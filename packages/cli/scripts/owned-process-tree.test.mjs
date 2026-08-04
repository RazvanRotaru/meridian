import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  attestOwnedProcessTreeAbsent,
  createOwnedProcessTreeTracker,
  parseProcessTable,
  readOwnedRegistryIdentities,
  readOwnedProcessRegistry,
  readProcessTable,
  terminateOwnedProcessTree,
} from "./owned-process-tree.mjs";

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const treeFixturePath = join(scriptsDirectory, "fixtures", "owned-process-tree-fixture.mjs");
const signalDriverPath = join(scriptsDirectory, "fixtures", "cold-signal-cleanup-driver.mjs");
const SIGNAL_FIXTURE_READY_TIMEOUT_MS = 8_000;
// The termination budgets bound the drain phases, not the full proof wall clock. Cleanup also
// freezes and rescans every detached group, waits for OS reaping, and requires two final snapshots.
// Keep the fixture alive long enough for the production proof instead of racing it with SIGKILL.
const SIGNAL_CLEANUP_EXIT_TIMEOUT_MS = 20_000;
const unixDescribe = process.platform === "win32" ? describe.skip : describe;

unixDescribe("owned process-tree cleanup with real detached processes", () => {
  it("stops a live root, detached analysis worker, and nested detached git-like child", async () => {
    await requireProcessTableProofBeforeSpawn();
    const context = spawnTreeFixture();
    try {
      await initializeTreeFixture(context);
      const evidence = await stopTrackedFixture(context);

      expect(evidence).toMatchObject({
        leaderExitedBeforeStop: false,
        registeredGroupCount: 3,
        detachedGroupCount: 2,
        verifiedRecordedPidsAbsent: true,
        verifiedRecordedGroupsAbsent: true,
        verifiedEmpty: true,
        residualPids: [],
        residualGroupIds: [],
      });
      expect(evidence.registeredProcessCount).toBeGreaterThanOrEqual(3);
      await expectTrackedIdentitiesAndGroupsAbsent(context.tracker);
    } finally {
      await forceExactFixtureCleanup(context);
    }
  }, 20_000);

  it("retains detached descendants after the root exits and they are reparented", async () => {
    await requireProcessTableProofBeforeSpawn();
    const context = spawnTreeFixture();
    try {
      await initializeTreeFixture(context);
      context.child.send({ type: "exit-root" });
      await waitForChildExit(context.child);
      await context.tracker.scan();

      const currentRows = await readProcessTable();
      expect(currentRows.some((row) => row.pid === context.ready.workerPid && row.ppid !== context.ready.rootPid)).toBe(true);
      const evidence = await stopTrackedFixture(context);

      expect(evidence).toMatchObject({
        leaderExitedBeforeStop: true,
        registeredGroupCount: 3,
        detachedGroupCount: 2,
        verifiedRecordedPidsAbsent: true,
        verifiedRecordedGroupsAbsent: true,
        verifiedEmpty: true,
      });
      expect(evidence.registeredProcessCount).toBeGreaterThanOrEqual(3);
      await expectTrackedIdentitiesAndGroupsAbsent(context.tracker);
    } finally {
      await forceExactFixtureCleanup(context);
    }
  }, 20_000);

  it("refuses to signal a registry-only Git group whose marker leader exited before the first scan", async () => {
    await requireProcessTableProofBeforeSpawn();
    const context = spawnTreeFixture({ leaderExitsWithHelper: true });
    try {
      context.ready = await context.readyPromise;
      expect(context.ready.helperPid).toBeGreaterThan(1);
      context.capturedIdentities = await captureFixtureIdentitiesByPids([
        context.ready.rootPid,
        context.ready.workerPid,
        context.ready.helperPid,
      ]);
      context.tracker = createOwnedProcessTreeTracker(context.ready.rootPid, {
        scanIntervalMs: 25,
        ownerToken: context.ownerToken,
        registryPath: context.registryPath,
        isRootAlive: () => !childExited(context.child),
      });
      await context.tracker.start();
      expect(context.tracker.registeredGroupIds()).toContain(context.ready.gitPid);

      const deliveredGroupSignals = [];
      const evidence = await terminateOwnedProcessTree(context.tracker, {
        gracefulTimeoutMs: 300,
        killTimeoutMs: 300,
        pollIntervalMs: 25,
        signalGroup: (pgid, signal) => {
          deliveredGroupSignals.push({ pgid, signal });
          signalIgnoringMissing(-pgid, signal);
        },
        signalProcess: signalIgnoringMissing,
      });
      await waitForChildExit(context.child, 2_000).catch(() => undefined);
      expect(evidence.registeredGroupIds).toContain(context.ready.gitPid);
      expect(evidence).toMatchObject({
        registeredGroupCount: 3,
        detachedGroupCount: 2,
        verifiedRecordedPidsAbsent: true,
        verifiedRecordedGroupsAbsent: false,
        verifiedEmpty: false,
        residualPids: [],
        residualGroupIds: [context.ready.gitPid],
      });
      expect(deliveredGroupSignals.filter(({ pgid }) => pgid === context.ready.gitPid)).toEqual([]);
      const rows = await readProcessTable();
      expect(rows.some((row) => (
        row.pid === context.ready.helperPid
        && context.capturedIdentities.some((entry) => sameIdentity(entry, row))
      ))).toBe(true);
    } finally {
      await forceExactFixtureCleanup(context);
    }
  }, 20_000);

  it("escalates a TERM-resistant detached child to SIGKILL and proves it absent", async () => {
    await requireProcessTableProofBeforeSpawn();
    const context = spawnTreeFixture({ termResistantLeaf: true });
    try {
      await initializeTreeFixture(context);
      const evidence = await stopTrackedFixture(context, { gracefulTimeoutMs: 300 });

      expect(evidence.sigtermGroupCount).toBeGreaterThanOrEqual(3);
      expect(evidence.sigkillGroupCount).toBeGreaterThanOrEqual(1);
      expect(evidence).toMatchObject({
        verifiedRecordedPidsAbsent: true,
        verifiedRecordedGroupsAbsent: true,
        verifiedEmpty: true,
        residualPids: [],
        residualGroupIds: [],
      });
      await expectTrackedIdentitiesAndGroupsAbsent(context.tracker);
    } finally {
      await forceExactFixtureCleanup(context);
    }
  }, 20_000);

  it("awaits the real SIGINT cleanup handler before exiting with code 130", async () => {
    await requireProcessTableProofBeforeSpawn();
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "meridian-pr-review-cold-signal-"));
    const markerPath = join(tmpdir(), `meridian-signal-cleanup-marker-${process.pid}-${Date.now()}`);
    const child = spawn(process.execPath, [signalDriverPath, temporaryDirectory, markerPath], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    let ready = null;
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    try {
      ready = await readReadyLine(child, SIGNAL_FIXTURE_READY_TIMEOUT_MS);
      expect(ready.registered).toHaveLength(3);
      const signalStartedAt = Date.now();
      expect(child.kill("SIGINT")).toBe(true);
      const [exitCode, exitSignal] = await waitForChildExit(child, SIGNAL_CLEANUP_EXIT_TIMEOUT_MS);

      expect(exitSignal).toBeNull();
      expect(exitCode).toBe(130);
      expect(Date.now() - signalStartedAt).toBeGreaterThanOrEqual(100);
      await expect(stat(temporaryDirectory)).rejects.toMatchObject({ code: "ENOENT" });
      const marker = JSON.parse(await readFile(markerPath, "utf8"));
      expect(marker).toMatchObject({
        type: "cleanup-complete",
        evidence: {
          registeredGroupCount: 3,
          verifiedRecordedPidsAbsent: true,
          verifiedRecordedGroupsAbsent: true,
          verifiedEmpty: true,
        },
      });
      expect(marker.evidence.registeredProcessCount).toBeGreaterThanOrEqual(3);
      const rows = await readProcessTable();
      const groups = new Set(ready.registered.map((entry) => entry.pgid));
      expect(ready.registered.filter((entry) => rows.some((row) => sameIdentity(entry, row)))).toEqual([]);
      expect(rows.filter((row) => groups.has(row.pgid))).toEqual([]);
      expect(stderr).toBe("");
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await waitForChildExit(child, 1_000).catch(() => undefined);
      if (ready?.registered) {
        await forceIdentityCleanup(ready.registered);
        await rm(temporaryDirectory, { recursive: true, force: true });
        await rm(markerPath, { force: true });
      } else {
        // Without the driver's authenticated ready record, descendant ownership is unknown. Keep
        // the private root as forensic evidence instead of making a failed cleanup look complete.
        throw new Error(`signal cleanup fixture never supplied exact identities; preserved ${temporaryDirectory}`);
      }
    }
  }, 35_000);
});

