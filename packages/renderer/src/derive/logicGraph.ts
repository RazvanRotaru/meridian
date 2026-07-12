/**
 * Derive a callable's logic flow into a pre-layout graph spec — the Unreal-Blueprints-style exec
 * graph the Logic tab renders. Calls become "building block" nodes (Blueprint function nodes);
 * `for`/`while`/`try` become expandable containers; `if`/`switch` become Branch nodes whose paths
 * leave as labeled edges (Unreal's True/False exec pins). "seq" edges are the white exec thread,
 * emitted left→right in execution order; a branch's paths reconverge onto the following step.
 *
 * Pure: (rootId, flows, index, expanded set, options) → {nodes, edges}. No React, no ELK.
 */

import type { EdgeResolution, FlowPath, FlowStep, GraphNode, LogicFlows } from "@meridian/core";
import { branchKindOf, exitLabel, parseNodeId, syntheticFallThroughLabel } from "@meridian/core";
import type { GraphIndex } from "../graph/graphIndex";
import { baseName, callDisplay } from "./flowViewModel";
import type { LogicOwner, OwnerLookup } from "./logicOwner";
import { clamp, monoTextWidth } from "../layout/measure";
import { buildPinModel, PIN_ROW_H, type PinModel } from "./signaturePins";

/** No owner/signature enrichment — the default when a caller (e.g. a unit test) supplies no lookup. */
const NO_OWNER: OwnerLookup = () => null;

export type LogicNodeType = "block" | "control" | "branch" | "servicegroup" | "terminal";

export type LogicNodeData = {
  logicKind: "call" | "loop" | "try" | "callback" | "if" | "switch" | "service";
  label: string;
  /** The untruncated `if`/`switch` condition, shown on the branch diamond's HOVER when `label` was
   * clipped for the compact on-node display. Undefined when the condition already fit (the hover
   * then falls back to `label`, which carries it in full). Only set on branch nodes. */
  fullLabel?: string;
  targetId: string | null;
  resolution: EdgeResolution | null;
  expandable: boolean;
  isExpanded: boolean;
  isContainer: boolean;
  greyed: boolean;
  provenance: { pkg: string; module: string } | null;
  childCount: number;
  /** A callable DEFINED in the open module (not a step in its load-flow): rendered as a distinct
   * disconnected "defined here" node so the view can style it apart from ordinary call blocks. */
  definition?: boolean;
  /** The sub-chains a control container holds (a loop's single body, or a try's try/catch/finally
   * arms). Set ONLY on `control` nodes so a double-click can DIVE into them without re-parsing the
   * flow; undefined on calls/branches. */
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
  /** The typed data ports drawn on the block — input pins (the callee's params) and an output pin
   * (its return), derived from the resolved target's `signature`. Null/absent when nothing is known
   * (external/unresolved call, or a `foo()` with no params and no return) so a gap shows honestly
   * rather than as a guessed port. Only set on non-greyed in-flow call blocks. */
  pins?: PinModel | null;
};

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
  /** The charted callable is itself in the PR's diff — set on the ENTRY cap so a drilled-into changed
   * function announces the diff even when none of its own calls target changed code. */
  changed?: boolean;
};

export interface LogicNodeSpec {
  id: string;
  parentId: string | null;
  type: LogicNodeType;
  data: LogicNodeData | TerminalData;
  width?: number;
  height?: number;
}

export interface LogicEdgeSpec {
  id: string;
  source: string;
  target: string;
  kind: "seq" | "branch";
  label?: string;
}

export interface LogicGraphSpec {
  nodes: LogicNodeSpec[];
  edges: LogicEdgeSpec[];
}

