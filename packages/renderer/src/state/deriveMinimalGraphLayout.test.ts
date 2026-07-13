import type { GraphArtifact } from "@meridian/core";
import { describe, expect, it } from "vitest";
import type { MinimalRollupExpansion } from "../derive/minimalRollupExpansion";
import type { MinimalSubgraphSpec } from "../derive/minimalSubgraph";
import { buildGraphIndex } from "../graph/graphIndex";
import {
  filterMinimalRollupExpansions,
  filterMinimalSubgraph,
  reviewDiffVisibleIds,
} from "./deriveMinimalGraphLayout";

const PACKAGE_ID = "ts:src";
const FILE_ID = "ts:src/a.ts";
const OTHER_FILE_ID = "ts:src/b.ts";
const CLASS_ID = `${FILE_ID}#Service`;
const CHANGED_ID = `${CLASS_ID}.changed`;
const UNCHANGED_ID = `${CLASS_ID}.unchanged`;
const GHOST_ID = "ts:src/context.ts#helper";

const ARTIFACT = {
  schemaVersion: "1.0.0",
  generatedAt: "2026-07-13T00:00:00.000Z",
  generator: { name: "test", version: "0" },
  target: { name: "fixture", root: ".", language: "typescript" },
  nodes: [
    graphNode(PACKAGE_ID, "package", "src"),
    graphNode(FILE_ID, "module", "src/a.ts", PACKAGE_ID),
    graphNode(OTHER_FILE_ID, "module", "src/b.ts", PACKAGE_ID),
    graphNode(CLASS_ID, "class", "src/a.ts", FILE_ID),
    graphNode(CHANGED_ID, "method", "src/a.ts", CLASS_ID),
    graphNode(UNCHANGED_ID, "method", "src/a.ts", CLASS_ID),
    graphNode(GHOST_ID, "function", "src/context.ts"),
  ],
  edges: [],
} satisfies GraphArtifact;

describe("PR diff-only minimal graph projection", () => {
  it("keeps exact diff nodes and every structural ancestor", () => {
    const index = buildGraphIndex(ARTIFACT);

    expect(reviewDiffVisibleIds(index, new Set([CHANGED_ID]))).toEqual(new Set([
      PACKAGE_ID,
      FILE_ID,
      CLASS_ID,
      CHANGED_ID,
    ]));
  });

  it("drops unchanged siblings, ghosts, and every edge incident to them before layout", () => {
    const visible = reviewDiffVisibleIds(buildGraphIndex(ARTIFACT), new Set([CHANGED_ID]));
    const spec = {
      nodes: [PACKAGE_ID, FILE_ID, CLASS_ID, CHANGED_ID, UNCHANGED_ID, GHOST_ID].map((id) => ({
        id,
        kind: id === GHOST_ID ? "ghost" : id === FILE_ID ? "file" : "group",
        parentId: null,
        tier: id === FILE_ID ? "seed" : null,
        data: {},
      })),
      edges: [
        edge("kept", FILE_ID, CHANGED_ID),
        edge("sibling", CHANGED_ID, UNCHANGED_ID),
        edge("ghost", CHANGED_ID, GHOST_ID),
      ],
      expansions: [{
        fileId: FILE_ID,
        nodes: [FILE_ID, CLASS_ID, CHANGED_ID, UNCHANGED_ID].map((id) => visibleNode(id)),
        edges: [
          treeEdge("parent", FILE_ID, CLASS_ID),
          treeEdge("changed", CLASS_ID, CHANGED_ID),
          treeEdge("unchanged", CLASS_ID, UNCHANGED_ID),
        ],
      }],
    } as unknown as MinimalSubgraphSpec;

    const filtered = filterMinimalSubgraph(spec, visible);

    expect(filtered.nodes.map((node) => node.id)).toEqual([PACKAGE_ID, FILE_ID, CLASS_ID, CHANGED_ID]);
    expect(filtered.edges.map((edge) => edge.id)).toEqual(["kept"]);
    expect(filtered.expansions[0].nodes.map((node) => node.id)).toEqual([FILE_ID, CLASS_ID, CHANGED_ID]);
    expect(filtered.expansions[0].edges.map((edge) => edge.id)).toEqual(["parent", "changed"]);
    expect(spec.nodes).toHaveLength(6);
  });

  it("prunes an opened package rollup to its changed-file frontier", () => {
    const visible = reviewDiffVisibleIds(buildGraphIndex(ARTIFACT), new Set([CHANGED_ID]));
    const expansion = {
      rootId: PACKAGE_ID,
      frontierIds: [FILE_ID, OTHER_FILE_ID],
      nodes: [
        visibleNode(PACKAGE_ID, null),
        visibleNode(FILE_ID, PACKAGE_ID),
        visibleNode(OTHER_FILE_ID, PACKAGE_ID),
      ],
      edges: [
        treeEdge("changed-file", PACKAGE_ID, FILE_ID),
        treeEdge("context-file", PACKAGE_ID, OTHER_FILE_ID),
      ],
    } as unknown as MinimalRollupExpansion;

    const filtered = filterMinimalRollupExpansions([expansion], visible);

    expect(filtered).toHaveLength(1);
    expect(filtered[0].frontierIds).toEqual([FILE_ID]);
    expect(filtered[0].nodes.map((node) => node.id)).toEqual([PACKAGE_ID, FILE_ID]);
    expect(filtered[0].edges.map((edge) => edge.id)).toEqual(["changed-file"]);
  });
});

function graphNode(id: string, kind: string, file: string, parentId?: string) {
  return {
    id,
    kind,
    qualifiedName: id,
    displayName: id,
    parentId,
    location: { file, startLine: 1, endLine: 2 },
  };
}

function edge(id: string, source: string, target: string) {
  return {
    id,
    source,
    target,
    weight: 1,
    kind: "dep",
    crossFrame: false,
    crossPackage: false,
    outsideView: false,
  };
}

function visibleNode(id: string, parentId: string | null = null) {
  return {
    id,
    parentId,
    kind: "block",
    isContainer: false,
    isExpanded: false,
    depth: parentId === null ? 0 : 1,
    childCount: 0,
    data: {},
  };
}

function treeEdge(id: string, source: string, target: string) {
  return {
    id,
    source,
    target,
    weight: 1,
    crossFrame: false,
    crossPackage: false,
    outsideView: false,
    category: "dep",
  };
}
