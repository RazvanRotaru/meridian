/**
 * The logic-flow pass: for each callable descriptor, walk its body AST into an ordered
 * `FlowStep[]`. Only method calls and control structures survive; everything else collapses
 * to nothing (but is still descended into, to find the calls buried in it). Calls are emitted
 * in EXECUTION order — arguments before the call — so `f(g(x))` yields `g` then `f`. Nested
 * function/arrow/class bodies are NOT descended: they are their own callables.
 */

import { Node } from "ts-morph";
import type {
  CallExpression,
  CaseOrDefaultClause,
  CatchClause,
  IfStatement,
  IterationStatement,
  NewExpression,
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
 * One flow per callable descriptor whose id survives depth-collapse. An empty flow (no calls,
 * no control structures) is omitted — an absent entry means "nothing worth charting".
 */
export function buildLogicFlows(
  descriptors: NodeDescriptor[],
  index: ResolutionIndex,
  keepIds: ReadonlySet<string>,
): LogicFlows {
  const flows: LogicFlows = {};
  const context: WalkContext = { index };
  for (const descriptor of descriptors) {
    if (!descriptor.callableNode || !keepIds.has(descriptor.finalId)) {
      continue;
    }
    const steps = flowOf(descriptor.callableNode, context);
    if (steps.length > 0) {
      flows[descriptor.finalId] = steps;
    }
  }
  return flows;
}

function flowOf(callableNode: Node, context: WalkContext): FlowStep[] {
  const body = bodyOf(callableNode);
  return body ? walkBody(body, context, 0) : [];
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

// Descend first (arguments + callee sub-expressions run before the call), then emit this call.
function callSteps(node: CallExpression | NewExpression, context: WalkContext, depth: number): FlowStep[] {
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
