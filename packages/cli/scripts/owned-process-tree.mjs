import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_SCAN_INTERVAL_MS = 100;
export const OWNED_PROCESS_TOKEN_ENV = "MERIDIAN_BENCHMARK_OWNER_TOKEN";
export const OWNED_PROCESS_REGISTRY_ENV = "MERIDIAN_BENCHMARK_OWNER_REGISTRY";

/**
 * Track the complete process ancestry of one owned root. Process groups are not an ownership
 * boundary: repository-analysis and projection workers may create their own sessions/groups. A
 * PID is retained with its OS start token so later PID reuse cannot be mistaken for ownership.
 */
export function createOwnedProcessTreeTracker(rootPid, options = {}) {
  if (!Number.isSafeInteger(rootPid) || rootPid <= 0 || rootPid === process.pid) {
    throw new TypeError("owned process tracker requires a positive non-harness root PID");
  }
  const scanIntervalMs = options.scanIntervalMs ?? DEFAULT_SCAN_INTERVAL_MS;
  if (!Number.isSafeInteger(scanIntervalMs) || scanIntervalMs < 25 || scanIntervalMs > 5_000) {
    throw new TypeError("owned process tracker scan interval must be 25..5000 ms");
  }
  const ownerToken = options.ownerToken;
  if (typeof ownerToken !== "string" || !/^[a-f0-9]{32,128}$/.test(ownerToken)) {
    throw new TypeError("owned process tracker requires a private 32..128 character hex owner token");
  }
  const registryPath = options.registryPath === undefined
    ? null
    : validateOwnedRegistryPath(options.registryPath);
  const readTable = options.readTable ?? readProcessTable;
  const isRootAlive = options.isRootAlive ?? (() => true);
  if (typeof isRootAlive !== "function") {
    throw new TypeError("owned process tracker root liveness proof must be a function");
  }
  if (registryPath === null && options.readOwnedIdentities === undefined) {
    throw new TypeError("owned process tracker requires a private owner registry path");
  }
  const readOwnedIdentities = options.readOwnedIdentities
    ?? ((rows) => readOwnedRegistryIdentities(registryPath, ownerToken, rows));
  const readRecordedGroups = options.readRecordedGroupIds
    ?? (registryPath === null
      ? null
      : async () => {
        const registry = await readOwnedProcessRegistry(registryPath, ownerToken);
        return {
          identities: [],
          recordedGroupIds: registry.records.map((record) => record.processGroupId),
          identityProofComplete: false,
          proofHealthy: registry.proofHealthy,
        };
      });
  // Key by immutable PID + OS start token, not PID alone. A reused PID is a different process and
  // must not erase the historical group whose absence still has to be proved.
  const registered = new Map();
  // Marker-bearing leaders are re-authenticated on every full snapshot. Descendants admitted from
  // a live owned-parent edge do not need their own argv marker and remain owned after reparenting.
  const markerRequiredIdentities = new Set();
  const tombstonedIdentities = new Set();
  const ambiguousOwnerProof = new Set();
  const registeredGroupIds = new Set();
  let rootIdentity = null;
  let rootParentIdentity = null;
  let rootExitObserved = false;
  let harnessPgid = null;
  let rootPgid = rootPid;
  let timer = null;
  let activeScan = Promise.resolve([]);
  let started = false;
  let stopped = false;
  let registryProofHealthy = true;

  const registerFrom = (rows, ownedDiscovery = null) => {
    const tokenBirthKeys = ownedDiscovery?.identityProofComplete === true
      ? ownedDiscovery.identityKeys
      : null;
    if (ownedDiscovery?.proofHealthy === false) registryProofHealthy = false;
    const byPid = new Map(rows.map((row) => [row.pid, row]));
    const registryLeaderPids = new Set(ownedDiscovery?.recordedGroupIds ?? []);
    // Detached registry records guarantee the original leader's pid === pgid. Classify any current
    // identity with that PID before the missing-marker pass even if its current PGID differs: that
    // is exactly what a same-second PID reuse can look like after a transient background read miss.
    for (const row of rows) {
      const identity = processIdentityKey(row);
      if (row.pid !== rootPid
        && row.pid !== process.pid
        && registered.has(identity)
        && (row.pid === row.pgid || registryLeaderPids.has(row.pid))
        && validProcessIdentity(row)) {
        markerRequiredIdentities.add(identity);
      }
    }
    if (!rootExitObserved && isRootAlive() !== true) rootExitObserved = true;
    if (rootExitObserved && rootIdentity !== null) {
      tombstonedIdentities.add(processIdentityKey(rootIdentity));
    }
    const harness = byPid.get(process.pid);
    if (harness !== undefined) harnessPgid = harness.pgid;
    const root = byPid.get(rootPid);
    const rootParent = root === undefined ? undefined : byPid.get(root.ppid);
    if (!rootExitObserved
      && rootIdentity === null
      && root !== undefined
      && validProcessIdentity(root)
      && root.ppid === process.pid
      && rootParent !== undefined
      && validProcessIdentity(rootParent)
      && rootParent.pid === process.pid) {
      rootIdentity = processIdentity(root);
      rootParentIdentity = processIdentity(rootParent);
      rootPgid = root.pgid;
    }

    // Once a complete snapshot proves an identity absent, it can never be adopted again. Cleanup's
    // private registry plus exact-PID argv-marker check also fails closed if the one-second ps birth
    // token is ambiguous (same PID/start but no longer carries this service's owner marker).
    for (const [identity, prior] of registered) {
      const current = byPid.get(prior.pid);
      if (!sameProcess(prior, current)) tombstonedIdentities.add(identity);
      else if (tokenBirthKeys !== null
        && markerRequiredIdentities.has(identity)
        && !tokenBirthKeys.has(identity)) {
        ambiguousOwnerProof.add(identity);
      }
    }

    const ownedDepth = new Map();
    if (!rootExitObserved
      && sameRootProcess(rootIdentity, rootParentIdentity, root, rootParent)
      && !tombstonedIdentities.has(processIdentityKey(rootIdentity))
      && !ambiguousOwnerProof.has(processIdentityKey(rootIdentity))) {
      ownedDepth.set(rootPid, 0);
    }
    for (const prior of registered.values()) {
      // The root is special: it is owned only while both its immutable identity and its pinned
      // harness parent are current. Never let the generic descendant-retention path bypass that.
      if (prior.pid === rootPid) continue;
      const current = byPid.get(prior.pid);
      if (sameProcess(prior, current)
        && !tombstonedIdentities.has(processIdentityKey(prior))
        && !ambiguousOwnerProof.has(processIdentityKey(prior))) {
        ownedDepth.set(prior.pid, prior.depth);
      }
    }
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of rows) {
        if (!validProcessIdentity(row) || ownedDepth.has(row.pid) || !ownedDepth.has(row.ppid)) continue;
        ownedDepth.set(row.pid, (ownedDepth.get(row.ppid) ?? 0) + 1);
        changed = true;
      }
    }
    if (tokenBirthKeys !== null) {
      for (const row of rows) {
        const identity = processIdentityKey(row);
        if (!validProcessIdentity(row)
          || row.pid === process.pid
          || !tokenBirthKeys.has(identity)
          || tombstonedIdentities.has(identity)
          || ambiguousOwnerProof.has(identity)) continue;
        if (row.pid === rootPid && !sameRootProcess(rootIdentity, rootParentIdentity, root, rootParent)) continue;
        if (!ownedDepth.has(row.pid)) ownedDepth.set(row.pid, registered.get(identity)?.depth ?? 1);
      }
    }
    for (const [pid, depth] of ownedDepth) {
      const row = byPid.get(pid);
      if (row === undefined) continue;
      const identity = processIdentityKey(row);
      if (tombstonedIdentities.has(identity) || ambiguousOwnerProof.has(identity)) continue;
      if (row.pid !== rootPid
        && (row.pid === row.pgid
          || registryLeaderPids.has(row.pid)
          || tokenBirthKeys?.has(identity))) {
        markerRequiredIdentities.add(identity);
      }
      const prior = registered.get(identity);
      registered.set(identity, {
        pid: row.pid,
        ppid: row.ppid,
        pgid: row.pgid,
        startedAt: row.startedAt,
        depth: prior === undefined ? depth : Math.min(prior.depth, depth),
      });
      registeredGroupIds.add(row.pgid);
    }
    for (const pgid of ownedDiscovery?.recordedGroupIds ?? []) registeredGroupIds.add(pgid);
    return rows;
  };

  const scan = async (discoverOwned = false) => {
    const rows = await readTable();
    let ownedIdentities = null;
    try {
      ownedIdentities = discoverOwned
        ? await readOwnedIdentities(rows, ownerToken)
        : readRecordedGroups === null
          ? null
          : await readRecordedGroups();
    } catch {
      // Registry availability/integrity is sticky evidence. A full proof failure must disable
      // marker-required identities; the root exit latch and current ancestry can still prove the
      // remaining safe cleanup candidates independently.
      registryProofHealthy = false;
      // A full discovery failure is authoritative negative proof for signalling purposes. Every
      // marker-required identity is excluded until an exact marker scan succeeds again. Background
      // scans remain non-authoritative so they can continue recording live ancestry cheaply.
      if (discoverOwned) {
        ownedIdentities = {
          identities: [],
          recordedGroupIds: [],
          identityProofComplete: true,
          proofHealthy: false,
        };
      }
    }
    const ownedDiscovery = ownedIdentities === null ? null : normalizeOwnedDiscovery(ownedIdentities);
    return registerFrom(rows, ownedDiscovery);
  };
  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(() => {
      activeScan = scan().catch(() => []).finally(schedule);
    }, scanIntervalMs);
  };

  return {
    rootPid,
    scanIntervalMs,
    get rootPgid() { return rootPgid; },
    get harnessPgid() { return harnessPgid; },
    async start() {
      if (started) return activeScan;
      started = true;
      activeScan = scan(true);
      const rows = await activeScan;
      if (rootIdentity === null
        || rootParentIdentity === null
        || !registered.has(processIdentityKey(rootIdentity))) {
        throw new Error("owned process root/parent exited before their immutable identities were registered");
      }
      schedule();
      return rows;
    },
    async scan() {
      activeScan = scan();
      return activeScan;
    },
    async stopPolling() {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      await activeScan.catch(() => []);
    },
    registeredProcesses() {
      return [...registered.values()].sort((left, right) => left.depth - right.depth || left.pid - right.pid);
    },
    registeredGroupIds() {
      return uniqueSorted(registeredGroupIds);
    },
    registryProofHealthy() {
      return registryProofHealthy;
    },
    async snapshot() {
      const rows = await scan(true);
      return snapshotForRows(rows);
    },
  };

  function snapshotForRows(rows) {
    const currentByPid = new Map(rows.map((row) => [row.pid, row]));
    const currentOwned = [...registered.values()].filter((entry) => (
      !tombstonedIdentities.has(processIdentityKey(entry))
      && !ambiguousOwnerProof.has(processIdentityKey(entry))
      && sameProcess(entry, currentByPid.get(entry.pid))
    ));
    const ambiguousOwned = [...registered.values()].filter((entry) => (
      ambiguousOwnerProof.has(processIdentityKey(entry))
      && sameProcess(entry, currentByPid.get(entry.pid))
    ));
    return { rows, currentOwned, ambiguousOwned };
  }
}

