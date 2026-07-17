/**
 * Reconstruct one captured request as an occurrence-preserving execution graph for the shared
 * split pane. This is deliberately runtime data, not a filtered static `LogicFlows` tree: span IDs
 * keep repeated calls distinct, branch events expose only the observed path, and unmapped spans
 * remain visible without acquiring a guessed graph target. Runtime edges come from the trace's
 * causal structure; timestamps only order events owned by the same span and never invent a path
 * between sibling spans.
 */

import type { LogicFlows, RequestTrace, SyntheticNodeSnapshot, TimelineEvent, TimelineSpan } from "@meridian/core";
import type { GraphIndex } from "../graph/graphIndex";
import type {
  LogicEdgeSpec,
  LogicGraphSpec,
  LogicNodeData,
  LogicNodeSpec,
  RequestRuntimeCausalRelation,
  RequestRuntimeEvidence,
  TerminalData,
} from "./logicGraph";
import { deriveLogicGraphFromBodies } from "./logicGraph";
import { buildRequestTimeline } from "./requestTimelineModel";
import { correlateStaticRequestEdges } from "./requestStaticTraversal";
import {
  compactTraceValue,
  observedBranchValue,
  requestControlEventBadge,
} from "./requestEventPresentation";
import { NODE_EMPTY_EXPANSION_HEIGHT } from "../theme/nodeChrome";
import { requestSpanMomentId } from "./requestFlowAddress";

const NODE_WIDTH = 260;
const NODE_BASE_HEIGHT = 70;
const TERMINAL_HEIGHT = 38;

interface RequestMoment {
  id: string;
  node: LogicNodeSpec;
  outgoingLabel?: string;
  event?: Exclude<TimelineEvent, { type: "data.observe" }>;
  nestedNodes?: LogicNodeSpec[];
  nestedEdges?: LogicEdgeSpec[];
}

