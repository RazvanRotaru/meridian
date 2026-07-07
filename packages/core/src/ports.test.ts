import { describe, expect, it } from "vitest";
import type { GraphNode, GraphEdge } from "./types";
import { channelNodeId, materializeChannels, matchRouteTemplate, type Port } from "./ports";

function node(id: string, kind = "function"): GraphNode {
  return { id, kind, qualifiedName: id, displayName: id, parentId: null, location: { file: "f.ts", startLine: 1 } };
}

function port(nodeId: string, direction: "in" | "out", protocol: string, channel: string | null): Port {
  return { nodeId, direction, protocol, channel, label: channel ?? "(dynamic)", callSite: { file: "f.ts", line: 1 } };
}

describe("channelNodeId", () => {
  it("keeps the node-id grammar: no whitespace, no hash", () => {
    expect(channelNodeId("http", "GET /api/orders")).toBe("ipc:http/GET+/api/orders");
    expect(channelNodeId("electron", "notes#load")).toBe("ipc:electron/notes%23load");
  });
});

describe("materializeChannels", () => {
  const NODES = [node("ts:a#send"), node("ts:b#handle")];
  const NO_EDGES: GraphEdge[] = [];

  it("joins a matching send/handle pair through one channel node", () => {
    const { nodes, edges } = materializeChannels(NODES, NO_EDGES, [
      port("ts:a#send", "out", "electron", "notes:load"),
      port("ts:b#handle", "in", "electron", "notes:load"),
    ]);
    const channel = nodes.find((entry) => entry.kind === "channel");
    expect(channel?.id).toBe("ipc:electron/notes:load");
    expect(edges).toContainEqual(expect.objectContaining({ kind: "sends", source: "ts:a#send", target: channel!.id }));
    expect(edges).toContainEqual(expect.objectContaining({ kind: "handles", source: channel!.id, target: "ts:b#handle" }));
  });

  it("keeps a one-ended channel dangling (the finding), and skips dynamic ports", () => {
    const { nodes, edges } = materializeChannels(NODES, NO_EDGES, [
      port("ts:a#send", "out", "electron", "unheard:channel"),
      port("ts:a#send", "out", "electron", null), // dynamic — never guessed
    ]);
    expect(nodes.filter((entry) => entry.kind === "channel")).toHaveLength(1);
    expect(edges).toHaveLength(1);
  });

  it("aggregates repeated call sites into one weighted edge", () => {
    const { edges } = materializeChannels(NODES, NO_EDGES, [
      port("ts:a#send", "out", "electron", "notes:load"),
      port("ts:a#send", "out", "electron", "notes:load"),
    ]);
    expect(edges).toHaveLength(1);
    expect(edges[0].weight).toBe(2);
    expect(edges[0].callSites).toHaveLength(2);
  });
});

describe("matchRouteTemplate", () => {
  const TEMPLATES = ["/api/orders", "/api/orders/:id", "/api/orders/:id/items", "/health"];

  it("matches concrete paths onto templates, preferring the most specific", () => {
    expect(matchRouteTemplate("/api/orders/123", TEMPLATES)).toBe("/api/orders/:id");
    expect(matchRouteTemplate("/api/orders", TEMPLATES)).toBe("/api/orders");
    expect(matchRouteTemplate("/api/orders/9/items", TEMPLATES)).toBe("/api/orders/:id/items");
  });

  it("returns null for no match and for an ambiguous tie", () => {
    expect(matchRouteTemplate("/nope", TEMPLATES)).toBeNull();
    expect(matchRouteTemplate("/a/b", ["/a/:x", "/:y/b"])).toBeNull(); // equal specificity — honest
  });
});
