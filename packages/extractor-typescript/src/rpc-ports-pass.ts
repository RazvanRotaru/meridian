/**
 * Conservative correlation for the common typed RPC-factory shape:
 *
 *   const { proxy: client } = factory.createProxy<IService>("service");
 *   client.method();
 *
 * paired with:
 *
 *   factory.createStub("service", (method, args) =>
 *     (receiver as any)[method](...args));
 *
 * This deliberately models a programming shape, not a product or class name. Both creator
 * methods must be present on the same statically typed receiver, the proxy service must be a
 * literal, and a stub must transparently dispatch into one unambiguous concrete class instance.
 */

import {
  Node,
  SyntaxKind,
  VariableDeclarationKind,
  type BindingElement,
  type CallExpression,
  type ClassDeclaration,
  type MethodDeclaration,
  type ParameterDeclaration,
  type SourceFile,
  type Type,
} from "ts-morph";
import type { Port } from "@meridian/core";
import { staticCallable, staticString } from "./port-static-values";
import { callSiteOf, nodeKey, type NodeDescriptor } from "./model";
import type { LoadedProject } from "./project-loader";
import type { ResolutionIndex } from "./resolution-index";
import { resolveTarget } from "./edge-resolve";

const RPC_PROTOCOL = "rpc";
const RPC_LANE = "service-method";
const RPC_PROXY_MEMBER = "createProxy";
const RPC_STUB_MEMBER = "createStub";
const MAX_ALIAS_DEPTH = 8;

interface ProxyOrigin {
  service: string;
  /** May be unavailable in per-package mode when the generic contract lives in a sibling unit. */
  serviceType: Type | null;
  /** Parameter propagation may observe a valid local specialization alongside unknown callers. */
  confidence: number;
}

interface RpcContext {
  index: ResolutionIndex;
  moduleByFilePath: Map<string, NodeDescriptor>;
  proxyBindings: Map<string, ProxyOrigin>;
  callsByTarget: Map<string, CallExpression[]>;
}

/** Infer typed RPC exits and concrete stub entries in addition to catalog-modeled boundaries. */
export function collectStaticRpcPorts(
  loaded: LoadedProject,
  index: ResolutionIndex,
  moduleByFilePath: Map<string, NodeDescriptor>,
): Port[] {
  const context: RpcContext = {
    index,
    moduleByFilePath,
    proxyBindings: collectProxyBindings(loaded.sourceFiles),
    callsByTarget: collectCallsByTarget(loaded.sourceFiles, index),
  };
  const ports: Port[] = [];
  for (const sourceFile of loaded.sourceFiles) {
    const relPath = loaded.relativePathOf(sourceFile);
    for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const outbound = proxyCallPort(call, relPath, context);
      if (outbound) ports.push(outbound);
      ports.push(...stubPorts(call, relPath, context));
    }
  }
  return dedupePorts(ports);
}

function collectProxyBindings(sourceFiles: readonly SourceFile[]): Map<string, ProxyOrigin> {
  const bindings = new Map<string, ProxyOrigin>();
  for (const sourceFile of sourceFiles) {
    for (const declaration of sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
      const initializer = declaration.getInitializer();
      const pattern = declaration.getNameNode();
      if (!initializer || !Node.isCallExpression(initializer) || !Node.isObjectBindingPattern(pattern)) continue;
      if (!isRpcFactoryCall(initializer, RPC_PROXY_MEMBER)) continue;
      const service = staticString(initializer.getArguments()[0]);
      const typeArgument = initializer.getTypeArguments()[0];
      if (service === null || !typeArgument || initializer.getTypeArguments().length !== 1) continue;
      const proxy = pattern.getElements().find(isProxyBinding);
      if (!proxy || !Node.isIdentifier(proxy.getNameNode())) continue;
      const resolvedType = typeArgument.getType();
      const origin: ProxyOrigin = {
        service,
        serviceType: resolvedType.isAny() || resolvedType.isUnknown() ? null : resolvedType,
        confidence: 1,
      };
      bindings.set(nodeKey(proxy), origin);
      bindings.set(nodeKey(proxy.getNameNode()), origin);
      for (const symbolDeclaration of proxy.getNameNode().getSymbol()?.getDeclarations() ?? []) {
        bindings.set(nodeKey(symbolDeclaration), origin);
      }
    }
  }
  return bindings;
}

function isProxyBinding(element: BindingElement): boolean {
  const property = element.getPropertyNameNode();
  return property ? property.getText() === "proxy" : element.getNameNode().getText() === "proxy";
}

