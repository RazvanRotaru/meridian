import { describe, expect, it } from "vitest";
import type { GraphArtifact, GraphNode, LogicFlows } from "@meridian/core";
import { buildGraphIndex } from "../graph/graphIndex";
import { buildFlowTree } from "./flowTree";

function node(id: string, kind: string, parentId: string | null, displayName: string): GraphNode {
  return { id, kind, qualifiedName: id, displayName, parentId, location: { file: id, startLine: 1 } } as GraphNode;
}

function fixture() {
  const nodes = [
    node("ts:pkg", "package", null, "pkg"),
    node("ts:pkg/src", "package", "ts:pkg", "src"),
    node("ts:pkg/docs", "package", "ts:pkg", "docs"),
    node("ts:pkg/src/service.ts", "module", "ts:pkg/src", "service.ts"),
    node("ts:pkg/src/service.ts#Service", "class", "ts:pkg/src/service.ts", "Service"),
    node("ts:pkg/src/service.ts#Service.run", "method", "ts:pkg/src/service.ts#Service", "run"),
    node("ts:pkg/src/service.ts#Service.save", "method", "ts:pkg/src/service.ts#Service", "save"),
    node("ts:pkg/src/util.ts", "module", "ts:pkg/src", "util.ts"),
    node("ts:pkg/src/util.ts#helper", "function", "ts:pkg/src/util.ts", "helper"),
    node("ts:pkg/src/empty.ts", "module", "ts:pkg/src", "empty.ts"),
  ];
  const flows: LogicFlows = {
    "ts:pkg/src/util.ts#helper": [],
    "ts:pkg/src/service.ts#Service.save": [],
    "ts:pkg/src/service.ts": [],
    "ts:pkg/src/service.ts#Service.run": [],
  };
  const index = buildGraphIndex({ nodes, edges: [] } as unknown as GraphArtifact);
  return { index, flows };
}

describe("buildFlowTree", () => {
  it("groups callable roots under their module and class containment chain", () => {
    const { index, flows } = fixture();
    const service = buildFlowTree(index, flows)[0].children[0];
    expect(service).toMatchObject({ kind: "module", label: "service.ts" });
    expect(service.children[0]).toMatchObject({ kind: "class", label: "Service" });
    expect(service.children[0].children.map((entry) => entry.kind)).toEqual(["callable", "callable"]);
  });

  it("prunes subtrees with no flow-bearing descendant", () => {
    const { index, flows } = fixture();
    const labels = JSON.stringify(buildFlowTree(index, flows));
    expect(labels).not.toContain("docs");
    expect(labels).not.toContain("empty.ts");
  });

  it("collapses single-child container chains into a joined label", () => {
    const { index, flows } = fixture();
    const tree = buildFlowTree(index, flows);
    expect(tree).toHaveLength(1);
    expect(tree[0]).toMatchObject({ kind: "container", label: "pkg/src" });
  });

  it("marks a module entry when the module itself has a flow", () => {
    const { index, flows } = fixture();
    const service = buildFlowTree(index, flows)[0].children[0];
    expect(service.flowRootId).toBe("ts:pkg/src/service.ts");
  });

  it("keeps source order rather than flow object order", () => {
    const { index, flows } = fixture();
    const root = buildFlowTree(index, flows)[0];
    expect(root.children.map((entry) => entry.label)).toEqual(["service.ts", "util.ts"]);
    expect(root.children[0].children[0].children.map((entry) => entry.label)).toEqual(["run", "save"]);
  });
});
