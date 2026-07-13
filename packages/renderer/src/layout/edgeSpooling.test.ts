import { describe, expect, it } from "vitest";
import type { Edge } from "@xyflow/react";
import { spoolFanEdges, SPOOL_EDGE_TYPE, type SpoolEdgeData } from "./edgeSpooling";
import { BUNDLE_EDGE_TYPE } from "./edgeBundling";

const edge = (id: string, source: string, target: string, type?: string): Edge => ({ id, source, target, type, data: {} });

/** A hub with `n` distinct sources fanning into it. */
const fanIn = (hub: string, n: number): Edge[] => Array.from({ length: n }, (_, i) => edge(`e${i}`, `s${i}`, hub));

describe("spoolFanEdges", () => {
  it("retypes every wire of a fan-in hub at the threshold, tagging the gathering end", () => {
    const result = spoolFanEdges(fanIn("hub", 6));
    expect(result.every((e) => e.type === SPOOL_EDGE_TYPE)).toBe(true);
    expect(result.every((e) => (e.data as SpoolEdgeData).spoolEnd === "target")).toBe(true);
  });

  it("leaves small fans untouched", () => {
    const result = spoolFanEdges(fanIn("hub", 5));
    expect(result.every((e) => e.type === undefined)).toBe(true);
  });

  it("keeps selected strands direct while an independently large remainder still spools", () => {
    const result = spoolFanEdges(fanIn("hub", 7), new Set(["s0"]));
    const selected = result.find((edge) => edge.id === "e0");
    const remainder = result.filter((edge) => edge.id !== "e0");

    expect(selected?.type).toBeUndefined();
    expect(remainder).toHaveLength(6);
    expect(remainder.every((edge) => edge.type === SPOOL_EDGE_TYPE)).toBe(true);
    expect(remainder.every((edge) => (edge.data as SpoolEdgeData).spoolEnd === "target")).toBe(true);
  });

  it("keeps every incident strand direct when the fan hub itself is selected", () => {
    const result = spoolFanEdges(fanIn("hub", 7), new Set(["hub"]));

    expect(result.every((edge) => edge.type === undefined)).toBe(true);
  });

  it("tags an edge between two hubs as gathering at both ends", () => {
    const edges = [
      ...fanIn("hubA", 6),
      ...Array.from({ length: 6 }, (_, i) => edge(`o${i}`, "hubB", `t${i}`)),
      edge("bridge", "hubB", "hubA"), // hubB fans out ≥6 AND hubA fans in ≥6 (bridge counts toward both)
    ];
    const result = spoolFanEdges(edges);
    const bridge = result.find((e) => e.id === "bridge");
    expect(bridge?.type).toBe(SPOOL_EDGE_TYPE);
    expect((bridge?.data as SpoolEdgeData).spoolEnd).toBe("both");
  });

  it("never retypes or counts container highways (bundle edges)", () => {
    const bundles = Array.from({ length: 6 }, (_, i) => edge(`b${i}`, `p${i}`, "hub", BUNDLE_EDGE_TYPE));
    const result = spoolFanEdges([...bundles, edge("solo", "s0", "hub")]);
    expect(result.filter((e) => e.type === BUNDLE_EDGE_TYPE)).toHaveLength(6);
    // The lone plain edge stays plain: bundle edges don't count toward the hub's fan.
    expect(result.find((e) => e.id === "solo")?.type).toBeUndefined();
  });

  it("preserves each edge's existing style and data", () => {
    const styled: Edge = { ...fanIn("hub", 6)[0], style: { stroke: "#abc", opacity: 0.4 }, data: { category: "import" } };
    const result = spoolFanEdges([styled, ...fanIn("hub", 6).slice(1)]);
    const out = result.find((e) => e.id === styled.id);
    expect(out?.style).toEqual({ stroke: "#abc", opacity: 0.4 });
    expect((out?.data as { category?: string }).category).toBe("import");
  });
});
