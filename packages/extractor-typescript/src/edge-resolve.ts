/**
 * Static call resolution, honestly classified. A callee expression resolves to `resolved`
 * (an in-graph node), `external` (a lib / node_modules / .d.ts declaration), or `unresolved`
 * (no symbol, or a symbol we did not emit). Every attempt is guarded — a thrown resolution
 * degrades to `unresolved` rather than aborting the pass.
 */

import { Node, SyntaxKind, type Symbol as TsSymbol } from "ts-morph";
import type { EdgeResolution } from "@meridian/core";
import { nodeKey } from "./model";
import { posixBasename } from "./paths";
import type { ResolutionIndex } from "./resolution-index";

export interface TargetResolution {
  resolution: EdgeResolution;
  resolvedTarget: string | null;
  externalModulePath: string | null;
  externalQualname: string | null;
  threw: boolean;
  /** Set in per-package mode when the target lives in a sibling workspace package: the join
   * pass (cross-package-join.ts) rewrites it to `resolved`, or it stays honestly unresolved. */
  pending?: PendingRef;
  /** Set when the symbol itself has no emitted node (a type alias, a plain const) and the target
   * is its declaring FILE's module node instead. Callers that share ownership with another pass
   * use this to tell "found the real node" from "found only the file". */
  viaModuleFallback?: true;
}

export interface PendingRef {
  /** The import specifier as written, e.g. `@scope/pkg` or `@scope/pkg/sub/path`. */
  specifier: string;
  /** The imported name (`default` for default imports); null for module-level `imports` edges. */
  exportedName: string | null;
  /** Set when `specifier` was RELATIVE and crossed a package boundary: the workspace-relative
   * base path (no extension) of the target file. The join resolves this by path instead of by
   * package name (a sibling package reached via `../../pkg/src/foo` rather than its bare name). */
  targetFile?: string;
}

const UNRESOLVED: TargetResolution = {
  resolution: "unresolved",
  resolvedTarget: null,
  externalModulePath: null,
  externalQualname: null,
  threw: false,
};

/**
 * Per-package mode's view of the rest of the workspace. `matches` recognizes a bare sibling
 * package specifier (`@scope/pkg[/sub]`); `resolveRelative` turns a RELATIVE specifier that
 * escapes the current unit into the workspace-relative base path of its target file (or null).
 */
export interface CrossPackageResolver {
  matches(specifier: string): boolean;
  resolveRelative(fromFileAbsPath: string, specifier: string): string | null;
}

export function resolveTarget(
  callee: Node,
  index: ResolutionIndex,
  resolver?: CrossPackageResolver,
  moduleFallback?: Map<string, { finalId: string }>,
): TargetResolution {
  try {
    const original = calleeSymbol(callee);
    const symbol = aliasedSymbol(original);
    const declaration = implementationDeclaration(symbol);
    const classified = symbol && declaration ? classifyDeclaration(declaration, symbol, index) : UNRESOLVED;
    // Opt-in module fallback (the value-ref pass): a symbol with no emitted node — a type alias,
    // a plain const — still names a real in-project dependency. Resolve it to the declaring
    // file's MODULE node so the relationship survives instead of dropping as unresolved.
    if (classified.resolution === "unresolved" && declaration && moduleFallback) {
      const fallback = moduleFallbackTarget(callee, declaration, moduleFallback);
      if (fallback) {
        return fallback;
      }
    }
    // Attach a pending ref on ANYTHING that did not resolve in-unit — including `external`,
    // because an installed monorepo resolves a sibling package through its node_modules copy
    // (a real .d.ts/.ts), which classifies external here; only the join knows it is in-project.
    if (classified.resolution !== "resolved" && resolver) {
      const pending = pendingCrossPackageRef(callee, original, resolver);
      if (pending) {
        return { ...classified, pending };
      }
    }
    return classified;
  } catch {
    return { ...UNRESOLVED, threw: true };
  }
}

/**
 * In per-package mode a cross-package reference cannot resolve to a declaration — the module is
 * not in this unit's project (or resolves only to its node_modules copy). Recover WHAT was
 * referenced from WHERE so the join (cross-package-join.ts) can resolve it against the target
 * package's summary: either a `<ns>.member` access on a namespace import, or the original
 * symbol's own import/re-export binding — each pointing at a sibling package by bare name or a
 * boundary-crossing relative path.
 */
function pendingCrossPackageRef(callee: Node, original: TsSymbol | undefined, resolver: CrossPackageResolver): PendingRef | null {
  return (
    namespaceMemberRef(callee, resolver) ??
    classMemberRef(callee, resolver) ??
    receiverTypedRef(callee, resolver) ??
    bindingRef(original, resolver)
  );
}

