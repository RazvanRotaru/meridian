/**
 * The logic-flow pass: for each callable descriptor, walk its body AST into an ordered
 * `FlowStep[]`; for each MODULE, walk its top-level statements the same way (the code that
 * auto-runs on load). Only method calls, async wait points, and control structures survive;
 * everything else collapses to nothing (but is still descended into, to find calls buried in it).
 * Calls are emitted in EXECUTION order — arguments before the call — so `f(g(x))` yields `g` then
 * `f`. Nested function/class DECLARATIONS are not descended: they are their own callables. But
 * inline callbacks chart here, in the flow that contains them: an Array-iteration callback
 * (`items.forEach(x => …)`) lifts into a `loop` step (it genuinely runs, in order, as part of
 * this flow); every OTHER inline callback (a `useEffect`/`useMemo` body, a `.then` continuation,
 * a `setTimeout` action, a JSX handler like `onClick={() => …}`) nests under a `callback` step —
 * "this callback was handed to X" — asserting nothing about when, or whether, it runs. The
 * exception: a callback that is itself an emitted node's body (an HOC-wrapped component) charts
 * as that node's own flow instead of double-charting here (see `callback-steps.ts`).
 */

import { Node } from "ts-morph";
import type { AwaitExpression, CallExpression, NewExpression, ReturnStatement, SourceFile, ThrowStatement } from "ts-morph";
import type { FlowStep, LogicFlows } from "@meridian/core";
import { createCallAnnotator, directAwaitOperandCall, standaloneAwaitStep } from "./call-annotations";
import { inlineCallbackSteps, iterationCall, iterationSteps, jsxHandlerSteps } from "./callback-steps";
import { controlStep } from "./control-steps";
import { calleeName, truncate } from "./flow-labels";
import { bodyOf, type FlowWalker } from "./flow-walker";
import { resolveTarget } from "./edge-resolve";
import type { NodeDescriptor } from "./model";
import type { ResolutionIndex } from "./resolution-index";

/** A generous ceiling that only truly pathological nesting hits — a stack-overflow guard. */
const MAX_DEPTH = 500;

/**
 * One flow per callable descriptor — and per module (its top-level, load-time statements) —
 * whose id survives depth-collapse. An empty flow (no calls, no control structures) is omitted
 * — an absent entry means "nothing worth charting". `moduleSourcesById` maps a surviving
 * module's node id to its `SourceFile`; module descriptors keep `callableNode: null` so edge
 * sourcing is unaffected.
 */
export function buildLogicFlows(
  descriptors: NodeDescriptor[],
  index: ResolutionIndex,
  keepIds: ReadonlySet<string>,
  moduleSourcesById: ReadonlyMap<string, SourceFile>,
): LogicFlows {
  const flows: LogicFlows = {};
  const walker = createWalker(index);
  for (const descriptor of descriptors) {
    if (!keepIds.has(descriptor.finalId)) {
      continue;
    }
    const steps = stepsOf(descriptor, moduleSourcesById, walker);
    // Exit steps alone don't make a flow worth charting — `function f() { return 0; }` stays
    // omitted, exactly as it was before returns were charted at all.
    if (steps.some((step) => step.kind !== "exit")) {
      flows[descriptor.finalId] = steps;
    }
  }
  return flows;
}

/** A callable charts its body; a module charts the top-level statements that run on load. */
function stepsOf(
  descriptor: NodeDescriptor,
  moduleSourcesById: ReadonlyMap<string, SourceFile>,
  walker: FlowWalker,
): FlowStep[] {
  if (descriptor.callableNode) {
    return flowOf(descriptor.callableNode, walker);
  }
  const sourceFile = moduleSourcesById.get(descriptor.finalId);
  return sourceFile ? moduleFlow(sourceFile, walker) : [];
}

function flowOf(callableNode: Node, walker: FlowWalker): FlowStep[] {
  const body = bodyOf(callableNode);
  return body ? walker.walkBody(body, 0) : [];
}

// The same walker as a callable body: imports/declarations collapse to nothing, `export <fn>`
// stops at its callable boundary, and a `const App = memo(() => {…})` wrapper emits one call
// without re-charting App's body (the callback is App's own flow, not the module's).
function moduleFlow(sourceFile: SourceFile, walker: FlowWalker): FlowStep[] {
  return sourceFile.getStatements().flatMap((statement) => walker.walk(statement, 0));
}