/**
 * Stop one owned process tree without trusting a process group to be the ownership boundary.
 *
 * The freeze phases are important. Stopping the root group first closes its spawn race; rescanning
 * and stopping each newly proved descendant group eventually closes every spawn-capable source.
 * TERM is queued while that barrier is held, and every error path resumes identities it stopped.
 */
export async function terminateOwnedProcessTree(tracker, options = {}) {
  const gracefulTimeoutMs = options.gracefulTimeoutMs ?? 10_000;
  const killTimeoutMs = options.killTimeoutMs ?? 5_000;
  const pollIntervalMs = options.pollIntervalMs ?? 50;
  const signalGroupImpl = options.signalGroup ?? signalGroup;
  const signalProcessImpl = options.signalProcess ?? signalProcess;
  await tracker.stopPolling();
  let leaderExitedBeforeStop = true;
  const stopSignaled = new Set();
  const termSignaled = new Set();
  const killGroups = new Set();
  try {
    const initialSnapshot = await tracker.snapshot();
    leaderExitedBeforeStop = !initialSnapshot.currentOwned.some((entry) => entry.pid === tracker.rootPid);
    await signalBehindFreezeBarrier(tracker, "SIGTERM", {
      signalGroupImpl,
      signalProcessImpl,
      stopSignaled,
      signaledGroups: termSignaled,
    });
    let verification = await drainOwnedProcesses(
      tracker,
      "SIGTERM",
      gracefulTimeoutMs,
      pollIntervalMs,
      signalGroupImpl,
      signalProcessImpl,
      termSignaled,
    );
    if (verification.verifiedEmpty) {
      verification = await attestOwnedProcessTreeAbsent(tracker, { confirmationDelayMs: pollIntervalMs });
    }
    if (!verification.verifiedEmpty) {
      await signalBehindFreezeBarrier(tracker, "SIGKILL", {
        signalGroupImpl,
        signalProcessImpl,
        stopSignaled,
        signaledGroups: killGroups,
      });
      verification = await drainOwnedProcesses(
        tracker,
        "SIGKILL",
        killTimeoutMs,
        pollIntervalMs,
        signalGroupImpl,
        signalProcessImpl,
        killGroups,
      );
      if (verification.verifiedEmpty) {
        verification = await attestOwnedProcessTreeAbsent(tracker, { confirmationDelayMs: pollIntervalMs });
      }
    }

    const registered = tracker.registeredProcesses();
    const registeredGroupIds = registeredOwnedGroupIds(tracker, registered);
    return {
      strategy: "tracked-owned-process-tree-and-groups",
      rootPid: tracker.rootPid,
      rootProcessGroupId: tracker.rootPgid,
      scanIntervalMs: tracker.scanIntervalMs,
      leaderExitedBeforeStop,
      registeredProcessCount: registered.length,
      registeredGroupCount: registeredGroupIds.length,
      detachedGroupCount: registeredGroupIds.filter((pgid) => pgid !== tracker.rootPgid).length,
      registeredGroupIds,
      sigstopGroupCount: stopSignaled.size,
      sigtermGroupCount: termSignaled.size,
      sigkillGroupCount: killGroups.size,
      registryProofHealthy: tracker.registryProofHealthy?.() === true,
      verifiedRecordedPidsAbsent: verification.residualProcesses.length === 0,
      verifiedRecordedGroupsAbsent: verification.residualGroupIds.length === 0,
      verifiedEmpty: verification.verifiedEmpty,
      residualPids: uniqueSorted(verification.residualProcesses.map((entry) => entry.pid)),
      residualGroupIds: verification.residualGroupIds,
    };
  } catch (error) {
    // Never turn a scanner/signal failure into an unbounded leak. Kill only identities that can
    // still be re-proved current; historical/reused groups are deliberately never signalled.
    await bestEffortKillTracked(tracker, signalGroupImpl, signalProcessImpl, killGroups);
    throw error;
  }
}

