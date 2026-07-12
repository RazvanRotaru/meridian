/**
 * Paint one selected request over an already-presented React Flow graph.
 *
 * This pass is deliberately downstream of layout and ordinary semantic emphasis: it may add
 * evidence metadata, classes, filters, and strokes, but it never changes identity, placement,
 * parentage, or endpoints. Node dimming uses `filter`, not inline opacity, because semantic-LOD CSS
 * owns opacity while parent levels cross-fade. Edges are allowed to use opacity: unlike nodes, their
 * request treatment must remain legible after the presentation pipeline has fused them into ribbons,
 * cycles, bundles, or spools.
 *
 * The input contract is structural around the concrete evidence types in
 * `derive/requestGraphOverlay.ts`, allowing a caller to adapt its exact-edge map from `edgesById`
 * to the presentation-facing `observedEdgesById` name without copying any evidence objects.
 */

import type { Edge, Node } from "@xyflow/react";
import type {
  ProjectedRequestNodeEvidence,
  RequestEvidenceStatus,
  RequestObservedEdgeEvidence,
} from "../derive/requestGraphOverlay";
import { isGhostHierarchyEdge } from "./canvas/presentationEdges";

export type RequestExecutionStatus = RequestEvidenceStatus;

export interface VisibleRequestNodeEvidenceLike {
  status: RequestExecutionStatus;
}

export interface RequestEdgeEvidenceLike {
  status: RequestExecutionStatus;
}

/** The visible, lens-projected evidence produced for one selected request. */
export interface VisibleRequestGraphOverlayLike<
  NodeEvidence extends VisibleRequestNodeEvidenceLike = ProjectedRequestNodeEvidence,
  EdgeEvidence extends RequestEdgeEvidenceLike = RequestObservedEdgeEvidence,
> {
  traceId: string;
  nodesById: ReadonlyMap<string, NodeEvidence>;
  /** Keyed by ORIGINAL artifact edge id, never by a presentation edge's synthetic id. */
  observedEdgesById: ReadonlyMap<string, EdgeEvidence>;
}

export const REQUEST_NODE_OBSERVED_CLASS = "request-graph-node--observed";
export const REQUEST_NODE_UNOBSERVED_CLASS = "request-graph-node--unobserved";
export const REQUEST_NODE_SELECTED_CONTEXT_CLASS = "request-graph-node--manual-context";
export const REQUEST_EDGE_OBSERVED_CLASS = "request-graph-edge--observed";
export const REQUEST_EDGE_UNOBSERVED_CLASS = "request-graph-edge--unobserved";

/** Stable filters shared with tests and any future stylesheet migration. */
export const UNOBSERVED_NODE_FILTER = "brightness(0.52) saturate(0.35)";
export const SELECTED_UNOBSERVED_NODE_FILTER = "brightness(0.82) saturate(0.72)";
const OBSERVED_NODE_FILTER = "brightness(1.04) saturate(1.08)";

const STATUS_COLOR: Readonly<Record<RequestExecutionStatus, string>> = {
  unset: "#8A93A0",
  ok: "#56C271",
  error: "#F0787C",
  mixed: "#E6B84D",
};

const DIM_EDGE_OPACITY = 0.14;
const SELECTED_CONTEXT_EDGE_OPACITY = 0.32;
const OBSERVED_EDGE_MIN_WIDTH = 3.2;

export interface RequestGraphPaintResult {
  nodes: Node[];
  edges: Edge[];
}

/** Paint nodes and already-presented semantic edges for one selected request. */
export function paintRequestGraph<
  NodeEvidence extends VisibleRequestNodeEvidenceLike,
  EdgeEvidence extends RequestEdgeEvidenceLike,
