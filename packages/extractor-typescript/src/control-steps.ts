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
  return { kind: "loop", label: loopLabel(node), body: walker.walkBody(node.getStatement(), depth + 1) };
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
function ifStep(node: IfStatement, walker: FlowWalker, depth: number): FlowStep {
  const paths: FlowPath[] = [{ label: "then", body: walker.walkBody(node.getThenStatement(), depth + 1) }];
  const elseStatement = node.getElseStatement();
  if (elseStatement) {
    paths.push({ label: "else", body: walker.walkBody(elseStatement, depth + 1) });
  }
  return { kind: "branch", label: ifLabel(node), paths };
}

function switchStep(node: SwitchStatement, walker: FlowWalker, depth: number): FlowStep {
  const paths = node.getClauses().map((clause) => clausePath(clause, walker, depth));
  return { kind: "branch", label: switchLabel(node), paths };
}

function clausePath(clause: CaseOrDefaultClause, walker: FlowWalker, depth: number): FlowPath {
  const label = Node.isCaseClause(clause) ? truncate(clause.getExpression().getText()) : "default";
  const body = clause.getStatements().flatMap((statement) => walker.walk(statement, depth + 1));
  return { label, body };
}

function tryStep(node: TryStatement, walker: FlowWalker, depth: number): FlowStep {
  const paths: FlowPath[] = [{ label: "try", body: walker.walkBody(node.getTryBlock(), depth + 1) }];
  const catchClause = node.getCatchClause();
  if (catchClause) {
    paths.push({ label: catchLabel(catchClause), body: walker.walkBody(catchClause.getBlock(), depth + 1) });
  }
  const finallyBlock = node.getFinallyBlock();
  if (finallyBlock) {
    paths.push({ label: "finally", body: walker.walkBody(finallyBlock, depth + 1) });
  }
  return { kind: "branch", label: "try/catch", paths };
}

function catchLabel(clause: CatchClause): string {
  const variable = clause.getVariableDeclaration();
  return variable ? `catch ${variable.getName()}` : "catch";
}