/**
 * Require two complete, fresh OS snapshots before cleanup may be reported as complete. The second
 * snapshot closes the last observation boundary: callers must not delete the private owner registry
 * merely because one `ps` sample happened to omit a still-running detached process.
 */
export async function attestOwnedProcessTreeAbsent(tracker, options = {}) {
  const confirmationDelayMs = options.confirmationDelayMs ?? 25;
  if (!Number.isSafeInteger(confirmationDelayMs)
    || confirmationDelayMs < 0
    || confirmationDelayMs > 5_000) {
    throw new TypeError("owned process absence confirmation delay must be 0..5000 ms");
  }
  const first = verifyAbsenceFromSnapshot(tracker, await tracker.snapshot());
  if (!first.verifiedEmpty) return first;
  if (confirmationDelayMs > 0) await delay(confirmationDelayMs);
  return verifyAbsenceFromSnapshot(tracker, await tracker.snapshot());
}

export async function readProcessTable() {
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid=,pgid=,state=,lstart="], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  const rows = parseProcessTable(stdout);
  // The process executing this proof must be present in a complete `ps -a` snapshot. Without this
  // sentinel, empty, truncated, localized, or otherwise unparsable output is indistinguishable from
  // proof that every owned PID and PGID disappeared.
  if (!rows.some((row) => row.pid === process.pid)) {
    throw new Error("process table did not include the verifier process; absence proof is incomplete");
  }
  return rows;
}

