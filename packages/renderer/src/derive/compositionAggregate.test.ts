import { describe, expect, it } from "vitest";
import type { GraphEdge, GraphNode } from "@meridian/core";
import type { CouplingEdge, UnitMetrics } from "@meridian/design-metrics";
import { aggregateByPackage } from "./compositionAggregate";
import type { PackageSummaryData } from "./compositionAggregate";
import type { ClusterNodeData, CompNodeSpec } from "./compositionGraph";

function node(id: string, kind: string, parentId: string | null): GraphNode {
  return { id, kind, qualifiedName: id, displayName: id.split("/").pop() ?? id, parentId, location: { file: id, startLine: 1 } };
}

function metric(id: string, distance: number, smells: string[]): UnitMetrics {
  return { id, kind: "class", displayName: id, moduleFile: "", members: 3, cohesion: 1, lcomComponents: 1, ce: 0, ca: 0, instability: 0, abstractness: 0, distance, externalFanout: 0, smells } as UnitMetrics;
}

// A stand-in scorecard factory — expansion tests only care about ids/parents, not card contents.
const UNIT_CARD = (unitId: string): CompNodeSpec => ({ id: unitId, type: "unit", width: 240, height: 104, data: { unitId } as never });
const NONE = new Set<string>();

// Two packages, one unit each; two electron channels where pkgA sends and pkgB handles.
const NODES = new Map<string, GraphNode>([
  ["p:a", node("p:a", "package", null)],
  ["p:b", node("p:b", "package", null)],
  ["u:a", node("u:a", "class", "p:a")],
  ["u:b", node("u:b", "class", "p:b")],
]);
const METRICS = new Map<string, UnitMetrics>([
  ["u:a", metric("u:a", 0.8, ["SPLIT"])],
  ["u:b", metric("u:b", 0.1, [])],
]);
const SURVIVORS = new Set(["u:a", "u:b"]);
const NO_COUPLINGS: CouplingEdge[] = [];
const IPC_EDGES: GraphEdge[] = [
  { id: "1", source: "u:a", target: "ipc:electron/foo", kind: "sends", resolution: "resolved" },
  { id: "2", source: "ipc:electron/foo", target: "u:b", kind: "handles", resolution: "resolved" },
  { id: "3", source: "u:a", target: "ipc:electron/bar", kind: "sends", resolution: "resolved" },
  { id: "4", source: "ipc:electron/bar", target: "u:b", kind: "handles", resolution: "resolved" },
];

describe("aggregateByPackage", () => {
  it("rolls units into one package card each, carrying the worst distance and smell tally", () => {
    const { nodes } = aggregateByPackage(IPC_EDGES, METRICS, NO_COUPLINGS, SURVIVORS, NODES, null, NONE, UNIT_CARD);
    const cards = nodes.filter((n) => n.type === "package");
    expect(cards).toHaveLength(2);
    const a = cards.find((c) => c.id === "p:a")!.data as PackageSummaryData;
    expect(a).toMatchObject({ unitCount: 1, memberCount: 3, smellyCount: 1, worstDistance: 0.8 });
  });

  it("collapses the two channels into ONE package→package IPC wire carrying both", () => {
    const { edges } = aggregateByPackage(IPC_EDGES, METRICS, NO_COUPLINGS, SURVIVORS, NODES, null, NONE, UNIT_CARD);
    const ipc = edges.filter((e) => e.ipc);
    expect(ipc).toHaveLength(1);
    expect(ipc[0]).toMatchObject({ source: "p:a", target: "p:b" });
    // the wire's inspector list = both channels it carries, sorted
    expect(ipc[0].ipcChannels?.map((c) => c.channel)).toEqual(["bar", "foo"]);
    expect(ipc[0].ipcChannels?.every((c) => c.protocol === "electron")).toBe(true);
  });

  it("flags a channel with no handler as dangling in the wire's channel detail", () => {
    const oneSided: GraphEdge[] = [{ id: "1", source: "u:a", target: "ipc:electron/foo", kind: "sends", resolution: "resolved" }];
    // no handler edge → foo is out-only; with no handler package, no wire forms, but a matched wire
    // that ALSO carries a half-dangling channel should mark it. Add a matched channel + a dangling one.
    const mixed: GraphEdge[] = [...IPC_EDGES, ...oneSided.map((e) => ({ ...e, id: "5", target: "ipc:electron/lonely" }))];
    const { edges } = aggregateByPackage(mixed, METRICS, NO_COUPLINGS, SURVIVORS, NODES, null, NONE, UNIT_CARD);
    const ipc = edges.find((e) => e.ipc)!;
    // 'lonely' has a sender but no handler, so it never joins a wire — the wire still carries foo+bar.
    expect(ipc.ipcChannels?.map((c) => c.channel)).toEqual(["bar", "foo"]);
  });
});

