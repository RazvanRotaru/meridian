/**
 * Turn generic causal graph facts into the quiet sequence projection.
 *
 * Extraction owns identity (Promise resources and IPC channels); core owns bounded traversal; this
 * adapter owns only presentation. It deliberately has no product/framework names and falls back to
 * the ordinary intraprocedural timeline when a selection has no causal resource neighborhood.
 */

import {
  branchKindOf,
  composeCausalSlice,
  pathRole,
  type CausalArc,
  type CausalSlice,
  type FlowStep,
  type GraphArtifact,
  type GraphEdge,
  type GraphNode,
  type LogicFlows,
  type NodeId,
} from "@meridian/core";
import type { GraphIndex } from "../graph/graphIndex";
import type {
  SequenceFrame,
  SequenceMessageTone,
  SequenceParticipant,
  SequenceRow,
  SequenceTimelineModel,
} from "./sequenceTimelineModel";

const MAX_PARTICIPANTS = 8;
const MAX_ROWS = 32;
const OVERFLOW_PARTICIPANT_ID = "causal:participant-overflow";
const CAUSAL_MAX_DEPTH = 8;
const CAUSAL_MAX_NODES = 128;
const PREDECESSOR_MAX_DEPTH = 3;
const CORRIDOR_KINDS = new Set<CausalArc["kind"]>(["call", "instantiate", "send", "handle"]);

export function causalSequenceTimelineFor(
  artifact: GraphArtifact,
  rootId: NodeId,
  index: GraphIndex,
): SequenceTimelineModel | null {
  // A returned/settled Promise is the stable identity of the lifecycle, while the methods around
  // it are merely entry points into that lifecycle. Discover that identity first and then compose
  // from it so selecting the waiter, the settler, or the resource produces the same causal story.
  const discovery = composeCausalSlice(
    { nodes: artifact.nodes, edges: artifact.edges, seedIds: [rootId] },
    { maxDepth: 2, maxNodes: 32 },
  );
  const promiseSeed = nearestUniqueResource(discovery, index, "promise")?.id ?? null;
  const slice = composeCausalSlice(
    { nodes: artifact.nodes, edges: artifact.edges, seedIds: [promiseSeed ?? rootId] },
    { maxDepth: CAUSAL_MAX_DEPTH, maxNodes: CAUSAL_MAX_NODES },
  );
  if (slice.arcs.length === 0) return null;

  const flows = readLogicFlows(artifact);
  return promiseTimeline(slice, flows, index) ?? channelTimeline(slice, index);
}