/** The step builders recurse through this object, so the modules stay import-acyclic. */
function createWalker(index: ResolutionIndex): FlowWalker {
  const walker: FlowWalker = {
    index,
    walk: (node, depth) => walk(node, walker, depth),
    walkBody: (body, depth) => walkBody(body, walker, depth),
    annotate: createCallAnnotator(),
  };
  return walker;
}

/** A block contributes its statements' steps; a concise arrow body is a single expression. */
function walkBody(body: Node, walker: FlowWalker, depth: number): FlowStep[] {
  if (Node.isBlock(body)) {
    return body.getStatements().flatMap((statement) => walk(statement, walker, depth));
  }
  return walk(body, walker, depth);
}

function walk(node: Node, walker: FlowWalker, depth: number): FlowStep[] {
  if (depth > MAX_DEPTH) {
    return [];
  }
  if (isCallableBoundary(node)) {
    return jsxHandlerSteps(node, walker, depth);
  }
  const control = controlStep(node, walker, depth);
  if (control) {
    return [control];
  }
  if (Node.isAwaitExpression(node)) {
    return awaitSteps(node, walker, depth);
  }
  if (Node.isCallExpression(node) || Node.isNewExpression(node)) {
    return callSteps(node, walker, depth);
  }
  if (Node.isReturnStatement(node) || Node.isThrowStatement(node)) {
    return exitSteps(node, walker, depth);
  }
  return descend(node, walker, depth);
}

// Calls nested directly under await carry the wait on their existing call step. A value operand
// (`await pending`) has no call of its own, so append an explicit join after evaluating the operand.
function awaitSteps(node: AwaitExpression, walker: FlowWalker, depth: number): FlowStep[] {
  const steps = descend(node, walker, depth);
  // A chartable DIRECT call/barrier already owns the wait badge. Pin this to the operand itself:
  // an awaited call nested in an argument must not suppress an unnameable outer call's wait gate.
  const directCall = directAwaitOperandCall(node);
  const waitAlreadyCharted = directCall !== null
    && calleeName(directCall.getExpression()) !== null
    && !(Node.isCallExpression(directCall) && iterationCall(directCall) !== null);
  const awaitStep = standaloneAwaitStep(node, waitAlreadyCharted);
  if (awaitStep) {
    steps.push(awaitStep);
  }
  return steps;
}

// The returned/thrown expression runs FIRST (its calls chart in order), then the path ends: an
// explicit `exit` step, so downstream views can tell a guard that leaves from a branch that falls
// through — the difference between "this then-path rejoins" and "the rest is really the else".
function exitSteps(node: ReturnStatement | ThrowStatement, walker: FlowWalker, depth: number): FlowStep[] {
  const steps = descend(node, walker, depth);
  const expression = node.getExpression();
  steps.push({
    kind: "exit",
    variant: Node.isReturnStatement(node) ? "return" : "throw",
    label: expression ? truncate(expression.getText()) : null,
  });
  return steps;
}

/** Collapse this node to nothing, but keep looking inside it for calls. */
function descend(node: Node, walker: FlowWalker, depth: number): FlowStep[] {
  return node.forEachChildAsArray().flatMap((child) => walk(child, walker, depth + 1));
}

// Descend first (arguments + callee sub-expressions run before the call), then emit this call,
// then one nested `callback` step per inline callback it was handed — UNLESS this is an
// Array-iteration call with an inline callback, which becomes a loop instead. An unnameable
// callee (super(), import(), computed) emits no call step of its own.
function callSteps(node: CallExpression | NewExpression, walker: FlowWalker, depth: number): FlowStep[] {
  const iteration = Node.isCallExpression(node) ? iterationCall(node) : null;
  if (iteration) {
    return iterationSteps(node as CallExpression, iteration, walker, depth);
  }
  const steps = descend(node, walker, depth);
  const callee = node.getExpression();
  const label = calleeName(callee);
  if (label) {
    const resolution = resolveTarget(callee, walker.index);
    steps.push({ kind: "call", label, target: resolution.resolvedTarget, resolution: resolution.resolution, ...walker.annotate(node) });
  }
  steps.push(...inlineCallbackSteps(node, label, walker, depth));
  return steps;
}

function isCallableBoundary(node: Node): boolean {
  return (
    Node.isFunctionDeclaration(node) ||
    Node.isFunctionExpression(node) ||
    Node.isArrowFunction(node) ||
    Node.isClassDeclaration(node) ||
    Node.isClassExpression(node) ||
    Node.isMethodDeclaration(node) ||
    Node.isConstructorDeclaration(node) ||
    Node.isGetAccessorDeclaration(node) ||
    Node.isSetAccessorDeclaration(node)
  );
}
