import { describe, expect, it } from "vitest";
import type { GraphArtifact, GraphNode, LogicFlows } from "@meridian/core";
import { buildGraphIndex, type GraphIndex } from "../graph/graphIndex";
import { buildBlockDeps } from "./blockDeps";
import { buildModuleGraph } from "./moduleGraph";
import {
  applyMinimalCodebaseExpansionOverrides,
  deriveMinimalCodebaseContext,
  type MinimalCodebaseContext,
} from "./minimalCodebaseContext";

const APP = "ts:app";
const SRC = `${APP}/src`;
const FEATURE_A = `${SRC}/feature-a`;
const FILE_A = `${FEATURE_A}/a.ts`;
const CLASS_A = `${FILE_A}#A`;
const METHOD_A = `${CLASS_A}.changed`;
const METHOD_A_TWO = `${CLASS_A}.alsoChanged`;
const FEATURE_B = `${SRC}/feature-b`;
const FILE_B = `${FEATURE_B}/b.ts`;
const FUNCTION_B = `${FILE_B}#changedB`;

const TOOLS = "ts:tools";
const TOOLS_SRC = `${TOOLS}/src`;
const TOOLS_FILE = `${TOOLS_SRC}/tool.ts`;
const TOOLS_FUNCTION = `${TOOLS_FILE}#changedTool`;

function node(id: string, kind: string, parentId: string | null, tags?: string[]): GraphNode {
  return {
    id,
    kind,
    parentId,
    qualifiedName: id,
    displayName: id.split("/").at(-1) ?? id,
    location: { file: id.replace(/^ts:/, ""), startLine: 1 },
    ...(tags ? { tags } : {}),
  } as GraphNode;
}

const ARTIFACT: GraphArtifact = {
  schemaVersion: "1.0.0",
  generatedAt: "2026-07-12T00:00:00.000Z",
  generator: { name: "test", version: "0" },
  target: { name: "fixture", root: ".", language: "typescript" },
  nodes: [
    node(APP, "package", null, ["npm-package"]),
    node(SRC, "package", APP),
    node(FEATURE_A, "package", SRC),
    node(FILE_A, "module", FEATURE_A),
    node(CLASS_A, "class", FILE_A),
    node(METHOD_A, "method", CLASS_A),
    node(METHOD_A_TWO, "method", CLASS_A),
    node(FEATURE_B, "package", SRC),
    node(FILE_B, "module", FEATURE_B),
    node(FUNCTION_B, "function", FILE_B),
    node(TOOLS, "package", null, ["npm-package"]),
    node(TOOLS_SRC, "package", TOOLS),
    node(TOOLS_FILE, "module", TOOLS_SRC),
    node(TOOLS_FUNCTION, "function", TOOLS_FILE),
  ],
  edges: [],
};

const INDEX = buildGraphIndex(ARTIFACT);

function derive(
  memberIds: readonly string[],
  minimalRollups: Readonly<Record<string, readonly string[]>> = {},
  index: GraphIndex = INDEX,
  options: { flows?: LogicFlows; hiddenIds?: ReadonlySet<string>; expandedIds?: ReadonlySet<string> } = {},
): MinimalCodebaseContext | null {
  return deriveMinimalCodebaseContext({
    index,
    moduleGraph: buildModuleGraph(index),
    blockDeps: buildBlockDeps(index),
    flows: options.flows ?? {},
    minimalMemberIds: memberIds,
    minimalRollups,
    hiddenIds: options.hiddenIds,
    expandedIds: options.expandedIds,
    demoteCommons: false,
  });
}

function visibleIds(context: MinimalCodebaseContext): Set<string> {
  return new Set(context.tree.nodes.filter((entry) => entry.kind !== "ghost").map((entry) => entry.id));
}

function applyExpansion(
  context: MinimalCodebaseContext,
  overrides: ReadonlyMap<string, boolean>,
): MinimalCodebaseContext {
  return applyMinimalCodebaseExpansionOverrides(
    context,
    {
      index: INDEX,
      moduleGraph: buildModuleGraph(INDEX),
      blockDeps: buildBlockDeps(INDEX),
      flows: {},
      demoteCommons: false,
    },
    overrides,
  );
}