function promiseTimeline(
  slice: CausalSlice,
  flows: LogicFlows,
  index: GraphIndex,
): SequenceTimelineModel | null {
  const resource = nearestUniqueResource(slice, index, "promise");
  if (!resource) return null;
  const incident = slice.arcs.filter((arc) =>
    (arc.source === resource.id || arc.target === resource.id)
    && ["create", "alias", "resolve", "reject", "await"].includes(arc.kind));
  if (!incident.some((arc) => arc.kind === "await" || arc.kind === "resolve" || arc.kind === "reject")) {
    return null;
  }

  const aliases = incident.filter((arc) => arc.kind === "alias");
  const creates = incident.filter((arc) => arc.kind === "create");
  const awaits = incident.filter((arc) => arc.kind === "await");
  const resolves = incident.filter((arc) => arc.kind === "resolve");
  const rejects = incident.filter((arc) => arc.kind === "reject");
  const directUpstream = upstreamCorridor(slice, [...resolves, ...rejects].map((arc) => arc.source), index);
  const expandedUpstream = expandPredecessorCorridors(directUpstream, flows, index);
  const upstream = expandedUpstream.arcs;
  const downstream = downstreamCorridor(slice, awaits, flows, index);
  const builder = new CausalTimelineBuilder(index);
  // Caller first, owning component second, resource last: the familiar sequence-diagram reading
  // direction stays intact even though the Promise node seeded discovery.
  awaits.forEach((arc) => builder.actor(arc.target));
  if (awaits.length === 0) {
    [...resolves, ...rejects].slice(0, 1).forEach((arc) => builder.actor(arc.source));
  }
  // Reserve the Promise before a long IPC/call corridor reaches the participant guard. It is moved
  // back to the visual right edge after every actor has been registered.
  const promise = builder.resource(resource, "Promise barrier");
  prewarmCorridor(builder, upstream, index);
  [...creates, ...aliases, ...resolves, ...rejects].forEach((arc) => builder.actor(arc.source));
  prewarmCorridor(builder, downstream, index);
  builder.moveParticipantToEnd(promise);

  for (const arc of creates) {
    builder.message(
      builder.actor(arc.source),
      promise,
      `creates ${resource.displayName}`,
      "call",
      arc.source,
    );
  }
  if (creates.length > 0) builder.note(promise, `${resource.displayName} · pending`, "wait");

  for (const arc of awaits) {
    const awaiter = arc.target;
    const returned = matchingReturnAlias(awaiter, aliases, flows, edgeSite(index, arc.edgeId));
    const target = returned?.source ?? null;
    const label = returned
      ? withCallSuffix(`await ${callableLabel(index, returned.source)}`)
      : `await ${resource.displayName}`;
    builder.message(builder.actor(awaiter), target ? builder.actor(target) : promise, label, "await", target);
    builder.note(builder.actor(awaiter), `blocked on ${resource.displayName}`, "wait");
  }

  // Triggers are common to both settlement outcomes. Keeping the corridor outside the alt frame
  // avoids duplicating an RPC/event delivery merely because the final settlement may resolve or
  // reject the same Promise.
  renderCorridor(builder, upstream, index, flows);

  const successStart = builder.rowCount;
  for (const arc of resolves) {
    builder.message(
      builder.actor(arc.source),
      promise,
      resolves.length > 0 && rejects.length > 0
        ? withCallSuffix(callableLabel(index, arc.source))
        : `${callableLabel(index, arc.source)} · resolves`,
      "await",
      arc.source,
    );
  }
  if (resolves.length > 0) {
    for (const arc of awaits) {
      builder.message(promise, builder.actor(arc.target), "wait completes", "await", arc.target, "return");
    }
    // The core slice already source-orders effects after the await boundary. Render that evidence
    // directly instead of replacing it with a generic "continues" note.
    renderCorridor(builder, downstream, index, flows);
  }
  const successEnd = builder.rowCount - 1;

  const failureStart = builder.rowCount;
  for (const arc of rejects) {
    builder.message(
      builder.actor(arc.source),
      promise,
      resolves.length > 0 && rejects.length > 0
        ? `${callableLabel(index, arc.source)}(error)`
        : `${callableLabel(index, arc.source)}(error) · rejects`,
      "await",
      arc.source,
    );
  }
  if (rejects.length > 0) {
    for (const arc of awaits) {
      builder.message(promise, builder.actor(arc.target), "wait rejects", "await", arc.target, "return");
    }
  }
  const failureEnd = builder.rowCount - 1;

  if (resolves.length > 0 && rejects.length > 0 && successEnd >= successStart && failureEnd >= failureStart) {
    builder.frame({
      id: "causal:promise-outcome",
      kind: "alt",
      label: "Promise resolves",
      startRow: successStart,
      endRow: failureEnd,
      separators: [{ row: failureStart, label: "Promise rejects" }],
    });
  }
  return builder.finish(expandedUpstream.truncated || projectionWasTruncated(slice, [
    {
      direction: "backward",
      nodeIds: [
        resource.id,
        ...resolves.map((arc) => arc.source),
        ...rejects.map((arc) => arc.source),
        ...directUpstream.flatMap((arc) => [arc.source, arc.target]),
      ],
    },
    {
      direction: "forward",
      // This projection intentionally shows only direct effects after the await. A deep call tree
      // below one of those effects is outside its promise and must not make the focused view look
      // incomplete; a cut at the resource/awaiter boundary does.
      nodeIds: [resource.id, ...awaits.map((arc) => arc.target)],
    },
  ]));
}

function channelTimeline(slice: CausalSlice, index: GraphIndex): SequenceTimelineModel | null {
  const channel = nearestUniqueResource(slice, index, "channel");
  if (!channel) return null;
  const sends = slice.arcs.filter((arc) => arc.kind === "send" && arc.target === channel.id);
  const handles = slice.arcs.filter((arc) => arc.kind === "handle" && arc.source === channel.id);
  if (sends.length === 0 && handles.length === 0) return null;

  const builder = new CausalTimelineBuilder(index);
  sends.forEach((arc) => builder.actor(arc.source));
  const boundary = builder.resource(channel, channel.location.file.replace(/^\(|\)$/g, "") || "IPC channel");
  handles.forEach((arc) => builder.actor(arc.target));
  for (const arc of sends) {
    builder.message(builder.actor(arc.source), boundary, `send · ${channel.displayName}`, "detached", arc.source);
  }
  if (slice.confidence < 1) {
    builder.note(boundary, `candidate correlation · ${Math.round(slice.confidence * 100)}% confidence`, "guard");
  }
  for (const arc of handles) {
    builder.message(boundary, builder.actor(arc.target), `deliver · ${channel.displayName}`, "callback", arc.target);
  }
  return builder.finish(projectionWasTruncated(slice, [
    { nodeIds: [channel.id], direction: "backward" },
    { nodeIds: [channel.id], direction: "forward" },
  ]));
}

