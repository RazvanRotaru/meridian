/**
 * The recursive declaration walk: classes -> methods, interfaces -> method signatures,
 * top-level and lexically nested functions plus callable-binding consts/properties/default exports (see
 * `resolveCallableBinding` — inline callables, possibly under `memo`/`forwardRef`), object-literal
 * consts -> methods, constructed singleton objects, and namespaces (recursed). Emission is top-down
 * so a child's parent descriptor always already exists.
 */

import {
  Node,
  type ClassDeclaration,
  type ConstructorDeclaration,
  type FunctionDeclaration,
  type GetAccessorDeclaration,
  type InterfaceDeclaration,
  type MethodDeclaration,
  type ModuleDeclaration,
  type SetAccessorDeclaration,
  type SourceFile,
  type VariableDeclaration,
} from "ts-morph";
import type { NodeKind } from "@meridian/core";
import { memberDescriptor, type IdContext } from "./descriptor-factory";
import { resolveCallableBinding, type CallableBinding } from "./inline-callables";
import type { NodeDescriptor } from "./model";
import type { SignatureLike } from "./node-fields";

type Container = SourceFile | ModuleDeclaration;
type CallableMember = ConstructorDeclaration | MethodDeclaration | GetAccessorDeclaration | SetAccessorDeclaration;

export interface EmitContext extends IdContext {
  emit: (descriptor: NodeDescriptor) => NodeDescriptor;
}

export function emitContainer(
  container: Container,
  parent: NodeDescriptor,
  enclosingNames: string[],
  context: EmitContext,
): void {
  for (const declaration of container.getClasses()) emitClass(declaration, parent, enclosingNames, context);
  for (const declaration of container.getInterfaces()) emitInterface(declaration, parent, enclosingNames, context);
  for (const declaration of container.getFunctions()) emitFunction(declaration, parent, enclosingNames, context);
  emitDefaultExports(container, parent, enclosingNames, context);
  for (const declaration of container.getVariableDeclarations()) emitVariable(declaration, parent, enclosingNames, context);
  for (const declaration of container.getModules()) emitNamespace(declaration, parent, enclosingNames, context);
}

function emitClass(node: ClassDeclaration, parent: NodeDescriptor, enclosingNames: string[], context: EmitContext): void {
  const name = node.getName() ?? "default";
  const self = context.emit(
    memberDescriptor(context, container("class", name, enclosingNames, parent, node)),
  );
  const inner = [...enclosingNames, name];
  for (const member of node.getConstructors()) emitCallable(member, "constructor", self, inner, context);
  for (const member of node.getMethods()) emitCallable(member, member.getName(), self, inner, context);
  for (const member of node.getGetAccessors()) emitCallable(member, member.getName(), self, inner, context);
  for (const member of node.getSetAccessors()) emitCallable(member, member.getName(), self, inner, context);
  for (const member of node.getProperties()) {
    const binding = resolveCallableBinding(member.getInitializer());
    if (binding) emitBinding(binding, "method", member.getName(), member, self, inner, context);
  }
}

function emitInterface(node: InterfaceDeclaration, parent: NodeDescriptor, enclosingNames: string[], context: EmitContext): void {
  const self = context.emit(
    memberDescriptor(context, container("interface", node.getName(), enclosingNames, parent, node)),
  );
  const inner = [...enclosingNames, node.getName()];
  for (const method of node.getMethods()) {
    context.emit(
      memberDescriptor(context, {
        kind: "method", localName: method.getName(), enclosingNames: inner, parent: self,
        declarationNode: method, callableNode: null, signatureSource: method, emitTelemetry: true,
      }),
    );
  }
}

function emitNamespace(node: ModuleDeclaration, parent: NodeDescriptor, enclosingNames: string[], context: EmitContext): void {
  const name = node.getName();
  const self = context.emit(
    memberDescriptor(context, container("namespace", name, enclosingNames, parent, node)),
  );
  emitContainer(node, self, [...enclosingNames, name], context);
}

