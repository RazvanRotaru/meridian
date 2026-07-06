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

export type LogicNodeType = "block" | "control" | "branch";

export type LogicNodeData = {
  logicKind: "call" | "loop" | "try" | "if" | "switch";
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
   * smell — the block's "service relationship" chip, and the seam that links across to that view. */
  owner?: LogicOwner | null;
};

export interface LogicNodeSpec {
  id: string;
  parentId: string | null;
  type: LogicNodeType;
  data: LogicNodeData;
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

export function deriveLogicGraph(
  rootId: string,
  flows: LogicFlows,
  index: GraphIndex,
  expandedLogic: ReadonlySet<string>,
  options: { hideGreyed: boolean },
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
  options: { hideGreyed: boolean },
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
    private readonly options: { hideGreyed: boolean },
    private readonly ownerLookup: OwnerLookup,
  ) {}

  build(steps: FlowStep[]): LogicGraphSpec {
    this.sequence(steps, null, "");
    return { nodes: this.nodes, edges: this.edges };
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

  /** Emit one nesting level as a chain of exec-linked steps; return its entry + trailing exits. */
  private sequence(steps: FlowStep[], parentId: string | null, prefix: string): { firstId: string | null; lastExits: Exit[] } {
    let firstId: string | null = null;
    let prevExits: Exit[] = [];
    steps.forEach((step, i) => {
      if (this.options.hideGreyed && this.isGreyedLeaf(step)) {
        return; // skip the node; prevExits carries over so the chain stitches prev → next.
      }
      const emit = this.step(step, parentId, `${prefix}${i}`);
      if (firstId === null) {
        firstId = emit.entry;
      }
      for (const exit of prevExits) {
        this.link(exit, emit.entry);
      }
      prevExits = emit.exits;
    });
    return { firstId, lastExits: prevExits };
  }

  private step(step: FlowStep, parentId: string | null, path: string): { entry: string; exits: Exit[] } {
    const id = `${this.rootId}::${path}`;
    if (step.kind === "call") {
      return this.callStep(step, parentId, path, id);
    }
    if (step.kind === "loop") {
      const bodies: FlowPath[] = [{ label: step.label, body: step.body }];
      return this.loopOrTry(parentId, path, id, "loop", step.label, bodies, step.body.length);
    }
    if (isTryLabel(step.label)) {
      const count = step.paths.reduce((sum, p) => sum + p.body.length, 0);
      return this.loopOrTry(parentId, path, id, "try", "try / catch", step.paths, count);
    }
    return this.branchStep(step, parentId, path, id);
  }

  private callStep(
    step: Extract<FlowStep, { kind: "call" }>,
    parentId: string | null,
    path: string,
    id: string,
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

  /** Loop and try/catch share the same container shape: default-expanded, children nested. */
  private loopOrTry(
    parentId: string | null,
    path: string,
    id: string,
    logicKind: "loop" | "try",
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
      const { width, height } = sizeFor(data.label, greyed, type, Boolean(data.signature), Boolean(data.owner));
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

// Extra vertical bands a non-greyed block grows by when it carries the new per-node detail: a
// signature line and/or the owning-unit chip. Kept as named consts so the render heights (in
// logicNodeTypes) and the laid-out box stay in lockstep.
const SIGNATURE_ROW_H = 16;
const OWNER_ROW_H = 20;

function sizeFor(
  label: string,
  greyed: boolean,
  type: LogicNodeType,
  hasSignature: boolean,
  hasOwner: boolean,
): { width: number; height: number } {
  if (type === "branch") {
    // A COMPACT, near-fixed decision node: an `if`/`switch` should be a small glanceable glyph, not a
    // wide box. The body hard-truncates the condition (full text in the hover title), so the width
    // barely tracks label length and stays tightly bounded — never a sprawling rectangle.
    return { width: roundedClamp(84, 132, 34 + label.length * 4.4), height: 44 };
  }
  if (greyed) {
    // A small chip: clearly smaller than an expandable block so size alone signals "leaf, no flow".
    return { width: roundedClamp(88, 150, 22 + label.length * 5.6), height: 30 };
  }
  // Base clears the title + provenance; each of the new detail rows adds its own band so the block
  // never clips the signature / owner chip the node component appends.
  const extra = (hasSignature ? SIGNATURE_ROW_H : 0) + (hasOwner ? OWNER_ROW_H : 0);
  return { width: roundedClamp(190, 360, 44 + label.length * 7.2), height: 66 + extra };
}

function roundedClamp(min: number, max: number, value: number): number {
  return Math.round(clamp(min, max, value));
}

function isTryLabel(label: string): boolean {
  return label === "try/catch";
}
