/**
 * Derive a callable's logic flow into a pre-layout graph spec — the Unreal-Blueprints-style exec
 * graph the Logic tab renders. Calls become "building block" nodes (Blueprint function nodes);
 * `for`/`while` become expandable containers; `if`/`switch` and ordinary `try`/`catch` become
 * explicit split/lane/join structures whose paths leave stable labeled exec pins. "seq" edges are
 * the white exec thread, emitted left→right in execution order; live paths reconverge onto the
 * following step. A non-terminating `finally` becomes one mandatory phase after that merge; only
 * protected arms with deferred return/throw outcomes retain the conservative container fallback.
 *
 * Pure: (rootId, flows, index, expanded set, options) → {nodes, edges}. No React, no ELK.
 */

import type {
  BranchKind,
  ChangeStatus,
  EdgeResolution,
  FlowAsyncInput,
  FlowCallAsync,
  FlowPath,
  FlowPathRole,
  FlowSourceAnchor,
  FlowStep,
  GraphNode,
  LogicFlows,
  SyntheticNodeSnapshot,
} from "@meridian/core";
import { branchKindOf, exitLabel, parseNodeId, pathRole, pathTerminates, syntheticFallThroughLabel, tryArms } from "@meridian/core";
import type { GraphIndex } from "../graph/graphIndex";
import { NODE_DISCLOSURE_SIZE, NODE_EMPTY_EXPANSION_HEIGHT } from "../theme/nodeChrome";
import { baseName, callDisplay } from "./flowViewModel";
import type { LogicOwner, OwnerLookup } from "./logicOwner";
import { clamp, monoTextWidth } from "../layout/measure";
import {
  awaitSemantics,
  callOccurrenceSemantics,
  declarationSemantics,
  detachedCallSummary,
  mergeNodeSemantics,
  displayNodeKind,
  semanticLabels,
  SEMANTIC_STATE_TEXT_MAX_WIDTH,
  type NodeSemanticModel,
} from "../nodeSemantics";
import {
  logicBranchBodyPrefix,
  logicCallBodyPrefix,
  logicControlBodyPrefix,
  logicFinallyBodyPrefix,
  logicNodeId,
  logicServiceFrameId,
  logicStepPath,
  logicTopLevelBodyPrefix,
} from "./logicFlowAddress";
import { canChartFinallyAsSharedPhase } from "./logicFlowShape";

/** No owner/signature enrichment — the default when a caller (e.g. a unit test) supplies no lookup. */
const NO_OWNER: OwnerLookup = () => null;

export type LogicNodeType = "block" | "control" | "branch" | "exception" | "finally" | "join" | "async" | "servicegroup" | "terminal" | "fold";

/** A call's ownership boundary, kept separate from whether its card is a compact leaf. */
export type LogicCallScope = "internal" | "external" | "unresolved";

/** One stable exec pin on a decision. `synthetic` is the implicit else/no-match path the source did
 * not spell out; it still needs a real lane so the graph never hides that fall-through. */
export interface LogicBranchPort {
  id: string;
  label: string;
  role: FlowPathRole | "fallthrough";
  order: number;
  /** Extractor-stable semantic arm id (`then`, `else`, case text, …). */
  pathId?: string;
  /** Exact source range for matching this arm to runtime branch counters. */
  source?: FlowSourceAnchor;
  synthetic?: boolean;
}

export type LogicAsyncEvent = FlowCallAsync | { kind: "await"; mode: "single"; inputs: FlowAsyncInput[] };

/** A task rail's physical endpoint. Launches expose a source; later await/barrier nodes expose one
 * target per input, including readable unresolved inputs that have no correlation edge. */
export interface LogicAsyncPort {
  id: string;
  direction: "source" | "target";
  label: string;
  taskId?: string;
  order: number;
}

export type LogicNodeData = {
  logicKind: "call" | "loop" | "try" | "finally" | "callback" | "if" | "switch" | "join" | "await" | "service";
  label: string;
  targetId: string | null;
  resolution: EdgeResolution | null;
  /** A resolved local target can be opened as its own flow even when that flow contains no steps. */
  navigable?: boolean;
  expandable: boolean;
  isExpanded: boolean;
  isContainer: boolean;
  /** A small leaf card. This is a density/layout fact, not a resolution or externality signal. */
  compact: boolean;
  /** Where a call resolves. Null on control/service/join nodes that are not call sites. */
  callScope: LogicCallScope | null;
  /** @deprecated Compatibility alias for old renderers. New code must use `compact` for size and
   * `callScope`/`resolution` for boundary styling. It is true only when resolution is unknown. */
  greyed: boolean;
  provenance: { pkg: string; module: string } | null;
  childCount: number;
  /** Resolved local callable with no drawable nested steps; expansion renders shared honest content. */
  emptyFlow?: boolean;
  /** A callable DEFINED in the open module (not a step in its load-flow): rendered as a distinct
   * disconnected "defined here" node so the view can style it apart from ordinary call blocks. */
  definition?: boolean;
  /** The sub-chains a control container holds (a loop/callback body, or the conservative
   * try/finally fallback). Set ONLY on `control` nodes so a double-click can DIVE into them without
   * re-parsing the flow; undefined on ordinary try/catch branch nodes. */
  bodies?: FlowPath[];
  /** Whether a `logicKind:"call"` block is a free function or a method (called through a receiver).
   * HEURISTIC: without type info we can't reliably separate an instance method from a static one, so
   * "method" means "called through a receiver / a class method", not strictly an instance method.
   * Set on call block nodes (and definition nodes, from their node kind); undefined on loop/try/if. */
  callKind?: "function" | "method";
  /** The resolved target's own signature (params/return), so a block shows WHAT it calls, not just
   * its name — the per-node vertical detail. Undefined for unresolved/external/signatureless targets. */
  signature?: string;
  /** The Service-composition unit that OWNS the call target (its class/object/module), with health +
   * smell. On a "service" frame it's the framed unit (title + click-through); on a call block it's the
   * owner the enclosing frame already shows, kept for the framing pass and as a fallback. */
  owner?: LogicOwner | null;
  /** True on a call block nested inside a service frame: the frame title names the owner, so the block
   * drops its own provenance line (§ ServiceGroupNode). Undefined on standalone/external calls. */
  framed?: boolean;
  /** The call sits under an `await`: execution holds for it (rendered as a latent ⏱ badge). */
  awaited?: boolean;
  /** The call's result is deliberately dropped (`void`-ed / un-awaited Promise): fire-and-forget
   * work that outlives this flow (rendered as a detached ⤳ badge). */
  detached?: boolean;
  /** Detached calls directly contained anywhere in this callee's own flow tree. This lets the
   * parent call warn before expansion without pretending the parent invocation itself is detached. */
  nestedDetachedCount?: number;
  /** Ordered source handles for an if/switch decision. Stable ids let ELK and React Flow route the
   * same arm from the same physical pin without changing node/drill identity. */
  branchPorts?: LogicBranchPort[];
  /** Exact source identity for a branch decision. Present only on if/switch/try nodes emitted by
   * current extractors; older artifacts remain readable and simply cannot join runtime counters. */
  branchSource?: FlowSourceAnchor;
  /** The canonical callable/module whose source contains this rendered structural occurrence.
   * `anchor` is the exact control statement when the extractor supplied one. Keep this independent
   * from `targetId`: calls preview their callee, while if/try/loop/finally nodes preview this owner
   * and merely focus the statement inside it. */
  sourceContext?: { ownerId: string; anchor?: FlowSourceAnchor };
  branchKind?: BranchKind;
  /** Rich async event + its task-rail endpoints. Legacy awaited/detached remain above for old data. */
  asyncEvent?: LogicAsyncEvent;
  asyncPorts?: LogicAsyncPort[];
  /** Shared declaration + occurrence semantics rendered identically in Map and Logic headers. */
  semantics?: NodeSemanticModel;
  /** One concrete request occurrence rendered in the shared split pane. Static Logic flows never
   * set this field; request reconstruction uses it to preserve span/event identity, timing, status,
   * caller context, and safely captured values without pretending those observations are source
   * `FlowStep`s. */
  runtime?: RequestRuntimeEvidence;
  /** Exact PR status at this rendered step's own source anchor. This is intentionally separate from
   * `targetId`: a call site can be new while its callee is unchanged, and vice versa. */
  changedStatus?: ChangeStatus;
  /** Exact PR status of a call step's resolved callee. Kept separate from `changedStatus` so the
   * renderer can say "target changed" without falsely painting an unchanged call site as edited. */
  targetChangedStatus?: ChangeStatus;
};