async function requireProcessTableProofBeforeSpawn() {
  // A detached fixture cannot be cleaned safely from cached numeric PIDs alone. Fail before spawn
  // when the environment denies `ps` (for example a restricted test sandbox), leaving no process or
  // private owner registry behind.
  await readProcessTable();
}

describe("owned process identity safety", () => {
  it("parses process state alongside the immutable start identity", () => {
    expect(parseProcessTable([
      "  61001  1  61001 Z+ Thu Jul 31 12:00:00 2026",
      "  61002  61001  61001 Ss Thu Jul 31 12:00:01 2026",
      "",
    ].join("\n"))).toEqual([
      {
        pid: 61_001,
        ppid: 1,
        pgid: 61_001,
        state: "Z+",
        startedAt: "Thu Jul 31 12:00:00 2026",
      },
      {
        pid: 61_002,
        ppid: 61_001,
        pgid: 61_001,
        state: "Ss",
        startedAt: "Thu Jul 31 12:00:01 2026",
      },
    ]);
  });

  it("rejects an incomplete process-table snapshot instead of treating omitted live rows as absence", () => {
    expect(() => parseProcessTable([
      "  61001  1  61001 Ss Thu Jul 31 12:00:00 2026",
      "  live detached row omitted its immutable start token",
    ].join("\n"))).toThrow(/could not parse process-table row/);
  });

  it("does not certify cleanup when a term-resistant detached identity is visible on confirmation", async () => {
    const survivor = {
      pid: 61_003,
      ppid: 1,
      pgid: 61_003,
      state: "Ss",
      startedAt: "Fri Aug 1 02:57:23 2026",
      depth: 2,
    };
    const snapshots = [
      { rows: [], currentOwned: [], ambiguousOwned: [] },
      { rows: [survivor], currentOwned: [survivor], ambiguousOwned: [] },
    ];
    const tracker = {
      rootPid: 61_001,
      rootPgid: 61_001,
      harnessPgid: 60_000,
      registeredProcesses: () => [survivor],
      registeredGroupIds: () => [survivor.pgid],
      snapshot: async () => snapshots.shift() ?? snapshots.at(-1),
    };

    await expect(attestOwnedProcessTreeAbsent(tracker, { confirmationDelayMs: 0 })).resolves.toMatchObject({
      verifiedEmpty: false,
      residualProcesses: [survivor],
      residualGroupIds: [survivor.pgid],
    });
  });

  it("salvages authenticated complete registry lines but marks a torn tail unhealthy", async () => {
    const root = mkdtempSync(join(tmpdir(), "meridian-pr-review-cold-registry-tail-"));
    const registryPath = join(root, "owned-processes.ndjson");
    const ownerToken = "d".repeat(64);
    const record = {
      version: 1,
      tokenDigest: createHash("sha256").update(ownerToken).digest("hex"),
      pid: 61_001,
      parentPid: process.pid,
      processGroupId: 61_001,
    };
    writeFileSync(registryPath, `${JSON.stringify(record)}\n{"version":`, { flag: "wx", mode: 0o600 });
    try {
      await expect(readOwnedProcessRegistry(registryPath, ownerToken)).resolves.toEqual({
        records: [{ pid: 61_001, parentPid: process.pid, processGroupId: 61_001 }],
        proofHealthy: false,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("never signals a registry PGID reused after its marker leader disappears", async () => {
    const startedAt = "Thu Jul 31 12:00:00 2026";
    const ownedRows = [
      processRow(process.pid, 1, 30_001, startedAt, "vitest harness"),
      processRow(41_001, process.pid, 41_001, startedAt, "node owned-root.mjs"),
      processRow(41_002, 41_001, 42_000, startedAt, "node repository-analysis-worker.mjs"),
    ];
    const reusedRows = [
      processRow(process.pid, 1, 30_001, startedAt, "vitest harness"),
      processRow(42_000, 1, 42_000, "Thu Jul 31 12:00:01 2026", "unrelated reused group"),
    ];
    let phase = "owned";
    const deliveredSignals = [];
    const tracker = createOwnedProcessTreeTracker(41_001, {
      scanIntervalMs: 25,
      readTable: async () => phase === "owned" ? ownedRows : reusedRows,
      ownerToken: "a".repeat(64),
      readOwnedIdentities: async () => phase === "owned"
        ? { identities: [ownedRows[2]], recordedGroupIds: [42_000] }
        : { identities: [], recordedGroupIds: [42_000] },
    });

    await tracker.start();
    phase = "reused";
    const evidence = await terminateOwnedProcessTree(tracker, {
      gracefulTimeoutMs: 0,
      killTimeoutMs: 0,
      pollIntervalMs: 25,
      signalGroup: (pgid, signal) => deliveredSignals.push({ kind: "group", pgid, signal }),
      signalProcess: (pid, signal) => deliveredSignals.push({ kind: "process", pid, signal }),
    });

    expect(deliveredSignals).toEqual([]);
    expect(evidence.verifiedRecordedPidsAbsent).toBe(true);
    expect(evidence.verifiedRecordedGroupsAbsent).toBe(false);
    expect(evidence.verifiedEmpty).toBe(false);
    expect(evidence.residualPids).toEqual([]);
    expect(evidence.residualGroupIds).toEqual([42_000]);
  });

  it("marks a registry leader admitted by a background ancestry scan before same-second reuse", async () => {
    const startedAt = "Thu Jul 31 12:00:00 2026";
    const initialRows = [
      processRow(process.pid, 1, 30_001, startedAt, "vitest harness"),
      processRow(44_001, process.pid, 44_001, startedAt, "node owned-root.mjs"),
    ];
    const lateOwnedRows = [
      ...initialRows,
      processRow(44_002, 44_001, 44_002, startedAt, "node late marker leader.mjs"),
    ];
    const reusedRows = [
      processRow(process.pid, 1, 30_001, startedAt, "vitest harness"),
      processRow(44_002, 1, 45_000, startedAt, "unrelated same-second replacement"),
    ];
    let phase = "initial";
    const deliveredSignals = [];
    const tracker = createOwnedProcessTreeTracker(44_001, {
      scanIntervalMs: 5_000,
      ownerToken: "1".repeat(64),
      readTable: async () => phase === "initial"
        ? initialRows
        : phase === "late-owned"
          ? lateOwnedRows
          : reusedRows,
      readOwnedIdentities: async () => ({
        identities: [],
        recordedGroupIds: phase === "initial" ? [] : [44_002],
      }),
      readRecordedGroupIds: async () => ({
        identities: [],
        recordedGroupIds: [44_002],
        identityProofComplete: false,
      }),
    });
    await tracker.start();
    phase = "late-owned";
    await tracker.scan();
    expect(tracker.registeredProcesses().map(({ pid }) => pid)).toContain(44_002);
    phase = "reused";

    const evidence = await terminateOwnedProcessTree(tracker, {
      gracefulTimeoutMs: 0,
      killTimeoutMs: 0,
      pollIntervalMs: 25,
      signalGroup: (pgid, signal) => deliveredSignals.push({ kind: "group", pgid, signal }),
      signalProcess: (pid, signal) => deliveredSignals.push({ kind: "process", pid, signal }),
    });

    expect(deliveredSignals).toEqual([]);
    expect(evidence.verifiedRecordedPidsAbsent).toBe(false);
    expect(evidence.verifiedEmpty).toBe(false);
    expect(evidence.residualPids).toEqual([44_002]);
  });

  it("recovers marker-required classification after a transient background registry miss", async () => {
    const startedAt = "Thu Jul 31 12:00:00 2026";
    const initialRows = [
      processRow(process.pid, 1, 30_001, startedAt, "vitest harness"),
      processRow(46_001, process.pid, 46_001, startedAt, "node owned-root.mjs"),
    ];
    const lateOwnedRows = [
      ...initialRows,
      processRow(46_002, 46_001, 46_002, startedAt, "node late marker leader.mjs"),
    ];
    const reusedRows = [
      processRow(process.pid, 1, 30_001, startedAt, "vitest harness"),
      processRow(46_002, 1, 47_000, startedAt, "unrelated same-second replacement"),
    ];
    let phase = "initial";
    const deliveredSignals = [];
    const tracker = createOwnedProcessTreeTracker(46_001, {
      scanIntervalMs: 5_000,
      ownerToken: "2".repeat(64),
      readTable: async () => phase === "initial"
        ? initialRows
        : phase === "late-owned"
          ? lateOwnedRows
          : reusedRows,
      readOwnedIdentities: async () => ({
        identities: [],
        recordedGroupIds: phase === "reused" ? [46_002] : [],
      }),
      readRecordedGroupIds: async () => {
        throw new Error("injected transient registry read failure");
      },
    });
    await tracker.start();
    phase = "late-owned";
    await tracker.scan();
    expect(tracker.registeredProcesses().map(({ pid }) => pid)).toContain(46_002);
    phase = "reused";

    const evidence = await terminateOwnedProcessTree(tracker, {
      gracefulTimeoutMs: 0,
      killTimeoutMs: 0,
      pollIntervalMs: 25,
      signalGroup: (pgid, signal) => deliveredSignals.push({ kind: "group", pgid, signal }),
      signalProcess: (pid, signal) => deliveredSignals.push({ kind: "process", pid, signal }),
    });

    expect(deliveredSignals).toEqual([]);
    expect(evidence.registryProofHealthy).toBe(false);
    expect(evidence.verifiedRecordedPidsAbsent).toBe(false);
    expect(evidence.verifiedEmpty).toBe(false);
    expect(evidence.residualPids).toEqual([46_002]);
  });

  it("fails closed when full marker discovery remains unavailable after late detached admission", async () => {
    const startedAt = "Thu Jul 31 12:00:00 2026";
    const initialRows = [
      processRow(process.pid, 1, 30_001, startedAt, "vitest harness"),
      processRow(48_001, process.pid, 48_001, startedAt, "node owned-root.mjs"),
    ];
    const lateOwnedRows = [
      ...initialRows,
      processRow(48_002, 48_001, 48_002, startedAt, "node unverified detached leader.mjs"),
    ];
    const reusedRows = [
      processRow(process.pid, 1, 30_001, startedAt, "vitest harness"),
      processRow(48_002, 1, 49_000, startedAt, "unrelated same-second replacement"),
    ];
    let phase = "initial";
    const deliveredSignals = [];
    const tracker = createOwnedProcessTreeTracker(48_001, {
      scanIntervalMs: 5_000,
      ownerToken: "3".repeat(64),
      readTable: async () => phase === "initial"
        ? initialRows
        : phase === "late-owned"
          ? lateOwnedRows
          : reusedRows,
      readOwnedIdentities: async () => {
        if (phase === "reused") throw new Error("injected full marker discovery failure");
        return { identities: [], recordedGroupIds: [] };
      },
      readRecordedGroupIds: async () => {
        throw new Error("injected background registry failure");
      },
    });
    await tracker.start();
    phase = "late-owned";
    await tracker.scan();
    expect(tracker.registeredProcesses().map(({ pid }) => pid)).toContain(48_002);
    phase = "reused";

    const evidence = await terminateOwnedProcessTree(tracker, {
      gracefulTimeoutMs: 0,
      killTimeoutMs: 0,
      pollIntervalMs: 25,
      signalGroup: (pgid, signal) => deliveredSignals.push({ kind: "group", pgid, signal }),
      signalProcess: (pid, signal) => deliveredSignals.push({ kind: "process", pid, signal }),
    });

    expect(deliveredSignals).toEqual([]);
    expect(evidence.registryProofHealthy).toBe(false);
    expect(evidence.verifiedRecordedPidsAbsent).toBe(false);
    expect(evidence.verifiedEmpty).toBe(false);
    expect(evidence.residualPids).toEqual([48_002]);
  });

  it("permanently excludes the root after its exact ChildProcess exit latch fires", async () => {
    const startedAt = "Thu Jul 31 12:00:00 2026";
    const ownedRows = [
      processRow(process.pid, 1, 30_001, startedAt, "vitest harness"),
      processRow(50_001, process.pid, 50_001, startedAt, "node owned-root.mjs"),
    ];
    const reusedRows = [
      processRow(process.pid, 1, 30_001, startedAt, "vitest harness"),
      processRow(50_001, process.pid, 50_001, startedAt, "unrelated direct harness child"),
    ];
    let rootAlive = true;
    let phase = "owned";
    const deliveredSignals = [];
    const tracker = createOwnedProcessTreeTracker(50_001, {
      scanIntervalMs: 5_000,
      ownerToken: "4".repeat(64),
      isRootAlive: () => rootAlive,
      readTable: async () => phase === "owned" ? ownedRows : reusedRows,
      readOwnedIdentities: async () => ({ identities: [], recordedGroupIds: [] }),
    });
    await tracker.start();
    rootAlive = false;
    phase = "reused";

    const evidence = await terminateOwnedProcessTree(tracker, {
      gracefulTimeoutMs: 0,
      killTimeoutMs: 0,
      pollIntervalMs: 25,
      signalGroup: (pgid, signal) => deliveredSignals.push({ kind: "group", pgid, signal }),
      signalProcess: (pid, signal) => deliveredSignals.push({ kind: "process", pid, signal }),
    });

    expect(deliveredSignals).toEqual([]);
    expect(evidence.leaderExitedBeforeStop).toBe(true);
    expect(evidence.verifiedRecordedPidsAbsent).toBe(false);
    expect(evidence.verifiedRecordedGroupsAbsent).toBe(false);
    expect(evidence.verifiedEmpty).toBe(false);
    expect(evidence.residualPids).toEqual([50_001]);
    expect(evidence.residualGroupIds).toEqual([50_001]);
  });

  it("keeps an ancestry-proven tokenless descendant as an anchor after reparenting", async () => {
    const startedAt = "Thu Jul 31 12:00:00 2026";
    const ownedRows = [
      processRow(process.pid, 1, 30_001, startedAt, "vitest harness"),
      processRow(52_001, process.pid, 52_001, startedAt, "node owned-root.mjs"),
      processRow(52_002, 52_001, 52_002, startedAt, "node marker-worker.mjs"),
      processRow(52_003, 52_002, 52_002, startedAt, "tokenless helper"),
    ];
    const reparentedRows = [
      processRow(process.pid, 1, 30_001, startedAt, "vitest harness"),
      processRow(52_003, 1, 52_002, startedAt, "tokenless helper"),
    ];
    const emptyRows = [processRow(process.pid, 1, 30_001, startedAt, "vitest harness")];
    let phase = "owned";
    const deliveredSignals = [];
    const tracker = createOwnedProcessTreeTracker(52_001, {
      scanIntervalMs: 25,
      ownerToken: "f".repeat(64),
      readTable: async () => phase === "owned"
        ? ownedRows
        : phase === "reparented"
          ? reparentedRows
          : emptyRows,
      readOwnedIdentities: async () => ({
        identities: phase === "owned" ? [ownedRows[2]] : [],
        recordedGroupIds: [52_002],
      }),
    });
    await tracker.start();
    phase = "reparented";

    const evidence = await terminateOwnedProcessTree(tracker, {
      gracefulTimeoutMs: 0,
      killTimeoutMs: 0,
      pollIntervalMs: 25,
      signalGroup: (pgid, signal) => {
        deliveredSignals.push({ pgid, signal });
        if (pgid === 52_002 && signal === "SIGTERM") phase = "empty";
      },
      signalProcess: () => {},
    });

    expect(deliveredSignals).toContainEqual({ pgid: 52_002, signal: "SIGSTOP" });
    expect(deliveredSignals).toContainEqual({ pgid: 52_002, signal: "SIGTERM" });
    expect(deliveredSignals).toContainEqual({ pgid: 52_002, signal: "SIGCONT" });
    expect(evidence.verifiedEmpty).toBe(true);
  });

  it("sends fallback SIGCONT when three post-SIGSTOP process-table scans fail", async () => {
    const startedAt = "Thu Jul 31 12:00:00 2026";
    const rows = [
      processRow(process.pid, 1, 30_001, startedAt, "vitest harness"),
      processRow(51_001, process.pid, 51_001, startedAt, "node owned-root.mjs"),
    ];
    let failingScans = 0;
    const deliveredSignals = [];
    const tracker = createOwnedProcessTreeTracker(51_001, {
      scanIntervalMs: 25,
      ownerToken: "b".repeat(64),
      readOwnedIdentities: async () => ({ identities: [], recordedGroupIds: [] }),
      readTable: async () => {
        if (failingScans > 0) {
          failingScans -= 1;
          throw new Error("injected ps failure after SIGSTOP");
        }
        return rows;
      },
    });
    await tracker.start();

    await expect(terminateOwnedProcessTree(tracker, {
      gracefulTimeoutMs: 0,
      killTimeoutMs: 0,
      pollIntervalMs: 25,
      signalGroup: (pgid, signal) => {
        deliveredSignals.push({ kind: "group", pgid, signal });
        if (signal === "SIGSTOP") failingScans = 3;
      },
      signalProcess: (pid, signal) => deliveredSignals.push({ kind: "process", pid, signal }),
    })).rejects.toThrow(/injected ps failure/);

    expect(deliveredSignals).toContainEqual({ kind: "group", pgid: 51_001, signal: "SIGSTOP" });
    expect(deliveredSignals).toContainEqual({ kind: "group", pgid: 51_001, signal: "SIGCONT" });
  });

  it("falls back to identity-proved PID resumes when a group SIGCONT is denied", async () => {
    const startedAt = "Thu Jul 31 12:00:00 2026";
    const ownedRows = [
      processRow(process.pid, 1, 30_001, startedAt, "vitest harness"),
      processRow(53_001, process.pid, 53_001, startedAt, "node owned-root.mjs"),
      processRow(53_002, 53_001, 53_001, startedAt, "node same-group-child.mjs"),
    ];
    const emptyRows = [processRow(process.pid, 1, 30_001, startedAt, "vitest harness")];
    let phase = "owned";
    const deliveredSignals = [];
    const resumedPids = new Set();
    const tracker = createOwnedProcessTreeTracker(53_001, {
      scanIntervalMs: 25,
      ownerToken: "9".repeat(64),
      readOwnedIdentities: async () => ({ identities: [], recordedGroupIds: [] }),
      readTable: async () => phase === "owned" ? ownedRows : emptyRows,
    });
    await tracker.start();

    const evidence = await terminateOwnedProcessTree(tracker, {
      gracefulTimeoutMs: 0,
      killTimeoutMs: 0,
      pollIntervalMs: 25,
      signalGroup: (pgid, signal) => {
        deliveredSignals.push({ kind: "group", pgid, signal });
        if (signal === "SIGCONT") {
          throw Object.assign(new Error("injected group permission failure"), { code: "EPERM" });
        }
      },
      signalProcess: (pid, signal) => {
        deliveredSignals.push({ kind: "process", pid, signal });
        if (signal !== "SIGCONT") return;
        if (pid === 53_001) {
          throw Object.assign(new Error("injected exit before per-pid resume"), { code: "ESRCH" });
        }
        resumedPids.add(pid);
        phase = "empty";
      },
    });

    expect(deliveredSignals).toContainEqual({ kind: "group", pgid: 53_001, signal: "SIGCONT" });
    expect(deliveredSignals).toContainEqual({ kind: "process", pid: 53_001, signal: "SIGCONT" });
    expect(deliveredSignals).toContainEqual({ kind: "process", pid: 53_002, signal: "SIGCONT" });
    expect([...resumedPids]).toEqual([53_002]);
    expect(evidence.verifiedEmpty).toBe(true);
  });

  it("does not try to resume an exact frozen anchor after it becomes a zombie", async () => {
    const startedAt = "Thu Jul 31 12:00:00 2026";
    const harness = processRow(process.pid, 1, 30_001, startedAt, "vitest harness", "Ss");
    const ownedRows = [
      harness,
      processRow(55_001, process.pid, 55_001, startedAt, "node owned-root.mjs", "Ss"),
      processRow(55_002, 55_001, 55_002, startedAt, "node marker-worker.mjs", "Ss"),
    ];
    const reparentedRows = [
      harness,
      processRow(55_002, 1, 55_002, startedAt, "node marker-worker.mjs", "Ss"),
    ];
    const zombieRows = [
      harness,
      processRow(55_002, 1, 55_002, startedAt, "(node)", "Z"),
    ];
    let phase = "owned";
    let rootAlive = true;
    let zombieScansRemaining = 1;
    const deliveredSignals = [];
    const tracker = createOwnedProcessTreeTracker(55_001, {
      scanIntervalMs: 25,
      ownerToken: "7".repeat(64),
      isRootAlive: () => rootAlive,
      readTable: async () => {
        if (phase === "owned") return ownedRows;
        if (phase === "reparented") return reparentedRows;
        if (zombieScansRemaining > 0) {
          zombieScansRemaining -= 1;
          return zombieRows;
        }
        return [harness];
      },
      readOwnedIdentities: async (rows) => ({
        identities: rows.filter((row) => row.pid === 55_002 && !row.state?.includes("Z")),
        recordedGroupIds: [55_002],
      }),
    });
    await tracker.start();
    rootAlive = false;
    phase = "reparented";
    await tracker.scan();

    const evidence = await terminateOwnedProcessTree(tracker, {
      gracefulTimeoutMs: 0,
      killTimeoutMs: 0,
      pollIntervalMs: 25,
      signalGroup: (pgid, signal) => {
        deliveredSignals.push({ kind: "group", pgid, signal });
        if (signal === "SIGTERM") phase = "zombie";
        if (signal === "SIGCONT") {
          throw Object.assign(new Error("injected zombie group permission failure"), { code: "EPERM" });
        }
      },
      signalProcess: (pid, signal) => deliveredSignals.push({ kind: "process", pid, signal }),
    });

    expect(deliveredSignals).toContainEqual({ kind: "group", pgid: 55_002, signal: "SIGCONT" });
    expect(deliveredSignals).not.toContainEqual({ kind: "process", pid: 55_002, signal: "SIGCONT" });
    expect(evidence.leaderExitedBeforeStop).toBe(true);
    expect(evidence.verifiedEmpty).toBe(true);
  });

  it("fails closed when a frozen non-zombie anchor loses marker proof", async () => {
    const startedAt = "Thu Jul 31 12:00:00 2026";
    const harness = processRow(process.pid, 1, 30_001, startedAt, "vitest harness", "Ss");
    const ownedRows = [
      harness,
      processRow(56_001, process.pid, 56_001, startedAt, "node owned-root.mjs", "Ss"),
      processRow(56_002, 56_001, 56_002, startedAt, "node marker-worker.mjs", "Ss"),
    ];
    const reparentedRows = [
      harness,
      processRow(56_002, 1, 56_002, startedAt, "node marker-worker.mjs", "Ss"),
    ];
    let phase = "owned";
    let rootAlive = true;
    let proofLossScansRemaining = 1;
    const tracker = createOwnedProcessTreeTracker(56_001, {
      scanIntervalMs: 25,
      ownerToken: "6".repeat(64),
      isRootAlive: () => rootAlive,
      readTable: async () => {
        if (phase === "owned") return ownedRows;
        if (phase === "reparented") return reparentedRows;
        if (proofLossScansRemaining > 0) {
          proofLossScansRemaining -= 1;
          return reparentedRows;
        }
        return [harness];
      },
      readOwnedIdentities: async (rows) => ({
        identities: phase === "proof-lost"
          ? []
          : rows.filter((row) => row.pid === 56_002),
        recordedGroupIds: [56_002],
      }),
    });
    await tracker.start();
    rootAlive = false;
    phase = "reparented";
    await tracker.scan();

    await expect(terminateOwnedProcessTree(tracker, {
      gracefulTimeoutMs: 0,
      killTimeoutMs: 0,
      pollIntervalMs: 25,
      signalGroup: (_pgid, signal) => {
        if (signal === "SIGTERM") phase = "proof-lost";
        if (signal === "SIGCONT") {
          throw Object.assign(new Error("injected group permission failure"), { code: "EPERM" });
        }
      },
      signalProcess: () => {},
    })).rejects.toThrow(
      /process-group 56002 SIGCONT failed \(EPERM\).*EOWNERSHIPPROOF.*frozen pid\(s\) 56002/,
    );
  });

  it("fails with bounded group and pid diagnostics when per-pid SIGCONT is denied", async () => {
    const startedAt = "Thu Jul 31 12:00:00 2026";
    const ownedRows = [
      processRow(process.pid, 1, 30_001, startedAt, "vitest harness"),
      processRow(54_001, process.pid, 54_001, startedAt, "node owned-root.mjs"),
    ];
    const emptyRows = [processRow(process.pid, 1, 30_001, startedAt, "vitest harness")];
    let phase = "owned";
    const tracker = createOwnedProcessTreeTracker(54_001, {
      scanIntervalMs: 25,
      ownerToken: "8".repeat(64),
      readOwnedIdentities: async () => ({ identities: [], recordedGroupIds: [] }),
      readTable: async () => phase === "owned" ? ownedRows : emptyRows,
    });
    await tracker.start();

    await expect(terminateOwnedProcessTree(tracker, {
      gracefulTimeoutMs: 0,
      killTimeoutMs: 0,
      pollIntervalMs: 25,
      signalGroup: (_pgid, signal) => {
        if (signal === "SIGCONT") {
          throw Object.assign(new Error("injected group permission failure"), { code: "EPERM" });
        }
      },
      signalProcess: (_pid, signal) => {
        if (signal === "SIGCONT") {
          throw Object.assign(new Error("injected pid permission failure"), { code: "EPERM" });
        }
        if (signal === "SIGKILL") phase = "empty";
      },
    })).rejects.toThrow(
      /process-group 54001 SIGCONT failed \(EPERM\).*per-pid SIGCONT failed for 54001:EPERM/,
    );
  });

  it("does not signal cached ownership when cleanup process-table proof is unavailable", async () => {
    const startedAt = "Thu Jul 31 12:00:00 2026";
    let liveRows = [
      processRow(process.pid, 1, 30_001, startedAt, "vitest harness"),
      processRow(71_001, process.pid, 71_001, startedAt, "node owned-root.mjs"),
    ];
    let processTableAvailable = true;
    const deliveredSignals = [];
    const tracker = createOwnedProcessTreeTracker(71_001, {
      scanIntervalMs: 25,
      ownerToken: "e".repeat(64),
      readOwnedIdentities: async () => ({ identities: [], recordedGroupIds: [] }),
      readTable: async () => {
        if (!processTableAvailable) throw new Error("injected initial cleanup ps failure");
        return liveRows;
      },
    });
    await tracker.start();

    // Model the cached numeric PID and PGID being reused by an unrelated process at the exact time
    // the OS process table becomes unavailable. Cleanup cannot see the new birth token, so it must
    // not deliver any signal based on the identity that start() cached.
    liveRows = [
      processRow(process.pid, 1, 30_001, startedAt, "vitest harness"),
      processRow(71_001, 1, 71_001, "Thu Jul 31 12:00:01 2026", "unrelated process"),
    ];
    processTableAvailable = false;

    await expect(terminateOwnedProcessTree(tracker, {
      gracefulTimeoutMs: 0,
      killTimeoutMs: 0,
      pollIntervalMs: 25,
      signalGroup: (pgid, signal) => deliveredSignals.push({ pgid, signal }),
      signalProcess: () => {},
    })).rejects.toThrow(/initial cleanup ps failure/);
    expect(deliveredSignals).toEqual([]);
  });
});

function spawnTreeFixture(options = {}) {
  const registryRoot = mkdtempSync(join(tmpdir(), "meridian-pr-review-cold-fixture-"));
  const registryPath = join(registryRoot, "owned-processes.ndjson");
  const ownerToken = randomBytes(32).toString("hex");
  writeFileSync(registryPath, "", { flag: "wx", mode: 0o600 });
  const child = spawn(process.execPath, [
    treeFixturePath,
    "root",
    ...(options.termResistantLeaf ? ["--term-resistant-leaf"] : []),
    ...(options.leaderExitsWithHelper ? ["--leader-exits-with-helper"] : []),
  ], {
    detached: true,
    env: {
      ...process.env,
      MERIDIAN_BENCHMARK_OWNER_TOKEN: ownerToken,
      MERIDIAN_BENCHMARK_OWNER_REGISTRY: registryPath,
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const context = {
    child,
    ready: null,
    tracker: null,
    capturedIdentities: [],
    stderr: "",
    registryRoot,
    registryPath,
    ownerToken,
  };
  child.stderr.on("data", (chunk) => { context.stderr += String(chunk); });
  context.readyPromise = readReadyLine(child, 8_000);
  return context;
}

async function initializeTreeFixture(context) {
  context.ready = await context.readyPromise;
  expect(context.ready.rootPid).toBe(context.child.pid);
  expect(new Set([context.ready.rootPid, context.ready.workerPid, context.ready.gitPid]).size).toBe(3);

  context.capturedIdentities = await captureFixtureIdentities(context.ready);
  expect(context.capturedIdentities).toHaveLength(3);
  context.tracker = createOwnedProcessTreeTracker(context.ready.rootPid, {
    scanIntervalMs: 25,
    ownerToken: context.ownerToken,
    registryPath: context.registryPath,
    isRootAlive: () => !childExited(context.child),
  });
  await context.tracker.start();
  await waitUntil(async () => {
    await context.tracker.scan();
    const pids = new Set(context.tracker.registeredProcesses().map((entry) => entry.pid));
    return [context.ready.rootPid, context.ready.workerPid, context.ready.gitPid].every((pid) => pids.has(pid));
  }, 5_000, "tracker did not register the full detached fixture ancestry");

  const registered = context.tracker.registeredProcesses();
  expect(new Set(registered.map((entry) => entry.pgid)).size).toBe(3);
}

async function stopTrackedFixture(context, options = {}) {
  const evidence = await terminateOwnedProcessTree(context.tracker, {
    gracefulTimeoutMs: options.gracefulTimeoutMs ?? 1_000,
    killTimeoutMs: 2_000,
    pollIntervalMs: 25,
  });
  await waitForChildExit(context.child, 2_000).catch(() => undefined);
  return evidence;
}

async function captureFixtureIdentities(ready) {
  return captureFixtureIdentitiesByPids([ready.rootPid, ready.workerPid, ready.gitPid]);
}

async function captureFixtureIdentitiesByPids(pids) {
  const expectedPids = new Set(pids);
  return waitUntil(async () => {
    const identities = (await readProcessTable()).filter((row) => expectedPids.has(row.pid));
    return identities.length === expectedPids.size ? identities : false;
  }, 5_000, "fixture processes did not become observable");
}

async function expectTrackedIdentitiesAndGroupsAbsent(tracker) {
  const registered = tracker.registeredProcesses();
  const groups = new Set(registered.map((entry) => entry.pgid));
  const rows = await readProcessTable();
  expect(registered.filter((entry) => rows.some((row) => sameIdentity(entry, row)))).toEqual([]);
  expect(rows.filter((row) => groups.has(row.pgid))).toEqual([]);
}

async function forceExactFixtureCleanup(context) {
  const known = new Map(context.capturedIdentities.map((entry) => [identityKey(entry), entry]));
  const historicalGroups = new Set();
  let ownershipProofHealthy = true;
  const discover = async (rows) => {
    const byPid = new Map(rows.map((row) => [row.pid, row]));
    const root = byPid.get(context.child.pid);
    // The root is adopted only while its immutable identity still has this exact Vitest worker as
    // parent. Detached leaders are separately authenticated by the private token registry below.
    if (root !== undefined && root.ppid === process.pid) known.set(identityKey(root), root);
    try {
      const registry = await readOwnedRegistryIdentities(
        context.registryPath,
        context.ownerToken,
        rows,
      );
      if (registry.proofHealthy !== true) ownershipProofHealthy = false;
      for (const groupId of registry.recordedGroupIds) historicalGroups.add(groupId);
      for (const identity of registry.identities) {
        const row = byPid.get(identity.pid);
        if (row !== undefined && identityKey(row) === identityKey(identity)) {
          known.set(identityKey(row), row);
        }
      }
    } catch {
      ownershipProofHealthy = false;
    }

    // Capture tokenless helpers only through a current, exact parent edge. Repeat to a fixed point
    // before each kill pass so a late child cannot escape between readiness and cleanup.
    let changed = true;
    while (changed) {
      changed = false;
      const ownedPids = new Set([...known.values()].map((entry) => entry.pid));
      for (const row of rows) {
        if (known.has(identityKey(row)) || !ownedPids.has(row.ppid)) continue;
        known.set(identityKey(row), row);
        changed = true;
      }
    }
    for (const row of known.values()) historicalGroups.add(row.pgid);
    if (context.ready !== null) {
      historicalGroups.add(context.ready.rootPid);
      historicalGroups.add(context.ready.workerPid);
      historicalGroups.add(context.ready.gitPid);
    }
  };

  let proof;
  try {
    proof = await forceExactIdentityCleanup(known, historicalGroups, discover);
  } finally {
    if (context.child.connected) context.child.disconnect();
    context.child.stdout?.destroy();
    context.child.stderr?.destroy();
    await waitForChildExit(context.child, 1_000).catch(() => undefined);
  }
  if (ownershipProofHealthy !== true || proof.verifiedEmpty !== true) {
    throw new Error(
      `owned fixture cleanup was not proved; residualPids=${proof.residualPids.join(",") || "none"}; `
      + `residualGroups=${proof.residualGroupIds.join(",") || "none"}; `
      + `registryProofHealthy=${ownershipProofHealthy}; preserved ${context.registryRoot}`,
    );
  }
  await rm(context.registryRoot, { recursive: true, force: true });
  await expect(stat(context.registryRoot)).rejects.toMatchObject({ code: "ENOENT" });
}

async function forceIdentityCleanup(identities) {
  const known = new Map(identities.map((entry) => [identityKey(entry), entry]));
  const groups = new Set(identities.map((entry) => entry.pgid));
  const proof = await forceExactIdentityCleanup(known, groups);
  if (!proof.verifiedEmpty) {
    throw new Error(
      `signal fixture cleanup was not proved; residualPids=${proof.residualPids.join(",") || "none"}; `
      + `residualGroups=${proof.residualGroupIds.join(",") || "none"}`,
    );
  }
}

async function forceExactIdentityCleanup(known, historicalGroups, discover = async () => {}) {
  let lastReadError = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    let rows;
    try {
      rows = await readProcessTable();
      lastReadError = null;
      await discover(rows);
    } catch (error) {
      lastReadError = error;
      await delay(25);
      continue;
    }
    const current = rows.filter((row) => known.has(identityKey(row)));
    for (const pgid of new Set(current.map((row) => row.pgid))) signalIgnoringMissing(-pgid, "SIGKILL");
    for (const row of current) signalIgnoringMissing(row.pid, "SIGKILL");
    const residualGroupIds = [...historicalGroups].filter((pgid) => rows.some((row) => row.pgid === pgid));
    if (current.length === 0 && residualGroupIds.length === 0) break;
    await delay(25);
  }
  if (lastReadError !== null) throw lastReadError;
  const first = await exactIdentityAbsenceProof(known, historicalGroups, discover);
  if (!first.verifiedEmpty) return first;
  await delay(50);
  return exactIdentityAbsenceProof(known, historicalGroups, discover);
}

async function exactIdentityAbsenceProof(known, historicalGroups, discover) {
  const rows = await readProcessTable();
  await discover(rows);
  const residualPids = rows
    .filter((row) => known.has(identityKey(row)))
    .map((row) => row.pid)
    .sort((left, right) => left - right);
  const residualGroupIds = [...historicalGroups]
    .filter((pgid) => rows.some((row) => row.pgid === pgid))
    .sort((left, right) => left - right);
  return {
    verifiedEmpty: residualPids.length === 0 && residualGroupIds.length === 0,
    residualPids,
    residualGroupIds,
  };
}

function readReadyLine(child, timeoutMs) {
  return new Promise((resolveReady, rejectReady) => {
    let output = "";
    const timer = setTimeout(() => finish(rejectReady, new Error("fixture readiness timed out")), timeoutMs);
    const onData = (chunk) => {
      output += String(chunk);
      const newline = output.indexOf("\n");
      if (newline < 0) return;
      try {
        const parsed = JSON.parse(output.slice(0, newline));
        if (parsed?.type !== "ready") throw new Error(`unexpected fixture output: ${output.slice(0, newline)}`);
        finish(resolveReady, parsed);
      } catch (error) {
        finish(rejectReady, error);
      }
    };
    const onError = (error) => finish(rejectReady, error);
    const onExit = (code, signal) => finish(
      rejectReady,
      new Error(`fixture exited before ready (code=${code}, signal=${signal})`),
    );
    const finish = (callback, value) => {
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
      callback(value);
    };
    child.stdout?.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

async function waitForChildExit(child, timeoutMs = 5_000) {
  if (child.exitCode !== null || child.signalCode !== null) return [child.exitCode, child.signalCode];
  return Promise.race([
    once(child, "exit"),
    delay(timeoutMs).then(() => { throw new Error(`child ${child.pid} did not exit within ${timeoutMs} ms`); }),
  ]);
}

async function waitUntil(callback, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await callback();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(message);
    await delay(25);
  }
}

function processRow(pid, ppid, pgid, startedAt, command, state) {
  return {
    pid,
    ppid,
    pgid,
    startedAt,
    command,
    ...(state === undefined ? {} : { state }),
  };
}

function sameIdentity(left, right) {
  return left.pid === right.pid
    && left.startedAt === right.startedAt;
}

function childExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function identityKey(entry) {
  return `${entry.pid}:${entry.startedAt}`;
}

function signalIgnoringMissing(pid, signal) {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
