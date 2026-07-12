/**
 * The Timeline projection's ORDERING model — pure, no React, no coordinates. It walks the MAIN
 * execution path of a `FlowStep` tree advancing a pseudo-clock `t` and hands the view a flat,
 * serializable spec of items keyed by [t0,t1] on named lanes. The one idea it encodes: fire-and-
 * forget work (detached calls, callbacks) opens a background bar that runs to `ticks` — PAST the
 * return line — so a reader sees it outlives the caller. Geometry (px, y) is the view's job.
 */

import type { FlowStep, LogicFlows, NodeId } from "@meridian/core";
import { branchCoversAllCases, exitLabel, pathTerminates, tryArms } from "@meridian/core";
import type { GraphIndex } from "../graph/graphIndex";
import type { BranchStep, CallStep, ExitStep } from "./flowViewModel";
import { FLOW_COLORS, callDisplay, isTryStep } from "./flowViewModel";

export interface TimelineItem {
  t0: number; t1: number; kind: "chip" | "bar" | "suspend"; color: string; glyph: string; text: string;
  target?: NodeId | null; expandable?: boolean; ghost?: boolean;
}
/** The road not taken (or taken — statically unknown): a terminated branch path, kept but ghosted. */
export interface AltItem { t0: number; t1: number; color: string; text: string; }
/** A dashed wire the view draws: `await` drops/rises main↔task at a tick; `detach` main→a bg lane. */
export interface Connector { kind: "await" | "detach"; t: number; row?: number; }
export interface GhostRegion { t0: number; t1: number; label: string; }
export interface TimelineSpec {
  ticks: number; mainRow: TimelineItem[]; taskRow: TimelineItem[]; catchRow: TimelineItem[];
  bgRows: TimelineItem[][]; altRows: AltItem[]; connectors: Connector[]; ghostRegions: GhostRegion[];
  elseTicks: number[]; returnsAt: number | null;
}

const OPEN = -1; // bg-bar t1 sentinel: "runs to the right edge", patched to `ticks` in finish().
const ADVANCE = 1, AWAIT_SPAN = 1.5, LOOP_SPAN = 1.6, GAP = 0.2, MARGIN = 1.2;

export function buildTimeline(steps: FlowStep[], flows: LogicFlows, index: GraphIndex): TimelineSpec {
  const b = new Builder(flows, index);
  b.walkMain(steps, false);
  return b.finish();
}

/** Holds the clock and the growing lanes; each method is one step-kind's contribution to order. */
class Builder {
  private t = 0;
  private done = false; // an exit was reached on the main path — later steps are dead code.
  private returnsAt: number | null = null;
  private mainRow: TimelineItem[] = [];
  private taskRow: TimelineItem[] = [];
  private catchRow: TimelineItem[] = [];
  private bgRows: TimelineItem[][] = [];
  private altRows: AltItem[] = [];
  private connectors: Connector[] = [];
  private ghostRegions: GhostRegion[] = [];
  private elseTicks: number[] = [];
  private altEnd = 0; // alt bars don't advance the clock, so their reach is tracked separately.

  constructor(private readonly flows: LogicFlows, private readonly index: GraphIndex) {}

  walkMain(list: FlowStep[], ghost: boolean): void {
    for (const step of list) {
      if (this.done) return; // dead steps after a return/throw
      if (step.kind === "exit") this.exit(step);
      else if (step.kind === "call") this.call(step, ghost);
      else if (step.kind === "await") this.awaitValue(step);
      else if (step.kind === "loop") this.loop(step);
      else if (step.kind === "callback") this.callback(step);
      else if (isTryStep(step)) this.tryStep(step, ghost);
      else this.branch(step);
    }
  }

  private exit(step: ExitStep): void {
    this.mainRow.push({ t0: this.t, t1: this.t, kind: "chip", color: FLOW_COLORS.exitCap, glyph: "⏎", text: exitLabel(step) });
    this.returnsAt = this.t;
    this.done = true;
  }

