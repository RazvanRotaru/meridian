/**
 * Async annotations for a charted call: is it AWAITED (execution holds), DETACHED (its result is
 * deliberately dropped), or the launch/join point of a Promise task? Kept out of the flow pass so
 * the walking and the annotating stay single-purpose.
 *
 * A `.then()/.catch()/.finally()` chain is ONE hand-off: only its head call is marked detached.
 * The continuation calls themselves are never detached — charting each link would fan one dropped
 * statement out into several detached lanes downstream.
 */

import { Node } from "ts-morph";
import type { AwaitExpression, CallExpression, NewExpression } from "ts-morph";
import type { FlowAsyncInput, FlowBarrierMode, FlowCallAsync, FlowStep } from "@meridian/core";
import { calleeName, truncate } from "./flow-labels";

export interface CallAnnotations {
  awaited?: boolean;
  detached?: boolean;
  async?: FlowCallAsync;
}

/** The direct operand call of an await, looking through wrappers that keep the same value. Keeping
 * this identity available lets the flow pass ask whether THAT call emitted a wait carrier, without
 * confusing it with an awaited call nested in one of the operand's arguments. */
export function directAwaitOperandCall(node: AwaitExpression): CallExpression | NewExpression | null {
  const expression = unwrap(node.getExpression());
  return Node.isCallExpression(expression) || Node.isNewExpression(expression) ? expression : null;
}

/** The annotator memoizes Promise-ness per callee SYMBOL: a repo calls the same few functions
 * thousands of times, and the type checker should price each of them once, not per call site. */
export function createCallAnnotator(): (node: CallExpression | NewExpression) => CallAnnotations {
  const promiseByCallee = new Map<unknown, boolean>();
  const isPromise = (node: CallExpression | NewExpression) => returnsPromise(node, promiseByCallee);
  return (node) => {
    const barrier = Node.isCallExpression(node) && isAwaited(node) ? barrierAnnotation(node, isPromise) : null;
    if (barrier) {
      // Keep the legacy flag: old renderers still understand this as an ordinary awaited call.
      return { awaited: true, async: barrier };
    }
    if (isAwaited(node)) {
      return { awaited: true, async: { kind: "direct-await", taskId: taskId(node) } };
    }

    const detached = isDetached(node, isPromise);
    const launch = !isContinuationCall(node) && isPromise(node) ? launchAnnotation(node) : null;
    if (detached && launch) {
      return { detached: true, async: launch };
    }
    if (detached) {
      return { detached: true };
    }
    return launch ? { async: launch } : {};
  };
}

/** A wait that has no call block of its own to carry it. Most direct call awaits and Promise
 * barriers stay on their existing call steps; `waitAlreadyCharted` is false for calls the flow
 * intentionally cannot name (`import()`, computed access, etc.), so those still get a structural
 * await gate instead of disappearing. */
export function standaloneAwaitStep(
  node: AwaitExpression,
  waitAlreadyCharted = false,
): Extract<FlowStep, { kind: "await" }> | null {
  if (waitAlreadyCharted) {
    return null;
  }
  const expression = unwrap(node.getExpression());
  // An uncharted direct call has no launch node for a correlation rail. Keep its readable source
  // label, but deliberately omit a task id so the renderer draws one self-contained wait gate.
  const input = Node.isCallExpression(expression) || Node.isNewExpression(expression)
    ? { label: asyncInputLabel(expression) }
    : asyncInput(expression, (call) => returnsPromise(call, new Map()));
  return { kind: "await", label: `await ${input.label}`, mode: "single", inputs: [input] };
}

function launchAnnotation(node: CallExpression | NewExpression): Extract<FlowCallAsync, { kind: "launch" }> {
  const binding = launchBinding(node);
  return binding
    ? { kind: "launch", taskId: taskId(node), binding }
    : { kind: "launch", taskId: taskId(node) };
}