export function deriveRequestExecutionFlow(
  trace: RequestTrace,
  index: GraphIndex,
  flows: LogicFlows = {},
  requestFlowExpansionOverrides: ReadonlySet<string> = new Set<string>(),
  snapshots: readonly SyntheticNodeSnapshot[] = [],
): LogicGraphSpec {
  const timeline = buildRequestTimeline(trace);
  const prefix = `request:${trace.traceId}`;
  const spansById = new Map(trace.spans.map((span) => [span.spanId, span]));
  const snapshotsBySpanId = new Map(snapshots.map((snapshot) => [snapshot.spanId, snapshot]));
  const moments: RequestMoment[] = [];
  const momentsBySpanId = new Map<string, RequestMoment[]>();

  for (const row of timeline.rows) {
    const span = row.span;
    const orderedEvents = row.events.map(({ event }) => event);
    const targetId = span.nodeId !== undefined && index.nodesById.has(span.nodeId) ? span.nodeId : null;
    const parent = span.parentSpanId === undefined ? null : spansById.get(span.parentSpanId) ?? null;
    const values = orderedEvents
      .filter((event): event is Extract<TimelineEvent, { type: "data.observe" }> => event.type === "data.observe")
      .map((event) => `${event.name} = ${compactTraceValue(event.value)}`);
    const staticSteps = targetId === null ? undefined : flows[targetId];
    const capturedSnapshot = snapshotsBySpanId.get(span.spanId);
    // Both ids must agree. A stale/malformed runner result remains absent rather than painting one
    // occurrence's values onto another callable with the same display label.
    const snapshot = capturedSnapshot !== undefined && capturedSnapshot.nodeId === span.nodeId
      ? {
          input: capturedSnapshot.input,
          ...(capturedSnapshot.output === undefined ? {} : { output: capturedSnapshot.output }),
          ...(capturedSnapshot.error === undefined ? {} : { error: capturedSnapshot.error }),
        }
      : undefined;
    const controlEvents = orderedEvents.filter(isControlEvent);
    const spanMomentId = requestSpanMomentId(trace.traceId, span.spanId);
    // Expansion belongs to this exact occurrence, never its artifact target: repeated/recursive
    // calls can be opened independently. Every mapped callable with a real static body gets the
    // affordance; the empty override set makes the whole request compact on first open. A mapped
    // local callable without static steps uses the same honest empty expansion as the static graph.
    const expandable = targetId !== null;
    const hasStaticFlow = (staticSteps?.length ?? 0) > 0;
    const emptyFlow = expandable && !hasStaticFlow;
    const isExpanded = expandable && requestFlowExpansionOverrides.has(spanMomentId);
    const graft = isExpanded && hasStaticFlow && staticSteps !== undefined
      ? staticBodyGraft(spanMomentId, staticSteps, flows, index, requestFlowExpansionOverrides, trace, span)
      : null;
    const runtimeBadges = [
      // Control events become static-flow badges only when there is a static graph to annotate.
      // Empty resolved callables keep their runtime events as real sibling moments instead of
      // duplicating the same observation in the callable header.
      ...(hasStaticFlow ? controlEvents.map(requestControlEventBadge) : []),
      ...values,
    ];
    const runtime: RequestRuntimeEvidence = {
      kind: "span",
      status: span.status,
      durationMs: row.durationMs,
      detail: spanDetail(span, parent, row.linkedFrom),
      eventCount: span.events.length,
      ...(runtimeBadges.length > 0 ? { badges: runtimeBadges } : {}),
      ...(snapshot === undefined ? {} : { snapshot }),
    };
    const spanMoment: RequestMoment = {
      id: spanMomentId,
      node: runtimeNode(spanMomentId, spanLabel(span, index), targetId, runtime, {
        expandable,
        isExpanded,
        childCount: staticSteps?.length ?? 0,
        nestedChildCount: graft?.nodes.length ?? 0,
        emptyFlow,
      }),
      ...(graft === null ? {} : { nestedNodes: graft.nodes, nestedEdges: graft.edges }),
    };
    const spanMoments = [spanMoment];
    moments.push(spanMoment);

    for (const event of orderedEvents) {
      if (event.type === "data.observe") continue;
      if (hasStaticFlow && isControlEvent(event)) continue;
      const eventMoment = momentForEvent(prefix, span, event, targetId);
      moments.push(eventMoment);
      spanMoments.push(eventMoment);
    }
    momentsBySpanId.set(span.spanId, spanMoments);
  }

  const entryId = `${prefix}:entry`;
  const exitId = `${prefix}:exit`;
  const entryData: TerminalData = {
    targetId: null,
    isContainer: false,
    terminal: "entry",
    label: trace.name,
  };
  const exitData: TerminalData = {
    targetId: null,
    isContainer: false,
    terminal: "exit",
    label: trace.status === "error" ? "ERROR" : "EXIT",
  };
  const nodes: LogicNodeSpec[] = [
    {
      id: entryId,
      parentId: null,
      type: "terminal",
      data: entryData,
      width: terminalWidth(trace.name),
      height: TERMINAL_HEIGHT,
    },
    ...moments.flatMap((moment) => [moment.node, ...(moment.nestedNodes ?? [])]),
    {
      id: exitId,
      parentId: null,
      type: "terminal",
      data: exitData,
      width: 92,
      height: TERMINAL_HEIGHT,
    },
  ];

  const nestedEdges = moments.flatMap((moment) => moment.nestedEdges ?? []);
  const runtimeEdges: LogicEdgeSpec[] = [];
  const edgePairs = new Set<string>();
  const incoming = new Set<string>();
  const outgoing = new Set<string>();
  const adjacency = new Map<string, Set<string>>();
  let edgeIndex = 0;
  const addRuntimeEdge = (
    source: string,
    target: string,
    relation: RequestRuntimeCausalRelation,
    label?: string,
    rejectCycle = false,
  ): boolean => {
    if (source === target) return false;
    const pair = `${source}\0${target}`;
    if (edgePairs.has(pair)) return false;
    // Parent references are validated as a tree. Links and handoffs are looser producer data, so
    // refuse an explicit relation that would turn this occurrence graph back into a cycle.
    if (rejectCycle && isReachable(target, source, adjacency)) return false;
    edgePairs.add(pair);
    incoming.add(target);
    outgoing.add(source);
    const targets = adjacency.get(source) ?? new Set<string>();
    targets.add(target);
    adjacency.set(source, targets);
    runtimeEdges.push({
      id: `${prefix}:edge:${edgeIndex++}`,
      source,
      target,
      kind: label === undefined ? "seq" : "branch",
      ...(label === undefined ? {} : { label }),
      requestTraversal: {
        traceId: trace.traceId,
        basis: "runtime-causal",
        relation,
        sourceMomentId: source,
        targetMomentId: target,
      },
    });
    return true;
  };

  const declaredRoot = momentsBySpanId.get(trace.rootSpanId)?.[0];
  if (declaredRoot !== undefined) addRuntimeEdge(entryId, declaredRoot.id, "trace-entry");

  // A span occurrence and its own visible events are the only runtime moments for which captured
  // time establishes a deterministic local sequence. A child's timestamp never splices it into
  // this chain: parent/child causality is represented separately below.
  for (const spanMoments of momentsBySpanId.values()) {
    for (let index = 0; index < spanMoments.length - 1; index += 1) {
      const source = spanMoments[index]!;
      addRuntimeEdge(source.id, spanMoments[index + 1]!.id, "span-local-order", source.outgoingLabel);
    }
  }

  // Real call parents are stronger than same-trace links for the same pair. Multiple children fan
  // out from the parent occurrence; even non-overlapping siblings never acquire a guessed A -> B.
  for (const row of timeline.rows) {
    const parentId = row.span.parentSpanId;
    const parentMoment = parentId === undefined ? undefined : momentsBySpanId.get(parentId)?.[0];
    const childMoment = momentsBySpanId.get(row.span.spanId)?.[0];
    if (parentMoment !== undefined && childMoment !== undefined) {
      addRuntimeEdge(parentMoment.id, childMoment.id, "parent-child");
    }
  }

  // A link belongs to the target span and names its causal source. Cross-trace and dangling links
  // remain timeline metadata only; neither can be joined safely to a moment in this request.
  for (const row of timeline.rows) {
    const targetMoment = momentsBySpanId.get(row.span.spanId)?.[0];
    if (targetMoment === undefined) continue;
    const links = [...(row.span.links ?? [])].sort(compareLinks);
    for (const link of links) {
      if (link.traceId !== trace.traceId) continue;
      const sourceMoment = momentsBySpanId.get(link.spanId)?.[0];
      if (sourceMoment === undefined) continue;
      addRuntimeEdge(sourceMoment.id, targetMoment.id, "span-link", `${link.relation} link`, true);
    }
  }

  // An async handoff event is more precise than a span-level link because it identifies the exact
  // source moment. It can coexist with a parent edge: one records call containment, the other the
  // observed scheduling/continuation site.
  for (const spanMoments of momentsBySpanId.values()) {
    for (const moment of spanMoments) {
      const event = moment.event;
      if (event?.type !== "async.handoff" || event.targetSpanId === undefined) continue;
      const targetMoment = momentsBySpanId.get(event.targetSpanId)?.[0];
      if (targetMoment === undefined) continue;
      addRuntimeEdge(moment.id, targetMoment.id, "async-handoff", `${event.mode} handoff`, true);
    }
  }

  // Invalid/unvalidated producer input can contain additional unparented, unlinked roots. Keep
  // them in the same visual frame without inventing an ordering between them.
  for (const spanMoments of momentsBySpanId.values()) {
    const spanMoment = spanMoments[0];
    if (spanMoment !== undefined && !incoming.has(spanMoment.id)) {
      addRuntimeEdge(entryId, spanMoment.id, "trace-entry");
    }
  }

  // The shared exit is a visual join for every causal leaf, not a bridge between those leaves.
  // This keeps concurrent branches legible while preserving their independence.
  if (moments.length === 0) {
    addRuntimeEdge(entryId, exitId, "trace-exit");
  } else {
    for (const moment of moments) {
      if (!outgoing.has(moment.id)) addRuntimeEdge(moment.id, exitId, "trace-exit", moment.outgoingLabel);
    }
  }

  return { nodes, edges: [...nestedEdges, ...runtimeEdges] };
}