  private call(step: CallStep, ghost: boolean): void {
    if (step.awaited) return this.awaitCall(step);
    if (step.detached) return this.detachCall(step);
    const d = callDisplay(step, this.flows, this.index);
    const color = d.method ? FLOW_COLORS.method : FLOW_COLORS.call;
    this.mainRow.push({ t0: this.t, t1: this.t, kind: "chip", color, glyph: d.method ? "∷" : "ƒ", text: step.label, target: step.target, expandable: d.navigable, ghost });
    this.t += ADVANCE;
  }

  private awaitCall(step: CallStep): void {
    const t0 = this.t;
    const t1 = t0 + AWAIT_SPAN; // execution HOLDS here — main shows a hatched suspended span…
    this.mainRow.push({ t0, t1, kind: "suspend", color: FLOW_COLORS.awaited, glyph: "⏸", text: "suspended" });
    const d = callDisplay(step, this.flows, this.index);
    this.taskRow.push({ t0, t1, kind: "bar", color: FLOW_COLORS.awaited, glyph: "⏱", text: `await ${step.label}`, target: step.target, expandable: d.navigable });
    this.connectors.push({ kind: "await", t: t0 }, { kind: "await", t: t1 }); // drop, then rise
    this.t = t1 + GAP;
  }

  /** A promise launched earlier and consumed here. Its lifetime begins on the earlier call in the
   * exec graph; this compact projection still makes the suspension gate explicit on the time axis. */
  private awaitValue(step: Extract<FlowStep, { kind: "await" }>): void {
    const t0 = this.t;
    const t1 = t0 + AWAIT_SPAN;
    this.mainRow.push({ t0, t1, kind: "suspend", color: FLOW_COLORS.awaited, glyph: "⏸", text: "suspended" });
    this.taskRow.push({ t0, t1, kind: "bar", color: FLOW_COLORS.awaited, glyph: "⌟", text: step.label });
    this.connectors.push({ kind: "await", t: t0 }, { kind: "await", t: t1 });
    this.t = t1 + GAP;
  }

  private detachCall(step: CallStep): void {
    const row = this.bgRows.length;
    const d = callDisplay(step, this.flows, this.index);
    this.mainRow.push({ t0: this.t, t1: this.t, kind: "chip", color: FLOW_COLORS.detached, glyph: "⤳", text: step.label, target: step.target, expandable: d.navigable });
    this.bgRows.push([{ t0: this.t, t1: OPEN, kind: "bar", color: FLOW_COLORS.detached, glyph: "⤳", text: `${step.label} · result dropped →`, target: step.target, expandable: d.navigable }]);
    this.connectors.push({ kind: "detach", t: this.t, row });
    this.t += ADVANCE;
  }

  private callback(step: Extract<FlowStep, { kind: "callback" }>): void {
    const row = this.bgRows.length;
    const calls = distinctCalls(step.body);
    const tail = calls.length ? `… → ${calls.join(" → ")}` : "runs later";
    this.bgRows.push([{ t0: this.t, t1: OPEN, kind: "bar", color: FLOW_COLORS.callback, glyph: "⤳", text: `${step.label} · ${tail}` }]);
    this.connectors.push({ kind: "detach", t: this.t, row });
    this.t += ADVANCE;
  }

  private loop(step: Extract<FlowStep, { kind: "loop" }>): void {
    const calls = distinctCalls(step.body);
    const summary = calls.length ? ` · ${calls.join(" ")}` : "";
    this.mainRow.push({ t0: this.t, t1: this.t + LOOP_SPAN, kind: "bar", color: FLOW_COLORS.loop, glyph: "↻", text: `${step.label}${summary}` });
    this.t += LOOP_SPAN + GAP;
  }