interface ProjectedCorridor {
  nodeIds: readonly NodeId[];
  direction: "backward" | "forward";
}

/**
 * The core composer explores a wider neighborhood than this focused projection renders. A deep
 * sibling below the resumed awaiter can therefore exhaust the slice bound even though every row
 * selected for the sequence is complete. Surface truncation only when the admitted node cap was
 * reached, or when a corridor that is actually rendered intersects the exact traversal frontier
 * in its causal direction. This preserves the warning for a genuinely cut trigger/consequence
 * chain without a false badge for unrelated implementation branches.
 */
function projectionWasTruncated(
  slice: CausalSlice,
  corridors: readonly ProjectedCorridor[],
): boolean {
  if (!slice.truncated) return false;

  return corridors.some(({ nodeIds, direction }) => {
    const projectedNodeIds = new Set(nodeIds);
    const frontier = direction === "backward"
      ? slice.truncationFrontier.backward
      : slice.truncationFrontier.forward;
    return frontier.some((nodeId) => projectedNodeIds.has(nodeId));
  });
}

/** Runtime arcs that can form a causal corridor without treating Promise aliases as events. */
function corridorCandidates(slice: CausalSlice, direction: "upstream" | "downstream"): CausalArc[] {
  const depthByNode = new Map(slice.nodes.map((entry) => [
    entry.id,
    direction === "upstream" ? entry.backwardDepth : entry.forwardDepth,
  ]));
  return slice.arcs.filter((arc) => {
    if (!CORRIDOR_KINDS.has(arc.kind)) return false;
    const sourceDepth = depthByNode.get(arc.source);
    const targetDepth = depthByNode.get(arc.target);
    if (sourceDepth === null || sourceDepth === undefined || targetDepth === null || targetDepth === undefined) {
      return false;
    }
    return direction === "upstream" ? sourceDepth > targetDepth : targetDepth > sourceDepth;
  });
}

/** Every proven call/IPC arc that leads into one of the Promise's settlement callables. */
function upstreamCorridor(
  slice: CausalSlice,
  settlementSources: readonly NodeId[],
  index: GraphIndex,
): CausalArc[] {
  const candidates = preferRuntimeDeliveries(corridorCandidates(slice, "upstream"));
  const reachable = new Set(settlementSources);
  const selected = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const arc of candidates) {
      if (!reachable.has(arc.target) || selected.has(arc.edgeId)) continue;
      selected.add(arc.edgeId);
      if (!reachable.has(arc.source)) {
        reachable.add(arc.source);
        changed = true;
      }
    }
  }
  return sortCorridor(candidates.filter((arc) => selected.has(arc.edgeId)), slice, index, "upstream");
}

/**
 * A handler's ordinary callers usually install/configure that handler; the incoming channel
 * delivery is what invokes it at runtime. When both exist, follow the handle edge exclusively.
 * This also prevents unit tests that call an RPC endpoint directly from becoming competing roots
 * of the production sequence.
 */
function preferRuntimeDeliveries(arcs: readonly CausalArc[]): CausalArc[] {
  const targetsWithDelivery = new Set(
    arcs.filter((arc) => arc.kind === "handle").map((arc) => arc.target),
  );
  return arcs.filter((arc) => !targetsWithDelivery.has(arc.target) || arc.kind === "handle");
}

type FlowCall = Extract<FlowStep, { kind: "call" }>;

interface FlowCallOccurrence {
  call: FlowCall;
  /** Calls proven to occur earlier on this exact structured path. */
  predecessors: FlowCall[];
  /** Catch is a failure-only sibling of the try success path. */
  inCatch: boolean;
}

interface ExpandedCorridor {
  arcs: CausalArc[];
  truncated: boolean;
}

/**
 * A call/send on the direct causal path may have required work immediately before it in the same
 * callable. Function-level graph traversal cannot see that sibling relationship: both calls point
 * outward from the caller. Recover it only when logicFlow and edge call-site anchors prove one
 * unambiguous, non-catch occurrence, then expand resolved calls made by that predecessor.
 */