export interface RequestRuntimeEvidence {
  kind: "span" | "branch" | "loop" | "exception" | "async";
  /** The one occurrence currently opened as the synthetic flow player's focused static body. */
  focused?: boolean;
  status?: "unset" | "ok" | "error";
  durationMs?: number;
  /** All events captured under this span, including data observations. */
  eventCount?: number;
  detail?: string;
  badges?: string[];
  /** Explicit runner-captured boundary values for this exact span occurrence. Absence means the
   * producer did not capture a snapshot; it must never be inferred from neighbouring events. */
  snapshot?: Pick<SyntheticNodeSnapshot, "input" | "output" | "error">;
}

/**
 * The ENTRY / EXIT end-caps of a top-level callable flow. A terminal is not a call step, so it
 * carries only the two fields the layout adapter and the view structurally read off EVERY logic
 * node: `targetId` (null — a terminal is never a call site, so clicking one is a harmless no-op) and
 * `isContainer` (false — it's a leaf ELK sizes from width/height). This mirrors `DefGroupData`
 * (see logicElk), which keeps the RF-node data union ergonomic by sharing those two accessors.
 */
export type TerminalData = {
  targetId: null;
  isContainer: false;
  /** `entry`/`exit` frame the whole flow; `return`/`throw` are MID-FLOW caps a path dead-ends at. */
  terminal: "entry" | "exit" | "return" | "throw";
  label: string;
  /** Exact PR status of the charted callable (ENTRY) or this terminal step's source anchor. */
  changedStatus?: ChangeStatus;
};

/** A compact continuation inserted when one edge is folded. It is a presentation node, not source
 * or runtime evidence: the semantic edge key restores the exact cut while the count reports only
 * execution steps owned exclusively by that path. */
export type CollapsedEdgeData = {
  targetId: null;
  isContainer: false;
  collapseKey: string;
  edgeKind: LogicEdgeSpec["kind"];
  targetLabel: string;
  hiddenStepCount: number;
  edgeLabel?: string;
  branchRole?: LogicBranchPort["role"];
};

export interface LogicNodeSpec {
  id: string;
  parentId: string | null;
  type: LogicNodeType;
  data: LogicNodeData | TerminalData | CollapsedEdgeData;
  width?: number;
  height?: number;
}

export interface LogicEdgeSpec {
  id: string;
  source: string;
  target: string;
  kind: "seq" | "branch" | "async";
  label?: string;
  /** Stable endpoint ids shared by ELK ports and React Flow handles. */
  sourcePort?: string;
  targetPort?: string;
  /** Opaque extractor task id on async correlation rails. */
  taskId?: string;
  /** Semantic lane carried by a split edge and its final hop into a join. Catch uses this to keep
   * the exceptional route visually distinct without turning it into a different graph topology. */
  branchRole?: LogicBranchPort["role"];
  /** Positive request evidence for this exact rendered edge. Absence means static/unknown context,
   * never proof that the edge did not execute. Runtime occurrences carry their exact causal
   * relation; static FlowSteps need site/path correlation before their internal edges can carry the
   * same claim. */
  requestTraversal?: RequestEdgeTraversalEvidence;
  /** Fold projections replace a canonical connection with non-collapsible segments around a `+N`
   * continuation node. Omitted means this canonical edge can be folded. */
  collapsible?: boolean;
}

export type RequestRuntimeCausalRelation =
  | "trace-entry"
  | "span-local-order"
  | "parent-child"
  | "span-link"
  | "async-handoff"
  | "trace-exit";

export type RequestEdgeTraversalEvidence =
  | {
      traceId: string;
      basis: "runtime-causal";
      relation: RequestRuntimeCausalRelation;
      sourceMomentId: string;
      targetMomentId: string;
    }
  | {
      traceId: string;
      basis: "span-body" | "child-span-order";
      spanId: string;
      childSpanIds?: string[];
    }
  | {
      traceId: string;
      basis: "branch-path";
      spanId: string;
      eventIds: string[];
      siteId: string;
      pathIds: string[];
    }
  | {
      traceId: string;
      basis: "loop-body";
      spanId: string;
      eventIds: string[];
      siteId: string;
      iterations: number;
    };

export interface LogicGraphSpec {
  nodes: LogicNodeSpec[];
  edges: LogicEdgeSpec[];
}

/** An outgoing exec connection point; `edgeLabel` marks a branch pin (e.g. an empty `else`). */
interface Exit {
  id: string;
  edgeLabel?: string;
  sourcePort?: string;
  branchRole?: LogicBranchPort["role"];
}

/** A flow step paired with its ORIGINAL index in the level, so a framed run keeps stable node ids. */
interface IndexedStep {
  step: FlowStep;
  i: number;
}

/** One emit unit of a level: a service `frame` wrapping a run of same-owner calls, or a lone flat
 * step (`frame: null`). See `planLevel`. */
interface RunUnit {
  frame: { owner: LogicOwner; id: string } | null;
  steps: IndexedStep[];
}

export interface LogicGraphOptions {
  hideGreyed: boolean;
  nestByService?: boolean;
  withTerminals?: boolean;
  /** Canonical source owner when `rootId` is only an occurrence namespace (focused body/request
   * grafts). Ordinary callable graphs default this to `rootId`. */
  sourceOwnerId?: string;
  /** Resolve change status from a flow step's own source line, never from its call target. */
  changedStatusForSource?: (source: FlowSourceAnchor | undefined) => ChangeStatus | undefined;
}

