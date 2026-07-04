/**
 * Short, human-readable labels for logic-flow steps. Every label collapses source text to a
 * glanceable form — a callee name without arguments, a `for each <binding>`, a truncated
 * condition — so the flow tree reads like pseudo-code rather than echoing the source.
 */

import { Node, SyntaxKind } from "ts-morph";
import type {
  ArrowFunction,
  DoStatement,
  ForInStatement,
  ForOfStatement,
  ForStatement,
  FunctionExpression,
  IfStatement,
  SwitchStatement,
  WhileStatement,
} from "ts-morph";

const MAX_COND = 40;

/** The callee's name only — `fetchScore`, `Foo.bar` — or null when it has no nameable form. */
export function calleeName(callee: Node): string | null {
  if (Node.isIdentifier(callee)) {
    return callee.getText();
  }
  if (Node.isPropertyAccessExpression(callee)) {
    return propertyAccessName(callee.getExpression(), callee.getName());
  }
  return null;
}

/** Keep a member call short: `<receiver>.<name>` only when the receiver is a bare identifier/this. */
function propertyAccessName(receiver: Node, name: string): string {
  if (Node.isIdentifier(receiver) || receiver.getKind() === SyntaxKind.ThisKeyword) {
    return `${receiver.getText()}.${name}`;
  }
  return name;
}

export function forOfLabel(node: ForOfStatement | ForInStatement): string {
  return `for each ${truncate(bindingText(node))}`;
}

/**
 * Label for an Array-iteration loop (`items.forEach(x => …)`). `forEach` reads like a `for..of`
 * over the element (`for each x`); the transforming methods keep their name so the shape is
 * legible (`map x`, `filter row`). With no callback parameter, just the method name.
 */
export function iterationLabel(methodName: string, callback: ArrowFunction | FunctionExpression): string {
  const param = firstParamName(callback);
  if (!param) {
    return methodName;
  }
  return methodName === "forEach" ? `for each ${param}` : `${methodName} ${param}`;
}

function firstParamName(callback: ArrowFunction | FunctionExpression): string | null {
  const first = callback.getParameters()[0];
  return first ? truncate(first.getName()) : null;
}

function bindingText(node: ForOfStatement | ForInStatement): string {
  const initializer = node.getInitializer();
  if (Node.isVariableDeclarationList(initializer)) {
    return initializer.getDeclarations()[0]?.getName() ?? initializer.getText();
  }
  return initializer.getText();
}

export function whileLabel(node: WhileStatement | DoStatement): string {
  return `while ${truncate(node.getExpression().getText())}`;
}

export function forLabel(node: ForStatement): string {
  const initializer = node.getInitializer();
  return initializer ? `for ${truncate(initializer.getText())}` : "loop";
}

export function ifLabel(node: IfStatement): string {
  return `if ${truncate(node.getExpression().getText())}`;
}

export function switchLabel(node: SwitchStatement): string {
  return `switch ${truncate(node.getExpression().getText())}`;
}

export function truncate(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > MAX_COND ? `${flat.slice(0, MAX_COND - 1)}…` : flat;
}
