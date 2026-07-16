/** Small, fail-closed constant/discriminator recovery for boundary API models. */

import {
  Node,
  SyntaxKind,
  VariableDeclarationKind,
  type ArrowFunction,
  type FunctionDeclaration,
  type FunctionExpression,
  type IfStatement,
  type MethodDeclaration,
  type ObjectLiteralExpression,
  type ParameterDeclaration,
} from "ts-morph";

const MAX_VALUE_DEPTH = 8;
const MAX_VALUE_CANDIDATES = 32;
const MESSAGE_KEYS = ["type", "kind", "channel", "event", "eventType", "method", "methodName"] as const;

/** Arguments observed at every statically known call of one locally closed callable parameter. */
export type StaticArgumentResolver = (
  parameter: ParameterDeclaration,
) => readonly (Node | undefined)[] | null;

/** A statically proven string through transparent syntax and immutable local aliases. */
export function staticString(node: Node | undefined, depth = 0, seen: ReadonlySet<Node> = new Set()): string | null {
  if (!node || depth > MAX_VALUE_DEPTH || seen.has(node)) return null;
  const expression = unwrap(node);
  if (Node.isStringLiteral(expression) || Node.isNoSubstitutionTemplateLiteral(expression)) {
    return expression.getLiteralText();
  }
  if (Node.isTemplateExpression(expression)) {
    let value = expression.getHead().getLiteralText();
    const nextSeen = withNode(seen, expression);
    for (const span of expression.getTemplateSpans()) {
      const part = staticString(span.getExpression(), depth + 1, nextSeen);
      if (part === null) return null;
      value += part + span.getLiteral().getLiteralText();
    }
    return value;
  }
  if (Node.isBinaryExpression(expression) && expression.getOperatorToken().getKind() === SyntaxKind.PlusToken) {
    const nextSeen = withNode(seen, expression);
    const left = staticString(expression.getLeft(), depth + 1, nextSeen);
    const right = staticString(expression.getRight(), depth + 1, nextSeen);
    return left === null || right === null ? null : left + right;
  }
  if (Node.isIdentifier(expression)) {
    const nextSeen = withNode(seen, expression);
    for (const declaration of expression.getSymbol()?.getDeclarations() ?? []) {
      if (Node.isVariableDeclaration(declaration) && isImmutableVariable(declaration)) {
        const value = staticString(declaration.getInitializer(), depth + 1, nextSeen);
        if (value !== null) return value;
      }
      if (Node.isEnumMember(declaration)) {
        const value = staticString(declaration.getInitializer(), depth + 1, nextSeen);
        if (value !== null) return value;
      }
    }
  }
  if (Node.isPropertyAccessExpression(expression)) {
    for (const declaration of expression.getNameNode().getSymbol()?.getDeclarations() ?? []) {
      if ((Node.isPropertyAssignment(declaration) && isReadonlyObjectProperty(declaration))
        || Node.isEnumMember(declaration)) {
        const value = staticString(declaration.getInitializer(), depth + 1, withNode(seen, expression));
        if (value !== null) return value;
      }
    }
  }
  return null;
}

/** Stable discriminator in a structured postMessage payload (`{ type: "ready" }`, etc.). */
export function messagePayloadDiscriminator(node: Node | undefined): string | null {
  const candidates = messagePayloadDiscriminators(node);
  return candidates.length === 1 ? candidates[0] ?? null : null;
}

/**
 * Stable discriminators for a structured postMessage payload, including finite literal values
 * propagated through a locally closed wrapper parameter. If any invocation is dynamic the helper
 * fails closed to `[null]`: function-level graph ownership cannot represent a mixed specialization
 * without incorrectly attaching the known channel to the dynamic caller too.
 */
export function messagePayloadDiscriminators(
  node: Node | undefined,
  argumentResolver?: StaticArgumentResolver,
): Array<string | null> {
  const object = objectLiteralOf(node, 0, new Set());
  if (object) {
    for (const key of MESSAGE_KEYS) {
      const property = uniqueProperty(object, key);
      if (property && payloadPropertyIsStable(object, property, key, argumentResolver)
        && Node.isPropertyAssignment(property)) {
        const values = staticStringCandidates(property.getInitializer(), argumentResolver, 0, new Set());
        if (!values.unknown && values.values.size > 0) {
          return [...values.values].sort().map((value) => `${key}:${value}`);
        }
      }
      if (property && payloadPropertyIsStable(object, property, key, argumentResolver)
        && Node.isShorthandPropertyAssignment(property)) {
        const values = staticStringCandidates(property.getNameNode(), argumentResolver, 0, new Set());
        if (!values.unknown && values.values.size > 0) {
          return [...values.values].sort().map((value) => `${key}:${value}`);
        }
      }
    }
  }
  const scalar = staticStringCandidates(node, argumentResolver, 0, new Set());
  return !scalar.unknown && scalar.values.size > 0
    ? [...scalar.values].sort().map((value) => `data:${value}`)
    : [null];
}

