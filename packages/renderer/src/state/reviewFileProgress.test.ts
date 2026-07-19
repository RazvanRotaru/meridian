import { describe, expect, it } from "vitest";
import type { ReviewFileRow } from "../derive/reviewFiles";
import {
  applyReviewFilesToggle,
  applyReviewFileToggle,
  countViewedReviewFiles,
  reconcileReviewProgress,
  reviewFileProgressState,
  reviewFilesProgressState,
} from "./reviewFileProgress";

const FILE_A = "src/a.ts";
const FILE_B = "src/b.ts";

function row(
  path: string,
  units: readonly { nodeId: string; fingerprint: string; isTest?: boolean }[],
): ReviewFileRow {
  return {
    path,
    status: "modified",
    moduleId: `ts:${path}`,
    isTest: false,
    units: units.map((unit, index) => ({
      ...unit,
      displayName: unit.nodeId,
      kind: "function",
      startLine: index + 1,
      endLine: index + 1,
      depth: 0,
      isTest: unit.isTest ?? false,
    })),
    blastRadius: 0,
    deletedImpact: null,
  };
}

const CHANGED = [
  { path: FILE_A, status: "modified" as const, hunks: [{ start: 1, end: 4 }] },
  { path: FILE_B, status: "modified" as const, hunks: [{ start: 8, end: 9 }] },
];

