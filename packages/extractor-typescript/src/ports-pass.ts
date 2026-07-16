/**
 * Static IPC/API boundary extraction.
 *
 * Supported surfaces live in `port-surfaces.ts`; this pass is the reusable interpreter. It proves
 * an API origin from imports, a known factory result, a global declaration, or a DOM owning type,
 * then applies the model's literal/channel strategy. Local aliases are followed conservatively.
 * Anything dynamic still emits a one-sided `channel: null` port and is never joined by core.
 */

import {
  Node,
  SyntaxKind,
  VariableDeclarationKind,
  type CallExpression,
  type ParameterDeclaration,
  type PropertyAccessExpression,
  type SourceFile,
  type Type,
} from "ts-morph";
import type { Port } from "@meridian/core";
import { callSiteOf, nodeKey, type NodeDescriptor } from "./model";
import type { LoadedProject } from "./project-loader";
import type { ResolutionIndex } from "./resolution-index";
import { resolveTarget } from "./edge-resolve";
import {
  BUILTIN_PORT_MODELS,
  type PortChannelRule,
  type PortFactoryDefinition,
  type PortModelCatalog,
  type PortSurfaceDefinition,
  type PortSurfaceOrigin,
} from "./port-surfaces";
import {
  messageListenerDiscriminators,
  messagePayloadDiscriminators,
  staticCallable,
  staticObjectProperty,
  staticString,
  type StaticArgumentResolver,
} from "./port-static-values";
import { collectStaticRpcPorts } from "./rpc-ports-pass";
import {
  collectMessageDispatcherPorts,
  type MessageListenerBoundary,
} from "./postmessage-dispatcher-ports";

const LABEL_CAP = 80;
const MAX_ORIGIN_DEPTH = 8;

interface ImportOrigin {
  kind: "import";
  module: string;
  exportName: string;
}

interface FactoryOrigin {
  kind: "factory";
  id: string;
  /** Proven identity of this concrete factory result, when the model requests one. */
  scope?: string;
}

type ApiOrigin = ImportOrigin | FactoryOrigin;

interface FileContext {
  /** Keyed by declaration identity, never spelling, so lexical shadowing cannot inherit a model. */
  imports: Map<string, ImportOrigin>;
  factories: Map<string, FactoryOrigin>;
}

interface ScopeEvidence {
  scope?: string;
  scopeKind?: Port["scopeKind"];
}

interface StaticArgumentIndex {
  resolve: StaticArgumentResolver;
  callSitesFor(callable: Node): readonly CallExpression[] | null;
  resolveAt(callable: Node, callSite: CallExpression): StaticArgumentResolver;
}

type PortOccurrence = Pick<Port, "nodeId" | "channel" | "callSite">;

export function collectPorts(
  loaded: LoadedProject,
  index: ResolutionIndex,
  moduleByFilePath: Map<string, NodeDescriptor>,
  models: PortModelCatalog = BUILTIN_PORT_MODELS,
): Port[] {
  const ports: Port[] = [];
  const messageListeners: MessageListenerBoundary[] = [];
  const argumentIndex = buildStaticArgumentIndex(loaded, index);
  for (const sourceFile of loaded.sourceFiles) {
    const relPath = loaded.relativePathOf(sourceFile);
    const context = fileContext(sourceFile, models.factories, relPath);
    for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const listenerSurface = matchingMessageListenerSurface(call, context, models.surfaces);
      if (listenerSurface) messageListeners.push({ call, surface: listenerSurface, relPath });
      ports.push(...matchCall(
        call,
        context,
        models.surfaces,
        relPath,
        loaded,
        index,
        moduleByFilePath,
        argumentIndex,
      ));
    }
  }
  return [
    ...ports,
    ...collectMessageDispatcherPorts(loaded, index, moduleByFilePath, messageListeners),
    ...collectStaticRpcPorts(loaded, index, moduleByFilePath),
  ];
}

