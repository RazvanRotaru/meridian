import type { LogicFlows, RequestTrace, SyntheticNodeSnapshot } from "@meridian/core";
import { deriveFocusedRequestExecutionFlow, deriveRequestExecutionFlow } from "../derive/requestExecutionFlow";
import type { GraphIndex } from "../graph/graphIndex";
import {
  buildLogicElkGraph,
  toReactFlowLogic,
  type LogicRfEdge,
  type LogicFlowOrientation,
  type LogicReactFlowGraph,
} from "../layout/logicElk";
import { runElkLayout } from "../layout/elkLayout";
import type { LogicEdgeSpec, LogicNodeSpec } from "../derive/logicGraph";

export const REQUEST_FLOW_EDGE_CLASS = "request-flow-edge";
export const REQUEST_FLOW_EDGE_OBSERVED_CLASS = "request-flow-edge--observed";
export const REQUEST_FLOW_EDGE_CONTEXT_CLASS = "request-flow-edge--context";

const OBSERVED_EDGE_FILTER = "drop-shadow(0 0 4px rgba(88, 201, 163, 0.9))";
const CONTEXT_EDGE_OPACITY = 0.22;

/** Lay out the concrete execution captured by one trace using the same ELK/React Flow adapter as
 * static Logic. The input identity is the trace (span/event IDs), never a clicked artifact node. */
export async function deriveRequestFlowPaneLayout(
  trace: RequestTrace,
  index: GraphIndex,
  flows: LogicFlows = {},
  requestFlowExpansionOverrides: ReadonlySet<string> = new Set<string>(),
  snapshots: readonly SyntheticNodeSnapshot[] = [],
): Promise<LogicReactFlowGraph> {
  const spec = deriveRequestExecutionFlow(trace, index, flows, requestFlowExpansionOverrides, snapshots);
  if (spec.nodes.length === 0) return { nodes: [], edges: [] };
  const laidOut = await runElkLayout(buildLogicElkGraph(spec));
  const specById = new Map<string, LogicNodeSpec>(spec.nodes.map((node) => [node.id, node]));
  const graph = toReactFlowLogic(laidOut, specById, spec.edges);
  return {
    ...graph,
    edges: decorateRequestFlowEdges(graph.edges, spec.edges, trace.traceId),
  };
}

/** The synthetic flow player charts one selected callable occurrence at a time. It shares the
 * request evidence paint, but gives the reader an explicit orientation choice for that focused
 * static body without changing the main Logic view's established horizontal layout. */
export async function deriveFocusedRequestFlowPaneLayout(
  trace: RequestTrace,
  index: GraphIndex,
  flows: LogicFlows,
  selectedMomentId: string,
  orientation: LogicFlowOrientation,
  requestFlowExpansionOverrides: ReadonlySet<string> = new Set<string>(),
  snapshots: readonly SyntheticNodeSnapshot[] = [],
): Promise<LogicReactFlowGraph> {
  const spec = deriveFocusedRequestExecutionFlow(
    trace,
    index,
    flows,
    selectedMomentId,
    requestFlowExpansionOverrides,
    snapshots,
  );
  if (spec.nodes.length === 0) return { nodes: [], edges: [] };
  const laidOut = await runElkLayout(buildLogicElkGraph(spec, orientation));
  const specById = new Map<string, LogicNodeSpec>(spec.nodes.map((node) => [node.id, node]));
  const graph = toReactFlowLogic(laidOut, specById, spec.edges, orientation);
  return {
    ...graph,
    edges: decorateRequestFlowEdges(graph.edges, spec.edges, trace.traceId),
  };
}

/** Request-only evidence paint. The shared Logic/PR adapter deliberately stays untouched: bright
 * edges have positive telemetry evidence, while expanded static edges without a successful
 * source/path or span-order correlation remain subdued context. */
export function decorateRequestFlowEdges(
  edges: readonly LogicRfEdge[],
  specs: readonly LogicEdgeSpec[],
  traceId: string,
): LogicRfEdge[] {
  const specById = new Map(specs.map((edge) => [edge.id, edge]));
  return edges.map((edge) => {
    const edgeSpec = specById.get(edge.id);
    const evidence = edgeSpec?.requestTraversal;
    const observed = evidence !== undefined;
    const disposition = observed ? "observed" : "context";
    return {
      ...edge,
      className: appendClasses(
        edge.className,
        REQUEST_FLOW_EDGE_CLASS,
        observed ? REQUEST_FLOW_EDGE_OBSERVED_CLASS : REQUEST_FLOW_EDGE_CONTEXT_CLASS,
      ),
      domAttributes: {
        ...(edge.domAttributes ?? {}),
        "data-request-flow-evidence": disposition,
        "data-request-flow-basis": evidence?.basis ?? "static-context",
        "data-request-flow-relation": evidence !== undefined && "relation" in evidence ? evidence.relation : undefined,
        "data-request-trace-id": traceId,
        "data-request-flow-span-id": evidence !== undefined && "spanId" in evidence ? evidence.spanId : undefined,
        "data-request-flow-site-id": evidence !== undefined && "siteId" in evidence ? evidence.siteId : undefined,
        "data-request-flow-path-ids": evidence !== undefined && "pathIds" in evidence ? evidence.pathIds.join(",") : undefined,
        "data-request-flow-event-ids": evidence !== undefined && "eventIds" in evidence ? evidence.eventIds.join(",") : undefined,
        "data-request-flow-iterations": evidence !== undefined && "iterations" in evidence ? String(evidence.iterations) : undefined,
      } as LogicRfEdge["domAttributes"],
      data: {
        ...edge.data,
        kind: edge.data?.kind ?? edgeSpec?.kind ?? "seq",
        requestFlowDisposition: disposition,
        requestFlowEvidence: evidence ?? null,
        requestTraceId: traceId,
      },
      animated: observed ? edge.animated : false,
      zIndex: observed ? 3 : 0,
      interactionWidth: observed ? Math.max(edge.interactionWidth ?? 0, 18) : edge.interactionWidth,
      style: observed
        ? {
            ...edge.style,
            opacity: 1,
            strokeWidth: Math.max(numericStrokeWidth(edge.style?.strokeWidth), 3.4),
            filter: appendFilter(edge.style?.filter, OBSERVED_EDGE_FILTER),
          }
        : {
            ...edge.style,
            opacity: dimmedOpacity(edge.style?.opacity),
            strokeWidth: Math.min(numericStrokeWidth(edge.style?.strokeWidth), 1.35),
          },
      labelStyle: observed
        ? { ...edge.labelStyle, opacity: 1 }
        : { ...edge.labelStyle, opacity: 0.34 },
    };
  });
}

function appendClasses(...classes: Array<string | undefined>): string {
  return classes.filter((value): value is string => Boolean(value)).join(" ");
}

function appendFilter(existing: unknown, addition: string): string {
  return typeof existing === "string" && existing.length > 0 ? `${existing} ${addition}` : addition;
}

function numericStrokeWidth(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 2;
}

function dimmedOpacity(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(value, CONTEXT_EDGE_OPACITY)
    : CONTEXT_EDGE_OPACITY;
}