>(
  nodes: Node[],
  edges: Edge[],
  overlay: VisibleRequestGraphOverlayLike<NodeEvidence, EdgeEvidence>,
  manualSelectedIds: ReadonlySet<string>,
): RequestGraphPaintResult {
  return {
    nodes: decorateRequestNodes(nodes, overlay, manualSelectedIds),
    edges: decorateRequestEdges(edges, overlay, manualSelectedIds),
  };
}

/**
 * Add request evidence to node wrappers. The original data remains available verbatim beneath the
 * extra keys, while `domAttributes` gives browser tests and CSS a stable, component-agnostic hook.
 */
export function decorateRequestNodes<
  NodeEvidence extends VisibleRequestNodeEvidenceLike,
  EdgeEvidence extends RequestEdgeEvidenceLike,
>(
  nodes: Node[],
  overlay: VisibleRequestGraphOverlayLike<NodeEvidence, EdgeEvidence>,
  manualSelectedIds: ReadonlySet<string>,
): Node[] {
  return nodes.map((node) => {
    const evidence = overlay.nodesById.get(node.id);
    if (evidence !== undefined) {
      const status = normalizeStatus(evidence.status);
      const color = STATUS_COLOR[status];
      return {
        ...node,
        className: appendClasses(node.className, REQUEST_NODE_OBSERVED_CLASS, statusClass(status)),
        domAttributes: requestNodeDomAttributes(node, overlay.traceId, true, status, false),
        data: {
          ...node.data,
          requestObserved: true,
          requestDimmed: false,
          requestTraceId: overlay.traceId,
          requestStatus: status,
          requestEvidence: evidence,
        },
        style: {
          ...node.style,
          outline: `2px solid ${color}`,
          outlineOffset: 2,
          filter: appendFilter(node.style?.filter, `${OBSERVED_NODE_FILTER} drop-shadow(0 0 7px ${color}88)`),
        },
      };
    }

    const manuallySelected = manualSelectedIds.has(node.id);
    return {
      ...node,
      className: appendClasses(
        node.className,
        REQUEST_NODE_UNOBSERVED_CLASS,
        manuallySelected ? REQUEST_NODE_SELECTED_CONTEXT_CLASS : undefined,
      ),
      domAttributes: requestNodeDomAttributes(node, overlay.traceId, false, null, manuallySelected),
      data: {
        ...node.data,
        requestObserved: false,
        requestDimmed: true,
        requestTraceId: overlay.traceId,
        requestStatus: null,
        requestEvidence: null,
        requestManualContext: manuallySelected,
      },
      // Do not touch opacity. Semantic LOD controls it with CSS, and the normal graph selection may
      // already have assigned an inline value that must survive this independent evidence layer.
      style: {
        ...node.style,
        filter: appendFilter(
          node.style?.filter,
          manuallySelected ? SELECTED_UNOBSERVED_NODE_FILTER : UNOBSERVED_NODE_FILTER,
        ),
      },
    };
  });
}

/**
 * Decorate presentation edges by looking through every aggregate at ORIGINAL artifact ids. Ribbon
 * members and bundle constituents are recursively decorated because their custom renderers paint
 * those child objects rather than the aggregate's own `style`. Presentation-only hierarchy spokes
 * pass through by identity.
 */
export function decorateRequestEdges<
  NodeEvidence extends VisibleRequestNodeEvidenceLike,
  EdgeEvidence extends RequestEdgeEvidenceLike,
>(
  edges: Edge[],
  overlay: VisibleRequestGraphOverlayLike<NodeEvidence, EdgeEvidence>,
  manualSelectedIds: ReadonlySet<string>,
): Edge[] {
  const cache = new WeakMap<object, Edge>();
  const visiting = new WeakSet<object>();
  return edges.map((edge) => decorateRequestEdge(edge, overlay, manualSelectedIds, cache, visiting));
}

/** Exact original ids observed anywhere inside a strand/ribbon/bundle aggregate. */
export function observedArtifactEdgeIds(
  edge: Edge,
  observedEdgesById: ReadonlyMap<string, RequestEdgeEvidenceLike>,
): string[] {
  const ids = new Set<string>();
  collectObservedArtifactEdgeIds(edge, observedEdgesById, ids, new WeakSet<object>());
  return [...ids].sort();
}

