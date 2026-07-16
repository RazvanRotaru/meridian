/**
 * Escaping Promise-resource correlation.
 *
 * Calls answer "who invokes whom"; they do not preserve value identity. This pass adds the small
 * def-use layer needed for deferred barriers: a stored `new Promise`, its captured resolver and
 * rejector aliases, methods returning that exact resource, awaiters, and settlement calls all join
 * through one graph node. The rules are syntax/type based and contain no framework vocabulary.
 */

import { buildNodeId, parseNodeId, type GraphNode } from "@meridian/core";
import { Node, SyntaxKind, type NewExpression } from "ts-morph";
import { callSiteOf, type RawEdge } from "./edge-pass";
import { resolveTarget, type CrossPackageResolver, type TargetResolution } from "./edge-resolve";
import { nodeKey, type NodeDescriptor } from "./model";
import { staticCallable } from "./port-static-values";
import type { LoadedProject } from "./project-loader";
import type { ResolutionIndex } from "./resolution-index";

export const PROMISE_RESOURCE_KIND = "promise";
export const CREATES_PROMISE_KIND = "createsPromise";
export const RETURNS_PROMISE_KIND = "returnsPromise";
export const AWAITS_PROMISE_KIND = "awaitsPromise";
export const RESOLVES_PROMISE_KIND = "resolvesPromise";
export const REJECTS_PROMISE_KIND = "rejectsPromise";

const MAX_ALIAS_DEPTH = 8;

export interface PromiseResourceResult {
  nodes: GraphNode[];
  edges: RawEdge[];
  /** Exit-only methods in this set still deserve a logic flow: returning the barrier is the flow. */
  flowIds: Set<string>;
}

interface PromiseResource {
  id: string;
  node: GraphNode;
  creation: NewExpression;
  creatorId: string;
  relativeFile: string;
}

interface SettlerAlias {
  resource: PromiseResource;
  role: "resolve" | "reject";
}

interface ReturnSite {
  source: string;
  expression: Node | null;
  statement: Node;
  relativeFile: string;
  preservesIdentity: boolean;
}

type StorageWrites = ReadonlyMap<string, readonly Node[]>;
type SettlerAliases = Map<string, SettlerAlias | null>;

interface ResourceFacts {
  resources: Map<string, PromiseResource>;
  unknown: boolean;
}

export function collectPromiseResources(
  loaded: LoadedProject,
  index: ResolutionIndex,
  moduleByFilePath: Map<string, NodeDescriptor>,
  resolver?: CrossPackageResolver,
): PromiseResourceResult {
  const resources = discoverResources(loaded, index, moduleByFilePath);
  if (resources.length === 0) return { nodes: [], edges: [], flowIds: new Set() };

  const byCreation = new Map(resources.map((resource) => [nodeKey(resource.creation), resource]));
  const storageWrites = collectStorageWrites(loaded);
  const settlers = collectSettlerAliases(resources, storageWrites);
  const returns = collectReturnSites(loaded, index, moduleByFilePath);
  const returnedBy = correlateReturnedResources(returns, byCreation, storageWrites, index, resolver);
  const edges: RawEdge[] = [];

  for (const resource of resources) {
    edges.push(resourceEdge(
      resource.creatorId,
      resource,
      CREATES_PROMISE_KIND,
      resource.creation,
      resource.relativeFile,
    ));
  }

  for (const site of returns) {
    const resource = returnedBy.get(site.source) ?? null;
    if (!resource) continue;
    edges.push(resourceEdge(site.source, resource, RETURNS_PROMISE_KIND, site.statement, site.relativeFile));
  }

  for (const sourceFile of loaded.sourceFiles) {
    const relativeFile = loaded.relativePathOf(sourceFile);
    for (const awaitExpression of sourceFile.getDescendantsOfKind(SyntaxKind.AwaitExpression)) {
      const resource = resourceForExpression(
        awaitExpression.getExpression(),
        byCreation,
        storageWrites,
        returnedBy,
        index,
        resolver,
      );
      if (!resource) continue;
      const source = owningNodeId(awaitExpression, index, moduleByFilePath);
      if (!source) continue;
      edges.push(resourceEdge(source, resource, AWAITS_PROMISE_KIND, awaitExpression, relativeFile));
    }
    for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const settler = settlerFor(call.getExpression(), settlers);
      if (!settler) continue;
      const source = owningNodeId(call, index, moduleByFilePath);
      if (!source) continue;
      edges.push(resourceEdge(
        source,
        settler.resource,
        settler.role === "resolve" ? RESOLVES_PROMISE_KIND : REJECTS_PROMISE_KIND,
        call,
        relativeFile,
      ));
    }
  }

  // A stored Promise that never escapes, settles, or gets awaited is ordinary local data, not a
  // causal resource. Keeping only participating resources avoids turning every short task into a
  // permanent structural node on the main map.
  const active = new Set(edges
    .filter((edge) => edge.kind !== CREATES_PROMISE_KIND)
    .map((edge) => edge.resolution.resolvedTarget)
    .filter((id): id is string => id !== null));
  const retainedEdges = edges.filter((edge) => active.has(edge.resolution.resolvedTarget ?? ""));
  return {
    nodes: resources.filter((resource) => active.has(resource.id)).map((resource) => resource.node),
    edges: retainedEdges,
    // Only a retained Promise-return edge can make an otherwise exit-only callable chartable.
    flowIds: new Set(retainedEdges
      .filter((edge) => edge.kind === RETURNS_PROMISE_KIND)
      .map((edge) => edge.source)),
  };
}

