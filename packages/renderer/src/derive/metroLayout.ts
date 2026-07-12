/**
 * Project a flow's exec thread onto a transit map (pure, unit-tested — the layout math is the hard
 * part). One left→right time cursor threads every lane, so stations never collide horizontally;
 * control structures become vertical lanes that split off and rejoin (or dead-end at a terminus):
 * a return is a TERMINUS, an await is an INTERCHANGE, a fire-and-forget hand-off is a dashed line
 * that leaves the system and keeps going. Generic over ANY FlowStep tree — no hand-laid coordinates.
 */

import type { FlowPath, FlowStep, LogicFlows } from "@meridian/core";
import { branchCoversAllCases, exitLabel, pathRole, pathTerminates, syntheticFallThroughLabel, tryArms } from "@meridian/core";
import type { GraphIndex } from "../graph/graphIndex";
import type { BranchStep, CallStep } from "./flowViewModel";
import { FLOW_COLORS, callDisplay, isTryStep } from "./flowViewModel";
import { createCanvas } from "./metroCanvas";
import type { MetroSpec } from "./metroSpec";
import {
  BASE_Y, BRANCH_RISE, CATCH_RISE, ENTRY_X, INTERCHANGE_PAD, LOOP_RY, MAX_DEPTH, MAX_ELEV_DEPTH,
  NEST_RISE, SLOT, encloseLoop, hline, rejoinTo, splitTo,
} from "./metroSpec";

type Lane = { y: number; color: string; depth: number; startX: number; dash?: boolean; over?: boolean };
type WalkResult = { terminated: boolean; endX: number };
type BranchResult = { terminated: boolean; mergeX: number };

