/**
 * The files-first review checklist: unit grouping (hunk ∩ node, container kinds excluded, nesting
 * depth), the whole-file fallback, the derived vs explicit per-file viewed state, and the tick
 * transitions — including the staleness contract (a moved block never stays silently green).
 */

import { describe, expect, it } from "vitest";
import type { GraphArtifact, GraphEdge, GraphNode, ReviewContext } from "@meridian/core";
import { buildGraphIndex } from "../graph/graphIndex";
import {
  applyUnitTick,
  checkStateOf,
  deriveReviewFiles,
  isReviewTestPath,
  unitsViewState,
} from "./reviewFiles";

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

function edge(
  id: string,
  source: string,
  target: string,
  kind: string,
  resolution?: GraphEdge["resolution"],
): GraphEdge {
  return { id, source, target, kind, resolution };
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
  it("classifies matched, explicitly tagged, and unmatched test files", () => {
    const taggedModule = {
      ...node("ts:src/checks.ts", "module", "src/checks.ts", 1, 20, null),
      tags: ["test"],
    } as GraphNode;
    const artifact = {
      nodes: [...NODES, taggedModule],
      edges: [],
    } as unknown as GraphArtifact;
    const files = deriveReviewFiles(
      contextOf([
        { path: "src/a.ts", status: "modified" },
        { path: "src/checks.ts", status: "modified" },
        { path: "src/new.spec.ts", status: "added" },
      ]),
      artifact,
      buildGraphIndex(artifact),
      { baseIndex: null },
    );

    expect(Object.fromEntries(files.map((file) => [file.path, file.isTest]))).toEqual({
      "src/a.ts": false,
      "src/checks.ts": true,
      "src/new.spec.ts": true,
    });

    const taggedIndex = buildGraphIndex(artifact);
    const emptyArtifact = { nodes: [], edges: [] } as unknown as GraphArtifact;
    expect(isReviewTestPath("src/checks.ts", buildGraphIndex(emptyArtifact), taggedIndex)).toBe(true);
    const untaggedHead = {
      nodes: [node("ts:src/checks.ts", "module", "src/checks.ts", 1, 20, null)],
      edges: [],
    } as unknown as GraphArtifact;
    expect(isReviewTestPath("src/checks.ts", buildGraphIndex(untaggedHead), taggedIndex)).toBe(false);
  });

  it("uses canonical projection verdicts before graph-index inference for ordinary paths", () => {
    const emptyArtifact = { nodes: [], edges: [] } as unknown as GraphArtifact;
    const emptyIndex = buildGraphIndex(emptyArtifact);
    const taggedModule = {
      ...node("ts:src/ordinary.ts", "module", "src/ordinary.ts", 1, 20, null),
      tags: ["test"],
    } as GraphNode;
    const taggedBase = buildGraphIndex({ nodes: [taggedModule], edges: [] } as unknown as GraphArtifact);
    const testVerdicts = new Map([["src/ordinary.ts", true]]);

    const [file] = deriveReviewFiles(
      contextOf([{ path: "src/ordinary.ts", status: "modified" }]),
      emptyArtifact,
      emptyIndex,
      { baseIndex: null, testVerdicts },
    );

    expect(file.isTest).toBe(true);
    expect(isReviewTestPath("src/ordinary.ts", emptyIndex, null, testVerdicts)).toBe(true);
    // Current canonical HEAD truth must also be able to override stale merge-base classification.
    expect(isReviewTestPath(
      "src/ordinary.ts",
      emptyIndex,
      taggedBase,
      new Map([["src/ordinary.ts", false]]),
    )).toBe(false);
    // The path heuristic remains the safe fallback even if bounded metadata is malformed/stale.
    expect(isReviewTestPath(
      "src/ordinary.test.ts",
      emptyIndex,
      null,
      new Map([["src/ordinary.test.ts", false]]),
    )).toBe(true);
  });

  it("groups hunk-overlapping LEAF units per file, in-graph files FIRST, ordered by start line", () => {
    const context = contextOf([
      { path: "docs/readme.md", status: "modified", hunks: [{ start: 1, end: 3 }] },
      { path: "src/a.ts", status: "modified", hunks: [{ start: 25, end: 30 }] },
    ]);
    const files = deriveReviewFiles(context, ARTIFACT, INDEX, { baseIndex: null });
    // src/a.ts sorts first despite "d" < "s": it is on the graph, the md file is not.
    expect(files.map((file) => [file.path, file.moduleId])).toEqual([
      ["src/a.ts", "ts:src/a.ts"],
      ["docs/readme.md", null],
    ]);
    const [a, docs] = files;
    // The md file maps to no extracted block — a unit-less row, not a dropped one.
    expect(docs.units).toEqual([]);
    // Core marks LEAF blocks: the 25..30 hunk sits inside Repo.save, so the containing class does
    // NOT mark (no own-line touch) and helper (70..90) misses it entirely.
    expect(a.units.map((unit) => [unit.nodeId, unit.depth])).toEqual([["ts:src/a.ts#Repo.save", 1]]);
  });

  it("keeps a hunk-less changed file as a unit-less row (core's module-only fallback)", () => {
    const files = deriveReviewFiles(
      contextOf([{ path: "src/a.ts", status: "modified" }]),
      ARTIFACT,
      INDEX,
      { baseIndex: null },
    );
    // The module node carries the "file changed" graph signal, but a container kind must never
    // render as a checkable unit — the file row itself represents it.
    expect(files[0].moduleId).toBe("ts:src/a.ts");
    expect(files[0].units).toEqual([]);
  });

  it("counts distinct unchanged caller files into changed units using resolved execution edges", () => {
    const extraNodes = [
      node("ts:src/b.ts#one", "function", "src/b.ts", 5, 8, null),
      node("ts:src/b.ts#two", "function", "src/b.ts", 10, 14, null),
      node("ts:src/c.ts#changing", "function", "src/c.ts", 5, 8, null),
      node("ts:src/d.ts#construct", "function", "src/d.ts", 5, 8, null),
      node("ts:src/e.ts#importer", "function", "src/e.ts", 5, 8, null),
      node("ts:src/f.ts#guess", "function", "src/f.ts", 5, 8, null),
    ];
    const artifact = {
      nodes: [...NODES, ...extraNodes],
      edges: [
        edge("calls-b1", "ts:src/b.ts#one", "ts:src/a.ts#Repo.save", "calls", "resolved"),
        edge("renders-b2", "ts:src/b.ts#two", "ts:src/a.ts#Repo.save", "renders", "resolved"),
        edge("calls-c", "ts:src/c.ts#changing", "ts:src/a.ts#Repo.save", "calls", "resolved"),
        edge("instantiates-d", "ts:src/d.ts#construct", "ts:src/a.ts#Repo.save", "instantiates"),
        edge("imports-e", "ts:src/e.ts#importer", "ts:src/a.ts#Repo.save", "imports", "resolved"),
        edge("calls-f", "ts:src/f.ts#guess", "ts:src/a.ts#Repo.save", "calls", "unresolved"),
      ],
    } as unknown as GraphArtifact;
    const index = buildGraphIndex(artifact);
    const files = deriveReviewFiles(
      contextOf([
        { path: "src/a.ts", status: "modified", hunks: [{ start: 25, end: 30 }] },
        { path: "src/c.ts", status: "modified", hunks: [{ start: 5, end: 8 }] },
      ]),
      artifact,
      index,
      { baseIndex: null },
    );

    expect(files.find((file) => file.path === "src/a.ts")).toMatchObject({
      blastRadius: 2,
      deletedImpact: null,
    });
  });

  it("derives capped surviving callers and resolution caveats for a deleted baseline file", () => {
    const deletedNodes = [
      node("ts:src/gone.ts", "module", "src/gone.ts", 1, 50, null),
      node("ts:src/gone.ts#gone", "function", "src/gone.ts", 10, 20, "ts:src/gone.ts"),
    ];
    const callerNodes = Array.from({ length: 9 }, (_, index) =>
      node(`ts:src/live-${index}.ts#caller`, "function", `src/live-${index}.ts`, index + 1, index + 2, null),
    );
    const changingCaller = node("ts:src/changing.ts#caller", "function", "src/changing.ts", 3, 4, null);
    const resolvedEdges = callerNodes.map((caller, index) =>
      edge(`caller-${index}`, caller.id, "ts:src/gone.ts#gone", "calls", "resolved"),
    );
    const baseArtifact = {
      nodes: [...deletedNodes, ...callerNodes, changingCaller],
      edges: [
        ...resolvedEdges,
        edge("duplicate-caller", callerNodes[0].id, "ts:src/gone.ts", "renders", "resolved"),
        edge("unresolved", callerNodes[0].id, "ts:src/gone.ts#gone", "calls", "unresolved"),
        edge("external", callerNodes[1].id, "ts:src/gone.ts#gone", "calls", "external"),
        edge("changed-caller", changingCaller.id, "ts:src/gone.ts#gone", "calls", "resolved"),
      ],
    } as unknown as GraphArtifact;
    const activeArtifact = { nodes: [], edges: [] } as unknown as GraphArtifact;
    const files = deriveReviewFiles(
      contextOf([
        { path: "src/gone.ts", status: "deleted" },
        { path: "docs/gone.md", status: "deleted" },
        { path: "src/changing.ts", status: "modified" },
      ]),
      activeArtifact,
      buildGraphIndex(activeArtifact),
      { baseIndex: buildGraphIndex(baseArtifact) },
    );
    const gone = files.find((file) => file.path === "src/gone.ts");

    expect(gone?.deletedImpact).toMatchObject({
      unresolvedCount: 2,
      truncated: true,
      omittedCallerCount: 1,
    });
    expect(gone?.deletedImpact?.callers).toHaveLength(8);
    expect(gone?.deletedImpact?.callers[0]).toEqual({
      nodeId: "ts:src/live-0.ts#caller",
      displayName: "caller",
      file: "src/live-0.ts",
      line: 1,
    });
    expect(files.find((file) => file.path === "docs/gone.md")?.deletedImpact).toBeNull();
    expect(files.find((file) => file.path === "src/changing.ts")?.deletedImpact).toBeNull();
  });
});