export function deriveLogicGraph(
  rootId: string,
  flows: LogicFlows,
  index: GraphIndex,
  expandedLogic: ReadonlySet<string>,
  // `withTerminals` frames a TOP-LEVEL callable flow with entry/exit end-caps (see build()); the
  // container-dive path leaves it off. `nestByService` groups consecutive same-owner calls under
  // service frames. Both optional so existing callers/tests default them off.
  options: LogicGraphOptions,
  ownerLookup: OwnerLookup = NO_OWNER,
): LogicGraphSpec {
  const steps = flows[rootId];
  if (!steps || steps.length === 0) {
    return { nodes: [], edges: [] };
  }
  return new LogicGraphBuilder(rootId, flows, index, expandedLogic, options, ownerLookup).build(steps);
}

/**
 * Chart a control container's bodies as INDEPENDENT top-level chains — the DIVE-into-a-container
 * view (the container analog of drilling a callable). `prefix` (the container's own node id)
 * namespaces every node id so they stay stable across relayouts and unique against any other view.
 */
export function deriveLogicGraphFromBodies(
  prefix: string,
  bodies: FlowPath[],
  flows: LogicFlows,
  index: GraphIndex,
  expandedLogic: ReadonlySet<string>,
  options: LogicGraphOptions,
  ownerLookup: OwnerLookup = NO_OWNER,
): LogicGraphSpec {
  return new LogicGraphBuilder(prefix, flows, index, expandedLogic, options, ownerLookup).buildFromBodies(bodies);
}

/**
 * The ids of every callable DEFINED anywhere under `moduleId` — the file's exported/declared
 * functions and methods, which its thin top-level load-flow never mentions. Walks `childrenOf`
 * RECURSIVELY (not just direct children) so methods on object/class literals — e.g.
 * `toolExecutionMiddleware.startExecution`, nested under the object node — are collected too.
 * Sorted by display name for a stable grid; the module itself is excluded (it's not a callable).
 */
export function collectModuleDefinitions(index: GraphIndex, moduleId: string): string[] {
  const found: GraphNode[] = [];
  const walk = (id: string): void => {
    for (const child of index.childrenOf(id)) {
      if (child.kind === "function" || child.kind === "method") {
        found.push(child);
      }
      walk(child.id);
    }
  };
  walk(moduleId);
  return found.sort((a, b) => a.displayName.localeCompare(b.displayName)).map((node) => node.id);
}

/**
 * Block-like data for a "defined here" node: it targets the callable itself, so single-click
 * selection (and its jump-to-flow ghosts) and double-click drill both route through the same
 * `targetId`/`expandable` path an ordinary call block uses. Every local callable is expandable;
 * declarations with no drawable steps use the same explicit empty-flow state as call occurrences.
 * Provenance reads as `<owner> › <name>` (the owning
 * object/class/module, then the callable) so a bare method name always shows where it lives.
 * `isExpanded` is the occurrence-level state supplied by the module layout.
 */
export function definitionNodeData(
  callableId: string,
  flows: LogicFlows,
  index: GraphIndex,
  ownerLookup: OwnerLookup = NO_OWNER,
  isExpanded = false,
): LogicNodeData {
  const node = index.nodesById.get(callableId);
  const flow = flows[callableId] ?? [];
  const expandable = node?.kind === "function" || node?.kind === "method";
  const expanded = expandable && isExpanded;
  const semantics = declarationSemantics(node);
  return {
    logicKind: "call",
    definition: true,
    label: node?.displayName ?? baseName(parseNodeId(callableId).modulePath),
    targetId: callableId,
    resolution: "resolved",
    navigable: true,
    expandable,
    isExpanded: expanded,
    isContainer: expanded,
    // Definition cells use their declaration-grid geometry (and grow around an expanded flow); a
    // missing child flow must not turn a declaration into the compact call-site vocabulary.
    compact: false,
    callScope: "internal",
    greyed: false,
    provenance: definitionProvenance(callableId, node, index),
    childCount: flow.length,
    ...(expandable && flow.length === 0 ? { emptyFlow: true } : {}),
    // A declared callable's own node kind is authoritative here (no receiver to infer from).
    callKind: node?.kind === "method" ? "method" : "function",
    signature: node?.signature,
    ...(semantics ? { semantics } : {}),
    owner: ownerLookup(callableId),
  };
}

/** `<owner> › <name>`: the immediate parent's display name (its object/class/module) over the
 * callable's own name — clearer for a declaration than the pkg›module a call block shows. */
function definitionProvenance(
  callableId: string,
  node: GraphNode | undefined,
  index: GraphIndex,
): { pkg: string; module: string } {
  const ancestors = index.ancestorsOf(callableId); // root..id inclusive; [-2] is the parent.
  const parent = ancestors[ancestors.length - 2];
  const name = node?.displayName ?? baseName(parseNodeId(callableId).modulePath);
  return { pkg: parent?.displayName ?? "", module: name };
}

class LogicGraphBuilder {
  private readonly nodes: LogicNodeSpec[] = [];
  private readonly edges: LogicEdgeSpec[] = [];
  /** task ids are only unique inside one source flow; namespace them by the rendered flow INSTANCE
   * so two expanded call sites of the same callee can never cross-wire their async rails. */
  private readonly asyncLaunches = new Map<string, { nodeId: string; sourcePort: string }>();
  private edgeSeq = 0;
  private readonly initialSourceOwnerId: string;

  constructor(
    private readonly rootId: string,
    private readonly flows: LogicFlows,
    private readonly index: GraphIndex,
    private readonly expanded: ReadonlySet<string>,
    private readonly options: LogicGraphOptions,
    private readonly ownerLookup: OwnerLookup,
  ) {
    this.initialSourceOwnerId = options.sourceOwnerId ?? rootId;
  }

  build(steps: FlowStep[]): LogicGraphSpec {
    const { firstId, lastExits } = this.sequence(steps, null, "", this.rootId, this.initialSourceOwnerId);
    // Frame the whole flow with entry/exit end-caps when asked (top-level callable flows only). Guarded
    // on a real first step: an all-greyed-and-hidden flow leaves `firstId` null, so it gets no terminals.
    if (this.options.withTerminals && firstId !== null) {
      this.addTerminals(firstId, lastExits);
    }
    return { nodes: this.nodes, edges: this.edges };
  }

  /**
   * The flow's ENTRY and EXIT end-caps: an entry node the observed callable starts at (its own name,
   * so the view can hang caller-ghosts off it), wired by a seq edge INTO the first step; and a single
   * synthetic exit node every trailing exec pin converges onto — dangling branch pins included, via
   * the same `link()` the chain uses, so their labels ride along. Both are top-level (parentId null).
   */
  private addTerminals(firstId: string, lastExits: Exit[]): void {
    const entry = this.index.nodesById.get(this.rootId);
    const entryId = `${this.rootId}::entry`;
    const entryData: TerminalData = {
      targetId: null,
      isContainer: false,
      terminal: "entry",
      label: entry?.displayName ?? baseName(parseNodeId(this.rootId).modulePath),
      changedStatus: this.index.changedStatus.get(this.rootId)
        ?? (this.index.changedIds.has(this.rootId) ? "modified" : undefined),
    };
    this.nodes.push({ id: entryId, parentId: null, type: "terminal", data: entryData, width: entryTerminalWidth(entryData.label), height: TERMINAL_HEIGHT });
    this.pushEdge(entryId, firstId, "seq");
    // No trailing exec pins means every path already dead-ended at its own return/throw cap — a
    // synthetic EXIT would float unconnected, so it only exists when something falls through to it.
    if (lastExits.length === 0) {
      return;
    }
    const exitId = `${this.rootId}::exit`;
    const exitData: TerminalData = { targetId: null, isContainer: false, terminal: "exit", label: "EXIT" };
    this.nodes.push({ id: exitId, parentId: null, type: "terminal", data: exitData, width: TERMINAL_WIDTH, height: TERMINAL_HEIGHT });
    for (const exit of lastExits) {
      this.link(exit, exitId);
    }
  }