  private branch(step: BranchStep): void {
    for (const path of step.paths) {
      if (pathTerminates(path.body)) {
        const calls = distinctCalls(path.body);
        const summary = calls.length ? ` ${calls.join(" → ")} →` : "";
        const t1 = this.t + estimateSpan(path.body);
        this.altEnd = Math.max(this.altEnd, t1);
        this.altRows.push({ t0: this.t, t1, color: FLOW_COLORS.branch, text: `? ${path.label} →${summary} ${exitSummary(path.body)}` });
      } else {
        const start = this.t;
        this.walkMain(path.body, true); // conditional work inlines on main, ghost-tinted
        if (this.t > start) this.ghostRegions.push({ t0: start, t1: this.t, label: `? ${path.label} (maybe)` });
      }
    }
    if (pathTerminates([step])) {
      this.returnsAt = this.t;
      this.done = true;
    } else if (!branchCoversAllCases(step.paths) && step.paths.some((p) => pathTerminates(p.body))) {
      this.elseTicks.push(this.t); // guard returned; the continuation IS the synthesized else
    }
  }

  private tryStep(step: BranchStep, ghost: boolean): void {
    const { tryPath, catchPath } = tryArms(step);
    const start = this.t;
    const returnsBefore = this.returnsAt;
    const arm = tryPath ?? step.paths[0];
    if (arm) this.walkMain(arm.body, ghost);
    const end = Math.max(this.t, start + ADVANCE);
    if (catchPath) {
      const calls = distinctCalls(catchPath.body);
      this.catchRow.push({ t0: start, t1: end, kind: "bar", color: FLOW_COLORS.try, glyph: "⚠", text: `on throw: ${calls.length ? calls.join(" → ") : "handle"}`, ghost: true });
    }
    // A return INSIDE the try isn't the flow's end when the catch recovers — control falls through
    // to whatever follows, so restore the exit bookkeeping. The exit chip itself stays on the lane.
    if (this.done && !pathTerminates([step])) {
      this.t += ADVANCE; // step past the in-try exit chip so the continuation doesn't overprint it
      this.done = false;
      this.returnsAt = returnsBefore;
    }
  }

  finish(): TimelineSpec {
    const ticks = Math.max(this.t, this.returnsAt ?? 0, this.altEnd) + MARGIN;
    // fire-and-forget bars run to the right edge — visibly crossing the return line.
    for (const row of this.bgRows) for (const item of row) if (item.t1 === OPEN) item.t1 = ticks;
    return {
      ticks, mainRow: this.mainRow, taskRow: this.taskRow, catchRow: this.catchRow, bgRows: this.bgRows,
      altRows: this.altRows, connectors: this.connectors, ghostRegions: this.ghostRegions,
      elseTicks: this.elseTicks, returnsAt: this.returnsAt,
    };
  }
}

/** Up to three distinct short call labels under `steps` — the summary a bar shows without unrolling. */
function distinctCalls(steps: FlowStep[]): string[] {
  const seen = new Set<string>(); // Set keeps insertion order — first occurrence wins
  const walk = (list: FlowStep[], depth: number): void => {
    if (depth > 4) return; // guard pathological nesting
    for (const s of list) {
      if (s.kind === "call") seen.add(shortLabel(s.label));
      else if (s.kind === "loop" || s.kind === "callback") walk(s.body, depth + 1);
      else if (s.kind === "branch") s.paths.forEach((p) => walk(p.body, depth + 1));
    }
  };
  walk(steps, 0);
  return [...seen].slice(0, 3);
}

function shortLabel(label: string): string {
  return label.split(".").pop() || label;
}

/** A rough tick-width for a ghosted alt bar — enough to read its summary, never unrolled. */
function estimateSpan(steps: FlowStep[]): number {
  return Math.max(1, steps.reduce((n, s) => n + (s.kind === "loop" ? LOOP_SPAN : ADVANCE), 0));
}

/** How a terminated path ends — a guard that THROWS must not read as returning normally. */
function exitSummary(body: FlowStep[]): string {
  const last = body[body.length - 1];
  if (last?.kind === "exit") return `${last.variant === "throw" ? "⚡" : "⏎"} ${exitLabel(last)}`;
  return "⏎ exits"; // sealed by a nested branch — every arm returns or throws
}