function discoverResources(
  loaded: LoadedProject,
  index: ResolutionIndex,
  moduleByFilePath: Map<string, NodeDescriptor>,
): PromiseResource[] {
  const resources: PromiseResource[] = [];
  const ordinalByBase = new Map<string, number>();
  for (const sourceFile of loaded.sourceFiles) {
    const relativeFile = loaded.relativePathOf(sourceFile);
    for (const expression of sourceFile.getDescendantsOfKind(SyntaxKind.NewExpression)) {
      if (!isGlobalPromise(expression)) continue;
      const anchor = resourceAnchor(expression, index, moduleByFilePath);
      if (!anchor) continue;
      const owner = parseNodeId(anchor.parentId);
      const ownerName = owner.qualname ?? owner.modulePath.split("/").at(-1) ?? "module";
      const qualname = `${ownerName}.${safeSegment(anchor.name)}`;
      const base = `${relativeFile}\u0000${qualname}`;
      const ordinal = ordinalByBase.get(base) ?? 0;
      ordinalByBase.set(base, ordinal + 1);
      const id = buildNodeId({ lang: "promise", modulePath: relativeFile, qualname, ordinal });
      const start = anchor.declaration.getStartLineNumber();
      const end = anchor.declaration.getEndLineNumber();
      resources.push({
        id,
        creation: expression,
        creatorId: anchor.parentId,
        relativeFile,
        node: {
          id,
          kind: PROMISE_RESOURCE_KIND,
          qualifiedName: qualname,
          displayName: anchor.name,
          parentId: anchor.parentId,
          language: "typescript",
          location: { file: relativeFile, startLine: start, ...(end === start ? {} : { endLine: end }) },
          summary: `Promise resource ${anchor.name} — creation, return, wait, and settlement share this identity`,
          tags: ["resource", "promise"],
        },
      });
    }
  }
  return resources;
}

function resourceAnchor(
  creation: NewExpression,
  index: ResolutionIndex,
  moduleByFilePath: Map<string, NodeDescriptor>,
): {
  declaration: Node;
  name: string;
  parentId: string;
} | null {
  let expression: Node = creation;
  let parent = expression.getParent();
  while (parent && isTransparentWrapper(parent)) {
    expression = parent;
    parent = expression.getParent();
  }

  let declaration: Node | null = null;
  let value: Node | null = null;
  if (parent && Node.isPropertyDeclaration(parent) && parent.getInitializer() === expression) {
    declaration = parent;
    value = parent.getNameNode();
  } else if (parent && Node.isVariableDeclaration(parent) && parent.getInitializer() === expression) {
    declaration = parent;
    value = parent.getNameNode();
  } else if (parent && Node.isBinaryExpression(parent)
    && parent.getOperatorToken().getKind() === SyntaxKind.EqualsToken
    && parent.getRight() === expression) {
    value = parent.getLeft();
    declaration = declarationsOf(value)[0] ?? null;
  }
  if (!declaration || !value) return null;

  const name = Node.isPropertyAccessExpression(value)
    ? value.getName()
    : Node.isIdentifier(value)
      ? value.getText()
      : Node.isPropertyDeclaration(declaration) || Node.isVariableDeclaration(declaration)
        ? declaration.getName()
        : "promise";
  const container = declaration.getFirstAncestor((candidate) =>
    Node.isClassDeclaration(candidate) || Node.isClassExpression(candidate));
  const parentId = container
    ? index.targetByDeclKey.get(nodeKey(container)) ?? owningNodeId(creation, index, moduleByFilePath)
    : owningNodeId(creation, index, moduleByFilePath);
  if (!parentId) return null;
  return { declaration, name, parentId };
}