  /**
   * The dive entry: render each body as its own top-level chain under `p${i}/` so ids stay unique.
   * Separate bodies are NOT exec-linked (a try's try/catch/finally arms don't run in sequence),
   * exactly like a container's inner rendering — only here they sit at the top level, not nested.
   */
  buildFromBodies(bodies: FlowPath[]): LogicGraphSpec {
    bodies.forEach((body, i) => this.sequence(
      body.body,
      null,
      logicTopLevelBodyPrefix(i),
      this.rootId,
      this.initialSourceOwnerId,
    ));
    return { nodes: this.nodes, edges: this.edges };
  }

  /**
   * Emit one nesting level, grouping consecutive calls to the SAME owning service into one frame so
   * the flow reads UML-like (mirrors the composition view): a run of framable calls nests under a
   * service-frame container, everything else emits flat. Exec wires are UNCHANGED — they thread
   * block→block in execution order across frame boundaries (ELK's root INCLUDE_CHILDREN routes them),
   * so `firstId`/`lastExits` still stitch branches and loops exactly as before.
   */
  private sequence(
    steps: FlowStep[],
    parentId: string | null,
    prefix: string,
    asyncScope: string,
    sourceOwnerId: string,
  ): { firstId: string | null; lastExits: Exit[] } {
    let firstId: string | null = null;
    let prevExits: Exit[] = [];
    for (const unit of this.planLevel(steps, prefix)) {
      const stepParent = unit.frame ? this.emitServiceFrame(unit.frame, unit.steps.length, parentId) : parentId;
      for (const { step, i } of unit.steps) {
        const emit = this.step(
          step,
          stepParent,
          logicStepPath(prefix, i),
          unit.frame !== null,
          asyncScope,
          sourceOwnerId,
        );
        if (firstId === null) {
          firstId = emit.entry;
        }
        for (const exit of prevExits) {
          this.link(exit, emit.entry);
        }
        prevExits = emit.exits;
        // A step with NO exec exits (a return/throw cap, or a branch whose every arm exits) ends
        // this path: whatever follows is unreachable, and charting it would strand wire-less
        // orphan nodes for ELK to float arbitrarily over the flow.
        if (prevExits.length === 0) {
          return { firstId, lastExits: [] };
        }
      }
    }
    return { firstId, lastExits: prevExits };
  }

  /**
   * Partition a level into emit units: maximal runs of consecutive framable calls sharing one owner
   * (each a `frame` unit), with every other step a lone flat unit. `hideGreyed` is the persisted name
   * of the old preference, but its UX is "hide leaf blocks", so it now reads compactness directly —
   * never the compatibility `greyed` bit. Original indices ride along so ids stay stable.
   */
  private planLevel(steps: FlowStep[], prefix: string): RunUnit[] {
    const units: RunUnit[] = [];
    let run: { owner: LogicOwner; steps: IndexedStep[] } | null = null;
    const flush = () => {
      if (run) {
        const firstStepPath = logicStepPath(prefix, run.steps[0].i);
        units.push({ frame: { owner: run.owner, id: logicServiceFrameId(this.rootId, firstStepPath) }, steps: run.steps });
        run = null;
      }
    };
    steps.forEach((step, i) => {
      if (this.options.hideGreyed && this.isCompactCall(step)) {
        return;
      }
      const owner = this.framableOwner(step, logicNodeId(this.rootId, logicStepPath(prefix, i)));
      if (owner && run && run.owner.unitId === owner.unitId) {
        run.steps.push({ step, i });
      } else if (owner) {
        flush();
        run = { owner, steps: [{ step, i }] };
      } else {
        flush();
        units.push({ frame: null, steps: [{ step, i }] });
      }
    });
    flush();
    return units;
  }

  /**
   * The owner a call would be FRAMED under, or null if the step breaks a run: non-calls, calls to an
   * unowned (external/unresolved) target, and EXPANDED calls (they become their own container, so
   * they can't also nest in a service frame). Greyed-but-resolved calls with an owner ARE framable —
   * they belong in their service's frame — so the greyed-ness alone never disqualifies.
   */
  private framableOwner(step: FlowStep, id: string): LogicOwner | null {
    if (!this.options.nestByService || step.kind !== "call") {
      return null; // nesting off (the default) ⇒ nothing frames, every call emits as a flat block.
    }
    const expandable = callDisplay(step, this.flows, this.index).expandable;
    if (expandable && this.expandedState(id, false)) {
      return null;
    }
    return this.ownerLookup(step.target);
  }

  /** Emit the titled service-frame container (an ELK container, so no measured size); returns its id
   * to parent the run's call blocks. Reuses `LogicNodeData` — `owner` carries the health/kind/unitId
   * the frame title renders, so no discriminated-union member is needed. */
  private emitServiceFrame(frame: { owner: LogicOwner; id: string }, childCount: number, parentId: string | null): string {
    const data: LogicNodeData = {
      logicKind: "service",
      label: frame.owner.label,
      targetId: null,
      resolution: null,
      expandable: false,
      isExpanded: true,
      isContainer: true,
      compact: false,
      callScope: null,
      greyed: false,
      provenance: null,
      childCount,
      owner: frame.owner,
    };
    this.push(frame.id, parentId, "servicegroup", data);
    return frame.id;
  }

  private step(
    step: FlowStep,
    parentId: string | null,
    path: string,
    framed: boolean,
    asyncScope: string,
    sourceOwnerId: string,
  ): { entry: string; exits: Exit[] } {
    const id = logicNodeId(this.rootId, path);
    if (step.kind === "call") {
      return this.callStep(step, parentId, path, id, framed, asyncScope, sourceOwnerId);
    }
    if (step.kind === "await") {
      return this.awaitStep(step, parentId, id, asyncScope);
    }
    if (step.kind === "exit") {
      return this.exitStep(step, parentId, id);
    }
    if (step.kind === "loop" || step.kind === "callback") {
      const bodies: FlowPath[] = [{ label: step.label, body: step.body }];
      return this.container(
        parentId,
        path,
        id,
        step.kind,
        step.label,
        bodies,
        step.body.length,
        asyncScope,
        sourceOwnerId,
        step.source,
      );
    }
    // `finally` is not a third alternative arm. When both protected arms fall through, chart it as
    // one mandatory phase after their merge. Explicit returns/throws inside those arms must be
    // deferred through cleanup; until the model carries that pending outcome, keep the conservative
    // container rather than drawing a terminal before FINALLY and lying that cleanup can be skipped.
    if (branchKindOf(step) === "try" && step.paths.some((flowPath) => pathRole(flowPath) === "finally")) {
      if (canChartFinallyAsSharedPhase(step)) {
        // A charted TRY/CATCH/FINALLY folds as one structural beat. Reopening it restores the exact
        // split/join/finally topology; a FINALLY phase can then be folded independently as well.
        if (!this.expandedState(id, true)) {
          return this.branchStep(step, parentId, path, id, asyncScope, sourceOwnerId);
        }
        return this.tryFinallyStep(step, parentId, path, id, asyncScope, sourceOwnerId);
      }
      const count = step.paths.reduce((sum, p) => sum + p.body.length, 0);
      return this.container(
        parentId,
        path,
        id,
        "try",
        "try / catch",
        step.paths,
        count,
        asyncScope,
        sourceOwnerId,
        step.source,
      );
    }
    return this.branchStep(step, parentId, path, id, asyncScope, sourceOwnerId);
  }

