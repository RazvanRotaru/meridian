/**
 * The logic-flow pass: for each callable descriptor, walk its body AST into an ordered
 * `FlowStep[]`; for each MODULE, walk its top-level statements the same way (the code that
 * auto-runs on load). Only method calls and control structures survive; everything else
 * collapses to nothing (but is still descended into, to find the calls buried in it). Calls
 * are emitted in EXECUTION order — arguments before the call — so `f(g(x))` yields `g` then
 * `f`. Nested function/arrow/class bodies are NOT descended: they are their own callables — the
 * one exception is an inline callback to a synchronous Array-iteration method (`forEach`/`map`/…),
 * which is lifted into a `loop` step (see `iterationCall`) because it runs as part of this flow.
 */

import { Node } from "ts-morph";
import type {
  ArrowFunction,
  CallExpression,
  CaseOrDefaultClause,
  CatchClause,
  FunctionExpression,
  IfStatement,
  IterationStatement,
  NewExpression,
  PropertyAccessExpression,
  SourceFile,
  SwitchStatement,
  TryStatement,
} from "ts-morph";
import type { FlowPath, FlowStep, LogicFlows } from "@meridian/core";
import { resolveTarget } from "./edge-resolve";
import {
  calleeName,
  forLabel,
  forOfLabel,
  ifLabel,
  iterationLabel,
  switchLabel,
  truncate,
  whileLabel,
} from "./flow-labels";
import type { NodeDescriptor } from "./model";
import type { ResolutionIndex } from "./resolution-index";

/** A generous ceiling that only truly pathological nesting hits — a stack-overflow guard. */
const MAX_DEPTH = 500;

interface WalkContext {
  index: ResolutionIndex;
}

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
  const context: WalkContext = { index };
  for (const descriptor of descriptors) {
    if (!keepIds.has(descriptor.finalId)) {
      continue;
    }
    const steps = stepsOf(descriptor, moduleSourcesById, context);
    if (steps.length > 0) {
      flows[descriptor.finalId] = steps;
    }
  }
  return flows;
}

/** A callable charts its body; a module charts the top-level statements that run on load. */
function stepsOf(
  descriptor: NodeDescriptor,
  moduleSourcesById: ReadonlyMap<string, SourceFile>,
  context: WalkContext,
): FlowStep[] {
  if (descriptor.callableNode) {
    return flowOf(descriptor.callableNode, context);
  }
  const sourceFile = moduleSourcesById.get(descriptor.finalId);
  return sourceFile ? moduleFlow(sourceFile, context) : [];
}

function flowOf(callableNode: Node, context: WalkContext): FlowStep[] {
  const body = bodyOf(callableNode);
  return body ? walkBody(body, context, 0) : [];
}

// The same walker as a callable body: imports/declarations collapse to nothing, `export <fn>`
// stops at its callable boundary, and an `app.on('x', () => {…})` registration emits one call
// without descending its callback (the callback does not run at load).
function moduleFlow(sourceFile: SourceFile, context: WalkContext): FlowStep[] {
  return sourceFile.getStatements().flatMap((statement) => walk(statement, context, 0));
}

/** The node to walk: a function's block itself, or an arrow/function-expression's body. */
function bodyOf(callableNode: Node): Node | null {
  if (Node.isBlock(callableNode)) {
    return callableNode;
  }
  return (callableNode as { getBody?(): Node | undefined }).getBody?.() ?? null;
}

/** A block contributes its statements' steps; a concise arrow body is a single expression. */
function walkBody(body: Node, context: WalkContext, depth: number): FlowStep[] {
  if (Node.isBlock(body)) {
    return body.getStatements().flatMap((statement) => walk(statement, context, depth));
  }
  return walk(body, context, depth);
}

function walk(node: Node, context: WalkContext, depth: number): FlowStep[] {
  if (depth > MAX_DEPTH || isCallableBoundary(node)) {
    return [];
  }
  const control = controlStep(node, context, depth);
  if (control) {
    return [control];
  }
  if (Node.isCallExpression(node) || Node.isNewExpression(node)) {
    return callSteps(node, context, depth);
  }
  return descend(node, context, depth);
}

/** Collapse this node to nothing, but keep looking inside it for calls. */
function descend(node: Node, context: WalkContext, depth: number): FlowStep[] {
  return node.forEachChildAsArray().flatMap((child) => walk(child, context, depth + 1));
}

function controlStep(node: Node, context: WalkContext, depth: number): FlowStep | null {
  if (Node.isIterationStatement(node)) {
    return loopStep(node, context, depth);
  }
  if (Node.isIfStatement(node)) {
    return ifStep(node, context, depth);
  }
  if (Node.isSwitchStatement(node)) {
    return switchStep(node, context, depth);
  }
  if (Node.isTryStatement(node)) {
    return tryStep(node, context, depth);
  }
  return null;
}

function loopStep(node: IterationStatement, context: WalkContext, depth: number): FlowStep {
  return { kind: "loop", label: loopLabel(node), body: walkBody(node.getStatement(), context, depth + 1) };
}

