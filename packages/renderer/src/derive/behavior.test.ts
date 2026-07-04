/**
 * The behavior payload guard and its file→unit joins. parseBehavior treats the fetched JSON as
 * untrusted: anything off-contract parses to null (degrade, never crash). The joins are pinned on
 * path normalization — artifact module files and git-derived paths must meet on the same bare
 * repo-relative POSIX form whatever prefix or separator either side carried.
 */

import { describe, expect, it } from "vitest";
import {
  churnByUnit,
  coChangeUnitPairs,
  normalizeRepoPath,
  parseBehavior,
  type BehaviorData,
} from "./behavior";

function contractPayload(): Record<string, unknown> {
  return {
    behaviorVersion: "1",
    generatedAt: "2026-07-04T00:00:00.000Z",
    commitsAnalyzed: 120,
    churnByFile: { "src/a.ts": 7, "src/b.ts": 12 },
    coChange: [{ a: "src/a.ts", b: "src/b.ts", count: 5, ratio: 0.62 }],
  };
}

describe("parseBehavior", () => {
  it("parses a contract-shaped payload into Maps and pairs", () => {
    const parsed = parseBehavior(contractPayload());
    expect(parsed).not.toBeNull();
    expect(parsed?.commitsAnalyzed).toBe(120);
    expect(parsed?.churnByFile.get("src/a.ts")).toBe(7);
    expect(parsed?.coChange).toEqual([{ a: "src/a.ts", b: "src/b.ts", count: 5, ratio: 0.62 }]);
  });

  it.each([
    ["not an object", "nope"],
    ["null", null],
    ["wrong behaviorVersion", { ...contractPayload(), behaviorVersion: "2" }],
    ["missing commitsAnalyzed", { ...contractPayload(), commitsAnalyzed: undefined }],
    ["non-numeric churn value", { ...contractPayload(), churnByFile: { "src/a.ts": "7" } }],
    ["churnByFile not a record", { ...contractPayload(), churnByFile: ["src/a.ts"] }],
    ["coChange not an array", { ...contractPayload(), coChange: {} }],
    ["coChange entry missing a file", { ...contractPayload(), coChange: [{ a: "src/a.ts", count: 5, ratio: 0.6 }] }],
    ["coChange count not a number", { ...contractPayload(), coChange: [{ a: "x", b: "y", count: "5", ratio: 0.6 }] }],
    ["negative count", { ...contractPayload(), coChange: [{ a: "x", b: "y", count: -1, ratio: 0.6 }] }],
  ])("returns null for a malformed payload (%s)", (_label, payload) => {
    expect(parseBehavior(payload)).toBeNull();
  });

  it("normalizes churn keys and co-change paths at parse time", () => {
    const parsed = parseBehavior({
      ...contractPayload(),
      churnByFile: { "./src/a.ts": 3, "src\\win\\b.ts": 4 },
      coChange: [{ a: "./src/a.ts", b: "src\\win\\b.ts", count: 3, ratio: 0.5 }],
    });
    expect([...(parsed?.churnByFile.keys() ?? [])]).toEqual(["src/a.ts", "src/win/b.ts"]);
    expect(parsed?.coChange[0]).toMatchObject({ a: "src/a.ts", b: "src/win/b.ts" });
  });

  it("keeps a file named __proto__ as inert Map data", () => {
    // Built via JSON.parse (like a real fetched payload): "__proto__" lands as an OWN property.
    const parsed = parseBehavior({ ...contractPayload(), churnByFile: JSON.parse('{"__proto__": 9}') });
    expect(parsed?.churnByFile.get("__proto__")).toBe(9);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("normalizeRepoPath", () => {
  it("strips leading ./ segments and converts backslashes to POSIX", () => {
    expect(normalizeRepoPath("./src/a.ts")).toBe("src/a.ts");
    expect(normalizeRepoPath("././src/a.ts")).toBe("src/a.ts");
    expect(normalizeRepoPath("src\\sub\\a.ts")).toBe("src/sub/a.ts");
    expect(normalizeRepoPath("src/a.ts")).toBe("src/a.ts");
  });
});

function behaviorWith(overrides: Partial<BehaviorData>): BehaviorData {
  return { commitsAnalyzed: 50, churnByFile: new Map(), coChange: [], ...overrides };
}

describe("churnByUnit", () => {
  it("joins churn onto units by normalized module file and omits unchurned units", () => {
    const behavior = behaviorWith({ churnByFile: new Map([["src/a.ts", 7]]) });
    const units = [
      { id: "ts:src/a", moduleFile: "./src/a.ts" }, // artifact-side "./" prefix still joins.
      { id: "ts:src/b", moduleFile: "src/b.ts" },
    ];
    const churn = churnByUnit(units, behavior);
    expect(churn.get("ts:src/a")).toBe(7);
    expect(churn.has("ts:src/b")).toBe(false);
  });

  it("gives every unit declared in the same file that file's churn", () => {
    const behavior = behaviorWith({ churnByFile: new Map([["src/a.ts", 4]]) });
    const units = [
      { id: "ts:src/a", moduleFile: "src/a.ts" },
      { id: "ts:src/a#K", moduleFile: "src/a.ts" },
    ];
    expect([...churnByUnit(units, behavior).values()]).toEqual([4, 4]);
  });
});

describe("coChangeUnitPairs", () => {
  const units = [
    { id: "ts:src/a", moduleFile: "src/a.ts" },
    { id: "ts:src/a#K", moduleFile: "src/a.ts" }, // second unit hosted by the same file.
    { id: "ts:src/b", moduleFile: "./src/b.ts" },
  ];

  it("fans a file pair out to every distinct unit pair, ordered [min, max]", () => {
    const behavior = behaviorWith({ coChange: [{ a: "src/a.ts", b: "src/b.ts", count: 5, ratio: 0.7 }] });
    expect(coChangeUnitPairs(units, behavior)).toEqual([
      ["ts:src/a", "ts:src/b"],
      ["ts:src/a#K", "ts:src/b"],
    ]);
  });

  it("deduplicates repeated pairs and drops files hosting no unit", () => {
    const behavior = behaviorWith({
      coChange: [
        { a: "src/a.ts", b: "src/b.ts", count: 5, ratio: 0.7 },
        { a: "src/a.ts", b: "src/b.ts", count: 5, ratio: 0.7 },
        { a: "src/b.ts", b: "src/unknown.ts", count: 3, ratio: 0.5 },
      ],
    });
    expect(coChangeUnitPairs(units, behavior)).toEqual([
      ["ts:src/a", "ts:src/b"],
      ["ts:src/a#K", "ts:src/b"],
    ]);
  });
});