function expandPredecessorCorridors(
  direct: readonly CausalArc[],
  flows: LogicFlows,
  index: GraphIndex,
): ExpandedCorridor {
  const directIds = new Set(direct.map((arc) => arc.edgeId));
  // In a multi-boundary path, the earliest send is the external trigger and is already a useful
  // start of the sequence. Expanding all work before it turns a focused flow into application
  // bootstrap. The send nearest settlement may still have ordered prerequisites (for example a
  // replay immediately before an acknowledgement RPC), so only that send expands. A single-send
  // path retains the ordinary predecessor behavior.
  const nearestSettlementSendId = [...direct].reverse().find((arc) => arc.kind === "send")?.edgeId ?? null;
  const emitted = new Set<string>();
  const result: CausalArc[] = [];
  let truncated = false;

  const appendExpanded = (arc: CausalArc, depth: number): void => {
    if (directIds.has(arc.edgeId) || emitted.has(arc.edgeId)) return;
    emitted.add(arc.edgeId);
    result.push(arc);
    if (arc.kind !== "call" && arc.kind !== "instantiate") {
      return;
    }
    const children = successCorridorCalls(flows[arc.target] ?? [])
      .map((call) => resolvedArcForFlowCall(arc.target, call, index))
      .filter((child): child is CausalArc => child !== null);
    if (depth >= PREDECESSOR_MAX_DEPTH) {
      if (children.some((child) => !directIds.has(child.edgeId) && !emitted.has(child.edgeId))) {
        truncated = true;
      }
      return;
    }
    for (const child of children) {
      appendExpanded(child, depth + 1);
    }
  };

  for (const boundary of direct) {
    if (boundary.kind === "call" || (boundary.kind === "send" && boundary.edgeId === nearestSettlementSendId)) {
      const occurrence = uniqueSuccessOccurrence(boundary, flows, index);
      if (occurrence) {
        for (const predecessor of occurrence.predecessors) {
          const arc = resolvedArcForFlowCall(boundary.source, predecessor, index);
          if (arc) appendExpanded(arc, 0);
        }
      }
    }
    if (!emitted.has(boundary.edgeId)) {
      emitted.add(boundary.edgeId);
      result.push(boundary);
    }
  }
  return { arcs: result, truncated };
}

function uniqueSuccessOccurrence(
  boundary: CausalArc,
  flows: LogicFlows,
  index: GraphIndex,
): FlowCallOccurrence | null {
  const edge = index.edgesById.get(boundary.edgeId);
  const sites = edge?.callSites ?? [];
  if (sites.length === 0) return null;
  const matches = flowCallOccurrences(flows[boundary.source] ?? [])
    .filter((occurrence) => !occurrence.inCatch)
    .filter((occurrence) => occurrence.call.source !== undefined
      && sites.some((site) => sameSourceLine(occurrence.call.source!, site)));
  // Two success-path occurrences cannot be ordered relative to the aggregate graph edge without
  // occurrence-level identity. Failing closed avoids pulling siblings from the wrong branch.
  return matches.length === 1 ? matches[0]! : null;
}

function flowCallOccurrences(steps: readonly FlowStep[]): FlowCallOccurrence[] {
  const occurrences: FlowCallOccurrence[] = [];
  const visit = (
    entries: readonly FlowStep[],
    inheritedPredecessors: readonly FlowCall[],
    inCatch: boolean,
  ): void => {
    const localPredecessors: FlowCall[] = [];
    for (const step of entries) {
      if (step.kind === "call") {
        occurrences.push({
          call: step,
          predecessors: [...inheritedPredecessors, ...localPredecessors],
          inCatch,
        });
        localPredecessors.push(step);
      } else if (step.kind === "loop") {
        visit(step.body, [...inheritedPredecessors, ...localPredecessors], inCatch);
      } else if (step.kind === "branch") {
        for (const path of step.paths) {
          visit(
            path.body,
            [...inheritedPredecessors, ...localPredecessors],
            inCatch || pathRole(path) === "catch",
          );
        }
      } else if (step.kind === "exit") {
        break;
      }
      // Callback bodies are definitions, not ordered work in the containing invocation.
    }
  };
  visit(steps, [], false);
  return occurrences;
}

/** Calls made when the expanded predecessor follows its ordinary success path. */
function successCorridorCalls(steps: readonly FlowStep[]): FlowCall[] {
  const calls: FlowCall[] = [];
  const visit = (entries: readonly FlowStep[]): void => {
    for (const step of entries) {
      if (step.kind === "call") {
        calls.push(step);
      } else if (step.kind === "loop") {
        // A loop may execute zero times, but its body is the operation represented by the loop and
        // is necessary to explain replay/batch-style predecessor calls.
        visit(step.body);
      } else if (step.kind === "branch" && branchKindOf(step) === "try") {
        const success = step.paths.find((path) => pathRole(path) === "try");
        if (success) visit(success.body);
        const finallyPath = step.paths.find((path) => pathRole(path) === "finally");
        if (finallyPath) visit(finallyPath.body);
      } else if (step.kind === "exit") {
        break;
      }
      // Conditional sibling arms and deferred callback bodies have no single proven execution
      // order, so they are deliberately not expanded.
    }
  };
  visit(steps);
  return calls;
}

