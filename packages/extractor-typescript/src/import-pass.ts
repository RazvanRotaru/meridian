/**
 * Import pass: one walk over each source file's static `import ... from` and re-export
 * (`export * from`, `export { x } from`) declarations. In-project targets receive a
 * module->module `imports` edge; external targets retain the imported binding when one exists.
 * This is the structural counterpart to the behavioural edge pass — it answers which modules
 * and contracts a file depends on, independent of whether any exported symbol is ever called.
 *
 * In-project targets become resolved module edges. Package, builtin, declared-but-missing, and
 * out-of-scope alias targets become honest external edges (one per imported binding) and flow
 * through the ordinary `includeExternal` policy rather than disappearing here.
 * Dynamic `import()` / `require()` and barrel-chain flattening are out of scope for the spike —
 * a barrel surfacing as a hub is honest data.
 */

import { Node, type ExportDeclaration, type ImportDeclaration, type SourceFile } from "ts-morph";
import { resolvedModuleFile } from "./import-reference";
import { callSiteOf, type NodeDescriptor } from "./model";
import type { RawEdge } from "./edge-pass";
import { externalImportTarget, type CrossPackageResolver, type TargetResolution } from "./edge-resolve";
import type { LoadedProject } from "./project-loader";
import type { ResolutionIndex } from "./resolution-index";

// Both declaration forms expose their target through the same ts-morph method, so one type
// covers `import ... from "x"` and re-exports alike.
type ModuleDependencyDecl = ImportDeclaration | ExportDeclaration;

export function collectImportEdges(
  loaded: LoadedProject,
  moduleByFilePath: Map<string, NodeDescriptor>,
  index: ResolutionIndex,
  resolver?: CrossPackageResolver,
): RawEdge[] {
  const edges: RawEdge[] = [];
  for (const sourceFile of loaded.sourceFiles) {
    collectFileImports(sourceFile, loaded.relativePathOf(sourceFile), moduleByFilePath, index, edges, resolver);
  }
  return edges;
}

function collectFileImports(
  sourceFile: SourceFile,
  relPath: string,
  moduleByFilePath: Map<string, NodeDescriptor>,
  index: ResolutionIndex,
  edges: RawEdge[],
  resolver?: CrossPackageResolver,
): void {
  const importer = moduleByFilePath.get(sourceFile.getFilePath());
  if (!importer) {
    return; // a selected file always has a module node; guard only for a caller passing a stray file
  }
  for (const declaration of moduleDependencyDecls(sourceFile)) {
    addImportEdge(declaration, importer.finalId, relPath, moduleByFilePath, index, edges, resolver);
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
  index: ResolutionIndex,
  edges: RawEdge[],
  resolver?: CrossPackageResolver,
): void {
  const specifier = declaration.getModuleSpecifierValue();
  const targetFile = specifier ? resolvedModuleFile(declaration, specifier) : null;
  const target = targetFile ? moduleByFilePath.get(targetFile) : undefined;
  if (target) {
    if (target.finalId !== source) {
      edges.push({ source, kind: "imports", resolution: resolvedTo(target.finalId), callSite: callSiteOf(declaration, relPath) });
    }
    return; // resolved in-unit (or a self-import, which carries no edge)
  }
  // A workspace package gets first refusal: the join must turn it back into an ordinary resolved
  // edge even when an installed node_modules copy made it look external inside this unit.
  const pending = pendingModuleRef(declaration, resolver);
  if (pending) {
    edges.push({ source, kind: "imports", resolution: pending, callSite: callSiteOf(declaration, relPath) });
    return;
  }
  // Everything left that is non-relative or checker-resolved outside the selected graph is an
  // external dependency. Keep each named binding so unused imported contracts/services still
  // appear in the boundary inventory; namespace/star/side-effect forms point at the module.
  for (const external of externalModuleRefs(declaration, index)) {
    edges.push({ source, kind: "imports", resolution: external, callSite: callSiteOf(declaration, relPath) });
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
  const fromFile = declaration.getSourceFile().getFilePath();
  const resolvedFile = resolvedModuleFile(declaration, specifier);
  if (resolvedFile) {
    const targetFile = resolver.resolveFile(fromFile, resolvedFile);
    if (targetFile !== null) {
      return pendingTo(specifier, null, targetFile);
    }
  }
  if (!resolver.matches(specifier)) {
    const targetFile = resolver.resolveRelative(fromFile, specifier);
    if (targetFile === null) {
      return null;
    }
    return pendingTo(specifier, null, targetFile);
  }
  return pendingTo(specifier, null);
}

function pendingTo(specifier: string, exportedName: string | null, targetFile?: string): TargetResolution {
  return {
    resolution: "unresolved",
    resolvedTarget: null,
    externalModulePath: null,
    externalQualname: null,
    threw: false,
    pending: { specifier, exportedName, ...(targetFile === undefined ? {} : { targetFile }) },
  };
}

function externalModuleRefs(declaration: ModuleDependencyDecl, index: ResolutionIndex): TargetResolution[] {
  const specifier = declaration.getModuleSpecifierValue();
  if (!specifier) {
    return [];
  }
  // Do not turn a typo such as `./missing` into a package boundary. A relative target that really
  // exists but falls outside/excluded from the graph is still an honest external dependency.
  const resolvedFile = resolvedModuleFile(declaration, specifier);
  if (resolvedFile === null) {
    if (declaration.isModuleSpecifierRelative()) {
      return [];
    }
    if (!index.isExternalSpecifier(declaration.getSourceFile().getFilePath(), specifier)) {
      return [];
    }
  }
  return externalBindingNames(declaration).map((name) => externalImportTarget(specifier, name));
}

function externalBindingNames(declaration: ModuleDependencyDecl): Array<string | null> {
  if (Node.isExportDeclaration(declaration)) {
    const names = declaration.getNamedExports().map((named) => named.getNameNode().getText());
    return names.length > 0 ? names : [null];
  }
  const names: Array<string | null> = [];
  if (declaration.getDefaultImport()) {
    names.push("default");
  }
  names.push(...declaration.getNamedImports().map((named) => named.getNameNode().getText()));
  if (declaration.getNamespaceImport()) {
    names.push(null);
  }
  return names.length > 0 ? names : [null];
}
