import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  effectiveReviewProjectionContentId,
  readReviewComparisonContext,
  resolveReviewContextCursor,
  reviewFileCursor,
  reviewPageCursor,
  writeReviewComparisonContext,
} from "./review-comparison-context";

const temporary: string[] = [];
const HEAD = "1".repeat(40);
const BASE = "2".repeat(40);

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
      headSha: HEAD,
      mergeBaseSha: BASE,
      analysisKey: "analysis-v1",
      changedFiles: [...files].reverse(),
    });
    const second = writeReviewComparisonContext(join(root, "second.json"), {
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
  });

  it("retains a valid 4096-byte path as metadata without putting it in a transport cursor", () => {
    const root = tempRoot();
    const longPath = `src/${"a".repeat(4_089)}.ts`;
    expect(Buffer.byteLength(longPath)).toBe(4_096);
    const reference = writeReviewComparisonContext(join(root, "context.json"), {
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
      headSha: HEAD,
      mergeBaseSha: BASE,
      analysisKey: "non-ascii",
      changedFiles: paths.map((path) => ({ path, status: "modified" as const })),
    });
    const second = writeReviewComparisonContext(join(root, "non-ascii-b.json"), {
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

  it("fails closed on digest/content mutation and binds effective identities to context and side", () => {
    const root = tempRoot();
    const path = join(root, "context.json");
    const reference = writeReviewComparisonContext(path, {
      headSha: HEAD,
      mergeBaseSha: BASE,
      analysisKey: "analysis-v1",
      changedFiles: [{ path: "src/a.ts", status: "modified" }],
    });
    const graph = "a".repeat(64);

    expect(effectiveReviewProjectionContentId(graph, reference.sha256, "head"))
      .not.toBe(effectiveReviewProjectionContentId(graph, reference.sha256, "mergeBase"));
    chmodSync(path, 0o600);
    const serialized = readFileSync(path, "utf8");
    writeFileSync(path, serialized.replace("src/a.ts", "src/b.ts"));
    expect(readReviewComparisonContext(reference)).toBeNull();
  });

  it("rejects non-canonical serialization even when its descriptor digest is otherwise valid", () => {
    const root = tempRoot();
    const canonicalPath = join(root, "canonical.json");
    const canonical = writeReviewComparisonContext(canonicalPath, {
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