function resolvedArcForFlowCall(
  source: NodeId,
  call: FlowCall,
  index: GraphIndex,
): CausalArc | null {
  if (!call.source) return null;
  const atSite = (index.outEdges.get(source) ?? [])
    .filter((edge) => edge.callSites?.some((site) => sameSourceLine(call.source!, site)))
    .map(edgeToCausalArc)
    .filter((arc): arc is CausalArc => arc !== null);
  const exactTarget = call.target === null
    ? []
    : atSite.filter((arc) =>
      (arc.kind === "call" || arc.kind === "instantiate") && arc.target === call.target);
  if (exactTarget.length === 1) return exactTarget[0]!;
  // Port edges replace an external postMessage-style call target with the correlated channel. Site
  // identity is sufficient only when exactly one such send exists.
  const sends = atSite.filter((arc) => arc.kind === "send");
  return sends.length === 1 ? sends[0]! : null;
}

function edgeToCausalArc(edge: GraphEdge): CausalArc | null {
  if (edge.resolution !== undefined && edge.resolution !== "resolved" && edge.confidence === undefined) {
    return null;
  }
  const kind = edge.kind === "calls"
    ? "call"
    : edge.kind === "instantiates"
      ? "instantiate"
      : edge.kind === "sends"
        ? "send"
        : null;
  if (!kind) return null;
  return {
    edgeId: edge.id,
    source: edge.source,
    target: edge.target,
    kind,
    edgeKind: edge.kind,
    confidence: Math.max(0, Math.min(1, edge.confidence ?? 1)),
    reversed: false,
  };
}

function sameSourceLine(
  left: NonNullable<FlowStep["source"]>,
  right: NonNullable<GraphEdge["callSites"]>[number],
): boolean {
  return left.file === right.file && left.line === right.line;
}

/** Every proven effect reachable after an awaiting callable resumes. */
function downstreamCorridor(
  slice: CausalSlice,
  awaits: readonly CausalArc[],
  flows: LogicFlows,
  index: GraphIndex,
): CausalArc[] {
  const candidates = corridorCandidates(slice, "downstream");
  const selected = new Set<string>();
  for (const awaitArc of awaits) {
    const awaiter = awaitArc.target;
    const boundary = index.edgesById.get(awaitArc.edgeId)?.callSites?.[0] ?? null;
    const hasFlow = Object.prototype.hasOwnProperty.call(flows, awaiter);
    const callsAfterWait = hasFlow
      ? orderedCalls(flows[awaiter] ?? []).filter((call) => occursAfterSite(call.source, boundary))
      : [];
    for (const arc of candidates) {
      if (arc.source !== awaiter) continue;
      // A logic-flow tree excludes deferred callback bodies, making it the strongest evidence for
      // which direct calls actually run in the resumed continuation. Artifacts without that
      // extension retain the core composer's source-order proof as a conservative fallback.
      if (!hasFlow || callsAfterWait.some((call) => call.target === arc.target && arcContainsSite(arc, call.source, index))) {
        selected.add(arc.edgeId);
      }
    }
  }
  return sortCorridor(candidates.filter((arc) => selected.has(arc.edgeId)), slice, index, "downstream");
}

function occursAfterSite(
  candidate: FlowStep["source"],
  boundary: NonNullable<GraphArtifact["edges"][number]["callSites"]>[number] | null,
): boolean {
  if (!candidate || !boundary || candidate.file !== boundary.file) return false;
  const boundaryEndLine = boundary.endLine ?? boundary.line;
  if (candidate.line !== boundaryEndLine) return candidate.line > boundaryEndLine;
  return boundary.endCol !== undefined && candidate.col !== undefined && candidate.col >= boundary.endCol;
}

function arcContainsSite(
  arc: CausalArc,
  site: FlowStep["source"],
  index: GraphIndex,
): boolean {
  if (!site) return false;
  return (index.edgesById.get(arc.edgeId)?.callSites ?? []).some((candidate) =>
    candidate.file === site.file
    && candidate.line === site.line);
}

function sortCorridor(
  arcs: readonly CausalArc[],
  slice: CausalSlice,
  index: GraphIndex,
  direction: "upstream" | "downstream",
): CausalArc[] {
  const depthByNode = new Map(slice.nodes.map((entry) => [
    entry.id,
    direction === "upstream" ? entry.backwardDepth : entry.forwardDepth,
  ]));
  return [...arcs].sort((left, right) => {
    const leftDepth = depthByNode.get(left.source) ?? 0;
    const rightDepth = depthByNode.get(right.source) ?? 0;
    const depthOrder = direction === "upstream" ? rightDepth - leftDepth : leftDepth - rightDepth;
    return depthOrder || compareArcSites(left, right, index) || left.edgeId.localeCompare(right.edgeId);
  });
}