/**
 * `receiver.method()` where `receiver`'s type is a class/interface imported from a sibling
 * package — the dominant cross-package member-call shape (`const x = new Sibling(); x.m()` or a
 * parameter typed by a sibling interface). The receiver's type is read from LOCAL syntax (a
 * `new X()` initializer or a type annotation), so the sibling's source is never loaded; the
 * join keys the call under `TypeName.method` against that package's member table.
 */
function receiverTypedRef(callee: Node, resolver: CrossPackageResolver): PendingRef | null {
  if (!Node.isPropertyAccessExpression(callee)) {
    return null;
  }
  const typeIdentifier = receiverTypeIdentifier(callee.getExpression());
  if (typeIdentifier === null) {
    return null;
  }
  const binding = namedImportBinding(typeIdentifier);
  if (binding === null) {
    return null;
  }
  return pendingFor(binding.specifier, `${binding.importedName}.${callee.getNameNode().getText()}`, binding.fromFile, resolver);
}

/** The identifier naming a receiver's class/interface, from a `new X()` or a type annotation. */
function receiverTypeIdentifier(receiver: Node): Node | null {
  const fromNew = newExpressionClass(receiver);
  if (fromNew !== null) {
    return fromNew;
  }
  if (!Node.isIdentifier(receiver)) {
    return null;
  }
  const declaration = receiver.getSymbol()?.getDeclarations().find(isTypedBinding);
  if (declaration === undefined) {
    return null;
  }
  return annotatedTypeIdentifier(declaration) ?? newExpressionClass(initializerOf(declaration));
}

function newExpressionClass(node: Node | undefined): Node | null {
  if (node && Node.isNewExpression(node)) {
    const expression = node.getExpression();
    return Node.isIdentifier(expression) ? expression : null;
  }
  return null;
}

function isTypedBinding(node: Node): boolean {
  return Node.isVariableDeclaration(node) || Node.isParameterDeclaration(node) || Node.isPropertyDeclaration(node);
}

function annotatedTypeIdentifier(declaration: Node): Node | null {
  const typeNode = (declaration as { getTypeNode?(): Node | undefined }).getTypeNode?.();
  if (typeNode && Node.isTypeReference(typeNode)) {
    const name = typeNode.getTypeName();
    return Node.isIdentifier(name) ? name : null;
  }
  return null;
}

function initializerOf(declaration: Node): Node | undefined {
  return (declaration as { getInitializer?(): Node | undefined }).getInitializer?.();
}

/**
 * `ImportedClass.method()` on a class/value imported from a sibling package — the member call
 * resolves inside that package. Found by scanning THIS file's imports (not the symbol, whose
 * alias the checker may have already followed into the target file), so it works whether or not
 * the specifier resolved on disk. The join keys it under `ExportedName.member`.
 */
function classMemberRef(callee: Node, resolver: CrossPackageResolver): PendingRef | null {
  if (!Node.isPropertyAccessExpression(callee)) {
    return null;
  }
  const object = callee.getExpression();
  if (!Node.isIdentifier(object)) {
    return null;
  }
  const binding = namedImportBinding(object);
  if (binding === null) {
    return null;
  }
  return pendingFor(binding.specifier, `${binding.importedName}.${callee.getNameNode().getText()}`, binding.fromFile, resolver);
}

interface ImportBinding {
  /** The name on the exporting side (`import { A as B }` -> `A`; `default` for a default import). */
  importedName: string;
  specifier: string;
  fromFile: string;
}

/** The named/default import in `identifier`'s own file that binds its text, scanned structurally. */
function namedImportBinding(identifier: Node): ImportBinding | null {
  const sourceFile = identifier.getSourceFile();
  const name = identifier.getText();
  for (const declaration of sourceFile.getImportDeclarations()) {
    const specifier = declaration.getModuleSpecifierValue();
    for (const named of declaration.getNamedImports()) {
      if ((named.getAliasNode() ?? named.getNameNode()).getText() === name) {
        return { importedName: named.getNameNode().getText(), specifier, fromFile: sourceFile.getFilePath() };
      }
    }
    if (declaration.getDefaultImport()?.getText() === name) {
      return { importedName: "default", specifier, fromFile: sourceFile.getFilePath() };
    }
  }
  return null;
}

/** `import * as ns from "@pkg"; ns.member()` — the member resolves inside @pkg, not here. */
function namespaceMemberRef(callee: Node, resolver: CrossPackageResolver): PendingRef | null {
  if (!Node.isPropertyAccessExpression(callee)) {
    return null;
  }
  const object = callee.getExpression();
  if (!Node.isIdentifier(object)) {
    return null;
  }
  const carrier = namespaceImportDecl(object.getSymbol());
  if (carrier === null) {
    return null;
  }
  return pendingFor(carrier.specifier, callee.getNameNode().getText(), carrier.fromFile, resolver);
}

