/**
 * End-to-end coherence for the composed review model: matched vs unmatched paths, changed-first
 * flows, and a minimal subgraph whose kept/boundary ids line up with the affected file and its
 * 1-hop import neighbors.
 */

import { describe, expect, it } from "vitest";
import type { GraphArtifact, GraphEdge, GraphNode, LogicFlows } from "@meridian/core";
import { buildGraphIndex } from "../graph/graphIndex";
import { buildModuleGraph } from "./moduleGraph";
import { buildReviewModel } from "./reviewModel";

function pkg(id: string, name: string, parentId: string | null): GraphNode {
  return { id, kind: "package", qualifiedName: id, displayName: name, parentId, location: { file: name, startLine: 1 } } as GraphNode;
}

function node(id: string, kind: string, file: string, parentId: string): GraphNode {
  return { id, kind, qualifiedName: id, displayName: id, parentId, location: { file, startLine: 1 } } as GraphNode;
}

function importEdge(source: string, target: string): GraphEdge {
  return { id: `imports:${source}->${target}`, source, target, kind: "imports", resolution: "resolved" } as GraphEdge;
}

const NODES = [
  pkg("p:root", "root", null),
  pkg("p:src", "src", "p:root"),
  node("m:svc", "module", "src/svc.ts", "p:src"),
  node("m:svc#compute", "function", "src/svc.ts", "m:svc"),
  node("m:api", "module", "src/api.ts", "p:src"),
  node("m:api#handler", "function", "src/api.ts", "m:api"),
  node("m:util", "module", "src/util.ts", "p:src"),
  node("m:util#help", "function", "src/util.ts", "m:util"),
];
const EDGES = [importEdge("m:api", "m:svc"), importEdge("m:svc", "m:util")];
const FLOWS: LogicFlows = {
  "m:api#handler": [{ kind: "call", label: "compute", target: "m:svc#compute", resolution: "resolved" }],
  "m:svc#compute": [{ kind: "call", label: "help", target: "m:util#help", resolution: "resolved" }],
};

function model(affectedFiles: string[], options = {}) {
  const index = buildGraphIndex({ nodes: NODES, edges: EDGES } as unknown as GraphArtifact);
  return buildReviewModel(index, buildModuleGraph(index), FLOWS, affectedFiles, options);
}

describe("buildReviewModel", () => {
  it("resolves matched files, keeps the unmatched, and ranks flows changed-first", () => {
    const result = model(["src/svc.ts", "does/not/exist.ts"]);
    expect(result.matchedFiles).toEqual(["src/svc.ts"]);
    expect(result.unmatched).toEqual(["does/not/exist.ts"]);
    expect(result.ambiguous).toEqual([]);
    expect(result.flows.map((flow) => flow.rootId)).toEqual(["m:svc#compute", "m:api#handler"]);
    expect(result.notCovered).toEqual([]);
  });

  it("keeps the affected subtree plus both-direction boundary neighbors", () => {
    const result = model(["src/svc.ts"]);
    expect(result.keptNodeIds).toEqual(["m:api", "m:svc", "m:util", "p:root", "p:src"]);
    expect(result.boundaryNodeIds).toEqual(["m:api", "m:util"]);
  });

  it("drops the boundary when includeBoundary is false", () => {
    const result = model(["src/svc.ts"], { includeBoundary: false });
    expect(result.boundaryNodeIds).toEqual([]);
    expect(result.keptNodeIds).toEqual(["m:svc", "p:root", "p:src"]);
  });
});
