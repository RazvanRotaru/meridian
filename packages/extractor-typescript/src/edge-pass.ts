/**
 * Edge pass: one walk over calls, explicit container composition, `new` expressions, JSX
 * composition, and class extends/implements. Each occurrence becomes a `RawEdge` carrying its
 * honest resolution and a call site; aggregation and the drop/include policy happen downstream.
 */

import { Node, SyntaxKind, type ClassDeclaration } from "ts-morph";
import type { CallSite, EdgeKind, ExtractionDiagnostic } from "@meridian/core";
import { callSiteOf, nodeKey, type NodeDescriptor } from "./model";
import { resolveTarget, type CrossPackageResolver, type TargetResolution } from "./edge-resolve";
import type { LoadedProject } from "./project-loader";
import type { ResolutionIndex } from "./resolution-index";

export { callSiteOf } from "./model";

export interface RawEdge {
  source: string;
  kind: EdgeKind;
  resolution: TargetResolution;
  callSite: CallSite;
}

export function collectRawEdges(
  loaded: LoadedProject,
  descriptors: NodeDescriptor[],
  index: ResolutionIndex,
  moduleByFilePath: Map<string, NodeDescriptor>,
  diagnostics: ExtractionDiagnostic[],
  resolver?: CrossPackageResolver,
): RawEdge[] {
  const edges: RawEdge[] = [];
  for (const sourceFile of loaded.sourceFiles) {
    const relPath = loaded.relativePathOf(sourceFile);
    collectBehaviouralEdges(sourceFile, relPath, index, moduleByFilePath, diagnostics, edges, resolver);
  }
  for (const descriptor of descriptors) {
    collectInheritanceEdges(descriptor, index, diagnostics, edges, resolver);
  }
  return edges;
}

function collectBehaviouralEdges(
  sourceFile: { getDescendantsOfKind(kind: SyntaxKind): Node[] },
  relPath: string,
  index: ResolutionIndex,
  moduleByFilePath: Map<string, NodeDescriptor>,
  diagnostics: ExtractionDiagnostic[],
  edges: RawEdge[],
  resolver?: CrossPackageResolver,
): void {
  for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    addCallableEdge(call, calleeOf(call), "calls", relPath, index, moduleByFilePath, diagnostics, edges, resolver);
    collectExplicitRegistration(call, relPath, index, moduleByFilePath, diagnostics, edges, resolver);
    collectExplicitInjection(call, relPath, index, moduleByFilePath, diagnostics, edges, resolver);
  }
  for (const expression of sourceFile.getDescendantsOfKind(SyntaxKind.NewExpression)) {
    addCallableEdge(expression, calleeOf(expression), "instantiates", relPath, index, moduleByFilePath, diagnostics, edges, resolver);
  }
  collectReferenceEdges(sourceFile, relPath, index, moduleByFilePath, diagnostics, edges, resolver);
  collectRenderEdges(sourceFile, relPath, index, moduleByFilePath, diagnostics, edges, resolver);
}

/**
 * Conservative service-container composition inference. A structural `registers` edge is added
 * only for the conventional shapes `container.register(key, value)` or
 * `providerRegistry.register(value)`, when:
 *
 *  - the receiver's value name or static type is container/registry/injector/services-like; and
 *  - `value` is an emitted declaration, or `new Class()` whose class is emitted.
 *
 * The ordinary `calls` edge to `register` (and an `instantiates` edge for `new Class()`) is still
 * collected by the behavioural pass. Requiring a semantic receiver prevents unrelated
 * one-argument domain methods such as `users.register(request)`, generic
 * `helper.register(key, value)` calls, and `Map.set` from becoming composition.
 */
