/**
 * Conservative recovery for a member call immediately dominated by a direct construction write.
 * This is intentionally local and linear: the preceding statement must be
 * `storage = new ExactType(...)`, the next statement must be exactly `await? storage.member(...)`,
 * and both storage references must identify the same base object and member declaration.
 */

import {
  Node,
  SyntaxKind,
  type Symbol as TsSymbol,
} from "ts-morph";
import { nodeKey } from "./model";

export interface ConstructedReceiverMemberTrace {
  storageDeclaration: Node;
  construction: Node;
  typeSymbol: TsSymbol | undefined;
  memberSymbol: TsSymbol | undefined;
  memberDeclarations: readonly Node[];
  /** Present only when the constructed receiver proves one body-bearing implementation. */
  consensus: {
    symbol: TsSymbol;
    declaration: Node;
  } | null;
}

/**
 * Inspect the exact fallback proof. A trace is returned even when the constructed type has no
 * usable member so semantic-cache observation records the compiler decision that could later add it.
 */
export function traceConstructedReceiverMember(
  callee: Node,
): ConstructedReceiverMemberTrace | null {
  if (!Node.isPropertyAccessExpression(callee) || callee.getNameNode().getSymbol() !== undefined) {
    return null;
  }
  const call = callee.getParent();
  if (!call || !Node.isCallExpression(call) || call.getExpression() !== callee) {
    return null;
  }
  const callStatement = call.getFirstAncestorByKind(SyntaxKind.ExpressionStatement);
  if (!callStatement) return null;
  if (unwrapCallStatementExpression(callStatement.getExpression()) !== call) return null;
  const block = callStatement.getParent();
  if (!Node.isBlock(block)) return null;
  const statements = block.getStatements();
  const callIndex = statements.findIndex((statement) => statement === callStatement);
  if (callIndex <= 0) return null;
  const previous = statements[callIndex - 1];
  if (!previous || !Node.isExpressionStatement(previous)) return null;
  const assignment = previous.getExpression();
  if (!Node.isBinaryExpression(assignment)
    || assignment.getOperatorToken().getKind() !== SyntaxKind.EqualsToken) {
    return null;
  }

  const receiver = callee.getExpression();
  const assigned = assignment.getLeft();
  if (!sameStorageReference(receiver, assigned)) return null;
  const receiverDeclarations = storageDeclarations(receiver);
  if (receiverDeclarations.length !== 1) return null;

  const construction = unwrapTransparent(assignment.getRight());
  if (!Node.isNewExpression(construction)) return null;
  const type = construction.getType();
  const typeSymbol = type.getAliasSymbol() ?? type.getSymbol();
  const memberSymbol = aliasedSymbol(type.getProperty(callee.getName()));
  const memberDeclarations = uniqueBodyDeclarations(memberSymbol);
  const declaration = memberDeclarations.length === 1 ? memberDeclarations[0]! : undefined;
  return {
    storageDeclaration: receiverDeclarations[0]!,
    construction,
    typeSymbol,
    memberSymbol,
    memberDeclarations,
    consensus: declaration && memberSymbol ? { symbol: memberSymbol, declaration } : null,
  };
}

/** Only the direct call, optionally awaited or wrapped by type-transparent syntax, may execute. */
function unwrapCallStatementExpression(node: Node): Node {
  let current = node;
  let sawAwait = false;
  while (true) {
    if (Node.isAwaitExpression(current) && !sawAwait) {
      sawAwait = true;
      current = current.getExpression();
      continue;
    }
    const transparent = unwrapOneTransparent(current);
    if (transparent !== current) {
      current = transparent;
      continue;
    }
    return current;
  }
}

/**
 * Match the storage identity, including the receiver object. TypeScript gives every instance
 * property access the same property declaration, so comparing only that declaration would confuse
 * `a.framework` with `b.framework`. Calls/getters/computed bases are deliberately unsupported.
 */
function sameStorageReference(left: Node, right: Node): boolean {
  const a = unwrapTransparent(left);
  const b = unwrapTransparent(right);
  if (Node.isIdentifier(a) && Node.isIdentifier(b)) {
    return sameSingleStorageDeclaration(a, b);
  }
  if (Node.isThisExpression(a) && Node.isThisExpression(b)) {
    return true;
  }
  if (!Node.isPropertyAccessExpression(a) || !Node.isPropertyAccessExpression(b)) {
    return false;
  }
  return sameSingleStorageDeclaration(a, b)
    && sameStorageReference(a.getExpression(), b.getExpression());
}

function sameSingleStorageDeclaration(left: Node, right: Node): boolean {
  const leftDeclarations = storageDeclarations(left);
  const rightDeclarations = storageDeclarations(right);
  return leftDeclarations.length === 1
    && rightDeclarations.length === 1
    && nodeKey(leftDeclarations[0]!) === nodeKey(rightDeclarations[0]!);
}

function storageDeclarations(node: Node): Node[] {
  const symbol = Node.isPropertyAccessExpression(node)
    ? node.getNameNode().getSymbol()
    : Node.isIdentifier(node)
      ? node.getSymbol()
      : undefined;
  return (symbol?.getDeclarations() ?? []).filter((declaration) =>
    Node.isVariableDeclaration(declaration)
    || Node.isParameterDeclaration(declaration)
    || Node.isPropertyDeclaration(declaration),
  );
}

function unwrapTransparent(node: Node): Node {
  let current = node;
  while (true) {
    const next = unwrapOneTransparent(current);
    if (next === current) return current;
    current = next;
  }
}

function unwrapOneTransparent(node: Node): Node {
  if (
    Node.isParenthesizedExpression(node)
    || Node.isNonNullExpression(node)
    || Node.isAsExpression(node)
    || Node.isSatisfiesExpression(node)
    || Node.isTypeAssertion(node)
  ) {
    return node.getExpression();
  }
  return node;
}

function aliasedSymbol(symbol: TsSymbol | undefined): TsSymbol | undefined {
  return symbol?.getAliasedSymbol() ?? symbol;
}

function uniqueBodyDeclarations(symbol: TsSymbol | undefined): Node[] {
  const unique = new Map<string, Node>();
  for (const declaration of symbol?.getDeclarations() ?? []) {
    if ((declaration as { getBody?(): Node | undefined }).getBody?.() !== undefined) {
      unique.set(nodeKey(declaration), declaration);
    }
  }
  return [...unique.values()];
}
