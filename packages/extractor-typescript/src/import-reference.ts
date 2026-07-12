/**
 * Recover the import binding behind a type/value/member reference. TypeScript's checker gives us
 * declaration nodes when dependencies are installed, but cloned repos often have no node_modules;
 * the source import still carries a stable module specifier and exported name in either case.
 */

import { Node, SyntaxKind, ts, type SourceFile, type Symbol as TsSymbol } from "ts-morph";

export interface ImportedSymbolReference {
  specifier: string;
  /** Null means the imported namespace/module as a value rather than one exported binding. */
  exportedName: string | null;
  fromFile: string;
  /** The checker-resolved target, when present. Used only to decide whether it is in extraction scope. */
  targetFile: string | null;
  targetSourceFile: SourceFile | null;
}

export function importedSymbolReference(reference: Node, original: TsSymbol | undefined): ImportedSymbolReference | null {
  return (
    namespaceMemberReference(reference) ??
    importedClassMemberReference(reference) ??
    receiverTypedReference(reference) ??
    bindingReference(original) ??
    unresolvedDirectBinding(reference, original)
  );
}

/** `import * as sdk from "pkg"; sdk.run()` and the type-position `sdk.Contract`. */
function namespaceMemberReference(reference: Node): ImportedSymbolReference | null {
  const member = memberAccess(reference);
  if (member === null || !Node.isIdentifier(member.receiver)) {
    return null;
  }
  const carrier = namespaceImportCarrier(member.receiver.getSymbol()) ??
    (member.receiver.getSymbol() === undefined ? namespaceImportByName(member.receiver) : null);
  return carrier === null ? null : referenceFromCarrier(carrier, member.name);
}

function memberAccess(reference: Node): { receiver: Node; name: string } | null {
  if (Node.isPropertyAccessExpression(reference)) {
    return { receiver: reference.getExpression(), name: reference.getNameNode().getText() };
  }
  if (Node.isQualifiedName(reference)) {
    return { receiver: reference.getLeft(), name: reference.getRight().getText() };
  }
  return null;
}

function namespaceImportCarrier(symbol: TsSymbol | undefined): Node | null {
  const declaration = symbol?.getDeclarations().find(Node.isNamespaceImport);
  return declaration ? moduleCarrier(declaration) : null;
}

function namespaceImportByName(identifier: Node): Node | null {
  const name = identifier.getText();
  return identifier.getSourceFile().getImportDeclarations().find(
    (declaration) => declaration.getNamespaceImport()?.getText() === name,
  ) ?? null;
}

/** `ImportedService.create()` — the member belongs to the imported class/value. */
function importedClassMemberReference(reference: Node): ImportedSymbolReference | null {
  if (!Node.isPropertyAccessExpression(reference)) {
    return null;
  }
  const receiver = reference.getExpression();
  if (!Node.isIdentifier(receiver)) {
    return null;
  }
  const binding = directBindingReference(receiver);
  return binding === null ? null : withMember(binding, reference.getNameNode().getText());
}

/** `service.run()` where `service` is constructed from or annotated with an imported type. */
function receiverTypedReference(reference: Node): ImportedSymbolReference | null {
  if (!Node.isPropertyAccessExpression(reference)) {
    return null;
  }
  for (const typeName of receiverTypeNames(reference.getExpression())) {
    const binding = Node.isIdentifier(typeName)
      ? directBindingReference(typeName)
      : namespaceMemberReference(typeName);
    if (binding !== null) {
      return withMember(binding, reference.getNameNode().getText());
    }
  }
  return null;
}

function receiverTypeNames(receiver: Node): Node[] {
  const fromNew = newExpressionTypeName(receiver);
  if (fromNew !== null) {
    return [fromNew];
  }
  const symbol = Node.isPropertyAccessExpression(receiver) ? receiver.getNameNode().getSymbol() : receiver.getSymbol();
  const declaration = symbol?.getDeclarations().find(isTypedBinding);
  if (declaration === undefined) {
    return [];
  }
  const annotated = annotatedTypeNames(declaration);
  const initialized = newExpressionTypeName(initializerOf(declaration));
  return initialized === null ? annotated : [...annotated, initialized];
}

function newExpressionTypeName(node: Node | undefined): Node | null {
  if (!node || !Node.isNewExpression(node)) {
    return null;
  }
  const expression = node.getExpression();
  return Node.isIdentifier(expression) || Node.isPropertyAccessExpression(expression) ? expression : null;
}

function isTypedBinding(node: Node): boolean {
  return Node.isVariableDeclaration(node) ||
    Node.isParameterDeclaration(node) ||
    Node.isPropertyDeclaration(node) ||
    Node.isPropertySignature(node);
}

function annotatedTypeNames(declaration: Node): Node[] {
  const typeNode = (declaration as { getTypeNode?(): Node | undefined }).getTypeNode?.();
  if (!typeNode) {
    return [];
  }
  return directTypeNames(typeNode);
}

