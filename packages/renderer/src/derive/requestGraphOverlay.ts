/**
 * Pure projection of one observed request onto the static Meridian graph.
 *
 * This deliberately accepts only the trace contract's exact `nodeId` join. Fallback name/source
 * matching belongs in an ingestion normalizer where ambiguity can be reported with its original
 * coordinates; the renderer must not turn a plausible candidate into observed graph evidence.
 */

import type { GraphEdge, RequestTrace, TimelineEvent, TimelineSpan, TimelineSpanLink } from "@meridian/core";
import type { Node } from "@xyflow/react";
import type { GraphIndex } from "../graph/graphIndex";
import { frameIdOf } from "./serviceClusterEdges";
import { clusteringFor } from "./serviceClusteringCache";
import type { ServiceGroupingMode } from "./serviceClusteringModes";
import type { ServiceClustering } from "./serviceComposition";
import { deriveServiceDomains } from "./serviceDomains";

export type RequestEvidenceStatus = "ok" | "error" | "mixed" | "unset";

export interface RequestEventCounts {
  branchTaken: number;
  dataObserve: number;
  loopSummary: number;
  asyncHandoff: number;
  exception: number;
}

export interface RequestSpanOccurrence {
  spanId: string;
  parentSpanId?: string;
  sequence: number;
  startMs: number;
  endMs: number;
  durationMs: number;
  status: TimelineSpan["status"];
  eventCounts: RequestEventCounts;
}

export interface RequestNodeEvidence {
  nodeId: string;
  occurrences: RequestSpanOccurrence[];
  occurrenceCount: number;
  inclusiveSpanMs: number;
  activeWallMs: number;
  firstSequence: number;
  firstStartMs: number;
  lastEndMs: number;
  status: RequestEvidenceStatus;
  eventCounts: RequestEventCounts;
}

export interface RequestObservedEdgeEvidence {
  edgeId: string;
  kind: "calls" | "instantiates";
  transitionIds: string[];
  occurrenceCount: number;
  firstSequence: number;
  status: RequestEvidenceStatus;
}

export type RequestTransitionRelation = "parent" | TimelineSpanLink["relation"];
export type RequestTransitionDisposition = "observed" | "runtime-only" | "ambiguous";

export interface RequestTransitionEvidence {
  transitionId: string;
  sourceSpanId: string;
  targetSpanId: string;
  sourceNodeId?: string;
  targetNodeId?: string;
  relation: RequestTransitionRelation;
  disposition: RequestTransitionDisposition;
  /** Exactly one id for observed transitions, every competing execution edge for ambiguity. */
  candidateEdgeIds: string[];
  reason?: "unmapped-endpoint" | "no-execution-edge" | "ambiguous-execution-edge";
}

export interface RequestUnmappedSpanDiagnostic {
  spanId: string;
  spanName: string;
  requestedNodeId?: string;
  reason: "missing-node-id" | "node-not-in-graph";
}

export interface RequestGraphOverlayCounts {
  totalSpans: number;
  exactSpans: number;
  unmappedSpans: number;
  totalTransitions: number;
  observedTransitions: number;
  runtimeOnlyTransitions: number;
  ambiguousTransitions: number;
  observedStaticEdges: number;
}

export interface RequestGraphOverlay {
  traceId: string;
  nodesById: Map<string, RequestNodeEvidence>;
  edgesById: Map<string, RequestObservedEdgeEvidence>;
  observedEdgeIds: Set<string>;
  transitions: RequestTransitionEvidence[];
  unmappedSpans: RequestUnmappedSpanDiagnostic[];
  counts: RequestGraphOverlayCounts;
}

export interface DeriveRequestGraphOverlayOptions {
  /** Same-trace links represent async/message causality. Parent relationships always win for a pair. */
  includeSameTraceLinks?: boolean;
}

export interface RequestGraphProjectionOptions {
  serviceGroupingMode?: ServiceGroupingMode;
  serviceGroupingTargetSize?: number;
}

export interface ProjectedRequestNodeEvidence {
  visibleNodeId: string;
  occurrenceCount: number;
  inclusiveSpanMs: number;
  activeWallMs: number;
  firstSequence: number;
  status: RequestEvidenceStatus;
  eventCounts: RequestEventCounts;
  /** Exact evidence whose graph node is itself visible. */
  directSourceIds: string[];
  /** Exact evidence lifted to a real ancestor, service frame, or service domain. */
  rollupSourceIds: string[];
}

