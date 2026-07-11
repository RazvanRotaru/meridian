import { describe, expect, it } from "vitest";
import type { Edge, Node } from "@xyflow/react";
import { repositionLitGhosts } from "./ghostReposition";

const CORE = "core";
const OUT_GROUP = "parent:outgoing";
const IN_GROUP = "parent:incoming";

function coreNode(): Node {
  return { id: CORE, type: "file", position: { x: 100, y: 200 }, style: { width: 220, height: 70, opacity: 1 }, data: {} };
}

function groupNode(id: string, direction: "incoming" | "outgoing"): Node {
  return {
    id,
    type: "ghost",
    position: { x: 0, y: 0 },
    style: { width: 200, height: 54, opacity: 1 },
    data: {
      ghostGroupId: id,
      ghostRole: "parent-anchor",
      groupedGhostCount: 4,
      ghostDirection: direction,
      label: id,
      context: "",
      ghostKind: "class",
    },
  };
}

function memberNode(id: string, direction: "incoming" | "outgoing"): Node {
  return {
    id,
    type: "ghost",
    position: { x: 0, y: 0 },
    style: { width: 180, height: 44, opacity: 1 },
    data: { ghostGroupParentId: direction === "outgoing" ? OUT_GROUP : IN_GROUP, ghostDirection: direction, label: id, context: "", ghostKind: "method" },
  };
}

function ordinaryGhostNode(id: string, direction: "incoming" | "outgoing"): Node {
  return {
    id,
    type: "ghost",
    position: { x: 0, y: 0 },
    style: { width: 180, height: 44, opacity: 1 },
    data: { ghostDirection: direction, label: id, context: "", ghostKind: "method" },
  };
}

function edge(id: string, source: string, target: string, hierarchy = false): Edge {
  return {
    id,
    source,
    target,
    style: { opacity: hierarchy ? 0 : 1 },
    data: hierarchy
      ? { edgeRole: "ghost-hierarchy", presentationOnly: true }
      : { category: "dep", depKind: "calls", ghost: true },
  };
}

function rect(node: Node) {
  const style = node.style as { width?: number; height?: number };
  return { x: node.position.x, y: node.position.y, width: style.width ?? 0, height: style.height ?? 0 };
}

function overlaps(a: ReturnType<typeof rect>, b: ReturnType<typeof rect>): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

function positions(nodes: readonly Node[]): Record<string, { x: number; y: number }> {
  return Object.fromEntries([...nodes].sort((a, b) => a.id.localeCompare(b.id)).map((node) => [node.id, node.position]));
}

describe("repositionLitGhosts — expanded parent hierarchy", () => {
  it("puts parent anchors in the outer column when ordinary ghosts overflow the inner column", () => {
    const outgoing = Array.from({ length: 8 }, (_, index) => ordinaryGhostNode(`ordinary:out:${index}`, "outgoing"));
    const incoming = Array.from({ length: 8 }, (_, index) => ordinaryGhostNode(`ordinary:in:${index}`, "incoming"));
    const outGroup = groupNode(OUT_GROUP, "outgoing");
    const inGroup = groupNode(IN_GROUP, "incoming");
    const nodes = [coreNode(), outGroup, inGroup, ...outgoing, ...incoming];
    const edges = [
      edge("core-to-out-group", CORE, OUT_GROUP),
      edge("in-group-to-core", IN_GROUP, CORE),
      ...outgoing.map((ghost) => edge(`edge:${ghost.id}`, CORE, ghost.id)),
      ...incoming.map((ghost) => edge(`edge:${ghost.id}`, ghost.id, CORE)),
    ];

    const byId = new Map(repositionLitGhosts(nodes, edges).map((node) => [node.id, node]));
    const outGroupRect = rect(byId.get(OUT_GROUP)!);
    const inGroupRect = rect(byId.get(IN_GROUP)!);
    const outgoingRects = outgoing.map((ghost) => rect(byId.get(ghost.id)!));
    const incomingRects = incoming.map((ghost) => rect(byId.get(ghost.id)!));

    expect(outgoingRects.every((ghost) => ghost.x < outGroupRect.x)).toBe(true);
    expect(incomingRects.every((ghost) => ghost.x > inGroupRect.x)).toBe(true);
  });

  it("keeps parent groups in the normal bands and fans exact members farther outward", () => {
    const outgoing = Array.from({ length: 10 }, (_, index) => memberNode(`out:${index}`, "outgoing"));
    const incoming = Array.from({ length: 10 }, (_, index) => memberNode(`in:${index}`, "incoming"));
    const nodes = [coreNode(), groupNode(OUT_GROUP, "outgoing"), groupNode(IN_GROUP, "incoming"), ...outgoing, ...incoming];
    const edges = [
      edge("core-to-out-group", CORE, OUT_GROUP),
      edge("in-group-to-core", IN_GROUP, CORE),
      ...outgoing.flatMap((member) => [
        edge(`ordinary:${member.id}`, CORE, member.id),
        edge(`hierarchy:${member.id}`, OUT_GROUP, member.id, true),
      ]),
      ...incoming.flatMap((member) => [
        edge(`ordinary:${member.id}`, member.id, CORE),
        edge(`hierarchy:${member.id}`, member.id, IN_GROUP, true),
      ]),
    ];

    const placed = repositionLitGhosts(nodes, edges);
    const byId = new Map(placed.map((node) => [node.id, node]));
    const core = rect(byId.get(CORE)!);
    const outGroup = rect(byId.get(OUT_GROUP)!);
    const inGroup = rect(byId.get(IN_GROUP)!);
    const outMembers = outgoing.map((member) => rect(byId.get(member.id)!));
    const inMembers = incoming.map((member) => rect(byId.get(member.id)!));

    expect(outGroup.x).toBeGreaterThanOrEqual(core.x + core.width);
    expect(inGroup.x + inGroup.width).toBeLessThanOrEqual(core.x);
    expect(outMembers.every((member) => member.x > outGroup.x + outGroup.width)).toBe(true);
    expect(inMembers.every((member) => member.x + member.width < inGroup.x)).toBe(true);
    const ghostRects = [outGroup, inGroup, ...outMembers, ...inMembers];
    for (let i = 0; i < ghostRects.length; i += 1) {
      expect(overlaps(ghostRects[i], core)).toBe(false);
      for (let j = i + 1; j < ghostRects.length; j += 1) {
        expect(overlaps(ghostRects[i], ghostRects[j])).toBe(false);
      }
    }
  });

  it("is deterministic and gives a bidirectional child its declared primary side", () => {
    const group = groupNode(OUT_GROUP, "outgoing");
    const child = memberNode("both", "outgoing");
    const nodes = [coreNode(), group, child];
    const edges = [
      edge("core-to-group", CORE, OUT_GROUP),
      edge("group-to-core", OUT_GROUP, CORE),
      edge("core-to-child", CORE, child.id),
      edge("child-to-core", child.id, CORE),
      edge("hierarchy-out", OUT_GROUP, child.id, true),
      edge("hierarchy-in", child.id, OUT_GROUP, true),
    ];

    const forward = repositionLitGhosts(nodes, edges);
    const reverse = repositionLitGhosts([...nodes].reverse(), [...edges].reverse());
    expect(positions(reverse)).toEqual(positions(forward));
    const byId = new Map(forward.map((node) => [node.id, node]));
    const parentRect = rect(byId.get(OUT_GROUP)!);
    expect(rect(byId.get(child.id)!).x).toBeGreaterThan(parentRect.x + parentRect.width);
  });
});