function expectHighlightsDrawn(context: MinimalCodebaseContext): void {
  const visible = visibleIds(context);
  expect([...context.highlightTargetIds].every((id) => visible.has(id))).toBe(true);
  expect(context.reveal.moduleSelected).toEqual(context.highlightTargetIds);
}

describe("deriveMinimalCodebaseContext", () => {
  it("uses a shared file as the cheapest LCA for methods in that file", () => {
    const context = derive([METHOD_A, METHOD_A_TWO]);

    expect(context?.reveal.moduleFocus).toBe(FILE_A);
    expect(context?.reveal.moduleExpanded).toEqual(new Set([CLASS_A]));
    expect(context?.highlightTargetIds).toEqual(new Set([METHOD_A, METHOD_A_TWO]));
    expectHighlightsDrawn(context as MinimalCodebaseContext);
  });

  it("widens above a bare package member so the package itself is a drawn highlight", () => {
    const context = derive([FEATURE_A]);

    expect(context).not.toBeNull();
    expect(context?.reveal.moduleFocus).toBe(SRC);
    expect(context?.reveal.moduleExpanded).toEqual(new Set());
    expect(context?.highlightTargetIds).toEqual(new Set([FEATURE_A]));
    expect(context?.tree.nodes.find((entry) => entry.id === FEATURE_A)).toMatchObject({
      kind: "package",
      parentId: null,
      isExpanded: false,
    });
    expectHighlightsDrawn(context as MinimalCodebaseContext);
  });

  it("widens a mixed package + descendant target and opens only the descendant's ancestor gates", () => {
    const context = derive([FEATURE_A, METHOD_A]);

    expect(context).not.toBeNull();
    expect(context?.reveal.moduleFocus).toBe(SRC);
    expect(context?.reveal.moduleExpanded).toEqual(new Set([FEATURE_A, FILE_A, CLASS_A]));
    expect(context?.highlightTargetIds).toEqual(new Set([FEATURE_A, METHOD_A]));
    expect(context?.tree.nodes.find((entry) => entry.id === METHOD_A)).toMatchObject({
      kind: "block",
      parentId: CLASS_A,
    });
    expectHighlightsDrawn(context as MinimalCodebaseContext);
  });

  it("uses the sibling directories' deepest common package and expands only their two paths", () => {
    const context = derive([METHOD_A, FUNCTION_B]);

    expect(context).not.toBeNull();
    expect(context?.reveal.moduleFocus).toBe(SRC);
    expect(context?.tree.effectiveFocus).toBe(SRC);
    expect(context?.reveal.moduleExpanded).toEqual(
      new Set([FEATURE_A, FILE_A, CLASS_A, FEATURE_B, FILE_B]),
    );
    expect(context?.highlightTargetIds).toEqual(new Set([METHOD_A, FUNCTION_B]));
    expectHighlightsDrawn(context as MinimalCodebaseContext);
  });

  it("falls back to the repository overview when targets have no common package root", () => {
    const context = derive([METHOD_A, TOOLS_FUNCTION]);

    expect(context).not.toBeNull();
    expect(context?.reveal.moduleFocus).toBeNull();
    expect(context?.tree.effectiveFocus).toBeNull();
    expect(context?.reveal.moduleExpanded).toEqual(
      new Set([APP, SRC, FEATURE_A, FILE_A, CLASS_A, TOOLS, TOOLS_SRC, TOOLS_FILE]),
    );
    expect(context?.highlightTargetIds).toEqual(new Set([METHOD_A, TOOLS_FUNCTION]));
    expectHighlightsDrawn(context as MinimalCodebaseContext);
  });

  it("drops unknown ids best-effort, reports them, and never accepts a same-id ghost as visible", () => {
    const unknown = "ts:missing#changed";
    const context = derive([unknown, FILE_A]);

    expect(context).not.toBeNull();
    expect(context?.normalizedTargetIds).toEqual([unknown, FILE_A]);
    expect(context?.highlightTargetIds).toEqual(new Set([FILE_A]));
    expect(context?.unresolvedTargetIds).toEqual(new Set([unknown]));
    expectHighlightsDrawn(context as MinimalCodebaseContext);
    expect(derive([unknown])).toBeNull();
  });

  it("keeps target paths visible when the ordinary Map test filter hides them", () => {
    const hiddenPath = new Set([APP, SRC, FEATURE_A, FILE_A, CLASS_A, METHOD_A]);
    const context = derive([METHOD_A], {}, INDEX, { hiddenIds: hiddenPath });

    expect(context?.reveal.moduleFocus).toBe(FILE_A);
    expect(context?.highlightTargetIds).toEqual(new Set([METHOD_A]));
    expectHighlightsDrawn(context as MinimalCodebaseContext);
  });

  it("retains an expanded callable so its synthetic flow steps stay visible", () => {
    const stepId = `step:${FUNCTION_B}:0`;
    const context = derive([FUNCTION_B], {}, INDEX, {
      flows: {
        [FUNCTION_B]: [{ kind: "call", label: "changed", target: METHOD_A, resolution: "resolved" }],
      },
      expandedIds: new Set([FUNCTION_B]),
    });

    expect(context?.reveal.moduleFocus).toBe(FILE_B);
    expect(context?.tree.nodes).toContainEqual(expect.objectContaining({ id: stepId, parentId: FUNCTION_B }));
    expect(context?.reveal.moduleExpanded.has(FUNCTION_B)).toBe(true);
  });

  it("normalizes only a current PR rollup package to its changed files", () => {
    const staleRollup = "ts:stale";
    const context = derive(
      [APP],
      {
        [APP]: [FILE_A, FILE_A, FILE_B],
        [staleRollup]: [TOOLS_FILE],
      },
    );

    expect(context).not.toBeNull();
    expect(context?.normalizedTargetIds).toEqual([FILE_A, FILE_B]);
    expect(context?.highlightTargetIds).toEqual(new Set([FILE_A, FILE_B]));
    expect(context?.highlightTargetIds.has(APP)).toBe(false);
    expect(context?.highlightTargetIds.has(TOOLS_FILE)).toBe(false);
    expect(context?.reveal.moduleFocus).toBe(SRC);
    expect(context?.reveal.moduleExpanded).toEqual(new Set([FEATURE_A, FEATURE_B]));
    expectHighlightsDrawn(context as MinimalCodebaseContext);
  });

  it("widens all the way to repo root when a root package itself is the target", () => {
    const context = derive([APP]);

    expect(context).not.toBeNull();
    expect(context?.reveal.moduleFocus).toBeNull();
    expect(context?.reveal.moduleExpanded).toEqual(new Set());
    expect(context?.highlightTargetIds).toEqual(new Set([APP]));
    expectHighlightsDrawn(context as MinimalCodebaseContext);
  });

  it("locally collapses an auto-opened target path without changing focus or availability", () => {
    const canonical = derive([METHOD_A, FUNCTION_B]) as MinimalCodebaseContext;
    const context = applyExpansion(canonical, new Map([[FEATURE_A, false]]));

    expect(context.reveal.moduleFocus).toBe(SRC);
    expect(context.tree.effectiveFocus).toBe(SRC);
    expect(context.reveal.moduleExpanded.has(FEATURE_A)).toBe(false);
    expect(visibleIds(context).has(METHOD_A)).toBe(false);
    expect(visibleIds(context).has(FUNCTION_B)).toBe(true);
    expect(context.highlightTargetIds).toEqual(new Set([FEATURE_A, FUNCTION_B]));
    expect(context.reveal.moduleSelected).toEqual(context.highlightTargetIds);
    expect(context.unresolvedTargetIds).toEqual(new Set());
    expectHighlightsDrawn(context);
  });

  it("locally opens a collapsed non-descendant package without changing canonical targets", () => {
    const canonical = derive([FEATURE_A, FEATURE_B]) as MinimalCodebaseContext;
    const context = applyExpansion(canonical, new Map([[FEATURE_A, true]]));

    expect(context.reveal.moduleFocus).toBe(SRC);
    expect(context.tree.nodes.find((entry) => entry.id === FEATURE_A)).toMatchObject({
      isContainer: true,
      isExpanded: true,
    });
    expect(visibleIds(context).has(FILE_A)).toBe(true);
    expect(context.highlightTargetIds).toEqual(new Set([FEATURE_A, FEATURE_B]));
    expect(context.unresolvedTargetIds).toEqual(new Set());
    expectHighlightsDrawn(context);
  });
});