export function parseProcessTable(value) {
  const rows = [];
  for (const line of String(value).split("\n")) {
    const normalized = line.trim();
    if (normalized.length === 0) continue;
    const match = normalized.match(
      /^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+\s+\S+\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})$/,
    );
    if (match === null) {
      throw new Error(`could not parse process-table row: ${normalized.slice(0, 160)}`);
    }
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      state: match[4],
      startedAt: match[5].replace(/\s+/g, " "),
    });
  }
  return rows;
}

export async function readOwnedProcessRegistry(registryPath, ownerToken) {
  const path = validateOwnedRegistryPath(registryPath);
  const [fileInfo, directoryInfo] = await Promise.all([lstat(path), lstat(dirname(path))]);
  if (!fileInfo.isFile()
    || fileInfo.isSymbolicLink()
    || fileInfo.size > 1024 * 1024
    || (fileInfo.mode & 0o077) !== 0
    || (typeof process.getuid === "function" && fileInfo.uid !== process.getuid())) {
    throw new Error("owned process registry is not a bounded regular file");
  }
  if (!directoryInfo.isDirectory()
    || directoryInfo.isSymbolicLink()
    || (directoryInfo.mode & 0o077) !== 0
    || (typeof process.getuid === "function" && directoryInfo.uid !== process.getuid())) {
    throw new Error("owned process registry directory is not private to this user");
  }
  const expectedDigest = createHash("sha256").update(ownerToken).digest("hex");
  const text = await readFile(path, "utf8");
  const records = [];
  let proofHealthy = true;
  for (const line of text.split("\n")) {
    if (line.length === 0) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      proofHealthy = false;
      continue;
    }
    if (record?.version !== 1
      || record.tokenDigest !== expectedDigest
      || !Number.isSafeInteger(record.pid)
      || record.pid <= 0
      || !Number.isSafeInteger(record.parentPid)
      || record.parentPid <= 0
      || !Number.isSafeInteger(record.processGroupId)
      || record.processGroupId !== record.pid) {
      proofHealthy = false;
      continue;
    }
    records.push({
      pid: record.pid,
      parentPid: record.parentPid,
      processGroupId: record.processGroupId,
    });
  }
  return { records, proofHealthy };
}

