/**
 * Correlate a local pub/sub facade with the Window `message` listener it wraps.
 *
 * This is deliberately structural rather than name based. A candidate must prove all of:
 *   - one locally closed factory owns a modeled message listener;
 *   - that listener routes `event.data.<key>` through a local keyed collection;
 *   - the factory returns callables whose channel parameter indexes the same collection (or
 *     delegates to one that does), and whose second parameter is callable;
 *   - a const receiver is initialized directly from that exact factory; and
 *   - the subscription call supplies a static string discriminator.
 *
 * That is enough to specialize `events.on("ready", handler)` as the inbound half of the same
 * `type:ready` postMessage channel without knowing anything about the application's framework.
 */

import {
  Node,
  SyntaxKind,
  VariableDeclarationKind,
  type ArrowFunction,
  type CallExpression,
  type FunctionDeclaration,
  type FunctionExpression,
  type MethodDeclaration,
  type ObjectLiteralExpression,
  type ParameterDeclaration,
  type VariableDeclaration,
} from "ts-morph";
import type { Port } from "@meridian/core";
import { callSiteOf, nodeKey, type NodeDescriptor } from "./model";
import type { LoadedProject } from "./project-loader";
import type { ResolutionIndex } from "./resolution-index";
import { resolveTarget } from "./edge-resolve";
import { staticCallable, staticString } from "./port-static-values";
import type { PortSurfaceDefinition } from "./port-surfaces";

const DISCRIMINATOR_KEYS = new Set([
  "type",
  "kind",
  "channel",
  "event",
  "eventType",
  "method",
  "methodName",
]);
const MAX_ALIAS_DEPTH = 8;
const LABEL_CAP = 80;

type FunctionLike = ArrowFunction | FunctionExpression | FunctionDeclaration | MethodDeclaration;

export interface MessageListenerBoundary {
  call: CallExpression;
  surface: PortSurfaceDefinition;
  relPath: string;
}

interface ListenerRouting {
  collectionDeclarationKey: string;
  discriminatorKey: string;
}

interface ReturnedMethod {
  member: string;
  callable: FunctionLike;
  channelParameter: ParameterDeclaration;
  handlerParameter: ParameterDeclaration;
}

interface DispatcherFactory {
  factory: FunctionLike;
  factoryId: string;
  surface: PortSurfaceDefinition;
  discriminatorKey: string;
  methods: ReadonlyMap<string, ReturnedMethod>;
}

export function collectMessageDispatcherPorts(
  loaded: LoadedProject,
  index: ResolutionIndex,
  moduleByFilePath: Map<string, NodeDescriptor>,
  boundaries: readonly MessageListenerBoundary[],
): Port[] {
  const factories = dispatcherFactories(boundaries, index);
  if (factories.size === 0) return [];

  const ports: Port[] = [];
  for (const sourceFile of loaded.sourceFiles) {
    const relPath = loaded.relativePathOf(sourceFile);
    for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const callee = unwrap(call.getExpression());
      if (!Node.isPropertyAccessExpression(callee)) continue;
      const factory = factoryForReceiver(callee.getExpression(), factories, index);
      if (!factory) continue;
      const method = factory.methods.get(callee.getName());
      if (!method) continue;

      const arguments_ = call.getArguments();
      const discriminator = staticString(arguments_[0]);
      if (discriminator === null || arguments_[1] === undefined) continue;

      const owner = owningNodeId(call, index, moduleByFilePath);
      const handlerNodeId = subscriptionHandlerNodeId(arguments_[1], owner, index);

      ports.push({
        nodeId: owner,
        handlerNodeId,
        direction: "in",
        protocol: factory.surface.protocol,
        channel: `${factory.discriminatorKey}:${discriminator}`,
        label: (arguments_[0]?.getText() ?? call.getText()).slice(0, LABEL_CAP),
        callSite: callSiteOf(call, relPath),
        surfaceId: `${factory.surface.id}.dispatcher`,
        operation: factory.surface.operation,
        lane: factory.surface.lane,
        confidence: factory.surface.confidence,
      });
    }
  }
  return ports;
}

