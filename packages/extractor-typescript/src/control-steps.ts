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
import { forLabel, forOfLabel, ifLabel, ifLabelFull, switchLabel, switchLabelFull, truncate, whileLabel } from "./flow-labels";
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
// Every path carries its structured `role` so readers never have to sniff the display label.
function ifStep(node: IfStatement, walker: FlowWalker, depth: number): FlowStep {
  const paths: FlowPath[] = [{ label: "then", role: "then", body: walker.walkBody(node.getThenStatement(), depth + 1) }];
  const elseStatement = node.getElseStatement();
  if (elseStatement) {
    paths.push({ label: "else", role: "else", body: walker.walkBody(elseStatement, depth + 1) });
  }
  const label = ifLabel(node);
  const full = ifLabelFull(node);
  // Only carry the untruncated form when it actually adds something (the label was clipped), so a
  // short `if` stays byte-for-byte identical to older artifacts.
  return { kind: "branch", branchKind: "if", label, paths, ...(full !== label ? { fullLabel: full } : {}) };
}

function switchStep(node: SwitchStatement, walker: FlowWalker, depth: number): FlowStep {
  const paths = node.getClauses().map((clause) => clausePath(clause, walker, depth));
  const label = switchLabel(node);
  const full = switchLabelFull(node);
  return { kind: "branch", branchKind: "switch", label, paths, ...(full !== label ? { fullLabel: full } : {}) };
}

function clausePath(clause: CaseOrDefaultClause, walker: FlowWalker, depth: number): FlowPath {
  const body = clause.getStatements().flatMap((statement) => walker.walk(statement, depth + 1));
  if (Node.isCaseClause(clause)) {
    return { label: truncate(clause.getExpression().getText()), role: "case", body };
  }
  return { label: "default", role: "default", body };
}

function tryStep(node: TryStatement, walker: FlowWalker, depth: number): FlowStep {
  const paths: FlowPath[] = [{ label: "try", role: "try", body: walker.walkBody(node.getTryBlock(), depth + 1) }];
  const catchClause = node.getCatchClause();
  if (catchClause) {
    paths.push({ label: catchLabel(catchClause), role: "catch", body: walker.walkBody(catchClause.getBlock(), depth + 1) });
  }
  const finallyBlock = node.getFinallyBlock();
  if (finallyBlock) {
    paths.push({ label: "finally", role: "finally", body: walker.walkBody(finallyBlock, depth + 1) });
  }
  return { kind: "branch", branchKind: "try", label: "try/catch", paths };
}

function catchLabel(clause: CatchClause): string {
  const variable = clause.getVariableDeclaration();
  return variable ? `catch ${variable.getName()}` : "catch";
}