  /**
   * A charted `return`/`throw`: a terminal cap this path DEAD-ENDS at. It exposes NO exec exits, so
   * nothing links onward from it — a guard's then-path visibly stops instead of silently rejoining
   * the thread, and a branch merges only what genuinely falls through.
   */
  private exitStep(step: Extract<FlowStep, { kind: "exit" }>, parentId: string | null, id: string): { entry: string; exits: Exit[] } {
    const label = exitLabel(step);
    const data: TerminalData = {
      targetId: null,
      isContainer: false,
      terminal: step.variant,
      label,
      changedStatus: this.changedStatus(step.source),
    };
    this.nodes.push({ id, parentId, type: "terminal", data, width: exitCapWidth(label), height: EXIT_CAP_HEIGHT });
    return { entry: id, exits: [] };
  }

  private callStep(
    step: Extract<FlowStep, { kind: "call" }>,
    parentId: string | null,
    path: string,
    id: string,
    framed: boolean,
    asyncScope: string,
    sourceOwnerId: string,
  ): { entry: string; exits: Exit[] } {
    const display = callDisplay(step, this.flows, this.index);
    const navigable = display.navigable;
    const expandable = display.expandable;
    const calleeFlow = step.target ? this.flows[step.target] ?? [] : [];
    const emptyFlow = expandable && calleeFlow.length === 0;
    // A barrier is execution structure, not a disposable leaf chip: give it full node geometry even
    // when Promise.all itself has no expandable repository flow.
    const compact = !expandable && step.async?.kind !== "barrier";
    const callScope = callScopeOf(step.resolution);
    // Kept only for old consumers during the renderer transition. Compactness and call boundary
    // are independent: a resolved internal leaf is compact but never "unknown"/greyed.
    const greyed = callScope === "unresolved";
    const isExpanded = expandable && this.expandedState(id, false);
    const targetNode = step.target ? this.index.nodesById.get(step.target) : undefined;
    const nestedDetached = detachedCallSummary(
      calleeFlow,
      (nestedStep) => nestedStep.target !== null
        && declarationSemantics(this.index.nodesById.get(nestedStep.target))?.returnsPromise === true,
    );
    const nestedDetachedCount = nestedDetached.notAwaited + nestedDetached.resultsDropped;
    const semantics = mergeNodeSemantics(
      declarationSemantics(targetNode),
      callOccurrenceSemantics(step),
      nestedDetachedCount > 0
        ? {
            ...(nestedDetached.notAwaited > 0 ? { nestedNotAwaited: nestedDetached.notAwaited } : {}),
            ...(nestedDetached.resultsDropped > 0 ? { nestedResultsDropped: nestedDetached.resultsDropped } : {}),
          }
        : undefined,
    );
    // A detached Promise has no consumer by definition. Giving it a launch socket creates a cyan
    // endpoint with no rail, which reads like a mysterious standalone node. Its violet tail is the
    // complete lifecycle signal; correlation ports are reserved for work that can later be joined.
    const correlatedAsync = step.detached ? undefined : step.async;
    const asyncPorts = correlatedAsync ? asyncPortsForCall(id, step.label, correlatedAsync) : [];
    const data: LogicNodeData = {
      logicKind: "call",
      label: step.label,
      targetId: step.target,
      resolution: step.resolution,
      navigable,
      expandable,
      isExpanded,
      isContainer: isExpanded,
      compact,
      callScope,
      greyed,
      provenance: provenanceOf(step.target, step.resolution, this.index),
      childCount: calleeFlow.length,
      ...(emptyFlow ? { emptyFlow: true } : {}),
      changedStatus: this.changedStatus(step.source),
      targetChangedStatus: step.resolution === "resolved" && step.target !== null
        ? this.index.changedStatus.get(step.target)
        : undefined,
      callKind: display.method ? "method" : "function",
      signature: step.target ? this.index.nodesById.get(step.target)?.signature : undefined,
      ...(semantics ? { semantics } : {}),
      owner: this.ownerLookup(step.target),
      framed,
      awaited: step.awaited,
      detached: step.detached,
      ...(nestedDetachedCount > 0 ? { nestedDetachedCount } : {}),
      ...(step.async ? { asyncEvent: step.async, asyncPorts } : {}),
    };
    this.push(id, parentId, "block", data);
    this.wireCallAsync(correlatedAsync, asyncPorts, id, asyncScope);
    if (isExpanded && calleeFlow.length > 0) {
      this.sequence(calleeFlow, id, logicCallBodyPrefix(path), id, step.target ?? sourceOwnerId);
    }
    return { entry: id, exits: [{ id }] };
  }

  /** A wait with no call block to carry it becomes one small structural node on the normal exec
   * thread. A stored task adds a non-exec correlation rail from its earlier launch; an unnameable
   * direct operand remains a self-contained gate with no invented launch edge. */
  private awaitStep(
    step: Extract<FlowStep, { kind: "await" }>,
    parentId: string | null,
    id: string,
    asyncScope: string,
  ): { entry: string; exits: Exit[] } {
    const asyncPorts = asyncTargetPorts(id, step.inputs);
    const data: LogicNodeData = {
      logicKind: "await",
      label: step.label,
      targetId: null,
      resolution: null,
      expandable: false,
      isExpanded: false,
      isContainer: false,
      compact: false,
      callScope: null,
      greyed: false,
      provenance: null,
      childCount: step.inputs.length,
      changedStatus: this.changedStatus(step.source),
      awaited: true,
      semantics: awaitSemantics(step.inputs.length),
      asyncEvent: { kind: "await", mode: step.mode, inputs: step.inputs },
      asyncPorts,
    };
    this.push(id, parentId, "async", data);
    this.wireAsyncInputs(step.inputs, asyncPorts, id, asyncScope);
    return { entry: id, exits: [{ id }] };
  }