interface StringCandidates {
  values: Set<string>;
  unknown: boolean;
}

function staticStringCandidates(
  node: Node | undefined,
  argumentResolver: StaticArgumentResolver | undefined,
  depth: number,
  seen: ReadonlySet<Node>,
): StringCandidates {
  if (!node || depth > MAX_VALUE_DEPTH || seen.has(node)) return unknownCandidates();
  const expression = unwrap(node);
  if (Node.isStringLiteral(expression) || Node.isNoSubstitutionTemplateLiteral(expression)) {
    return knownCandidate(expression.getLiteralText());
  }
  const nextSeen = withNode(seen, expression);
  if (Node.isTemplateExpression(expression)) {
    let result = knownCandidate(expression.getHead().getLiteralText());
    for (const span of expression.getTemplateSpans()) {
      result = concatenateCandidates(
        result,
        staticStringCandidates(span.getExpression(), argumentResolver, depth + 1, nextSeen),
      );
      result = appendLiteral(result, span.getLiteral().getLiteralText());
    }
    return result;
  }
  if (Node.isBinaryExpression(expression) && expression.getOperatorToken().getKind() === SyntaxKind.PlusToken) {
    return concatenateCandidates(
      staticStringCandidates(expression.getLeft(), argumentResolver, depth + 1, nextSeen),
      staticStringCandidates(expression.getRight(), argumentResolver, depth + 1, nextSeen),
    );
  }
  if (Node.isIdentifier(expression)) {
    const combined = emptyCandidates();
    let participated = false;
    const shorthand = expression.getParent();
    const symbol = shorthand && Node.isShorthandPropertyAssignment(shorthand)
      ? shorthand.getValueSymbol()
      : expression.getSymbol();
    for (const declaration of symbol?.getDeclarations() ?? []) {
      if (Node.isVariableDeclaration(declaration) && isImmutableVariable(declaration)) {
        participated = true;
        mergeCandidates(
          combined,
          staticStringCandidates(declaration.getInitializer(), argumentResolver, depth + 1, nextSeen),
        );
      } else if (Node.isEnumMember(declaration)) {
        participated = true;
        mergeCandidates(
          combined,
          staticStringCandidates(declaration.getInitializer(), argumentResolver, depth + 1, nextSeen),
        );
      } else if (Node.isParameterDeclaration(declaration) && argumentResolver) {
        participated = true;
        const argumentsAtCalls = argumentResolver(declaration);
        if (!argumentsAtCalls || argumentsAtCalls.length === 0) {
          combined.unknown = true;
          continue;
        }
        for (const argument of argumentsAtCalls) {
          const effective = argument ?? declaration.getInitializer();
          mergeCandidates(
            combined,
            staticStringCandidates(effective, argumentResolver, depth + 1, nextSeen),
          );
        }
      }
    }
    return participated ? combined : unknownCandidates();
  }
  if (Node.isPropertyAccessExpression(expression)) {
    const combined = emptyCandidates();
    let participated = false;
    for (const declaration of expression.getNameNode().getSymbol()?.getDeclarations() ?? []) {
      if ((Node.isPropertyAssignment(declaration) && isReadonlyObjectProperty(declaration))
        || Node.isEnumMember(declaration)) {
        participated = true;
        mergeCandidates(
          combined,
          staticStringCandidates(declaration.getInitializer(), argumentResolver, depth + 1, nextSeen),
        );
      }
    }
    return participated ? combined : unknownCandidates();
  }
  return unknownCandidates();
}

function emptyCandidates(): StringCandidates {
  return { values: new Set(), unknown: false };
}

function knownCandidate(value: string): StringCandidates {
  return { values: new Set([value]), unknown: false };
}

function unknownCandidates(): StringCandidates {
  return { values: new Set(), unknown: true };
}

function mergeCandidates(into: StringCandidates, from: StringCandidates): void {
  into.unknown ||= from.unknown;
  for (const value of from.values) {
    if (into.values.size >= MAX_VALUE_CANDIDATES) {
      into.unknown = true;
      return;
    }
    into.values.add(value);
  }
}