// Inline expansion: p:a holds two direct units AND a sub-package with its own unit; p:b stays a card.
const DEEP_NODES = new Map<string, GraphNode>([
  ["p:a", node("p:a", "package", null)],
  ["p:a/sub", node("p:a/sub", "package", "p:a")],
  ["p:b", node("p:b", "package", null)],
  ["u:a", node("u:a", "class", "p:a")],
  ["u:a2", node("u:a2", "class", "p:a")],
  ["u:sub", node("u:sub", "class", "p:a/sub")],
  ["u:b", node("u:b", "class", "p:b")],
]);
const DEEP_METRICS = new Map<string, UnitMetrics>([
  ["u:a", metric("u:a", 0.8, ["SPLIT"])],
  ["u:a2", metric("u:a2", 0.2, [])],
  ["u:sub", metric("u:sub", 0.3, [])],
  ["u:b", metric("u:b", 0.1, [])],
]);
const DEEP_SURVIVORS = new Set(["u:a", "u:a2", "u:sub", "u:b"]);
const DEEP_COUPLINGS: CouplingEdge[] = [
  { source: "u:a", target: "u:a2", inheritanceOnly: false, kinds: new Set(["calls"]) },
  { source: "u:a", target: "u:sub", inheritanceOnly: false, kinds: new Set(["calls"]) },
  { source: "u:sub", target: "u:b", inheritanceOnly: false, kinds: new Set(["calls"]) },
];

describe("aggregateByPackage with inline expansion", () => {
  const expanded = new Set(["p:a"]);

  it("keeps every package→package coupling gold when nothing is expanded (the pre-expansion view)", () => {
    const { edges } = aggregateByPackage([], DEEP_METRICS, DEEP_COUPLINGS, DEEP_SURVIVORS, DEEP_NODES, null, NONE, UNIT_CARD);
    expect(edges.find((e) => e.id === "couple:p:a->p:b")).toMatchObject({ crossBoundary: true });
  });

  it("turns the expanded package into a frame holding the next level: a sub-package card + unit scorecards", () => {
    const { nodes } = aggregateByPackage([], DEEP_METRICS, DEEP_COUPLINGS, DEEP_SURVIVORS, DEEP_NODES, null, expanded, UNIT_CARD);
    const frame = nodes.find((n) => n.id === "p:a")!;
    expect(frame.type).toBe("cluster");
    expect((frame.data as ClusterNodeData)).toMatchObject({ unitCount: 3, smellyCount: 1, expanded: true });
    // the next level nests INSIDE the frame; the untouched package stays a top-level card
    expect(nodes.find((n) => n.id === "p:a/sub")).toMatchObject({ type: "package", parentId: "p:a" });
    expect(nodes.find((n) => n.id === "u:a")).toMatchObject({ type: "unit", parentId: "p:a" });
    expect(nodes.find((n) => n.id === "p:b")).toMatchObject({ type: "package", parentId: undefined });
  });

  it("expands recursively — a sub-package in the set becomes a nested frame with its units inside", () => {
    const both = new Set(["p:a", "p:a/sub"]);
    const { nodes } = aggregateByPackage([], DEEP_METRICS, DEEP_COUPLINGS, DEEP_SURVIVORS, DEEP_NODES, null, both, UNIT_CARD);
    expect(nodes.find((n) => n.id === "p:a/sub")).toMatchObject({ type: "cluster", parentId: "p:a" });
    expect(nodes.find((n) => n.id === "u:sub")).toMatchObject({ type: "unit", parentId: "p:a/sub" });
    // frames come parent-first so every consumer sees a container before its contents
    expect(nodes.findIndex((n) => n.id === "p:a")).toBeLessThan(nodes.findIndex((n) => n.id === "p:a/sub"));
  });

  it("re-lifts couplings to the finest visible cards; only unit↔unit inside one frame goes grey", () => {
    const { edges } = aggregateByPackage([], DEEP_METRICS, DEEP_COUPLINGS, DEEP_SURVIVORS, DEEP_NODES, null, expanded, UNIT_CARD);
    // two unit scorecards in the same opened frame — genuinely intra-package
    expect(edges.find((e) => e.id === "couple:u:a->u:a2")).toMatchObject({ crossBoundary: false });
    // a unit card to the sub-package CARD still crosses a package boundary (the card IS a package)
    expect(edges.find((e) => e.id === "couple:u:a->p:a/sub")).toMatchObject({ crossBoundary: true });
    // u:sub → u:b leaves the frame for the p:b card: cross-boundary
    expect(edges.find((e) => e.id === "couple:p:a/sub->p:b")).toMatchObject({ crossBoundary: true });
  });

  it("attaches IPC wires to the unit scorecard once its package is opened", () => {
    const { edges } = aggregateByPackage(IPC_EDGES, DEEP_METRICS, NO_COUPLINGS, DEEP_SURVIVORS, DEEP_NODES, null, expanded, UNIT_CARD);
    const ipc = edges.filter((e) => e.ipc);
    expect(ipc).toHaveLength(1);
    expect(ipc[0]).toMatchObject({ source: "u:a", target: "p:b", crossBoundary: true });
  });
});