export function layoutMetro(steps: FlowStep[], flows: LogicFlows, index: GraphIndex, rootName = "flow"): MetroSpec {
  const c = createCanvas();

  /** Walk one step list on one lane, drawing that lane's horizontal base segment at the end. */
  function walk(list: FlowStep[], lane: Lane): WalkResult {
    if (lane.depth > MAX_DEPTH) {
      return { terminated: false, endX: c.cursor };
    }
    let endX = lane.startX;
    let terminated = false;
    let alt = 0;
    for (const step of list) {
      const x = c.cursor;
      if (step.kind === "exit") {
        c.terminus(x, lane.y, FLOW_COLORS.exitCap, `⏎ ${exitLabel(step)}`);
        endX = x;
        terminated = true;
        break; // steps after an exit on this path are dead code
      } else if (step.kind === "call") {
        call(step, lane, x, alt++);
        endX = x;
        c.cursor = x + (step.awaited ? SLOT + INTERCHANGE_PAD : SLOT);
      } else if (step.kind === "await") {
        c.mark({ x, y: lane.y, kind: "interchange", color: FLOW_COLORS.awaited, labelSide: -1, name: step.label, sub: "wait for earlier task" });
        endX = x;
        c.cursor = x + SLOT + INTERCHANGE_PAD;
      } else if (step.kind === "loop") {
        endX = Math.max(endX, loop(step, lane, x));
      } else if (step.kind === "callback") {
        callback(step, lane, x);
        endX = x;
        c.cursor = x + SLOT;
      } else if (step.kind === "branch") {
        const r = isTryStep(step) ? tryCatch(step, lane, x) : branch(step, lane, x);
        endX = Math.max(endX, r.mergeX);
        if (r.terminated) { terminated = true; break; }
      }
    }
    c.line(hline(lane.startX, Math.max(endX, lane.startX + 1), lane.y), lane.color, { dash: lane.dash, over: lane.over });
    return { terminated, endX };
  }

  function call(step: CallStep, lane: Lane, x: number, alt: number): void {
    const disp = callDisplay(step, flows, index);
    const side: 1 | -1 = alt % 2 === 0 ? -1 : 1;
    const shared = { x, target: step.target, expandable: disp.navigable };
    if (step.awaited) {
      c.mark({ ...shared, y: lane.y, kind: "interchange", color: FLOW_COLORS.awaited, labelSide: -1, name: step.label, sub: disp.provenance ?? "awaited · the line holds here" });
    } else if (step.detached) {
      c.mark({ ...shared, y: lane.y, kind: "station", color: FLOW_COLORS.detached, labelSide: side, name: step.label, sub: disp.provenance ?? "void · result dropped" });
      c.detach(x, lane.y);
    } else {
      const color = disp.method ? FLOW_COLORS.method : FLOW_COLORS.call;
      c.mark({ ...shared, y: lane.y, kind: "station", color, labelSide: side, name: step.label, sub: disp.provenance ?? undefined });
    }
  }

  /** A loop is NOT a branch — its body always sits on the execution path; it just repeats. So the
   * body stays INLINE on the current lane, recolored and painted over the trunk, and one stadium
   * ring encloses the whole sequence. The trunk running on past it is the zero-iteration path. */
  function loop(step: Extract<FlowStep, { kind: "loop" }>, lane: Lane, x: number): number {
    const bodyStart = x + SLOT * 0.35;
    c.cursor = bodyStart;
    const r = walk(step.body, { y: lane.y, color: FLOW_COLORS.loop, depth: lane.depth + 1, startX: x, over: true });
    const right = Math.max(r.endX, bodyStart) + SLOT * 0.35;
    c.line(hline(x, right, lane.y), FLOW_COLORS.loop, { over: true }); // recolor the FULL enclosed span
    c.line(encloseLoop(x, right, lane.y, LOOP_RY), FLOW_COLORS.loop, { width: 3, over: true });
    c.label(x + 4, lane.y - LOOP_RY - 12, `↻ ${step.label}`, FLOW_COLORS.loop);
    c.cursor = right + SLOT * 0.5;
    return right;
  }

  function callback(step: Extract<FlowStep, { kind: "callback" }>, lane: Lane, x: number): void {
    const laneY = c.clampY(lane.y + CATCH_RISE);
    const landX = x + SLOT * 0.6;
    c.line(splitTo(x, lane.y, landX, laneY), FLOW_COLORS.callback, { dash: true, width: 4 });
    c.label(x + 14, lane.y + 34, `⤳ ${step.label}`, FLOW_COLORS.callback);
    c.cursor = landX;
    walk(step.body, { y: laneY, color: FLOW_COLORS.callback, depth: lane.depth + 1, startX: landX, dash: true });
  }

  function branch(step: BranchStep, lane: Lane, x: number): BranchResult {
    c.junction(x, lane.y);
    c.label(x - 40, lane.y + 18, `? ${step.label}`, FLOW_COLORS.branch);
    c.cursor = x + SLOT * 0.7;
    const paths = step.paths.filter((p) => p.body.length > 0);
    for (let i = 0; i < paths.length; i++) {
      const side = laneSide(paths[i], i);
      const laneY = c.clampY(lane.y + side * laneOffset(lane.depth));
      const landX = c.cursor;
      c.line(splitTo(x, lane.y, landX, laneY), FLOW_COLORS.branch);
      c.label(landX + 8, (laneY + lane.y) / 2 - 8, paths[i].label, FLOW_COLORS.branch);
      const r = walk(paths[i].body, { y: laneY, color: FLOW_COLORS.branch, depth: lane.depth + 1, startX: landX });
      if (!r.terminated) {
        const mergeX = c.cursor + SLOT * 0.5;
        c.line(rejoinTo(r.endX, laneY, mergeX, lane.y), FLOW_COLORS.branch);
        c.cursor = mergeX + SLOT * 0.3;
      }
    }
    const synthetic = syntheticFallThroughLabel(step);
    if (synthetic) {
      c.label(x + SLOT * 0.85, lane.y - 2, `${synthetic} · synthesized`, FLOW_COLORS.branch);
    }
    const sealed = branchCoversAllCases(step.paths) && step.paths.every((p) => pathTerminates(p.body));
    c.cursor += SLOT * 0.3; // a merge gap so the trunk reads on past the fork
    return { terminated: sealed, mergeX: c.cursor };
  }

  function tryCatch(step: BranchStep, lane: Lane, x: number): BranchResult {
    const { tryPath, catchPath, finallyPath } = tryArms(step);
    c.cursor = x;
    const tryTerm = walkBody(tryPath, lane, x);
    let catchTerm = false;
    if (catchPath) {
      const laneY = c.clampY(lane.y + CATCH_RISE);
      const landX = c.cursor + SLOT * 0.4;
      c.line(splitTo(x, lane.y, landX, laneY), FLOW_COLORS.try, { dash: true, width: 4 });
      c.label(x + 16, lane.y + 40, "⚠ on throw", FLOW_COLORS.try);
      c.cursor = landX;
      catchTerm = walkBody(catchPath, { ...lane, dash: true }, landX, laneY, FLOW_COLORS.try);
      const mergeX = c.cursor + SLOT * 0.5;
      c.line(rejoinTo(c.cursor, laneY, mergeX, lane.y), FLOW_COLORS.try, { dash: true, width: 4 });
      c.cursor = mergeX + SLOT * 0.3;
    }
    if (finallyPath?.body.length) {
      // finally always runs, so it charts exactly ONCE — inline on the current lane, never on a throw lane.
      walk(finallyPath.body, { ...lane, depth: lane.depth + 1, startX: c.cursor });
    }
    return { terminated: tryTerm && catchTerm, mergeX: c.cursor };
  }

  /** Walk a path body on a lane, returning whether it terminated (null/empty path = no-op, open). */
  function walkBody(path: FlowPath | undefined, lane: Lane, startX: number, y = lane.y, color = lane.color): boolean {
    if (!path || path.body.length === 0) {
      return false;
    }
    return walk(path.body, { y, color, depth: lane.depth + 1, startX, dash: lane.dash }).terminated;
  }

  c.terminus(ENTRY_X, BASE_Y, FLOW_COLORS.entry, `▶ ${rootName}`);
  c.cursor = ENTRY_X + SLOT;
  const res = walk(steps, { y: BASE_Y, color: FLOW_COLORS.ink, depth: 0, startX: ENTRY_X });
  if (!res.terminated) {
    // Cap at the ADVANCED cursor — endX is the last station's own x, and a bar there overprints it.
    const exitX = Math.max(c.cursor, res.endX + SLOT * 0.5);
    c.line(hline(res.endX, exitX, BASE_Y), FLOW_COLORS.ink);
    c.terminus(exitX, BASE_Y, FLOW_COLORS.exit, "EXIT");
  }
  return c.finish();
}

/** Unconditional arms (else/default) ride BELOW the trunk; conditional arms alternate from above. */
function laneSide(path: FlowPath, i: number): 1 | -1 {
  const role = pathRole(path);
  if (role === "else" || role === "default") {
    return 1;
  }
  return i % 2 === 0 ? -1 : 1;
}

function laneOffset(depth: number): number {
  if (depth >= MAX_ELEV_DEPTH) {
    return 0; // cap reached: nested branches share the parent lane
  }
  return depth === 0 ? BRANCH_RISE : NEST_RISE;
}
