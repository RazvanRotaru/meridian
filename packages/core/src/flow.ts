/**
 * The intra-procedural "logic flow" model — a per-callable control-flow tree.
 *
 * A flow is an ordered list of `FlowStep`s: only method calls, async wait points, and control
 * structures survive; everything else collapses away. It rides in the artifact's `extensions`
 * record under the `logicFlow` key (no schema change, no version bump), keyed by the same `node.id`
 * grammar the rest of the graph joins on.
 */

import type { EdgeResolution, NodeId } from "./types";

/** An async operation launched by a call and referred to by a later await. `taskId` is opaque and
 * only needs to be unique inside its owning logic flow; `label` is the concise source expression
 * shown at the join (usually a binding such as `invoice` or a callee such as `loadInvoice`). */
export interface FlowAsyncInput {
  label: string;
  taskId?: string;
}

export type FlowBarrierMode = "all" | "allSettled";

/** Rich async semantics layered onto the existing call step. The legacy `awaited`/`detached`
 * booleans remain authoritative for old readers; new readers use this discriminator to draw the
 * launch and its eventual join instead of treating every async call as an ordinary call node. */
export type FlowCallAsync =
  /** The call starts async work without holding the current flow. `binding` is present for the
   * common `const pending = start()` form and absent for inline/detached launches. */
  | { kind: "launch"; taskId: string; binding?: string }
  /** `await start()` — launch and wait are one source expression, so a view can keep both marks on
   * the same lane/node rather than manufacturing a later join. */
  | { kind: "direct-await"; taskId: string }
  /** The existing `Promise.all*` call is also the barrier node. Inputs point back to launch IDs when
   * extraction can resolve them; value-only/unresolved operands still retain a readable label. */
  | { kind: "barrier"; mode: FlowBarrierMode; inputs: FlowAsyncInput[] };

/** Portable source anchor emitted with a static flow step. Files are extraction-root-relative
 * POSIX paths. Lines are 1-based; columns are 0-based, and the end position is exclusive. The
 * optional coordinates keep artifacts written before precise ranges were introduced readable. */
export interface FlowSourceAnchor {
  file: string;
  line: number;
  col?: number;
  endLine?: number;
  endCol?: number;
}

interface LocatedFlowStep {
  source?: FlowSourceAnchor;
}

export type FlowStep =
  /** `awaited` — the call sits under an `await` (execution holds for it). `detached` — the call's
   * result is deliberately dropped (`void expr` or an un-awaited Promise in statement position):
   * fire-and-forget work that outlives this flow. Both flags are absent (not false) when a call is
   * plain synchronous, so older artifacts and older readers agree byte-for-byte. */
  | ({
      kind: "call";
      label: string;
      target: NodeId | null;
      resolution: EdgeResolution;
      awaited?: boolean;
      detached?: boolean;
      async?: FlowCallAsync;
    } & LocatedFlowStep)
  /** A structural wait with no chartable call block of its own: usually `await pending`, where the
   * task started earlier, and also unnameable direct operands such as `await import(...)`. Nameable
   * calls retain their existing call step and use `call.async.kind === "direct-await"` instead. */
  | ({ kind: "await"; label: string; mode: "single"; inputs: FlowAsyncInput[] } & LocatedFlowStep)
  | ({ kind: "loop"; label: string; body: FlowStep[] } & LocatedFlowStep)
  /** `branchKind` is the STRUCTURED discriminator (if/switch/try); older artifacts predate it, so
   * readers go through `branchKindOf`, which falls back to the label. Never sniff labels directly —
   * a `case catchAll:` label is presentation, not semantics. */
  | ({ kind: "branch"; label: string; paths: FlowPath[]; branchKind?: BranchKind } & LocatedFlowStep)
  /** An inline callback handed to a call (`useEffect(() => …)`, `setTimeout(() => …)`) or bound
   * to a JSX attribute (`onClick={() => …}`). Its body nests here rather than charting as flat
   * siblings, because HANDING OVER a callback asserts nothing about when — or whether — it runs. */
  | ({ kind: "callback"; label: string; body: FlowStep[] } & LocatedFlowStep)
  /** A `return` or `throw`: this path of the flow ENDS here. Downstream views need this to stop
   * pretending a guard's then-branch rejoins the flow — everything after an exiting `if` is really
   * the else branch. `label` is the truncated returned/thrown expression, null for a bare return. */
  | ({ kind: "exit"; variant: ExitVariant; label: string | null } & LocatedFlowStep);

export type ExitVariant = "return" | "throw";

export type BranchKind = "if" | "switch" | "try";