/**
 * Project one synthetic occurrence into a focused flow-player spec. The selected runtime card stays
 * as the titled container while its static body is expanded underneath it; every other request
 * occurrence is omitted. Captured values move to the dedicated inspector, so the canvas keeps only
 * compact runtime context and positively-correlated observed edges.
 */
export function deriveFocusedRequestExecutionFlow(
  trace: RequestTrace,
  index: GraphIndex,
  flows: LogicFlows,
  selectedMomentId: string,
  requestFlowExpansionOverrides: ReadonlySet<string> = new Set<string>(),
  snapshots: readonly SyntheticNodeSnapshot[] = [],
): LogicGraphSpec {
  const expanded = new Set(requestFlowExpansionOverrides);
  expanded.add(selectedMomentId);
  const full = deriveRequestExecutionFlow(trace, index, flows, expanded, snapshots);
  return focusRequestExecutionFlow(full, selectedMomentId);
}

export function focusRequestExecutionFlow(
  spec: LogicGraphSpec,
  selectedMomentId: string,
): LogicGraphSpec {
  const selected = spec.nodes.find((node) => node.id === selectedMomentId);
  if (selected === undefined) return { nodes: [], edges: [] };
  const byId = new Map(spec.nodes.map((node) => [node.id, node]));
  const included = new Set<string>();
  for (const node of spec.nodes) {
    let current: LogicNodeSpec | undefined = node;
    while (current !== undefined) {
      if (current.id === selectedMomentId) {
        included.add(node.id);
        break;
      }
      current = current.parentId === null ? undefined : byId.get(current.parentId);
    }
  }
  const nodes = spec.nodes
    .filter((node) => included.has(node.id))
    .map((node) => node.id === selectedMomentId ? focusedRuntimeNode(node) : node);
  const edges = spec.edges.filter((edge) => included.has(edge.source) && included.has(edge.target));
  return { nodes, edges };
}

