import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  PR_PREPARE_MAX_CHANGED_PATH_BYTES,
  PR_PREPARE_MAX_CHANGED_PATH_BYTES_TOTAL,
  PR_PREPARE_MAX_WARNINGS,
  PR_PREPARE_MAX_WARNING_BYTES,
  PR_PREPARE_MAX_WARNING_BYTES_TOTAL,
} from "@meridian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MAX_PREPARED_REVIEW_HANDOFF_BYTES,
  PreparedReviewHandoffStore,
  type PreparedReviewHandoffInput,
  type PreparedReviewHandoffStoreOptions,
} from "./prepared-review-handoff-store";
import type { GraphCapabilityBinding } from "./graph-capability-store";

const HEAD_SHA = "1".repeat(40);
const BASE_SHA = "a".repeat(40);
const MERGE_BASE_SHA = "c".repeat(40);

let cacheRoot: string;
let retainedOwners: string[];
let releasedOwners: string[];
let retainedBindings: GraphCapabilityBinding[][];
let activeGraphOwners: Map<string, GraphCapabilityBinding[]>;
let graphCapabilities: PreparedReviewHandoffStoreOptions["graphCapabilities"];

beforeEach(() => {
  cacheRoot = mkdtempSync(join(tmpdir(), "meridian-prepared-review-store-"));
  retainedOwners = [];
  releasedOwners = [];
  retainedBindings = [];
  activeGraphOwners = new Map();
  graphCapabilities = {
    async retainMany(bindings, owner) {
      retainedBindings.push(bindings.map((binding) => ({ ...binding })));
      retainedOwners.push(owner.id);
      activeGraphOwners.set(owner.id, bindings.map((binding) => ({ ...binding })));
    },
    async releaseOwner(owner) {
      releasedOwners.push(owner.id);
      activeGraphOwners.delete(owner.id);
    },
    async reconcileOwners(_scope, expectations) {
      const expected = new Set(expectations.map((expectation) => expectation.owner.id));
      for (const id of [...activeGraphOwners.keys()].filter((candidate) => !expected.has(candidate))) {
        releasedOwners.push(id);
        activeGraphOwners.delete(id);
      }
      for (const expectation of expectations) {
        const bindings = expectation.bindings.map((binding) => ({ ...binding }));
        retainedBindings.push(bindings);
        retainedOwners.push(expectation.owner.id);
        activeGraphOwners.set(expectation.owner.id, bindings);
      }
      return { retainedOwners: expectations.map((expectation) => expectation.owner), failures: [] };
    },
  };
});

afterEach(() => {
  thawTestTree(cacheRoot);
  rmSync(cacheRoot, { recursive: true, force: true });
});