export async function readOwnedRegistryIdentities(registryPath, ownerToken, processRows) {
  const registry = await readOwnedProcessRegistry(registryPath, ownerToken);
  const records = registry.records;
  const rowByPid = new Map(processRows.map((row) => [row.pid, row]));
  const candidates = records.filter((record) => {
    const row = rowByPid.get(record.pid);
    return row !== undefined && row.pgid === record.processGroupId;
  });
  const identities = [];
  let proofHealthy = registry.proofHealthy;
  for (let offset = 0; offset < candidates.length; offset += 128) {
    const batch = candidates.slice(offset, offset + 128);
    let stdout;
    try {
      ({ stdout } = await execFileAsync("ps", [
        "-ww",
        "-p", batch.map((entry) => entry.pid).join(","),
        "-o", "pid=,lstart=,command=",
      ], { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 }));
    } catch (error) {
      // BSD/GNU ps may return 1 when a candidate exits between the ancestry snapshot and this exact
      // marker query. Its remaining stdout is still complete for every PID that still exists.
      if (error?.code === 1 && typeof error.stdout === "string") stdout = error.stdout;
      else {
        proofHealthy = false;
        continue;
      }
    }
    const markers = [`--meridian-owner-token=${ownerToken}`, `meridian.owner=${ownerToken}`];
    for (const line of stdout.split("\n")) {
      const match = line.trim().match(
        /^(\d+)\s+(\S+\s+\S+\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/,
      );
      if (match === null || !markers.some((marker) => hasExactCommandArgument(match[3], marker))) continue;
      const pid = Number(match[1]);
      const row = rowByPid.get(pid);
      const record = batch.find((entry) => entry.pid === pid);
      const startedAt = match[2].replace(/\s+/g, " ");
      if (row !== undefined
        && record !== undefined
        && row.pgid === record.processGroupId
        && row.startedAt === startedAt) {
        identities.push({ pid, startedAt });
      }
    }
  }
  return {
    identities,
    recordedGroupIds: uniqueSorted(records.map((record) => record.processGroupId)),
    proofHealthy,
  };
}

function validateOwnedRegistryPath(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("owned process registry path is required");
  }
  const path = resolve(value);
  const directory = dirname(path);
  if (basename(path) !== "owned-processes.ndjson"
    || dirname(directory) !== resolve(tmpdir())
    || !basename(directory).startsWith("meridian-pr-review-cold-")) {
    throw new TypeError("owned process registry must be inside a private cold-service temp root");
  }
  return path;
}

function normalizeOwnedDiscovery(value) {
  const structured = value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && !(value instanceof Set)
    && Array.isArray(value.identities)
    && Array.isArray(value.recordedGroupIds);
  const entries = structured ? value.identities : value instanceof Set ? [...value] : value;
  if (!Array.isArray(entries)) throw new TypeError("owned process registry reader returned invalid identities");
  const keys = new Set();
  for (const entry of entries) {
    if (typeof entry === "string") {
      keys.add(entry);
      continue;
    }
    if (!validProcessIdentity(entry)) throw new TypeError("owned process registry reader returned an invalid identity");
    keys.add(processIdentityKey(entry));
  }
  const recordedGroupIds = structured ? value.recordedGroupIds : [];
  if (!recordedGroupIds.every((pgid) => Number.isSafeInteger(pgid) && pgid > 1)) {
    throw new TypeError("owned process registry reader returned invalid process groups");
  }
  return {
    identityKeys: keys,
    recordedGroupIds: uniqueSorted(recordedGroupIds),
    identityProofComplete: structured ? value.identityProofComplete !== false : true,
    proofHealthy: structured ? value.proofHealthy !== false : true,
  };
}

function sameProcess(expected, current) {
  return expected !== null
    && expected !== undefined
    && current !== undefined
    && validProcessIdentity(expected)
    && validProcessIdentity(current)
    && current.pid === expected.pid
    && current.startedAt === expected.startedAt;
}

function sameRootProcess(expected, expectedParent, current, currentParent) {
  return sameProcess(expected, current)
    && sameProcess(expectedParent, currentParent)
    && current.ppid === expectedParent.pid;
}

function ownedGroups(tracker, processes) {
  const groups = new Map();
  for (const processEntry of processes) {
    if (!safeOwnedGroup(tracker, processEntry.pgid)) continue;
    const current = groups.get(processEntry.pgid) ?? { pgid: processEntry.pgid, depth: -1 };
    current.depth = Math.max(current.depth, processEntry.depth);
    groups.set(processEntry.pgid, current);
  }
  return [...groups.values()].sort((left, right) => {
    const leftRoot = left.pgid === tracker.rootPgid;
    const rightRoot = right.pgid === tracker.rootPgid;
    if (leftRoot !== rightRoot) return leftRoot ? 1 : -1;
    return right.depth - left.depth || right.pgid - left.pgid;
  });
}

function safeOwnedGroup(tracker, pgid) {
  return Number.isSafeInteger(pgid)
    && pgid > 1
    && pgid !== tracker.harnessPgid
    && pgid !== process.pid;
}