function proxyCallPort(call: CallExpression, relPath: string, context: RpcContext): Port | null {
  const callee = call.getExpression();
  if (!Node.isPropertyAccessExpression(callee)) return null;
  const method = callee.getName();
  if (method === RPC_PROXY_MEMBER || method === RPC_STUB_MEMBER) return null;
  const origin = proxyOriginOf(callee.getExpression(), context, 0, new Set());
  if (!origin || (origin.serviceType && !isCallableServiceMember(origin.serviceType, method, callee.getExpression()))) {
    return null;
  }
  return {
    nodeId: owningNodeId(call, context.index, context.moduleByFilePath),
    direction: "out",
    protocol: RPC_PROTOCOL,
    channel: rpcChannel(origin.service, method),
    label: call.getText().slice(0, 80),
    callSite: callSiteOf(call, relPath),
    surfaceId: "rpc.typed-proxy-call",
    operation: "request",
    lane: RPC_LANE,
    confidence: origin.confidence,
  };
}

function proxyOriginOf(
  node: Node,
  context: RpcContext,
  depth: number,
  seen: ReadonlySet<Node>,
): ProxyOrigin | null {
  if (depth > MAX_ALIAS_DEPTH || seen.has(node)) return null;
  const expression = unwrap(node);
  if (!Node.isIdentifier(expression)) return null;
  const nextSeen = new Set(seen);
  nextSeen.add(expression);
  const candidates: ProxyOrigin[] = [];
  let unknownParameterCaller = false;
  for (const declaration of expression.getSymbol()?.getDeclarations() ?? []) {
    const direct = context.proxyBindings.get(nodeKey(declaration));
    if (direct) candidates.push(direct);
    else if (Node.isVariableDeclaration(declaration) && isConstVariable(declaration)) {
      const initializer = declaration.getInitializer();
      if (initializer) {
        const aliased = proxyOriginOf(initializer, context, depth + 1, nextSeen);
        if (aliased) candidates.push(aliased);
      }
    } else if (Node.isParameterDeclaration(declaration)) {
      const propagated = proxyOriginsAtParameter(declaration, context, depth + 1, nextSeen);
      candidates.push(...propagated.origins);
      unknownParameterCaller ||= propagated.unknown;
    }
  }
  if (candidates.length === 0) return null;
  const services = new Set(candidates.map((candidate) => candidate.service));
  if (services.size !== 1) return null;
  const first = candidates[0];
  return {
    service: first.service,
    serviceType: first.serviceType,
    confidence: unknownParameterCaller
      ? Math.min(0.75, ...candidates.map((candidate) => candidate.confidence))
      : Math.min(...candidates.map((candidate) => candidate.confidence)),
  };
}

function proxyOriginsAtParameter(
  parameter: ParameterDeclaration,
  context: RpcContext,
  depth: number,
  seen: ReadonlySet<Node>,
): { origins: ProxyOrigin[]; unknown: boolean } {
  const callable = parameter.getParent();
  if (!isFunctionLike(callable)) return { origins: [], unknown: true };
  const targetId = context.index.sourceByCallableKey.get(nodeKey(callable))
    ?? context.index.targetByDeclKey.get(nodeKey(callable));
  if (!targetId) return { origins: [], unknown: true };
  const parameterKey = nodeKey(parameter);
  const position = callable.getParameters().findIndex((candidate) => nodeKey(candidate) === parameterKey);
  if (position < 0) return { origins: [], unknown: true };
  const callSites = context.callsByTarget.get(targetId) ?? [];
  if (callSites.length === 0) return { origins: [], unknown: true };
  const origins: ProxyOrigin[] = [];
  let unknown = false;
  for (const call of callSites) {
    const argument = call.getArguments()[position];
    if (!argument) {
      unknown = true;
      continue;
    }
    const origin = proxyOriginOf(argument, context, depth, seen);
    if (origin) origins.push(origin);
    else unknown = true;
  }
  return { origins, unknown };
}

function collectCallsByTarget(
  sourceFiles: readonly SourceFile[],
  index: ResolutionIndex,
): Map<string, CallExpression[]> {
  const calls = new Map<string, CallExpression[]>();
  for (const sourceFile of sourceFiles) {
    for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const target = resolveTarget(call.getExpression(), index);
      if (target.resolution !== "resolved" || target.resolvedTarget === null) continue;
      calls.set(target.resolvedTarget, [...(calls.get(target.resolvedTarget) ?? []), call]);
    }
  }
  return calls;
}

