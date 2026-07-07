/**
 * The SHARED base of every Logic-flow presentation. All four sub-views (exec-pins graph, metro,
 * blocks, timeline) render the SAME `FlowStep[]` tree with the same navigation state (root, drill
 * trail, selection) — only the projection differs. What they read in common lives here: the view
 * mode vocabulary, the flow palette (one meaning = one colour across every sub-view), and the pure
 * step-level helpers (expandability, provenance, termination) so no view re-derives them
 * differently. No React, no store.
 */

import type { FlowStep, LogicFlows, NodeId } from "@meridian/core";
import { branchKindOf, parseNodeId } from "@meridian/core";
import type { GraphIndex } from "../graph/graphIndex";

/** Which projection of the logic flow is on screen. "graph" is the exec-pins canvas (the default). */
export type LogicViewMode = "graph" | "metro" | "blocks" | "timeline";

export const LOGIC_VIEW_MODES: ReadonlyArray<{ mode: LogicViewMode; label: string }> = [
  { mode: "graph", label: "Exec graph" },
  { mode: "metro", label: "Metro" },
  { mode: "blocks", label: "Blocks" },
  { mode: "timeline", label: "Timeline" },
];

export function isLogicViewMode(value: string): value is LogicViewMode {
  return LOGIC_VIEW_MODES.some((entry) => entry.mode === value);
}

/**
 * One semantic = one colour, across every sub-view (mirrors the exec-graph accents in
 * logicNodeTypes): blue call / indigo method / amber loop / orange try / slate-cyan callback /
 * sky branch / green entry / slate fall-through exit / red return-throw / cyan awaited / violet
 * detached.
 */
export const FLOW_COLORS = {
  call: "#3B7AC0",
  method: "#5E74C6",
  loop: "#E6B84D",
  try: "#D98A5B",
  callback: "#5FA8A0",
  branch: "#5BB4E8",
  entry: "#4FB477",
  exit: "#8A93A0",
  exitCap: "#E06C6C",
  awaited: "#5FC1CE",
  detached: "#A47BD6",
  /** The by-target selection highlight — shared with the exec graph's node ring and edge glow. */
  select: "#6BE38A",
  ink: "#C8D3E0",
  dim: "#6B7686",
  faint: "#3A414C",
  card: "#141A23",
  canvas: "#0B0E13",
} as const;

/** The props every alternate flow view receives — the shared base, projected differently. */
export interface FlowViewProps {
  rootId: NodeId;
  steps: FlowStep[];
  flows: LogicFlows;
  index: GraphIndex;
  /** Selection is BY TARGET (same contract as the exec graph): every call site of it lights up. */
  selected: NodeId | null;
  onSelect: (target: NodeId | null) => void;
  /** Drill into a resolved callee's own flow (pushes the breadcrumb) — double-click a call. */
  onDrill: (target: NodeId) => void;
}

export type CallStep = Extract<FlowStep, { kind: "call" }>;
export type ExitStep = Extract<FlowStep, { kind: "exit" }>;
export type BranchStep = Extract<FlowStep, { kind: "branch" }>;

/** What a call step is, for display: same expandability/provenance rules as the exec graph. */
export interface CallDisplay {
  /** Resolved to a callable that ships its own flow — double-click drills into it. */
  expandable: boolean;
  /** `receiver.method` labels read as method calls (the exec graph's heuristic, shared). */
  method: boolean;
  /** A one-line origin (`module` of the resolved target), or null for externals/unresolved. */
  provenance: string | null;
}

export function callDisplay(step: CallStep, flows: LogicFlows, index: GraphIndex): CallDisplay {
  const expandable = step.resolution === "resolved" && step.target !== null && (flows[step.target]?.length ?? 0) > 0;
  const target = step.target ? index.nodesById.get(step.target) : undefined;
  const method = target?.kind === "method" || step.label.includes(".");
  return { expandable, method, provenance: step.target ? baseName(parseNodeId(step.target).modulePath) : null };
}

/** A try/catch rides the branch step kind — discriminated structurally, never by its label. */
export function isTryStep(step: FlowStep): step is BranchStep {
  return step.kind === "branch" && branchKindOf(step) === "try";
}

/** All the fire-and-forget work a flow hands off, in order — detached calls and handed-over
 * callbacks anywhere in the tree. The blocks/timeline views park these in a background section. */
export interface HandoffEntry {
  step: CallStep | Extract<FlowStep, { kind: "callback" }>;
  /** The label of the call the work was handed to/dropped by — context for the tray row. */
  context: string;
}

export function collectHandoffs(steps: FlowStep[]): HandoffEntry[] {
  const out: HandoffEntry[] = [];
  const walk = (list: FlowStep[], context: string): void => {
    for (const step of list) {
      if (step.kind === "call" && step.detached) {
        out.push({ step, context });
      } else if (step.kind === "callback") {
        out.push({ step, context });
        walk(step.body, step.label);
      } else if (step.kind === "loop") {
        walk(step.body, context);
      } else if (step.kind === "branch") {
        step.paths.forEach((path) => walk(path.body, context));
      }
    }
  };
  walk(steps, "flow");
  return out;
}

/** Last path segment — the module a target lives in, shared by every projection's provenance. */
export function baseName(path: string): string {
  const segments = path.split("/");
  return segments[segments.length - 1] || path;
}