function barrierAnnotation(
  node: CallExpression,
  isPromise: (node: CallExpression | NewExpression) => boolean,
): Extract<FlowCallAsync, { kind: "barrier" }> | null {
  const mode = barrierMode(node);
  if (!mode) {
    return null;
  }
  const firstArgument = node.getArguments()[0];
  const inputExpression = firstArgument ? unwrap(firstArgument) : null;
  const inputs = inputExpression && Node.isArrayLiteralExpression(inputExpression)
    ? inputExpression.getElements().map((element) => asyncInput(element, isPromise))
    : inputExpression
      ? [asyncInput(inputExpression, isPromise)]
      : [];
  return { kind: "barrier", mode, inputs };
}

function barrierMode(node: CallExpression): FlowBarrierMode | null {
  const callee = node.getExpression();
  if (!Node.isPropertyAccessExpression(callee)) {
    return null;
  }
  const receiver = unwrap(callee.getExpression());
  if (!Node.isIdentifier(receiver) || receiver.getText() !== "Promise") {
    return null;
  }
  const name = callee.getName();
  return name === "all" || name === "allSettled" ? name : null;
}

/** Produce a readable barrier/wait operand and link it to its launch whenever the expression is a
 * direct Promise call or a local binding initialized by one. */
function asyncInput(
  node: Node,
  isPromise: (node: CallExpression | NewExpression) => boolean,
): FlowAsyncInput {
  const expression = unwrap(node);
  const label = asyncInputLabel(expression);
  if ((Node.isCallExpression(expression) || Node.isNewExpression(expression)) && isPromise(expression)) {
    return { label, taskId: taskId(expression) };
  }
  if (Node.isIdentifier(expression)) {
    const launch = referencedLaunch(expression, isPromise);
    if (launch) {
      return { label, taskId: taskId(launch) };
    }
  }
  return { label };
}

function asyncInputLabel(node: Node): string {
  if (Node.isCallExpression(node) || Node.isNewExpression(node)) {
    return calleeName(node.getExpression()) ?? truncate(node.getText());
  }
  return truncate(node.getText());
}

function referencedLaunch(
  reference: Node,
  isPromise: (node: CallExpression | NewExpression) => boolean,
): CallExpression | NewExpression | null {
  for (const declaration of reference.getSymbol()?.getDeclarations() ?? []) {
    if (!Node.isVariableDeclaration(declaration)) {
      continue;
    }
    const initializer = declaration.getInitializer();
    const expression = initializer ? unwrap(initializer) : null;
    if (expression && (Node.isCallExpression(expression) || Node.isNewExpression(expression)) && isPromise(expression)) {
      return expression;
    }
  }
  return null;
}

/** The local binding when this call is the value stored by a variable declaration. */
function launchBinding(node: CallExpression | NewExpression): string | null {
  let expression: Node = node;
  let parent = expression.getParent();
  while (parent && isTransparentWrapper(parent)) {
    expression = parent;
    parent = expression.getParent();
  }
  if (!parent || !Node.isVariableDeclaration(parent) || parent.getInitializer() !== expression) {
    return null;
  }
  return truncate(parent.getName());
}

/** Source offsets are deterministic and unique inside the one source file that owns a flow. */
function taskId(node: CallExpression | NewExpression): string {
  return `task:${node.getStart()}`;
}

/** The expression this call answers to, looking through wrappers that don't change its fate. */
function enclosing(node: Node): Node | undefined {
  let parent = node.getParent();
  while (parent && isTransparentWrapper(parent)) {
    parent = parent.getParent();
  }
  return parent;
}

function unwrap(node: Node): Node {
  let expression = node;
  let inner: Node | null;
  while ((inner = transparentInner(expression)) !== null) {
    expression = inner;
  }
  return expression;
}

function transparentInner(node: Node): Node | null {
  if (Node.isParenthesizedExpression(node) || Node.isNonNullExpression(node)) {
    return node.getExpression();
  }
  if (Node.isAsExpression(node) || Node.isSatisfiesExpression(node) || Node.isTypeAssertion(node)) {
    return node.getExpression();
  }
  return null;
}

function isTransparentWrapper(node: Node): boolean {
  return (
    Node.isParenthesizedExpression(node) ||
    Node.isNonNullExpression(node) ||
    Node.isAsExpression(node) ||
    Node.isSatisfiesExpression(node) ||
    Node.isTypeAssertion(node)
  );
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

// The checker query is cached per callee symbol; a `new` expression yields its instance, never a
// bare Promise worth flagging under the pre-existing detached-call rules.
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
