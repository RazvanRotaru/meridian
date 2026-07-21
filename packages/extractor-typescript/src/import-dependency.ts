/**
 * Syntax adapters for dependencies that load a module. Runtime imports are included only when
 * their target is statically knowable; computed specifiers remain deliberately unmodelled.
 */

import {
  Node,
  SyntaxKind,
  type CallExpression,
  type ExportDeclaration,
  type ImportDeclaration,
  type ImportTypeNode,
  type SourceFile,
} from "ts-morph";

export type ModuleDependencyNode = ImportDeclaration | ExportDeclaration | ImportTypeNode | CallExpression;

export function moduleDependencies(sourceFile: SourceFile): ModuleDependencyNode[] {
  return [
    ...sourceFile.getImportDeclarations(),
    ...sourceFile.getExportDeclarations(),
    ...sourceFile.getDescendantsOfKind(SyntaxKind.ImportType),
    ...sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression).filter(isRuntimeImportCall),
  ];
}

export function isRuntimeImportCall(node: Node): node is CallExpression {
  return Node.isCallExpression(node) && Node.isImportExpression(node.getExpression());
}

export function moduleSpecifierValue(dependency: ModuleDependencyNode): string | null {
  if (Node.isCallExpression(dependency)) {
    return runtimeImportSpecifier(dependency);
  }
  if (!Node.isImportTypeNode(dependency)) {
    return dependency.getModuleSpecifierValue() || null;
  }
  const argument = dependency.getArgument();
  if (!Node.isLiteralTypeNode(argument)) {
    return null;
  }
  const literal = argument.getLiteral();
  return Node.isStringLiteral(literal) ? literal.getLiteralValue() : null;
}

export function isRelativeModuleSpecifier(dependency: ModuleDependencyNode, specifier: string): boolean {
  return Node.isImportTypeNode(dependency) || Node.isCallExpression(dependency)
    ? specifier.startsWith(".")
    : dependency.isModuleSpecifierRelative();
}

export function externalBindingNames(dependency: ModuleDependencyNode): Array<string | null> {
  if (Node.isCallExpression(dependency)) {
    return [null]; // import() resolves to the module namespace, not one statically named binding
  }
  if (Node.isImportTypeNode(dependency)) {
    return [dependency.getQualifier()?.getText() ?? null];
  }
  if (Node.isExportDeclaration(dependency)) {
    const names = dependency.getNamedExports().map((named) => named.getNameNode().getText());
    return names.length > 0 ? names : [null];
  }
  const names: Array<string | null> = [];
  if (dependency.getDefaultImport()) {
    names.push("default");
  }
  names.push(...dependency.getNamedImports().map((named) => named.getNameNode().getText()));
  if (dependency.getNamespaceImport()) {
    names.push(null);
  }
  return names.length > 0 ? names : [null];
}

function runtimeImportSpecifier(call: CallExpression): string | null {
  const argument = unwrapTransparentExpression(call.getArguments()[0]);
  return Node.isStringLiteral(argument) || Node.isNoSubstitutionTemplateLiteral(argument)
    ? argument.getLiteralValue()
    : null;
}

function unwrapTransparentExpression(node: Node | undefined): Node | undefined {
  let current = node;
  while (
    Node.isParenthesizedExpression(current) ||
    Node.isAsExpression(current) ||
    Node.isSatisfiesExpression(current) ||
    Node.isTypeAssertion(current) ||
    Node.isNonNullExpression(current)
  ) {
    current = current.getExpression();
  }
  return current;
}
