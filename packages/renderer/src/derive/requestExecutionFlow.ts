/**
 * Reconstruct one captured request as an occurrence-preserving execution graph for the shared
 * split pane. This is deliberately runtime data, not a filtered static `LogicFlows` tree: span IDs
 * keep repeated calls distinct, branch events expose only the observed path, and unmapped spans
 * remain visible without acquiring a guessed graph target. Runtime edges come from the trace's
 * causal structure; timestamps only order events owned by the same span and never invent a path
 * between sibling spans.
 */

import type { LogicFlows, RequestTrace, TimelineEvent, TimelineSpan } from "@meridian/core";
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
): LogicGraphSpec {
  const timeline = buildRequestTimeline(trace);
  const prefix = `request:${trace.traceId}`;
  const spansById = new Map(trace.spans.map((span) => [span.spanId, span]));
  const moments: RequestMoment[] = [];
  const momentsBySpanId = new Map<string, RequestMoment[]>();

  for (const row of timeline.rows) {
    const span = row.span;
    const orderedEvents = row.events.map(({ event }) => event);
    const targetId = span.nodeId !== undefined && index.nodesById.has(span.nodeId) ? span.nodeId : null;
    const parent = span.parentSpanId === undefined ? null : spansById.get(span.parentSpanId) ?? null;
    const values = orderedEvents
      .filter((event): event is Extract<TimelineEvent, { type: "data.observe" }> => event.type === "data.observe")
      .map((event) => `${event.name} = ${compactValue(event.value)}`);
    const staticSteps = targetId === null ? undefined : flows[targetId];
    const controlEvents = orderedEvents.filter(isControlEvent);
    const spanMomentId = `${prefix}:span:${span.spanId}`;
    // Expansion belongs to this exact occurrence, never its artifact target: repeated/recursive
    // calls can be opened independently. Every mapped callable with a real static body gets the
    // affordance; the empty override set makes the whole request compact on first open.
    const expandable = staticSteps !== undefined && staticSteps.length > 0;
    const isExpanded = expandable && requestFlowExpansionOverrides.has(spanMomentId);
    const graft = isExpanded && staticSteps !== undefined
      ? staticBodyGraft(spanMomentId, staticSteps, flows, index, requestFlowExpansionOverrides, trace, span)
      : null;
    const runtimeBadges = [
      // Keep observed decisions on the occurrence header in BOTH states. When expanded, the
      // source/path join additionally paints the exact static edges without changing the captured
      // runtime chain or duplicating those events as standalone nodes.
      ...(expandable ? controlEvents.map(controlEventBadge) : []),
      ...values,
    ];
    const runtime: RequestRuntimeEvidence = {
      kind: "span",
      status: span.status,
      durationMs: row.durationMs,
      detail: spanDetail(span, parent, row.linkedFrom),
      eventCount: span.events.length,
      ...(runtimeBadges.length > 0 ? { badges: runtimeBadges } : {}),
    };
    const spanMoment: RequestMoment = {
      id: spanMomentId,
      node: runtimeNode(spanMomentId, spanLabel(span, index), targetId, runtime, {
        expandable,
        isExpanded,
        nestedChildCount: graft?.nodes.length ?? 0,
      }),
      ...(graft === null ? {} : { nestedNodes: graft.nodes, nestedEdges: graft.edges }),
    };
    const spanMoments = [spanMoment];
    moments.push(spanMoment);

    for (const event of orderedEvents) {
      if (event.type === "data.observe") continue;
      if (expandable && isControlEvent(event)) continue;
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
    const observedValue = event.valueName && event.value !== undefined
      ? `${event.valueName} = ${compactValue(event.value)}`
      : `outcome = ${compactValue(event.outcome)}`;
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
  options: { expandable?: boolean; isExpanded?: boolean; nestedChildCount?: number } = {},
): LogicNodeSpec {
  const badgeRows = Math.min(runtime.badges?.length ?? 0, 3);
  const expandable = options.expandable ?? false;
  const isExpanded = options.isExpanded ?? false;
  const nestedChildCount = options.nestedChildCount ?? 0;
  const isContainer = isExpanded && nestedChildCount > 0;
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
    childCount: nestedChildCount,
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
    node.height = NODE_BASE_HEIGHT + badgeRows * 18;
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
    { hideGreyed: false, nestByService: false },
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

function controlEventBadge(
  event: Extract<TimelineEvent, { type: "branch.taken" | "loop.summary" }>,
): string {
  if (event.type === "loop.summary") {
    return `${event.iterations} iteration${event.iterations === 1 ? "" : "s"} · ${event.label}`;
  }
  const observed = event.valueName && event.value !== undefined
    ? `${event.valueName} = ${compactValue(event.value)}`
    : `outcome = ${compactValue(event.outcome)}`;
  return `${event.pathId} · ${observed}`;
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

function compactValue(value: unknown): string {
  let rendered: string;
  try {
    rendered = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    rendered = String(value);
  }
  if (rendered.length <= 42) return rendered;
  return `${rendered.slice(0, 39)}…`;
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
