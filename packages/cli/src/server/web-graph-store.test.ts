import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GraphArtifact } from "@meridian/core";
import {
  artifactSummary,
  materializeValidatedArtifact,
  verifiedArtifactFile,
  WebGraphStore,
  WebGraphViewLeaseError,
  type WebGraphRegistration,
  type WebGraphStoreMaintenance,
} from "./web-graph-store";
import type { GraphRetentionOptions } from "./web-graph-retention";

const NODE_ID = "ts:src/order.ts#placeOrder";

const ARTIFACT: GraphArtifact = {
  schemaVersion: "1.1.0",
  generatedAt: "2026-07-20T00:00:00.000Z",
  generator: { name: "meridian-test", version: "1" },
  target: { name: "shop", root: ".", language: "typescript" },
  nodes: [{
    id: NODE_ID,
    kind: "function",
    qualifiedName: "placeOrder",
    displayName: "placeOrder",
    location: { file: "src/order.ts", startLine: 1, endLine: 3 },
  }],
  edges: [],
};

const stores: WebGraphStore[] = [];
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("WebGraphStore", () => {
  it("hashes untrusted ids instead of using them as filesystem paths", () => {
    const store = createStore();
    const id = "../../outside/graph?x=1";
    store.publish(registration(id));

    const path = registrationPath(store, id);
    expect(path).toBeDefined();
    expect(relative(store.rootPath, path!)).not.toMatch(/^\.\.(?:\/|$)/);
    expect(dirname(path!)).not.toContain("outside");
    expect(readdirSync(store.rootPath)).toHaveLength(1);
    expect(hasRegistration(store, "")).toBe(false);
    expect(hasRegistration(store, "../../outside/other")).toBe(false);
  });

  it("persists only a bounded descriptor beside the artifact", () => {
    const store = createStore();
    const descriptor = store.publish(registration("graph-1"));
    const path = registrationPath(store, "graph-1")!;
    const raw = JSON.parse(readFileSync(join(dirname(path), "descriptor.json"), "utf8")) as Record<string, unknown>;

    expect(descriptor).toEqual({
      formatVersion: 1,
      id: "graph-1",
      byteDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      summary: {
        schemaVersion: ARTIFACT.schemaVersion,
        generatedAt: ARTIFACT.generatedAt,
        nodeCount: 1,
        edgeCount: 0,
      },
      sourceRoot: "/workspace/shop",
      source: { kind: "path" },
      synthetic: { scenarios: [], sourceFingerprint: null, trust: null },
    });
    expect(raw).toEqual(descriptor);
    expect(raw).not.toHaveProperty("artifact");
    expect(raw).not.toHaveProperty("nodes");
    expect(JSON.stringify(raw)).not.toContain(NODE_ID);
  });

  it("accepts an exact republish and rejects every conflicting immutable coordinate", () => {
    const store = createStore();
    const first = store.publish(registration("graph-1"));
    const second = store.publish(registration("graph-1"));

    expect(second).toEqual(first);
    expect(readdirSync(store.rootPath)).toHaveLength(1);
    expect(() => store.publish(registration("graph-1", {
      metadata: {
        sourceRoot: "/workspace/other",
        source: { kind: "path" },
        synthetic: { scenarios: [], sourceFingerprint: null, trust: null },
      },
    }))).toThrow(/different immutable coordinates/);
    expect(() => store.publish(registration("graph-1", {
      material: materializeValidatedArtifact({ ...ARTIFACT, generatedAt: "2026-07-20T00:00:01.000Z" }),
    }))).toThrow(/different immutable coordinates/);
  });

  it("retains a newly published source lease until disposal", () => {
    const store = createStore();
    const release = vi.fn();

    store.publish(registrationWithLease("leased-graph", release));

    expect(release).not.toHaveBeenCalled();
    store.dispose();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("evicts inactive registrations deterministically to the low watermark", () => {
    let now = 1_000;
    const store = createStore({
      maxEntries: 2,
      lowWaterEntries: 1,
      publicationHandoffTtlMs: 0,
      now: () => now,
    });
    const releaseFirst = vi.fn();
    const releaseSecond = vi.fn();
    const releaseNewest = vi.fn();

    store.publish(registrationWithLease("first", releaseFirst));
    now += 1;
    store.publish(registrationWithLease("second", releaseSecond));
    now += 1;
    store.publish(registrationWithLease("newest", releaseNewest));

    expect(store.stats()).toMatchObject({ registrations: 1, sourceLeases: 1 });
    expect(hasRegistration(store, "first")).toBe(false);
    expect(hasRegistration(store, "second")).toBe(false);
    expect(hasRegistration(store, "newest")).toBe(true);
    expect(releaseFirst).toHaveBeenCalledTimes(1);
    expect(releaseSecond).toHaveBeenCalledTimes(1);
    expect(releaseNewest).not.toHaveBeenCalled();
  });

  it("admits temporary pressure while an active browser view is pinned, then evicts on release", () => {
    const store = createStore({
      maxEntries: 1,
      lowWaterEntries: 0,
      publicationHandoffTtlMs: 0,
    });
    const releaseBase = vi.fn();
    const releaseInactive = vi.fn();
    store.publish(registrationWithLease("base", releaseBase));
    const view = store.createViewLease("base");

    store.publish(registrationWithLease("inactive", releaseInactive));

    expect(store.stats()).toMatchObject({ registrations: 2, sourceLeases: 2 });
    expect(releaseBase).not.toHaveBeenCalled();
    expect(releaseInactive).not.toHaveBeenCalled();

    store.releaseViewLease(view.leaseId);
    expect(store.stats()).toMatchObject({ registrations: 0, sourceLeases: 0 });
    expect(releaseBase).toHaveBeenCalledTimes(1);
    expect(releaseInactive).toHaveBeenCalledTimes(1);
  });

  it("atomically replaces a view set and preserves the old pins after a failed replacement", () => {
    const store = createStore({ publicationHandoffTtlMs: 0 });
    store.publish(registration("base"));
    store.publish(registration("head"));
    const view = store.createViewLease("base");
    store.renewViewLease(view.leaseId, ["base", "head"]);

    expect(() => store.renewViewLease(view.leaseId, ["base", "missing"]))
      .toThrow(WebGraphViewLeaseError);
    expect(store.stats().viewLeases).toBe(1);
    expect(hasRegistration(store, "base")).toBe(true);
    expect(hasRegistration(store, "head")).toBe(true);
  });

  it("expires abandoned views and releases their newly eligible source workspaces", () => {
    let now = 100;
    const store = createStore({
      maxIdleMs: 10,
      publicationHandoffTtlMs: 0,
      viewLeaseTtlMs: 10,
      now: () => now,
    });
    const release = vi.fn();
    store.publish(registrationWithLease("base", release));
    store.createViewLease("base");

    now = 110;
    store.sweep();

    expect(store.stats()).toMatchObject({ registrations: 0, sourceLeases: 0, viewLeases: 0 });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("recreates an expired browser view atomically while its inactive graphs remain cached", () => {
    let now = 100;
    const store = createStore({
      maxIdleMs: 1_000,
      publicationHandoffTtlMs: 0,
      viewLeaseTtlMs: 10,
      now: () => now,
    });
    store.publish(registration("base"));
    store.publish(registration("head"));
    const expired = store.createViewLease("base", ["base", "head"]);

    now = 110;
    expect(() => store.renewViewLease(expired.leaseId, ["base", "head"]))
      .toThrow(/lease has expired/);
    const recreated = store.createViewLease("base", ["base", "head"]);

    expect(recreated.leaseId).not.toBe(expired.leaseId);
    expect(store.stats()).toMatchObject({ registrations: 2, viewLeases: 1 });
    store.releaseViewLease(recreated.leaseId);
  });

  it("admits temporary pressure while a request is pinned, then evicts on release", () => {
    const store = createStore({
      maxEntries: 1,
      lowWaterEntries: 0,
      publicationHandoffTtlMs: 0,
    });
    const releasePinned = vi.fn();
    const releaseOther = vi.fn();
    store.publish(registrationWithLease("pinned", releasePinned));
    const request = store.acquire("pinned")!;

    store.publish(registrationWithLease("other", releaseOther));

    expect(request.loadArtifact()).toEqual(ARTIFACT);
    expect(store.stats()).toMatchObject({ registrations: 2, sourceLeases: 2 });
    expect(releasePinned).not.toHaveBeenCalled();
    expect(releaseOther).not.toHaveBeenCalled();

    request.release();
    request.release();
    expect(store.stats()).toMatchObject({ registrations: 0, sourceLeases: 0 });
    expect(releasePinned).toHaveBeenCalledTimes(1);
    expect(releaseOther).toHaveBeenCalledTimes(1);

    store.publish(registration("replacement"));
    expect(store.stats().registrations).toBe(1);
  });

  it("admits concurrent publication handoffs and evicts after their reservations expire", () => {
    let now = 1_000;
    const store = createStore({
      maxEntries: 1,
      lowWaterEntries: 0,
      publicationHandoffTtlMs: 100,
      now: () => now,
    });
    const releaseFirst = vi.fn();
    const releaseSecond = vi.fn();
    store.publish(registrationWithLease("first", releaseFirst));

    now += 1;
    store.publish(registrationWithLease("second", releaseSecond));

    expect(store.stats()).toMatchObject({ registrations: 2, sourceLeases: 2 });
    expect(hasRegistration(store, "first")).toBe(true);
    expect(hasRegistration(store, "second")).toBe(true);
    expect(releaseFirst).not.toHaveBeenCalled();
    expect(releaseSecond).not.toHaveBeenCalled();

    now += 100;
    store.sweep();
    expect(store.stats()).toMatchObject({ registrations: 0, sourceLeases: 0 });
    expect(releaseFirst).toHaveBeenCalledTimes(1);
    expect(releaseSecond).toHaveBeenCalledTimes(1);
  });

  it("publishes an oversized batch atomically and returns to its retention target on sweep", () => {
    const removePath = vi.fn((path: string) => rmSync(path, { recursive: true, force: true }));
    const store = createStore({
      maxEntries: 2,
      lowWaterEntries: 1,
      publicationHandoffTtlMs: 0,
    }, { removePath });
    const releaseFirst = vi.fn();
    const releaseSecond = vi.fn();
    store.publish(registrationWithLease("first", releaseFirst));
    store.publish(registrationWithLease("second", releaseSecond));
    removePath.mockClear();
    const batchReleases = [vi.fn(), vi.fn(), vi.fn()];

    const descriptors = store.publishBatch([
      registrationWithLease("head", batchReleases[0]!),
      registrationWithLease("comparison", batchReleases[1]!),
      registrationWithLease("extra", batchReleases[2]!),
    ]);

    expect(descriptors.map(({ id }) => id)).toEqual(["head", "comparison", "extra"]);
    expect(store.stats()).toMatchObject({ registrations: 3, sourceLeases: 3 });
    expect(releaseFirst).toHaveBeenCalledTimes(1);
    expect(releaseSecond).toHaveBeenCalledTimes(1);
    for (const release of batchReleases) expect(release).not.toHaveBeenCalled();
    expect(removePath).toHaveBeenCalled();

    store.sweep();
    expect(store.stats()).toMatchObject({ registrations: 1, sourceLeases: 1 });
    expect(batchReleases.reduce((total, release) => total + release.mock.calls.length, 0)).toBe(2);
  });

  it("publishes a coherent graph pair in one admission transaction", () => {
    const store = createStore({ maxEntries: 2, lowWaterEntries: 1 });
    const releaseHead = vi.fn();
    const releaseComparison = vi.fn();

    const descriptors = store.publishBatch([
      registrationWithLease("head", releaseHead),
      registrationWithLease("comparison", releaseComparison),
    ]);

    expect(descriptors.map(({ id }) => id)).toEqual(["head", "comparison"]);
    expect(store.stats()).toMatchObject({ registrations: 2, sourceLeases: 2 });
    expect(hasRegistration(store, "head")).toBe(true);
    expect(hasRegistration(store, "comparison")).toBe(true);
    expect(releaseHead).not.toHaveBeenCalled();
    expect(releaseComparison).not.toHaveBeenCalled();
  });

  it("keeps publishing while victim cleanup is pending and recovers after maintenance succeeds", () => {
    const artifactBytes = materializeValidatedArtifact(ARTIFACT).bytes.length;
    let now = 1_000;
    let failEvictionRemoval = true;
    const onError = vi.fn();
    const removePath = vi.fn((path: string) => {
      if (
        failEvictionRemoval
        && path.includes(".eviction-")
        && readdirSync(path).length > 0
      ) {
        const partiallyRemovedArtifact = join(path, "0", "artifact.json");
        if (existsSync(partiallyRemovedArtifact)) unlinkSync(partiallyRemovedArtifact);
        throw new Error("injected removal failure");
      }
      rmSync(path, { recursive: true, force: true });
    });
    const store = createStore({
      maxArtifactBytes: artifactBytes,
      lowWaterArtifactBytes: 0,
      publicationHandoffTtlMs: 100,
      now: () => now,
    }, { onError, removePath });
    const releaseFirst = vi.fn();
    const releaseReplacement = vi.fn();
    const releaseAdditional = vi.fn();
    store.publish(registrationWithLease("first", releaseFirst));
    now += 100;

    store.publish(registrationWithLease("replacement", releaseReplacement));
    expect(store.stats()).toMatchObject({
      registrations: 1,
      artifactBytes: artifactBytes * 2,
      trashEntries: 1,
      trashBytes: artifactBytes,
    });
    expect(hasRegistration(store, "first")).toBe(false);
    expect(hasRegistration(store, "replacement")).toBe(true);
    expect(releaseFirst).toHaveBeenCalledTimes(1);
    expect(releaseReplacement).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalled();

    store.publish(registrationWithLease("additional", releaseAdditional));
    expect(store.stats()).toMatchObject({
      registrations: 2,
      artifactBytes: artifactBytes * 3,
      trashEntries: 1,
    });
    expect(hasRegistration(store, "replacement")).toBe(true);
    expect(hasRegistration(store, "additional")).toBe(true);
    expect(releaseAdditional).not.toHaveBeenCalled();

    failEvictionRemoval = false;
    now += 100;
    store.sweep();
    expect(store.stats()).toMatchObject({
      registrations: 0,
      artifactBytes: 0,
      trashEntries: 0,
      trashBytes: 0,
    });
    expect(releaseReplacement).toHaveBeenCalledTimes(1);
    expect(releaseAdditional).toHaveBeenCalledTimes(1);

    store.publish(registration("recovered"));
    expect(store.stats()).toMatchObject({
      registrations: 1,
      artifactBytes,
      trashEntries: 0,
      trashBytes: 0,
    });
    expect(hasRegistration(store, "replacement")).toBe(false);
    expect(hasRegistration(store, "recovered")).toBe(true);
  });

  it("restores eviction victims when a later batch destination cannot be committed", () => {
    let failComparisonCommit = false;
    const renamePath = vi.fn((source: string, destination: string) => {
      if (
        failComparisonCommit
        && source.includes(".stage-")
        && destination.endsWith(createHash("sha256").update("comparison").digest("hex"))
      ) {
        throw new Error("injected destination rename failure");
      }
      renameSync(source, destination);
    });
    const store = createStore({
      maxEntries: 2,
      lowWaterEntries: 1,
      publicationHandoffTtlMs: 0,
    }, { renamePath });
    const releaseOriginal = vi.fn();
    const releaseHead = vi.fn();
    const releaseComparison = vi.fn();
    store.publish(registrationWithLease("original", releaseOriginal));
    failComparisonCommit = true;

    expect(() => store.publishBatch([
      registrationWithLease("head", releaseHead),
      registrationWithLease("comparison", releaseComparison),
    ])).toThrow(/injected destination rename failure/);

    expect(hasRegistration(store, "original")).toBe(true);
    expect(hasRegistration(store, "head")).toBe(false);
    expect(hasRegistration(store, "comparison")).toBe(false);
    expect(releaseOriginal).not.toHaveBeenCalled();
    expect(releaseHead).toHaveBeenCalledTimes(1);
    expect(releaseComparison).toHaveBeenCalledTimes(1);
  });

  it("accounts victim bytes when both rollback and reservation cleanup fail", () => {
    const artifactBytes = materializeValidatedArtifact(ARTIFACT).bytes.length;
    let injectFailures = false;
    let originalPath = "";
    const onError = vi.fn();
    const renamePath = vi.fn((source: string, destination: string) => {
      if (
        injectFailures
        && source.includes(".stage-")
        && destination.endsWith(createHash("sha256").update("comparison").digest("hex"))
      ) {
        throw new Error("injected destination rename failure");
      }
      if (injectFailures && source.includes(".eviction-") && destination === originalPath) {
        throw new Error("injected victim restore failure");
      }
      renameSync(source, destination);
    });
    const removePath = vi.fn((path: string) => {
      if (injectFailures && path.includes(".eviction-")) {
        throw new Error("injected reservation cleanup failure");
      }
      rmSync(path, { recursive: true, force: true });
    });
    const store = createStore({
      maxEntries: 2,
      lowWaterEntries: 1,
      publicationHandoffTtlMs: 0,
    }, { onError, removePath, renamePath });
    const releaseOriginal = vi.fn();
    const releaseHead = vi.fn();
    const releaseComparison = vi.fn();
    store.publish(registrationWithLease("original", releaseOriginal));
    originalPath = dirname(registrationPath(store, "original")!);
    injectFailures = true;

    expect(() => store.publishBatch([
      registrationWithLease("head", releaseHead),
      registrationWithLease("comparison", releaseComparison),
    ])).toThrow(/injected destination rename failure/);

    expect(store.stats()).toMatchObject({
      registrations: 0,
      artifactBytes,
      trashEntries: 1,
      trashBytes: artifactBytes,
    });
    expect(hasRegistration(store, "original")).toBe(false);
    expect(hasRegistration(store, "head")).toBe(false);
    expect(hasRegistration(store, "comparison")).toBe(false);
    expect(releaseOriginal).toHaveBeenCalledTimes(1);
    expect(releaseHead).toHaveBeenCalledTimes(1);
    expect(releaseComparison).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalled();
  });

  it("releases an exact-republish candidate while retaining the original source lease", () => {
    const store = createStore();
    const releaseOriginal = vi.fn();
    const releaseCandidate = vi.fn();
    const first = store.publish(registrationWithLease("leased-graph", releaseOriginal));

    const second = store.publish(registrationWithLease("leased-graph", releaseCandidate));

    expect(second).toEqual(first);
    expect(releaseCandidate).toHaveBeenCalledTimes(1);
    expect(releaseOriginal).not.toHaveBeenCalled();

    store.dispose();
    expect(releaseOriginal).toHaveBeenCalledTimes(1);
    expect(releaseCandidate).toHaveBeenCalledTimes(1);
  });

  it("releases source lease candidates when publication or conflict fails", () => {
    const store = createStore();
    const releaseFailed = vi.fn();
    const releaseOriginal = vi.fn();
    const releaseConflict = vi.fn();
    const sourcePath = join(temporaryRoot(), "removed-before-publication.json");
    const bytes = Buffer.from(`${JSON.stringify(ARTIFACT)}\n`, "utf8");
    writeFileSync(sourcePath, bytes);
    const failed = registrationWithLease("failed-graph", releaseFailed);
    failed.material = verifiedArtifactFile(
      sourcePath,
      createHash("sha256").update(bytes).digest("hex"),
      artifactSummary(ARTIFACT),
    );
    unlinkSync(sourcePath);

    expect(() => store.publish(failed)).toThrow();
    expect(releaseFailed).toHaveBeenCalledTimes(1);

    store.publish(registrationWithLease("leased-graph", releaseOriginal));
    expect(() => store.publish(registrationWithLease("leased-graph", releaseConflict, "/workspace/other")))
      .toThrow(/different immutable coordinates/);
    expect(releaseConflict).toHaveBeenCalledTimes(1);
    expect(releaseOriginal).not.toHaveBeenCalled();

    store.dispose();
    expect(releaseOriginal).toHaveBeenCalledTimes(1);
  });

  it("owns exact artifact bytes independently of later source writes or removal", () => {
    const store = createStore();
    const sourceRoot = temporaryRoot();
    const sourcePath = join(sourceRoot, "artifact.json");
    const bytes = Buffer.from(`${JSON.stringify(ARTIFACT)}\n`, "utf8");
    writeFileSync(sourcePath, bytes);
    store.publish(registration("graph-file", {
      material: verifiedArtifactFile(
        sourcePath,
        createHash("sha256").update(bytes).digest("hex"),
        artifactSummary(ARTIFACT),
      ),
    }));

    writeFileSync(sourcePath, "source was replaced after publication\n", "utf8");
    expect(loadRegistration(store, "graph-file")).toEqual(ARTIFACT);
    expect(readFileSync(registrationPath(store, "graph-file")!, "utf8")).toBe(`${JSON.stringify(ARTIFACT)}\n`);

    unlinkSync(sourcePath);
    rmSync(sourceRoot, { recursive: true, force: true });

    expect(loadRegistration(store, "graph-file")).toEqual(ARTIFACT);
    expect(readFileSync(registrationPath(store, "graph-file")!, "utf8")).toBe(`${JSON.stringify(ARTIFACT)}\n`);
  });

  it("publishes a verified-file proof without reading, parsing, validating, or hashing it again", () => {
    const store = createStore();
    const sourcePath = join(temporaryRoot(), "opaque-artifact.json");
    writeFileSync(sourcePath, "not JSON and not the claimed digest", "utf8");
    const claimedDigest = "a".repeat(64);

    const descriptor = store.publish(registration("proof-only", {
      material: verifiedArtifactFile(sourcePath, claimedDigest, artifactSummary(ARTIFACT)),
    }));

    expect(descriptor.byteDigest).toBe(claimedDigest);
    expect(readFileSync(registrationPath(store, "proof-only")!, "utf8")).toBe("not JSON and not the claimed digest");
    expect(() => loadRegistration(store, "proof-only")).toThrow(/digest does not match/);
  });

  it("loads a fresh validated artifact and fails closed on descriptor or artifact corruption", () => {
    const store = createStore();
    store.publish(registration("graph-1"));
    const first = loadRegistration(store, "graph-1")!;
    first.nodes.length = 0;
    expect(loadRegistration(store, "graph-1")?.nodes).toHaveLength(1);

    const artifactPath = registrationPath(store, "graph-1")!;
    const descriptorPath = join(dirname(artifactPath), "descriptor.json");
    const descriptor = JSON.parse(readFileSync(descriptorPath, "utf8")) as Record<string, unknown>;
    const invalidArtifact = Buffer.from(JSON.stringify({ ...ARTIFACT, nodes: [{ ...ARTIFACT.nodes[0], id: "invalid" }] }));
    descriptor.byteDigest = createHash("sha256").update(invalidArtifact).digest("hex");
    writeFileSync(artifactPath, invalidArtifact);
    writeFileSync(descriptorPath, JSON.stringify(descriptor), "utf8");
    expect(() => loadRegistration(store, "graph-1")).toThrow(/not a valid graph artifact/);

    writeFileSync(artifactPath, "{broken", "utf8");
    expect(() => loadRegistration(store, "graph-1")).toThrow(/digest does not match/);

    descriptor.id = "other-id";
    writeFileSync(descriptorPath, JSON.stringify(descriptor), "utf8");
    expect(() => registrationDescriptor(store, "graph-1")).toThrow(/id does not match/);
  });

  it("disposes its private root once and rejects later access", () => {
    const store = createStore();
    const release = vi.fn();
    store.publish(registrationWithLease("graph-1", release));
    const rootPath = store.rootPath;

    store.dispose();
    store.dispose();

    expect(release).toHaveBeenCalledTimes(1);
    expect(existsSync(rootPath)).toBe(false);
    expect(typeof store.rootPath).toBe("string");
    expect(() => hasRegistration(store, "graph-1")).toThrow(/disposed/);
  });

  it("consumes and releases a transferred source lease even after disposal", () => {
    const store = createStore();
    const release = vi.fn();
    store.dispose();

    expect(() => store.publish(registrationWithLease("late-graph", release))).toThrow(/disposed/);
    expect(release).toHaveBeenCalledTimes(1);
  });
});

function createStore(
  options: Partial<GraphRetentionOptions> = {},
  maintenance: WebGraphStoreMaintenance = {},
): WebGraphStore {
  const store = new WebGraphStore(options, maintenance);
  stores.push(store);
  return store;
}

function hasRegistration(store: WebGraphStore, id: string): boolean {
  const registration = store.acquire(id);
  registration?.release();
  return registration !== undefined;
}

function registrationPath(store: WebGraphStore, id: string): string | undefined {
  const registration = store.acquire(id);
  try {
    return registration?.artifactPath;
  } finally {
    registration?.release();
  }
}

function registrationDescriptor(store: WebGraphStore, id: string) {
  const registration = store.acquire(id);
  try {
    return registration?.descriptor;
  } finally {
    registration?.release();
  }
}

function loadRegistration(store: WebGraphStore, id: string): GraphArtifact | undefined {
  const registration = store.acquire(id);
  try {
    return registration?.loadArtifact();
  } finally {
    registration?.release();
  }
}

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "meridian-web-graph-store-test-"));
  temporaryRoots.push(root);
  return root;
}

function registration(
  id: string,
  overrides: Partial<WebGraphRegistration> = {},
): WebGraphRegistration {
  return {
    id,
    material: materializeValidatedArtifact(ARTIFACT),
    metadata: {
      sourceRoot: "/workspace/shop",
      source: { kind: "path" },
      synthetic: { scenarios: [], sourceFingerprint: null, trust: null },
    },
    ...overrides,
  };
}

function registrationWithLease(
  id: string,
  release: () => void,
  sourceRoot = "/workspace/shop",
): WebGraphRegistration {
  return registration(id, {
    metadata: {
      sourceRoot,
      sourceLease: { release },
      source: { kind: "path" },
      synthetic: { scenarios: [], sourceFingerprint: null, trust: null },
    },
  });
}
