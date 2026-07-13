/**
 * Inline-callback charting for the flow pass. An Array-iteration callback
 * (`items.forEach(x => …)`) genuinely runs, in order, as part of the enclosing flow, so it lifts
 * into a `loop` step. Every OTHER inline callback — a hook body, a `.then` continuation, a
 * `setTimeout` action, a JSX handler — nests under a `callback` step: "this callback was handed
 * to X", asserting nothing about when, or whether, it runs. A callback that is some emitted
 * node's own body (an HOC-wrapped component like `memo(() => …)`) is excluded entirely: it
 * charts as that node's flow, and re-walking it here would double-chart it.
 */

import { Node } from "ts-morph";
import type { ArrowFunction, CallExpression, FunctionExpression, NewExpression, PropertyAccessExpression } from "ts-morph";
import type { FlowStep } from "@meridian/core";
import { iterationLabel } from "./flow-labels";
import { bodyOf, type FlowWalker } from "./flow-walker";
import { ITERATION_METHODS, isInlineCallback } from "./inline-callables";
import { nodeKey } from "./model";

/** One nested `callback` step per inline callback the call was handed (own-body ones excluded). */
export function inlineCallbackSteps(
  node: CallExpression | NewExpression,
  receiver: string | null,
  walker: FlowWalker,
  depth: number,
): FlowStep[] {
  return node
    .getArguments()
    .filter(isInlineCallback)
    .filter((callback) => !walker.index.sourceByCallableKey.has(nodeKey(callback)))
    .flatMap((callback) => {
      const step = callbackStep(callback, receiver, walker, depth);
      return step ? [step] : [];
    });
}

// A JSX-embedded inline callback (`onClick={() => …}`, including one wrapped in pure expressions
// like `onClick={dirty ? () => save() : () => discard()}`): anonymous logic of the enclosing
// component, nested as a `callback` step labeled with its JSX attribute.
export function jsxHandlerSteps(node: Node, walker: FlowWalker, depth: number): FlowStep[] {
  if (!isInlineCallback(node)) {
    return [];
  }
  const jsxExpression = enclosingJsxExpression(node);
  if (!jsxExpression) {
    return [];
  }
  const step = callbackStep(node, jsxAttributeName(jsxExpression), walker, depth);
  return step ? [step] : [];
}

// Climb from an inline callable through PURE expression wrappers (nodes that pass the value along
// unchanged). Reaching a JsxExpression first means the callable is a JSX-bound handler; hitting
// anything else (a call's argument list, a statement, another callable) means it is not.
function enclosingJsxExpression(node: Node): Node | null {
  let current = node.getParent();
  while (current && isPureExpressionWrapper(current)) {
    current = current.getParent();
  }
  return current && Node.isJsxExpression(current) ? current : null;
}

function isPureExpressionWrapper(node: Node): boolean {
  return (
    Node.isParenthesizedExpression(node) ||
    Node.isConditionalExpression(node) ||
    Node.isBinaryExpression(node) ||
    Node.isAsExpression(node) ||
    Node.isNonNullExpression(node) ||
    Node.isSatisfiesExpression(node)
  );
}

function jsxAttributeName(jsxExpression: Node): string | null {
  const parent = jsxExpression.getParent();
  return parent && Node.isJsxAttribute(parent) ? parent.getNameNode().getText() : null;
}

// An inline callback's body as ONE nested step. A callback with nothing worth charting inside
// contributes no step at all.
function callbackStep(callback: Node, receiver: string | null, walker: FlowWalker, depth: number): FlowStep | null {
  const body = bodyOf(callback);
  const steps = body ? walker.walkBody(body, depth + 1) : [];
  if (steps.length === 0) {
    return null;
  }
  return { kind: "callback", label: receiver ? `callback → ${receiver}` : "callback", body: steps, source: walker.source(callback) };
}

export interface IterationCall {
  callee: PropertyAccessExpression;
  callback: ArrowFunction | FunctionExpression;
}

// An Array-iteration call with an INLINE callback — the shape we lift into a loop. A named
// callback (`items.forEach(handler)`) is not inline, so it falls through to a plain call.
export function iterationCall(node: CallExpression): IterationCall | null {
  const callee = node.getExpression();
  if (!Node.isPropertyAccessExpression(callee) || !ITERATION_METHODS.has(callee.getName())) {
    return null;
  }
  const callback = node.getArguments().find(isInlineCallback);
  return callback ? { callee, callback } : null;
}

// The receiver and any non-callback args evaluate BEFORE the callback iterates, so emit their
// calls first, in execution order (e.g. getItems() in getItems().forEach(cb)); then the loop
// whose body is the callback walked inline — NOT stopped at the arrow's callable boundary, since
// this callback genuinely runs as part of THIS flow rather than being its own callable.
export function iterationSteps(node: CallExpression, call: IterationCall, walker: FlowWalker, depth: number): FlowStep[] {
  const preludeNodes = [call.callee.getExpression(), ...node.getArguments().filter((arg) => arg !== call.callback)];
  const steps = preludeNodes.flatMap((child) => walker.walk(child, depth + 1));
  const body = call.callback.getBody();
  steps.push({
    kind: "loop",
    label: iterationLabel(call.callee.getName(), call.callback),
    body: body ? walker.walkBody(body, depth + 1) : [],
    source: walker.source(node),
  });
  return steps;
}
