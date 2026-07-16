import { describe, expect, it } from "vitest";
import { EXTERNAL_CONTAINER_ID, externalTargetId, materializeBoundaryNodes } from "./boundary";
import { linkArtifacts, type LinkSource } from "./link";
import type { Port } from "./ports";
import type { GraphEdge, GraphNode } from "./types";

function node(id: string, kind: string, parentId: string | null = null): GraphNode {
  return { id, kind, qualifiedName: id, displayName: id, parentId, location: { file: "src/index.ts", startLine: 1 } };
}

function port(nodeId: string, direction: "in" | "out", protocol: string, channel: string | null): Port {
  return { nodeId, direction, protocol, channel, label: channel ?? "(dynamic)", callSite: { file: "src/index.ts", line: 1 } };
}

function boundarySource(name: string, sourceId: string, target: string): LinkSource {
  const edge: GraphEdge = {
    id: `calls@${sourceId}|${target}`,
    source: sourceId,
    target,
    kind: "calls",
    resolution: "external",
  };
  return {
    name,
    nodes: materializeBoundaryNodes([node(sourceId, "function")], [edge]),
    edges: [edge],
    ports: [],
  };
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

  it("namespaces edge evidence files with the same system prefix as node locations", () => {
    const evidenceEdge: GraphEdge = {
      id: "calls@ts:src/index.ts#load|ts:src/index.ts#helper",
      source: "ts:src/index.ts#load",
      target: "ts:src/index.ts#helper",
      kind: "calls",
      weight: 1,
      callSites: [{ file: "src/index.ts", line: 8, col: 2, endLine: 8, endCol: 19 }],
    };
    const linkedEvidence = linkArtifacts([{
      ...WEB,
      nodes: [...WEB.nodes, node("ts:src/index.ts#helper", "function", "ts:src/index.ts")],
      edges: [evidenceEdge],
    }]);
    expect(linkedEvidence.edges[0]?.callSites).toEqual([
      { file: "checkout-web/src/index.ts", line: 8, col: 2, endLine: 8, endCol: 19 },
    ]);
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

  it("never template-joins HTTP ports across different or unknown endpoint scopes", () => {
    const scopedWeb: LinkSource = {
      ...WEB,
      ports: [
        { ...WEB.ports[0], scope: "origin:https://one.example" },
        { ...WEB.ports[0], scope: "origin:https://two.example" },
      ],
    };
    const relinked = linkArtifacts([scopedWeb, API]);

    expect(relinked.stats.httpTemplateJoins).toBe(0);
    expect(relinked.stats.crossSystemChannels).toBe(0);
    expect(relinked.nodes.filter((entry) =>
      entry.kind === "channel" && entry.displayName === "GET /api/orders/123",
    )).toHaveLength(2);
    expect(relinked.nodes.find((entry) =>
      entry.kind === "channel" && entry.displayName === "GET /api/orders/:id",
    )).toBeTruthy();
  });

  it("template-joins HTTP ports when their endpoint scopes are proven equal", () => {
    const scope = "origin:https://api.example";
    const scopedWeb: LinkSource = { ...WEB, ports: WEB.ports.map((entry) => ({ ...entry, scope })) };
    const scopedApi: LinkSource = { ...API, ports: API.ports.map((entry) => ({ ...entry, scope })) };
    const relinked = linkArtifacts([scopedWeb, scopedApi]);

    expect(relinked.stats.httpTemplateJoins).toBe(1);
    expect(relinked.stats.crossSystemChannels).toBe(1);
  });

  it("namespaces artifact-local client instances before considering channel identity", () => {
    const localScope = "factory:axios.instance@src/client.ts:1:1";
    const first: LinkSource = {
      ...WEB,
      name: "web-a",
      ports: WEB.ports.map((entry) => ({ ...entry, scope: localScope, scopeKind: "artifact" })),
    };
    const second: LinkSource = {
      ...WEB,
      name: "web-b",
      ports: WEB.ports.map((entry) => ({ ...entry, scope: localScope, scopeKind: "artifact" })),
    };
    const relinked = linkArtifacts([first, second]);

    expect(new Set(relinked.ports.map((entry) => entry.scope))).toEqual(new Set([
      `artifact:web-a/${localScope}`,
      `artifact:web-b/${localScope}`,
    ]));
    expect(relinked.nodes.filter((entry) =>
      entry.kind === "channel" && entry.displayName === "GET /api/orders/123",
    )).toHaveLength(2);
  });

  it("merges each source's logic flows and entry modules, namespacing keys and call targets", () => {
    const withFlows: LinkSource = {
      ...WEB,
      logicFlow: {
        "ts:src/index.ts#load": [
          { kind: "call", label: "helper()", target: "ts:src/index.ts#helper", resolution: "resolved" },
          { kind: "call", label: "fetch()", target: "ext:npm/node-fetch", resolution: "external" },
          { kind: "loop", label: "for", body: [{ kind: "call", label: "log()", target: null, resolution: "unresolved" }] },
          { kind: "branch", label: "if bad", paths: [{ label: "then", body: [{ kind: "exit", variant: "throw", label: "boom" }] }] },
          { kind: "exit", variant: "return", label: null },
        ],
      },
      entryModules: ["ts:src/index.ts"],
    };
    const relinked = linkArtifacts([withFlows, API]);

    // The record key is namespaced onto the system-prefixed id...
    expect(Object.keys(relinked.logicFlow)).toContain("ts:checkout-web/src/index.ts#load");
    expect(relinked.logicFlow["ts:src/index.ts#load"]).toBeUndefined(); // raw key must not survive
    const steps = relinked.logicFlow["ts:checkout-web/src/index.ts#load"];
    // ...as is a resolved in-repo call target...
    expect(steps[0]).toMatchObject({ target: "ts:checkout-web/src/index.ts#helper" });
    // ...while a shared-space (ext:) target and a null target pass through untouched.
    expect(steps[1]).toMatchObject({ target: "ext:npm/node-fetch" });
    expect((steps[2] as { body: Array<{ target: string | null }> }).body[0].target).toBeNull();
    // Exit steps carry no target and no body — they must survive the remap unchanged, at any depth.
    expect((steps[3] as { paths: Array<{ body: unknown[] }> }).paths[0].body[0]).toEqual({ kind: "exit", variant: "throw", label: "boom" });
    expect(steps[4]).toEqual({ kind: "exit", variant: "return", label: null });
    // Declared entry modules are namespaced too.
    expect(relinked.entryModules).toEqual(["ts:checkout-web/src/index.ts"]);
  });

  it("shares boundary nodes within one ecosystem without conflating equal cross-ecosystem names", () => {
    const npmTarget = externalTargetId("npm", "shared", "Client");
    const pythonTarget = externalTargetId("python", "shared", "Client");
    const relinked = linkArtifacts([
      boundarySource("web-a", "ts:a.ts#run", npmTarget),
      boundarySource("web-b", "ts:b.ts#run", npmTarget),
      boundarySource("worker", "py:worker#run", pythonTarget),
    ]);

    const boundaryLeaves = relinked.nodes
      .filter((entry) => entry.parentId === EXTERNAL_CONTAINER_ID)
      .map((entry) => entry.id)
      .sort();
    expect(boundaryLeaves).toEqual([npmTarget, pythonTarget].sort());
    expect(relinked.edges.map((edge) => edge.target).sort()).toEqual([
      npmTarget,
      npmTarget,
      pythonTarget,
    ].sort());
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
