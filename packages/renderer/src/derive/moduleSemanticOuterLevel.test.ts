import type { GraphArtifact, GraphNode } from "@meridian/core";
import { describe, expect, it } from "vitest";
import { buildGraphIndex } from "../graph/graphIndex";
import { semanticAncestorLevels, semanticOuterLevel } from "./moduleSemanticComposite";

function graphNode(id: string, kind: string, parentId: string | null, displayName = id, tags?: string[]): GraphNode {
  return {
    id,
    kind,
    parentId,
    displayName,
    qualifiedName: id,
    tags,
    location: { file: "fixture.ts", startLine: 1 },
  } as GraphNode;
}

function indexOf(nodes: GraphNode[]) {
  return buildGraphIndex({ nodes, edges: [] } as unknown as GraphArtifact);
}

describe("semanticOuterLevel", () => {
  const index = indexOf([
    graphNode("ts:packages", "package", null, "packages"),
    graphNode("ts:autopilot-vscode", "package", "ts:packages", "autopilot-vscode", ["npm-package"]),
    graphNode("ts:autopilot-vscode/src", "package", "ts:autopilot-vscode", "src"),
    graphNode("ts:autopilot-vscode/src/host", "package", "ts:autopilot-vscode/src", "host"),
    graphNode("ts:autopilot-vscode/src/shared", "package", "ts:autopilot-vscode/src", "shared"),
    graphNode("ts:autopilot-vscode/src/host/index.ts", "module", "ts:autopilot-vscode/src/host", "index.ts"),
    graphNode("ts:other", "package", "ts:packages", "other", ["npm-package"]),
    graphNode("ts:other/src", "package", "ts:other", "src"),
    graphNode("ts:other/src/index.ts", "module", "ts:other/src", "index.ts"),
  ]);

  it("anchors an Autopilot lone-src collapse to the raw npm package in the repository graph", () => {
    expect(semanticOuterLevel(index, "ts:autopilot-vscode", "ts:autopilot-vscode/src")).toEqual({
      focus: null,
      anchorId: "ts:autopilot-vscode",
    });
  });

  it("moves a nested directory to its containing level and preserves that directory as anchor", () => {
    expect(semanticOuterLevel(index, "ts:autopilot-vscode/src/host", "ts:autopilot-vscode/src/host")).toEqual({
      focus: "ts:autopilot-vscode/src",
      anchorId: "ts:autopilot-vscode/src/host",
    });
  });

  it("moves a focused file back to its containing directory", () => {
    expect(
      semanticOuterLevel(
        index,
        "ts:autopilot-vscode/src/host/index.ts",
        "ts:autopilot-vscode/src/host/index.ts",
      ),
    ).toEqual({ focus: "ts:autopilot-vscode/src/host", anchorId: "ts:autopilot-vscode/src/host/index.ts" });
  });

  it("has no outer transition at the repository root", () => {
    expect(semanticOuterLevel(index, null, null)).toBeNull();
  });

  it("uses the topmost package as the overview node in a package-less artifact", () => {
    const single = indexOf([
      graphNode("ts:src", "package", null, "src"),
      graphNode("ts:src/a.ts", "module", "ts:src", "a.ts"),
      graphNode("ts:src/b.ts", "module", "ts:src", "b.ts"),
    ]);
    expect(semanticOuterLevel(single, "ts:src", "ts:src")).toEqual({ focus: null, anchorId: "ts:src" });
  });

  it("resolves every successive ancestor transition with stable depths and labels", () => {
    expect(
      semanticAncestorLevels(
        index,
        "ts:autopilot-vscode/src/host/index.ts",
        "ts:autopilot-vscode/src/host/index.ts",
      ),
    ).toEqual([
      {
        depth: 1,
        focus: "ts:autopilot-vscode/src/host",
        effectiveFocus: "ts:autopilot-vscode/src/host",
        anchorId: "ts:autopilot-vscode/src/host/index.ts",
        label: "index.ts",
      },
      {
        depth: 2,
        focus: "ts:autopilot-vscode/src",
        effectiveFocus: "ts:autopilot-vscode/src",
        anchorId: "ts:autopilot-vscode/src/host",
        label: "host",
      },
      {
        depth: 3,
        focus: "ts:packages",
        effectiveFocus: "ts:packages",
        anchorId: "ts:autopilot-vscode",
        label: "autopilot-vscode",
      },
      {
        depth: 4,
        focus: null,
        effectiveFocus: null,
        anchorId: "ts:packages",
        label: "packages",
      },
    ]);
  });
});
