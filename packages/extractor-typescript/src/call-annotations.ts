/**
 * Async annotations for a charted call: is it AWAITED (execution holds), or DETACHED (its result is
 * deliberately dropped — fire-and-forget work that outlives the flow)? Kept out of the flow pass so
 * the walking and the annotating stay single-purpose.
 *
 * A `.then()/.catch()/.finally()` chain is ONE hand-off: only its head call is marked detached (a
 * chain whose result nobody keeps has a Promise-bearing head by construction, so no checker query
 * is needed there). The continuation calls themselves are never detached — charting each link would
 * fan one dropped statement out into several detached lanes downstream.
 */

import { Node } from "ts-morph";
import type { CallExpression, NewExpression } from "ts-morph";

export interface CallAnnotations {
  awaited?: boolean;
  detached?: boolean;
}

/** The annotator memoizes Promise-ness per callee SYMBOL: a repo calls the same few side-effect
 * functions (`logger.info`, `res.send`, …) thousands of times in statement position, and the type
 * checker should price each of them once, not per call site. */
export function createCallAnnotator(): (node: CallExpression | NewExpression) => CallAnnotations {
  const promiseByCallee = new Map<unknown, boolean>();
  const isPromise = (node: CallExpression | NewExpression) => returnsPromise(node, promiseByCallee);
  return (node) => {
    if (isAwaited(node)) {
      return { awaited: true };
    }
    if (isDetached(node, isPromise)) {
      return { detached: true };
    }
    return {};
  };
}

/** The expression this call answers to, looking through wrappers that don't change its fate. */
function enclosing(node: Node): Node | undefined {
  let parent = node.getParent();
  while (parent && (Node.isParenthesizedExpression(parent) || Node.isNonNullExpression(parent))) {
    parent = parent.getParent();
  }
  return parent;
}

function isAwaited(node: CallExpression | NewExpression): boolean {
  const parent = enclosing(node);
  return parent !== undefined && Node.isAwaitExpression(parent);
}

/** Promise continuations that consume a result without ever surfacing it to this flow. */
const CONTINUATION_NAMES = new Set(["then", "catch", "finally"]);

/**
 * Detached when the result is deliberately dropped: `void`-ed, an un-awaited Promise standing alone
 * as a statement, or the HEAD of a continuation chain that itself stands alone. The continuation
 * calls are excluded up front (see the module note).
 */
function isDetached(node: CallExpression | NewExpression, isPromise: (node: CallExpression | NewExpression) => boolean): boolean {
  if (isContinuationCall(node)) {
    return false;
  }
  const parent = enclosing(node);
  if (!parent) {
    return false;
  }
  if (Node.isVoidExpression(parent)) {
    return true;
  }
  if (Node.isExpressionStatement(parent)) {
    return isPromise(node);
  }
  if (Node.isPropertyAccessExpression(parent) && CONTINUATION_NAMES.has(parent.getName())) {
    const chained = enclosing(parent);
    return chained !== undefined && Node.isCallExpression(chained) && chainIsDropped(chained);
  }
  return false;
}

/** `send(x).then(cb)` — a call whose callee is a continuation on another call's result. */
function isContinuationCall(node: CallExpression | NewExpression): boolean {
  if (!Node.isCallExpression(node)) {
    return false;
  }
  const callee = node.getExpression();
  return Node.isPropertyAccessExpression(callee) && CONTINUATION_NAMES.has(callee.getName()) && Node.isCallExpression(callee.getExpression());
}

/** Does this chain link's result ultimately go nowhere (a bare statement / `void`), however many
 * further continuations it passes through? `await`, assignment, or argument use all keep it. */
function chainIsDropped(node: CallExpression): boolean {
  const parent = enclosing(node);
  if (!parent) {
    return false;
  }
  if (Node.isVoidExpression(parent) || Node.isExpressionStatement(parent)) {
    return true;
  }
  if (Node.isPropertyAccessExpression(parent) && CONTINUATION_NAMES.has(parent.getName())) {
    const chained = enclosing(parent);
    return chained !== undefined && Node.isCallExpression(chained) && chainIsDropped(chained);
  }
  return false;
}

// The checker query is confined to statement-position calls and cached per callee symbol; a `new`
// expression yields its instance, never a bare Promise worth flagging.
function returnsPromise(node: CallExpression | NewExpression, cache: Map<unknown, boolean>): boolean {
  if (!Node.isCallExpression(node)) {
    return false;
  }
  const callee = node.getExpression().getSymbol();
  const cached = callee ? cache.get(callee) : undefined;
  if (cached !== undefined) {
    return cached;
  }
  const result = node.getType().getSymbol()?.getName() === "Promise";
  if (callee) {
    cache.set(callee, result);
  }
  return result;
}
