/**
 * Deterministic box sizing. React Flow parents do NOT auto-size, and ELK needs a concrete
 * width/height for every leaf and collapsed node, so we compute them from the content we
 * intend to paint (title, "N items", or a function signature) rather than guessing post-hoc.
 */

import type { VisibleNode } from "../derive/types";

const COLLAPSED_WIDTH = 232;
const COLLAPSED_HEIGHT = 78;
const CHAR_WIDTH = 7.4;
const MIN_CALLABLE_WIDTH = 200;
const MAX_CALLABLE_WIDTH = 420;

export interface BoxSize {
  width: number;
  height: number;
}

export function isCallable(kind: string): boolean {
  return kind === "function" || kind === "method";
}

/** Size for any node ELK will NOT measure itself: a leaf or a collapsed container. */
export function boxSize(visibleNode: VisibleNode): BoxSize {
  if (isCallable(visibleNode.node.kind)) {
    return callableSize(visibleNode);
  }
  return { width: COLLAPSED_WIDTH, height: COLLAPSED_HEIGHT };
}

function callableSize(visibleNode: VisibleNode): BoxSize {
  const signature = visibleNode.node.signature ?? "";
  const titleText = visibleNode.node.displayName;
  const longestLine = Math.max(titleText.length, signature.length);
  const width = clamp(MIN_CALLABLE_WIDTH, MAX_CALLABLE_WIDTH, 40 + longestLine * CHAR_WIDTH);
  // Pins occupy a dedicated row under the signature, so callable leaves are taller.
  const height = signature.length > 0 ? 104 : 76;
  return { width: Math.round(width), height };
}

function clamp(min: number, max: number, value: number): number {
  return Math.min(max, Math.max(min, value));
}