/** Physical message listeners that may back a returned, typed dispatcher object. */
function matchingMessageListenerSurface(
  call: CallExpression,
  context: FileContext,
  surfaces: readonly PortSurfaceDefinition[],
): PortSurfaceDefinition | null {
  const callee = call.getExpression();
  const member = Node.isPropertyAccessExpression(callee) ? callee.getName() : null;
  const receiver = Node.isPropertyAccessExpression(callee) ? callee.getExpression() : null;
  for (const surface of surfaces) {
    if (surface.direction !== "in" || surface.channel.kind !== "web-message-listener") continue;
    if (surface.member !== member || !originMatches(surface.origin, callee, receiver, context)) continue;
    if (surface.minimumArguments !== undefined && call.getArguments().length < surface.minimumArguments) continue;
    if (surface.requiresLiteralArgument) {
      const { index, value } = surface.requiresLiteralArgument;
      if (staticString(call.getArguments()[index]) !== value) continue;
    }
    return surface;
  }
  return null;
}

function fileContext(
  sourceFile: SourceFile,
  factoryModels: readonly PortFactoryDefinition[],
  relPath: string,
): FileContext {
  const imports = importOrigins(sourceFile);
  const factories = factoryOrigins(sourceFile, imports, factoryModels, relPath);
  return { imports, factories };
}

/** Public import identity, including aliases and namespace imports. */
function importOrigins(sourceFile: SourceFile): Map<string, ImportOrigin> {
  const origins = new Map<string, ImportOrigin>();
  for (const declaration of sourceFile.getImportDeclarations()) {
    const module = declaration.getModuleSpecifierValue();
    const defaultImport = declaration.getDefaultImport();
    if (defaultImport) registerDeclarationOrigin(origins, defaultImport, { kind: "import", module, exportName: "default" });
    const namespaceImport = declaration.getNamespaceImport();
    if (namespaceImport) registerDeclarationOrigin(origins, namespaceImport, { kind: "import", module, exportName: "*" });
    for (const named of declaration.getNamedImports()) {
      registerDeclarationOrigin(
        origins,
        named.getAliasNode() ?? named.getNameNode(),
        { kind: "import", module, exportName: named.getName() },
      );
    }
  }
  return origins;
}

function registerDeclarationOrigin<T extends ApiOrigin>(origins: Map<string, T>, declaration: Node, origin: T): void {
  origins.set(nodeKey(declaration), origin);
  for (const symbolDeclaration of declaration.getSymbol()?.getDeclarations() ?? []) {
    origins.set(nodeKey(symbolDeclaration), origin);
  }
}

/** Variables created by any factory described in the supplied port-model catalog. */
function factoryOrigins(
  sourceFile: SourceFile,
  imports: Map<string, ImportOrigin>,
  models: readonly PortFactoryDefinition[],
  relPath: string,
): Map<string, FactoryOrigin> {
  const factories = new Map<string, FactoryOrigin>();
  const context: FileContext = { imports, factories };
  const declarations = sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration);
  // A few passes admit simple aliases without turning this into a whole-program points-to engine.
  for (let pass = 0; pass < 3; pass += 1) {
    for (const declaration of declarations) {
      const key = nodeKey(declaration);
      if (!Node.isIdentifier(declaration.getNameNode()) || !isConstVariable(declaration) || factories.has(key)) continue;
      const origin = factoryFromInitializer(declaration.getInitializer(), context, models, relPath);
      if (origin) factories.set(key, origin);
    }
  }
  return factories;
}

function factoryFromInitializer(
  initializer: Node | undefined,
  context: FileContext,
  models: readonly PortFactoryDefinition[],
  relPath: string,
): FactoryOrigin | null {
  const value = initializer ? unwrap(initializer) : null;
  if (!value) return null;
  if (Node.isIdentifier(value)) {
    const existing = originOf(value, context);
    return existing?.kind === "factory" ? existing : null;
  }
  if (!Node.isCallExpression(value)) return null;
  const callee = value.getExpression();
  const member = Node.isPropertyAccessExpression(callee) ? callee.getName() : null;
  const receiver = Node.isPropertyAccessExpression(callee) ? callee.getExpression() : null;
  for (const model of models) {
    if (model.member !== member) continue;
    if (model.minimumArguments !== undefined && value.getArguments().length < model.minimumArguments) continue;
    if (originMatches(model.origin, callee, receiver, context)) {
      return {
        kind: "factory",
        id: model.resultId,
        scope: factoryScope(model, value, relPath),
      };
    }
  }
  return null;
}