function emitFunction(node: FunctionDeclaration, parent: NodeDescriptor, enclosingNames: string[], context: EmitContext): void {
  const name = node.getName() ?? "default";
  const self = context.emit(
    memberDescriptor(context, {
      kind: "function", localName: name, enclosingNames, parent,
      declarationNode: node, callableNode: bodyOf(node), signatureSource: node, emitTelemetry: true,
    }),
  );
  emitNestedCallables(bodyOf(node), self, [...enclosingNames, name], context);
}

function emitCallable(node: CallableMember, name: string, parent: NodeDescriptor, enclosingNames: string[], context: EmitContext): void {
  const self = context.emit(
    memberDescriptor(context, {
      kind: "method", localName: name, enclosingNames, parent,
      declarationNode: node, callableNode: bodyOf(node), signatureSource: node, emitTelemetry: true,
    }),
  );
  emitNestedCallables(bodyOf(node), self, [...enclosingNames, name], context);
}

// `export default () => …` / `export default memo(() => …)`: an anonymous default export whose
// expression binds a callable is named "default", like `export default function () {}`.
// `export = expr` is NOT a default export — it re-exports an existing declaration, so no node.
function emitDefaultExports(node: Container, parent: NodeDescriptor, enclosingNames: string[], context: EmitContext): void {
  for (const statement of node.getStatements()) {
    if (!Node.isExportAssignment(statement) || statement.isExportEquals()) {
      continue;
    }
    const binding = resolveCallableBinding(statement.getExpression());
    if (binding) emitBinding(binding, "function", "default", statement, parent, enclosingNames, context);
  }
}

// A callable-binding const emits a function node; an object-literal const emits a container node
// whose function-valued members are methods; and a `new`-initialized binding emits the constructed
// singleton as an object node. Only Identifier-named declarations qualify — a
// destructuring pattern (`const { save } = buildApi(…)`) binds pieces, and its pattern text would
// make a malformed node id.
function emitVariable(node: VariableDeclaration, parent: NodeDescriptor, enclosingNames: string[], context: EmitContext): void {
  if (!Node.isIdentifier(node.getNameNode())) {
    return;
  }
  const binding = resolveCallableBinding(node.getInitializer());
  if (binding) {
    emitBinding(binding, "function", node.getName(), node, parent, enclosingNames, context);
    return;
  }
  const initializer = node.getInitializer();
  if (Node.isObjectLiteralExpression(initializer)) {
    emitObjectLiteralConst(node, parent, enclosingNames, context);
    return;
  }
  if (Node.isNewExpression(initializer)) {
    emitConstructedObject(node, parent, enclosingNames, context);
  }
}

function emitConstructedObject(node: VariableDeclaration, parent: NodeDescriptor, enclosingNames: string[], context: EmitContext): void {
  context.emit(
    memberDescriptor(context, container("object", node.getName(), enclosingNames, parent, node)),
  );
}

function emitObjectLiteralConst(node: VariableDeclaration, parent: NodeDescriptor, enclosingNames: string[], context: EmitContext): void {
  const name = node.getName();
  const self = context.emit(
    memberDescriptor(context, container("object", name, enclosingNames, parent, node)),
  );
  const object = node.getInitializer();
  if (!Node.isObjectLiteralExpression(object)) {
    return;
  }
  const inner = [...enclosingNames, name];
  for (const property of object.getProperties()) emitObjectMember(property, self, inner, context);
}

// One object-literal property. We stay one level deep, so nested object literals are not recursed.
function emitObjectMember(property: Node, parent: NodeDescriptor, enclosingNames: string[], context: EmitContext): void {
  if (Node.isMethodDeclaration(property) || Node.isGetAccessorDeclaration(property) || Node.isSetAccessorDeclaration(property)) {
    emitCallable(property, property.getName(), parent, enclosingNames, context);
    return;
  }
  if (Node.isPropertyAssignment(property)) {
    const binding = resolveCallableBinding(property.getInitializer());
    if (binding) emitBinding(binding, "method", property.getName(), property, parent, enclosingNames, context);
  }
}

