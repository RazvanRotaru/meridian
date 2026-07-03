/**
 * The recursive declaration walk: classes -> methods, interfaces -> method signatures,
 * top-level functions and arrow consts, object-literal consts -> methods, and namespaces
 * (recursed). Emission is top-down so a child's parent descriptor always already exists.
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
  type PropertyDeclaration,
  type SetAccessorDeclaration,
  type SourceFile,
  type VariableDeclaration,
} from "ts-morph";
import { memberDescriptor, type IdContext } from "./descriptor-factory";
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
  for (const declaration of arrowConsts(container)) emitArrowConst(declaration, parent, enclosingNames, context);
  for (const declaration of objectLiteralConsts(container)) emitObjectLiteralConst(declaration, parent, enclosingNames, context);
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
  for (const member of arrowProperties(node)) emitArrowProperty(member, self, inner, context);
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
  context.emit(
    memberDescriptor(context, {
      kind: "function", localName: node.getName() ?? "default", enclosingNames, parent,
      declarationNode: node, callableNode: bodyOf(node), signatureSource: node, emitTelemetry: true,
    }),
  );
}

function emitCallable(node: CallableMember, name: string, parent: NodeDescriptor, enclosingNames: string[], context: EmitContext): void {
  context.emit(
    memberDescriptor(context, {
      kind: "method", localName: name, enclosingNames, parent,
      declarationNode: node, callableNode: bodyOf(node), signatureSource: node, emitTelemetry: true,
    }),
  );
}

function emitArrowConst(node: VariableDeclaration, parent: NodeDescriptor, enclosingNames: string[], context: EmitContext): void {
  const initializer = node.getInitializer();
  context.emit(
    memberDescriptor(context, {
      kind: "function", localName: node.getName(), enclosingNames, parent,
      declarationNode: node, callableNode: initializer ?? null, signatureSource: asSignature(initializer), emitTelemetry: true,
    }),
  );
}

function emitArrowProperty(node: PropertyDeclaration, parent: NodeDescriptor, enclosingNames: string[], context: EmitContext): void {
  const initializer = node.getInitializer();
  context.emit(
    memberDescriptor(context, {
      kind: "method", localName: node.getName(), enclosingNames, parent,
      declarationNode: node, callableNode: initializer ?? null, signatureSource: asSignature(initializer), emitTelemetry: true,
    }),
  );
}

// A const bound to an object literal is a container node; its function-valued members are methods.
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
  if (Node.isPropertyAssignment(property) && isCallableInitializer(property.getInitializer())) {
    const initializer = property.getInitializer();
    context.emit(
      memberDescriptor(context, {
        kind: "method", localName: property.getName(), enclosingNames, parent,
        declarationNode: property, callableNode: initializer ?? null, signatureSource: asSignature(initializer), emitTelemetry: true,
      }),
    );
  }
}

function container(kind: "class" | "interface" | "namespace" | "object", localName: string, enclosingNames: string[], parent: NodeDescriptor, declarationNode: Node) {
  return { kind, localName, enclosingNames, parent, declarationNode, callableNode: null, signatureSource: null, emitTelemetry: false };
}

function arrowConsts(node: Container): VariableDeclaration[] {
  return node.getVariableDeclarations().filter((declaration) => isCallableInitializer(declaration.getInitializer()));
}

function objectLiteralConsts(node: Container): VariableDeclaration[] {
  return node.getVariableDeclarations().filter((declaration) => Node.isObjectLiteralExpression(declaration.getInitializer()));
}

function arrowProperties(node: ClassDeclaration): PropertyDeclaration[] {
  return node.getProperties().filter((property) => isCallableInitializer(property.getInitializer()));
}

function isCallableInitializer(node: Node | undefined): boolean {
  return !!node && (Node.isArrowFunction(node) || Node.isFunctionExpression(node));
}

function asSignature(node: Node | undefined): SignatureLike | null {
  return node ? (node as unknown as SignatureLike) : null;
}

function bodyOf(node: Node): Node | null {
  return (node as { getBody?(): Node | undefined }).getBody?.() ?? null;
}