/**
 * Prefer the callback itself when emitted. Anonymous callbacks intentionally share their enclosing
 * graph owner, so refine that fallback only when the callback directly invokes exactly one emitted
 * callable declared inside its own lexical body. External/outer calls cannot qualify, and calls
 * under conditional control are ignored rather than guessing which branch handles delivery.
 */
function subscriptionHandlerNodeId(
  handlerArgument: Node,
  owner: string,
  index: ResolutionIndex,
): string {
  const handler = staticCallable(handlerArgument);
  if (!handler) return owner;
  const direct = index.sourceByCallableKey.get(nodeKey(handler))
    ?? index.targetByDeclKey.get(nodeKey(handler));
  if (direct) return direct;

  const body = handler.getBody();
  if (!body) return owner;
  const nestedIds = new Set(body.getDescendants()
    .filter(isFunctionLike)
    .map((callable) => index.sourceByCallableKey.get(nodeKey(callable))
      ?? index.targetByDeclKey.get(nodeKey(callable)))
    .filter((id): id is string => id !== undefined));
  if (nestedIds.size === 0) return owner;

  const invoked = new Set<string>();
  for (const call of directCalls(handler)) {
    if (insideConditionalControl(call, handler)) continue;
    const target = resolveTarget(call.getExpression(), index);
    if (target.resolution === "resolved" && target.resolvedTarget !== null
      && nestedIds.has(target.resolvedTarget)) {
      invoked.add(target.resolvedTarget);
    }
  }
  return invoked.size === 1 ? [...invoked][0] : owner;
}

function insideConditionalControl(node: Node, callable: FunctionLike): boolean {
  let current = node.getParent();
  while (current && current !== callable) {
    if (Node.isIfStatement(current)
      || Node.isSwitchStatement(current)
      || Node.isConditionalExpression(current)) return true;
    current = current.getParent();
  }
  return false;
}

function dispatcherFactories(
  boundaries: readonly MessageListenerBoundary[],
  index: ResolutionIndex,
): ReadonlyMap<string, DispatcherFactory> {
  const grouped = new Map<string, { factory: FunctionLike; boundaries: MessageListenerBoundary[] }>();
  for (const boundary of boundaries) {
    const factory = enclosingCallable(boundary.call);
    if (!factory || !isLocallyClosedFactory(factory)) continue;
    const key = nodeKey(factory);
    const group = grouped.get(key) ?? { factory, boundaries: [] };
    group.boundaries.push(boundary);
    grouped.set(key, group);
  }

  const byFactoryId = new Map<string, DispatcherFactory>();
  for (const { factory, boundaries: factoryBoundaries } of grouped.values()) {
    // Multiple physical listeners make the returned facade's transport ambiguous.
    if (factoryBoundaries.length !== 1) continue;
    const boundary = factoryBoundaries[0];
    const routing = listenerRouting(boundary, factory);
    if (!routing) continue;
    const returned = returnedMethods(factory);
    if (returned.length === 0) continue;
    const methods = correlatedMethods(returned, routing);
    if (methods.size === 0) continue;
    const factoryId = index.sourceByCallableKey.get(nodeKey(factory))
      ?? index.targetByDeclKey.get(nodeKey(factory));
    if (!factoryId || byFactoryId.has(factoryId)) continue;
    byFactoryId.set(factoryId, {
      factory,
      factoryId,
      surface: boundary.surface,
      discriminatorKey: routing.discriminatorKey,
      methods,
    });
  }
  return byFactoryId;
}

function listenerRouting(boundary: MessageListenerBoundary, factory: FunctionLike): ListenerRouting | null {
  if (boundary.surface.channel.kind !== "web-message-listener") return null;
  const handlerArgument = boundary.surface.channel.handlerArgument;
  const listener = staticCallable(boundary.call.getArguments()[handlerArgument]);
  if (!listener || !isWithin(listener, factory)) return null;
  const eventParameter = listener.getParameters()[0];
  if (!eventParameter || !Node.isIdentifier(eventParameter.getNameNode())) return null;

  const routes = new Map<string, ListenerRouting>();
  for (const call of directCalls(listener)) {
    const callee = unwrap(call.getExpression());
    if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== "get") continue;
    const discriminatorKey = eventDiscriminatorKey(call.getArguments()[0], eventParameter, 0, new Set());
    if (!discriminatorKey) continue;
    const collectionDeclarationKey = stableLocalDeclarationKey(callee.getExpression(), factory);
    if (!collectionDeclarationKey) continue;
    const route = { collectionDeclarationKey, discriminatorKey };
    routes.set(`${collectionDeclarationKey}|${discriminatorKey}`, route);
  }
  return routes.size === 1 ? [...routes.values()][0] : null;
}