  private wireCallAsync(
    event: FlowCallAsync | undefined,
    ports: LogicAsyncPort[],
    nodeId: string,
    asyncScope: string,
  ): void {
    if (!event) {
      return;
    }
    if (event.kind === "launch") {
      const sourcePort = ports.find((port) => port.direction === "source");
      if (sourcePort) {
        this.asyncLaunches.set(asyncTaskKey(asyncScope, event.taskId), { nodeId, sourcePort: sourcePort.id });
      }
      return;
    }
    if (event.kind === "barrier") {
      this.wireAsyncInputs(event.inputs, ports, nodeId, asyncScope);
    }
    // direct-await launches and waits on this one call node; its source+target ports form a local
    // visual loop in the renderer and intentionally add no graph edge or second node.
  }

  private wireAsyncInputs(
    inputs: FlowAsyncInput[],
    ports: LogicAsyncPort[],
    targetId: string,
    asyncScope: string,
  ): void {
    inputs.forEach((input, index) => {
      if (!input.taskId) {
        return;
      }
      const launch = this.asyncLaunches.get(asyncTaskKey(asyncScope, input.taskId));
      const targetPort = ports[index];
      if (!launch || !targetPort) {
        return;
      }
      this.pushEdge(launch.nodeId, targetId, "async", input.label, {
        sourcePort: launch.sourcePort,
        targetPort: targetPort.id,
        taskId: input.taskId,
      });
    });
  }

  /** Loops, callbacks and the conservative try/finally fallback share the same container shape. */
  private container(
    parentId: string | null,
    path: string,
    id: string,
    logicKind: "loop" | "try" | "callback",
    label: string,
    bodies: FlowPath[],
    childCount: number,
    asyncScope: string,
    sourceOwnerId: string,
    source: FlowSourceAnchor | undefined,
  ): { entry: string; exits: Exit[] } {
    const isExpanded = this.expandedState(id, true);
    const data: LogicNodeData = {
      logicKind,
      label,
      targetId: null,
      resolution: null,
      expandable: true,
      isExpanded,
      isContainer: isExpanded,
      compact: false,
      callScope: null,
      greyed: false,
      provenance: null,
      childCount,
      ...(childCount === 0 ? { emptyFlow: true } : {}),
      changedStatus: this.changedStatus(source),
      sourceContext: { ownerId: sourceOwnerId, ...(source ? { anchor: source } : {}) },
      // Carried so a double-click can DIVE into these sub-chains without re-parsing the flow.
      bodies,
    };
    this.push(id, parentId, "control", data);
    if (isExpanded) {
      // Each body is an independent sub-chain inside the frame. This is deliberately presentation-
      // only for the try/finally fallback; it avoids inventing an incorrect alternative-lane edge.
      bodies.forEach((body, bi) => this.sequence(
        body.body,
        id,
        logicControlBodyPrefix(path, bi),
        asyncScope,
        sourceOwnerId,
      ));
    }
    return { entry: id, exits: [{ id }] };
  }

  private branchStep(
    step: Extract<FlowStep, { kind: "branch" }>,
    parentId: string | null,
    path: string,
    id: string,
    asyncScope: string,
    sourceOwnerId: string,
  ): { entry: string; exits: Exit[] } {
    const kind = branchKindOf(step);
    const isExpanded = this.expandedState(id, true);
    const synthetic = syntheticFallThroughLabel(step);
    const branchPorts: LogicBranchPort[] = step.paths.map((flowPath, order) => ({
      id: branchPortId(id, order),
      label: flowPath.label,
      role: pathRole(flowPath),
      order,
      ...(flowPath.pathId ? { pathId: flowPath.pathId } : {}),
      ...(flowPath.source ? { source: flowPath.source } : {}),
    }));
    if (synthetic) {
      branchPorts.push({
        id: branchPortId(id, branchPorts.length),
        label: synthetic,
        role: "fallthrough",
        order: branchPorts.length,
        synthetic: true,
      });
    }
    const data: LogicNodeData = {
      logicKind: kind,
      label: step.label,
      targetId: null,
      resolution: null,
      expandable: true,
      isExpanded,
      isContainer: false,
      compact: false,
      callScope: null,
      greyed: false,
      provenance: null,
      childCount: branchPorts.length,
      changedStatus: this.changedStatus(step.source),
      branchPorts,
      branchKind: kind,
      ...(step.source ? { branchSource: step.source } : {}),
      sourceContext: { ownerId: sourceOwnerId, ...(step.source ? { anchor: step.source } : {}) },
    };
    // IF/SWITCH own the decision diamond. TRY/CATCH is an exception gate with a straight normal
    // route and a lower catch outlet; keeping a separate node type prevents it reading as a choice.
    this.push(id, parentId, kind === "try" ? "exception" : "branch", data);
    if (!isExpanded) {
      // The structural summary is atomic while folded. Preserve true termination so collapsing an
      // exhaustive return/throw branch cannot manufacture a fall-through path to unreachable code.
      return { entry: id, exits: pathTerminates([step]) ? [] : [{ id }] };
    }
    const exits: Exit[] = [];
    step.paths.forEach((flowPath, pi) => {
      const port = branchPorts[pi];
      const role = pathRole(flowPath);
      const sub = this.sequence(
        flowPath.body,
        parentId,
        logicBranchBodyPrefix(path, pi),
        asyncScope,
        sourceOwnerId,
      );
      if (sub.firstId) {
        this.pushEdge(id, sub.firstId, "branch", flowPath.label, { sourcePort: port.id, branchRole: role });
        // A path that ends at a return/throw cap surfaces NO exits — it dead-ends there instead of
        // being folded back into the merge, so only genuine fall-through reconverges.
        exits.push(...sub.lastExits.map((exit) => ({ ...exit, branchRole: role })));
      } else {
        // An empty path (e.g. an `if` with no `else` body): the branch pin wires straight to the
        // merge point, carrying its label.
        exits.push({ id, edgeLabel: flowPath.label, sourcePort: port.id, branchRole: role });
      }
    });
    // The path the source never wrote: an `if` with no `else` (or a switch with no `default`) falls
    // through, so the branch gets an explicit labeled pin onto the continuation — the "implicit
    // else" made visible instead of the flow pretending nothing happened.
    if (synthetic) {
      const port = branchPorts[branchPorts.length - 1];
      exits.push({ id, edgeLabel: synthetic, sourcePort: port.id, branchRole: "fallthrough" });
    }
    return { entry: id, exits: this.mergeBranchExits(id, parentId, exits) };
  }