function focusedRuntimeNode(node: LogicNodeSpec): LogicNodeSpec {
  if (!("runtime" in node.data) || node.data.runtime === undefined) return node;
  const { snapshot: _snapshot, ...runtimeEvidence } = node.data.runtime;
  const runtime: RequestRuntimeEvidence = {
    ...runtimeEvidence,
    focused: true,
  };
  return {
    ...node,
    data: {
      ...node.data,
      expandable: false,
      runtime,
    },
  };
}

function momentForEvent(
  prefix: string,
  span: TimelineSpan,
  event: Exclude<TimelineEvent, { type: "data.observe" }>,
  targetId: string | null,
): RequestMoment {
  const id = `${prefix}:event:${span.spanId}:${event.eventId}`;
  const eventView = runtimeForEvent(event);
  return {
    id,
    node: runtimeNode(id, eventView.label, targetId, eventView.runtime),
    event,
    ...(eventView.outgoingLabel === undefined ? {} : { outgoingLabel: eventView.outgoingLabel }),
  };
}

function runtimeForEvent(event: Exclude<TimelineEvent, { type: "data.observe" }>): {
  label: string;
  runtime: RequestRuntimeEvidence;
  outgoingLabel?: string;
} {
  if (event.type === "branch.taken") {
    const observedValue = observedBranchValue(event);
    return {
      label: event.condition,
      runtime: {
        kind: "branch",
        detail: `${observedValue} · ${event.source.file}:${event.source.line}`,
        badges: [`site ${event.siteId}`],
      },
      outgoingLabel: `${event.pathId} · ${observedValue}`,
    };
  }
  if (event.type === "loop.summary") {
    return {
      label: event.label,
      runtime: {
        kind: "loop",
        detail: `${event.iterations} iteration${event.iterations === 1 ? "" : "s"}${event.truncated ? " · truncated" : ""}`,
        badges: [`site ${event.siteId}`],
      },
    };
  }
  if (event.type === "exception") {
    return {
      label: `${event.handled ? "Caught" : "Threw"} ${event.exceptionType}`,
      runtime: {
        kind: "exception",
        status: event.handled ? "unset" : "error",
        detail: event.message ?? (event.handled ? "handled by the request" : "propagated to the caller"),
        badges: [event.handled ? "handled" : "unhandled"],
      },
    };
  }
  return {
    label: `${handoffLabel(event.mode)} handoff`,
    runtime: {
      kind: "async",
      detail: event.targetSpanId ? `target span ${shortId(event.targetSpanId)}` : "target span not captured",
      badges: [`site ${event.siteId}`],
    },
  };
}