function collectExplicitRegistration(
  call: Node,
  relPath: string,
  index: ResolutionIndex,
  moduleByFilePath: Map<string, NodeDescriptor>,
  diagnostics: ExtractionDiagnostic[],
  edges: RawEdge[],
  resolver?: CrossPackageResolver,
): void {
  if (!Node.isCallExpression(call)) {
    return;
  }
  const callee = call.getExpression();
  if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== "register") {
    return;
  }
  const args = call.getArguments();
  if ((args.length !== 1 && args.length !== 2) || !isContainerLike(callee.getExpression())) {
    return;
  }
  const target = registeredTarget(args.at(-1)!);
  addResolvedCompositionEdge(call, target, "registers", relPath, index, moduleByFilePath, diagnostics, edges, resolver);
}

/** `container.get<Service>()` explicitly requests a service type from a semantic container. */
function collectExplicitInjection(
  call: Node,
  relPath: string,
  index: ResolutionIndex,
  moduleByFilePath: Map<string, NodeDescriptor>,
  diagnostics: ExtractionDiagnostic[],
  edges: RawEdge[],
  resolver?: CrossPackageResolver,
): void {
  if (!Node.isCallExpression(call)) {
    return;
  }
  const callee = call.getExpression();
  if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== "get" || !isContainerLike(callee.getExpression())) {
    return;
  }
  const typeArgs = call.getTypeArguments();
  if (typeArgs.length !== 1) {
    return;
  }
  const requestedType = typeArgs[0]!;
  const target = Node.isTypeReference(requestedType) ? typeNameOf(requestedType) : requestedType;
  addResolvedCompositionEdge(call, target, "injects", relPath, index, moduleByFilePath, diagnostics, edges, resolver);
}

/** Add only composition whose target is known here, or is eligible for the workspace join. */
function addResolvedCompositionEdge(
  site: Node,
  target: Node,
  kind: "registers" | "injects",
  relPath: string,
  index: ResolutionIndex,
  moduleByFilePath: Map<string, NodeDescriptor>,
  diagnostics: ExtractionDiagnostic[],
  edges: RawEdge[],
  resolver?: CrossPackageResolver,
): void {
  const resolution = resolveTarget(target, index, resolver);
  recordThrow(resolution, relPath, site, diagnostics);
  // Composition describes known code structure, not a speculative dynamic/external dependency.
  // A pending ref is retained in bounded per-package extraction so the workspace join can make it
  // resolved; every other unresolved/external value is deliberately ignored.
  if (resolution.resolution !== "resolved" && resolution.pending === undefined) {
    return;
  }
  const source = enclosingSemanticDeclaration(site, index)
    ?? moduleByFilePath.get(site.getSourceFile().getFilePath())?.finalId
    ?? "";
  edges.push({ source, kind, resolution, callSite: callSiteOf(site, relPath) });
}

/** The semantic declaration named by a registered value, unwrapping the common `new Service()`. */
function registeredTarget(value: Node): Node {
  return Node.isNewExpression(value) ? value.getExpression() : value;
}

const CONTAINER_NAME = /(?:container|registry|injector|services?)$/i;

/** Receiver syntax and static type both carry useful intent (`services`, or `c: AppContainer`). */
function isContainerLike(receiver: Node): boolean {
  const syntacticName = Node.isIdentifier(receiver)
    ? receiver.getText()
    : Node.isPropertyAccessExpression(receiver)
      ? receiver.getName()
      : "";
  if (syntacticName === "di" || CONTAINER_NAME.test(syntacticName)) {
    return true;
  }
  try {
    const type = receiver.getType();
    const typeName = type.getAliasSymbol()?.getName() ?? type.getSymbol()?.getName() ?? "";
    return typeName === "DI" || CONTAINER_NAME.test(typeName);
  } catch {
    return false;
  }
}

/**
 * Type dependencies: a symbol used in a TYPE POSITION — a parameter or return annotation, a property
 * type, a type argument (`Promise<FsReadFileResult>`) — becomes a `references` edge from the enclosing
 * callable/type declaration (or the module, for a top-level type) to that type's definition. This
 * is what makes a types/protocol module read as USED: `foo(req: FsReadFileRequest)` couples `foo`
 * to the interface even though it never calls or extends it. `extends`/`implements` live in heritage
 * clauses (not TypeReference nodes), so they never double-count here; built-in/lib types resolve external and drop.
 */
