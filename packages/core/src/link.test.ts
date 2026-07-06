import { describe, expect, it } from "vitest";
import { linkArtifacts, type LinkSource } from "./link";
import type { Port } from "./ports";
import type { GraphNode } from "./types";

function node(id: string, kind: string, parentId: string | null = null): GraphNode {
  return { id, kind, qualifiedName: id, displayName: id, parentId, location: { file: "src/index.ts", startLine: 1 } };
}

function port(nodeId: string, direction: "in" | "out", protocol: string, channel: string | null): Port {
  return { nodeId, direction, protocol, channel, label: channel ?? "(dynamic)", callSite: { file: "src/index.ts", line: 1 } };
}

// Two repos with COLLIDING module paths: web fetches what api serves.
const WEB: LinkSource = {
  name: "checkout-web",
  nodes: [node("ts:src", "package"), node("ts:src/index.ts", "module", "ts:src"), node("ts:src/index.ts#load", "function", "ts:src/index.ts")],
  edges: [],
  ports: [port("ts:src/index.ts#load", "out", "http", "GET /api/orders/123")],
};
const API: LinkSource = {
  name: "orders-api",
  nodes: [node("ts:src", "package"), node("ts:src/index.ts", "module", "ts:src"), node("ts:src/index.ts#route", "function", "ts:src/index.ts")],
  edges: [],
  ports: [
    port("ts:src/index.ts#route", "in", "http", "GET /api/orders/:id"),
    port("ts:src/index.ts#route", "in", "http", "DELETE /api/orders/:id"), // dangling entry
  ],
};

describe("linkArtifacts", () => {
  const linked = linkArtifacts([WEB, API]);

  it("namespaces colliding ids and nests each source under its system frame", () => {
    const ids = new Set(linked.nodes.map((entry) => entry.id));
    expect(ids.has("ts:checkout-web/src/index.ts#load")).toBe(true);
    expect(ids.has("ts:orders-api/src/index.ts#route")).toBe(true);
    expect(ids.has("ts:src/index.ts#load")).toBe(false); // the raw id must not survive
    const webRoot = linked.nodes.find((entry) => entry.id === "ts:checkout-web/src");
    expect(webRoot?.parentId).toBe("sys:checkout-web");
    expect(linked.nodes.filter((entry) => entry.kind === "system")).toHaveLength(2);
  });

  it("joins the concrete HTTP exit onto the entry's route template through ONE channel", () => {
    const channel = linked.nodes.find((entry) => entry.kind === "channel" && entry.displayName === "GET /api/orders/:id");
    expect(channel).toBeTruthy();
    expect(linked.edges).toContainEqual(
      expect.objectContaining({ kind: "sends", source: "ts:checkout-web/src/index.ts#load", target: channel!.id }),
    );
    expect(linked.edges).toContainEqual(
      expect.objectContaining({ kind: "handles", source: channel!.id, target: "ts:orders-api/src/index.ts#route" }),
    );
    expect(linked.stats.httpTemplateJoins).toBe(1);
    expect(linked.stats.crossSystemChannels).toBe(1);
  });

  it("keeps the unmatched entry as a dangling channel", () => {
    const dangling = linked.nodes.find((entry) => entry.kind === "channel" && entry.displayName === "DELETE /api/orders/:id");
    expect(dangling).toBeTruthy();
    expect(linked.stats.danglingChannels).toBe(1);
  });

  it("strips per-artifact channels and rebuilds them once over the merged ports", () => {
    // Pre-materialized channel + sends edge in a source must not survive as a duplicate.
    const preChanneled: LinkSource = {
      ...WEB,
      nodes: [...WEB.nodes, node("ipc:http/GET+/api/orders/123", "channel")],
      edges: [
        {
          id: "sends@ts:src/index.ts#load|ipc:http/GET+/api/orders/123",
          source: "ts:src/index.ts#load",
          target: "ipc:http/GET+/api/orders/123",
          kind: "sends",
          resolution: "resolved",
        },
      ],
    };
    const relinked = linkArtifacts([preChanneled, API]);
    const concreteChannel = relinked.nodes.filter((entry) => entry.id === "ipc:http/GET+/api/orders/123");
    expect(concreteChannel).toHaveLength(0); // rebuilt onto the template key instead
    expect(relinked.edges.filter((edge) => edge.kind === "sends")).toHaveLength(1);
  });
});