interface MutableNodeEvidence {
  nodeId: string;
  occurrences: RequestSpanOccurrence[];
}

interface MutableEdgeEvidence {
  edgeId: string;
  kind: "calls" | "instantiates";
  transitionIds: string[];
  firstSequence: number;
  statuses: TimelineSpan["status"][];
}

interface ProjectionAccumulator {
  visibleNodeId: string;
  occurrences: RequestSpanOccurrence[];
  inclusiveSpanMs: number;
  firstSequence: number;
  statuses: TimelineSpan["status"][];
  eventCounts: RequestEventCounts;
  directSourceIds: Set<string>;
  rollupSourceIds: Set<string>;
}

/** Derive exact node occurrences, proven static execution edges, and every unproven transition. */
export function deriveRequestGraphOverlay(
  trace: RequestTrace,
  index: GraphIndex,
  options: DeriveRequestGraphOverlayOptions = {},
): RequestGraphOverlay {
  const includeSameTraceLinks = options.includeSameTraceLinks ?? true;
  const traceStart = nano(trace.startedAtUnixNano);
  const orderedSpans = [...trace.spans].sort(compareSpanTime);
  const occurrenceBySpanId = new Map<string, RequestSpanOccurrence>();
  const exactNodeIdBySpanId = new Map<string, string>();
  const mutableNodes = new Map<string, MutableNodeEvidence>();
  const unmappedSpans: RequestUnmappedSpanDiagnostic[] = [];

  orderedSpans.forEach((span, offset) => {
    const occurrence = occurrenceOf(span, offset + 1, traceStart);
    occurrenceBySpanId.set(span.spanId, occurrence);
    if (span.nodeId === undefined) {
      unmappedSpans.push({ spanId: span.spanId, spanName: span.name, reason: "missing-node-id" });
      return;
    }
    if (!index.nodesById.has(span.nodeId)) {
      unmappedSpans.push({
        spanId: span.spanId,
        spanName: span.name,
        requestedNodeId: span.nodeId,
        reason: "node-not-in-graph",
      });
      return;
    }
    exactNodeIdBySpanId.set(span.spanId, span.nodeId);
    const evidence = mutableNodes.get(span.nodeId) ?? { nodeId: span.nodeId, occurrences: [] };
    evidence.occurrences.push(occurrence);
    mutableNodes.set(span.nodeId, evidence);
  });

  const nodesById = new Map(
    [...mutableNodes].map(([nodeId, evidence]) => [nodeId, finalizeNodeEvidence(evidence)]),
  );
  const mutableEdges = new Map<string, MutableEdgeEvidence>();
  const transitions: RequestTransitionEvidence[] = [];
  const parentPairs = new Set<string>();

  for (const target of orderedSpans) {
    if (target.parentSpanId === undefined) continue;
    parentPairs.add(spanPair(target.parentSpanId, target.spanId));
    appendTransition(
      transitionOf("parent", target.parentSpanId, target, index, exactNodeIdBySpanId),
      target,
      occurrenceBySpanId,
      index,
      transitions,
      mutableEdges,
    );
  }

  if (includeSameTraceLinks) {
    const seenLinks = new Set<string>();
    for (const target of orderedSpans) {
      for (const link of target.links ?? []) {
        if (link.traceId !== trace.traceId || parentPairs.has(spanPair(link.spanId, target.spanId))) continue;
        const key = `${link.relation}\0${spanPair(link.spanId, target.spanId)}`;
        if (seenLinks.has(key)) continue;
        seenLinks.add(key);
        appendTransition(
          transitionOf(link.relation, link.spanId, target, index, exactNodeIdBySpanId),
          target,
          occurrenceBySpanId,
          index,
          transitions,
          mutableEdges,
        );
      }
    }
  }

  const edgesById = new Map(
    [...mutableEdges].map(([edgeId, evidence]) => [edgeId, finalizeEdgeEvidence(evidence)]),
  );
  const runtimeOnlyTransitions = transitions.filter((transition) => transition.disposition === "runtime-only").length;
  const ambiguousTransitions = transitions.filter((transition) => transition.disposition === "ambiguous").length;
  const observedTransitions = transitions.length - runtimeOnlyTransitions - ambiguousTransitions;
  return {
    traceId: trace.traceId,
    nodesById,
    edgesById,
    observedEdgeIds: new Set(edgesById.keys()),
    transitions,
    unmappedSpans,
    counts: {
      totalSpans: trace.spans.length,
      exactSpans: trace.spans.length - unmappedSpans.length,
      unmappedSpans: unmappedSpans.length,
      totalTransitions: transitions.length,
      observedTransitions,
      runtimeOnlyTransitions,
      ambiguousTransitions,
      observedStaticEdges: edgesById.size,
    },
  };
}