function runtimeNode(
  id: string,
  label: string,
  targetId: string | null,
  runtime: RequestRuntimeEvidence,
  options: { expandable?: boolean; isExpanded?: boolean; childCount?: number; nestedChildCount?: number; emptyFlow?: boolean } = {},
): LogicNodeSpec {
  const badgeRows = Math.min(runtime.badges?.length ?? 0, 3);
  const snapshotRows = runtime.snapshot === undefined ? 0 : 2;
  const expandable = options.expandable ?? false;
  const isExpanded = options.isExpanded ?? false;
  const nestedChildCount = options.nestedChildCount ?? 0;
  const emptyFlow = options.emptyFlow === true;
  const isContainer = isExpanded && (nestedChildCount > 0 || emptyFlow);
  const data: LogicNodeData = {
    logicKind: "call",
    label,
    targetId,
    resolution: targetId === null ? "unresolved" : "resolved",
    expandable,
    isExpanded,
    isContainer,
    compact: false,
    callScope: targetId === null ? null : "internal",
    greyed: false,
    provenance: null,
    // Capability is stable across collapsed/expanded presentation. Keep the source body's potential
    // child count on the card; nestedChildCount only decides whether this particular layout frames
    // rendered children. Otherwise a collapsed expandable request span looks like an empty leaf.
    childCount: options.childCount ?? nestedChildCount,
    ...(emptyFlow ? { emptyFlow: true } : {}),
    runtime,
  };
  const node: LogicNodeSpec = {
    id,
    parentId: null,
    type: "block",
    data,
  };
  if (!isContainer) {
    node.width = Math.max(NODE_WIDTH, Math.min(360, 105 + label.length * 7));
    node.height = NODE_BASE_HEIGHT + badgeRows * 18 + snapshotRows * 20;
  } else if (emptyFlow) {
    node.width = Math.max(NODE_WIDTH, Math.min(360, 105 + label.length * 7));
    node.height = Math.max(
      NODE_EMPTY_EXPANSION_HEIGHT,
      NODE_BASE_HEIGHT + badgeRows * 18 + snapshotRows * 20,
    );
  }
  return node;
}

function staticBodyGraft(
  spanMomentId: string,
  steps: LogicFlows[string],
  flows: LogicFlows,
  index: GraphIndex,
  requestFlowExpansionOverrides: ReadonlySet<string>,
  trace: RequestTrace,
  span: TimelineSpan,
): { nodes: LogicNodeSpec[]; edges: LogicEdgeSpec[] } | null {
  const execPrefix = `${spanMomentId}:exec`;
  const spec = deriveLogicGraphFromBodies(
    execPrefix,
    [{ label: "observed span", body: steps }],
    flows,
    index,
    requestFlowExpansionOverrides,
    {
      hideGreyed: false,
      nestByService: false,
      ...(span.nodeId ? { sourceOwnerId: span.nodeId } : {}),
    },
  );
  if (spec.nodes.length === 0) return null;
  const correlatedEdges = correlateStaticRequestEdges({
    edges: spec.edges,
    execPrefix,
    steps,
    flows,
    expansionOverrides: requestFlowExpansionOverrides,
    trace,
    span,
  });
  return {
    nodes: spec.nodes.map((node) => node.parentId === null ? { ...node, parentId: spanMomentId } : node),
    // LogicGraphBuilder numbers edges from e0 for every spec. Namespace them per occurrence just
    // like the nodes so repeated/recursive spans cannot collide in React Flow.
    edges: correlatedEdges.map((edge) => ({ ...edge, id: `${execPrefix}:${edge.id}` })),
  };
}

function isControlEvent(
  event: TimelineEvent,
): event is Extract<TimelineEvent, { type: "branch.taken" | "loop.summary" }> {
  return event.type === "branch.taken" || event.type === "loop.summary";
}

function spanLabel(span: TimelineSpan, index: GraphIndex): string {
  return span.nodeId === undefined ? span.name : index.nodesById.get(span.nodeId)?.displayName ?? span.name;
}

function spanDetail(
  span: TimelineSpan,
  parent: TimelineSpan | null,
  linkedFrom: { spanId: string; relation: "async" | "message" | "detached" } | null,
): string {
  if (parent !== null) return `called by ${parent.name}`;
  if (linkedFrom !== null) return `${linkedFrom.relation} from ${shortId(linkedFrom.spanId)}`;
  return span.kind === "server" ? "request entrypoint" : "root span";
}

function handoffLabel(mode: "awaited" | "detached" | "callback"): string {
  if (mode === "awaited") return "Awaited async";
  if (mode === "detached") return "Detached async";
  return "Callback";
}

function shortId(id: string): string {
  return id.length <= 10 ? id : `${id.slice(0, 5)}…${id.slice(-4)}`;
}

function terminalWidth(label: string): number {
  return Math.max(190, Math.min(360, 96 + label.length * 7));
}

function compareLinks(
  left: NonNullable<TimelineSpan["links"]>[number],
  right: NonNullable<TimelineSpan["links"]>[number],
): number {
  return left.spanId.localeCompare(right.spanId) || left.relation.localeCompare(right.relation);
}

function isReachable(source: string, target: string, adjacency: ReadonlyMap<string, ReadonlySet<string>>): boolean {
  const pending = [source];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current === target) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const next of adjacency.get(current) ?? []) pending.push(next);
  }
  return false;
}