// The one emission path for every callable-binding declaration (const, class property, object
// member, default export), so the same expression yields the same graph regardless of syntactic
// position. A `body` binding carries the unwrapped callable; an `alias` stays bodiless — the
// referenced component's body is its own node's flow.
function emitBinding(
  binding: CallableBinding,
  kind: NodeKind,
  localName: string,
  declarationNode: Node,
  parent: NodeDescriptor,
  enclosingNames: string[],
  context: EmitContext,
): void {
  const callable = binding.kind === "body" ? binding.callable : null;
  const self = context.emit(
    memberDescriptor(context, {
      kind, localName, enclosingNames, parent,
      declarationNode,
      modifierSource: callable,
      callableNode: callable,
      signatureSource: bindingSignatureSource(callable, declarationNode),
      emitTelemetry: true,
    }),
  );
  emitNestedCallables(callable, self, [...enclosingNames, localName], context);
}

/**
 * Emit lexically named callables that live inside another callable. These helpers are real graph
 * participants: calls inside them execute under their own identity, and calls to them are the
 * causal bridge between an enclosing callback and the work it schedules. Anonymous callbacks
 * remain flow steps on their nearest named owner, but we deliberately walk through them so a
 * declaration such as `events.on("ready", () => { const synchronize = () => ... })` is retained.
 *
 * A named callable owns its own recursive scan; skipping its subtree here prevents duplicate
 * descriptors. Class/module boundaries are independent declaration containers and must not be
 * re-parented beneath the surrounding function.
 */
function emitNestedCallables(
  callable: Node | null,
  parent: NodeDescriptor,
  enclosingNames: string[],
  context: EmitContext,
): void {
  if (!callable) return;

  const visit = (node: Node): void => {
    for (const child of node.getChildren()) {
      if (Node.isFunctionDeclaration(child)) {
        emitFunction(child, parent, enclosingNames, context);
        continue;
      }

      if (Node.isVariableDeclaration(child) && Node.isIdentifier(child.getNameNode())) {
        const binding = resolveCallableBinding(child.getInitializer());
        if (binding) {
          emitBinding(binding, "function", child.getName(), child, parent, enclosingNames, context);
          continue;
        }
      }

      if (
        Node.isClassDeclaration(child) ||
        Node.isInterfaceDeclaration(child) ||
        Node.isModuleDeclaration(child)
      ) {
        continue;
      }

      visit(child);
    }
  };

  visit(callable);
}

function container(kind: "class" | "interface" | "namespace" | "object", localName: string, enclosingNames: string[], parent: NodeDescriptor, declarationNode: Node) {
  return { kind, localName, enclosingNames, parent, declarationNode, callableNode: null, signatureSource: null, emitTelemetry: false };
}

function asSignature(node: Node | null): SignatureLike | null {
  return node ? (node as unknown as SignatureLike) : null;
}

/** Prefer the inline callable's own annotation. When it omits one, a direct contextual function
 * type on the binding is still source-level proof (`const load: (...) => Promise<X> = ...`). */
function bindingSignatureSource(callable: Node | null, declarationNode: Node): SignatureLike | null {
  const inline = asSignature(callable);
  if (inline?.getReturnTypeNode()) return inline;
  const contextual = (declarationNode as { getTypeNode?(): Node | undefined }).getTypeNode?.();
  return contextual && Node.isFunctionTypeNode(contextual)
    ? contextual as unknown as SignatureLike
    : inline;
}

function bodyOf(node: Node): Node | null {
  return (node as { getBody?(): Node | undefined }).getBody?.() ?? null;
}