/**
 * Project exact evidence onto the nodes currently painted by React Flow. Semantic zoom mounts more
 * than one LOD at once, so an exact source lands on one representative in EACH semantic-depth
 * population: its detail card can glow while its package/service ancestor is already ready for the
 * outward cross-fade. Duplicate targets for one source are suppressed. Within a population, real
 * containment has first claim and Service-only frames/domains are conservative fallbacks.
 */
export function projectRequestGraphOverlay(
  overlay: Pick<RequestGraphOverlay, "nodesById">,
  visibleNodes: readonly Node[],
  index: GraphIndex,
  options: RequestGraphProjectionOptions = {},
): Map<string, ProjectedRequestNodeEvidence> {
  const visiblePopulations = visibleNodePopulations(visibleNodes);
  const clustering = clusteringFor(index);
  const domains = deriveServiceDomains(
    clustering,
    options.serviceGroupingMode,
    options.serviceGroupingTargetSize,
  );
  const accumulators = new Map<string, ProjectionAccumulator>();

  for (const [sourceId, evidence] of overlay.nodesById) {
    const projectedTargets = new Set<string>();
    for (const visibleIds of visiblePopulations.values()) {
      const target = visibleRepresentative(sourceId, visibleIds, index, clustering, domains.domainByLead);
      if (target === null || projectedTargets.has(target)) continue;
      projectedTargets.add(target);
      const direct = target === sourceId;
      const accumulator = accumulators.get(target) ?? {
        visibleNodeId: target,
        occurrences: [],
        inclusiveSpanMs: 0,
        firstSequence: Number.POSITIVE_INFINITY,
        statuses: [],
        eventCounts: emptyEventCounts(),
        directSourceIds: new Set<string>(),
        rollupSourceIds: new Set<string>(),
      };
      accumulator.occurrences.push(...evidence.occurrences);
      accumulator.inclusiveSpanMs += evidence.inclusiveSpanMs;
      accumulator.firstSequence = Math.min(accumulator.firstSequence, evidence.firstSequence);
      accumulator.statuses.push(...evidence.occurrences.map((occurrence) => occurrence.status));
      addEventCounts(accumulator.eventCounts, evidence.eventCounts);
      (direct ? accumulator.directSourceIds : accumulator.rollupSourceIds).add(sourceId);
      accumulators.set(target, accumulator);
    }
  }

  return new Map([...accumulators].map(([visibleNodeId, evidence]) => [visibleNodeId, {
    visibleNodeId,
    occurrenceCount: evidence.occurrences.length,
    inclusiveSpanMs: evidence.inclusiveSpanMs,
    activeWallMs: intervalUnionMs(evidence.occurrences),
    firstSequence: evidence.firstSequence,
    status: aggregateStatus(evidence.statuses),
    eventCounts: evidence.eventCounts,
    directSourceIds: [...evidence.directSourceIds].sort(),
    rollupSourceIds: [...evidence.rollupSourceIds].sort(),
  }]));
}

function visibleNodePopulations(visibleNodes: readonly Node[]): Map<string, Set<string>> {
  const populations = new Map<string, Set<string>>();
  for (const node of visibleNodes) {
    const semanticDepth = (node.data as { semanticDepth?: unknown }).semanticDepth;
    const key = typeof semanticDepth === "number" && Number.isFinite(semanticDepth)
      ? `depth:${semanticDepth}`
      : "default";
    const ids = populations.get(key) ?? new Set<string>();
    ids.add(node.id);
    populations.set(key, ids);
  }
  return populations;
}

function occurrenceOf(span: TimelineSpan, sequence: number, traceStart: bigint): RequestSpanOccurrence {
  const start = nano(span.startedAtUnixNano);
  const end = nano(span.endedAtUnixNano);
  const safeEnd = end < start ? start : end;
  return {
    spanId: span.spanId,
    ...(span.parentSpanId === undefined ? {} : { parentSpanId: span.parentSpanId }),
    sequence,
    startMs: nanoToMs(start - traceStart),
    endMs: nanoToMs(safeEnd - traceStart),
    durationMs: nanoToMs(safeEnd - start),
    status: span.status,
    eventCounts: countEvents(span.events),
  };
}