function matchCall(
  call: CallExpression,
  context: FileContext,
  surfaces: readonly PortSurfaceDefinition[],
  relPath: string,
  loaded: LoadedProject,
  index: ResolutionIndex,
  moduleByFilePath: Map<string, NodeDescriptor>,
  argumentIndex: StaticArgumentIndex,
): Port[] {
  const callee = call.getExpression();
  const member = Node.isPropertyAccessExpression(callee) ? callee.getName() : null;
  const receiver = Node.isPropertyAccessExpression(callee) ? callee.getExpression() : null;
  for (const surface of surfaces) {
    if (surface.member !== member || !originMatches(surface.origin, callee, receiver, context)) continue;
    if (surface.minimumArguments !== undefined && call.getArguments().length < surface.minimumArguments) continue;
    if (surface.requiresLiteralArgument) {
      const { index: argumentIndex, value } = surface.requiresLiteralArgument;
      if (staticString(call.getArguments()[argumentIndex]) !== value) continue;
    }
    const scope = scopeFor(surface.channel, call, receiver, context);
    const owner = owningNodeId(call, index, moduleByFilePath);
    const physical: PortOccurrence = {
      nodeId: owner,
      channel: null,
      callSite: callSiteOf(call, relPath),
    };
    const occurrences = surface.channel.kind === "web-message-send"
      ? messageSendOccurrences(
        call,
        surface.channel.payloadArgument,
        physical,
        argumentIndex,
        loaded,
        index,
        moduleByFilePath,
      )
      : channelsFor(surface.channel, call, member).map((channel) => ({ ...physical, channel }));
    const handlerNodeId = handlerIdFor(call, surface.handlerArgument, index);
    const label = argLabel(call).slice(0, LABEL_CAP);
    return occurrences.map((occurrence): Port => ({
      nodeId: occurrence.nodeId,
      direction: surface.direction,
      protocol: surface.protocol,
      channel: occurrence.channel,
      label,
      callSite: occurrence.callSite,
      surfaceId: surface.id,
      operation: surface.operation,
      lane: surface.lane,
      scope: scope.scope,
      scopeKind: scope.scopeKind,
      confidence: surface.confidence,
      handlerNodeId: handlerNodeId ?? undefined,
    }));
  }
  return [];
}

/**
 * Absolute HTTP origins and concrete factory results are endpoint identity, separate from the
 * method/path channel. Relative direct requests intentionally stay unscoped: their ambient runtime
 * origin is not statically proven. A factory scope is used only when its catalog model opted in.
 */
function scopeFor(
  rule: PortChannelRule,
  call: CallExpression,
  receiver: Node | null,
  context: FileContext,
): ScopeEvidence {
  let urlArgument: number | null = null;
  if (rule.kind === "http-fetch" || rule.kind === "http-member") {
    urlArgument = rule.urlArgument;
  }
  if (urlArgument === null) return {};

  const url = staticString(call.getArguments()[urlArgument]);
  const absoluteOrigin = url === null ? null : absoluteHttpOrigin(url);
  if (absoluteOrigin !== null) return { scope: `origin:${absoluteOrigin}`, scopeKind: "global" };

  const apiOrigin = receiver ? originOf(receiver, context) : null;
  return apiOrigin?.kind === "factory" && apiOrigin.scope !== undefined
    ? { scope: apiOrigin.scope, scopeKind: "artifact" }
    : {};
}

function factoryScope(
  model: PortFactoryDefinition,
  call: CallExpression,
  relPath: string,
): string | undefined {
  if (model.scope?.kind !== "allocation-site") return undefined;
  const site = callSiteOf(call, relPath);
  let scope = `factory:${model.resultId}@${relPath}:${site.line}:${site.col ?? 1}`;
  const configModel = model.scope.staticConfig;
  if (!configModel) return scope;

  const config = staticObjectProperty(call.getArguments()[configModel.argument], configModel.property);
  const value = !config.objectKnown
    ? "unknown"
    : !config.propertyPresent
      ? "default"
      : config.value ?? "dynamic";
  scope += `|${configModel.property}=${value}`;
  return scope;
}

function absoluteHttpOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