describe("review file progress catalog", () => {
  it("keeps overview metadata non-authoritative and promotes a file tick when exact units hydrate", () => {
    const overview = reconcileReviewProgress({
      previous: null,
      reviewKey: "review",
      revisionKey: "head-1",
      changedFiles: CHANGED,
      // An overview representative must never become the file's complete unit inventory.
      authoritativeFiles: [],
      includeTests: false,
      unitTicks: {},
      fileTicks: {},
    });
    const aOverview = overview.catalog.byPath.get(FILE_A)!;
    expect(aOverview.tickedUnitIds).toEqual([]);
    expect(aOverview).not.toHaveProperty("units");

    const marked = applyReviewFileToggle(overview.catalog, aOverview, {}, {}, "marked", false);
    expect(reviewFileProgressState(
      marked.catalog.byPath.get(FILE_A)!,
      marked.unitTicks,
      marked.fileTicks,
      false,
    )).toBe("done");

    const exact = reconcileReviewProgress({
      previous: marked.catalog,
      reviewKey: "review",
      revisionKey: "head-1",
      changedFiles: CHANGED,
      authoritativeFiles: [row(FILE_A, [
        { nodeId: "ts:src/a.ts#one", fingerprint: "1:1|1-4" },
        { nodeId: "ts:src/a.ts#two", fingerprint: "3:4|1-4" },
      ])],
      includeTests: false,
      unitTicks: marked.unitTicks,
      fileTicks: marked.fileTicks,
    });

    expect(exact.ticksChanged).toBe(true);
    expect(exact.fileTicks[FILE_A]).toBeUndefined();
    expect(Object.keys(exact.unitTicks)).toEqual(["ts:src/a.ts#one", "ts:src/a.ts#two"]);
    expect(exact.catalog.byPath.get(FILE_A)?.tickedUnitIds).toEqual([
      "ts:src/a.ts#one",
      "ts:src/a.ts#two",
    ]);
    expect(exact.catalog.byPath.get(FILE_A)).not.toHaveProperty("units");
    expect(reviewFileProgressState(exact.catalog.byPath.get(FILE_A)!, exact.unitTicks, exact.fileTicks, false)).toBe("done");
    expect(countViewedReviewFiles(exact.catalog, exact.unitTicks, exact.fileTicks, false)).toBe(1);
  });

  it("retains only compact user progress when an exact inventory leaves the active coordinate", () => {
    const exact = reconcileReviewProgress({
      previous: null,
      reviewKey: "review",
      revisionKey: "head-1",
      changedFiles: CHANGED,
      authoritativeFiles: [row(FILE_A, [{ nodeId: "unit-a", fingerprint: "a" }])],
      includeTests: false,
      unitTicks: { "unit-a": { at: "t", fingerprint: "a" } },
      fileTicks: {},
    });
    const overview = reconcileReviewProgress({
      previous: exact.catalog,
      reviewKey: "review",
      revisionKey: "head-1",
      changedFiles: CHANGED,
      authoritativeFiles: [],
      includeTests: false,
      unitTicks: exact.unitTicks,
      fileTicks: exact.fileTicks,
    });

    expect(overview.catalog.order).toEqual([FILE_A, FILE_B]);
    expect(overview.catalog.byPath.get(FILE_A)).toEqual(expect.objectContaining({
      state: "done",
      tickedUnitIds: ["unit-a"],
    }));
    expect(JSON.stringify([...overview.catalog.byPath.values()])).not.toContain('"fingerprint":"a"');
    expect(countViewedReviewFiles(overview.catalog, overview.unitTicks, overview.fileTicks, false)).toBe(1);
  });

  it("does not retain untouched ids from either an exact unitless or populated file", () => {
    const progress = reconcileReviewProgress({
      previous: null,
      reviewKey: "review",
      revisionKey: "head-1",
      changedFiles: CHANGED,
      authoritativeFiles: [
        row(FILE_A, [{ nodeId: "untouched", fingerprint: "graph-fingerprint" }]),
        row(FILE_B, []),
      ],
      includeTests: false,
      unitTicks: {},
      fileTicks: {},
    });

    expect(progress.catalog.byPath.get(FILE_A)?.tickedUnitIds).toEqual([]);
    expect(progress.catalog.byPath.get(FILE_B)?.tickedUnitIds).toEqual([]);
    expect(JSON.stringify([...progress.catalog.byPath.values()])).not.toContain("untouched");
    expect(JSON.stringify([...progress.catalog.byPath.values()])).not.toContain("graph-fingerprint");
  });

  it("cascades exact file toggles across units and refreshes partial or stale progress", () => {
    const progress = reconcileReviewProgress({
      previous: null,
      reviewKey: "review",
      revisionKey: "head-1",
      changedFiles: CHANGED,
      authoritativeFiles: [row(FILE_A, [
        { nodeId: "unit-a1", fingerprint: "a1" },
        { nodeId: "unit-a2", fingerprint: "a2" },
      ])],
      includeTests: false,
      unitTicks: {},
      fileTicks: {},
    });
    const file = progress.catalog.byPath.get(FILE_A)!;
    const partial = { "unit-a1": { at: "old", fingerprint: "a1" } };

    const units = [
      { nodeId: "unit-a1", fingerprint: "a1" },
      { nodeId: "unit-a2", fingerprint: "a2" },
    ];
    const completed = applyReviewFileToggle(progress.catalog, file, partial, {}, "fresh", false, units);
    expect(completed.unitTicks).toMatchObject({
      "unit-a1": { at: "fresh", fingerprint: "a1" },
      "unit-a2": { at: "fresh", fingerprint: "a2" },
    });
    expect(reviewFileProgressState(
      completed.catalog.byPath.get(FILE_A)!,
      completed.unitTicks,
      completed.fileTicks,
      false,
    )).toBe("done");

    const stale = { ...completed.unitTicks, "unit-a2": { at: "old", fingerprint: "moved" } };
    const staleProgress = reconcileReviewProgress({
      previous: completed.catalog,
      reviewKey: "review",
      revisionKey: "head-1",
      changedFiles: CHANGED,
      authoritativeFiles: [row(FILE_A, units)],
      includeTests: false,
      unitTicks: stale,
      fileTicks: {},
    });
    expect(reviewFileProgressState(
      staleProgress.catalog.byPath.get(FILE_A)!,
      staleProgress.unitTicks,
      staleProgress.fileTicks,
      false,
    )).toBe("stale");
    const refreshed = applyReviewFileToggle(
      staleProgress.catalog,
      staleProgress.catalog.byPath.get(FILE_A)!,
      staleProgress.unitTicks,
      staleProgress.fileTicks,
      "newer",
      false,
      units,
    );
    expect(reviewFileProgressState(
      refreshed.catalog.byPath.get(FILE_A)!,
      refreshed.unitTicks,
      refreshed.fileTicks,
      false,
    )).toBe("done");

    const cleared = applyReviewFileToggle(
      refreshed.catalog,
      refreshed.catalog.byPath.get(FILE_A)!,
      refreshed.unitTicks,
      refreshed.fileTicks,
      "unused",
      false,
      units,
    );
    expect(cleared.unitTicks).toEqual({});
  });

  it("bulk-toggles canonical files without disturbing ticks outside the requested set", () => {
    const progress = reconcileReviewProgress({
      previous: null,
      reviewKey: "review",
      revisionKey: "head-1",
      changedFiles: CHANGED,
      authoritativeFiles: [
        row(FILE_A, [{ nodeId: "unit-a", fingerprint: "a" }]),
        row(FILE_B, []),
      ],
      includeTests: false,
      unitTicks: {},
      fileTicks: {},
    });
    const files = progress.catalog.order.map((path) => progress.catalog.byPath.get(path)!);
    const unrelated = { at: "earlier", fingerprint: "outside" };
    const initialUnits = { "unit-a": { at: "t1", fingerprint: "a" }, outside: unrelated };
    const initialFiles = { "outside.md": unrelated };

    expect(reviewFilesProgressState(files, initialUnits, initialFiles, false)).toBe("todo");
    const completed = applyReviewFilesToggle(
      progress.catalog,
      files,
      initialUnits,
      initialFiles,
      "t2",
      false,
      new Map([[FILE_A, [{ nodeId: "unit-a", fingerprint: "a" }]], [FILE_B, []]]),
    );
    const completedFiles = completed.catalog.order.map((path) => completed.catalog.byPath.get(path)!);
    expect(reviewFilesProgressState(completedFiles, completed.unitTicks, completed.fileTicks, false)).toBe("done");
    expect(completed.unitTicks.outside).toBe(unrelated);
    expect(completed.fileTicks["outside.md"]).toBe(unrelated);

    const cleared = applyReviewFilesToggle(
      completed.catalog,
      completedFiles,
      completed.unitTicks,
      completed.fileTicks,
      "t3",
      false,
      new Map([[FILE_A, [{ nodeId: "unit-a", fingerprint: "a" }]], [FILE_B, []]]),
    );
    const clearedFiles = cleared.catalog.order.map((path) => cleared.catalog.byPath.get(path)!);
    expect(reviewFilesProgressState(clearedFiles, cleared.unitTicks, cleared.fileTicks, false)).toBe("todo");
    expect(cleared.unitTicks).toEqual({ outside: unrelated });
    expect(cleared.fileTicks).toEqual({ "outside.md": unrelated });
  });

  it("preserves hunk-based fingerprints within a revision and resets completeness for a new one", () => {
    const first = reconcileReviewProgress({
      previous: null,
      reviewKey: "review",
      revisionKey: "head-1",
      changedFiles: CHANGED,
      authoritativeFiles: [row(FILE_A, [{ nodeId: "unit-a", fingerprint: "a" }])],
      includeTests: false,
      unitTicks: {},
      fileTicks: {},
    });
    const richerSameRevision = reconcileReviewProgress({
      previous: first.catalog,
      reviewKey: "review",
      revisionKey: "head-1",
      changedFiles: [{ ...CHANGED[0]!, hunks: [{ start: 1, end: 99 }] }, CHANGED[1]!],
      authoritativeFiles: [],
      includeTests: false,
      unitTicks: {},
      fileTicks: {},
    });
    expect(richerSameRevision.catalog.byPath.get(FILE_A)?.fingerprint).toBe("1-4");
    expect(richerSameRevision.catalog.byPath.get(FILE_A)?.tickedUnitIds).toEqual([]);

    const nextRevision = reconcileReviewProgress({
      previous: richerSameRevision.catalog,
      reviewKey: "review",
      revisionKey: "head-2",
      changedFiles: [{ ...CHANGED[0]!, hunks: [{ start: 1, end: 99 }] }, CHANGED[1]!],
      authoritativeFiles: [],
      includeTests: false,
      unitTicks: {},
      fileTicks: {},
    });
    expect(nextRevision.catalog.byPath.get(FILE_A)?.fingerprint).toBe("1-99");
    expect(nextRevision.catalog.byPath.get(FILE_A)?.tickedUnitIds).toEqual([]);
  });

  it("recomputes done, stale, and todo when an evicted exact file is reloaded", () => {
    const firstUnits = [
      { nodeId: "unit-a1", fingerprint: "a1" },
      { nodeId: "unit-a2", fingerprint: "a2" },
    ];
    const first = reconcileReviewProgress({
      previous: null,
      reviewKey: "review",
      revisionKey: "head-1",
      changedFiles: CHANGED,
      authoritativeFiles: [row(FILE_A, firstUnits)],
      includeTests: false,
      unitTicks: {
        "unit-a1": { at: "viewed", fingerprint: "a1" },
        "unit-a2": { at: "viewed", fingerprint: "a2" },
      },
      fileTicks: {},
    });
    const overview = reconcileReviewProgress({
      previous: first.catalog,
      reviewKey: "review",
      revisionKey: "head-1",
      changedFiles: CHANGED,
      authoritativeFiles: [],
      includeTests: false,
      unitTicks: first.unitTicks,
      fileTicks: first.fileTicks,
    });
    expect(overview.catalog.byPath.get(FILE_A)?.state).toBe("done");
    expect(overview.catalog.byPath.get(FILE_A)).not.toHaveProperty("units");

    const cachedBack = reconcileReviewProgress({
      previous: overview.catalog,
      reviewKey: "review",
      revisionKey: "head-1",
      changedFiles: CHANGED,
      authoritativeFiles: [row(FILE_A, firstUnits)],
      includeTests: false,
      unitTicks: overview.unitTicks,
      fileTicks: overview.fileTicks,
    });
    expect(cachedBack.catalog.byPath.get(FILE_A)?.state).toBe("done");

    const reloadedChanged = reconcileReviewProgress({
      previous: overview.catalog,
      reviewKey: "review",
      revisionKey: "head-1",
      changedFiles: CHANGED,
      authoritativeFiles: [row(FILE_A, [
        { nodeId: "unit-a1", fingerprint: "a1" },
        { nodeId: "unit-a2", fingerprint: "changed" },
      ])],
      includeTests: false,
      unitTicks: overview.unitTicks,
      fileTicks: overview.fileTicks,
    });
    expect(reloadedChanged.catalog.byPath.get(FILE_A)?.state).toBe("stale");

    const reloadedWithNoTicks = reconcileReviewProgress({
      previous: overview.catalog,
      reviewKey: "review",
      revisionKey: "head-1",
      changedFiles: CHANGED,
      authoritativeFiles: [row(FILE_A, firstUnits)],
      includeTests: false,
      unitTicks: {},
      fileTicks: {},
    });
    expect(reloadedWithNoTicks.catalog.byPath.get(FILE_A)?.state).toBe("todo");
  });

  it("keeps hidden test ticks but invalidates a filtered aggregate until the full view reloads", () => {
    const productionUnit = { nodeId: "unit-production", fingerprint: "production" };
    const testUnit = { nodeId: "unit-test", fingerprint: "test", isTest: true };
    const ticks = {
      [productionUnit.nodeId]: { at: "viewed", fingerprint: productionUnit.fingerprint },
      [testUnit.nodeId]: { at: "viewed", fingerprint: testUnit.fingerprint },
    };
    const withTests = reconcileReviewProgress({
      previous: null,
      reviewKey: "review",
      revisionKey: "head-1",
      changedFiles: CHANGED,
      authoritativeFiles: [row(FILE_A, [productionUnit, testUnit])],
      includeTests: true,
      unitTicks: ticks,
      fileTicks: {},
    });
    expect(withTests.catalog.byPath.get(FILE_A)?.state).toBe("done");

    const withoutTests = reconcileReviewProgress({
      previous: withTests.catalog,
      reviewKey: "review",
      revisionKey: "head-1",
      changedFiles: CHANGED,
      authoritativeFiles: [row(FILE_A, [productionUnit])],
      includeTests: false,
      unitTicks: withTests.unitTicks,
      fileTicks: withTests.fileTicks,
    });
    const filtered = withoutTests.catalog.byPath.get(FILE_A)!;
    expect(filtered.tickedUnitIds).toEqual([productionUnit.nodeId, testUnit.nodeId]);
    expect(withoutTests.unitTicks[testUnit.nodeId]).toEqual(ticks[testUnit.nodeId]);
    expect(reviewFileProgressState(filtered, withoutTests.unitTicks, withoutTests.fileTicks, false)).toBe("done");
    expect(reviewFileProgressState(filtered, withoutTests.unitTicks, withoutTests.fileTicks, true)).toBe("todo");

    const restored = reconcileReviewProgress({
      previous: withoutTests.catalog,
      reviewKey: "review",
      revisionKey: "head-1",
      changedFiles: CHANGED,
      authoritativeFiles: [row(FILE_A, [productionUnit, testUnit])],
      includeTests: true,
      unitTicks: withoutTests.unitTicks,
      fileTicks: withoutTests.fileTicks,
    });
    expect(restored.catalog.byPath.get(FILE_A)?.state).toBe("done");
    expect(restored.catalog.byPath.get(FILE_A)?.tickedUnitIds).toEqual([
      productionUnit.nodeId,
      testUnit.nodeId,
    ]);
  });
});