function finalizeNodeEvidence(evidence: MutableNodeEvidence): RequestNodeEvidence {
  const occurrences = evidence.occurrences.slice().sort((left, right) => left.sequence - right.sequence);
  return {
    nodeId: evidence.nodeId,
    occurrences,
    occurrenceCount: occurrences.length,
    inclusiveSpanMs: occurrences.reduce((sum, occurrence) => sum + occurrence.durationMs, 0),
    activeWallMs: intervalUnionMs(occurrences),
    firstSequence: Math.min(...occurrences.map((occurrence) => occurrence.sequence)),
    firstStartMs: Math.min(...occurrences.map((occurrence) => occurrence.startMs)),
    lastEndMs: Math.max(...occurrences.map((occurrence) => occurrence.endMs)),
    status: aggregateStatus(occurrences.map((occurrence) => occurrence.status)),
    eventCounts: occurrences.reduce((counts, occurrence) => addEventCounts(counts, occurrence.eventCounts), emptyEventCounts()),
  };
}

function transitionOf(
  relation: RequestTransitionRelation,
  sourceSpanId: string,
  target: TimelineSpan,
  index: GraphIndex,
  exactNodeIdBySpanId: ReadonlyMap<string, string>,
): RequestTransitionEvidence {
  const sourceNodeId = exactNodeIdBySpanId.get(sourceSpanId);
  const targetNodeId = exactNodeIdBySpanId.get(target.spanId);
  const transitionId = `${relation}:${sourceSpanId}->${target.spanId}`;
  if (sourceNodeId === undefined || targetNodeId === undefined) {
    return {
      transitionId,
      sourceSpanId,
      targetSpanId: target.spanId,
      ...(sourceNodeId === undefined ? {} : { sourceNodeId }),
      ...(targetNodeId === undefined ? {} : { targetNodeId }),
      relation,
      disposition: "runtime-only",
      candidateEdgeIds: [],
      reason: "unmapped-endpoint",
    };
  }
  const match = executionEdgeMatch(sourceNodeId, targetNodeId, index);
  return {
    transitionId,
    sourceSpanId,
    targetSpanId: target.spanId,
    sourceNodeId,
    targetNodeId,
    relation,
    disposition: match.disposition,
    candidateEdgeIds: match.edges.map((edge) => edge.id),
    ...(match.disposition === "runtime-only" ? { reason: "no-execution-edge" as const } : {}),
    ...(match.disposition === "ambiguous" ? { reason: "ambiguous-execution-edge" as const } : {}),
  };
}

function executionEdgeMatch(
  sourceNodeId: string,
  targetNodeId: string,
  index: GraphIndex,
): { disposition: RequestTransitionDisposition; edges: GraphEdge[] } {
  const between = (index.outEdges.get(sourceNodeId) ?? []).filter((edge) => edge.target === targetNodeId);
  const calls = between.filter((edge) => edge.kind === "calls");
  if (calls.length === 1) return { disposition: "observed", edges: calls };
  if (calls.length > 1) return { disposition: "ambiguous", edges: calls };
  const instantiates = between.filter((edge) => edge.kind === "instantiates");
  if (instantiates.length === 1) return { disposition: "observed", edges: instantiates };
  if (instantiates.length > 1) return { disposition: "ambiguous", edges: instantiates };
  return { disposition: "runtime-only", edges: [] };
}

function appendTransition(
  transition: RequestTransitionEvidence,
  target: TimelineSpan,
  occurrenceBySpanId: ReadonlyMap<string, RequestSpanOccurrence>,
  index: GraphIndex,
  transitions: RequestTransitionEvidence[],
  mutableEdges: Map<string, MutableEdgeEvidence>,
): void {
  transitions.push(transition);
  if (transition.disposition !== "observed") return;
  const edgeId = transition.candidateEdgeIds[0];
  const edge = index.edgesById.get(edgeId);
  const occurrence = occurrenceBySpanId.get(target.spanId);
  if (!edge || !occurrence) return;
  const edgeKind = edge.kind === "calls" ? "calls" : edge.kind === "instantiates" ? "instantiates" : null;
  if (edgeKind === null) return;
  const evidence: MutableEdgeEvidence = mutableEdges.get(edgeId) ?? {
    edgeId,
    kind: edgeKind,
    transitionIds: [],
    firstSequence: occurrence.sequence,
    statuses: [],
  };
  evidence.transitionIds.push(transition.transitionId);
  evidence.firstSequence = Math.min(evidence.firstSequence, occurrence.sequence);
  evidence.statuses.push(target.status);
  mutableEdges.set(edgeId, evidence);
}

