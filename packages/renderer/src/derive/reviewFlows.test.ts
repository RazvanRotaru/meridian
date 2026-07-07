/**
 * Affected-flow ranking: a flow qualifies as "changed" (root in an affected file) or "calls-into"
 * (a resolved call reaches an affected file) or both; changed sorts first; step/branch counts and
 * touched modules are derived from the flow tree; affected files no flow touches become notCovered.
 */

import { describe, expect, it } from "vitest";
import type { FlowStep, GraphArtifact, GraphNode, LogicFlows } from "@meridian/core";
import { buildGraphIndex } from "../graph/graphIndex";
import { reviewFlows } from "./reviewFlows";

function node(id: string, kind: string, file: string, parentId: string | null = null): GraphNode {
  return { id, kind, qualifiedName: id, displayName: id, parentId, location: { file, startLine: 1 } } as GraphNode;
}

function call(target: string | null): FlowStep {
  return { kind: "call", label: target ?? "anon", target, resolution: target ? "resolved" : "unresolved" };
}

function indexOf(nodes: GraphNode[]) {
  return buildGraphIndex({ nodes, edges: [] } as unknown as GraphArtifact);
}

const GRAPH = [
  node("m:svc", "module", "src/svc.ts"),
  node("m:svc#compute", "function", "src/svc.ts", "m:svc"),
  node("m:util", "module", "src/util.ts"),
  node("m:util#help", "function", "src/util.ts", "m:util"),
  node("m:api", "module", "src/api.ts"),
  node("m:api#handler", "function", "src/api.ts", "m:api"),
];

const FLOWS: LogicFlows = {
  "m:svc#compute": [call("m:util#help")],
  "m:api#handler": [
    call("m:svc#compute"),
    { kind: "branch", label: "if", paths: [{ label: "then", body: [call("m:util#help")] }, { label: "else", body: [call(null)] }] },
    { kind: "loop", label: "for", body: [call("m:util#help")] },
  ],
};

describe("reviewFlows", () => {
  it("qualifies a changed flow and a calls-into flow, changed first", () => {
    const result = reviewFlows(FLOWS, indexOf(GRAPH), new Set(["m:svc", "m:svc#compute"]), ["src/svc.ts"]);
    expect(result.flows.map((flow) => flow.rootId)).toEqual(["m:svc#compute", "m:api#handler"]);
    expect(result.notCovered).toEqual([]);
  });

  it("labels the changed flow and its touched module without a calls-into badge", () => {
    const [changed] = reviewFlows(FLOWS, indexOf(GRAPH), new Set(["m:svc", "m:svc#compute"]), ["src/svc.ts"]).flows;
    expect(changed.reasons).toEqual(["changed"]);
    expect(changed.callsIntoFiles).toEqual([]);
    expect(changed.touchedModuleIds).toEqual(["m:svc"]);
    expect(changed).toMatchObject({ stepCount: 1, branchCount: 0 });
  });

  it("counts steps/branches recursively and touches the callee's module for a calls-into flow", () => {
    const result = reviewFlows(FLOWS, indexOf(GRAPH), new Set(["m:svc", "m:svc#compute"]), ["src/svc.ts"]);
    const handler = result.flows.find((flow) => flow.rootId === "m:api#handler");
    expect(handler).toMatchObject({ reasons: ["calls-into"], callsIntoFiles: ["src/svc.ts"], stepCount: 6, branchCount: 1 });
    expect(handler?.touchedModuleIds).toEqual(["m:api", "m:svc"]);
  });

  it("marks both reasons when a changed flow also calls into another affected file", () => {
    const nodes = [
      node("m:orders", "module", "src/orders.ts"),
      node("m:orders#place", "function", "src/orders.ts", "m:orders"),
      node("m:svc", "module", "src/svc.ts"),
      node("m:svc#compute", "function", "src/svc.ts", "m:svc"),
    ];
    const flows: LogicFlows = { "m:orders#place": [call("m:svc#compute")] };
    const affected = new Set(["m:orders", "m:orders#place", "m:svc", "m:svc#compute"]);
    const [flow] = reviewFlows(flows, indexOf(nodes), affected, ["src/orders.ts", "src/svc.ts"]).flows;
    expect(flow.reasons).toEqual(["changed", "calls-into"]);
    expect(flow.callsIntoFiles).toEqual(["src/svc.ts"]);
  });

  it("reports affected files with no qualifying flow, with a reason per file", () => {
    const nodes = [
      node("m:types", "module", "src/types.ts"),
      node("m:orphan", "module", "src/orphan.ts"),
      node("m:orphan#f", "function", "src/orphan.ts", "m:orphan"),
    ];
    const affected = new Set(["m:types", "m:orphan", "m:orphan#f"]);
    const result = reviewFlows({}, indexOf(nodes), affected, ["src/types.ts", "src/orphan.ts"]);
    expect(result.flows).toEqual([]);
    expect(result.notCovered).toEqual([
      { file: "src/orphan.ts", reason: "Not defined or reached by any charted flow" },
      { file: "src/types.ts", reason: "No callable code in this file" },
    ]);
  });
});