function originMatches(
  expected: PortSurfaceOrigin,
  callee: Node,
  receiver: Node | null,
  context: FileContext,
): boolean {
  switch (expected.kind) {
    case "global":
      return receiver === null && Node.isIdentifier(callee) && callee.getText() === expected.name
        && isModeledGlobal(callee, expected);
    case "import": {
      const actual = originOf(receiver ?? callee, context);
      return isImport(actual, expected.module, expected.exportName);
    }
    case "factory": {
      const actual = receiver ? originOf(receiver, context) : null;
      return actual?.kind === "factory" && actual.id === expected.id;
    }
    case "dom":
      return receiver !== null && Node.isPropertyAccessExpression(callee)
        && isPlatformMessagingMember(callee)
        && domOwnerNames(receiver, callee).some((owner) => expected.owners.includes(owner));
    case "unresolved-member":
      return receiver !== null && Node.isPropertyAccessExpression(callee)
        && isUnresolvedDynamicMember(receiver, callee);
    case "receiver-suffix":
      return receiver !== null && receiver.getText().endsWith(expected.suffix);
  }
}

function originOf(node: Node, context: FileContext, depth = 0, seen: ReadonlySet<Node> = new Set()): ApiOrigin | null {
  if (depth > MAX_ORIGIN_DEPTH || seen.has(node)) return null;
  const expression = unwrap(node);
  const nextSeen = new Set(seen);
  nextSeen.add(expression);
  if (Node.isIdentifier(expression)) {
    for (const declaration of expression.getSymbol()?.getDeclarations() ?? []) {
      const direct = context.factories.get(nodeKey(declaration)) ?? context.imports.get(nodeKey(declaration));
      if (direct) return direct;
      if (Node.isVariableDeclaration(declaration) && isConstVariable(declaration)) {
        const initializer = declaration.getInitializer();
        if (initializer) {
          const aliased = originOf(initializer, context, depth + 1, nextSeen);
          if (aliased) return aliased;
        }
      }
    }
    return null;
  }
  if (Node.isPropertyAccessExpression(expression)) {
    const parent = originOf(expression.getExpression(), context, depth + 1, nextSeen);
    if (parent?.kind === "import" && parent.exportName === "*") {
      return { kind: "import", module: parent.module, exportName: expression.getName() };
    }
  }
  return null;
}

function channelsFor(
  rule: PortChannelRule,
  call: CallExpression,
  member: string | null,
): Array<string | null> {
  switch (rule.kind) {
    case "literal-argument":
      return [staticString(call.getArguments()[rule.index])];
    case "http-fetch": {
      const url = staticString(call.getArguments()[rule.urlArgument]);
      const method = fetchMethod(call.getArguments()[rule.optionsArgument]);
      return [url === null || method === null ? null : `${method} ${pathOf(url)}`];
    }
    case "http-member": {
      const url = staticString(call.getArguments()[rule.urlArgument]);
      return [url === null || member === null ? null : `${member.toUpperCase()} ${pathOf(url)}`];
    }
    case "web-message-send":
      return messagePayloadDiscriminators(call.getArguments()[rule.payloadArgument]);
    case "web-message-listener": {
      const discriminators = messageListenerDiscriminators(call.getArguments()[rule.handlerArgument]);
      return discriminators.length === 0 ? [null] : discriminators;
    }
  }
}

/**
 * A literal sent directly at the physical postMessage site keeps the ordinary boundary ownership.
 * A parameterized local wrapper instead specializes once per statically known invocation: the
 * caller owns the send and the wrapper invocation is its source anchor. This preserves context in
 * the function-level graph (`ready` and `session-changed` callers cannot inherit one another's
 * channels). Unknown invocations retain one null port at the physical boundary as honest evidence.
 */
function messageSendOccurrences(
  boundaryCall: CallExpression,
  payloadArgument: number,
  physical: PortOccurrence,
  argumentIndex: StaticArgumentIndex,
  loaded: LoadedProject,
  index: ResolutionIndex,
  moduleByFilePath: Map<string, NodeDescriptor>,
): PortOccurrence[] {
  const payload = boundaryCall.getArguments()[payloadArgument];
  const direct = messagePayloadDiscriminators(payload);
  if (direct.some((channel) => channel !== null)) {
    return direct.map((channel) => ({ ...physical, channel }));
  }

  const wrapper = enclosingFunctionLike(boundaryCall);
  const callSites = wrapper ? argumentIndex.callSitesFor(wrapper) : null;
  if (!wrapper || !callSites || callSites.length === 0) return [physical];

  const occurrences: PortOccurrence[] = [];
  let hasUnknown = false;
  for (const callSite of callSites) {
    const channels = messagePayloadDiscriminators(payload, argumentIndex.resolveAt(wrapper, callSite));
    // More than one candidate from one invocation means an outer context was merged. Until the
    // graph carries context identities, retaining a null physical port is safer than cross-linking.
    if (channels.length !== 1 || channels[0] === null) {
      hasUnknown = true;
      continue;
    }
    occurrences.push({
      nodeId: owningNodeId(callSite, index, moduleByFilePath),
      channel: channels[0],
      callSite: callSiteOf(callSite, loaded.relativePathOf(callSite.getSourceFile())),
    });
  }
  if (hasUnknown) occurrences.push(physical);
  return occurrences.length > 0 ? occurrences : [physical];
}

