import { describe, expect, it } from "vitest";
import type { Edge, Node } from "@xyflow/react";
import {
  paintRequestGraph,
  observedArtifactEdgeIds,
  REQUEST_EDGE_OBSERVED_CLASS,
  REQUEST_NODE_OBSERVED_CLASS,
  SELECTED_UNOBSERVED_NODE_FILTER,
  UNOBSERVED_NODE_FILTER,
  type RequestEdgeEvidenceLike,
  type VisibleRequestGraphOverlayLike,
  type VisibleRequestNodeEvidenceLike,
} from "./requestGraphPaint";

type NodeEvidence = VisibleRequestNodeEvidenceLike & {
  firstOrdinal: number;
  occurrences: number;
  totalDurationMs: number;
};

type EdgeEvidence = RequestEdgeEvidenceLike & { occurrences: number };

function overlay(
  nodesById: ReadonlyMap<string, NodeEvidence> = new Map(),
  observedEdgesById: ReadonlyMap<string, EdgeEvidence> = new Map(),
): VisibleRequestGraphOverlayLike<NodeEvidence, EdgeEvidence> {
  return { traceId: "trace-123", nodesById, observedEdgesById };
}

function node(id: string, extra: Partial<Node> = {}): Node {
  return {
    id,
    type: "file",
    position: { x: 17, y: 29 },
    data: { label: id },
    style: { width: 220, height: 54 },
    ...extra,
  } as Node;
}

function edge(id: string, source: string, target: string, data: Record<string, unknown> = {}, extra: Partial<Edge> = {}): Edge {
  return { id, source, target, data, style: { stroke: "#5E74C6", strokeWidth: 2, opacity: 0.4 }, ...extra } as Edge;
}

describe("paintRequestGraph nodes", () => {
  it("adds stable evidence hooks without moving or reparenting any node", () => {
    const position = { x: 17, y: 29 };
    const original = node("child", {
      position,
      parentId: "frame",
      extent: "parent",
      className: "semantic-layer",
      domAttributes: { title: "kept" },
      style: { width: 220, height: 54, opacity: 0.28, filter: "contrast(1.1)" },
    });
    const evidence: NodeEvidence = { status: "ok", firstOrdinal: 2, occurrences: 3, totalDurationMs: 12.5 };

    const painted = paintRequestGraph([original], [], overlay(new Map([[original.id, evidence]])), new Set());
    const result = painted.nodes[0];

    expect(result).not.toBe(original);
    expect(result.id).toBe(original.id);
    expect(result.position).toBe(position);
    expect(result.parentId).toBe("frame");
    expect(result.extent).toBe("parent");
    expect(result.style).toMatchObject({ width: 220, height: 54, opacity: 0.28 });
    expect(result.className).toContain("semantic-layer");
    expect(result.className).toContain(REQUEST_NODE_OBSERVED_CLASS);
    expect(result.domAttributes).toMatchObject({
      title: "kept",
      "data-request-trace-id": "trace-123",
      "data-request-observed": "true",
      "data-request-status": "ok",
    });
    expect(result.data).toMatchObject({ requestObserved: true, requestEvidence: evidence, requestStatus: "ok" });
  });

  it("dims with filters only and keeps selected unobserved context more readable", () => {
    const ordinary = node("ordinary");
    const selected = node("selected");
    const painted = paintRequestGraph([ordinary, selected], [], overlay(), new Set([selected.id])).nodes;

    expect(painted[0].style?.filter).toBe(UNOBSERVED_NODE_FILTER);
    expect(painted[1].style?.filter).toBe(SELECTED_UNOBSERVED_NODE_FILTER);
    expect(painted[0].style?.opacity).toBeUndefined();
    expect(painted[1].style?.opacity).toBeUndefined();
    expect((painted[0].data as { requestManualContext?: boolean }).requestManualContext).toBe(false);
    expect((painted[1].data as { requestManualContext?: boolean }).requestManualContext).toBe(true);
  });
});

describe("paintRequestGraph presentation edges", () => {
  it("finds exact artifact evidence through nested constituents and ribbon members", () => {
    const quiet = edge("quiet", "a", "b", { underlyingEdgeIds: ["artifact:quiet"] });
    const observed = edge("observed", "a", "b", { underlyingEdgeIds: ["artifact:observed"] });
    const ribbon = edge("ribbon", "a", "b", { members: [quiet, observed] }, { type: "ribbon" });
    const bundle = edge("bundle", "a", "b", { constituents: [ribbon] }, { type: "bundle" });
    const edgeEvidence: EdgeEvidence = { status: "error", occurrences: 2 };
    const model = overlay(new Map(), new Map([["artifact:observed", edgeEvidence]]));

    expect(observedArtifactEdgeIds(bundle, model.observedEdgesById)).toEqual(["artifact:observed"]);
    const painted = paintRequestGraph([], [bundle], model, new Set()).edges[0];
    const paintedRibbon = ((painted.data as { constituents: Edge[] }).constituents[0]);
    const paintedMembers = (paintedRibbon.data as { members: Edge[] }).members;

    expect(painted.id).toBe(bundle.id);
    expect(painted.source).toBe(bundle.source);
    expect(painted.target).toBe(bundle.target);
    expect(painted.className).toContain(REQUEST_EDGE_OBSERVED_CLASS);
    expect(painted.style).toMatchObject({ stroke: "#F0787C", opacity: 1, strokeWidth: 3.2 });
    expect(painted.data).toMatchObject({
      requestObserved: true,
      requestStatus: "error",
      requestObservedArtifactEdgeIds: ["artifact:observed"],
    });
    expect(paintedRibbon.data).toMatchObject({ requestObserved: true, requestStatus: "error" });
    expect(paintedMembers[0].data).toMatchObject({ requestObserved: false, requestDimmed: true });
    expect(paintedMembers[0].style?.opacity).toBe(0.14);
    expect(paintedMembers[1].data).toMatchObject({ requestObserved: true, requestStatus: "error" });
    expect(paintedMembers[1].style).toMatchObject({ stroke: "#F0787C", opacity: 1, strokeWidth: 3.2 });
  });

  it("marks an aggregate mixed when its observed members have different statuses", () => {
    const ok = edge("ok", "a", "b", { underlyingEdgeIds: ["artifact:ok"] });
    const failed = edge("failed", "a", "b", { underlyingEdgeIds: ["artifact:failed"] });
    const aggregate = edge("aggregate", "a", "b", { members: [ok, failed] }, { type: "ribbon" });
    const model = overlay(new Map(), new Map([
      ["artifact:ok", { status: "ok", occurrences: 1 }],
      ["artifact:failed", { status: "error", occurrences: 1 }],
    ]));

    const painted = paintRequestGraph([], [aggregate], model, new Set()).edges[0];
    expect((painted.data as { requestStatus?: string }).requestStatus).toBe("mixed");
    expect(painted.style?.stroke).toBe("#E6B84D");
  });

  it("preserves presentation-only hierarchy edges by identity", () => {
    const hierarchy = edge("hierarchy", "parent", "child", { edgeRole: "ghost-hierarchy" });
    const painted = paintRequestGraph([], [hierarchy], overlay(), new Set()).edges[0];
    expect(painted).toBe(hierarchy);
  });
});