async function signalVerifiedGroup(tracker, pgid, signal, signalImpl) {
  const { currentOwned } = await tracker.snapshot();
  const members = currentOwned.filter((entry) => entry.pgid === pgid);
  // A registry PGID is historical cleanup evidence, not an identity. Without a current owned
  // member there is no way to distinguish the original group from a numerically reused group.
  if (members.length === 0 || !safeOwnedGroup(tracker, pgid)) return null;
  signalImpl(pgid, signal);
  return {
    pgid,
    anchors: new Set(members.map(processIdentityKey)),
  };
}

async function signalVerifiedProcess(tracker, expected, signal, signalImpl) {
  const { currentOwned } = await tracker.snapshot();
  if (!currentOwned.some((entry) => sameProcess(expected, entry))) return false;
  signalImpl(expected.pid, signal);
  return true;
}

async function signalBehindFreezeBarrier(tracker, signal, options) {
  const frozenGroups = new Map();
  let bodyError = null;
  try {
    await freezeToFixedPoint(tracker, frozenGroups, options.stopSignaled, options.signalGroupImpl);
    const { currentOwned } = await tracker.snapshot();
    for (const group of ownedGroups(tracker, currentOwned)) {
      const proof = await signalVerifiedGroup(tracker, group.pgid, signal, options.signalGroupImpl);
      if (proof !== null) options.signaledGroups.add(group.pgid);
    }
    // SIGKILL every still-current PID too. This is an identity-safe fallback for a process that
    // changed groups between the group proof and delivery, and for descendants in an unsafe group.
    if (signal === "SIGKILL") {
      const latest = await tracker.snapshot();
      for (const entry of latest.currentOwned) {
        await signalVerifiedProcess(tracker, entry, signal, options.signalProcessImpl);
      }
    }
  } catch (error) {
    bodyError = error;
  } finally {
    try {
      await resumeFrozenGroups(
        tracker,
        frozenGroups,
        options.signalGroupImpl,
        options.signalProcessImpl,
      );
    } catch (resumeError) {
      bodyError = bodyError === null
        ? resumeError
        : new AggregateError([bodyError, resumeError], "owned process freeze cleanup failed");
    }
  }
  if (bodyError !== null) throw bodyError;
}

async function freezeToFixedPoint(tracker, frozenGroups, stopSignaled, signalGroupImpl) {
  let priorSignature = null;
  for (let pass = 0; pass < 64; pass += 1) {
    let snapshot = await tracker.snapshot();
    let added = false;
    // Root first: once the root group is stopped it cannot race the descendant discovery passes.
    for (const group of freezeOrderedGroups(
      tracker,
      snapshot.currentOwned,
    )) {
      if (isFrozenGroup(
        frozenGroups.get(group.pgid),
        snapshot.currentOwned,
      )) continue;
      const proof = await signalVerifiedGroup(tracker, group.pgid, "SIGSTOP", signalGroupImpl);
      if (proof === null) continue;
      frozenGroups.set(group.pgid, proof);
      stopSignaled.add(group.pgid);
      added = true;
    }
    snapshot = await tracker.snapshot();
    const currentGroups = freezeOrderedGroups(
      tracker,
      snapshot.currentOwned,
    );
    const allFrozen = currentGroups.every((group) => (
      isFrozenGroup(frozenGroups.get(group.pgid), snapshot.currentOwned)
    ));
    const signature = snapshot.currentOwned.map(processIdentityKey).sort().join("|");
    if (allFrozen && !added && signature === priorSignature) return;
    priorSignature = signature;
    await delay(5);
  }
  throw new Error("owned process ancestry did not reach a frozen shutdown fixed point");
}

function freezeOrderedGroups(tracker, processes) {
  return ownedGroups(tracker, processes).sort((left, right) => {
    const leftRoot = left.pgid === tracker.rootPgid;
    const rightRoot = right.pgid === tracker.rootPgid;
    if (leftRoot !== rightRoot) return leftRoot ? -1 : 1;
    return left.depth - right.depth || left.pgid - right.pgid;
  });
}

function isFrozenGroup(record, currentOwned) {
  return record !== undefined
    && currentOwned.some((entry) => (
      entry.pgid === record.pgid && record.anchors.has(processIdentityKey(entry))
    ));
}