function compareArcSites(left: CausalArc, right: CausalArc, index: GraphIndex): number {
  const leftSite = index.edgesById.get(left.edgeId)?.callSites?.[0];
  const rightSite = index.edgesById.get(right.edgeId)?.callSites?.[0];
  return (leftSite?.file ?? "").localeCompare(rightSite?.file ?? "")
    || (leftSite?.line ?? 0) - (rightSite?.line ?? 0)
    || (leftSite?.col ?? 0) - (rightSite?.col ?? 0);
}

function prewarmCorridor(builder: CausalTimelineBuilder, arcs: readonly CausalArc[], index: GraphIndex): void {
  for (const arc of arcs) {
    corridorParticipant(builder, arc.source, index);
    corridorParticipant(builder, arc.target, index);
  }
}

function renderCorridor(
  builder: CausalTimelineBuilder,
  arcs: readonly CausalArc[],
  index: GraphIndex,
  flows: LogicFlows,
): void {
  for (const arc of arcs) {
    const from = corridorParticipant(builder, arc.source, index);
    const to = corridorParticipant(builder, arc.target, index);
    switch (arc.kind) {
      case "call": {
        const presentation = callPresentation(arc, flows, index);
        builder.message(from, to, presentation.label, presentation.tone, arc.target);
        break;
      }
      case "instantiate": {
        const presentation = callPresentation(arc, flows, index, "new ");
        builder.message(from, to, presentation.label, presentation.tone, arc.target);
        break;
      }
      case "send":
        builder.message(from, to, `send · ${callableLabel(index, arc.target)}`, "detached", arc.source);
        break;
      case "handle":
        builder.message(from, to, `deliver · ${callableLabel(index, arc.source)}`, "callback", arc.target);
        break;
    }
  }
}

function callPresentation(
  arc: CausalArc,
  flows: LogicFlows,
  index: GraphIndex,
  prefix = "",
): { label: string; tone: SequenceMessageTone } {
  const step = orderedCalls(flows[arc.source] ?? []).find((call) =>
    call.target === arc.target && arcContainsSite(arc, call.source, index));
  const launched = step?.detached === true || step?.async?.kind === "launch";
  const awaited = step?.awaited === true
    || step?.async?.kind === "direct-await"
    || step?.async?.kind === "barrier";
  const tone: SequenceMessageTone = launched ? "detached" : awaited ? "await" : "call";
  const base = `${prefix}${withCallSuffix(callableLabel(index, arc.target))}`;
  return { label: awaited && !launched ? `await ${base}` : base, tone };
}

function corridorParticipant(builder: CausalTimelineBuilder, nodeId: NodeId, index: GraphIndex): string {
  const node = index.nodesById.get(nodeId);
  return node?.kind === "channel"
    ? builder.channel(node)
    : builder.actor(nodeId);
}

class CausalTimelineBuilder {
  private readonly participants: SequenceParticipant[] = [];
  private readonly participantByNode = new Map<NodeId, string>();
  private readonly participantAliases = new Map<string, string>();
  private readonly rows: SequenceRow[] = [];
  private readonly frames: SequenceFrame[] = [];
  private sequence = 0;
  private truncated = false;

  constructor(private readonly index: GraphIndex) {}

  get rowCount(): number {
    return this.rows.length;
  }

  actor(nodeId: NodeId): string {
    const identity = actorIdentity(nodeId, this.index);
    return this.participant(identity.key, "node", null, identity.label, identity.target);
  }

  resource(node: GraphNode, detail: string): string {
    return this.participant(node.id, "resource", detail, node.displayName, null);
  }

  /** Sequence diagrams read by runtime participant, not by every endpoint. Multiple logical
   * channels on the same protocol/lane therefore share one transport lifeline while their exact
   * channel names remain visible on the send/deliver messages. */
  channel(node: GraphNode): string {
    const identity = channelIdentity(node);
    return this.participant(identity.key, "resource", identity.detail, identity.label, null);
  }

