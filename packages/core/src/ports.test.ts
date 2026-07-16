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
    expect(channelNodeId("http", "GET /api/orders")).toBe("ipc:http/channel=GET%20%2Fapi%2Forders");
    expect(channelNodeId("electron", "notes#load")).toBe("ipc:electron/channel=notes%23load");
    expect(channelNodeId("electron", "notes#load", "renderer main", "app#1"))
      .toBe("ipc:electron/lane=renderer%20main/scope=app%231/channel=notes%23load");
  });

  it("encodes qualified components injectively", () => {
    expect(channelNodeId("electron", "ready", "frame")).not.toBe(
      channelNodeId("electron", "ready", undefined, "frame"),
    );
    expect(channelNodeId("electron", "b/c", "a")).not.toBe(
      channelNodeId("electron", "c", "a/b"),
    );
    expect(channelNodeId("electron", "a+b", "lane")).not.toBe(
      channelNodeId("electron", "a b", "lane"),
    );
    expect(channelNodeId("electron", "a+b")).not.toBe(
      channelNodeId("electron", "a b"),
    );
    expect(channelNodeId("electron", "a%23b")).not.toBe(
      channelNodeId("electron", "a#b"),
    );
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
    expect(channel?.id).toBe("ipc:electron/channel=notes%3Aload");
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

  it("keeps incompatible transport lanes separate", () => {
    const { nodes, edges } = materializeChannels(NODES, NO_EDGES, [
      { ...port("ts:a#send", "out", "electron", "notes:load"), lane: "renderer-main-invoke" },
      { ...port("ts:b#handle", "in", "electron", "notes:load"), lane: "main-renderer-message" },
    ]);
    expect(nodes.filter((entry) => entry.kind === "channel")).toHaveLength(2);
    expect(edges).toHaveLength(2);
  });

  it("marks selector-only correlations as candidates and enters a resolved handler", () => {
    const nodes = [...NODES, node("ts:b#register")];
    const { nodes: materializedNodes, edges } = materializeChannels(nodes, NO_EDGES, [
      { ...port("ts:a#send", "out", "postmessage", "type:ready"), confidence: 0.65 },
      {
        ...port("ts:b#register", "in", "postmessage", "type:ready"),
        confidence: 0.65,
        handlerNodeId: "ts:b#handle",
      },
    ]);
    const channel = materializedNodes.find((entry) => entry.kind === "channel");
    expect(channel?.tags).toContain("candidate");
    expect(edges).toContainEqual(expect.objectContaining({
      kind: "handles",
      target: "ts:b#handle",
      resolution: "unresolved",
      confidence: 0.65,
    }));
  });

  it("derives candidate channel metadata independently of port order", () => {
    const approximate = {
      ...port("ts:a#send", "out" as const, "electron", "notes:changed"),
      lane: "main-renderer-message",
      confidence: 0.6,
    };
    const exact = {
      ...port("ts:b#handle", "in" as const, "electron", "notes:changed"),
      lane: "main-renderer-message",
    };
    const channelOf = (ports: Port[]) => materializeChannels(NODES, NO_EDGES, ports).nodes
      .find((entry) => entry.kind === "channel");

    expect(channelOf([approximate, exact])).toEqual(channelOf([exact, approximate]));
    expect(channelOf([exact, approximate])).toMatchObject({
      tags: expect.arrayContaining(["candidate"]),
      summary: expect.stringContaining("60% confidence"),
    });
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
