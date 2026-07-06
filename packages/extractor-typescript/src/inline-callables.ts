/**
 * Shared judgments about inline callables (arrow/function expressions used as expressions):
 * what counts as an inline callback, which Array-iteration calls treat one as a loop body,
 * and what callable — if any — a const/property/default-export declaration binds.
 */

import { Node, type ArrowFunction, type CallExpression, type FunctionExpression } from "ts-morph";

/** Synchronous Array-iteration methods whose inline callback runs once per element, in order. */
export const ITERATION_METHODS = new Set([
  "forEach",
  "map",
  "filter",
  "reduce",
  "reduceRight",
  "some",
  "every",
  "find",
  "findIndex",
  "findLast",
  "findLastIndex",
  "flatMap",
  "sort",
]);

export function isInlineCallback(node: Node): node is ArrowFunction | FunctionExpression {
  return Node.isArrowFunction(node) || Node.isFunctionExpression(node);
}

/**
 * What a declaration's initializer/exported expression binds as a callable:
 * - `body` — an inline arrow/function expression, possibly under React component wrappers
 *   (`memo(() => …)`, `memo(forwardRef(() => …))`); the node's own flowable body.
 * - `alias` — a component wrapper around a REFERENCE (`memo(AppImpl)`); a bodiless alias node,
 *   because the body belongs to the referenced declaration's own node.
 */
export type CallableBinding = { kind: "body"; callable: Node } | { kind: "alias" };

/**
 * Resolve the binding, or null when the expression binds a plain value. Only the KNOWN component
 * wrappers unwrap: an arbitrary call taking an inline callback (`fetch().then(d => …)`,
 * `subscribe(() => …)`, `buildApi(() => …)`) binds the call's RESULT, not the callback — treating
 * it as a callable would mint phantom function nodes for ordinary values.
 */
export function resolveCallableBinding(node: Node | undefined): CallableBinding | null {
  if (!node) {
    return null;
  }
  if (isInlineCallback(node)) {
    return { kind: "body", callable: node };
  }
  if (!isComponentWrapperCall(node)) {
    return null;
  }
  const wrapped = node.getArguments()[0];
  if (wrapped && Node.isIdentifier(wrapped)) {
    return { kind: "alias" };
  }
  return resolveCallableBinding(wrapped);
}

/**
 * React's standard component wrappers. A call to one of these binds a component even when its
 * argument is a reference declared elsewhere — a shape syntax alone cannot classify for arbitrary
 * callees (`compute(helper)` binds a value) — so exactly these names are special-cased.
 */
const COMPONENT_WRAPPERS = new Set(["memo", "forwardRef"]);

/** `memo(...)` / `forwardRef(...)` — bare, or with receiver EXACTLY `React` (`lru.memo(x)` is not). */
function isComponentWrapperCall(node: Node): node is CallExpression {
  if (!Node.isCallExpression(node)) {
    return false;
  }
  const callee = node.getExpression();
  if (Node.isIdentifier(callee)) {
    return COMPONENT_WRAPPERS.has(callee.getText());
  }
  return (
    Node.isPropertyAccessExpression(callee) &&
    COMPONENT_WRAPPERS.has(callee.getName()) &&
    Node.isIdentifier(callee.getExpression()) &&
    callee.getExpression().getText() === "React"
  );
}
