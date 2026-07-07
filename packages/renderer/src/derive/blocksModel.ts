/**
 * The one non-trivial derivation the Blocks (structogram) view needs: a branch's COMPARTMENTS.
 *
 * A structogram nests scope, so an `if`/`switch` becomes side-by-side compartments — one per real
 * path. The honest twist: the extractor omits the arm a developer never wrote, but the reader still
 * needs to see where control goes when nothing matched. So a guard with no `else` (and a `switch`
 * with no `default`) gets ONE synthesized compartment that spells out the fall-through — and,
 * crucially, distinguishes a guard whose then-arm exits (the rest of the function IS the else) from
 * one that merely skips ahead. Pure, no React, so it can be unit-tested on its own.
 */

import type { FlowStep } from "@meridian/core";
import { branchCoversAllCases, branchKindOf, pathTerminates } from "@meridian/core";
import type { BranchStep } from "./flowViewModel";

export interface Compartment {
  /** The caption shown above the compartment body (uppercased by the view). */
  caption: string;
  /** A synthesized compartment stands in for an arm the code never wrote — it has no body, only a note. */
  synthesized: boolean;
  body: FlowStep[];
  /** The fall-through explanation, present only on the synthesized compartment. */
  note: string | null;
}

/** Every compartment a branch renders, real arms first, then the synthesized fall-through (if any). */
export function branchCompartments(step: BranchStep): Compartment[] {
  const real = step.paths.map((path) => ({ caption: path.label, synthesized: false, body: path.body, note: null }));
  const synth = synthesizedCompartment(step);
  return synth ? [...real, synth] : real;
}

/** The made-up "otherwise"/"no match" arm — null when the branch already covers every case. */
function synthesizedCompartment(step: BranchStep): Compartment | null {
  if (branchCoversAllCases(step.paths)) {
    return null;
  }
  const isSwitch = branchKindOf(step) === "switch";
  const caption = isSwitch ? "no match — synthesized" : "otherwise — synthesized";
  // A switch that matches nothing always falls through; an `if` falls through UNLESS its then-arm
  // exits, in which case everything after the guard is really the else branch.
  const note = !isSwitch && pathTerminates(firstBody(step)) ? "↓ the rest of the function is the else branch" : "↓ skips straight ahead";
  return { caption, synthesized: true, body: [], note };
}

function firstBody(step: BranchStep): FlowStep[] {
  return step.paths[0]?.body ?? [];
}