async function resumeFrozenGroups(tracker, frozenGroups, signalGroupImpl, signalProcessImpl) {
  const failures = [];
  // Every entry was identity-proved immediately before SIGSTOP. A stopped process cannot naturally
  // exit or recycle its PGID, so use that captured proof directly: depending on another ps scan here
  // could strand the entire repository worker tree if process-table access is what failed.
  const records = [...frozenGroups.entries()].sort(([leftPgid], [rightPgid]) => {
    const leftRoot = leftPgid === tracker.rootPgid;
    const rightRoot = rightPgid === tracker.rootPgid;
    if (leftRoot !== rightRoot) return leftRoot ? 1 : -1;
    return rightPgid - leftPgid;
  });
  for (const [pgid, record] of records) {
    try {
      signalGroupImpl(pgid, "SIGCONT");
      frozenGroups.delete(pgid);
    } catch (error) {
      if (error?.code !== "EPERM") {
        failures.push(error);
        continue;
      }
      try {
        // Darwin reports EPERM for a group signal when *any* current group member cannot be
        // signalled. Do not ignore it: resume only identities that a fresh ownership snapshot can
        // still prove. This avoids both stranding our stopped workers and signalling an unrelated
        // member that happened to join or reuse the numeric process group.
        const snapshot = await tracker.snapshot();
        const capturedAnchors = new Set(record.anchors);
        const currentRowsByPid = new Map(snapshot.rows.map((entry) => [entry.pid, entry]));
        const resumable = snapshot.currentOwned.filter((entry) => (
          !isZombieProcess(currentRowsByPid.get(entry.pid))
          && (entry.pgid === pgid || capturedAnchors.has(processIdentityKey(entry)))
        ));
        const currentlyProved = new Set(snapshot.currentOwned.map(processIdentityKey));
        const unresolvedAnchors = snapshot.rows.filter((entry) => (
          capturedAnchors.has(processIdentityKey(entry))
          && !currentlyProved.has(processIdentityKey(entry))
        ));
        // A queued terminating signal can turn a stopped leader into a zombie before this finally
        // block runs. ps no longer exposes its argv marker, but the exact captured identity plus Z
        // state proves it cannot run and therefore needs no SIGCONT. It remains in absence checks
        // below until its PID and group are reaped. Missing state and every non-zombie proof loss
        // stay fail-closed.
        const unresolvedRunnableAnchors = unresolvedAnchors.filter((entry) => !isZombieProcess(entry));
        if (unresolvedRunnableAnchors.length > 0) {
          throw Object.assign(
            new Error(
              `ownership proof missing for frozen pid(s) ${boundedPidList(unresolvedRunnableAnchors)}`,
            ),
            { code: "EOWNERSHIPPROOF" },
          );
        }
        const resumeFailures = [];
        for (const entry of resumable) {
          try {
            // The snapshot immediately above is the same ps -> signal proof used everywhere else
            // in this module. Do not insert another scan here: a TERM-pending stopped process can
            // exit between the two scans, and ESRCH then means there is nothing left to resume.
            signalProcessImpl(entry.pid, "SIGCONT");
          } catch (resumeError) {
            if (resumeError?.code !== "ESRCH") resumeFailures.push({ entry, error: resumeError });
          }
        }
        if (resumeFailures.length > 0) {
          throw new AggregateError(
            resumeFailures.map(({ error: resumeError }) => resumeError),
            `per-pid SIGCONT failed for ${resumeFailures
              .slice(0, 8)
              .map(({ entry, error: resumeError }) => `${entry.pid}:${signalErrorCode(resumeError)}`)
              .join(",")}`,
          );
        }
        frozenGroups.delete(pgid);
      } catch (resumeError) {
        failures.push(new AggregateError(
          [error, resumeError],
          `process-group ${pgid} SIGCONT failed (${signalErrorCode(error)}); `
            + `identity fallback failed (${signalErrorCode(resumeError)}: ${boundedErrorMessage(resumeError)})`,
        ));
      }
    }
  }
  if (frozenGroups.size > 0) {
    throw new AggregateError(
      failures,
      `could not resume every proof-captured frozen process group: ${failures
        .slice(0, 8)
        .map((failure) => boundedErrorMessage(failure))
        .join("; ")}`,
    );
  }
}

async function drainOwnedProcesses(
  tracker,
  signal,
  timeoutMs,
  pollIntervalMs,
  signalGroupImpl,
  signalProcessImpl,
  signaledGroups,
) {
  const deadline = Date.now() + timeoutMs;
  const deliveredProofs = new Set();
  for (;;) {
    const snapshot = await tracker.snapshot();
    // snapshot() registers any descendant that became visible after TERM. Verification always uses
    // the full dynamic registry, so a late detached worker cannot fall outside escalation/proof.
    let verification = verifyAbsenceFromSnapshot(tracker, snapshot);
    if (verification.verifiedEmpty) return verification;

    for (const group of ownedGroups(tracker, snapshot.currentOwned)) {
      const members = snapshot.currentOwned.filter((entry) => entry.pgid === group.pgid);
      const proofKey = `${group.pgid}:${members.map(processIdentityKey).sort().join(",")}`;
      if (signal === "SIGTERM" && deliveredProofs.has(proofKey)) continue;
      const proof = await signalVerifiedGroup(tracker, group.pgid, signal, signalGroupImpl);
      if (proof !== null) {
        deliveredProofs.add(proofKey);
        signaledGroups.add(group.pgid);
      }
    }
    // KILL is deliberately repeated against every currently proved identity until proof is empty.
    // TERM uses this only for processes whose group cannot be safely signalled.
    const latest = await tracker.snapshot();
    for (const entry of latest.currentOwned) {
      if (signal === "SIGKILL" || !safeOwnedGroup(tracker, entry.pgid)) {
        await signalVerifiedProcess(tracker, entry, signal, signalProcessImpl);
      }
    }
    verification = verifyAbsenceFromSnapshot(tracker, await tracker.snapshot());
    if (verification.verifiedEmpty || Date.now() >= deadline) return verification;
    await delay(pollIntervalMs);
  }
}