function decorateRequestEdge<
  NodeEvidence extends VisibleRequestNodeEvidenceLike,
  EdgeEvidence extends RequestEdgeEvidenceLike,
>(
  edge: Edge,
  overlay: VisibleRequestGraphOverlayLike<NodeEvidence, EdgeEvidence>,
  manualSelectedIds: ReadonlySet<string>,
  cache: WeakMap<object, Edge>,
  visiting: WeakSet<object>,
): Edge {
  if (isGhostHierarchyEdge(edge)) {
    return edge;
  }
  const object = edge as object;
  const cached = cache.get(object);
  if (cached !== undefined) {
    return cached;
  }
  // Malformed hand-built aggregates can be cyclic. Preserve the current edge rather than recurse
  // forever; real presentation aggregates are acyclic.
  if (visiting.has(object)) {
    return edge;
  }
  visiting.add(object);

  const data = (edge.data ?? {}) as Record<string, unknown>;
  const members = decorateNestedEdges(data.members, overlay, manualSelectedIds, cache, visiting);
  const constituents = decorateNestedEdges(data.constituents, overlay, manualSelectedIds, cache, visiting);
  const nestedData = members === data.members && constituents === data.constituents
    ? data
    : { ...data, ...(members === undefined ? {} : { members }), ...(constituents === undefined ? {} : { constituents }) };
  const edgeForEvidence = nestedData === data ? edge : { ...edge, data: nestedData };
  const observedIds = observedArtifactEdgeIds(edgeForEvidence, overlay.observedEdgesById);
  const evidence = observedIds.map((id) => overlay.observedEdgesById.get(id)).filter(isDefined);

  let decorated: Edge;
  if (evidence.length > 0) {
    const status = strongestStatus(evidence.map((item) => item.status));
    const color = STATUS_COLOR[status];
    decorated = {
      ...edgeForEvidence,
      className: appendClasses(edge.className, REQUEST_EDGE_OBSERVED_CLASS, statusClass(status)),
      data: {
        ...nestedData,
        requestObserved: true,
        requestDimmed: false,
        requestTraceId: overlay.traceId,
        requestStatus: status,
        requestEvidence: evidence,
        requestObservedArtifactEdgeIds: observedIds,
      },
      style: {
        ...edge.style,
        stroke: color,
        opacity: 1,
        strokeWidth: Math.max(numericStrokeWidth(edge.style?.strokeWidth), OBSERVED_EDGE_MIN_WIDTH),
        filter: appendFilter(edge.style?.filter, `drop-shadow(0 0 4px ${color}AA)`),
      },
    };
  } else {
    const selectedContext = manualSelectedIds.has(edge.source) || manualSelectedIds.has(edge.target);
    decorated = {
      ...edgeForEvidence,
      className: appendClasses(
        edge.className,
        REQUEST_EDGE_UNOBSERVED_CLASS,
        selectedContext ? REQUEST_NODE_SELECTED_CONTEXT_CLASS : undefined,
      ),
      data: {
        ...nestedData,
        requestObserved: false,
        requestDimmed: true,
        requestTraceId: overlay.traceId,
        requestStatus: null,
        requestEvidence: null,
        requestObservedArtifactEdgeIds: [],
        requestManualContext: selectedContext,
      },
      style: {
        ...edge.style,
        opacity: dimmedEdgeOpacity(edge.style?.opacity, selectedContext),
      },
    };
  }

  visiting.delete(object);
  cache.set(object, decorated);
  return decorated;
}

function decorateNestedEdges<
  NodeEvidence extends VisibleRequestNodeEvidenceLike,
  EdgeEvidence extends RequestEdgeEvidenceLike,