function collectStorageWrites(loaded: LoadedProject): Map<string, Node[]> {
  const writes = new Map<string, Node[]>();
  for (const sourceFile of loaded.sourceFiles) {
    for (const declaration of sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
      const initializer = declaration.getInitializer();
      if (initializer) appendWrite(writes, nodeKey(declaration), initializer);
    }
    for (const declaration of sourceFile.getDescendantsOfKind(SyntaxKind.PropertyDeclaration)) {
      const initializer = declaration.getInitializer();
      if (initializer) appendWrite(writes, nodeKey(declaration), initializer);
    }
    for (const assignment of sourceFile.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
      if (assignment.getOperatorToken().getKind() !== SyntaxKind.EqualsToken) continue;
      for (const declaration of declarationsOf(assignment.getLeft())) {
        appendWrite(writes, nodeKey(declaration), assignment.getRight());
      }
    }
  }
  return writes;
}

function appendWrite(writes: Map<string, Node[]>, key: string, value: Node): void {
  writes.set(key, [...(writes.get(key) ?? []), value]);
}

function collectSettlerAliases(
  resources: readonly PromiseResource[],
  storageWrites: StorageWrites,
): SettlerAliases {
  const aliases: SettlerAliases = new Map();
  for (const resource of resources) {
    const executor = staticCallable(resource.creation.getArguments()[0]);
    if (!executor) continue;
    const parameters = executor.getParameters();
    registerAlias(parameters[0]?.getNameNode(), { resource, role: "resolve" }, aliases);
    registerAlias(parameters[1]?.getNameNode(), { resource, role: "reject" }, aliases);
  }

  // Resolve simple escape aliases (`this.done = resolve`, `const finish = this.done`) across the
  // selected program. Conflicting sources become null instead of first-wins correlation.
  for (let pass = 0; pass < MAX_ALIAS_DEPTH; pass += 1) {
    let changed = false;
    for (const [key, writes] of storageWrites) {
      for (const write of writes) {
        const alias = settlerFor(write, aliases);
        if (alias) changed = registerAliasKey(key, alias, aliases) || changed;
      }
    }
    if (!changed) break;
  }

  // A later non-settler write kills the alias. Repeat because invalidating one alias may invalidate
  // aliases copied from it. This is deliberately must-alias, not flow-sensitive may-alias.
  for (let pass = 0; pass < MAX_ALIAS_DEPTH; pass += 1) {
    let changed = false;
    for (const [key, alias] of aliases) {
      if (!alias) continue;
      const writes = storageWrites.get(key);
      if (!writes) continue; // executor parameter seed
      if (writes.some((write) => !sameSettler(settlerFor(write, aliases), alias))) {
        aliases.set(key, null);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return aliases;
}

function collectReturnSites(
  loaded: LoadedProject,
  index: ResolutionIndex,
  moduleByFilePath: Map<string, NodeDescriptor>,
): ReturnSite[] {
  const sites: ReturnSite[] = [];
  for (const sourceFile of loaded.sourceFiles) {
    const relativeFile = loaded.relativePathOf(sourceFile);
    for (const statement of sourceFile.getDescendantsOfKind(SyntaxKind.ReturnStatement)) {
      const source = owningNodeId(statement, index, moduleByFilePath);
      if (source) {
        sites.push({
          source,
          expression: statement.getExpression() ?? null,
          statement,
          relativeFile,
          preservesIdentity: !nearestCallableBoundary(statement)?.isAsync?.(),
        });
      }
    }
  }
  return sites;
}

function correlateReturnedResources(
  sites: readonly ReturnSite[],
  byCreation: ReadonlyMap<string, PromiseResource>,
  storageWrites: StorageWrites,
  index: ResolutionIndex,
  resolver: CrossPackageResolver | undefined,
): Map<string, PromiseResource | null> {
  const bySource = new Map<string, ReturnSite[]>();
  for (const site of sites) bySource.set(site.source, [...(bySource.get(site.source) ?? []), site]);
  let returnedBy = new Map<string, PromiseResource | null>();
  for (let pass = 0; pass < MAX_ALIAS_DEPTH; pass += 1) {
    const next = new Map<string, PromiseResource | null>();
    for (const [source, sourceSites] of bySource) {
      const resources = sourceSites.map((site) => site.preservesIdentity
        ? resourceForExpression(site.expression ?? undefined, byCreation, storageWrites, returnedBy, index, resolver)
        : null);
      const first = resources[0] ?? null;
      next.set(source, first !== null && resources.every((resource) => resource?.id === first.id) ? first : null);
    }
    if (sameReturnMap(returnedBy, next)) return next;
    returnedBy = next;
  }
  return returnedBy;
}

function resourceForExpression(
  node: Node | undefined,
  byCreation: ReadonlyMap<string, PromiseResource>,
  storageWrites: StorageWrites,
  returnedBy: ReadonlyMap<string, PromiseResource | null>,
  index: ResolutionIndex,
  resolver: CrossPackageResolver | undefined,
  depth = 0,
  seen: ReadonlySet<string> = new Set(),
): PromiseResource | null {
  const facts = resourceFactsForExpression(
    node, byCreation, storageWrites, returnedBy, index, resolver, depth, seen,
  );
  return !facts.unknown && facts.resources.size === 1 ? [...facts.resources.values()][0] : null;
}

function resourceFactsForExpression(
  node: Node | undefined,
  byCreation: ReadonlyMap<string, PromiseResource>,
  storageWrites: StorageWrites,
  returnedBy: ReadonlyMap<string, PromiseResource | null>,
  index: ResolutionIndex,
  resolver: CrossPackageResolver | undefined,
  depth: number,
  seen: ReadonlySet<string>,
): ResourceFacts {
  if (!node || depth > MAX_ALIAS_DEPTH) return unknownResourceFacts();
  const expression = unwrap(node);
  const expressionKey = nodeKey(expression);
  if (seen.has(expressionKey)) return unknownResourceFacts();
  const nextSeen = new Set(seen);
  nextSeen.add(expressionKey);

  if (Node.isNewExpression(expression)) {
    const resource = byCreation.get(expressionKey);
    return resource ? knownResourceFacts(resource) : unknownResourceFacts();
  }

  const declarations = declarationsOf(expression);
  if (declarations.length > 0) {
    const combined = emptyResourceFacts();
    let participated = false;
    for (const declaration of declarations) {
      const writes = storageWrites.get(nodeKey(declaration));
      if (!writes) continue;
      participated = true;
      for (const write of writes) {
        mergeResourceFacts(combined, resourceFactsForExpression(
          write, byCreation, storageWrites, returnedBy, index, resolver, depth + 1, nextSeen,
        ));
      }
    }
    return participated ? combined : unknownResourceFacts();
  }
  if (Node.isCallExpression(expression)) {
    const target = resolveTarget(expression.getExpression(), index, resolver);
    if (target.resolution === "resolved" && target.resolvedTarget) {
      const resource = returnedBy.get(target.resolvedTarget) ?? null;
      return resource ? knownResourceFacts(resource) : unknownResourceFacts();
    }
  }
  // Await and async return adopt another Promise's state but never preserve its object identity.
  return unknownResourceFacts();
}

function emptyResourceFacts(): ResourceFacts {
  return { resources: new Map(), unknown: false };
}

function knownResourceFacts(resource: PromiseResource): ResourceFacts {
  return { resources: new Map([[resource.id, resource]]), unknown: false };
}

function unknownResourceFacts(): ResourceFacts {
  return { resources: new Map(), unknown: true };
}

function mergeResourceFacts(target: ResourceFacts, source: ResourceFacts): void {
  source.resources.forEach((resource, id) => target.resources.set(id, resource));
  target.unknown ||= source.unknown;
}

function sameReturnMap(
  left: ReadonlyMap<string, PromiseResource | null>,
  right: ReadonlyMap<string, PromiseResource | null>,
): boolean {
  return left.size === right.size
    && [...left].every(([key, value]) => right.has(key) && right.get(key)?.id === value?.id);
}

function settlerFor(node: Node | undefined, aliases: ReadonlyMap<string, SettlerAlias | null>): SettlerAlias | null {
  if (!node) return null;
  const expression = unwrap(node);
  for (const declaration of declarationsOf(expression)) {
    const alias = aliases.get(nodeKey(declaration));
    if (alias) return alias;
  }
  return null;
}

function registerAlias(
  node: Node | undefined,
  alias: SettlerAlias,
  aliases: SettlerAliases,
): boolean {
  if (!node) return false;
  let changed = false;
  for (const declaration of declarationsOf(node)) {
    changed = registerAliasKey(nodeKey(declaration), alias, aliases) || changed;
  }
  return changed;
}

function registerAliasKey(key: string, alias: SettlerAlias, aliases: SettlerAliases): boolean {
  const current = aliases.get(key);
  if (current === undefined) {
    aliases.set(key, alias);
    return true;
  }
  if (current === null || sameSettler(current, alias)) return false;
  aliases.set(key, null);
  return true;
}

function sameSettler(left: SettlerAlias | null, right: SettlerAlias): boolean {
  return left !== null && left.resource.id === right.resource.id && left.role === right.role;
}

function declarationsOf(node: Node): Node[] {
  const expression = unwrap(node);
  if (Node.isIdentifier(expression)) return expression.getSymbol()?.getDeclarations() ?? [];
  if (Node.isPropertyAccessExpression(expression)) return expression.getNameNode().getSymbol()?.getDeclarations() ?? [];
  return [];
}

function resourceEdge(
  source: string,
  resource: PromiseResource,
  kind: string,
  site: Node,
  relativeFile: string,
): RawEdge {
  return {
    source,
    kind,
    resolution: resolved(resource.id),
    callSite: callSiteOf(site, relativeFile),
  };
}

function resolved(target: string): TargetResolution {
  return {
    resolution: "resolved",
    resolvedTarget: target,
    externalModulePath: null,
    externalQualname: null,
    threw: false,
  };
}

function owningNodeId(
  site: Node,
  index: ResolutionIndex,
  moduleByFilePath: Map<string, NodeDescriptor>,
): string {
  let current: Node | undefined = site;
  while (current) {
    const enclosing = index.sourceByCallableKey.get(nodeKey(current));
    if (enclosing) return enclosing;
    if (current !== site && isCallableBoundary(current)) return "";
    current = current.getParent();
  }
  return moduleByFilePath.get(site.getSourceFile().getFilePath())?.finalId ?? "";
}

function isGlobalPromise(expression: NewExpression): boolean {
  const callee = expression.getExpression();
  const symbol = Node.isIdentifier(callee) && callee.getText() === "Promise"
    ? callee.getSymbol()
    : Node.isPropertyAccessExpression(callee)
      && Node.isIdentifier(callee.getExpression())
      && callee.getExpression().getText() === "globalThis"
      && callee.getName() === "Promise"
        ? callee.getNameNode().getSymbol()
        : undefined;
  const declarations = symbol?.getDeclarations() ?? [];
  return declarations.length > 0 && declarations.every(isTypeScriptLibDeclaration);
}

function isTypeScriptLibDeclaration(declaration: Node): boolean {
  const path = declaration.getSourceFile().getFilePath().replaceAll("\\", "/");
  return /\/typescript\/lib\/lib\.[^/]+\.d\.ts$/.test(path);
}

function nearestCallableBoundary(node: Node): (Node & { isAsync?(): boolean }) | null {
  let current = node.getParent();
  while (current) {
    if (isCallableBoundary(current)) return current as Node & { isAsync?(): boolean };
    current = current.getParent();
  }
  return null;
}

function isCallableBoundary(node: Node): boolean {
  return Node.isFunctionDeclaration(node)
    || Node.isFunctionExpression(node)
    || Node.isArrowFunction(node)
    || Node.isMethodDeclaration(node)
    || Node.isConstructorDeclaration(node)
    || Node.isGetAccessorDeclaration(node)
    || Node.isSetAccessorDeclaration(node);
}

function safeSegment(value: string): string {
  return value.replace(/^#/, "private-").replace(/[^a-zA-Z0-9_$.-]/g, "-");
}

function unwrap(node: Node): Node {
  let current = node;
  while (isTransparentWrapper(current)) current = current.getExpression();
  return current;
}

function isTransparentWrapper(node: Node): node is Node & { getExpression(): Node } {
  return Node.isParenthesizedExpression(node) || Node.isNonNullExpression(node)
    || Node.isAsExpression(node) || Node.isSatisfiesExpression(node) || Node.isTypeAssertion(node);
}
