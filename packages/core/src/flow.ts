/**
 * The intra-procedural "logic flow" model — a per-callable control-flow tree.
 *
 * A flow is an ordered list of `FlowStep`s: only method calls and control structures survive;
 * everything else collapses away. It rides in the artifact's `extensions` record under the
 * `logicFlow` key (no schema change, no version bump), keyed by the same `node.id` grammar the
 * rest of the graph joins on.
 */

import type { EdgeResolution, NodeId } from "./types";

export type FlowStep =
  /** `awaited` — the call sits under an `await` (execution holds for it). `detached` — the call's
   * result is deliberately dropped (`void expr` or an un-awaited Promise in statement position):
   * fire-and-forget work that outlives this flow. Both flags are absent (not false) when a call is
   * plain synchronous, so older artifacts and older readers agree byte-for-byte. */
  | { kind: "call"; label: string; target: NodeId | null; resolution: EdgeResolution; awaited?: boolean; detached?: boolean }
  | { kind: "loop"; label: string; body: FlowStep[] }
  /** `branchKind` is the STRUCTURED discriminator (if/switch/try); older artifacts predate it, so
   * readers go through `branchKindOf`, which falls back to the label. Never sniff labels directly —
   * a `case catchAll:` label is presentation, not semantics.
   *
   * `fullLabel` is the UNTRUNCATED condition, kept for the hover/tooltip when `label` was clipped to
   * a glanceable form — so the diamond can read compact yet reveal the whole `if`/`switch` on hover.
   * Absent (not equal to `label`) when the condition already fit, so short branches stay byte-for-byte
   * identical to older artifacts; readers fall back to `label`. */
  | { kind: "branch"; label: string; paths: FlowPath[]; branchKind?: BranchKind; fullLabel?: string }
  /** An inline callback handed to a call (`useEffect(() => …)`, `setTimeout(() => …)`) or bound
   * to a JSX attribute (`onClick={() => …}`). Its body nests here rather than charting as flat
   * siblings, because HANDING OVER a callback asserts nothing about when — or whether — it runs. */
  | { kind: "callback"; label: string; body: FlowStep[] }
  /** A `return` or `throw`: this path of the flow ENDS here. Downstream views need this to stop
   * pretending a guard's then-branch rejoins the flow — everything after an exiting `if` is really
   * the else branch. `label` is the truncated returned/thrown expression, null for a bare return. */
  | { kind: "exit"; variant: ExitVariant; label: string | null };

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