  /** TRY and CATCH remain alternative lanes; FINALLY is the single mandatory phase they both feed.
   * It is deliberately outside the branch's path list, so no edge can make cleanup look optional. */
  private tryFinallyStep(
    step: Extract<FlowStep, { kind: "branch" }>,
    parentId: string | null,
    path: string,
    id: string,
    asyncScope: string,
    sourceOwnerId: string,
  ): { entry: string; exits: Exit[] } {
    const { tryPath, catchPath, finallyPath } = tryArms(step);
    // Guarded by canChartFinallyAsSharedPhase; keep the defensive fallback structurally valid.
    if (!tryPath || !catchPath || !finallyPath) {
      const count = step.paths.reduce((sum, candidate) => sum + candidate.body.length, 0);
      return this.container(
        parentId,
        path,
        id,
        "try",
        "try / catch",
        step.paths,
        count,
        asyncScope,
        sourceOwnerId,
        step.source,
      );
    }

    const protectedFlow = this.branchStep(
      { ...step, paths: [tryPath, catchPath] },
      parentId,
      path,
      id,
      asyncScope,
      sourceOwnerId,
    );
    const finallyId = `${id}::finally`;
    const finallyExpandable = true;
    const finallyExpanded = this.expandedState(finallyId, true);
    const finallyData: LogicNodeData = {
      logicKind: "finally",
      label: "finally · always",
      targetId: null,
      resolution: null,
      expandable: finallyExpandable,
      isExpanded: finallyExpanded,
      isContainer: false,
      compact: false,
      callScope: null,
      greyed: false,
      provenance: null,
      childCount: finallyPath.body.length,
      ...(finallyPath.body.length === 0 ? { emptyFlow: true } : {}),
      changedStatus: this.changedStatus(finallyPath.source),
      sourceContext: {
        ownerId: sourceOwnerId,
        ...(finallyPath.source ? { anchor: finallyPath.source } : {}),
      },
    };
    this.push(finallyId, parentId, "finally", finallyData);
    for (const exit of protectedFlow.exits) {
      this.link(exit, finallyId);
    }

    if (!finallyExpanded) {
      return { entry: protectedFlow.entry, exits: [{ id: finallyId }] };
    }

    const cleanup = this.sequence(
      finallyPath.body,
      parentId,
      logicFinallyBodyPrefix(path),
      asyncScope,
      sourceOwnerId,
    );
    if (cleanup.firstId === null) {
      return { entry: protectedFlow.entry, exits: [{ id: finallyId }] };
    }
    this.pushEdge(finallyId, cleanup.firstId, "seq");
    return { entry: protectedFlow.entry, exits: cleanup.lastExits };
  }

  /** A symmetric split -> lanes -> join whenever multiple arms genuinely continue. Paths that end
   * at return/throw expose no exit and are deliberately absent from the merge. A lone surviving arm
   * needs no visual join and keeps its original direct continuation. */
  private mergeBranchExits(branchId: string, parentId: string | null, exits: Exit[]): Exit[] {
    if (exits.length < 2) {
      return exits;
    }
    const id = `${branchId}::join`;
    const data: LogicNodeData = {
      logicKind: "join",
      label: "merge",
      targetId: null,
      resolution: null,
      expandable: false,
      isExpanded: false,
      isContainer: false,
      compact: false,
      callScope: null,
      greyed: false,
      provenance: null,
      childCount: exits.length,
    };
    this.push(id, parentId, "join", data);
    exits.forEach((exit) => this.link(exit, id));
    return [{ id }];
  }

  private isCompactCall(step: FlowStep): boolean {
    if (step.kind !== "call") {
      return false;
    }
    // Async launch/barrier/direct-await calls carry control semantics even when their call card is
    // physically compact. Hiding one would strand a wait socket or erase the only launch marker.
    if (step.async) {
      return false;
    }
    return !callDisplay(step, this.flows, this.index).expandable;
  }

  /** default XOR toggle: calls default collapsed, loop/try default expanded. */
  private expandedState(id: string, defaultExpanded: boolean): boolean {
    return defaultExpanded !== this.expanded.has(id);
  }

  private changedStatus(source: FlowSourceAnchor | undefined): ChangeStatus | undefined {
    return this.options.changedStatusForSource?.(source);
  }

  private link(from: Exit, toId: string): void {
    this.pushEdge(
      from.id,
      toId,
      from.edgeLabel ? "branch" : "seq",
      from.edgeLabel,
      from.sourcePort || from.branchRole
        ? { ...(from.sourcePort ? { sourcePort: from.sourcePort } : {}), ...(from.branchRole ? { branchRole: from.branchRole } : {}) }
        : undefined,
    );
  }

  private pushEdge(
    source: string,
    target: string,
    kind: LogicEdgeSpec["kind"],
    label?: string,
    endpoints?: Pick<LogicEdgeSpec, "sourcePort" | "targetPort" | "taskId" | "branchRole">,
  ): void {
    this.edges.push({ id: `e${this.edgeSeq++}`, source, target, kind, label, ...endpoints });
  }

  private push(id: string, parentId: string | null, type: LogicNodeType, data: LogicNodeData): void {
    const spec: LogicNodeSpec = { id, parentId, type, data };
    // Containers need the same measured header floor as their collapsed card; otherwise ELK sizes
    // only around narrow children and the kind/Promise/state/source/disclosure rail clips.
    const { width, height } = logicNodeSize(data, type);
    spec.width = width;
    spec.height = height;
    this.nodes.push(spec);
  }
}

/** Package + module the building block comes from, so a block is never a bare name. */
function provenanceOf(
  targetId: string | null,
  resolution: EdgeResolution,
  index: GraphIndex,
): { pkg: string; module: string } | null {
  if (targetId === null) {
    return resolution === "unresolved" ? { pkg: "unresolved", module: "dynamic" } : null;
  }
  const parts = parseNodeId(targetId);
  const module = baseName(parts.modulePath);
  const node = index.nodesById.get(targetId);
  if (node) {
    const ancestors = index.ancestorsOf(targetId);
    const pkg = ancestors[0]?.displayName ?? firstSegment(parts.modulePath);
    return { pkg, module };
  }
  if (parts.lang === "unresolved") {
    return { pkg: "unresolved", module: module || "dynamic" };
  }
  return { pkg: firstSegment(parts.modulePath) || "external", module: module || parts.modulePath };
}

function firstSegment(path: string): string {
  return path.split("/")[0] ?? path;
}

function callScopeOf(resolution: EdgeResolution): LogicCallScope {
  if (resolution === "resolved") {
    return "internal";
  }
  return resolution;
}

/** Stable across relayout, hiding compact calls, and branch-arm contents changing. */
function branchPortId(branchId: string, order: number): string {
  return `${branchId}::port/${order}`;
}

function asyncPortsForCall(nodeId: string, label: string, event: FlowCallAsync): LogicAsyncPort[] {
  if (event.kind === "launch") {
    return [{
      id: asyncPortId(nodeId, "source", 0),
      direction: "source",
      label: event.binding ?? label,
      taskId: event.taskId,
      order: 0,
    }];
  }
  if (event.kind === "barrier") {
    return asyncTargetPorts(nodeId, event.inputs);
  }
  // Direct await is both ends of a task lifetime on one call node. No correlation edge is emitted;
  // the two ports give the renderer stable anchors for the local launch->wait loop.
  return [
    { id: asyncPortId(nodeId, "source", 0), direction: "source", label, taskId: event.taskId, order: 0 },
    { id: asyncPortId(nodeId, "target", 0), direction: "target", label, taskId: event.taskId, order: 0 },
  ];
}

function asyncTargetPorts(nodeId: string, inputs: FlowAsyncInput[]): LogicAsyncPort[] {
  return inputs.map((input, order) => ({
    id: asyncPortId(nodeId, "target", order),
    direction: "target",
    label: input.label,
    ...(input.taskId ? { taskId: input.taskId } : {}),
    order,
  }));
}

function asyncPortId(nodeId: string, direction: LogicAsyncPort["direction"], order: number): string {
  return `${nodeId}::async/${direction}/${order}`;
}