describe("unit view state + tick transitions", () => {
  // Two hunks so src/a.ts carries TWO leaf units (Repo.save + helper).
  const context = contextOf([
    { path: "src/a.ts", status: "modified", hunks: [{ start: 25, end: 30 }, { start: 75, end: 80 }] },
    { path: "docs/readme.md", status: "deleted" },
  ]);
  const [a] = deriveReviewFiles(context, ARTIFACT, INDEX, { baseIndex: null });

  it("derives aggregate viewed state from its units (all done ⇒ done)", () => {
    let unitTicks: Record<string, { at: string; fingerprint: string }> = {};
    expect(unitsViewState(a.units, unitTicks)).toBe("todo");
    for (const unit of a.units) {
      unitTicks = applyUnitTick(unitTicks, unit, "2026-07-10T00:00:00Z");
    }
    expect(unitsViewState(a.units, unitTicks)).toBe("done");
    // Toggling one unit off drops the file back to todo.
    unitTicks = applyUnitTick(unitTicks, a.units[0], "2026-07-10T00:00:01Z");
    expect(unitsViewState(a.units, unitTicks)).toBe("todo");
  });

  it("marks a ticked unit stale when its fingerprint no longer matches", () => {
    const tick = { at: "t", fingerprint: "old-fingerprint" };
    expect(checkStateOf(a.units[0].fingerprint, tick)).toBe("stale");
    expect(unitsViewState(a.units, { [a.units[0].nodeId]: tick })).toBe("stale");
  });
});