function stubPorts(call: CallExpression, relPath: string, context: RpcContext): Port[] {
  if (!isRpcFactoryCall(call, RPC_STUB_MEMBER)) return [];
  const service = staticString(call.getArguments()[0]);
  const handler = staticCallable(call.getArguments()[1]);
  if (service === null || !handler || handler.getParameters().length < 2) return [];
  const receiver = transparentDispatchReceiver(handler);
  if (!receiver) return [];
  const methods = concreteReceiverMethods(receiver, context.index);
  if (methods.length === 0) return [];
  const owner = owningNodeId(call, context.index, context.moduleByFilePath);
  return methods.map(({ name, nodeId }): Port => ({
    nodeId: owner,
    handlerNodeId: nodeId,
    direction: "in",
    protocol: RPC_PROTOCOL,
    channel: rpcChannel(service, name),
    label: `${service}.${name}`,
    callSite: callSiteOf(call, relPath),
    surfaceId: "rpc.dynamic-stub-dispatch",
    operation: "handle",
    lane: RPC_LANE,
    confidence: 1,
  }));
}

function transparentDispatchReceiver(handler: ReturnType<typeof staticCallable>): Node | null {
  if (!handler) return null;
  const [methodParameter, argsParameter] = handler.getParameters();
  if (!methodParameter || !argsParameter
    || !Node.isIdentifier(methodParameter.getNameNode()) || !Node.isIdentifier(argsParameter.getNameNode())) {
    return null;
  }
  const call = transparentHandlerCall(handler.getBody());
  if (!call) return null;
  const callee = call.getExpression();
  if (!Node.isElementAccessExpression(callee)) return null;
  const key = callee.getArgumentExpression();
  if (!key || !sameDeclaration(key, methodParameter.getNameNode())) return null;
  const argumentsList = call.getArguments();
  const transparentlyForwardsArgs = argumentsList.length === 1
    && Node.isSpreadElement(argumentsList[0])
    && sameDeclaration(argumentsList[0].getExpression(), argsParameter.getNameNode());
  return transparentlyForwardsArgs ? unwrap(callee.getExpression()) : null;
}

function transparentHandlerCall(body: Node | undefined): CallExpression | null {
  if (!body) return null;
  let value = body;
  if (Node.isBlock(value)) {
    const statements = value.getStatements();
    if (statements.length !== 1) return null;
    const statement = statements[0];
    if (Node.isReturnStatement(statement)) value = statement.getExpression() ?? statement;
    else if (Node.isExpressionStatement(statement)) value = statement.getExpression();
    else return null;
  }
  while (Node.isAwaitExpression(value)) value = value.getExpression();
  value = unwrap(value);
  return Node.isCallExpression(value) ? value : null;
}