function asyncTaskKey(scope: string, taskId: string): string {
  return `${scope}\u0000${taskId}`;
}

// The signature line's vertical band a non-greyed block grows by. Named so the render height (in
// logicNodeTypes) and the laid-out box stay in lockstep. The owner is now the enclosing service
// frame, not a per-block row, so a block only grows for its signature.
const SIGNATURE_ROW_H = 16;
// End-caps are compact pills — no provenance or disclosure. The EXIT cap only ever says "EXIT", so it
// keeps a fixed width; the ENTRY cap wears the flow's own callable name (+ an ENTRY tag), so it sizes
// to that name rather than clipping it.
const TERMINAL_WIDTH = 150;
const TERMINAL_HEIGHT = 46;
const ENTRY_MIN_WIDTH = 150;
const ENTRY_MAX_WIDTH = 460;
const ENTRY_CHROME = 92; // border + padding (14+14) + glyph + two 8px gaps + the ENTRY tag pill

/** The ENTRY end-cap's width: its callable name plus the fixed chrome of the pill and its ENTRY tag. */
function entryTerminalWidth(label: string): number {
  return roundedClamp(ENTRY_MIN_WIDTH, ENTRY_MAX_WIDTH, ENTRY_CHROME + monoTextWidth(label, 12));
}

// A call block's title is `glyph + name + a right-aligned tail` (the expand toggle, the </> code
// button, and occasionally an async / coverage badge). The name must clear the glyph, the padding, and
// that tail, so the box is sized to fit the whole name rather than truncating it under the buttons.
const BLOCK_TITLE_FONT = 12;
const BLOCK_TITLE_CHROME = 30; // title padding (8+8) + border (2) + gaps around the kind chip
const BLOCK_TITLE_TAIL = 42 + NODE_DISCLOSURE_SIZE; // room for the disclosure + </> buttons
const BLOCK_MIN_WIDTH = 190;
const BLOCK_MAX_WIDTH = 620;
const CONTAINER_MAX_WIDTH = 760;
/** Paint/layout contract for the provenance chip moved into an expanded frame's header. */
export const FRAME_PROVENANCE_MAX_WIDTH = 150;
// Any resolved call card may gain a coverage battery at render time, independently of graph
// derivation. Reserve its fixed footprint on leaves and frames alike; changed/def slots are added
// from serializable data below. Source/disclosure stay in the fixed title-tail reserve.
const CALL_INDICATOR_RESERVE = 38;
// A compact leaf stays a small chip — its 30px height says "no child flow" without implying anything
// about whether the call is internal/external/unresolved. Its name remains priority and never clips.
const COMPACT_TITLE_FONT = 10;
const COMPACT_TITLE_CHROME = 22; // title padding (6+6) + border (2) + gaps around the kind chip
const COMPACT_TITLE_TAIL = 34; // room for the </> button; semantic chips are measured below
const COMPACT_MIN_WIDTH = 96;
const TARGET_CHANGED_BADGE_WIDTH = 88;
const COMPACT_MAX_WIDTH = 600;

/** Shared paint-aware measurement for a Logic node, including the common kind/semantic rail. */
export function logicNodeSize(data: LogicNodeData, type: LogicNodeType): { width: number; height: number } {
  const callHeaderExtra = type === "block"
    ? CALL_INDICATOR_RESERVE
      + (data.isContainer && data.provenance
        ? 5 + Math.min(
            FRAME_PROVENANCE_MAX_WIDTH,
            monoTextWidth(`${data.provenance.pkg} › ${data.provenance.module}`, 9),
          )
        : 0)
      + (data.changedStatus ? 20 : 0)
      + (data.definition ? 24 : 0)
      + (data.targetChangedStatus ? TARGET_CHANGED_BADGE_WIDTH : 0)
    : 0;
  const measured = sizeFor(
    data.label,
    data.compact,
    type,
    Boolean(data.signature) && !data.definition,
    Boolean(data.provenance),
    data.callKind ?? data.logicKind,
    data.semantics,
    callHeaderExtra,
    data.isContainer ? CONTAINER_MAX_WIDTH : BLOCK_MAX_WIDTH,
  );
  return data.emptyFlow && data.isExpanded
    ? { width: Math.max(260, measured.width), height: Math.max(NODE_EMPTY_EXPANSION_HEIGHT, measured.height) }
    : measured;
}

function sizeFor(
  label: string,
  compact: boolean,
  type: LogicNodeType,
  hasSignature: boolean,
  hasProvenance: boolean,
  kind: string,
  semantics: NodeSemanticModel | undefined,
  headerExtra: number,
  blockMaxWidth: number,
): { width: number; height: number } {
  if (type === "join") {
    // A one-way funnel, deliberately wider than a line but nowhere near a decision diamond.
    return { width: 42, height: 72 };
  }
  if (type === "async") {
    return {
      width: roundedClamp(150, 420, 30 + kindChipWidth(kind) + monoTextWidth(label, 10.5) + semanticRailWidth(semantics)),
      height: 42,
    };
  }
  if (compact) {
    // External leaves stay one row. Resolved/unresolved leaves with provenance reserve a real
    // second row; the former 30px blanket height clipped that row behind BODY overflow.
    return {
      width: roundedClamp(
        COMPACT_MIN_WIDTH,
        COMPACT_MAX_WIDTH,
        COMPACT_TITLE_CHROME
          + kindChipWidth(kind)
          + monoTextWidth(label, COMPACT_TITLE_FONT)
          + COMPACT_TITLE_TAIL
          + semanticRailWidth(semantics)
          + headerExtra,
      ),
      height: hasProvenance ? 42 : 30,
    };
  }
  // Fit glyph + name + the title tail; the signature row adds its band below so it never clips either.
  return {
    width: roundedClamp(
      BLOCK_MIN_WIDTH,
      blockMaxWidth,
      BLOCK_TITLE_CHROME
        + kindChipWidth(kind)
        + monoTextWidth(label, BLOCK_TITLE_FONT)
        + BLOCK_TITLE_TAIL
        + semanticRailWidth(semantics)
        + headerExtra,
    ),
    height: 66 + (hasSignature ? SIGNATURE_ROW_H : 0),
  };
}

function kindChipWidth(kind: string): number {
  return 10 + monoTextWidth(displayNodeKind(kind), 7.5);
}

function semanticRailWidth(semantics: NodeSemanticModel | undefined): number {
  const labels = semanticLabels(semantics);
  if (labels.length === 0) return 0;
  return 6 + labels.reduce((width, label) => {
    const measured = monoTextWidth(label, 7.5);
    const capped = label.startsWith("LAUNCHED · ")
      ? Math.min(measured, SEMANTIC_STATE_TEXT_MAX_WIDTH)
      : measured;
    return width + 10 + capped;
  }, 0) + (labels.length - 1) * 4;
}

function roundedClamp(min: number, max: number, value: number): number {
  return Math.round(clamp(min, max, value));
}

// Mid-flow return/throw caps are compact pills sized to their (truncated) expression.
const EXIT_CAP_HEIGHT = 34;

function exitCapWidth(label: string): number {
  return roundedClamp(96, 260, 36 + label.length * 6.6);
}