function concatenateCandidates(left: StringCandidates, right: StringCandidates): StringCandidates {
  const result = emptyCandidates();
  result.unknown = left.unknown || right.unknown;
  for (const leftValue of left.values) {
    for (const rightValue of right.values) {
      if (result.values.size >= MAX_VALUE_CANDIDATES) {
        result.unknown = true;
        return result;
      }
      result.values.add(leftValue + rightValue);
    }
  }
  return result;
}

function appendLiteral(candidates: StringCandidates, suffix: string): StringCandidates {
  return {
    values: new Set([...candidates.values].map((value) => value + suffix)),
    unknown: candidates.unknown,
  };
}

/** Later spreads can overwrite an earlier discriminator. Admit them only when every statically
 * known argument is an object that provably cannot define the selected key. */
function payloadPropertyIsStable(
  object: ObjectLiteralExpression,
  selected: Node,
  key: string,
  argumentResolver: StaticArgumentResolver | undefined,
): boolean {
  const properties = object.getProperties();
  const selectedIndex = properties.findIndex((property) => property === selected);
  if (selectedIndex < 0) return false;
  for (let index = selectedIndex + 1; index < properties.length; index += 1) {
    const property = properties[index];
    if (Node.isSpreadAssignment(property)) {
      if (!objectCannotDefineKey(property.getExpression(), key, argumentResolver, 0, new Set())) return false;
      continue;
    }
    const nameNode = property.getNameNode?.();
    if (nameNode && Node.isComputedPropertyName(nameNode)) return false;
    if (property.getName?.() === key) return false;
  }
  return true;
}

function objectCannotDefineKey(
  node: Node | undefined,
  key: string,
  argumentResolver: StaticArgumentResolver | undefined,
  depth: number,
  seen: ReadonlySet<Node>,
): boolean {
  // An omitted optional spread behaves like undefined and contributes no properties.
  if (!node) return true;
  if (depth > MAX_VALUE_DEPTH || seen.has(node)) return false;
  const expression = unwrap(node);
  if (Node.isNullLiteral(expression)
    || (Node.isIdentifier(expression) && expression.getText() === "undefined")) {
    return true;
  }
  const nextSeen = withNode(seen, expression);
  if (Node.isObjectLiteralExpression(expression)) {
    for (const property of expression.getProperties()) {
      if (Node.isSpreadAssignment(property)) {
        if (!objectCannotDefineKey(property.getExpression(), key, argumentResolver, depth + 1, nextSeen)) return false;
        continue;
      }
      const nameNode = property.getNameNode?.();
      if (nameNode && Node.isComputedPropertyName(nameNode)) return false;
      if (property.getName?.() === key) return false;
    }
    return true;
  }
  if (Node.isIdentifier(expression)) {
    let participated = false;
    for (const declaration of expression.getSymbol()?.getDeclarations() ?? []) {
      if (Node.isParameterDeclaration(declaration) && argumentResolver) {
        participated = true;
        const argumentsAtCalls = argumentResolver(declaration);
        if (!argumentsAtCalls || argumentsAtCalls.length === 0) return false;
        for (const argument of argumentsAtCalls) {
          if (!objectCannotDefineKey(
            argument ?? declaration.getInitializer(),
            key,
            argumentResolver,
            depth + 1,
            nextSeen,
          )) return false;
        }
      } else if (Node.isVariableDeclaration(declaration) && isReadonlyObjectAlias(declaration)) {
        participated = true;
        if (!objectCannotDefineKey(
          declaration.getInitializer(),
          key,
          argumentResolver,
          depth + 1,
          nextSeen,
        )) return false;
      }
    }
    return participated;
  }
  return false;
}

/** A statically proven string property on an object literal or immutable alias. */
export function staticObjectProperty(
  node: Node | undefined,
  propertyName: string,
): { objectKnown: boolean; propertyPresent: boolean; value: string | null } {
  const object = objectLiteralOf(node, 0, new Set());
  if (!object || !isClosedObjectLiteral(object)) {
    return { objectKnown: false, propertyPresent: false, value: null };
  }
  const property = uniqueProperty(object, propertyName);
  if (property && Node.isPropertyAssignment(property)) {
    return { objectKnown: true, propertyPresent: true, value: staticString(property.getInitializer()) };
  }
  if (property && Node.isShorthandPropertyAssignment(property)) {
    return { objectKnown: true, propertyPresent: true, value: staticString(property.getNameNode()) };
  }
  return { objectKnown: true, propertyPresent: object.getProperty(propertyName) !== undefined, value: null };
}