>(
  value: unknown,
  overlay: VisibleRequestGraphOverlayLike<NodeEvidence, EdgeEvidence>,
  manualSelectedIds: ReadonlySet<string>,
  cache: WeakMap<object, Edge>,
  visiting: WeakSet<object>,
): unknown {
  if (!Array.isArray(value)) {
    return value;
  }
  let changed = false;
  const next = value.map((entry) => {
    if (!isEdgeLike(entry)) {
      return entry;
    }
    const decorated = decorateRequestEdge(entry, overlay, manualSelectedIds, cache, visiting);
    changed ||= decorated !== entry;
    return decorated;
  });
  return changed ? next : value;
}

function collectObservedArtifactEdgeIds(
  edge: Edge,
  observedEdgesById: ReadonlyMap<string, RequestEdgeEvidenceLike>,
  out: Set<string>,
  seen: WeakSet<object>,
): void {
  const object = edge as object;
  if (seen.has(object)) return;
  seen.add(object);
  const data = edge.data as { underlyingEdgeIds?: unknown; members?: unknown; constituents?: unknown } | undefined;
  if (Array.isArray(data?.underlyingEdgeIds)) {
    for (const id of data.underlyingEdgeIds) {
      if (typeof id === "string" && observedEdgesById.has(id)) out.add(id);
    }
  }
  collectNestedObservedIds(data?.members, observedEdgesById, out, seen);
  collectNestedObservedIds(data?.constituents, observedEdgesById, out, seen);
}

function collectNestedObservedIds(
  value: unknown,
  observedEdgesById: ReadonlyMap<string, RequestEdgeEvidenceLike>,
  out: Set<string>,
  seen: WeakSet<object>,
): void {
  if (!Array.isArray(value)) return;
  for (const entry of value) {
    if (isEdgeLike(entry)) collectObservedArtifactEdgeIds(entry, observedEdgesById, out, seen);
  }
}

function isEdgeLike(value: unknown): value is Edge {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<Edge>;
  return typeof candidate.id === "string" && typeof candidate.source === "string" && typeof candidate.target === "string";
}

function requestNodeDomAttributes(
  node: Node,
  traceId: string,
  observed: boolean,
  status: RequestExecutionStatus | null,
  manualContext: boolean,
): Node["domAttributes"] {
  return {
    ...(node.domAttributes ?? {}),
    "data-request-trace-id": traceId,
    "data-request-observed": observed ? "true" : "false",
    "data-request-status": status ?? "none",
    "data-request-manual-context": manualContext ? "true" : "false",
  } as Node["domAttributes"];
}

function dimmedEdgeOpacity(value: unknown, selectedContext: boolean): number {
  const cap = selectedContext ? SELECTED_CONTEXT_EDGE_OPACITY : DIM_EDGE_OPACITY;
  return typeof value === "number" && Number.isFinite(value) ? Math.min(value, cap) : cap;
}

function numericStrokeWidth(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 1.5;
}

function strongestStatus(statuses: readonly RequestExecutionStatus[]): RequestExecutionStatus {
  const normalized = new Set(statuses.map(normalizeStatus));
  if (normalized.size === 0) return "unset";
  if (normalized.has("mixed") || normalized.size > 1) return "mixed";
  return normalized.values().next().value ?? "unset";
}

function normalizeStatus(status: RequestExecutionStatus): RequestExecutionStatus {
  return status === "error" || status === "ok" || status === "mixed" ? status : "unset";
}

function statusClass(status: RequestExecutionStatus): string {
  return `request-graph-status--${status}`;
}

function appendClasses(base: string | undefined, ...classes: Array<string | undefined>): string {
  return [base, ...classes].filter((entry): entry is string => typeof entry === "string" && entry.length > 0).join(" ");
}

function appendFilter(base: string | undefined, requestFilter: string): string {
  return base && base.trim().length > 0 ? `${base} ${requestFilter}` : requestFilter;
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}
