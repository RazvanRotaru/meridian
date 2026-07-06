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
import { parseNodeId } from "@meridian/core";
import type { GraphIndex } from "../graph/graphIndex";
import type { LogicOwner, OwnerLookup } from "./logicOwner";
import { clamp } from "../layout/measure";

/** No owner/signature enrichment — the default when a caller (e.g. a unit test) supplies no lookup. */
const NO_OWNER: OwnerLookup = () => null;

export type LogicNodeType = "block" | "control" | "branch" | "servicegroup" | "terminal";

export type LogicNodeData = {
  logicKind: "call" | "loop" | "try" | "callback" | "if" | "switch" | "service";
  label: string;
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
  terminal: "entry" | "exit";
  label: string;
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
    const entryData: TerminalData = { targetId: null, isContainer: false, terminal: "entry", label: entry?.displayName ?? baseName(parseNodeId(this.rootId).modulePath) };
    this.nodes.push({ id: entryId, parentId: null, type: "terminal", data: entryData, width: TERMINAL_WIDTH, height: TERMINAL_HEIGHT });
    this.pushEdge(entryId, firstId, "seq");
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
    if (step.kind === "loop" || step.kind === "callback") {
      const bodies: FlowPath[] = [{ label: step.label, body: step.body }];
      return this.container(parentId, path, id, step.kind, step.label, bodies, step.body.length);
    }
    if (isTryLabel(step.label)) {
      const count = step.paths.reduce((sum, p) => sum + p.body.length, 0);
      return this.container(parentId, path, id, "try", "try / catch", step.paths, count);
    }
    return this.branchStep(step, parentId, path, id);
  }

  private callStep(
    step: Extract<FlowStep, { kind: "call" }>,
    parentId: string | null,
    path: string,
    id: string,
    framed: boolean,
  ): { entry: string; exits: Exit[] } {
    const expandable = step.resolution === "resolved" && step.target !== null && (this.flows[step.target]?.length ?? 0) > 0;
    const greyed = !expandable;
    const isExpanded = expandable && this.expandedState(id, false);
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
      callKind: this.callKindOf(step),
      signature: step.target ? this.index.nodesById.get(step.target)?.signature : undefined,
      owner: this.ownerLookup(step.target),
      framed,
    };
    this.push(id, parentId, "block", data, greyed);
    if (isExpanded && step.target) {
      this.sequence(this.flows[step.target], id, `${path}/`);
    }
    return { entry: id, exits: [{ id }] };
  }

  /**
   * Function vs method for a call step. Prefer the RESOLVED target's own node kind; otherwise (an
   * unresolved/external call, or a target that isn't a method) fall back to the label shape — a
   * `receiver.method` label (anything with a `.`, e.g. `store.selectSessionId`, `this.foo`,
   * `mixpanelService.track`) reads as a method call. See `callKind`'s note on the heuristic's limits.
   */
  private callKindOf(step: Extract<FlowStep, { kind: "call" }>): "function" | "method" {
    const target = step.target ? this.index.nodesById.get(step.target) : undefined;
    if (target?.kind === "method") {
      return "method";
    }
    return step.label.includes(".") ? "method" : "function";
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
      logicKind: step.label.startsWith("switch") ? "switch" : "if",
      label: step.label,
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
        exits.push(...sub.lastExits);
      } else {
        // An empty path (e.g. an `if` with no `else` body): the branch pin wires straight to the
        // merge point, carrying its label.
        exits.push({ id, edgeLabel: flowPath.label });
      }
    });
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
      const { width, height } = sizeFor(data.label, greyed, type, Boolean(data.signature));
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

function baseName(path: string): string {
  const segments = path.split("/");
  return segments[segments.length - 1] || path;
}

function firstSegment(path: string): string {
  return path.split("/")[0] ?? path;
}

// The signature line's vertical band a non-greyed block grows by. Named so the render height (in
// logicNodeTypes) and the laid-out box stay in lockstep. The owner is now the enclosing service
// frame, not a per-block row, so a block only grows for its signature.
const SIGNATURE_ROW_H = 16;
// Entry/exit end-caps are compact fixed-size pills — they carry no provenance or disclosure, so
// unlike call blocks their width doesn't track label length.
const TERMINAL_WIDTH = 150;
const TERMINAL_HEIGHT = 46;

function sizeFor(
  label: string,
  greyed: boolean,
  type: LogicNodeType,
  hasSignature: boolean,
): { width: number; height: number } {
  if (type === "branch") {
    // A FIXED, glanceable decision diamond. Its content is always a single "X" (the condition is
    // revealed on demand in an inline panel), so the node never tracks label length — it stays a
    // small, constant marker, never a sprawling box.
    return { width: 72, height: 56 };
  }
  if (greyed) {
    // A small chip: clearly smaller than an expandable block so size alone signals "leaf, no flow".
    return { width: roundedClamp(88, 150, 22 + label.length * 5.6), height: 30 };
  }
  // Base clears the title + provenance; the signature row adds its band so the block never clips it.
  return { width: roundedClamp(190, 360, 44 + label.length * 7.2), height: 66 + (hasSignature ? SIGNATURE_ROW_H : 0) };
}

function roundedClamp(min: number, max: number, value: number): number {
  return Math.round(clamp(min, max, value));
}

function isTryLabel(label: string): boolean {
  return label === "try/catch";
}