  private participant(
    key: NodeId,
    kind: SequenceParticipant["kind"],
    detailOverride: string | null,
    labelOverride: string,
    targetNodeId: NodeId | null,
  ): string {
    const existing = this.participantByNode.get(key);
    if (existing) return existing;
    if (this.participants.length >= MAX_PARTICIPANTS) {
      this.truncated = true;
      if (!this.participants.some((participant) => participant.id === OVERFLOW_PARTICIPANT_ID)) {
        // Keep the projection bounded by replacing the last concrete lane with an honest overflow
        // lane. finish() remaps any rows that already referenced the evicted participant.
        const evicted = this.participants.pop();
        if (evicted) {
          this.participantAliases.set(evicted.id, OVERFLOW_PARTICIPANT_ID);
          for (const [knownKey, knownId] of this.participantByNode) {
            if (knownId === evicted.id) this.participantByNode.set(knownKey, OVERFLOW_PARTICIPANT_ID);
          }
        }
        this.participants.push({
          id: OVERFLOW_PARTICIPANT_ID,
          kind: "overflow",
          label: "More participants",
          detail: "collapsed by size guard",
          nodeId: null,
        });
      }
      this.participantByNode.set(key, OVERFLOW_PARTICIPANT_ID);
      return OVERFLOW_PARTICIPANT_ID;
    }
    const node = targetNodeId ? this.index.nodesById.get(targetNodeId) : this.index.nodesById.get(key);
    const id = `causal:participant:${key}`;
    this.participants.push({
      id,
      kind,
      label: labelOverride,
      detail: detailOverride ?? node?.location.file ?? null,
      nodeId: kind === "resource" ? null : targetNodeId,
      changedStatus: targetNodeId ? this.index.changedStatus.get(targetNodeId) : undefined,
    });
    this.participantByNode.set(key, id);
    return id;
  }

  message(
    from: string,
    to: string,
    label: string,
    tone: SequenceMessageTone,
    target: NodeId | null,
    kind: "call" | "return" = "call",
  ): void {
    if (!this.canAddRow()) return;
    this.rows.push({
      id: this.id("message"),
      type: "message",
      row: this.rows.length,
      kind,
      tone,
      from,
      to,
      label,
      visualRole: "primary",
      target,
      drillable: target !== null,
    });
  }

  note(participant: string, label: string, tone: "wait" | "exit" | "handoff" | "guard"): void {
    if (!this.canAddRow()) return;
    this.rows.push({
      id: this.id("note"),
      type: "note",
      row: this.rows.length,
      participant,
      tone,
      label,
      visualRole: "primary",
    });
  }

  frame(frame: SequenceFrame): void {
    this.frames.push(frame);
  }

  moveParticipantToEnd(participantId: string): void {
    const effectiveId = this.participantAliases.get(participantId) ?? participantId;
    const index = this.participants.findIndex((participant) => participant.id === effectiveId);
    if (index < 0 || index === this.participants.length - 1) return;
    const [participant] = this.participants.splice(index, 1);
    if (participant) this.participants.push(participant);
  }

  finish(sliceTruncated: boolean): SequenceTimelineModel {
    const alias = (id: string) => this.participantAliases.get(id) ?? id;
    const rows = this.rows.map((row): SequenceRow => row.type === "message"
      ? { ...row, from: alias(row.from), to: alias(row.to) }
      : { ...row, participant: alias(row.participant) });
    return {
      participants: this.participants,
      rows,
      frames: this.frames.filter((frame) => frame.startRow < rows.length),
      truncated: this.truncated || sliceTruncated,
      guards: { maxInlineDepth: 2, maxParticipants: MAX_PARTICIPANTS, maxRows: MAX_ROWS },
    };
  }

  private canAddRow(): boolean {
    if (this.rows.length < MAX_ROWS) return true;
    this.truncated = true;
    return false;
  }

  private id(kind: string): string {
    return `causal:${kind}:${this.sequence++}`;
  }
}

function nearestUniqueResource(slice: CausalSlice, index: GraphIndex, kind: string): GraphNode | null {
  const candidates = slice.nodes
    .map((entry) => ({ entry, node: index.nodesById.get(entry.id) }))
    .filter((candidate): candidate is { entry: CausalSlice["nodes"][number]; node: GraphNode } =>
      candidate.node?.kind === kind)
    .map((candidate) => ({
      ...candidate,
      distance: Math.min(candidate.entry.backwardDepth ?? Infinity, candidate.entry.forwardDepth ?? Infinity),
    }))
    .sort((left, right) => left.distance - right.distance || left.node.id.localeCompare(right.node.id));
  if (candidates.length === 0) return null;
  if (candidates.length > 1 && candidates[0]!.distance === candidates[1]!.distance) return null;
  return candidates[0]!.node;
}