function collectReferenceEdges(
  sourceFile: { getDescendantsOfKind(kind: SyntaxKind): Node[] },
  relPath: string,
  index: ResolutionIndex,
  moduleByFilePath: Map<string, NodeDescriptor>,
  diagnostics: ExtractionDiagnostic[],
  edges: RawEdge[],
  resolver?: CrossPackageResolver,
): void {
  for (const ref of sourceFile.getDescendantsOfKind(SyntaxKind.TypeReference)) {
    addCallableEdge(ref, typeNameOf(ref), "references", relPath, index, moduleByFilePath, diagnostics, edges, resolver);
  }
}

/** A TypeReference's name node (`FsReadFileResult`, or the `A.B` entity), the thing to resolve. */
const typeNameOf = (node: Node): Node => (node as unknown as { getTypeName(): Node }).getTypeName();

// Both JSX element forms; an element is exactly one of them, so walking both never double-counts.
const JSX_ELEMENT_KINDS = [SyntaxKind.JsxOpeningElement, SyntaxKind.JsxSelfClosingElement] as const;

/**
 * React composition: every JSX `<Child/>` in a component body becomes a `renders` edge to the
 * child's declaration. Host/intrinsic tags (lowercase `<div>`) and fragments carry no edge; the
 * tag name resolves exactly like a call callee and the source walks up to the nearest emitted
 * component, so `<ProductCard/>` inside `items.map(...)` is sourced from the enclosing component.
 */
function collectRenderEdges(
  sourceFile: { getDescendantsOfKind(kind: SyntaxKind): Node[] },
  relPath: string,
  index: ResolutionIndex,
  moduleByFilePath: Map<string, NodeDescriptor>,
  diagnostics: ExtractionDiagnostic[],
  edges: RawEdge[],
  resolver?: CrossPackageResolver,
): void {
  for (const kind of JSX_ELEMENT_KINDS) {
    for (const element of sourceFile.getDescendantsOfKind(kind)) {
      const tag = componentTagOf(element);
      if (tag) {
        addCallableEdge(element, tag, "renders", relPath, index, moduleByFilePath, diagnostics, edges, resolver);
      }
    }
  }
}

/** The tag-name node when the element names a component (`<NavBar/>`, `<Foo.Bar/>`); null for host tags. */
function componentTagOf(element: Node): Node | null {
  if (!Node.isJsxOpeningElement(element) && !Node.isJsxSelfClosingElement(element)) {
    return null;
  }
  const tag = element.getTagNameNode();
  if (Node.isPropertyAccessExpression(tag)) {
    return tag; // A dotted tag (`<Foo.Bar/>`) is always a component reference, never a host element.
  }
  // React's rule: a lowercase-initial identifier is an intrinsic host element, not a component.
  return Node.isIdentifier(tag) && !startsLowercase(tag.getText()) ? tag : null;
}

function startsLowercase(text: string): boolean {
  const first = text.charAt(0);
  return first >= "a" && first <= "z";
}

function addCallableEdge(
  site: Node,
  callee: Node,
  kind: EdgeKind,
  relPath: string,
  index: ResolutionIndex,
  moduleByFilePath: Map<string, NodeDescriptor>,
  diagnostics: ExtractionDiagnostic[],
  edges: RawEdge[],
  resolver?: CrossPackageResolver,
): void {
  const resolution = resolveTarget(callee, index, resolver);
  recordThrow(resolution, relPath, site, diagnostics);
  const enclosing = kind === "references"
    ? enclosingSemanticDeclaration(site, index)
    : enclosingCallable(site, index);
  if (enclosing === null && kind === "renders") {
    return; // a module can call/instantiate at load time, but it cannot render JSX
  }
  const source = enclosing ?? moduleByFilePath.get(site.getSourceFile().getFilePath())?.finalId ?? "";
  edges.push({ source, kind, resolution, callSite: callSiteOf(site, relPath) });
}

