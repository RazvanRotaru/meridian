/**
 * Guards that an EXAMPLE_PRS entry, fed through the real review pipeline, lands its per-file status
 * where the graph reads it: an "added" file whose `location.file` EXACTLY equals the input path gets
 * `changeStatus: "added"` on its minimal-subgraph node, and a "removed" file with no node at HEAD
 * lands in `reviewModel.removed` (not `unmatched`). Exercises the exact-path attach the picker relies on.
 */

import { describe, expect, it } from "vitest";
import type { GraphArtifact, GraphNode } from "@meridian/core";
import { buildGraphIndex } from "../graph/graphIndex";
import { buildModuleGraph } from "../derive/moduleGraph";
import { affectedNodes } from "../derive/affectedNodes";
import { buildMinimalSubgraph } from "../derive/minimalSubgraph";
import { buildReviewModel } from "../derive/reviewModel";
import { EXAMPLE_PRS, exampleAffectedInput } from "./examplePrs";

const ADDED_FILE = "shopfront/src/services/orderFactory.ts";
const REMOVED_FILE = "shopfront/src/utils/legacy.ts";

function pkg(id: string, name: string, parentId: string | null): GraphNode {
  return { id, kind: "package", qualifiedName: id, displayName: name, parentId, location: { file: name, startLine: 1 } } as GraphNode;
}
function moduleNode(id: string, file: string, parentId: string): GraphNode {
  return { id, kind: "module", qualifiedName: id, displayName: id, parentId, location: { file, startLine: 1 } } as GraphNode;
}

// A tiny graph holding ONLY the added file's module node; the removed file has NO node (deleted at HEAD).
const NODES = [
  pkg("p:root", "root", null),
  pkg("p:services", "shopfront/src/services", "p:root"),
  moduleNode("m:orderFactory", ADDED_FILE, "p:services"),
];

function index() {
  return buildGraphIndex({ nodes: NODES, edges: [] } as unknown as GraphArtifact);
}

const PR77 = EXAMPLE_PRS.find((pr) => pr.number === 77)!;

describe("EXAMPLE_PRS status attach", () => {
  it("carries the added file's changeStatus onto its minimal-subgraph node (exact-path match)", () => {
    const { statusByFile } = exampleAffectedInput(PR77);
    const idx = index();
    const seeds = affectedNodes(idx, [ADDED_FILE]).seedModuleIds;
    const spec = buildMinimalSubgraph(idx, buildModuleGraph(idx), seeds, {}, statusByFile).spec;

    const added = spec.nodes.find((node) => node.id === "m:orderFactory");
    expect(added?.kind).toBe("file");
    expect(added?.changeStatus).toBe("added");
  });

  it("routes the removed file (no node at HEAD) into reviewModel.removed, not unmatched", () => {
    const { paths, statusByFile } = exampleAffectedInput(PR77);
    const idx = index();
    const model = buildReviewModel(idx, buildModuleGraph(idx), {}, paths, statusByFile);

    expect(model.removed).toContain(REMOVED_FILE);
    expect(model.unmatched).not.toContain(REMOVED_FILE);
    expect(model.matchedFiles).toContain(ADDED_FILE);
  });
});
