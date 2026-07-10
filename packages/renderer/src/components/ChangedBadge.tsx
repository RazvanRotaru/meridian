/**
 * Change-status colour helpers, re-exported for the node components. The "Δ changed" / "Δ n" header
 * chips were removed — the status ring + body wash (green added / gold modified / red deleted) now
 * carry the "touched" signal on their own, so the chip was redundant clutter. The component stubs
 * stay (returning nothing) so call sites need no edit and the chip is trivial to reinstate.
 */

import type { GraphNode } from "@meridian/core";
import { CHANGED_ACCENT, changedColor, changedFill } from "../theme/changedColors";

export { CHANGED_ACCENT, changedColor, changedFill };

export function ChangedBadge(_props: { node: GraphNode; color?: string }): null {
  return null;
}

export function ChangedCountChip(_props: { count: number; color?: string }): null {
  return null;
}
