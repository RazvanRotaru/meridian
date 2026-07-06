/**
 * The seam between the flow pass's driver and its step builders: control-structure and callback
 * step builders recurse back into the walk through this interface instead of importing the
 * driver, so `flow-pass.ts` / `control-steps.ts` / `callback-steps.ts` stay acyclic.
 */

import { Node } from "ts-morph";
import type { FlowStep } from "@meridian/core";
import type { ResolutionIndex } from "./resolution-index";

export interface FlowWalker {
  index: ResolutionIndex;
  /** Walk one AST node into its steps (a statement, an expression, anything). */
  walk(node: Node, depth: number): FlowStep[];
  /** Walk a callable/control BODY: a block statement-by-statement, or a single expression. */
  walkBody(body: Node, depth: number): FlowStep[];
}

/** The node to walk: a function's block itself, or an arrow/function-expression's body. */
export function bodyOf(callableNode: Node): Node | null {
  if (Node.isBlock(callableNode)) {
    return callableNode;
  }
  return (callableNode as { getBody?(): Node | undefined }).getBody?.() ?? null;
}
