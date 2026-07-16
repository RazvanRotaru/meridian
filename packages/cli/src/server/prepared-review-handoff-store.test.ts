import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MAX_PREPARED_REVIEW_HANDOFF_BYTES,
  PreparedReviewHandoffStore,
  type PreparedReviewHandoffInput,
} from "./prepared-review-handoff-store";

const HEAD_SHA = "1".repeat(40);
const BASE_SHA = "a".repeat(40);
const MERGE_BASE_SHA = "c".repeat(40);

let cacheRoot: string;

beforeEach(() => {
  cacheRoot = mkdtempSync(join(tmpdir(), "meridian-prepared-review-store-"));
});

afterEach(() => {
  rmSync(cacheRoot, { recursive: true, force: true });
});

describe("PreparedReviewHandoffStore", () => {
  it("publishes canonical status-rich metadata and resolves it after restart", () => {
    const first = new PreparedReviewHandoffStore({ cacheRoot });
    const candidate = first.prepare(input());
    const reference = first.publish(candidate);

    expect(reference).toEqual({
      id: expect.stringMatching(/^prh-v1-[0-9a-f]{64}$/),
      url: `/api/pr/prepared?id=${candidate.id}`,
      viewUrl: `/view?id=pr-head-test&view=modules&prn=41&rev=1&prepared=${candidate.id}`,
    });
    expect(lstatSync(resolvedFile(candidate.id)).isFile()).toBe(true);
    expect(lstatSync(resolvedFile(candidate.id)).isSymbolicLink()).toBe(false);

    const restarted = new PreparedReviewHandoffStore({ cacheRoot });
    const resolved = restarted.resolve(candidate.id);
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
  });

  it("content-addresses provenance and diagnostics without changing comparison descriptors", () => {
    const store = new PreparedReviewHandoffStore({ cacheRoot });
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
    expect(store.publish(first)).not.toEqual(store.publish(second));
    // Each URL remains bound to its exact canonical bytes before and after independent publication.
    expect(store.resolve(first.id)?.document).toEqual(first.document);
    expect(store.resolve(second.id)?.document).toEqual(second.document);
  });

  it("rejects credentials, malformed manifests, and oversized documents", () => {
    const store = new PreparedReviewHandoffStore({ cacheRoot });
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

    const small = new PreparedReviewHandoffStore({ cacheRoot, maxDocumentBytes: 512 });
    expect(() => small.prepare({ ...input(), warnings: ["x".repeat(512)] })).toThrow(/handoff limit/);
    expect(() => new PreparedReviewHandoffStore({
      cacheRoot,
      maxDocumentBytes: MAX_PREPARED_REVIEW_HANDOFF_BYTES + 1,
    })).toThrow(/2 MiB/);
  });

  it("fails closed for traversal ids, digest mismatches, malformed JSON, and symlinked files", () => {
    const store = new PreparedReviewHandoffStore({ cacheRoot });
    const first = store.prepare(input());
    store.publish(first);
    const validated = store.resolve(first.id)!;
    expect(store.resolve("../../outside")).toBeNull();
    expect(store.resolve(`prh-v1-${"z".repeat(64)}`)).toBeNull();

    writeFileSync(resolvedFile(first.id), `${JSON.stringify({ ...first.document, warnings: ["changed"] })}\n`);
    expect(validated.bytes.toString("utf8")).toBe(first.serialized);
    expect(store.resolve(first.id)).toBeNull();

    const second = store.prepare({ ...input(), request: { ...input().request, prNumber: 42 } });
    store.publish(second);
    writeFileSync(resolvedFile(second.id), "{not json\n");
    expect(store.resolve(second.id)).toBeNull();

    const third = store.prepare({ ...input(), request: { ...input().request, prNumber: 43 } });
    store.publish(third);
    const outside = join(cacheRoot, "outside.json");
    writeFileSync(outside, third.serialized);
    rmSync(resolvedFile(third.id));
    symlinkSync(outside, resolvedFile(third.id));
    expect(store.resolve(third.id)).toBeNull();
  });

  it("rejects a symlinked handoff cache root", () => {
    const outside = mkdtempSync(join(tmpdir(), "meridian-prepared-review-outside-"));
    try {
      symlinkSync(outside, join(cacheRoot, "prepared-review-handoffs"), "dir");
      expect(() => new PreparedReviewHandoffStore({ cacheRoot })).toThrow(/unsafe directory/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("bounds entries with deterministic least-recently-used eviction", () => {
    let now = Date.now();
    const store = new PreparedReviewHandoffStore({
      cacheRoot,
      maxDocumentBytes: 4 * 1024,
      maxEntries: 2,
      maxCacheBytes: 64 * 1024,
      maxAgeMs: 60_000,
      now: () => now,
    });
    const first = store.prepare({ ...input(), request: { ...input().request, prNumber: 41 } });
    store.publish(first);
    now += 100;
    const second = store.prepare({ ...input(), request: { ...input().request, prNumber: 42 } });
    store.publish(second);
    now += 100;
    expect(store.resolve(first.id)).not.toBeNull(); // renew first for back-navigation
    now += 100;
    const third = store.prepare({ ...input(), request: { ...input().request, prNumber: 43 } });
    store.publish(third);

    expect(store.resolve(second.id)).toBeNull();
    expect(store.resolve(first.id)).not.toBeNull();
    expect(store.resolve(third.id)).not.toBeNull();
    expect(store.scavenge()).toMatchObject({ entries: 2 });
  });

  it("bounds total bytes and scavenges expired entries on restart", () => {
    let now = Date.now();
    const limits = {
      maxDocumentBytes: 4 * 1024,
      maxEntries: 10,
      maxCacheBytes: 4 * 1024 + 65,
      maxAgeMs: 1_000,
      now: () => now,
    };
    const store = new PreparedReviewHandoffStore({ cacheRoot, ...limits });
    for (let prNumber = 50; prNumber < 53; prNumber += 1) {
      const candidate = store.prepare({
        ...input(),
        request: { ...input().request, prNumber },
        warnings: ["w".repeat(512)],
      });
      store.publish(candidate);
      now += 100;
    }
    const bounded = store.scavenge();
    expect(bounded.bytes).toBeLessThanOrEqual(limits.maxCacheBytes);
    expect(bounded.entries).toBeLessThan(3);

    now += limits.maxAgeMs + 1;
    const restarted = new PreparedReviewHandoffStore({ cacheRoot, ...limits });
    expect(restarted.scavenge()).toMatchObject({ entries: 0, bytes: 0 });
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
  const digest = id.slice("prh-v1-".length);
  const path = join(cacheRoot, "prepared-review-handoffs", "v1", digest.slice(0, 2), id, "handoff.json");
  mkdirSync(dirname(path), { recursive: true });
  return path;
}