describe("PreparedReviewHandoffStore", () => {
  it("publishes canonical status-rich metadata and resolves it after restart", async () => {
    const first = createStore();
    const candidate = first.prepare(input());
    const reference = await first.publish(candidate, { deliver: () => undefined });

    expect(reference).toEqual({
      id: expect.stringMatching(/^prh-v1-[0-9a-f]{64}$/),
      url: `/api/pr/prepared?id=${candidate.id}`,
      viewUrl: `/view?id=pr-head-test&view=modules&prn=41&rev=1&prepared=${candidate.id}`,
    });
    expect(lstatSync(resolvedFile(candidate.id)).isFile()).toBe(true);
    expect(lstatSync(resolvedFile(candidate.id)).isSymbolicLink()).toBe(false);

    const restarted = createStore();
    const resolved = await restarted.resolve(candidate.id);
    expect(resolved?.document).toEqual(candidate.document);
    expect(resolved?.document.changedFiles).toEqual([
      { path: "src/added.ts", status: "added" },
      { path: "src/deleted.ts", status: "deleted" },
      { path: "src/modified.ts", status: "modified" },
      { path: "src/new-name.ts", previousPath: "src/old-name.ts", status: "renamed" },
    ]);
    const raw = readFileSync(resolvedFile(candidate.id), "utf8");
    expect(raw).not.toContain("token");
    expect(raw).not.toContain("artifactPath");
    expect(raw).not.toContain('"nodes"');
    expect(raw).not.toContain('"edges"');
    expect(retainedOwners).toEqual([candidate.id, candidate.id]);
    expect(retainedBindings).toEqual([expectedBindings(), expectedBindings()]);
  });

  it("publishes exact bounded bytes with immutable modes and preserves the inode idempotently", async () => {
    const store = createStore();
    const candidate = store.prepare(input());
    const first = await store.publish(candidate, { deliver: () => undefined });
    const directory = handoffDirectory(candidate.id);
    const handoff = resolvedFile(candidate.id);
    const integrity = integrityFile(candidate.id);
    const firstDirectory = lstatSync(directory);

    expect(first).toEqual(candidate.reference);
    expect(candidate.id).toBe(`prh-v1-${candidate.contentSha256}`);
    expect(firstDirectory.mode & 0o777).toBe(0o500);
    expect(lstatSync(handoff).mode & 0o777).toBe(0o400);
    expect(lstatSync(integrity).mode & 0o777).toBe(0o400);
    expect(lstatSync(handoff).size).toBe(Buffer.byteLength(candidate.serialized));
    expect(lstatSync(integrity).size).toBe(65);
    expect(readFileSync(integrity, "utf8")).toBe(`${candidate.contentSha256}\n`);

    await expect(store.publish(candidate, { deliver: () => undefined })).resolves.toEqual(first);
    expect(lstatSync(directory).ino).toBe(firstDirectory.ino);
    expect(readFileSync(handoff, "utf8")).toBe(candidate.serialized);
    expect(releasedOwners).toEqual([]);
  });

  it("content-addresses provenance and diagnostics without changing comparison descriptors", async () => {
    const store = createStore();
    const first = store.prepare(input());
    const second = store.prepare({
      ...input(),
      baseSha: "b".repeat(40),
      cache: "hit",
      timings: { resolve: 99, git: 101 },
      warnings: ["warm observation"],
    });
    expect(second.id).not.toBe(first.id);
    expect(second.contentSha256).not.toBe(first.contentSha256);
    expect(second.document.headSha).toBe(first.document.headSha);
    expect(second.document.mergeBaseSha).toBe(first.document.mergeBaseSha);
    expect(second.document.head).toEqual(first.document.head);
    expect(second.document.mergeBase).toEqual(first.document.mergeBase);
    expect(await store.publish(first, { deliver: () => undefined }))
      .not.toEqual(await store.publish(second, { deliver: () => undefined }));
    // Each URL remains bound to its exact canonical bytes before and after independent publication.
    expect((await store.resolve(first.id))?.document).toEqual(first.document);
    expect((await store.resolve(second.id))?.document).toEqual(second.document);
  });

  it("rejects credentials, malformed manifests, and oversized documents", () => {
    const store = createStore();
    expect(() => store.prepare({
      ...input(),
      request: { ...input().request, token: "secret" } as never,
    })).toThrow(/invalid/);
    expect(() => store.prepare({
      ...input(),
      changedFiles: [{ path: "src/new.ts", status: "renamed" } as never],
    })).toThrow(/invalid/);
    expect(() => store.prepare({
      ...input(),
      changedFiles: [{ path: "src/new.ts", previousPath: "src/new.ts", status: "renamed" }],
    })).toThrow(/invalid/);
    expect(() => store.prepare({
      ...input(),
      changedFiles: [{
        path: "é".repeat(Math.floor(PR_PREPARE_MAX_CHANGED_PATH_BYTES / 2) + 1),
        status: "modified",
      }],
    })).toThrow(/invalid/);
    expect(() => store.prepare({
      ...input(),
      changedFiles: Array.from(
        { length: Math.ceil(PR_PREPARE_MAX_CHANGED_PATH_BYTES_TOTAL / 4_000) + 1 },
        (_, index) => ({ path: `${index.toString(36)}/${"x".repeat(4_000)}`, status: "modified" }),
      ),
    })).toThrow(/invalid/);
    expect(() => store.prepare({
      ...input(),
      head: { ...input().head, legacyGraphId: "session-graph" } as never,
    })).toThrow(/invalid/);
    expect(() => store.prepare({
      ...input(),
      head: { ...input().head, searchUrl: "/api/graph/search?id=wrong" },
    })).toThrow(/invalid/);
    expect(() => store.prepare({
      ...input(),
      timings: { resolve: 1, totalMs: 1 } as never,
    })).toThrow(/invalid/);
    expect(() => store.prepare({
      ...input(),
      warnings: Array.from({ length: PR_PREPARE_MAX_WARNINGS + 1 }, () => "warning"),
    })).toThrow(/invalid/);
    expect(() => store.prepare({
      ...input(),
      warnings: ["x".repeat(PR_PREPARE_MAX_WARNING_BYTES + 1)],
    })).toThrow(/invalid/);
    expect(() => store.prepare({
      ...input(),
      warnings: Array.from(
        { length: Math.ceil(PR_PREPARE_MAX_WARNING_BYTES_TOTAL / PR_PREPARE_MAX_WARNING_BYTES) + 1 },
        () => "x".repeat(PR_PREPARE_MAX_WARNING_BYTES),
      ),
    })).toThrow(/invalid/);

    const small = createStore({ maxDocumentBytes: 512 });
    expect(() => small.prepare({ ...input(), warnings: ["x".repeat(512)] })).toThrow(/handoff limit/);
    expect(() => createStore({
      maxDocumentBytes: MAX_PREPARED_REVIEW_HANDOFF_BYTES + 1,
    })).toThrow(/2 MiB/);
  });

  it("fails closed for traversal ids, digest mismatches, malformed JSON, and symlinked files", async () => {
    const store = createStore();
    const first = store.prepare(input());
    await store.publish(first, { deliver: () => undefined });
    const validated = (await store.resolve(first.id))!;
    expect(await store.resolve("../../outside")).toBeNull();
    expect(await store.resolve(`prh-v1-${"z".repeat(64)}`)).toBeNull();

    chmodSync(resolvedFile(first.id), 0o600);
    writeFileSync(resolvedFile(first.id), `${JSON.stringify({ ...first.document, warnings: ["changed"] })}\n`);
    expect(validated.bytes.toString("utf8")).toBe(first.serialized);
    expect(await store.resolve(first.id)).toBeNull();

    const second = store.prepare({ ...input(), request: { ...input().request, prNumber: 42 } });
    await store.publish(second, { deliver: () => undefined });
    chmodSync(resolvedFile(second.id), 0o600);
    writeFileSync(resolvedFile(second.id), "{not json\n");
    expect(await store.resolve(second.id)).toBeNull();

    const third = store.prepare({ ...input(), request: { ...input().request, prNumber: 43 } });
    await store.publish(third, { deliver: () => undefined });
    const outside = join(cacheRoot, "outside.json");
    writeFileSync(outside, third.serialized);
    chmodSync(dirname(resolvedFile(third.id)), 0o700);
    rmSync(resolvedFile(third.id));
    symlinkSync(outside, resolvedFile(third.id));
    expect(await store.resolve(third.id)).toBeNull();
  });

  it("deterministically removes an invalid immutable entry during restart reconciliation", async () => {
    const store = createStore();
    const candidate = store.prepare(input());
    await store.publish(candidate, { deliver: () => undefined });
    const directory = handoffDirectory(candidate.id);
    chmodSync(directory, 0o700);
    writeFileSync(join(directory, "unexpected"), "not part of the bounded handoff", { mode: 0o400 });
    chmodSync(directory, 0o500);

    const restarted = createStore();
    await expect(restarted.reconcile()).resolves.toMatchObject({ entries: 0, removed: 1 });
    expect(() => lstatSync(directory)).toThrow();
    expect(activeGraphOwners.has(candidate.id)).toBe(false);
    expect(releasedOwners).toContain(candidate.id);
  });

  it("converges retain-before-stage and stage-only crash residues to no live owner", async () => {
    const store = createStore();
    const candidate = store.prepare(input());
    const shard = join(
      cacheRoot,
      "prepared-review-handoffs",
      "v1",
      candidate.id.slice("prh-v1-".length, "prh-v1-".length + 2),
    );
    mkdirSync(join(shard, ".stage-retained"), { recursive: true, mode: 0o700 });
    mkdirSync(join(shard, ".stage-only"), { mode: 0o700 });
    await graphCapabilities.retainMany(
      expectedBindings(),
      { scope: "prepared-review-handoff", id: candidate.id },
      Date.now() + 60_000,
    );
    expect(activeGraphOwners.has(candidate.id)).toBe(true);

    await expect(store.reconcile()).resolves.toEqual({ entries: 0, bytes: 0, removed: 2 });

    expect(activeGraphOwners.size).toBe(0);
    expect(releasedOwners).toContain(candidate.id);
    expect(() => lstatSync(join(shard, ".stage-retained"))).toThrow();
    expect(() => lstatSync(join(shard, ".stage-only"))).toThrow();
  });

  it("repairs release-before-delete and releases delete-before-release after restart", async () => {
    const store = createStore();
    const releasedFirst = store.prepare({
      ...input(),
      request: { ...input().request, prNumber: 81 },
    });
    const deletedFirst = store.prepare({
      ...input(),
      request: { ...input().request, prNumber: 82 },
    });
    await store.publish(releasedFirst, { deliver: () => undefined });
    await store.publish(deletedFirst, { deliver: () => undefined });

    await graphCapabilities.releaseOwner({
      scope: "prepared-review-handoff",
      id: releasedFirst.id,
    });
    const deletedDirectory = handoffDirectory(deletedFirst.id);
    thawTestTree(deletedDirectory);
    rmSync(deletedDirectory, { recursive: true, force: true });
    retainedOwners.length = 0;
    releasedOwners.length = 0;

    const restarted = createStore();
    await expect(restarted.reconcile()).resolves.toMatchObject({ entries: 1, removed: 0 });

    expect(activeGraphOwners.get(releasedFirst.id)).toEqual(expectedBindings());
    expect(activeGraphOwners.has(deletedFirst.id)).toBe(false);
    expect(retainedOwners).toContain(releasedFirst.id);
    expect(releasedOwners).toContain(deletedFirst.id);
    expect(lstatSync(handoffDirectory(releasedFirst.id)).isDirectory()).toBe(true);
  });

  it("removes a symlinked handoff destination without following it and releases its owner", async () => {
    const outside = mkdtempSync(join(tmpdir(), "meridian-prepared-review-symlink-target-"));
    try {
      const store = createStore();
      const candidate = store.prepare(input());
      await store.publish(candidate, { deliver: () => undefined });
      const directory = handoffDirectory(candidate.id);
      thawTestTree(directory);
      rmSync(directory, { recursive: true, force: true });
      writeFileSync(join(outside, "must-survive"), "outside");
      symlinkSync(outside, directory, "dir");

      const restarted = createStore();
      await expect(restarted.reconcile()).resolves.toMatchObject({ entries: 0, removed: 1 });

      expect(readFileSync(join(outside, "must-survive"), "utf8")).toBe("outside");
      expect(() => lstatSync(directory)).toThrow();
      expect(activeGraphOwners.has(candidate.id)).toBe(false);
      expect(releasedOwners).toContain(candidate.id);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("releases lifecycle admission before asynchronously removing a hostile deep quarantine", async () => {
    const cleanupStarted = deferred<void>();
    const cleanupGate = deferred<void>();
    let cleanupCalls = 0;
    const store = createStore({
      quarantineCleanup: async (_path, removeIdentityBoundTree) => {
        cleanupCalls += 1;
        cleanupStarted.resolve();
        await cleanupGate.promise;
        await removeIdentityBoundTree();
      },
    });
    const hostile = store.prepare({
      ...input(),
      request: { ...input().request, prNumber: 83 },
    });
    await store.publish(hostile, { deliver: () => undefined });
    const hostileDirectory = handoffDirectory(hostile.id);
    chmodSync(hostileDirectory, 0o700);
    let deep = join(hostileDirectory, "unexpected-deep-tree");
    mkdirSync(deep);
    for (let depth = 0; depth < 64; depth += 1) {
      deep = join(deep, `level-${depth}`);
      mkdirSync(deep);
    }
    writeFileSync(join(deep, "payload"), "hostile");
    chmodSync(hostileDirectory, 0o500);

    const reconciling = store.reconcile();
    await cleanupStarted.promise;
    expect(() => lstatSync(hostileDirectory)).toThrow();
    expect(readdirSync(quarantineRoot())).toHaveLength(1);

    const concurrent = store.prepare({
      ...input(),
      request: { ...input().request, prNumber: 84 },
    });
    let delivered = false;
    await expect(store.publish(concurrent, {
      deliver: () => {
        delivered = true;
        return undefined;
      },
    })).resolves.toEqual(concurrent.reference);
    expect(delivered).toBe(true);
    expect(cleanupCalls).toBe(1);

    cleanupGate.resolve();
    await expect(reconciling).resolves.toMatchObject({ entries: 0, removed: 1 });
    expect(readdirSync(quarantineRoot())).toEqual([]);
    expect(await store.resolve(concurrent.id)).not.toBeNull();
  });

  it("keeps a delivered publication successful when cleanup fails and drains the residue on restart", async () => {
    const cleanupFailure = new Error("injected physical cleanup failure");
    let failCleanup = true;
    const store = createStore({
      maxEntries: 1,
      quarantineCleanup: async (_path, removeIdentityBoundTree) => {
        if (failCleanup) {
          failCleanup = false;
          throw cleanupFailure;
        }
        await removeIdentityBoundTree();
      },
    });
    const first = store.prepare({
      ...input(),
      request: { ...input().request, prNumber: 85 },
    });
    const committed = store.prepare({
      ...input(),
      request: { ...input().request, prNumber: 86 },
    });
    await store.publish(first, { deliver: () => undefined });
    const deliveries: string[] = [];

    await expect(store.publish(committed, {
      deliver: (reference) => {
        deliveries.push(reference.id);
        return undefined;
      },
    })).resolves.toEqual(committed.reference);

    expect(deliveries).toEqual([committed.id]);
    expect(await store.resolve(first.id)).toBeNull();
    expect(await store.resolve(committed.id)).not.toBeNull();
    expect(readdirSync(quarantineRoot())).toHaveLength(1);

    const restarted = createStore({ maxEntries: 1 });
    await expect(restarted.reconcile()).resolves.toMatchObject({ entries: 1, removed: 0 });
    expect(readdirSync(quarantineRoot())).toEqual([]);
    expect(await restarted.resolve(committed.id)).not.toBeNull();
  });

  it("rejects a symlinked handoff cache root", () => {
    const outside = mkdtempSync(join(tmpdir(), "meridian-prepared-review-outside-"));
    try {
      symlinkSync(outside, join(cacheRoot, "prepared-review-handoffs"), "dir");
      expect(() => createStore()).toThrow(/unsafe directory/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("bounds entries with deterministic least-recently-used eviction", async () => {
    let now = Date.now();
    const store = createStore({
      maxDocumentBytes: 4 * 1024,
      maxEntries: 2,
      maxCacheBytes: 64 * 1024,
      maxAgeMs: 60_000,
      now: () => now,
    });
    const first = store.prepare({ ...input(), request: { ...input().request, prNumber: 41 } });
    await store.publish(first, { deliver: () => undefined });
    now += 100;
    const second = store.prepare({ ...input(), request: { ...input().request, prNumber: 42 } });
    await store.publish(second, { deliver: () => undefined });
    now += 100;
    expect(await store.resolve(first.id)).not.toBeNull(); // renew first for back-navigation
    now += 100;
    const third = store.prepare({ ...input(), request: { ...input().request, prNumber: 43 } });
    await store.publish(third, { deliver: () => undefined });

    expect(await store.resolve(second.id)).toBeNull();
    expect(await store.resolve(first.id)).not.toBeNull();
    expect(await store.resolve(third.id)).not.toBeNull();
    expect(await store.scavenge()).toMatchObject({ entries: 2 });
    expect(releasedOwners).toContain(second.id);
  });

  it("repairs surviving owners and releases evicted owners during restart reconciliation", async () => {
    let now = Date.now();
    const limits = {
      maxDocumentBytes: 4 * 1024,
      maxEntries: 10,
      maxCacheBytes: 64 * 1024,
      maxAgeMs: 60_000,
      now: () => now,
    };
    const store = createStore(limits);
    const first = store.prepare({ ...input(), request: { ...input().request, prNumber: 71 } });
    await store.publish(first, { deliver: () => undefined });
    now += 100;
    const second = store.prepare({ ...input(), request: { ...input().request, prNumber: 72 } });
    await store.publish(second, { deliver: () => undefined });
    retainedOwners.length = 0;
    retainedBindings.length = 0;
    releasedOwners.length = 0;

    const restarted = createStore({ ...limits, maxEntries: 1 });
    await expect(restarted.reconcile()).resolves.toEqual({ entries: 1, bytes: expect.any(Number), removed: 1 });
    expect(releasedOwners).toEqual([first.id]);
    expect(retainedOwners).toEqual([second.id]);
    expect(retainedBindings).toEqual([expectedBindings()]);
    expect(await restarted.resolve(first.id)).toBeNull();
    expect(await restarted.resolve(second.id)).not.toBeNull();
  });

  it("removes a surviving handoff whose exact graph pair cannot be repaired after restart", async () => {
    let rejectRetention = false;
    const authority = completeGraphAuthority({
      async retainMany() {
        if (rejectRetention) throw new Error("graph pair is gone");
      },
      async releaseOwner(owner) {
        releasedOwners.push(owner.id);
      },
      async reconcileOwners(_scope, expectations) {
        if (!rejectRetention) {
          return { retainedOwners: expectations.map((expectation) => expectation.owner), failures: [] };
        }
        for (const expectation of expectations) releasedOwners.push(expectation.owner.id);
        return {
          retainedOwners: [],
          failures: expectations.map((expectation) => ({
            owner: expectation.owner,
            error: new Error("graph pair is gone"),
          })),
        };
      },
    });
    const store = new PreparedReviewHandoffStore({ cacheRoot, graphCapabilities: authority });
    const candidate = store.prepare(input());
    await store.publish(candidate, { deliver: () => undefined });
    rejectRetention = true;

    const restarted = new PreparedReviewHandoffStore({ cacheRoot, graphCapabilities: authority });
    await expect(restarted.reconcile()).resolves.toMatchObject({ entries: 0, removed: 1 });
    expect(releasedOwners).toContain(candidate.id);
    expect(await restarted.resolve(candidate.id)).toBeNull();
  });

  it("releases the exact final graph owner when resolve finds an expired handoff", async () => {
    let now = Date.now();
    const activeOwners = new Set<string>();
    let sourceReclaimed = false;
    const authority = completeGraphAuthority({
      async retainMany(bindings, owner) {
        expect(bindings).toEqual(expectedBindings());
        activeOwners.add(owner.id);
        sourceReclaimed = false;
      },
      async releaseOwner(owner) {
        activeOwners.delete(owner.id);
        if (activeOwners.size === 0) sourceReclaimed = true;
      },
    });
    const store = new PreparedReviewHandoffStore({
      cacheRoot,
      graphCapabilities: authority,
      maxDocumentBytes: 4 * 1024,
      maxEntries: 2,
      maxCacheBytes: 64 * 1024,
      maxAgeMs: 1_000,
      now: () => now,
    });
    const candidate = store.prepare(input());
    await store.publish(candidate, { deliver: () => undefined });
    const handoffDirectory = dirname(resolvedFile(candidate.id));
    expect(activeOwners).toEqual(new Set([candidate.id]));

    now += 1_000;
    await expect(store.resolve(candidate.id)).resolves.toBeNull();

    expect(activeOwners).toEqual(new Set());
    expect(sourceReclaimed).toBe(true);
    expect(() => lstatSync(handoffDirectory)).toThrow();
  });

  it("serializes concurrent publications through eviction and delivers only retained references", async () => {
    let now = Date.now();
    let blockRelease = false;
    const releaseStarted = deferred<void>();
    const releaseGate = deferred<void>();
    const authority = completeGraphAuthority({
      async retainMany() {},
      async releaseOwner() {
        if (!blockRelease) return;
        releaseStarted.resolve();
        await releaseGate.promise;
      },
    });
    const store = new PreparedReviewHandoffStore({
      cacheRoot,
      graphCapabilities: authority,
      maxDocumentBytes: 4 * 1024,
      maxEntries: 2,
      maxCacheBytes: 64 * 1024,
      maxAgeMs: 60_000,
      now: () => now,
    });
    for (const prNumber of [40, 41]) {
      const seed = store.prepare({ ...input(), request: { ...input().request, prNumber } });
      await store.publish(seed, { deliver: () => undefined });
      now += 100;
    }
    const first = store.prepare({ ...input(), request: { ...input().request, prNumber: 42 } });
    const second = store.prepare({ ...input(), request: { ...input().request, prNumber: 43 } });
    blockRelease = true;
    const delivered: string[] = [];
    const firstPending = store.publish(first, {
      deliver: (reference) => {
        expect(lstatSync(resolvedFile(reference.id)).isFile()).toBe(true);
        delivered.push(reference.id);
        return undefined;
      },
    });
    await releaseStarted.promise;
    const secondPending = store.publish(second, {
      deliver: (reference) => {
        expect(lstatSync(resolvedFile(reference.id)).isFile()).toBe(true);
        delivered.push(reference.id);
        return undefined;
      },
    });
    await Promise.resolve();
    expect(delivered).toEqual([]);

    releaseGate.resolve();
    const [firstReference, secondReference] = await Promise.all([firstPending, secondPending]);
    expect(delivered).toEqual([first.id, second.id]);
    expect((await store.resolve(firstReference.id))?.document).toEqual(first.document);
    expect((await store.resolve(secondReference.id))?.document).toEqual(second.document);
  });

  it("cancels lifecycle-lock acquisition immediately without a hidden admission queue", async () => {
    let blockRelease = false;
    const releaseStarted = deferred<void>();
    const releaseGate = deferred<void>();
    const retained: string[] = [];
    const released: string[] = [];
    const authority = completeGraphAuthority({
      async retainMany(bindings, owner) {
        expect(bindings).toEqual(expectedBindings());
        retained.push(owner.id);
      },
      async releaseOwner(owner) {
        released.push(owner.id);
        if (!blockRelease) return;
        releaseStarted.resolve();
        await releaseGate.promise;
      },
    });
    const store = new PreparedReviewHandoffStore({
      cacheRoot,
      graphCapabilities: authority,
      maxDocumentBytes: 4 * 1024,
      maxEntries: 1,
      maxCacheBytes: 64 * 1024,
      maxAgeMs: 60_000,
    });
    const seed = store.prepare({ ...input(), request: { ...input().request, prNumber: 61 } });
    const predecessor = store.prepare({ ...input(), request: { ...input().request, prNumber: 62 } });
    const cancelled = store.prepare({ ...input(), request: { ...input().request, prNumber: 63 } });
    await store.publish(seed, { deliver: () => undefined });

    blockRelease = true;
    const predecessorPending = store.publish(predecessor, { deliver: () => undefined });
    await releaseStarted.promise;
    let delivered = false;
    const controller = new AbortController();
    const cancelledPending = store.publish(cancelled, {
      signal: controller.signal,
      deliver: () => {
        delivered = true;
        return undefined;
      },
    });
    await Promise.resolve();
    controller.abort(new DOMException("client left", "AbortError"));
    await expect(cancelledPending).rejects.toMatchObject({ name: "AbortError" });
    expect(delivered).toBe(false);
    expect(retained).not.toContain(cancelled.id);
    releaseGate.resolve();
    await predecessorPending;
    expect(released).toContain(seed.id);
    expect(await store.resolve(cancelled.id)).toBeNull();
  });

  it.each(["reconcile", "resolve", "scavenge"] as const)(
    "cancels %s while waiting for lifecycle admission",
    async (operation) => {
      let blockRelease = false;
      const releaseStarted = deferred<void>();
      const releaseGate = deferred<void>();
      const authority = completeGraphAuthority({
        async releaseOwner() {
          if (!blockRelease) return;
          releaseStarted.resolve();
          await releaseGate.promise;
        },
      });
      const store = new PreparedReviewHandoffStore({
        cacheRoot,
        graphCapabilities: authority,
        maxDocumentBytes: 4 * 1024,
        maxEntries: 1,
        maxCacheBytes: 64 * 1024,
        maxAgeMs: 60_000,
      });
      const seed = store.prepare({ ...input(), request: { ...input().request, prNumber: 64 } });
      const predecessor = store.prepare({
        ...input(),
        request: { ...input().request, prNumber: 65 },
      });
      await store.publish(seed, { deliver: () => undefined });

      blockRelease = true;
      const predecessorPending = store.publish(predecessor, { deliver: () => undefined });
      await releaseStarted.promise;
      const controller = new AbortController();
      const pending = operation === "reconcile"
        ? store.reconcile({ signal: controller.signal })
        : operation === "resolve"
          ? store.resolve(seed.id, { signal: controller.signal })
          : store.scavenge({ signal: controller.signal });
      await Promise.resolve();
      controller.abort(new DOMException("server shutdown", "AbortError"));

      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      releaseGate.resolve();
      await predecessorPending;
    },
  );

  it("observes shutdown during a bounded startup scan and leaves durable claims", async () => {
    const controller = new AbortController();
    let scanCheckpoints = 0;
    const store = createStore({
      afterMaintenanceCheckpoint: (phase) => {
        if (phase === "scan" && scanCheckpoints++ === 0) {
          controller.abort(new DOMException("stop startup scan", "AbortError"));
        }
      },
    });
    populateInvalidHandoffShards(70);

    await expect(store.reconcile({ signal: controller.signal }))
      .rejects.toMatchObject({ name: "AbortError" });

    expect(readdirSync(quarantineRoot())).toHaveLength(32);
    expect(readdirSync(handoffVersionRoot())).toHaveLength(38);
  });

  it("reconciles durable scan residue successfully after restart", async () => {
    const controller = new AbortController();
    let scanCheckpoints = 0;
    const interrupted = createStore({
      afterMaintenanceCheckpoint: (phase) => {
        if (phase === "scan" && scanCheckpoints++ === 0) {
          controller.abort(new DOMException("stop startup scan", "AbortError"));
        }
      },
    });
    populateInvalidHandoffShards(70);
    await expect(interrupted.reconcile({ signal: controller.signal }))
      .rejects.toMatchObject({ name: "AbortError" });

    const restarted = createStore();
    await expect(restarted.reconcile()).resolves.toEqual({ entries: 0, bytes: 0, removed: 38 });
    expect(readdirSync(quarantineRoot())).toEqual([]);
    expect(readdirSync(handoffVersionRoot())).toEqual([]);
  });

  it("forwards startup cancellation through graph-owner reconciliation", async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const authority = completeGraphAuthority({
      async reconcileOwners(_scope, expectations, options) {
        receivedSignal = options?.signal;
        controller.abort(new DOMException("stop owner reconciliation", "AbortError"));
        return { retainedOwners: expectations.map((entry) => entry.owner), failures: [] };
      },
    });
    const store = new PreparedReviewHandoffStore({ cacheRoot, graphCapabilities: authority });
    const candidate = store.prepare(input());
    await store.publish(candidate, { deliver: () => undefined });

    await expect(store.reconcile({ signal: controller.signal }))
      .rejects.toMatchObject({ name: "AbortError" });

    expect(receivedSignal).toBe(controller.signal);
    expect(await store.resolve(candidate.id)).not.toBeNull();
  });

  it("forwards request cancellation authority while releasing an expired handoff owner", async () => {
    let now = 1_000;
    let receivedSignal: AbortSignal | undefined;
    const authority = completeGraphAuthority({
      async releaseOwner(_owner, options) {
        receivedSignal = options?.signal;
      },
    });
    const store = new PreparedReviewHandoffStore({
      cacheRoot,
      graphCapabilities: authority,
      maxAgeMs: 100,
      now: () => now,
    });
    const candidate = store.prepare(input());
    await store.publish(candidate, { deliver: () => undefined });
    now = 1_101;
    const controller = new AbortController();

    await expect(store.resolve(candidate.id, { signal: controller.signal })).resolves.toBeNull();
    expect(receivedSignal).toBe(controller.signal);
  });

  it("rejects a directory path swap between validated read and non-follow renewal", async () => {
    let retainCount = 0;
    let candidate!: ReturnType<PreparedReviewHandoffStore["prepare"]>;
    let displaced = "";
    const authority = completeGraphAuthority({
      async retainMany() {
        retainCount += 1;
        if (retainCount !== 2) return;
        displaced = replaceHandoffDirectory(candidate.id, "renewal replacement");
      },
    });
    const store = new PreparedReviewHandoffStore({ cacheRoot, graphCapabilities: authority });
    candidate = store.prepare(input());
    await store.publish(candidate, { deliver: () => undefined });

    await expect(store.resolve(candidate.id)).rejects.toThrow(/lifetime renewal failed/);
    expect(readFileSync(join(handoffDirectory(candidate.id), "replacement"), "utf8"))
      .toBe("renewal replacement");
    expect(lstatSync(displaced).isDirectory()).toBe(true);
  });

  it("preserves a CAS replacement when expiry observes a different directory identity", async () => {
    let now = Date.now();
    let swapOnNextClockRead = false;
    let candidate!: ReturnType<PreparedReviewHandoffStore["prepare"]>;
    let displaced = "";
    const store = createStore({
      maxAgeMs: 1_000,
      now: () => {
        if (swapOnNextClockRead) {
          swapOnNextClockRead = false;
          displaced = replaceHandoffDirectory(candidate.id, "expiry replacement");
        }
        return now;
      },
    });
    candidate = store.prepare(input());
    await store.publish(candidate, { deliver: () => undefined });
    now += 1_000;
    swapOnNextClockRead = true;

    await expect(store.resolve(candidate.id)).rejects.toThrow(/changed while expiring/);
    expect(readFileSync(join(handoffDirectory(candidate.id), "replacement"), "utf8"))
      .toBe("expiry replacement");
    expect(lstatSync(displaced).isDirectory()).toBe(true);
    expect(releasedOwners).not.toContain(candidate.id);
  });

  it("rejects thenable delivery and rolls back the handoff with its source owner", async () => {
    const store = createStore();
    const candidate = store.prepare(input());
    const asyncDelivery = (() => Promise.resolve()) as unknown as (
      reference: typeof candidate.reference,
    ) => undefined;

    await expect(store.publish(candidate, { deliver: asyncDelivery }))
      .rejects.toThrow("prepared-review publication delivery must be synchronous");

    expect(await store.resolve(candidate.id)).toBeNull();
    expect(retainedOwners).toContain(candidate.id);
    expect(releasedOwners).toContain(candidate.id);
    expect(retainedBindings).toContainEqual(expectedBindings());
  });

  it("serializes resolve renewal ahead of a publishing scavenge", async () => {
    let now = Date.now();
    const resolveStarted = deferred<void>();
    const resolveGate = deferred<void>();
    const retainCounts = new Map<string, number>();
    let protectedOwner = "";
    const authority = completeGraphAuthority({
      async retainMany(bindings, owner) {
        expect(bindings).toEqual(expectedBindings());
        const count = (retainCounts.get(owner.id) ?? 0) + 1;
        retainCounts.set(owner.id, count);
        if (owner.id === protectedOwner && count > 1) {
          resolveStarted.resolve();
          await resolveGate.promise;
        }
      },
    });
    const store = new PreparedReviewHandoffStore({
      cacheRoot,
      graphCapabilities: authority,
      maxDocumentBytes: 4 * 1024,
      maxEntries: 2,
      maxCacheBytes: 64 * 1024,
      maxAgeMs: 60_000,
      now: () => now,
    });
    const first = store.prepare({ ...input(), request: { ...input().request, prNumber: 51 } });
    const second = store.prepare({ ...input(), request: { ...input().request, prNumber: 52 } });
    await store.publish(first, { deliver: () => undefined });
    now += 100;
    await store.publish(second, { deliver: () => undefined });
    now += 100;
    protectedOwner = first.id;

    const resolving = store.resolve(first.id);
    await resolveStarted.promise;
    now += 100;
    const third = store.prepare({ ...input(), request: { ...input().request, prNumber: 53 } });
    const publishing = store.publish(third, { deliver: () => undefined });
    resolveGate.resolve();
    await expect(resolving).resolves.not.toBeNull();
    await publishing;

    expect(await store.resolve(second.id)).toBeNull();
    expect(await store.resolve(first.id)).not.toBeNull();
    expect(await store.resolve(third.id)).not.toBeNull();
  });

  it("bounds total bytes and scavenges expired entries on restart", async () => {
    let now = Date.now();
    const limits = {
      maxDocumentBytes: 4 * 1024,
      maxEntries: 10,
      maxCacheBytes: 4 * 1024 + 65,
      maxAgeMs: 1_000,
      now: () => now,
    };
    const store = createStore(limits);
    for (let prNumber = 50; prNumber < 53; prNumber += 1) {
      const candidate = store.prepare({
        ...input(),
        request: { ...input().request, prNumber },
        warnings: ["w".repeat(512)],
      });
      await store.publish(candidate, { deliver: () => undefined });
      now += 100;
    }
    const bounded = await store.scavenge();
    expect(bounded.bytes).toBeLessThanOrEqual(limits.maxCacheBytes);
    expect(bounded.entries).toBeLessThan(3);

    now += limits.maxAgeMs + 1;
    const restarted = createStore(limits);
    expect(await restarted.scavenge()).toMatchObject({ entries: 0, bytes: 0 });
  });
});

function input(): PreparedReviewHandoffInput {
  return {
    request: {
      owner: "org",
      repo: "repo",
      subdir: "packages/app",
      prNumber: 41,
      baseRef: "main",
      headRef: "feature/review",
    },
    headSha: HEAD_SHA,
    baseSha: BASE_SHA,
    mergeBaseSha: MERGE_BASE_SHA,
    changedFiles: [
      { path: "src/added.ts", status: "added" },
      { path: "src/deleted.ts", status: "deleted" },
      { path: "src/modified.ts", status: "modified" },
      { path: "src/new-name.ts", previousPath: "src/old-name.ts", status: "renamed" },
    ],
    head: descriptor("pr-head-test"),
    mergeBase: descriptor("pr-base-test"),
    cache: "miss",
    timings: { resolve: 1.25, git: 2, "extract-head": 3, "extract-merge-base": 4, publish: 5 },
    warnings: [],
  };
}

function descriptor(graphId: string) {
  const id = encodeURIComponent(graphId);
  return {
    graphId,
    manifestUrl: `/api/graph/manifest?id=${id}`,
    projectionUrl: `/api/graph/projection?id=${id}`,
    searchUrl: `/api/graph/search?id=${id}`,
    sourceUrl: `/api/source?id=${id}`,
    metaUrl: `/api/meta?id=${id}`,
    graphSummary: {
      schemaVersion: "1.1.0",
      generatedAt: "2026-07-16T00:00:00.000Z",
      nodeCount: 10,
      edgeCount: 9,
    },
  };
}

function resolvedFile(id: string): string {
  const path = join(handoffDirectory(id), "handoff.json");
  mkdirSync(dirname(path), { recursive: true });
  return path;
}

function integrityFile(id: string): string {
  return join(handoffDirectory(id), "sha256");
}

function handoffDirectory(id: string): string {
  const digest = id.slice("prh-v1-".length);
  return join(cacheRoot, "prepared-review-handoffs", "v1", digest.slice(0, 2), id);
}

function quarantineRoot(): string {
  return join(cacheRoot, "prepared-review-handoffs", "quarantine-v1");
}

function handoffVersionRoot(): string {
  return join(cacheRoot, "prepared-review-handoffs", "v1");
}

function populateInvalidHandoffShards(count: number): void {
  for (let index = 0; index < count; index += 1) {
    mkdirSync(join(handoffVersionRoot(), `invalid-${String(index).padStart(3, "0")}`));
  }
}

function replaceHandoffDirectory(id: string, marker: string): string {
  const directory = handoffDirectory(id);
  const displaced = join(dirname(directory), `.displaced-${id}`);
  renameSync(directory, displaced);
  mkdirSync(directory, { mode: 0o700 });
  writeFileSync(join(directory, "replacement"), marker, { mode: 0o400 });
  chmodSync(directory, 0o500);
  return displaced;
}

function createStore(
  overrides: Omit<Partial<PreparedReviewHandoffStoreOptions>, "cacheRoot" | "graphCapabilities"> = {},
): PreparedReviewHandoffStore {
  return new PreparedReviewHandoffStore({ cacheRoot, graphCapabilities, ...overrides });
}

function completeGraphAuthority(
  overrides: Partial<PreparedReviewHandoffStoreOptions["graphCapabilities"]>,
): PreparedReviewHandoffStoreOptions["graphCapabilities"] {
  return {
    async retainMany() {},
    async releaseOwner() {},
    async reconcileOwners(_scope, expectations) {
      return { retainedOwners: expectations.map((expectation) => expectation.owner), failures: [] };
    },
    ...overrides,
  };
}

function expectedBindings(): GraphCapabilityBinding[] {
  return [
    { id: "pr-head-test", expectedVcsCommit: HEAD_SHA },
    { id: "pr-base-test", expectedVcsCommit: MERGE_BASE_SHA },
  ];
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function thawTestTree(path: string): void {
  let entry;
  try {
    entry = lstatSync(path);
  } catch {
    return;
  }
  if (!entry.isDirectory() || entry.isSymbolicLink()) return;
  chmodSync(path, 0o700);
  for (const child of readdirSync(path)) thawTestTree(join(path, child));
}
