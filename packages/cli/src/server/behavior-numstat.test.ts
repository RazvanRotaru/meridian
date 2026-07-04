/**
 * The pure numstat aggregation: fixture log text in, churn + co-change out. Covers the
 * contract gates (count >= 3, ratio >= 0.5, a < b, top-200 cap), path re-rooting with
 * outside-root rejection, binary-file touches, and the huge-commit pair skip.
 */

import { describe, expect, it } from "vitest";
import { aggregateNumstatLog } from "./behavior-numstat";

const ROOT = "/repo";

describe("aggregateNumstatLog churn", () => {
  it("counts commits touching each file, including binary numstat entries", () => {
    const log = logOf([["src/a.ts", "logo.png"], ["src/a.ts"]], { binary: ["logo.png"] });
    const stats = aggregateNumstatLog(log, ROOT, ROOT);
    expect(stats.commitsAnalyzed).toBe(2);
    expect(stats.churnByFile).toEqual({ "src/a.ts": 2, "logo.png": 1 });
  });

  it("counts a file once per commit even if numstat repeats it", () => {
    const log = `${hash(0)}\n\n1\t1\tsrc/a.ts\n2\t2\tsrc/a.ts\n`;
    expect(aggregateNumstatLog(log, ROOT, ROOT).churnByFile).toEqual({ "src/a.ts": 1 });
  });

  it("ignores malformed lines and returns zeros for an empty log", () => {
    expect(aggregateNumstatLog("", ROOT, ROOT)).toEqual({ commitsAnalyzed: 0, churnByFile: {}, coChange: [] });
    expect(aggregateNumstatLog("not-a-hash\ngarbage line\n", ROOT, ROOT).commitsAnalyzed).toBe(0);
  });

  it("keeps a file named __proto__ as plain data instead of polluting the map", () => {
    const stats = aggregateNumstatLog(logOf([["__proto__"]]), ROOT, ROOT);
    expect(Object.keys(stats.churnByFile)).toEqual(["__proto__"]);
    expect(stats.churnByFile["__proto__"]).toBe(1);
  });
});

describe("aggregateNumstatLog path re-rooting", () => {
  it("re-roots repo-top paths onto the source root and drops files outside its subtree", () => {
    const log = logOf([["pkg/web/src/a.ts", "pkg/api/main.ts", "README.md"]]);
    const stats = aggregateNumstatLog(log, ROOT, `${ROOT}/pkg/web`);
    expect(stats.churnByFile).toEqual({ "src/a.ts": 1 });
    expect(stats.commitsAnalyzed).toBe(1);
  });

  it("emits POSIX separators for nested paths", () => {
    const stats = aggregateNumstatLog(logOf([["a/b/c.ts"]]), ROOT, ROOT);
    expect(Object.keys(stats.churnByFile)).toEqual(["a/b/c.ts"]);
  });

  it("rejects traversal that escapes the source root", () => {
    const stats = aggregateNumstatLog(logOf([["../outside.ts", "inside.ts"]]), `${ROOT}/sub`, `${ROOT}/sub`);
    expect(stats.churnByFile).toEqual({ "inside.ts": 1 });
  });
});

describe("aggregateNumstatLog co-change", () => {
  it("emits a pair only at 3+ co-commits and ratio >= 0.5, ordered a < b", () => {
    const commits = [
      ["b.ts", "a.ts"],
      ["a.ts", "b.ts"],
      ["a.ts", "b.ts"],
      ["a.ts", "c.ts"],
      ["a.ts", "c.ts"],
    ];
    const { coChange } = aggregateNumstatLog(logOf(commits), ROOT, ROOT);
    expect(coChange).toEqual([{ a: "a.ts", b: "b.ts", count: 3, ratio: 1 }]);
  });

  it("computes ratio as coCount / min(churn(a), churn(b))", () => {
    const commits = [...Array.from({ length: 3 }, () => ["a.ts", "b.ts"]), ["a.ts"], ["a.ts"], ["b.ts"]];
    const { coChange } = aggregateNumstatLog(logOf(commits), ROOT, ROOT);
    expect(coChange).toEqual([{ a: "a.ts", b: "b.ts", count: 3, ratio: 0.75 }]);
  });

  it("filters a pair whose ratio falls below 0.5", () => {
    // 3 co-commits but both files churn 7 → ratio 3/min(7,7) ≈ 0.43 < 0.5.
    const commits = [
      ...Array.from({ length: 3 }, () => ["a.ts", "b.ts"]),
      ...Array.from({ length: 4 }, () => ["a.ts"]),
      ...Array.from({ length: 4 }, () => ["b.ts"]),
    ];
    expect(aggregateNumstatLog(logOf(commits), ROOT, ROOT).coChange).toEqual([]);
  });

  it("caps the list at the top 200 pairs by count", () => {
    const commits = pairFixture(210);
    const { coChange } = aggregateNumstatLog(logOf(commits), ROOT, ROOT);
    expect(coChange).toHaveLength(200);
    expect(coChange[0]?.count).toBeGreaterThanOrEqual(coChange[199]?.count ?? 0);
  });

  it("skips pair counting (but not churn) for a commit touching more than 50 files", () => {
    const hugeCommit = Array.from({ length: 60 }, (_, index) => `f${index}.ts`);
    const commits = [hugeCommit, hugeCommit, hugeCommit];
    const stats = aggregateNumstatLog(logOf(commits), ROOT, ROOT);
    expect(stats.coChange).toEqual([]);
    expect(stats.churnByFile["f0.ts"]).toBe(3);
  });
});

/** 3 + (i % 3) co-commits for pair i, so counts vary and the cap has an order to respect. */
function pairFixture(pairCount: number): string[][] {
  return Array.from({ length: pairCount }, (_, index) => index).flatMap((index) =>
    Array.from({ length: 3 + (index % 3) }, () => [`p${index}-a.ts`, `p${index}-b.ts`]),
  );
}

function logOf(commits: string[][], options: { binary?: string[] } = {}): string {
  const binary = new Set(options.binary ?? []);
  return commits
    .map((files, index) => {
      const lines = files.map((file) => (binary.has(file) ? `-\t-\t${file}` : `3\t1\t${file}`));
      return `${hash(index)}\n\n${lines.join("\n")}\n`;
    })
    .join("\n");
}

function hash(index: number): string {
  return index.toString(16).padStart(40, "0");
}