/** What a branch path IS, independent of how its label reads. `case` and `then` are conditional
 * arms; `else`/`default`/`catch` are the unconditional ones that can seal a branch. */
export type FlowPathRole = "then" | "else" | "case" | "default" | "try" | "catch" | "finally";

export interface FlowPath {
  label: string;
  body: FlowStep[];
  /** Absent in older artifacts — read through `pathRole`, which falls back to the label. */
  role?: FlowPathRole;
  /** Runtime `branch.taken.pathId` join. Extractors use a semantic id (`then`, `else`, `catch`,
   * case text, …); generated probes must emit the same id for this source path. */
  pathId?: string;
  /** Optional path-specific anchor, primarily for catch clauses whose telemetry fires at `catch`
   * rather than at the enclosing `try` statement. */
  source?: FlowSourceAnchor;
}

/** Callable node id -> its ordered logic flow. Lives under `artifact.extensions.logicFlow`. */
export type LogicFlows = Record<NodeId, FlowStep[]>;

export const LOGIC_FLOW_EXTENSION = "logicFlow";

/**
 * Does this step list END the path it sits on (no fall-through to whatever follows)?
 *
 * True when the last step is an `exit`, or a branch that exits on EVERY path while covering every
 * case. Coverage is judged conservatively: an `if` without an `else` (a single path) falls through
 * by construction, and a `switch` without a `default` may match nothing — only a branch whose
 * paths include an unconditional one (`else`, `default`, `try`+`catch`) can seal the flow. Loops
 * and callbacks never terminate (a loop may run zero times; a callback runs elsewhere, if at all).
 */
export function pathTerminates(steps: FlowStep[]): boolean {
  const last = steps[steps.length - 1];
  if (!last) {
    return false;
  }
  if (last.kind === "exit") {
    return true;
  }
  if (last.kind === "branch") {
    return branchCoversAllCases(last.paths) && last.paths.every((path) => pathTerminates(path.body));
  }
  return false;
}

/** The branch's structured kind, with a label fallback for artifacts that predate `branchKind`. */
export function branchKindOf(step: Pick<Extract<FlowStep, { kind: "branch" }>, "label" | "branchKind">): BranchKind {
  if (step.branchKind) {
    return step.branchKind;
  }
  if (step.label === "try/catch") {
    return "try";
  }
  return step.label.startsWith("switch") ? "switch" : "if";
}

/** A path's structured role, with a label fallback for older artifacts. The catch fallback demands
 * the exact keyword shape (`catch` / `catch e`) — a switch case labeled `catchAll` is a CASE. */
export function pathRole(path: FlowPath): FlowPathRole {
  if (path.role) {
    return path.role;
  }
  if (path.label === "then" || path.label === "else" || path.label === "default" || path.label === "try" || path.label === "finally") {
    return path.label;
  }
  return path.label === "catch" || path.label.startsWith("catch ") ? "catch" : "case";
}

/** `then`+`else`, `try`+`catch`, and a switch with a `default` each include an unconditional arm;
 * a lone `then` or an all-`case` switch leaves a way through no matter what its bodies do. */
export function branchCoversAllCases(paths: FlowPath[]): boolean {
  return paths.length > 1 && paths.some((path) => {
    const role = pathRole(path);
    return role === "else" || role === "default" || role === "catch";
  });
}

/**
 * The label for a branch's IMPLICIT fall-through (the else the source never wrote), or null when
 * the source covers it. Try branches never get one — their fall-through is the try body itself.
 */
export function syntheticFallThroughLabel(step: Extract<FlowStep, { kind: "branch" }>): string | null {
  const kind = branchKindOf(step);
  if (kind === "try") {
    return null;
  }
  if (kind === "switch") {
    return step.paths.some((path) => pathRole(path) === "default") ? null : "no match";
  }
  return step.paths.some((path) => pathRole(path) === "else") ? null : "else";
}

/** A try branch's arms picked BY ROLE, never by position — extractors owe no path ordering. */
export function tryArms(step: Extract<FlowStep, { kind: "branch" }>): { tryPath?: FlowPath; catchPath?: FlowPath; finallyPath?: FlowPath } {
  const byRole = (role: FlowPathRole) => step.paths.find((path) => pathRole(path) === role);
  return { tryPath: byRole("try"), catchPath: byRole("catch"), finallyPath: byRole("finally") };
}

/** One rendering of an exit step everywhere: `return res` / `throw` — the views must not drift. */
export function exitLabel(step: Extract<FlowStep, { kind: "exit" }>): string {
  return step.label ? `${step.variant} ${step.label}` : step.variant;
}