function returnedMethods(factory: FunctionLike): ReturnedMethod[] {
  const object = returnedObject(factory);
  if (!object) return [];
  const methods = new Map<string, ReturnedMethod>();
  const ambiguous = new Set<string>();
  for (const property of object.getProperties()) {
    if (!Node.isMethodDeclaration(property)
      && !Node.isShorthandPropertyAssignment(property)
      && !Node.isPropertyAssignment(property)) continue;
    const nameNode = property.getNameNode();
    if (!nameNode || Node.isComputedPropertyName(nameNode)) continue;
    const member = property.getName();
    if (!member) continue;
    let callable: FunctionLike | null = null;
    if (Node.isMethodDeclaration(property)) callable = property;
    else if (Node.isShorthandPropertyAssignment(property)) callable = shorthandCallable(property);
    else if (Node.isPropertyAssignment(property)) callable = staticCallable(property.getInitializer());
    if (!callable || !isWithin(callable, factory)) continue;
    const parameters = subscriptionParameters(callable);
    if (!parameters) continue;
    if (methods.has(member)) {
      ambiguous.add(member);
      continue;
    }
    methods.set(member, { member, callable, ...parameters });
  }
  for (const member of ambiguous) methods.delete(member);
  return [...methods.values()];
}

function shorthandCallable(property: import("ts-morph").ShorthandPropertyAssignment): FunctionLike | null {
  for (const declaration of property.getValueSymbol()?.getDeclarations() ?? []) {
    if (Node.isVariableDeclaration(declaration) && isConstVariable(declaration)) {
      const callable = staticCallable(declaration.getInitializer());
      if (callable) return callable;
    }
    if (Node.isFunctionDeclaration(declaration) || Node.isMethodDeclaration(declaration)) return declaration;
  }
  return null;
}

function subscriptionParameters(
  callable: FunctionLike,
): Pick<ReturnedMethod, "channelParameter" | "handlerParameter"> | null {
  const [channelParameter, handlerParameter] = callable.getParameters();
  if (!channelParameter || !handlerParameter) return null;
  if (!Node.isIdentifier(channelParameter.getNameNode()) || !Node.isIdentifier(handlerParameter.getNameNode())) return null;
  if (channelParameter.isOptional() || handlerParameter.isOptional()
    || channelParameter.isRestParameter() || handlerParameter.isRestParameter()) return null;
  const handlerType = handlerParameter.getType();
  if (handlerType.isAny() || handlerType.isUnknown() || handlerType.getCallSignatures().length === 0) return null;
  if (!parameterIsReferenced(handlerParameter, callable)) return null;
  return { channelParameter, handlerParameter };
}

function correlatedMethods(
  methods: readonly ReturnedMethod[],
  routing: ListenerRouting,
): ReadonlyMap<string, ReturnedMethod> {
  const acceptedCallableKeys = new Set<string>();
  for (const method of methods) {
    if (indexesRoutingCollection(method, routing.collectionDeclarationKey)) {
      acceptedCallableKeys.add(nodeKey(method.callable));
    }
  }

  // Facades commonly implement `once` by delegating to their proven `on` method.
  let changed = true;
  while (changed) {
    changed = false;
    for (const method of methods) {
      const key = nodeKey(method.callable);
      if (acceptedCallableKeys.has(key)) continue;
      if (delegatesToAcceptedMethod(method, acceptedCallableKeys)) {
        acceptedCallableKeys.add(key);
        changed = true;
      }
    }
  }

  return new Map(methods
    .filter((method) => acceptedCallableKeys.has(nodeKey(method.callable)))
    .map((method) => [method.member, method]));
}

