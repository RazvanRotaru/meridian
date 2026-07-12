/**
 * Static call resolution, honestly classified. A callee expression resolves to `resolved`
 * (an in-graph node), `external` (a lib / node_modules / .d.ts declaration), or `unresolved`
 * (no symbol, or a symbol we did not emit). Every attempt is guarded — a thrown resolution
 * degrades to `unresolved` rather than aborting the pass.
 */

import { Node, type Symbol as TsSymbol } from "ts-morph";
import type { EdgeResolution } from "@meridian/core";
import { importedSymbolReference, type ImportedSymbolReference } from "./import-reference";
import { nodeKey } from "./model";
import { posixBasename } from "./paths";
import { throughLocalReexports } from "./reexport-reference";
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
 * `resolveFile` performs the same boundary check for a checker-resolved tsconfig alias target.
 */
export interface CrossPackageResolver {
  matches(specifier: string): boolean;
  resolveRelative(fromFileAbsPath: string, specifier: string): string | null;
  resolveFile(fromFileAbsPath: string, targetFileAbsPath: string): string | null;
}

export function resolveTarget(
  callee: Node,
  index: ResolutionIndex,
  resolver?: CrossPackageResolver,
  moduleFallback?: Map<string, { finalId: string }>,
): TargetResolution {
  try {
    const original = calleeSymbol(callee);
    const imported = importedSymbolReference(callee, original);
    const symbol = aliasedSymbol(original);
    const declaration = implementationDeclaration(symbol);
    const classified = symbol && declaration ? classifyDeclaration(declaration, symbol, index) : UNRESOLVED;
    const dependencyImport = classified.resolution === "resolved" || imported === null
      ? imported
      : throughLocalReexports(imported, index.sourceFilePaths) ?? imported;
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
      const pending = pendingCrossPackageRef(dependencyImport, resolver);
      if (pending) {
        return { ...classified, pending };
      }
    }
    // Prefer the public import identity over a package manager's physical declaration path. This
    // also recovers dependencies when node_modules is absent or a tsconfig alias lands outside the
    // selected root. A selected target is never externalized merely because its symbol is unemitted.
    if (classified.resolution !== "resolved" && dependencyImport) {
      const external = externalImportedSymbol(dependencyImport, index);
      if (external) {
        return external;
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
 * package's summary. Import recovery is shared with external classification so installed and
 * dependency-less worktrees agree on the same exported name.
 */
function pendingCrossPackageRef(
  imported: ImportedSymbolReference | null,
  resolver: CrossPackageResolver,
): PendingRef | null {
  if (imported === null) {
    return null;
  }
  return pendingFor(imported.specifier, imported.exportedName, imported.fromFile, resolver, imported.targetFile);
}

/** A pending ref for a bare sibling-package specifier, or a boundary-crossing relative one. */
function pendingFor(
  specifier: string,
  exportedName: string | null,
  fromFileAbsPath: string,
  resolver: CrossPackageResolver,
  resolvedFileAbsPath: string | null = null,
): PendingRef | null {
  if (resolvedFileAbsPath !== null) {
    const targetFile = resolver.resolveFile(fromFileAbsPath, resolvedFileAbsPath);
    if (targetFile !== null) {
      return { specifier, exportedName, targetFile };
    }
  }
  if (resolver.matches(specifier)) {
    return { specifier, exportedName };
  }
  const targetFile = resolver.resolveRelative(fromFileAbsPath, specifier);
  return targetFile === null ? null : { specifier, exportedName, targetFile };
}

function calleeSymbol(callee: Node): TsSymbol | undefined {
  if (Node.isPropertyAccessExpression(callee)) {
    return callee.getNameNode().getSymbol();
  }
  if (Node.isIdentifier(callee)) {
    return callee.getSymbol();
  }
  if (Node.isQualifiedName(callee)) {
    return callee.getRight().getSymbol();
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

function externalImportedSymbol(
  imported: ImportedSymbolReference,
  index: ResolutionIndex,
): TargetResolution | null {
  if (imported.targetFile !== null && index.sourceFilePaths.has(imported.targetFile)) {
    return null;
  }
  // A missing relative lookup is a broken/local import, not evidence of an external package.
  if (imported.targetFile === null && imported.specifier.startsWith(".")) {
    return null;
  }
  if (imported.targetFile === null && !index.isExternalSpecifier(imported.fromFile, imported.specifier)) {
    return null;
  }
  return externalImportTarget(imported.specifier, imported.exportedName);
}

/** A stable external identity derived from public import syntax rather than declaration layout. */
export function externalImportTarget(specifier: string, exportedName: string | null): TargetResolution {
  return {
    resolution: "external",
    resolvedTarget: null,
    externalModulePath: escapeExternalIdPart(specifier),
    externalQualname: exportedName === null ? null : escapeExternalIdPart(exportedName),
    threw: false,
  };
}

/** Keep the node-id delimiters out while leaving ordinary `@scope/pkg/subpath` readable. */
function escapeExternalIdPart(value: string): string {
  if (value === "__external__") {
    return "%5F%5Fexternal%5F%5F"; // never collide with core's synthetic External container
  }
  return value.replace(/[%#~\s]/gu, (character) => {
    if (character === "~") return "%7E";
    return encodeURIComponent(character);
  });
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
