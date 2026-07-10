/**
 * The files-first review checklist: unit grouping (hunk ∩ node, container kinds excluded, nesting
 * depth), the whole-file fallback, the derived vs explicit per-file viewed state, and the tick
 * transitions — including the staleness contract (a moved block never stays silently green).
 */

import { describe, expect, it } from "vitest";
import type { GraphArtifact, GraphNode, ReviewContext } from "@meridian/core";
import { buildGraphIndex } from "../graph/graphIndex";
import { applyFileToggle, applyUnitTick, checkStateOf, deriveReviewFiles, fileViewState } from "./reviewFiles";

function node(id: string, kind: string, file: string, start: number, end: number, parentId: string | null): GraphNode {
  return {
    id,
    kind,
    qualifiedName: id,
    displayName: id.split(/[#.]/).pop() ?? id,
    parentId,
    location: { file, startLine: start, endLine: end },
  } as GraphNode;
}

const NODES: GraphNode[] = [
  node("ts:src/a.ts", "module", "src/a.ts", 1, 120, null),
  node("ts:src/a.ts#Repo", "class", "src/a.ts", 10, 60, "ts:src/a.ts"),
  node("ts:src/a.ts#Repo.save", "method", "src/a.ts", 20, 40, "ts:src/a.ts#Repo"),
  node("ts:src/a.ts#helper", "function", "src/a.ts", 70, 90, "ts:src/a.ts"),
];

const ARTIFACT = { nodes: NODES, edges: [] } as unknown as GraphArtifact;
const INDEX = buildGraphIndex(ARTIFACT);

function contextOf(changedFiles: ReviewContext["changedFiles"]): ReviewContext {
  return { changedFiles, baseRef: null, baseSha: null, headRef: null, reviewKey: "test", warnings: [] };
}

describe("deriveReviewFiles", () => {
  it("groups hunk-overlapping units per file, in-graph files FIRST, units by start line with depth", () => {
    const context = contextOf([
      { path: "docs/readme.md", status: "modified", hunks: [{ start: 1, end: 3 }] },
      { path: "src/a.ts", status: "modified", hunks: [{ start: 25, end: 30 }] },
    ]);
    const files = deriveReviewFiles(context, ARTIFACT, INDEX);
    // src/a.ts sorts first despite "d" < "s": it is on the graph, the md file is not.
    expect(files.map((file) => [file.path, file.moduleId])).toEqual([
      ["src/a.ts", "ts:src/a.ts"],
      ["docs/readme.md", null],
    ]);
    const [a, docs] = files;
    // The md file maps to no extracted block — a unit-less row, not a dropped one.
    expect(docs.units).toEqual([]);
    // Module (file container) is excluded; helper (70..90) misses the 25..30 hunk.
    expect(a.units.map((unit) => [unit.nodeId, unit.depth])).toEqual([
      ["ts:src/a.ts#Repo", 0],
      ["ts:src/a.ts#Repo.save", 1],
    ]);
  });

  it("falls back to every block in the file when a changed file carries no hunks", () => {
    const files = deriveReviewFiles(contextOf([{ path: "src/a.ts", status: "modified" }]), ARTIFACT, INDEX);
    expect(files[0].units.map((unit) => unit.nodeId)).toEqual([
      "ts:src/a.ts#Repo",
      "ts:src/a.ts#Repo.save",
      "ts:src/a.ts#helper",
    ]);
  });
});

describe("view state + tick transitions", () => {
  const context = contextOf([
    { path: "src/a.ts", status: "modified", hunks: [{ start: 25, end: 30 }] },
    { path: "docs/readme.md", status: "deleted" },
  ]);
  const [a, docs] = deriveReviewFiles(context, ARTIFACT, INDEX);

  it("derives a unit-ful file's viewed state from its units (all done ⇒ done)", () => {
    let unitTicks: Record<string, { at: string; fingerprint: string }> = {};
    expect(fileViewState(a, unitTicks, {})).toBe("todo");
    for (const unit of a.units) {
      unitTicks = applyUnitTick(unitTicks, unit, "2026-07-10T00:00:00Z");
    }
    expect(fileViewState(a, unitTicks, {})).toBe("done");
    // Toggling one unit off drops the file back to todo.
    unitTicks = applyUnitTick(unitTicks, a.units[0], "2026-07-10T00:00:01Z");
    expect(fileViewState(a, unitTicks, {})).toBe("todo");
  });

  it("marks a ticked unit stale when its fingerprint no longer matches", () => {
    const tick = { at: "t", fingerprint: "old-fingerprint" };
    expect(checkStateOf(a.units[0].fingerprint, tick)).toBe("stale");
    expect(fileViewState(a, { [a.units[0].nodeId]: tick }, {})).toBe("stale");
  });

  it("cascades the file toggle over its units, both on and off", () => {
    const on = applyFileToggle(a, {}, {}, "t");
    expect(a.units.every((unit) => checkStateOf(unit.fingerprint, on.unitTicks[unit.nodeId]) === "done")).toBe(true);
    expect(on.fileTicks).toEqual({});
    const off = applyFileToggle(a, on.unitTicks, on.fileTicks, "t");
    expect(Object.keys(off.unitTicks)).toEqual([]);
  });

  it("re-ticking a PARTLY viewed file completes it instead of clearing the done units", () => {
    const partial = applyUnitTick({}, a.units[0], "t");
    const next = applyFileToggle(a, partial, {}, "t");
    expect(fileViewState(a, next.unitTicks, next.fileTicks)).toBe("done");
  });

  it("uses the explicit file tick for a unit-less file, with hunk-digest staleness", () => {
    expect(fileViewState(docs, {}, {})).toBe("todo");
    const on = applyFileToggle(docs, {}, {}, "t");
    expect(on.fileTicks[docs.path]).toEqual({ at: "t", fingerprint: docs.fingerprint });
    expect(fileViewState(docs, {}, on.fileTicks)).toBe("done");
    expect(fileViewState(docs, {}, { [docs.path]: { at: "t", fingerprint: "other" } })).toBe("stale");
    const off = applyFileToggle(docs, {}, on.fileTicks, "t");
    expect(off.fileTicks).toEqual({});
  });
});