/** Every literal discriminator accepted by a `message` callback's event-data guards/switches. */
export function messageListenerDiscriminators(handler: Node | undefined): string[] {
  const callable = staticCallable(handler);
  if (!callable) return [];
  const firstParameter = callable.getParameters()[0];
  if (!firstParameter || !Node.isIdentifier(firstParameter.getNameNode())) return [];
  const eventParameter = firstParameter.getNameNode();
  const body = callable.getBody();
  if (!body) return [];

  const values = new Set<string>();
  for (const binary of body.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
    if (insideNestedCallable(binary, callable)) continue;
    const operator = binary.getOperatorToken().getKind();
    if (!comparisonSelectsHandledBranch(binary.getParent(), operator)) continue;
    addDiscriminator(values, eventParameter, binary.getLeft(), binary.getRight());
    addDiscriminator(values, eventParameter, binary.getRight(), binary.getLeft());
  }
  for (const statement of body.getDescendantsOfKind(SyntaxKind.SwitchStatement)) {
    if (insideNestedCallable(statement, callable)) continue;
    const key = messageDataKey(statement.getExpression(), eventParameter);
    if (key === null) continue;
    for (const clause of statement.getCaseBlock().getClauses()) {
      if (!Node.isCaseClause(clause)) continue;
      const value = staticString(clause.getExpression());
      if (value !== null) values.add(`${key}:${value}`);
    }
  }
  return [...values];
}

/** The statically named or inline callback registered at a boundary, when recoverable. */
export function staticCallable(handler: Node | undefined): FunctionLike | null {
  return functionLikeOf(handler, 0, new Set());
}

function addDiscriminator(into: Set<string>, eventParameter: Node, candidate: Node, literal: Node): void {
  const key = messageDataKey(candidate, eventParameter);
  if (key === null) return;
  const value = staticString(literal);
  if (value !== null) into.add(`${key}:${value}`);
}

function messageDataKey(node: Node, eventParameter: Node): string | null {
  const outer = unwrap(node);
  if (!Node.isPropertyAccessExpression(outer) || !MESSAGE_KEYS.includes(outer.getName() as typeof MESSAGE_KEYS[number])) {
    return null;
  }
  const data = unwrap(outer.getExpression());
  if (!Node.isPropertyAccessExpression(data) || data.getName() !== "data") return null;
  const root = unwrap(data.getExpression());
  return Node.isIdentifier(root) && sameDeclaration(root, eventParameter) ? outer.getName() : null;
}

/**
 * Only direct if-guards are interpreted. `if (type !== "x") return` selects x; an equality branch
 * selects x unless it is the common explicit-ignore shape `if (type === "x") return`.
 */
function comparisonSelectsHandledBranch(parent: Node | undefined, operator: SyntaxKind): boolean {
  if (!parent || !Node.isIfStatement(parent) || unwrap(parent.getExpression()).getKind() !== SyntaxKind.BinaryExpression) {
    return false;
  }
  const equality = operator === SyntaxKind.EqualsEqualsToken || operator === SyntaxKind.EqualsEqualsEqualsToken;
  const inequality = operator === SyntaxKind.ExclamationEqualsToken || operator === SyntaxKind.ExclamationEqualsEqualsToken;
  if (!equality && !inequality) return false;
  const ignoresMatchingBranch = isBareAbruptGuard(parent);
  return inequality ? ignoresMatchingBranch : !ignoresMatchingBranch && hasExecutableBranch(parent);
}

function isBareAbruptGuard(statement: IfStatement): boolean {
  const then = statement.getThenStatement();
  const statements = Node.isBlock(then) ? then.getStatements() : [then];
  if (statements.length !== 1) return false;
  const only = statements[0];
  return (Node.isReturnStatement(only) && only.getExpression() === undefined) || Node.isThrowStatement(only);
}

function hasExecutableBranch(statement: IfStatement): boolean {
  const then = statement.getThenStatement();
  return !Node.isBlock(then) || then.getStatements().length > 0;
}

function objectLiteralOf(
  node: Node | undefined,
  depth: number,
  seen: ReadonlySet<Node>,
): ObjectLiteralExpression | null {
  if (!node || depth > MAX_VALUE_DEPTH || seen.has(node)) return null;
  const expression = unwrap(node);
  if (Node.isObjectLiteralExpression(expression)) return expression;
  if (!Node.isIdentifier(expression)) return null;
  const nextSeen = withNode(seen, expression);
  for (const declaration of expression.getSymbol()?.getDeclarations() ?? []) {
    if (Node.isVariableDeclaration(declaration) && isReadonlyObjectAlias(declaration)) {
      const object = objectLiteralOf(declaration.getInitializer(), depth + 1, nextSeen);
      if (object) return object;
    }
  }
  return null;
}

type FunctionLike = ArrowFunction | FunctionExpression | FunctionDeclaration | MethodDeclaration;

