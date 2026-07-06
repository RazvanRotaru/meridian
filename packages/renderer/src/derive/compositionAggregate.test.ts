import { describe, expect, it } from "vitest";
import type { GraphEdge, GraphNode } from "@meridian/core";
import type { CouplingEdge, UnitMetrics } from "@meridian/design-metrics";
import { aggregateByPackage } from "./compositionAggregate";
import type { PackageSummaryData } from "./compositionAggregate";

function node(id: string, kind: string, parentId: string | null): GraphNode {
  return { id, kind, qualifiedName: id, displayName: id.split("/").pop() ?? id, parentId, location: { file: id, startLine: 1 } };
}

function metric(id: string, distance: number, smells: string[]): UnitMetrics {
  return { id, kind: "class", displayName: id, moduleFile: "", members: 3, cohesion: 1, lcomComponents: 1, ce: 0, ca: 0, instability: 0, abstractness: 0, distance, externalFanout: 0, smells } as UnitMetrics;
}

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
    const { nodes } = aggregateByPackage(IPC_EDGES, METRICS, NO_COUPLINGS, SURVIVORS, NODES, null);
    const cards = nodes.filter((n) => n.type === "package");
    expect(cards).toHaveLength(2);
    const a = cards.find((c) => c.id === "p:a")!.data as PackageSummaryData;
    expect(a).toMatchObject({ unitCount: 1, memberCount: 3, smellyCount: 1, worstDistance: 0.8 });
  });

  it("collapses the two channels into ONE package→package IPC wire carrying both", () => {
    const { edges } = aggregateByPackage(IPC_EDGES, METRICS, NO_COUPLINGS, SURVIVORS, NODES, null);
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
    const { edges } = aggregateByPackage(mixed, METRICS, NO_COUPLINGS, SURVIVORS, NODES, null);
    const ipc = edges.find((e) => e.ipc)!;
    // 'lonely' has a sender but no handler, so it never joins a wire — the wire still carries foo+bar.
    expect(ipc.ipcChannels?.map((c) => c.channel)).toEqual(["bar", "foo"]);
  });
});