function loopLabel(node: IterationStatement): string {
  if (Node.isForOfStatement(node) || Node.isForInStatement(node)) {
    return forOfLabel(node);
  }
  if (Node.isWhileStatement(node) || Node.isDoStatement(node)) {
    return whileLabel(node);
  }
  return Node.isForStatement(node) ? forLabel(node) : "loop";
}

// `else if` chains nest: the `else` path holds the trailing `if` as its own single branch step.
function ifStep(node: IfStatement, context: WalkContext, depth: number): FlowStep {
  const paths: FlowPath[] = [{ label: "then", body: walkBody(node.getThenStatement(), context, depth + 1) }];
  const elseStatement = node.getElseStatement();
  if (elseStatement) {
    paths.push({ label: "else", body: walkBody(elseStatement, context, depth + 1) });
  }
  return { kind: "branch", label: ifLabel(node), paths };
}

function switchStep(node: SwitchStatement, context: WalkContext, depth: number): FlowStep {
  const paths = node.getClauses().map((clause) => clausePath(clause, context, depth));
  return { kind: "branch", label: switchLabel(node), paths };
}

function clausePath(clause: CaseOrDefaultClause, context: WalkContext, depth: number): FlowPath {
  const label = Node.isCaseClause(clause) ? truncate(clause.getExpression().getText()) : "default";
  const body = clause.getStatements().flatMap((statement) => walk(statement, context, depth + 1));
  return { label, body };
}

function tryStep(node: TryStatement, context: WalkContext, depth: number): FlowStep {
  const paths: FlowPath[] = [{ label: "try", body: walkBody(node.getTryBlock(), context, depth + 1) }];
  const catchClause = node.getCatchClause();
  if (catchClause) {
    paths.push({ label: catchLabel(catchClause), body: walkBody(catchClause.getBlock(), context, depth + 1) });
  }
  const finallyBlock = node.getFinallyBlock();
  if (finallyBlock) {
    paths.push({ label: "finally", body: walkBody(finallyBlock, context, depth + 1) });
  }
  return { kind: "branch", label: "try/catch", paths };
}

function catchLabel(clause: CatchClause): string {
  const variable = clause.getVariableDeclaration();
  return variable ? `catch ${variable.getName()}` : "catch";
}

// Descend first (arguments + callee sub-expressions run before the call), then emit this call —
// UNLESS this is an Array-iteration call with an inline callback, which becomes a loop instead.
function callSteps(node: CallExpression | NewExpression, context: WalkContext, depth: number): FlowStep[] {
  const iteration = Node.isCallExpression(node) ? iterationCall(node) : null;
  if (iteration) {
    return iterationSteps(node as CallExpression, iteration, context, depth);
  }
  const steps = descend(node, context, depth);
  const callee = node.getExpression();
  const label = calleeName(callee);
  if (!label) {
    return steps; // an unnameable callee (super(), import(), computed) — keep only its nested calls
  }
  const resolution = resolveTarget(callee, context.index);
  steps.push({ kind: "call", label, target: resolution.resolvedTarget, resolution: resolution.resolution });
  return steps;
}

// Synchronous Array-iteration methods whose callback runs once per element, in order — so an
// inline callback reads as a loop body. Deferred/event callbacks (.then/.catch/.finally,
// addEventListener/.on, setTimeout/setInterval) are deliberately ABSENT: they run later, not
// during this flow, so they stay ordinary `call` steps with an undescended callback.
const ITERATION_METHODS = new Set([
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

interface IterationCall {
  callee: PropertyAccessExpression;
  callback: ArrowFunction | FunctionExpression;
}

// An Array-iteration call with an INLINE callback — the shape we lift into a loop. A named
// callback (`items.forEach(handler)`) is not inline, so it falls through to a plain call.
function iterationCall(node: CallExpression): IterationCall | null {
  const callee = node.getExpression();
  if (!Node.isPropertyAccessExpression(callee) || !ITERATION_METHODS.has(callee.getName())) {
    return null;
  }
  const callback = node.getArguments().find(isInlineCallback);
  return callback ? { callee, callback } : null;
}

function isInlineCallback(node: Node): node is ArrowFunction | FunctionExpression {
  return Node.isArrowFunction(node) || Node.isFunctionExpression(node);
}

// The receiver and any non-callback args evaluate BEFORE the callback iterates, so emit their
// calls first, in execution order (e.g. getItems() in getItems().forEach(cb)); then the loop
// whose body is the callback walked inline — NOT stopped at the arrow's callable boundary, since
// this callback genuinely runs as part of THIS flow rather than being its own callable.
function iterationSteps(
  node: CallExpression,
  call: IterationCall,
  context: WalkContext,
  depth: number,
): FlowStep[] {
  const preludeNodes = [call.callee.getExpression(), ...node.getArguments().filter((arg) => arg !== call.callback)];
  const steps = preludeNodes.flatMap((child) => walk(child, context, depth + 1));
  const body = call.callback.getBody();
  steps.push({
    kind: "loop",
    label: iterationLabel(call.callee.getName(), call.callback),
    body: body ? walkBody(body, context, depth + 1) : [],
  });
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