function namespaceImportDecl(symbol: TsSymbol | undefined): { specifier: string; fromFile: string } | null {
  for (const declaration of symbol?.getDeclarations() ?? []) {
    if (Node.isNamespaceImport(declaration)) {
      const specifier = declaration.getFirstAncestorByKind(SyntaxKind.ImportDeclaration)?.getModuleSpecifierValue();
      if (specifier) {
        return { specifier, fromFile: declaration.getSourceFile().getFilePath() };
      }
    }
  }
  return null;
}

function bindingRef(original: TsSymbol | undefined, resolver: CrossPackageResolver): PendingRef | null {
  for (const declaration of original?.getDeclarations() ?? []) {
    const exportedName = importedNameOf(declaration);
    const specifier = exportedName === null ? null : bindingSpecifier(declaration);
    if (specifier !== null) {
      const pending = pendingFor(specifier, exportedName as string, declaration.getSourceFile().getFilePath(), resolver);
      if (pending) {
        return pending;
      }
    }
  }
  return null;
}

/** A pending ref for a bare sibling-package specifier, or a boundary-crossing relative one. */
function pendingFor(
  specifier: string,
  exportedName: string | null,
  fromFileAbsPath: string,
  resolver: CrossPackageResolver,
): PendingRef | null {
  if (resolver.matches(specifier)) {
    return { specifier, exportedName };
  }
  const targetFile = resolver.resolveRelative(fromFileAbsPath, specifier);
  return targetFile === null ? null : { specifier, exportedName, targetFile };
}

/** The name on the far (exporting) side of the binding: `import { X as Y }` imports X. */
function importedNameOf(declaration: Node): string | null {
  if (Node.isImportSpecifier(declaration) || Node.isExportSpecifier(declaration)) {
    return declaration.getNameNode().getText();
  }
  if (Node.isImportClause(declaration)) {
    return "default";
  }
  return null;
}

function bindingSpecifier(declaration: Node): string | null {
  const carrier =
    declaration.getFirstAncestorByKind(SyntaxKind.ImportDeclaration) ??
    declaration.getFirstAncestorByKind(SyntaxKind.ExportDeclaration);
  return carrier?.getModuleSpecifierValue() ?? null;
}

function calleeSymbol(callee: Node): TsSymbol | undefined {
  if (Node.isPropertyAccessExpression(callee)) {
    return callee.getNameNode().getSymbol();
  }
  if (Node.isIdentifier(callee)) {
    return callee.getSymbol();
  }
  return undefined;
}

function aliasedSymbol(symbol: TsSymbol | undefined): TsSymbol | undefined {
  return symbol?.getAliasedSymbol() ?? symbol;
}

/** Prefer the body-bearing declaration (the implementation) over overload signatures. */
function implementationDeclaration(symbol: TsSymbol | undefined): Node | undefined {
  const declarations = symbol?.getDeclarations() ?? [];
  return declarations.find(hasBody) ?? declarations[0];
}

function hasBody(node: Node): boolean {
  return !!(node as { getBody?(): Node | undefined }).getBody?.();
}

function classifyDeclaration(declaration: Node, symbol: TsSymbol, index: ResolutionIndex): TargetResolution {
  if (isExternalDeclaration(declaration)) {
    return externalTo(declaration, symbol);
  }
  const resolvedTarget = index.targetByDeclKey.get(nodeKey(declaration));
  if (resolvedTarget) {
    return { resolution: "resolved", resolvedTarget, externalModulePath: null, externalQualname: null, threw: false };
  }
  return UNRESOLVED;
}

/** The declaring file's module node, for an unresolved symbol that still lives in-project. Never
 * the referencing file's own module (an intra-file symbol is not a dependency). */
function moduleFallbackTarget(
  callee: Node,
  declaration: Node,
  moduleFallback: Map<string, { finalId: string }>,
): TargetResolution | null {
  const declFile = declaration.getSourceFile().getFilePath();
  if (declFile === callee.getSourceFile().getFilePath()) {
    return null;
  }
  const module = moduleFallback.get(declFile);
  if (!module) {
    return null;
  }
  return {
    resolution: "resolved",
    resolvedTarget: module.finalId,
    externalModulePath: null,
    externalQualname: null,
    threw: false,
    viaModuleFallback: true,
  };
}

function isExternalDeclaration(declaration: Node): boolean {
  const filePath = declaration.getSourceFile().getFilePath();
  return filePath.includes("/node_modules/") || filePath.endsWith(".d.ts");
}

function externalTo(declaration: Node, symbol: TsSymbol): TargetResolution {
  return {
    resolution: "external",
    resolvedTarget: null,
    externalModulePath: externalModulePath(declaration),
    externalQualname: symbol.getName(),
    threw: false,
  };
}

function externalModulePath(declaration: Node): string {
  const filePath = declaration.getSourceFile().getFilePath();
  const marker = "/node_modules/";
  const at = filePath.lastIndexOf(marker);
  return at === -1 ? posixBasename(filePath) : filePath.slice(at + marker.length);
}