function indexesRoutingCollection(method: ReturnedMethod, collectionDeclarationKey: string): boolean {
  for (const call of directCalls(method.callable)) {
    const callee = unwrap(call.getExpression());
    if (!Node.isPropertyAccessExpression(callee) || (callee.getName() !== "get" && callee.getName() !== "set")) continue;
    if (stableDeclarationKey(callee.getExpression()) !== collectionDeclarationKey) continue;
    if (referencesParameter(call.getArguments()[0], method.channelParameter)) return true;
  }
  return false;
}

function delegatesToAcceptedMethod(method: ReturnedMethod, acceptedCallableKeys: ReadonlySet<string>): boolean {
  for (const call of directCalls(method.callable)) {
    const target = staticCallable(call.getExpression());
    if (!target || !acceptedCallableKeys.has(nodeKey(target))) continue;
    if (!referencesParameter(call.getArguments()[0], method.channelParameter)) continue;
    if (call.getArguments()[1] === undefined) continue;
    return true;
  }
  return false;
}

function factoryForReceiver(
  receiver: Node,
  factories: ReadonlyMap<string, DispatcherFactory>,
  index: ResolutionIndex,
): DispatcherFactory | null {
  const expression = unwrap(receiver);
  if (!Node.isIdentifier(expression)) return null;
  const declarations = (expression.getSymbol()?.getDeclarations() ?? [])
    .filter((declaration): declaration is VariableDeclaration =>
      Node.isVariableDeclaration(declaration) && isConstVariable(declaration));
  if (declarations.length !== 1) return null;
  const initializer = unwrap(declarations[0].getInitializer() ?? declarations[0]);
  if (!Node.isCallExpression(initializer)) return null;
  const target = resolveTarget(initializer.getExpression(), index);
  if (target.resolution !== "resolved" || target.resolvedTarget === null) return null;
  return factories.get(target.resolvedTarget) ?? null;
}

function returnedObject(factory: FunctionLike): ObjectLiteralExpression | null {
  const body = factory.getBody();
  if (!body) return null;
  const unwrappedBody = unwrap(body);
  if (Node.isObjectLiteralExpression(unwrappedBody)) return unwrappedBody;
  if (!Node.isBlock(body)) return null;
  const returns = body.getDescendantsOfKind(SyntaxKind.ReturnStatement)
    .filter((statement) => enclosingCallable(statement) === factory);
  if (returns.length !== 1) return null;
  const expression = returns[0].getExpression();
  if (!expression) return null;
  const value = unwrap(expression);
  return Node.isObjectLiteralExpression(value) ? value : null;
}

function eventDiscriminatorKey(
  node: Node | undefined,
  eventParameter: ParameterDeclaration,
  depth: number,
  seen: ReadonlySet<Node>,
): string | null {
  if (!node || depth > MAX_ALIAS_DEPTH) return null;
  const expression = unwrap(node);
  if (seen.has(expression)) return null;
  const nextSeen = new Set(seen);
  nextSeen.add(expression);
  if (Node.isPropertyAccessExpression(expression)
    && DISCRIMINATOR_KEYS.has(expression.getName())
    && resolvesEventData(expression.getExpression(), eventParameter, depth + 1, nextSeen)) {
    return expression.getName();
  }
  if (!Node.isIdentifier(expression)) return null;
  const declarations = immutableVariableDeclarations(expression);
  if (declarations.length !== 1) return null;
  return eventDiscriminatorKey(declarations[0].getInitializer(), eventParameter, depth + 1, nextSeen);
}

function resolvesEventData(
  node: Node,
  eventParameter: ParameterDeclaration,
  depth: number,
  seen: ReadonlySet<Node>,
): boolean {
  if (depth > MAX_ALIAS_DEPTH) return false;
  const expression = unwrap(node);
  if (seen.has(expression)) return false;
  const nextSeen = new Set(seen);
  nextSeen.add(expression);
  if (Node.isPropertyAccessExpression(expression) && expression.getName() === "data") {
    return referencesParameter(expression.getExpression(), eventParameter);
  }
  if (!Node.isIdentifier(expression)) return false;
  const declarations = immutableVariableDeclarations(expression);
  return declarations.length === 1
    && resolvesEventData(declarations[0].getInitializer() ?? expression, eventParameter, depth + 1, nextSeen);
}