function concreteReceiverMethods(
  receiver: Node,
  index: ResolutionIndex,
): Array<{ name: string; nodeId: string }> {
  const type = receiver.getType();
  if (type.isAny() || type.isUnknown() || type.isUnion() || type.isIntersection()) return [];
  const symbol = type.getAliasSymbol() ?? type.getSymbol();
  const classes = (symbol?.getDeclarations() ?? []).filter(Node.isClassDeclaration);
  if (classes.length !== 1) return [];
  const classDeclaration = classes[0] as ClassDeclaration;
  const methods = new Map<string, { name: string; nodeId: string }>();
  for (const method of classDeclaration.getMethods()) {
    if (!isPublicInstanceMethod(method)) continue;
    const implementation = implementationMethod(method, classDeclaration);
    const nodeId = index.targetByDeclKey.get(nodeKey(implementation));
    if (nodeId) methods.set(method.getName(), { name: method.getName(), nodeId });
  }
  return [...methods.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function implementationMethod(method: MethodDeclaration, owner: ClassDeclaration): MethodDeclaration {
  if (method.getBody()) return method;
  return owner.getMethods().find((candidate) => candidate.getName() === method.getName() && candidate.getBody()) ?? method;
}

function isPublicInstanceMethod(method: MethodDeclaration): boolean {
  return !method.isStatic()
    && !method.hasModifier(SyntaxKind.PrivateKeyword)
    && !method.hasModifier(SyntaxKind.ProtectedKeyword);
}

/** Both halves on one typed receiver are the evidence that these generic names describe RPC. */
function isRpcFactoryCall(call: CallExpression, selectedMember: string): boolean {
  const callee = call.getExpression();
  if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== selectedMember) return false;
  const receiver = callee.getExpression();
  const receiverType = receiver.getType();
  if (receiverType.isAny() || receiverType.isUnknown()) {
    return unresolvedImportedFactoryHasRpcPair(receiver);
  }
  const proxy = receiverType.getProperty(RPC_PROXY_MEMBER);
  const stub = receiverType.getProperty(RPC_STUB_MEMBER);
  if (!proxy || !stub) return false;
  const proxySignatures = proxy.getTypeAtLocation(receiver).getCallSignatures();
  const stubSignatures = stub.getTypeAtLocation(receiver).getCallSignatures();
  return proxySignatures.some((signature) => signature.getReturnType().getProperty("proxy") !== undefined)
    && stubSignatures.some((signature) => signature.getParameters().length >= 2);
}

/**
 * Per-package extraction intentionally does not load sibling package programs. An imported
 * factory can therefore degrade to `any`; retain it only when one immutable imported-constructor
 * instance exhibits BOTH complementary typed-proxy and stub-registration shapes in this file.
 */
function unresolvedImportedFactoryHasRpcPair(receiver: Node): boolean {
  const expression = unwrap(receiver);
  if (!Node.isIdentifier(expression) || !isImportedConstructorInstance(expression)) return false;
  let hasTypedProxy = false;
  let hasStub = false;
  for (const call of expression.getSourceFile().getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression();
    if (!Node.isPropertyAccessExpression(callee)
      || !sameDeclaration(callee.getExpression(), expression)) continue;
    if (callee.getName() === RPC_PROXY_MEMBER) {
      const parent = call.getParent();
      const pattern = Node.isVariableDeclaration(parent) ? parent.getNameNode() : null;
      hasTypedProxy ||= call.getTypeArguments().length === 1
        && staticString(call.getArguments()[0]) !== null
        && pattern !== null
        && Node.isObjectBindingPattern(pattern)
        && pattern.getElements().some(isProxyBinding);
    } else if (callee.getName() === RPC_STUB_MEMBER) {
      const handler = staticCallable(call.getArguments()[1]);
      hasStub ||= staticString(call.getArguments()[0]) !== null
        && handler !== null
        && handler.getParameters().length >= 2;
    }
    if (hasTypedProxy && hasStub) return true;
  }
  return false;
}

function isImportedConstructorInstance(identifier: Node): boolean {
  if (!Node.isIdentifier(identifier)) return false;
  return (identifier.getSymbol()?.getDeclarations() ?? []).some((declaration) => {
    if (!Node.isVariableDeclaration(declaration) || !isConstVariable(declaration)) return false;
    const initialValue = declaration.getInitializer();
    if (!initialValue) return false;
    const initializer = unwrap(initialValue);
    if (!Node.isNewExpression(initializer)) return false;
    const constructor = unwrap(initializer.getExpression());
    if (!Node.isIdentifier(constructor)) return false;
    return (constructor.getSymbol()?.getDeclarations() ?? []).some((origin) =>
      Node.isImportSpecifier(origin) || Node.isImportClause(origin) || Node.isNamespaceImport(origin));
  });
}

function isCallableServiceMember(serviceType: Type, member: string, location: Node): boolean {
  const property = serviceType.getProperty(member);
  return property !== undefined && property.getTypeAtLocation(location).getCallSignatures().length > 0;
}

function rpcChannel(service: string, method: string): string {
  return `${service}/${method}`;
}

function isConstVariable(declaration: Node): boolean {
  return Node.isVariableDeclaration(declaration)
    && declaration.getVariableStatement()?.getDeclarationKind() === VariableDeclarationKind.Const;
}

function isFunctionLike(node: Node): node is Node & { getParameters(): ParameterDeclaration[] } {
  return Node.isFunctionDeclaration(node)
    || Node.isFunctionExpression(node)
    || Node.isArrowFunction(node)
    || Node.isMethodDeclaration(node);
}

function sameDeclaration(left: Node, right: Node): boolean {
  const leftNode = unwrap(left);
  const rightNode = unwrap(right);
  if (!Node.isIdentifier(leftNode) || !Node.isIdentifier(rightNode)) return false;
  const leftDeclarations = new Set(leftNode.getSymbol()?.getDeclarations() ?? []);
  return (rightNode.getSymbol()?.getDeclarations() ?? []).some((declaration) => leftDeclarations.has(declaration));
}

/** The enclosing emitted callable, else the file's module node. */
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

function dedupePorts(ports: Port[]): Port[] {
  const seen = new Set<string>();
  return ports.filter((port) => {
    const key = [port.nodeId, port.handlerNodeId, port.direction, port.protocol, port.lane, port.channel,
      port.callSite.file, port.callSite.line, port.callSite.col].join("\u0000");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
