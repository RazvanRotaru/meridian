/**
 * Deterministic box sizing. React Flow parents do NOT auto-size, and ELK needs a concrete
 * width/height for every leaf and collapsed node, so we compute them from the content we
 * intend to paint (title, "N items", or a function signature) rather than guessing post-hoc.
 */

import type { VisibleNode } from "../derive/types";

const CHAR_WIDTH = 7.4;
const MIN_WIDTH = 168;
const MAX_WIDTH = 420;
// Heights mirror what the node components actually paint: a 34px header row, then one
// optional 20px summary line, then an optional 24px signature line (plus body padding).
const HEADER_HEIGHT = 34;
const SUMMARY_HEIGHT = 20;
const SIGNATURE_HEIGHT = 24;
const BODY_PADDING = 12;

export interface BoxSize {
  width: number;
  height: number;
}

export function isCallable(kind: string): boolean {
  return kind === "function" || kind === "method";
}

/** Size for any node ELK will NOT measure itself: a leaf or a collapsed container. */
export function boxSize(visibleNode: VisibleNode): BoxSize {
  const node = visibleNode.node;
  const signature = isCallable(node.kind) ? (node.signature ?? "") : "";
  const hasSummary = Boolean(node.summary);
  // The header row also fits the kind label and (for containers) the child-count chip.
  const headerChars = node.displayName.length + node.kind.length + (visibleNode.isContainer ? 6 : 0);
  const longestLine = Math.max(headerChars, signature.length);
  const width = clamp(MIN_WIDTH, MAX_WIDTH, 56 + longestLine * CHAR_WIDTH);
  const bodyLines = (hasSummary ? SUMMARY_HEIGHT : 0) + (signature.length > 0 ? SIGNATURE_HEIGHT : 0);
  const height = HEADER_HEIGHT + (bodyLines > 0 ? bodyLines + BODY_PADDING : 0);
  return { width: Math.round(width), height };
}

function clamp(min: number, max: number, value: number): number {
  return Math.min(max, Math.max(min, value));
}