function verifyAbsenceFromSnapshot(tracker, snapshot) {
  const registered = tracker.registeredProcesses();
  const groupIds = registeredOwnedGroupIds(tracker, registered);
  const byPid = new Map(snapshot.rows.map((row) => [row.pid, row]));
  const residualByIdentity = new Map();
  for (const entry of registered) {
    if (sameProcess(entry, byPid.get(entry.pid))) residualByIdentity.set(processIdentityKey(entry), entry);
  }
  for (const entry of snapshot.ambiguousOwned ?? []) {
    residualByIdentity.set(processIdentityKey(entry), entry);
  }
  const residualProcesses = [...residualByIdentity.values()];
  const liveGroups = new Set(snapshot.rows.map((row) => row.pgid));
  const residualGroupIds = groupIds.filter((pgid) => liveGroups.has(pgid));
  return {
    verifiedEmpty: residualProcesses.length === 0 && residualGroupIds.length === 0,
    residualProcesses,
    residualGroupIds,
  };
}

function registeredOwnedGroupIds(tracker, registered = tracker.registeredProcesses()) {
  const historicalGroups = typeof tracker.registeredGroupIds === "function"
    ? tracker.registeredGroupIds()
    : [];
  return uniqueSorted([
    ...historicalGroups,
    ...registered.map((entry) => entry.pgid),
  ].filter((pgid) => safeOwnedGroup(tracker, pgid)));
}

async function bestEffortKillTracked(tracker, signalGroupImpl, signalProcessImpl, killGroups) {
  const deadline = Date.now() + 1_000;
  let lastVerification = null;
  do {
    let snapshot;
    try {
      snapshot = await tracker.snapshot();
    } catch {
      // Cached identities and PGIDs can be recycled as soon as the process-table proof is lost.
      // Fail closed until a fresh snapshot succeeds; leaking owned work is safer than signalling an
      // unrelated process that inherited one of those numeric identifiers.
      await delay(25);
      continue;
    }
    const groups = ownedGroups(tracker, snapshot.currentOwned);
    for (const group of groups) {
      try {
        const signaled = await signalVerifiedGroup(
          tracker,
          group.pgid,
          "SIGKILL",
          signalGroupImpl,
        ) !== null;
        if (signaled) {
          killGroups.add(group.pgid);
        }
      } catch {
        // Keep attempting other identity-proved groups.
      }
    }
    for (const entry of snapshot.currentOwned) {
      try {
        await signalVerifiedProcess(tracker, entry, "SIGKILL", signalProcessImpl);
      } catch {
        // Keep attempting other identity-proved processes.
      }
    }
    try {
      lastVerification = verifyAbsenceFromSnapshot(tracker, await tracker.snapshot());
      if (lastVerification.verifiedEmpty) return lastVerification;
    } catch {
      // Retry until the bounded emergency-drain deadline.
    }
    await delay(25);
  } while (Date.now() < deadline);
  return lastVerification;
}

function processIdentityKey(entry) {
  return JSON.stringify([entry.pid, entry.startedAt]);
}

function processIdentity(entry) {
  return {
    pid: entry.pid,
    startedAt: entry.startedAt,
  };
}

function validProcessIdentity(entry) {
  return Number.isSafeInteger(entry?.pid)
    && entry.pid > 0
    && typeof entry.startedAt === "string"
    && entry.startedAt.length > 0;
}

function hasExactCommandArgument(command, marker) {
  return String(command).split(/\s+/).includes(marker);
}

function delay(milliseconds) {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}

function signalGroup(pgid, signal) {
  try {
    process.kill(-pgid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function signalProcess(pid, signal) {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function boundedPidList(entries) {
  const pids = entries.slice(0, 8).map((entry) => entry.pid).join(",");
  return entries.length > 8 ? `${pids},+${entries.length - 8}` : pids;
}

function boundedErrorMessage(error) {
  const message = typeof error?.message === "string" ? error.message : signalErrorCode(error);
  return message.slice(0, 512);
}

function signalErrorCode(error) {
  if (typeof error?.code === "string" && error.code.length > 0) return error.code.slice(0, 64);
  if (typeof error?.name === "string" && error.name.length > 0) return error.name.slice(0, 64);
  return "UNKNOWN";
}

function isZombieProcess(entry) {
  return typeof entry?.state === "string" && entry.state.includes("Z");
}

function uniqueSorted(values) {
  return [...new Set(values)].sort((left, right) => left - right);
}