/** An outgoing exec connection point; `edgeLabel` marks a branch pin (e.g. an empty `else`). */
interface Exit {
  id: string;
  edgeLabel?: string;
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

export function deriveLogicGraph(
  rootId: string,
  flows: LogicFlows,
  index: GraphIndex,
  expandedLogic: ReadonlySet<string>,
  // `withTerminals` frames a TOP-LEVEL callable flow with entry/exit end-caps (see build()); the
  // container-dive path leaves it off. `nestByService` groups consecutive same-owner calls under
  // service frames. Both optional so existing callers/tests default them off.
  options: { hideGreyed: boolean; nestByService?: boolean; withTerminals?: boolean },
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
  options: { hideGreyed: boolean; nestByService?: boolean },
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
 * `targetId`/`expandable` path an ordinary call block uses. `expandable` reflects whether that
 * callable actually ships a flow to dive into; provenance reads as `<owner> › <name>` (the owning
 * object/class/module, then the callable) so a bare method name always shows where it lives.
 */
export function definitionNodeData(
  callableId: string,
  flows: LogicFlows,
  index: GraphIndex,
  ownerLookup: OwnerLookup = NO_OWNER,
): LogicNodeData {
  const node = index.nodesById.get(callableId);
  const expandable = (flows[callableId]?.length ?? 0) > 0;
  return {
    logicKind: "call",
    definition: true,
    label: node?.displayName ?? baseName(parseNodeId(callableId).modulePath),
    targetId: callableId,
    resolution: "resolved",
    expandable,
    isExpanded: false,
    isContainer: false,
    greyed: false,
    provenance: definitionProvenance(callableId, node, index),
    childCount: expandable ? flows[callableId].length : 0,
    // A declared callable's own node kind is authoritative here (no receiver to infer from).
    callKind: node?.kind === "method" ? "method" : "function",
    signature: node?.signature,
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
  private edgeSeq = 0;

  constructor(
    private readonly rootId: string,
    private readonly flows: LogicFlows,
    private readonly index: GraphIndex,
    private readonly expanded: ReadonlySet<string>,
    private readonly options: { hideGreyed: boolean; nestByService?: boolean; withTerminals?: boolean },
    private readonly ownerLookup: OwnerLookup,
  ) {}

  build(steps: FlowStep[]): LogicGraphSpec {
    const { firstId, lastExits } = this.sequence(steps, null, "");
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
    const entryData: TerminalData = { targetId: null, isContainer: false, terminal: "entry", label: entry?.displayName ?? baseName(parseNodeId(this.rootId).modulePath), changed: this.index.changedIds.has(this.rootId) };
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
    bodies.forEach((body, i) => this.sequence(body.body, null, `p${i}/`));
    return { nodes: this.nodes, edges: this.edges };
  }

  /**
   * Emit one nesting level, grouping consecutive calls to the SAME owning service into one frame so
   * the flow reads UML-like (mirrors the composition view): a run of framable calls nests under a
   * service-frame container, everything else emits flat. Exec wires are UNCHANGED — they thread
   * block→block in execution order across frame boundaries (ELK's root INCLUDE_CHILDREN routes them),
   * so `firstId`/`lastExits` still stitch branches and loops exactly as before.
   */
  private sequence(steps: FlowStep[], parentId: string | null, prefix: string): { firstId: string | null; lastExits: Exit[] } {
    let firstId: string | null = null;
    let prevExits: Exit[] = [];
    for (const unit of this.planLevel(steps, prefix)) {
      const stepParent = unit.frame ? this.emitServiceFrame(unit.frame, unit.steps.length, parentId) : parentId;
      for (const { step, i } of unit.steps) {
        const emit = this.step(step, stepParent, `${prefix}${i}`, unit.frame !== null);
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
   * (each a `frame` unit), with every other step a lone flat unit. hideGreyed leaves are dropped here
   * (they never join a run), matching the old skip. Original indices ride along so ids stay stable.
   */
  private planLevel(steps: FlowStep[], prefix: string): RunUnit[] {
    const units: RunUnit[] = [];
    let run: { owner: LogicOwner; steps: IndexedStep[] } | null = null;
    const flush = () => {
      if (run) {
        units.push({ frame: { owner: run.owner, id: `${this.rootId}::svc/${prefix}${run.steps[0].i}` }, steps: run.steps });
        run = null;
      }
    };
    steps.forEach((step, i) => {
      if (this.options.hideGreyed && this.isGreyedLeaf(step)) {
        return;
      }
      const owner = this.framableOwner(step, `${this.rootId}::${prefix}${i}`);
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
    const expandable = step.resolution === "resolved" && step.target !== null && (this.flows[step.target]?.length ?? 0) > 0;
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
      greyed: false,
      provenance: null,
      childCount,
      owner: frame.owner,
    };
    this.push(frame.id, parentId, "servicegroup", data, false);
    return frame.id;
  }

  private step(step: FlowStep, parentId: string | null, path: string, framed: boolean): { entry: string; exits: Exit[] } {
    const id = `${this.rootId}::${path}`;
    if (step.kind === "call") {
      return this.callStep(step, parentId, path, id, framed);
    }
    if (step.kind === "exit") {
      return this.exitStep(step, parentId, id);
    }
    if (step.kind === "loop" || step.kind === "callback") {
      const bodies: FlowPath[] = [{ label: step.label, body: step.body }];
      return this.container(parentId, path, id, step.kind, step.label, bodies, step.body.length);
    }
    if (branchKindOf(step) === "try") {
      const count = step.paths.reduce((sum, p) => sum + p.body.length, 0);
      return this.container(parentId, path, id, "try", "try / catch", step.paths, count);
    }
    return this.branchStep(step, parentId, path, id);
  }

  /**
   * A charted `return`/`throw`: a terminal cap this path DEAD-ENDS at. It exposes NO exec exits, so
   * nothing links onward from it — a guard's then-path visibly stops instead of silently rejoining
   * the thread, and a branch merges only what genuinely falls through.
   */
  private exitStep(step: Extract<FlowStep, { kind: "exit" }>, parentId: string | null, id: string): { entry: string; exits: Exit[] } {
    const label = exitLabel(step);
    const data: TerminalData = { targetId: null, isContainer: false, terminal: step.variant, label };
    // The cap DISPLAYS only the variant word (`return`/`throw`) — like the EXIT pill — with the
    // returned/thrown expression (`label`) revealed on hover. So it's sized to the word, not the expr.
    this.nodes.push({ id, parentId, type: "terminal", data, width: exitCapWidth(step.variant), height: EXIT_CAP_HEIGHT });
    return { entry: id, exits: [] };
  }

  private callStep(
    step: Extract<FlowStep, { kind: "call" }>,
    parentId: string | null,
    path: string,
    id: string,
    framed: boolean,
  ): { entry: string; exits: Exit[] } {
    const display = callDisplay(step, this.flows, this.index);
    const expandable = display.expandable;
    const greyed = !expandable;
    const isExpanded = expandable && this.expandedState(id, false);
    const signature = step.target ? this.index.nodesById.get(step.target)?.signature ?? null : null;
    const data: LogicNodeData = {
      logicKind: "call",
      label: step.label,
      targetId: step.target,
      resolution: step.resolution,
      expandable,
      isExpanded,
      isContainer: isExpanded,
      greyed,
      provenance: provenanceOf(step.target, step.resolution, this.index),
      childCount: expandable && step.target ? this.flows[step.target].length : 0,
      callKind: display.method ? "method" : "function",
      signature: signature ?? undefined,
      // A greyed leaf stays a compact chip (no ports); every other in-flow call shows its typed I/O.
      pins: greyed ? null : buildPinModel(signature),
      owner: this.ownerLookup(step.target),
      framed,
      awaited: step.awaited,
      detached: step.detached,
    };
    this.push(id, parentId, "block", data, greyed);
    if (isExpanded && step.target) {
      this.sequence(this.flows[step.target], id, `${path}/`);
    }
    return { entry: id, exits: [{ id }] };
  }

  /** Loop, try/catch and callback share the same container shape: default-expanded, children nested. */
  private container(
    parentId: string | null,
    path: string,
    id: string,
    logicKind: "loop" | "try" | "callback",
    label: string,
    bodies: FlowPath[],
    childCount: number,
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
      greyed: false,
      provenance: null,
      childCount,
      // Carried so a double-click can DIVE into these sub-chains without re-parsing the flow.
      bodies,
    };
    this.push(id, parentId, "control", data, false);
    if (isExpanded) {
      // Each body is an independent sub-chain inside the frame (a try's catch/finally do not run
      // sequentially after its try block), so they are not exec-linked to each other.
      bodies.forEach((body, bi) => this.sequence(body.body, id, `${path}/p${bi}/`));
    }
    return { entry: id, exits: [{ id }] };
  }

  private branchStep(
    step: Extract<FlowStep, { kind: "branch" }>,
    parentId: string | null,
    path: string,
    id: string,
  ): { entry: string; exits: Exit[] } {
    const data: LogicNodeData = {
      logicKind: branchKindOf(step) === "switch" ? "switch" : "if",
      label: step.label,
      // The whole condition for the hover; undefined for a short one, where the diamond falls back
      // to `label` (which is then already complete).
      fullLabel: step.fullLabel,
      targetId: null,
      resolution: null,
      expandable: false,
      isExpanded: false,
      isContainer: false,
      greyed: false,
      provenance: null,
      childCount: step.paths.length,
    };
    this.push(id, parentId, "branch", data, false);
    const exits: Exit[] = [];
    step.paths.forEach((flowPath, pi) => {
      const sub = this.sequence(flowPath.body, parentId, `${path}/b${pi}/`);
      if (sub.firstId) {
        this.pushEdge(id, sub.firstId, "branch", flowPath.label);
        // A path that ends at a return/throw cap surfaces NO exits — it dead-ends there instead of
        // being folded back into the merge, so only genuine fall-through reconverges.
        exits.push(...sub.lastExits);
      } else {
        // An empty path (e.g. an `if` with no `else` body): the branch pin wires straight to the
        // merge point, carrying its label.
        exits.push({ id, edgeLabel: flowPath.label });
      }
    });
    // The path the source never wrote: an `if` with no `else` (or a switch with no `default`) falls
    // through, so the branch gets an explicit labeled pin onto the continuation — the "implicit
    // else" made visible instead of the flow pretending nothing happened.
    const synthetic = syntheticFallThroughLabel(step);
    if (synthetic) {
      exits.push({ id, edgeLabel: synthetic });
    }
    return { entry: id, exits };
  }

  private isGreyedLeaf(step: FlowStep): boolean {
    if (step.kind !== "call") {
      return false;
    }
    return !(step.resolution === "resolved" && step.target !== null && (this.flows[step.target]?.length ?? 0) > 0);
  }

  /** default XOR toggle: calls default collapsed, loop/try default expanded. */
  private expandedState(id: string, defaultExpanded: boolean): boolean {
    return defaultExpanded !== this.expanded.has(id);
  }

  private link(from: Exit, toId: string): void {
    this.pushEdge(from.id, toId, from.edgeLabel ? "branch" : "seq", from.edgeLabel);
  }

  private pushEdge(source: string, target: string, kind: "seq" | "branch", label?: string): void {
    this.edges.push({ id: `e${this.edgeSeq++}`, source, target, kind, label });
  }

  private push(id: string, parentId: string | null, type: LogicNodeType, data: LogicNodeData, greyed: boolean): void {
    const spec: LogicNodeSpec = { id, parentId, type, data };
    if (!data.isContainer) {
      const { width, height } = sizeFor(data.label, greyed, type, data.pins ?? null);
      spec.width = width;
      spec.height = height;
    }
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

// A call block's fixed chrome above its data pins — the title bar plus the provenance line plus
// padding. The pin rows (PIN_ROW_H each) stack below it; a block with NO pins keeps the original
// flat height instead. Kept here so the laid-out box matches the render in logicNodeTypes.
const PIN_BLOCK_BASE = 58;
const FLAT_BLOCK_HEIGHT = 66;
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
const BLOCK_TITLE_CHROME = 40; // title padding (8+8) + border (2) + glyph (~10) + two 6px gaps
const BLOCK_TITLE_TAIL = 58; // room for the expand + </> buttons (async / coverage badges ride here too)
const BLOCK_MIN_WIDTH = 190;
const BLOCK_MAX_WIDTH = 460;
// A greyed leaf stays a compact chip — its 30px height already reads as "leaf, no flow" — but its name
// is priority and must never clip, so its width still tracks the name plus its smaller tail.
const GREY_TITLE_FONT = 10;
const GREY_TITLE_CHROME = 30; // title padding (6+6) + border (2) + glyph (~8) + two 4px gaps
const GREY_TITLE_TAIL = 34; // room for the </> button (+ an occasional async badge)
const GREY_MIN_WIDTH = 96;
const GREY_MAX_WIDTH = 320;
// A decision DIAMOND sized to hold its condition: the text sits in the rhombus's central band, which
// narrows toward the top/bottom vertices — so the box must be WIDER than the text by that band
// fraction for the text to clear the slanted edges. CHROME is a little breathing room; the height is
// fixed so the diamond stays a glanceable, consistent shape.
const BRANCH_TEXT_BAND = 0.6;
const BRANCH_CHROME = 20;
const BRANCH_HEIGHT = 58;
const BRANCH_MIN_WIDTH = 96;
const BRANCH_MAX_WIDTH = 320;

function sizeFor(
  label: string,
  greyed: boolean,
  type: LogicNodeType,
  pins: PinModel | null,
): { width: number; height: number } {
  if (type === "branch") {
    // A decision DIAMOND sized to fit its condition in the rhombus's central band (full text on
    // hover). The condition drops the leading if/switch keyword — the diamond shape says "decision".
    const condWidth = monoTextWidth(branchCondition(label), 11);
    return { width: roundedClamp(BRANCH_MIN_WIDTH, BRANCH_MAX_WIDTH, condWidth / BRANCH_TEXT_BAND + BRANCH_CHROME), height: BRANCH_HEIGHT };
  }
  if (greyed) {
    // A small chip, but sized so the priority name never clips under its tail.
    return { width: roundedClamp(GREY_MIN_WIDTH, GREY_MAX_WIDTH, GREY_TITLE_CHROME + monoTextWidth(label, GREY_TITLE_FONT) + GREY_TITLE_TAIL), height: 30 };
  }
  // Fit glyph + name + the title tail; the widest pin row must clear the box too, so a long
  // `param: Type` never clips under the node's right edge.
  const titleWidth = BLOCK_TITLE_CHROME + monoTextWidth(label, BLOCK_TITLE_FONT) + BLOCK_TITLE_TAIL;
  const width = roundedClamp(BLOCK_MIN_WIDTH, BLOCK_MAX_WIDTH, Math.max(titleWidth, pinRowWidth(pins)));
  const rows = pinRowCount(pins);
  // A block with pins grows one PIN_ROW_H band per port row below its chrome; one with none keeps
  // the original flat height (an unresolved/void-only call stays compact).
  const height = rows === 0 ? FLAT_BLOCK_HEIGHT : PIN_BLOCK_BASE + rows * PIN_ROW_H;
  return { width, height };
}

/** How many port rows a block draws: one per shown input, one for the "+N hidden" row when the cap
 * bit, and one for the output. Zero when there are no pins at all. */
function pinRowCount(pins: PinModel | null): number {
  if (!pins) {
    return 0;
  }
  return pins.inputs.length + (pins.hiddenInputs > 0 ? 1 : 0) + (pins.output ? 1 : 0);
}

// A pin row is `[dot] name?: type` (inputs) or `type [dot]` (output), set in the 11px mono stack;
// this chrome covers the dot, its gaps and the row's horizontal padding.
const PIN_ROW_FONT = 11;
const PIN_ROW_CHROME = 26;

/** The widest port row's pixel width, so the node box fits its longest `param: Type`. Zero for a
 * block with no pins (its width then tracks the title alone, exactly as before). */
function pinRowWidth(pins: PinModel | null): number {
  if (!pins) {
    return 0;
  }
  const widths = pins.inputs.map((pin) => monoTextWidth(inputPinText(pin), PIN_ROW_FONT));
  if (pins.output) {
    widths.push(monoTextWidth(pins.output.type, PIN_ROW_FONT));
  }
  return PIN_ROW_CHROME + Math.max(0, ...widths);
}

/** The label a single input pin renders — `...`/`?` markers folded in, `: type` when annotated. */
export function inputPinText(pin: { name: string; type: string | null; optional: boolean; rest: boolean }): string {
  const head = `${pin.rest ? "..." : ""}${pin.name}${pin.optional ? "?" : ""}`;
  return pin.type ? `${head}: ${pin.type}` : head;
}

/** The condition shown ON a branch decision node — the leading `if`/`switch` keyword dropped (the
 * diamond shape already says "decision"). Shared by the layout sizing and the render so the diamond
 * is always wide enough for the text it draws (full text rides the hover title). */
export function branchCondition(label: string): string {
  return label.replace(/^(if|switch)\b\s*/, "").trim() || label;
}

function roundedClamp(min: number, max: number, value: number): number {
  return Math.round(clamp(min, max, value));
}

// Mid-flow return/throw caps are compact pills sized to the word they show (`return`/`throw`); the
// expression itself is on hover, so it never widens the cap.
const EXIT_CAP_HEIGHT = 34;

function exitCapWidth(word: string): number {
  return roundedClamp(96, 260, 36 + word.length * 6.6);
}