function finalizeEdgeEvidence(evidence: MutableEdgeEvidence): RequestObservedEdgeEvidence {
  return {
    edgeId: evidence.edgeId,
    kind: evidence.kind,
    transitionIds: evidence.transitionIds,
    occurrenceCount: evidence.transitionIds.length,
    firstSequence: evidence.firstSequence,
    status: aggregateStatus(evidence.statuses),
  };
}

function visibleRepresentative(
  sourceId: string,
  visibleIds: ReadonlySet<string>,
  index: GraphIndex,
  clustering: ServiceClustering,
  domainByLead: ReadonlyMap<string, { id: string }>,
): string | null {
  if (visibleIds.has(sourceId)) return sourceId;
  const seen = new Set<string>([sourceId]);
  let ancestor = index.parentOf.get(sourceId) ?? null;
  while (ancestor !== null && !seen.has(ancestor)) {
    if (visibleIds.has(ancestor)) return ancestor;
    seen.add(ancestor);
    ancestor = index.parentOf.get(ancestor) ?? null;
  }

  const lead = serviceLeadOf(sourceId, index, clustering);
  if (lead === null) return null;
  const frameId = frameIdOf(lead);
  if (visibleIds.has(frameId)) return frameId;
  const domainId = domainByLead.get(lead)?.id;
  return domainId !== undefined && visibleIds.has(domainId) ? domainId : null;
}

function serviceLeadOf(sourceId: string, index: GraphIndex, clustering: ServiceClustering): string | null {
  const ancestors = index.ancestorsOf(sourceId);
  for (let offset = ancestors.length - 1; offset >= 0; offset -= 1) {
    const lead = clustering.leadOf.get(ancestors[offset].id);
    if (lead !== undefined) return lead;
  }
  return null;
}

function countEvents(events: readonly TimelineEvent[]): RequestEventCounts {
  const counts = emptyEventCounts();
  for (const event of events) {
    switch (event.type) {
      case "branch.taken": counts.branchTaken += 1; break;
      case "data.observe": counts.dataObserve += 1; break;
      case "loop.summary": counts.loopSummary += 1; break;
      case "async.handoff": counts.asyncHandoff += 1; break;
      case "exception": counts.exception += 1; break;
    }
  }
  return counts;
}

function emptyEventCounts(): RequestEventCounts {
  return { branchTaken: 0, dataObserve: 0, loopSummary: 0, asyncHandoff: 0, exception: 0 };
}

function addEventCounts(target: RequestEventCounts, source: RequestEventCounts): RequestEventCounts {
  target.branchTaken += source.branchTaken;
  target.dataObserve += source.dataObserve;
  target.loopSummary += source.loopSummary;
  target.asyncHandoff += source.asyncHandoff;
  target.exception += source.exception;
  return target;
}

function aggregateStatus(statuses: readonly TimelineSpan["status"][]): RequestEvidenceStatus {
  const distinct = new Set(statuses);
  if (distinct.size === 0) return "unset";
  if (distinct.size > 1) return "mixed";
  return statuses[0] ?? "unset";
}

function intervalUnionMs(occurrences: readonly Pick<RequestSpanOccurrence, "startMs" | "endMs">[]): number {
  const intervals = occurrences
    .map((occurrence) => ({ start: occurrence.startMs, end: Math.max(occurrence.startMs, occurrence.endMs) }))
    .sort((left, right) => left.start - right.start || left.end - right.end);
  if (intervals.length === 0) return 0;
  let total = 0;
  let start = intervals[0].start;
  let end = intervals[0].end;
  for (const interval of intervals.slice(1)) {
    if (interval.start <= end) {
      end = Math.max(end, interval.end);
    } else {
      total += end - start;
      start = interval.start;
      end = interval.end;
    }
  }
  return total + end - start;
}

function compareSpanTime(left: TimelineSpan, right: TimelineSpan): number {
  const start = compareNano(left.startedAtUnixNano, right.startedAtUnixNano);
  if (start !== 0) return start;
  const end = compareNano(left.endedAtUnixNano, right.endedAtUnixNano);
  return end !== 0 ? end : left.spanId.localeCompare(right.spanId);
}

function compareNano(left: string, right: string): number {
  const a = nano(left);
  const b = nano(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function nano(value: string): bigint {
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

function nanoToMs(value: bigint): number {
  return Number(value) / 1_000_000;
}

function spanPair(sourceSpanId: string, targetSpanId: string): string {
  return `${sourceSpanId}\0${targetSpanId}`;
}
