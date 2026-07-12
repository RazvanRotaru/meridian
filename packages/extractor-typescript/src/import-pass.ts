/**
 * Import pass: one walk over each source file's static `import ... from` and re-export
 * (`export * from`, `export { x } from`) declarations, emitting a module->module `imports`
 * edge for every specifier that resolves to an in-project file. This is the structural
 * counterpart to the behavioural edge pass — it answers "which files depend on which",
 * independent of whether any exported symbol is ever called.
 *
 * Only statically-resolvable, in-project targets become edges: node_modules / `.d.ts` /
 * excluded files are absent from `moduleByFilePath`, so they are skipped rather than invented.
 * Dynamic `import()` / `require()` and barrel-chain flattening are out of scope for the spike —
 * a barrel surfacing as a hub is honest data.
 */

import type { ExportDeclaration, ImportDeclaration, SourceFile } from "ts-morph";
import { callSiteOf, type NodeDescriptor } from "./model";
import type { RawEdge } from "./edge-pass";
import type { CrossPackageResolver, TargetResolution } from "./edge-resolve";
import type { LoadedProject } from "./project-loader";

// Both declaration forms expose their target through the same ts-morph method, so one type
// covers `import ... from "x"` and re-exports alike.
type ModuleDependencyDecl = ImportDeclaration | ExportDeclaration;

export function collectImportEdges(
  loaded: LoadedProject,
  moduleByFilePath: Map<string, NodeDescriptor>,
  resolver?: CrossPackageResolver,
): RawEdge[] {
  const edges: RawEdge[] = [];
  for (const sourceFile of loaded.sourceFiles) {
    collectFileImports(sourceFile, loaded.relativePathOf(sourceFile), moduleByFilePath, edges, resolver);
  }
  return edges;
}

function collectFileImports(
  sourceFile: SourceFile,
  relPath: string,
  moduleByFilePath: Map<string, NodeDescriptor>,
  edges: RawEdge[],
  resolver?: CrossPackageResolver,
): void {
  const importer = moduleByFilePath.get(sourceFile.getFilePath());
  if (!importer) {
    return; // a selected file always has a module node; guard only for a caller passing a stray file
  }
  for (const declaration of moduleDependencyDecls(sourceFile)) {
    addImportEdge(declaration, importer.finalId, relPath, moduleByFilePath, edges, resolver);
  }
}

/** A bare `export { x }` carries no specifier, so `getModuleSpecifierSourceFile()` yields nothing later. */
function moduleDependencyDecls(sourceFile: SourceFile): ModuleDependencyDecl[] {
  return [...sourceFile.getImportDeclarations(), ...sourceFile.getExportDeclarations()];
}

function addImportEdge(
  declaration: ModuleDependencyDecl,
  source: string,
  relPath: string,
  moduleByFilePath: Map<string, NodeDescriptor>,
  edges: RawEdge[],
  resolver?: CrossPackageResolver,
): void {
  const targetFile = declaration.getModuleSpecifierSourceFile();
  const target = targetFile ? moduleByFilePath.get(targetFile.getFilePath()) : undefined;
  if (target) {
    if (target.finalId !== source) {
      edges.push({ source, kind: "imports", resolution: resolvedTo(target.finalId), callSite: callSiteOf(declaration, relPath) });
    }
    return; // resolved in-unit (or a self-import, which carries no edge)
  }
  // No in-unit target — either the specifier resolved nowhere, or it resolved only to a sibling
  // package's node_modules copy (per-package mode). If it names a workspace package (by bare
  // name or a boundary-crossing relative path), record it as pending so the join points the
  // edge at that package's module node; else it is a genuine external and drops out as before.
  const pending = pendingModuleRef(declaration, resolver);
  if (pending) {
    edges.push({ source, kind: "imports", resolution: pending, callSite: callSiteOf(declaration, relPath) });
  }
}

function resolvedTo(target: string): TargetResolution {
  return { resolution: "resolved", resolvedTarget: target, externalModulePath: null, externalQualname: null, threw: false };
}

function pendingModuleRef(declaration: ModuleDependencyDecl, resolver?: CrossPackageResolver): TargetResolution | null {
  const specifier = declaration.getModuleSpecifierValue();
  if (!specifier || !resolver) {
    return null;
  }
  if (!resolver.matches(specifier)) {
    const targetFile = resolver.resolveRelative(declaration.getSourceFile().getFilePath(), specifier);
    if (targetFile === null) {
      return null;
    }
    return { resolution: "unresolved", resolvedTarget: null, externalModulePath: null, externalQualname: null, threw: false, pending: { specifier, exportedName: null, targetFile } };
  }
  return {
    resolution: "unresolved",
    resolvedTarget: null,
    externalModulePath: null,
    externalQualname: null,
    threw: false,
    pending: { specifier, exportedName: null },
  };
}
