import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  effectiveReviewProjectionContentId,
  readReviewComparisonContext,
  REVIEW_PROJECTION_CONTENT_VERSION,
  resolveReviewContextCursor,
  reviewFileCursor,
  reviewPageCursor,
  writeReviewComparisonContext,
} from "./review-comparison-context";

const temporary: string[] = [];
const HEAD = "1".repeat(40);
const BASE = "2".repeat(40);
const GRAPH_IDENTITY = {
  headContentId: "a".repeat(64),
  mergeBaseContentId: "b".repeat(64),
  testClassifications: [],
} as const;

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("review comparison context", () => {
  it("publishes a deterministic >48 KiB status index with bounded stable continuation", () => {
    const root = tempRoot();
    const files = Array.from({ length: 513 }, (_, index) => index === 512
      ? { path: "src/z-new.ts", previousPath: "src/z-old.ts", status: "renamed" as const }
      : {
          path: `src/${index.toString().padStart(4, "0")}-${"segment".repeat(14)}.ts`,
          status: index % 3 === 0 ? "deleted" as const : "modified" as const,
        });
    const first = writeReviewComparisonContext(join(root, "first.json"), {
      ...GRAPH_IDENTITY,
      headSha: HEAD,
      mergeBaseSha: BASE,
      analysisKey: "analysis-v1",
      changedFiles: [...files].reverse(),
    });
    const second = writeReviewComparisonContext(join(root, "second.json"), {
      ...GRAPH_IDENTITY,
      headSha: HEAD,
      mergeBaseSha: BASE,
      analysisKey: "analysis-v1",
      changedFiles: files,
    });

    expect(first.sha256).toBe(second.sha256);
    const context = readReviewComparisonContext(first)!;
    expect(context.changedFiles).toHaveLength(513);
    expect(context.changedFiles.reduce((bytes, file) => bytes + Buffer.byteLength(file.path), 0))
      .toBeGreaterThan(48 * 1024);
    expect(context.pages.every((page) => page.end - page.start <= 64 && page.pathBytes <= 24 * 1024)).toBe(true);

    const overview = resolveReviewContextCursor(context, first.sha256, "head", null);
    expect(overview.facts.page).toMatchObject({ index: 0, previousCursor: null, nextCursor: "page:1" });
    expect(overview.facts.page?.entries).toHaveLength(64);
    expect(overview.changedPaths).toEqual([]);
    expect(overview.graphPaths).toEqual(overview.facts.page?.entries
      .filter((entry) => entry.status !== "deleted")
      .map((entry) => entry.path));
    expect(overview.facts.overview?.entries).toEqual(overview.facts.page?.entries.map((entry) => ({
      index: entry.index,
      state: entry.status === "deleted" ? "absent" : "deferred",
      isTest: null,
    })));
    const lastPage = resolveReviewContextCursor(
      context,
      first.sha256,
      "mergeBase",
      reviewPageCursor(context.pages.length - 1),
    );
    expect(lastPage.facts.page?.nextCursor).toBeNull();

    const renamedIndex = context.changedFiles.findIndex((entry) => entry.status === "renamed");
    const head = resolveReviewContextCursor(context, first.sha256, "head", reviewFileCursor(renamedIndex));
    const base = resolveReviewContextCursor(context, first.sha256, "mergeBase", reviewFileCursor(renamedIndex));
    expect(head.graphPath).toBe("src/z-new.ts");
    expect(base.graphPath).toBe("src/z-old.ts");
    expect(head.changedPath).toBe("src/z-new.ts");
    expect(base.changedPath).toBe("src/z-new.ts");
    expect(head.graphPaths).toEqual(["src/z-new.ts"]);
    expect(base.graphPaths).toEqual(["src/z-old.ts"]);
    expect(head.changedPaths).toEqual(["src/z-new.ts"]);
    expect(base.changedPaths).toEqual(["src/z-new.ts"]);
  });

  it("resolves bounded overview paths independently for both comparison sides", () => {
    const root = tempRoot();
    const reference = writeReviewComparisonContext(join(root, "status-rich.json"), {
      ...GRAPH_IDENTITY,
      headSha: HEAD,
      mergeBaseSha: BASE,
      analysisKey: "status-rich",
      changedFiles: [
        { path: "src/new-name.ts", previousPath: "src/old-name.ts", status: "renamed" },
        { path: "src/modified.ts", status: "modified" },
        { path: "src/deleted.ts", status: "deleted" },
        { path: "src/added.ts", status: "added" },
      ],
    });
    const context = readReviewComparisonContext(reference)!;

    const head = resolveReviewContextCursor(context, reference.sha256, "head", null);
    const mergeBase = resolveReviewContextCursor(context, reference.sha256, "mergeBase", null);

    expect(head.graphPath).toBeNull();
    expect(mergeBase.graphPath).toBeNull();
    expect(head.facts.selection).toBeNull();
    expect(mergeBase.facts.selection).toBeNull();
    expect(head.changedPaths).toEqual([]);
    expect(mergeBase.changedPaths).toEqual(head.changedPaths);
    expect(head.graphPaths).toEqual([
      "src/added.ts",
      "src/modified.ts",
      "src/new-name.ts",
    ]);
    expect(mergeBase.graphPaths).toEqual([
      "src/deleted.ts",
      "src/modified.ts",
      "src/old-name.ts",
    ]);
    expect(head.facts.overview?.entries).toEqual([
      { index: 0, state: "deferred", isTest: null },
      { index: 1, state: "absent", isTest: null },
      { index: 2, state: "deferred", isTest: null },
      { index: 3, state: "deferred", isTest: null },
    ]);
    expect(mergeBase.facts.overview?.entries).toEqual([
      { index: 0, state: "absent", isTest: null },
      { index: 1, state: "deferred", isTest: null },
      { index: 2, state: "deferred", isTest: null },
      { index: 3, state: "deferred", isTest: null },
    ]);
  });

  it("retains a valid 4096-byte path as metadata without putting it in a transport cursor", () => {
    const root = tempRoot();
    const longPath = `src/${"a".repeat(4_089)}.ts`;
    expect(Buffer.byteLength(longPath)).toBe(4_096);
    const reference = writeReviewComparisonContext(join(root, "context.json"), {
      ...GRAPH_IDENTITY,
      headSha: HEAD,
      mergeBaseSha: BASE,
      analysisKey: "long-path",
      changedFiles: [{ path: longPath, status: "modified" }],
    });
    const context = readReviewComparisonContext(reference)!;

    expect(context.changedFiles[0]?.path).toBe(longPath);
    expect(reviewFileCursor(0)).toBe("file:0");
    expect(resolveReviewContextCursor(context, reference.sha256, "head", "file:0").graphPath).toBe(longPath);
  });

  it("uses one locale-independent non-ASCII order for digest and file coordinates", () => {
    const root = tempRoot();
    const paths = ["src/😀.ts", "src/é.ts", "src/z.ts", "src/中.ts", "src/ä.ts"];
    const first = writeReviewComparisonContext(join(root, "non-ascii-a.json"), {
      ...GRAPH_IDENTITY,
      headSha: HEAD,
      mergeBaseSha: BASE,
      analysisKey: "non-ascii",
      changedFiles: paths.map((path) => ({ path, status: "modified" as const })),
    });
    const second = writeReviewComparisonContext(join(root, "non-ascii-b.json"), {
      ...GRAPH_IDENTITY,
      headSha: HEAD,
      mergeBaseSha: BASE,
      analysisKey: "non-ascii",
      changedFiles: [...paths].reverse().map((path) => ({ path, status: "modified" as const })),
    });
    const context = readReviewComparisonContext(first)!;

    expect(first.sha256).toBe(second.sha256);
    expect(context.changedFiles.map((entry) => entry.path)).toEqual([
      "src/z.ts", "src/ä.ts", "src/é.ts", "src/中.ts", "src/😀.ts",
    ]);
    const selectedIndex = context.changedFiles.findIndex((entry) => entry.path === "src/中.ts");
    expect(resolveReviewContextCursor(
      context,
      first.sha256,
      "head",
      reviewFileCursor(selectedIndex),
    ).facts.selection?.entry.path).toBe("src/中.ts");
  });

  it("keeps classification truth attached to paths while canonicalizing manifest order", () => {
    const root = tempRoot();
    const first = writeReviewComparisonContext(join(root, "classified-a.json"), {
      ...GRAPH_IDENTITY,
      headSha: HEAD,
      mergeBaseSha: BASE,
      analysisKey: "classified",
      changedFiles: [
        { path: "src/z.ts", status: "modified" },
        { path: "src/a.ts", status: "modified" },
      ],
      testClassifications: [{ index: 0, isTest: true }, { index: 1, isTest: false }],
    });
    const second = writeReviewComparisonContext(join(root, "classified-b.json"), {
      ...GRAPH_IDENTITY,
      headSha: HEAD,
      mergeBaseSha: BASE,
      analysisKey: "classified",
      changedFiles: [
        { path: "src/a.ts", status: "modified" },
        { path: "src/z.ts", status: "modified" },
      ],
      testClassifications: [{ index: 0, isTest: false }, { index: 1, isTest: true }],
    });

    expect(first.sha256).toBe(second.sha256);
    expect(readReviewComparisonContext(first)).toMatchObject({
      changedFiles: [{ path: "src/a.ts" }, { path: "src/z.ts" }],
      testClassifications: [{ index: 0, isTest: false }, { index: 1, isTest: true }],
    });
  });

  it("fails closed on digest/content mutation and binds effective identities to context and side", () => {
    const root = tempRoot();
    const path = join(root, "context.json");
    const reference = writeReviewComparisonContext(path, {
      ...GRAPH_IDENTITY,
      headSha: HEAD,
      mergeBaseSha: BASE,
      analysisKey: "analysis-v1",
      changedFiles: [{ path: "src/a.ts", status: "modified" }],
    });
    const graph = "a".repeat(64);

    expect(effectiveReviewProjectionContentId(graph, reference.sha256, "head"))
      .not.toBe(effectiveReviewProjectionContentId(graph, reference.sha256, "mergeBase"));
    expect(effectiveReviewProjectionContentId(graph, reference.sha256, "head")).toBe(createHash("sha256")
      .update(`review-projection-v${REVIEW_PROJECTION_CONTENT_VERSION}\0${graph}\0${reference.sha256}\0head`)
      .digest("hex"));
    chmodSync(path, 0o600);
    const serialized = readFileSync(path, "utf8");
    writeFileSync(path, serialized.replace("src/a.ts", "src/b.ts"));
    expect(readReviewComparisonContext(reference)).toBeNull();
  });

  it("rejects non-canonical serialization even when its descriptor digest is otherwise valid", () => {
    const root = tempRoot();
    const canonicalPath = join(root, "canonical.json");
    const canonical = writeReviewComparisonContext(canonicalPath, {
      ...GRAPH_IDENTITY,
      headSha: HEAD,
      mergeBaseSha: BASE,
      analysisKey: "canonical",
      changedFiles: [{ path: "src/a.ts", status: "modified" }],
    });
    const nonCanonicalPath = join(root, "non-canonical.json");
    const nonCanonical = readFileSync(canonicalPath, "utf8").trimEnd();
    writeFileSync(nonCanonicalPath, nonCanonical);
    expect(readReviewComparisonContext({
      path: nonCanonicalPath,
      bytes: Buffer.byteLength(nonCanonical),
      sha256: createHash("sha256").update(nonCanonical).digest("hex"),
    })).toBeNull();
    expect(readReviewComparisonContext(canonical)).not.toBeNull();
  });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "meridian-review-context-"));
  temporary.push(root);
  return root;
}
