/**
 * Control-structure step builders for the flow pass: loops, if/else (as nested branch steps),
 * switch, and try/catch/finally. Each walks its bodies back through the `FlowWalker`.
 */

import { Node } from "ts-morph";
import type {
  CaseOrDefaultClause,
  CatchClause,
  IfStatement,
  IterationStatement,
  SwitchStatement,
  TryStatement,
} from "ts-morph";
import type { FlowPath, FlowStep } from "@meridian/core";
import { forLabel, forOfLabel, ifLabel, switchLabel, truncate, whileLabel } from "./flow-labels";
import { flowSource } from "./flow-source";
import type { FlowWalker } from "./flow-walker";

export function controlStep(node: Node, walker: FlowWalker, depth: number): FlowStep | null {
  if (Node.isIterationStatement(node)) {
    return loopStep(node, walker, depth);
  }
  if (Node.isIfStatement(node)) {
    return ifStep(node, walker, depth);
  }
  if (Node.isSwitchStatement(node)) {
    return switchStep(node, walker, depth);
  }
  if (Node.isTryStatement(node)) {
    return tryStep(node, walker, depth);
  }
  return null;
}

function loopStep(node: IterationStatement, walker: FlowWalker, depth: number): FlowStep {
  return { kind: "loop", label: loopLabel(node), body: walker.walkBody(node.getStatement(), depth + 1), source: flowSource(node) };
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
// Every path carries its structured `role` so readers never have to sniff the display label.
function ifStep(node: IfStatement, walker: FlowWalker, depth: number): FlowStep {
  const thenStatement = node.getThenStatement();
  const paths: FlowPath[] = [{
    label: "then",
    role: "then",
    pathId: "then",
    source: flowSource(thenStatement),
    body: walker.walkBody(thenStatement, depth + 1),
  }];
  const elseStatement = node.getElseStatement();
  if (elseStatement) {
    paths.push({ label: "else", role: "else", pathId: "else", source: flowSource(elseStatement), body: walker.walkBody(elseStatement, depth + 1) });
  }
  return { kind: "branch", branchKind: "if", label: ifLabel(node), paths, source: flowSource(node) };
}

function switchStep(node: SwitchStatement, walker: FlowWalker, depth: number): FlowStep {
  const paths = node.getClauses().map((clause) => clausePath(clause, walker, depth));
  return { kind: "branch", branchKind: "switch", label: switchLabel(node), paths, source: flowSource(node) };
}

function clausePath(clause: CaseOrDefaultClause, walker: FlowWalker, depth: number): FlowPath {
  const body = clause.getStatements().flatMap((statement) => walker.walk(statement, depth + 1));
  if (Node.isCaseClause(clause)) {
    const label = truncate(clause.getExpression().getText());
    return { label, role: "case", pathId: label, source: flowSource(clause), body };
  }
  return { label: "default", role: "default", pathId: "default", source: flowSource(clause), body };
}

function tryStep(node: TryStatement, walker: FlowWalker, depth: number): FlowStep {
  const tryBlock = node.getTryBlock();
  const paths: FlowPath[] = [{ label: "try", role: "try", pathId: "try", source: flowSource(tryBlock), body: walker.walkBody(tryBlock, depth + 1) }];
  const catchClause = node.getCatchClause();
  if (catchClause) {
    paths.push({ label: catchLabel(catchClause), role: "catch", pathId: "catch", source: flowSource(catchClause), body: walker.walkBody(catchClause.getBlock(), depth + 1) });
  }
  const finallyBlock = node.getFinallyBlock();
  if (finallyBlock) {
    paths.push({ label: "finally", role: "finally", pathId: "finally", source: flowSource(finallyBlock), body: walker.walkBody(finallyBlock, depth + 1) });
  }
  return { kind: "branch", branchKind: "try", label: "try/catch", paths, source: flowSource(node) };
}

function catchLabel(clause: CatchClause): string {
  const variable = clause.getVariableDeclaration();
  return variable ? `catch ${variable.getName()}` : "catch";
}