function matchingReturnAlias(
  awaiter: NodeId,
  aliases: readonly CausalArc[],
  flows: LogicFlows,
  site: { file: string; line: number } | null,
): CausalArc | null {
  const calls = orderedCalls(flows[awaiter] ?? []);
  const targets = new Set(aliases.map((arc) => arc.source));
  const exact = calls.find((call) => call.target !== null
    && targets.has(call.target)
    && (site === null || (call.source?.file === site.file && call.source.line === site.line)));
  const target = exact?.target ?? (site === null
    ? calls.find((call) => call.target !== null && targets.has(call.target))?.target
    : null);
  return target ? aliases.find((arc) => arc.source === target) ?? null : null;
}

function orderedCalls(steps: readonly FlowStep[]): Array<Extract<FlowStep, { kind: "call" }>> {
  const calls: Array<Extract<FlowStep, { kind: "call" }>> = [];
  const visit = (entries: readonly FlowStep[]) => {
    for (const step of entries) {
      if (step.kind === "call") calls.push(step);
      else if (step.kind === "loop") visit(step.body);
      else if (step.kind === "branch") step.paths.forEach((path) => visit(path.body));
      // Callback bodies are definitions, not ordered continuation.
    }
  };
  visit(steps);
  return calls.sort((left, right) =>
    (left.source?.file ?? "").localeCompare(right.source?.file ?? "")
    || (left.source?.line ?? 0) - (right.source?.line ?? 0)
    || (left.source?.col ?? 0) - (right.source?.col ?? 0));
}

interface ParticipantIdentity {
  key: NodeId;
  label: string;
  target: NodeId;
}

/**
 * Collapse implementation detail into industry-style component lifelines. Methods share their
 * class/interface/object. Free functions in one module share a lane, labelled by the outermost
 * function involved in this sequence (`bootstrapIframe`, `wireDelegateHost`, ...), so nested
 * helpers remain visible as message labels without multiplying vertical lanes.
 */
function actorIdentity(nodeId: NodeId, index: GraphIndex): ParticipantIdentity {
  const node = index.nodesById.get(nodeId);
  if (!node) return { key: nodeId, label: nodeId, target: nodeId };

  if (node.kind === "function") {
    let outermost = node;
    const seen = new Set<NodeId>([nodeId]);
    let parent = index.parentOf.get(nodeId) ?? node.parentId ?? null;
    while (parent && !seen.has(parent)) {
      seen.add(parent);
      const owner = index.nodesById.get(parent);
      if (!owner) break;
      if (owner.kind === "function") {
        outermost = owner;
        parent = index.parentOf.get(parent) ?? owner.parentId ?? null;
        continue;
      }
      if (owner.kind === "module") {
        return { key: owner.id, label: outermost.displayName, target: outermost.id };
      }
      break;
    }
    return { key: node.id, label: node.displayName, target: node.id };
  }

  if (node.kind !== "method") {
    return { key: node.id, label: node.displayName, target: node.id };
  }
  const seen = new Set<NodeId>([nodeId]);
  let parent = index.parentOf.get(nodeId) ?? node.parentId ?? null;
  while (parent && !seen.has(parent)) {
    seen.add(parent);
    const owner = index.nodesById.get(parent);
    if (owner && ["class", "interface", "object"].includes(owner.kind)) {
      return { key: owner.id, label: owner.displayName, target: owner.id };
    }
    parent = index.parentOf.get(parent) ?? owner?.parentId ?? null;
  }
  return { key: node.id, label: node.displayName, target: node.id };
}

function channelIdentity(node: GraphNode): { key: NodeId; label: string; detail: string } {
  // Channel ids are injective named segments. Removing only the final channel component preserves
  // protocol + lane + scope, which is exactly the physical lifeline identity.
  const key = node.id.replace(/\/channel=[^/]+$/u, "") as NodeId;
  const protocol = node.location.file.replace(/^\(|\)$/g, "").trim() || "IPC";
  const label = protocol.toLowerCase() === "rpc"
    ? "RPC transport"
    : protocol.toLowerCase() === "postmessage"
      ? "postMessage"
      : `${protocol} transport`;
  return { key, label, detail: `${protocol} boundary` };
}

function callableLabel(index: GraphIndex, nodeId: NodeId): string {
  return index.nodesById.get(nodeId)?.displayName ?? nodeId;
}

function withCallSuffix(label: string): string {
  return label.endsWith(")") ? label : `${label}()`;
}

function edgeSite(index: GraphIndex, edgeId: string): { file: string; line: number } | null {
  const site = index.edgesById.get(edgeId)?.callSites?.[0];
  return site ? { file: site.file, line: site.line } : null;
}

function readLogicFlows(artifact: GraphArtifact): LogicFlows {
  const raw = artifact.extensions?.logicFlow;
  return typeof raw === "object" && raw !== null && !Array.isArray(raw)
    ? raw as unknown as LogicFlows
    : {};
}