function collectInheritanceEdges(
  descriptor: NodeDescriptor,
  index: ResolutionIndex,
  diagnostics: ExtractionDiagnostic[],
  edges: RawEdge[],
  resolver?: CrossPackageResolver,
): void {
  const node = descriptor.declarationNode;
  if (!node) {
    return;
  }
  const relPath = descriptor.location.file;
  if (Node.isClassDeclaration(node)) {
    collectClassInheritance(node, descriptor.finalId, relPath, index, diagnostics, edges, resolver);
    return;
  }
  if (Node.isInterfaceDeclaration(node)) {
    // Interfaces can extend multiple bases, so getExtends() is an array.
    for (const base of node.getExtends()) {
      addInheritanceEdge(base, "extends", descriptor.finalId, relPath, index, diagnostics, edges, resolver);
    }
  }
}

function collectClassInheritance(
  node: ClassDeclaration,
  source: string,
  relPath: string,
  index: ResolutionIndex,
  diagnostics: ExtractionDiagnostic[],
  edges: RawEdge[],
  resolver?: CrossPackageResolver,
): void {
  const base = node.getExtends();
  if (base) {
    addInheritanceEdge(base, "extends", source, relPath, index, diagnostics, edges, resolver);
  }
  for (const contract of node.getImplements()) {
    addInheritanceEdge(contract, "implements", source, relPath, index, diagnostics, edges, resolver);
  }
}

function addInheritanceEdge(
  expression: { getExpression(): Node } & Node,
  kind: EdgeKind,
  source: string,
  relPath: string,
  index: ResolutionIndex,
  diagnostics: ExtractionDiagnostic[],
  edges: RawEdge[],
  resolver?: CrossPackageResolver,
): void {
  const resolution = resolveTarget(expression.getExpression(), index, resolver);
  recordThrow(resolution, relPath, expression, diagnostics);
  edges.push({ source, kind, resolution, callSite: callSiteOf(expression, relPath) });
}

function calleeOf(node: Node): Node {
  return (node as unknown as { getExpression(): Node }).getExpression();
}

/** The nearest enclosing emitted callable, or null when the site sits at module top level. */
export function enclosingCallable(site: Node, index: ResolutionIndex): string | null {
  let current = site.getParent();
  // A SourceFile and its first declaration can both start at offset zero. Source files are not
  // callable declarations, and looking them up by nodeKey can therefore alias that declaration.
  while (current && !Node.isSourceFile(current)) {
    const enclosing = index.sourceByCallableKey.get(nodeKey(current));
    if (enclosing) {
      return enclosing;
    }
    current = current.getParent();
  }
  return null;
}

/**
 * The nearest emitted declaration enclosing a type reference. Type annotations in a callable's
 * parameters and return type sit outside its body, so the behavioural body index cannot see them.
 * Declaration ancestry also gives un-emitted class/interface properties to their owning type,
 * while a reference with no emitted declaration ancestor remains a module-level reference.
 */
function enclosingSemanticDeclaration(site: Node, index: ResolutionIndex): string | null {
  let current = site.getParent();
  // Stop before SourceFile for the same offset-zero reason as enclosingCallable: module ownership
  // is represented by the explicit fallback, never by a declaration sharing the file's start.
  while (current && !Node.isSourceFile(current)) {
    const enclosing = index.sourceBySemanticDeclKey.get(nodeKey(current));
    if (enclosing) {
      return enclosing;
    }
    current = current.getParent();
  }
  return null;
}

export function recordThrow(resolution: TargetResolution, relPath: string, node: Node, diagnostics: ExtractionDiagnostic[]): void {
  if (resolution.threw) {
    diagnostics.push({ severity: "warn", message: `symbol resolution threw at ${relPath}:${node.getStartLineNumber()}` });
  }
}
