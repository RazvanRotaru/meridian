import { describe, expect, it } from "vitest";
import type { Edge, Node } from "@xyflow/react";
import { minimalGraphConnectorIds } from "./minimalGraphConnectors";

const node = (id: string, type = "package", parentId: string | undefined = "ts:src"): Node => ({
  id,
  type,
  parentId,
  position: { x: 0, y: 0 },
  data: { semanticDepth: 0 },
});
const edge = (source: string, target: string, data: Record<string, unknown> = {}): Edge => ({
  id: `${source}->${target}`,
  source,
  target,
  data,
});

describe("minimalGraphConnectorIds", () => {
  it("retains a same-level bridge independently of selection order", () => {
    const nodes = ["api", "services", "repository", "index", "domain"].map((id) => node(id));
    const edges = [
      edge("api", "services"),
      edge("services", "repository"),
    ];

    expect(minimalGraphConnectorIds(nodes, edges, new Set(["api", "repository"])))
      .toEqual(new Set(["services"]));
    expect(minimalGraphConnectorIds(nodes, edges, new Set(["repository", "api"])))
      .toEqual(new Set(["services"]));
  });

  it("keeps the strongest shortest shared caller when the selected cards are siblings", () => {
    const nodes = ["notifications", "pricing", "services", "index", "domain"].map((id) => node(id));
    const edges = [
      // The meaningful service bridge carries two semantic strands per leg.
      edge("services", "notifications", { weight: 1, relationKind: "calls" }),
      edge("services", "notifications", { weight: 1, relationKind: "references" }),
      edge("services", "pricing", { weight: 1, relationKind: "calls" }),
      edge("services", "pricing", { weight: 1, relationKind: "references" }),
      // These are equally short, but single-kind common dependency/caller alternatives.
      edge("notifications", "domain", { weight: 3, relationKind: "references" }),
      edge("pricing", "domain", { weight: 3, relationKind: "references" }),
      edge("index", "notifications", { weight: 1, relationKind: "instantiates" }),
      edge("index", "pricing", { weight: 1, relationKind: "instantiates" }),
    ];

    expect(minimalGraphConnectorIds(nodes, edges, new Set(["notifications", "pricing"])))
      .toEqual(new Set(["services"]));
  });

  it("stays inside the selected cards' abstraction and ignores ghost/presentation edges", () => {
    const nodes = [
      node("api"),
      node("repository"),
      node("method", "block", "services.ts"),
      { ...node("ghost"), type: "ghost" },
    ];
    const edges = [
      edge("api", "method"),
      edge("method", "repository"),
      edge("api", "ghost"),
      edge("ghost", "repository"),
      edge("api", "repository", { presentationOnly: true }),
    ];

    expect(minimalGraphConnectorIds(nodes, edges, new Set(["api", "repository"]))).toEqual(new Set());
  });

  it("returns no connector when every selection is not drawable at one source abstraction", () => {
    expect(minimalGraphConnectorIds([node("api")], [], new Set(["api", "missing"]))).toEqual(new Set());
  });
});