function enclosingFunctionLike(node: Node): Node | null {
  let current = node.getParent();
  while (current) {
    if (isFunctionLike(current)) return current;
    current = current.getParent();
  }
  return null;
}

/** Resolve literal arguments through non-exported local wrapper callables. */
function buildStaticArgumentIndex(
  loaded: LoadedProject,
  index: ResolutionIndex,
): StaticArgumentIndex {
  let callsByTarget: Map<string, CallExpression[]> | null = null;
  const calls = (): Map<string, CallExpression[]> => {
    if (callsByTarget) return callsByTarget;
    callsByTarget = new Map();
    for (const sourceFile of loaded.sourceFiles) {
      for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const target = resolveTarget(call.getExpression(), index);
        if (target.resolution !== "resolved" || target.resolvedTarget === null) continue;
        callsByTarget.set(target.resolvedTarget, [
          ...(callsByTarget.get(target.resolvedTarget) ?? []),
          call,
        ]);
      }
    }
    return callsByTarget;
  };

  const callSitesFor = (callable: Node): readonly CallExpression[] | null => {
    if (!isFunctionLike(callable) || !isLocallyClosedCallable(callable)) return null;
    const targetId = index.sourceByCallableKey.get(nodeKey(callable))
      ?? index.targetByDeclKey.get(nodeKey(callable));
    if (!targetId) return null;
    return calls().get(targetId) ?? null;
  };

  const resolve: StaticArgumentResolver = (parameter): readonly (Node | undefined)[] | null => {
    const callable = parameter.getParent();
    if (!isFunctionLike(callable)) return null;
    const callSites = callSitesFor(callable);
    if (!callSites || callSites.length === 0) return null;
    const parameterKey = nodeKey(parameter);
    const parameterIndex = callable.getParameters().findIndex((candidate) => nodeKey(candidate) === parameterKey);
    if (parameterIndex < 0) return null;
    return callSites.map((call) => call.getArguments()[parameterIndex]);
  };

  const resolveAt = (boundCallable: Node, boundCallSite: CallExpression): StaticArgumentResolver => {
    const boundKey = nodeKey(boundCallable);
    return (parameter) => {
      const callable = parameter.getParent();
      if (isFunctionLike(callable) && nodeKey(callable) === boundKey) {
        const parameterKey = nodeKey(parameter);
        const parameterIndex = callable.getParameters()
          .findIndex((candidate) => nodeKey(candidate) === parameterKey);
        return parameterIndex < 0 ? null : [boundCallSite.getArguments()[parameterIndex]];
      }
      return resolve(parameter);
    };
  };

  return { resolve, callSitesFor, resolveAt };
}

function isFunctionLike(node: Node): node is Node & { getParameters(): ParameterDeclaration[] } {
  return Node.isFunctionDeclaration(node)
    || Node.isFunctionExpression(node)
    || Node.isArrowFunction(node)
    || Node.isMethodDeclaration(node);
}

/** Exported functions and non-private methods may have call sites outside this extraction. */
function isLocallyClosedCallable(node: Node): boolean {
  if (Node.isFunctionDeclaration(node)) return !node.isExported() && !node.isDefaultExport();
  if (Node.isMethodDeclaration(node)) return node.hasModifier(SyntaxKind.PrivateKeyword);
  if (Node.isArrowFunction(node) || Node.isFunctionExpression(node)) {
    const declaration = node.getFirstAncestorByKind(SyntaxKind.VariableDeclaration);
    const statement = declaration?.getVariableStatement();
    return declaration?.getInitializer() === node
      && statement !== undefined
      && !statement.isExported()
      && !statement.isDefaultExport();
  }
  return false;
}

/** No options means Fetch's specified GET default. Present-but-dynamic options are unknown. */
function fetchMethod(options: Node | undefined): string | null {
  if (!options) return "GET";
  const method = staticObjectProperty(options, "method");
  if (!method.objectKnown) return null;
  if (!method.propertyPresent) return "GET";
  return method.value?.toUpperCase() ?? null;
}