/** Only unwrap unions/intersections/parentheses. Array/generic element types do not own methods on
 * their wrapper receiver (`GraphEdge[]#map` must stay Array.map, never GraphEdge.map). */
function directTypeNames(typeNode: Node): Node[] {
  if (Node.isTypeReference(typeNode)) {
    return [typeNode.getTypeName()];
  }
  if (Node.isUnionTypeNode(typeNode) || Node.isIntersectionTypeNode(typeNode)) {
    return typeNode.getTypeNodes().flatMap(directTypeNames);
  }
  if (Node.isParenthesizedTypeNode(typeNode)) {
    return directTypeNames(typeNode.getTypeNode());
  }
  return [];
}

function initializerOf(declaration: Node): Node | undefined {
  return (declaration as { getInitializer?(): Node | undefined }).getInitializer?.();
}

function directBindingReference(identifier: Node): ImportedSymbolReference | null {
  const symbol = identifier.getSymbol();
  return bindingReference(symbol) ?? (symbol === undefined ? importBindingByName(identifier) : null);
}

/** A checker alias normally points back to the ImportSpecifier/ImportClause in this file. */
function bindingReference(symbol: TsSymbol | undefined): ImportedSymbolReference | null {
  for (const declaration of symbol?.getDeclarations() ?? []) {
    const imported = importedBindingReference(declaration);
    if (imported !== null) {
      return imported;
    }
  }
  return null;
}

/** Recover one import binding declaration; used directly when a local barrel re-exports it. */
export function importedBindingReference(declaration: Node): ImportedSymbolReference | null {
  const carrier = moduleCarrier(declaration);
  if (carrier === null) {
    return null;
  }
  if (Node.isNamespaceImport(declaration)) {
    return referenceFromCarrier(carrier, null);
  }
  const exportedName = importedNameOf(declaration);
  return exportedName === null ? null : referenceFromCarrier(carrier, exportedName);
}

/** Checker-less fallback for a missing dependency. Never use it when a local/shadowing symbol exists. */
function unresolvedDirectBinding(reference: Node, original: TsSymbol | undefined): ImportedSymbolReference | null {
  return original === undefined && Node.isIdentifier(reference) ? importBindingByName(reference) : null;
}

function importBindingByName(identifier: Node): ImportedSymbolReference | null {
  const localName = identifier.getText();
  for (const declaration of identifier.getSourceFile().getImportDeclarations()) {
    for (const named of declaration.getNamedImports()) {
      if ((named.getAliasNode() ?? named.getNameNode()).getText() === localName) {
        return referenceFromCarrier(declaration, named.getNameNode().getText());
      }
    }
    if (declaration.getDefaultImport()?.getText() === localName) {
      return referenceFromCarrier(declaration, "default");
    }
  }
  return null;
}

function importedNameOf(declaration: Node): string | null {
  if (Node.isImportSpecifier(declaration) || Node.isExportSpecifier(declaration)) {
    return declaration.getNameNode().getText();
  }
  return Node.isImportClause(declaration) ? "default" : null;
}

function moduleCarrier(declaration: Node): Node | null {
  if (Node.isImportDeclaration(declaration) || Node.isExportDeclaration(declaration)) {
    return declaration;
  }
  return declaration.getFirstAncestorByKind(SyntaxKind.ImportDeclaration) ??
    declaration.getFirstAncestorByKind(SyntaxKind.ExportDeclaration) ??
    null;
}

export function referenceFromCarrier(carrier: Node, exportedName: string | null): ImportedSymbolReference | null {
  if (!Node.isImportDeclaration(carrier) && !Node.isExportDeclaration(carrier)) {
    return null;
  }
  const specifier = carrier.getModuleSpecifierValue();
  if (!specifier) {
    return null;
  }
  const targetSourceFile = carrier.getModuleSpecifierSourceFile() ?? null;
  return {
    specifier,
    exportedName,
    fromFile: carrier.getSourceFile().getFilePath(),
    targetFile: resolvedModuleFile(carrier, specifier),
    targetSourceFile,
  };
}

export function resolvedModuleFile(carrier: Node, specifier: string): string | null {
  if (!Node.isImportDeclaration(carrier) && !Node.isExportDeclaration(carrier)) {
    return null;
  }
  const direct = carrier.getModuleSpecifierSourceFile()?.getFilePath();
  if (direct) {
    return direct;
  }
  const sourceFile = carrier.getSourceFile();
  const resolved = ts.resolveModuleName(
    specifier,
    sourceFile.getFilePath(),
    sourceFile.getProject().getCompilerOptions(),
    ts.sys,
  );
  return resolved.resolvedModule?.resolvedFileName ?? null;
}

function withMember(binding: ImportedSymbolReference, member: string): ImportedSymbolReference {
  const exportedName = binding.exportedName === null ? member : `${binding.exportedName}.${member}`;
  return { ...binding, exportedName };
}