function stableLocalDeclarationKey(node: Node, factory: FunctionLike): string | null {
  const expression = unwrap(node);
  if (!Node.isIdentifier(expression)) return null;
  const declarations = immutableVariableDeclarations(expression);
  if (declarations.length !== 1 || enclosingCallable(declarations[0]) !== factory) return null;
  return nodeKey(declarations[0]);
}

function stableDeclarationKey(node: Node): string | null {
  const expression = unwrap(node);
  if (!Node.isIdentifier(expression)) return null;
  const declarations = immutableVariableDeclarations(expression);
  return declarations.length === 1 ? nodeKey(declarations[0]) : null;
}

function immutableVariableDeclarations(identifier: Node): VariableDeclaration[] {
  if (!Node.isIdentifier(identifier)) return [];
  return (identifier.getSymbol()?.getDeclarations() ?? [])
    .filter((declaration): declaration is VariableDeclaration =>
      Node.isVariableDeclaration(declaration) && isConstVariable(declaration));
}

function parameterIsReferenced(parameter: ParameterDeclaration, callable: FunctionLike): boolean {
  const body = callable.getBody();
  if (!body) return false;
  return body.getDescendantsOfKind(SyntaxKind.Identifier)
    .some((identifier) => referencesParameter(identifier, parameter));
}

function referencesParameter(node: Node | undefined, parameter: ParameterDeclaration): boolean {
  if (!node) return false;
  const expression = unwrap(node);
  if (!Node.isIdentifier(expression)) return false;
  const declarations = expression.getSymbol()?.getDeclarations() ?? [];
  return declarations.some((declaration) => nodeKey(declaration) === nodeKey(parameter));
}

function directCalls(callable: FunctionLike): CallExpression[] {
  const body = callable.getBody();
  if (!body) return [];
  return body.getDescendantsOfKind(SyntaxKind.CallExpression)
    .filter((call) => enclosingCallable(call) === callable);
}

function enclosingCallable(node: Node): FunctionLike | null {
  let current = node.getParent();
  while (current) {
    if (isFunctionLike(current)) return current;
    current = current.getParent();
  }
  return null;
}

function isFunctionLike(node: Node): node is FunctionLike {
  return Node.isArrowFunction(node)
    || Node.isFunctionExpression(node)
    || Node.isFunctionDeclaration(node)
    || Node.isMethodDeclaration(node);
}

function isLocallyClosedFactory(factory: FunctionLike): boolean {
  if (Node.isFunctionDeclaration(factory)) {
    return factory.getName() !== undefined && !factory.isExported() && !factory.isDefaultExport();
  }
  if (!Node.isArrowFunction(factory) && !Node.isFunctionExpression(factory)) return false;
  const declaration = factory.getFirstAncestorByKind(SyntaxKind.VariableDeclaration);
  const statement = declaration?.getVariableStatement();
  return declaration?.getInitializer() === factory
    && Node.isIdentifier(declaration.getNameNode())
    && statement?.getDeclarationKind() === VariableDeclarationKind.Const
    && !statement.isExported()
    && !statement.isDefaultExport();
}

function isWithin(node: Node, ancestor: Node): boolean {
  let current: Node | undefined = node;
  while (current) {
    if (current === ancestor) return true;
    current = current.getParent();
  }
  return false;
}

function isConstVariable(node: Node): boolean {
  return Node.isVariableDeclaration(node)
    && node.getVariableStatement()?.getDeclarationKind() === VariableDeclarationKind.Const;
}

/** The enclosing emitted callable, else the source module. */
function owningNodeId(
  site: Node,
  index: ResolutionIndex,
  moduleByFilePath: Map<string, NodeDescriptor>,
): string {
  let current = site.getParent();
  while (current) {
    const enclosing = index.sourceByCallableKey.get(nodeKey(current));
    if (enclosing) return enclosing;
    current = current.getParent();
  }
  return moduleByFilePath.get(site.getSourceFile().getFilePath())?.finalId ?? "";
}

function unwrap(node: Node): Node {
  let current = node;
  while (Node.isParenthesizedExpression(current) || Node.isNonNullExpression(current)
    || Node.isAsExpression(current) || Node.isSatisfiesExpression(current) || Node.isTypeAssertion(current)) {
    current = current.getExpression();
  }
  return current;
}
