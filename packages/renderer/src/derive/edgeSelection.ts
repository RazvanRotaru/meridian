/**
 * View-mode edge selection: filter the artifact's edges by kind BEFORE they are lifted onto
 * the visible boxes. The two modes are the "separate viewers" — call-flow hides the React
 * composition wires, and UI-composition shows ONLY them — so a big graph reads as one story
 * at a time.
 */

import type { GraphEdge } from "@meridian/core";

export type ViewMode = "call" | "ui" | "logic" | "modules" | "prs";

/** The behavioural call graph: everything the extractor emits EXCEPT the React "renders" tree.
 * IPC hops (`sends`/`handles`, routed through channel pseudo-nodes) belong here — an exit port
 * IS behaviour, and including both halves lets a flow trace across a process boundary. */
const CALL_EDGE_KINDS: ReadonlySet<string> = new Set([
  "calls",
  "instantiates",
  "extends",
  "implements",
  "references",
  "sends",
  "handles",
  "createsPromise",
  "returnsPromise",
  "awaitsPromise",
  "resolvesPromise",
  "rejectsPromise",
]);

/** The single kind that expresses React component composition (JSX child rendering). */
export const UI_EDGE_KIND = "renders";

export function selectEdgesForMode(edges: GraphEdge[], mode: ViewMode): GraphEdge[] {
  if (mode === "ui") {
    return edges.filter((edge) => edge.kind === UI_EDGE_KIND);
  }
  // Logic flow and PR review are DOM renders, and the Module map walks the import graph on its own
  // surface — none lifts wires onto the call/UI boxes, so they select nothing here.
  if (mode === "logic" || mode === "modules" || mode === "prs") {
    return [];
  }
  return edges.filter((edge) => CALL_EDGE_KINDS.has(edge.kind));
}