/** URL → route path: strip an absolute origin, query, and hash; guarantee a leading slash. */
function pathOf(url: string): string {
  let path = url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i, "");
  path = path.split("?")[0].split("#")[0];
  return path.startsWith("/") ? path : `/${path}`;
}

function argLabel(call: CallExpression): string {
  return call.getArguments()[0]?.getText() ?? call.getText();
}

function isImport(origin: ApiOrigin | null, module: string, exportName: string): origin is ImportOrigin {
  return origin?.kind === "import" && origin.module === module && origin.exportName === exportName;
}

function isConstVariable(declaration: Node): boolean {
  return Node.isVariableDeclaration(declaration)
    && declaration.getVariableStatement()?.getDeclarationKind() === VariableDeclarationKind.Const;
}

/** A same-named local or project ambient must not inherit a modeled platform global. */
function isModeledGlobal(identifier: Node, model: Extract<PortSurfaceOrigin, { kind: "global" }>): boolean {
  const declarations = Node.isIdentifier(identifier) ? identifier.getSymbol()?.getDeclarations() ?? [] : [];
  return declarations.some((declaration) => {
    const sourceFile = declaration.getSourceFile();
    if (!sourceFile.isDeclarationFile()) return false;
    const path = sourceFile.getFilePath().replaceAll("\\", "/").toLowerCase();
    return model.declarationPathSuffixes.some((suffix) => path.endsWith(suffix.toLowerCase()));
  });
}

/** Owning interface/class names proven by the receiver type or the selected member declaration. */
function domOwnerNames(receiver: Node, callee: PropertyAccessExpression): string[] {
  const owners = new Set<string>();
  addTypeNames(receiver.getType(), owners);
  for (const declaration of callee.getNameNode().getSymbol()?.getDeclarations() ?? []) {
    let current: Node | undefined = declaration;
    while ((current = current.getParent()) !== undefined) {
      if (Node.isInterfaceDeclaration(current) || Node.isClassDeclaration(current)) {
        const name = current.getName();
        if (name) owners.add(name);
        break;
      }
    }
  }
  return [...owners];
}

/** DOM messaging models are admitted only when the selected member comes from a platform lib. */
function isPlatformMessagingMember(callee: PropertyAccessExpression): boolean {
  return (callee.getNameNode().getSymbol()?.getDeclarations() ?? []).some((declaration) => {
    const file = declaration.getSourceFile().getBaseName().toLowerCase();
    return file === "lib.dom.d.ts" || file.startsWith("lib.webworker") || file === "lib.serviceworker.d.ts";
  });
}

/**
 * Conservative recovery for dependency-light extraction. If an imported receiver's declarations
 * are absent, TypeScript commonly degrades `receiver.postMessage` to `any` and gives the selected
 * member no symbol. We retain that as a low-confidence boundary candidate. A locally declared or
 * otherwise typed `postMessage` method never qualifies, which avoids stealing application APIs.
 */
function isUnresolvedDynamicMember(receiver: Node, callee: PropertyAccessExpression): boolean {
  const declarations = callee.getNameNode().getSymbol()?.getDeclarations() ?? [];
  const type = receiver.getType();
  return declarations.length === 0 && (type.isAny() || type.isUnknown());
}

function addTypeNames(type: Type, into: Set<string>): void {
  const symbolName = type.getAliasSymbol()?.getName() ?? type.getSymbol()?.getName();
  if (symbolName) into.add(symbolName);
  for (const part of type.getUnionTypes()) addTypeNames(part, into);
  // Intersection constituents (e.g. `Window & typeof globalThis`) are not union types.
  for (const part of type.getIntersectionTypes()) addTypeNames(part, into);
}

function handlerIdFor(call: CallExpression, argumentIndex: number | undefined, index: ResolutionIndex): string | null {
  if (argumentIndex === undefined) return null;
  const args = call.getArguments();
  const normalized = argumentIndex < 0 ? args.length + argumentIndex : argumentIndex;
  const callable = staticCallable(args[normalized]);
  if (!callable) return null;
  return index.sourceByCallableKey.get(nodeKey(callable))
    ?? index.targetByDeclKey.get(nodeKey(callable))
    ?? null;
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
