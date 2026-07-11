/**
 * Commons demotion (the hub treatment): a top-level leaf FILE with 6+ distinct dependents at this
 * level demotes — its node marks isCommons, its incoming wires mark commons (paint hides them at
 * rest), and each dependent gains chips naming its demoted deps. Frames, packages, expanded files,
 * the entry file, and ghost wires never trigger it.
 */

import { describe, expect, it } from "vitest";
import { demoteCommons } from "./commonsDemotion";
import type { ModuleCardData } from "./moduleLevel";
import type { ModuleTreeEdge, VisibleModuleNode } from "./moduleTreeTypes";

function file(id: string, extra: Partial<ModuleCardData> = {}, parentId: string | null = null, isExpanded = false): VisibleModuleNode {
  const data = { label: id.split("/").pop() ?? id, fullPath: id, category: "app", inCount: 0, outCount: 0, isEntry: false, isContainer: false, isExpanded, unitCount: 0, ...extra } as ModuleCardData;
  return { id, parentId, kind: "file", isContainer: false, isExpanded, depth: 0, childCount: 0, data };
}

function wire(source: string, target: string, ghost = false): ModuleTreeEdge {
  return { id: `w:${source}->${target}`, source, target, weight: 1, crossFrame: false, category: "import", ghost };
}

const DEPENDENTS = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts"];

function level(hubId = "logger.ts", hubExtra: Partial<ModuleCardData> = {}, hubExpanded = false) {
  const nodes = [...DEPENDENTS.map((id) => file(id)), file(hubId, hubExtra, null, hubExpanded)];
  const edges = DEPENDENTS.map((id) => wire(id, hubId));
  return { nodes, edges };
}

describe("demoteCommons", () => {
  it("demotes a 6-dependent file: isCommons on the hub, commons on its wires, chips on dependents", () => {
    const { nodes, edges } = level();
    const demoted = demoteCommons(nodes, edges);
    const hub = demoted.nodes.find((node) => node.id === "logger.ts");
    expect((hub?.data as ModuleCardData).isCommons).toBe(true);
    expect(demoted.edges.every((edge) => edge.commons === true)).toBe(true);
    const dependent = demoted.nodes.find((node) => node.id === "a.ts");
    expect((dependent?.data as ModuleCardData).commonsChips).toEqual(["logger"]);
  });

  it("3 dependents stay below the floor — nothing changes", () => {
    const { nodes, edges } = level();
    const result = demoteCommons(nodes, edges.slice(0, 3));
    expect(result.nodes).toBe(nodes);
    expect(result.edges.slice(0, 3)).toEqual(edges.slice(0, 3));
  });

  it("the bar scales with the level: 4 dependents demote on a small level, not among 30 cards", () => {
    const small = level();
    const smallResult = demoteCommons(small.nodes, small.edges.slice(0, 4));
    expect(smallResult.nodes.some((node) => (node.data as ModuleCardData).isCommons === true)).toBe(true);
    const crowd = Array.from({ length: 24 }, (_, i) => file(`extra${i}.ts`));
    const bigResult = demoteCommons([...small.nodes, ...crowd], small.edges.slice(0, 4));
    expect(bigResult.nodes.every((node) => (node.data as ModuleCardData).isCommons !== true)).toBe(true);
  });

  it("never demotes the entry file, an expanded file, or a nested file", () => {
    const entry = demoteCommons(...Object.values(level("logger.ts", { isEntry: true })) as [VisibleModuleNode[], ModuleTreeEdge[]]);
    expect(entry.nodes.every((node) => (node.data as ModuleCardData).isCommons !== true)).toBe(true);
    const expanded = demoteCommons(...Object.values(level("logger.ts", {}, true)) as [VisibleModuleNode[], ModuleTreeEdge[]]);
    expect(expanded.nodes.every((node) => (node.data as ModuleCardData).isCommons !== true)).toBe(true);
    const nested = level();
    nested.nodes[nested.nodes.length - 1] = file("logger.ts", {}, "some-frame");
    expect(demoteCommons(nested.nodes, nested.edges).nodes.every((node) => (node.data as ModuleCardData).isCommons !== true)).toBe(true);
  });

  it("ghost wires neither count toward the threshold nor get marked", () => {
    const { nodes, edges } = level();
    const withGhosts = [...edges.slice(0, 3), wire("ghost-src", "logger.ts", true)];
    const result = demoteCommons(nodes, withGhosts);
    expect(result.nodes.every((node) => (node.data as ModuleCardData).isCommons !== true)).toBe(true);
    expect(result.edges.every((edge) => edge.commons !== true)).toBe(true);
  });

  it("lifts nested sources: an expanded frame's member wires are ONE dependent, chipped on the frame", () => {
    const { nodes } = level();
    // Three members inside one expanded file frame all hit the hub; plus 3 top-level dependents.
    const frame = file("frame.ts", { isContainer: true }, null, true);
    const members = ["m1", "m2", "m3"].map((id) => file(`frame.ts#${id}`, {}, "frame.ts"));
    const memberWires = members.map((member) => wire(member.id, "logger.ts"));
    const topWires = [wire("a.ts", "logger.ts"), wire("b.ts", "logger.ts"), wire("c.ts", "logger.ts")];
    const all = demoteCommons([...nodes, frame, ...members], [...topWires, ...memberWires]);
    // 3 members lift to ONE frame → 4 distinct dependents total → demotes; chips land on the FRAME.
    expect(all.nodes.some((node) => node.id === "logger.ts" && (node.data as ModuleCardData).isCommons === true)).toBe(true);
    expect((all.nodes.find((node) => node.id === "frame.ts")?.data as ModuleCardData).commonsChips).toEqual(["logger"]);
    expect(all.nodes.filter((node) => node.id.startsWith("frame.ts#")).every((node) => (node.data as ModuleCardData).commonsChips === undefined)).toBe(true);
  });

  it("hides a docked hub's OWN outgoing wires too (both directions mark commons)", () => {
    const { nodes, edges } = level();
    const out = wire("logger.ts", "a.ts");
    const result = demoteCommons(nodes, [...edges, out]);
    expect(result.edges.find((edge) => edge.source === "logger.ts")?.commons).toBe(true);
    // ...but the outgoing target gains no chip (chips mean "depends ON a commons").
    expect((result.nodes.find((node) => node.id === "a.ts")?.data as ModuleCardData).commonsChips).toEqual(["logger"]);
  });

  it("dedupes chips and keeps a dependent of two hubs wearing both", () => {
    const { nodes, edges } = level();
    const second = level("config.ts");
    const all = demoteCommons([...nodes, second.nodes[second.nodes.length - 1]], [...edges, ...second.edges, wire("a.ts", "logger.ts")]);
    const dependent = all.nodes.find((node) => node.id === "a.ts");
    expect((dependent?.data as ModuleCardData).commonsChips).toEqual(["logger", "config"]);
  });
});
