/**
 * The PR / diff status palette: one hue per change kind, so a "touched" node reads its status from
 * colour alone. GOLD stays "modified" (the original single diff accent); ADDED is green and DELETED
 * red, mirroring the PR file-list statuses. RENAMED rides gold — a rename with no content change is,
 * for the graph, a modified file. The status rides `graphIndex.changedStatus`; a node with no entry
 * (a container that merely CONTAINS changes) falls back to gold, the neutral "contains changes" hue.
 */

import type { ChangeStatus } from "@meridian/core";

export const CHANGED_COLORS = {
  added: "#3FB950", // green — a newly added node (every kind: file / function / class…)
  modified: "#E2A33C", // gold — an edited node (the original diff accent)
  deleted: "#E5484D", // red — a deleted node
  renamed: "#E2A33C", // gold — treated as modified for the ring
} as const satisfies Record<ChangeStatus, string>;

/** The ring/tag colour for a change status; gold is the fallback for "contains changes" containers. */
export function changedColor(status: ChangeStatus | undefined | null): string {
  return status ? CHANGED_COLORS[status] : CHANGED_COLORS.modified;
}

/** Small textual status chips need a little more luminance than the corresponding graph ring.
 * In particular, the canonical deletion red is intentionally dense and falls short for tiny type
 * on the dark review canvas; keep the semantic hue while lifting only its text treatment. */
export function changedTextColor(status: ChangeStatus): string {
  return status === "deleted" ? "#FF7B82" : changedColor(status);
}

/** The translucent body wash layered over a card's dark base for a changed node — a visible warm
 * (or green / red) fill that reads as "touched" without drowning the card's own content. ~18%. */
export function changedFill(color: string): string {
  return `${color}2E`;
}

/** The original single diff accent, kept so pre-status call sites (gold fallback) read unchanged. */
export const CHANGED_ACCENT = CHANGED_COLORS.modified;