function functionLikeOf(node: Node | undefined, depth: number, seen: ReadonlySet<Node>): FunctionLike | null {
  if (!node || depth > MAX_VALUE_DEPTH || seen.has(node)) return null;
  const expression = unwrap(node);
  if (Node.isArrowFunction(expression) || Node.isFunctionExpression(expression) || Node.isFunctionDeclaration(expression)
    || Node.isMethodDeclaration(expression)) {
    return expression;
  }
  if (!Node.isIdentifier(expression) && !Node.isPropertyAccessExpression(expression)) return null;
  const symbol = Node.isIdentifier(expression) ? expression.getSymbol() : expression.getNameNode().getSymbol();
  const nextSeen = withNode(seen, expression);
  for (const declaration of symbol?.getDeclarations() ?? []) {
    if (Node.isVariableDeclaration(declaration) && isImmutableVariable(declaration)) {
      const callable = functionLikeOf(declaration.getInitializer(), depth + 1, nextSeen);
      if (callable) return callable;
    }
    if (Node.isFunctionDeclaration(declaration) || Node.isMethodDeclaration(declaration)) {
      return declaration;
    }
  }
  return null;
}

function unwrap(node: Node): Node {
  let current = node;
  while (Node.isParenthesizedExpression(current) || Node.isNonNullExpression(current)
    || Node.isAsExpression(current) || Node.isSatisfiesExpression(current) || Node.isTypeAssertion(current)) {
    current = current.getExpression();
  }
  return current;
}

function withNode(seen: ReadonlySet<Node>, node: Node): Set<Node> {
  const next = new Set(seen);
  next.add(node);
  return next;
}

function isImmutableVariable(declaration: Node): boolean {
  return Node.isVariableDeclaration(declaration)
    && declaration.getVariableStatement()?.getDeclarationKind() === VariableDeclarationKind.Const;
}

function isReadonlyObjectProperty(property: Node): boolean {
  const object = property.getFirstAncestorByKind(SyntaxKind.ObjectLiteralExpression);
  if (!object) return false;
  const declaration = object.getFirstAncestorByKind(SyntaxKind.VariableDeclaration);
  return declaration !== undefined && isReadonlyObjectAlias(declaration);
}

/** A const binding does not make its object immutable. Only an explicit const assertion is treated
 * as a statically stable object alias; ordinary aliased object literals fail closed. */
function isReadonlyObjectAlias(declaration: Node): boolean {
  return Node.isVariableDeclaration(declaration)
    && isImmutableVariable(declaration)
    && hasConstAssertion(declaration.getInitializer());
}

function hasConstAssertion(node: Node | undefined): boolean {
  if (!node) return false;
  if (Node.isAsExpression(node) || Node.isTypeAssertion(node)) {
    return node.getTypeNode()?.getText() === "const" || hasConstAssertion(node.getExpression());
  }
  if (Node.isParenthesizedExpression(node) || Node.isNonNullExpression(node) || Node.isSatisfiesExpression(node)) {
    return hasConstAssertion(node.getExpression());
  }
  return false;
}

/** Spreads/computed or duplicate keys make both selector and Fetch-option recovery ambiguous. */
function isClosedObjectLiteral(object: ObjectLiteralExpression): boolean {
  const names = new Set<string>();
  for (const property of object.getProperties()) {
    if (Node.isSpreadAssignment(property) || Node.isComputedPropertyName(property.getNameNode?.())) return false;
    const name = property.getName?.();
    if (name !== undefined) {
      if (names.has(name)) return false;
      names.add(name);
    }
  }
  return true;
}

function uniqueProperty(object: ObjectLiteralExpression, name: string): Node | null {
  const matches = object.getProperties().filter((property) => {
    if (!Node.isPropertyAssignment(property) && !Node.isShorthandPropertyAssignment(property)) return false;
    return property.getName() === name;
  });
  return matches.length === 1 ? matches[0] : null;
}

function sameDeclaration(left: Node, right: Node): boolean {
  const leftDeclarations = new Set((Node.isIdentifier(left) ? left.getSymbol()?.getDeclarations() : []) ?? []);
  const rightDeclarations = (Node.isIdentifier(right) ? right.getSymbol()?.getDeclarations() : []) ?? [];
  return rightDeclarations.some((declaration) => leftDeclarations.has(declaration));
}

function insideNestedCallable(node: Node, root: FunctionLike): boolean {
  let current = node.getParent();
  while (current && current !== root) {
    if (Node.isArrowFunction(current) || Node.isFunctionExpression(current) || Node.isFunctionDeclaration(current)
      || Node.isMethodDeclaration(current)) {
      return true;
    }
    current = current.getParent();
  }
  return false;
}
