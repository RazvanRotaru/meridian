/**
 * Import pass: one walk over each source file's static `import ... from`, re-export
 * (`export * from`, `export { x } from`), and inline import-type dependencies. In-project targets
 * receive a module->module `imports` edge; external targets retain the imported binding when one exists.
 * This is the structural counterpart to the behavioural edge pass — it answers which modules
 * and contracts a file depends on, independent of whether any exported symbol is ever called.
 *
 * In-project targets become resolved module edges. Package, builtin, declared-but-missing, and
 * out-of-scope alias targets become honest external edges (one per imported binding) and flow
 * through the ordinary `includeExternal` policy rather than disappearing here.
 * Runtime dynamic `import()` / `require()` and barrel-chain flattening remain out of scope — a
 * barrel surfacing as a hub is honest data. TypeScript's `import("pkg").Type` is an ImportTypeNode,
 * not a runtime dynamic import, and belongs in this structural dependency pass.
 */

import {
  Node,
  SyntaxKind,
  type ExportDeclaration,
  type ImportDeclaration,
  type ImportTypeNode,
  type SourceFile,
} from "ts-morph";
import { resolvedModuleFile } from "./import-reference";
import { callSiteOf, type NodeDescriptor } from "./model";
import type { RawEdge } from "./edge-pass";
import { externalImportTarget, type CrossPackageResolver, type TargetResolution } from "./edge-resolve";
import type { LoadedProject } from "./project-loader";
import type { ResolutionIndex } from "./resolution-index";

// Keep every syntax form's source node so the final edge points back to exact evidence.
type ModuleDependencyNode = ImportDeclaration | ExportDeclaration | ImportTypeNode;

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
  for (const dependency of moduleDependencies(sourceFile)) {
    addImportEdge(dependency, importer.finalId, relPath, moduleByFilePath, index, edges, resolver);
  }
}

function moduleDependencies(sourceFile: SourceFile): ModuleDependencyNode[] {
  return [
    ...sourceFile.getImportDeclarations(),
    ...sourceFile.getExportDeclarations(),
    ...sourceFile.getDescendantsOfKind(SyntaxKind.ImportType),
  ];
}

function addImportEdge(
  dependency: ModuleDependencyNode,
  source: string,
  relPath: string,
  moduleByFilePath: Map<string, NodeDescriptor>,
  index: ResolutionIndex,
  edges: RawEdge[],
  resolver?: CrossPackageResolver,
): void {
  const specifier = moduleSpecifierValue(dependency);
  const targetFile = specifier ? resolvedModuleFile(dependency, specifier) : null;
  const target = targetFile ? moduleByFilePath.get(targetFile) : undefined;
  if (target) {
    if (target.finalId !== source) {
      edges.push({ source, kind: "imports", resolution: resolvedTo(target.finalId), callSite: callSiteOf(dependency, relPath) });
    }
    return; // resolved in-unit (or a self-import, which carries no edge)
  }
  // A workspace package gets first refusal: the join must turn it back into an ordinary resolved
  // edge even when an installed node_modules copy made it look external inside this unit.
  const pending = pendingModuleRef(dependency, resolver);
  if (pending) {
    edges.push({ source, kind: "imports", resolution: pending, callSite: callSiteOf(dependency, relPath) });
    return;
  }
  // Everything left that is non-relative or checker-resolved outside the selected graph is an
  // external dependency. Keep each named binding so unused imported contracts/services still
  // appear in the boundary inventory; namespace/star/side-effect forms point at the module.
  for (const external of externalModuleRefs(dependency, index)) {
    edges.push({ source, kind: "imports", resolution: external, callSite: callSiteOf(dependency, relPath) });
  }
}

function resolvedTo(target: string): TargetResolution {
  return { resolution: "resolved", resolvedTarget: target, externalModulePath: null, externalQualname: null, threw: false };
}

function pendingModuleRef(dependency: ModuleDependencyNode, resolver?: CrossPackageResolver): TargetResolution | null {
  const specifier = moduleSpecifierValue(dependency);
  if (!specifier || !resolver) {
    return null;
  }
  const fromFile = dependency.getSourceFile().getFilePath();
  const resolvedFile = resolvedModuleFile(dependency, specifier);
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

function externalModuleRefs(dependency: ModuleDependencyNode, index: ResolutionIndex): TargetResolution[] {
  const specifier = moduleSpecifierValue(dependency);
  if (!specifier) {
    return [];
  }
  // Do not turn a typo such as `./missing` into a package boundary. A relative target that really
  // exists but falls outside/excluded from the graph is still an honest external dependency.
  const resolvedFile = resolvedModuleFile(dependency, specifier);
  if (resolvedFile === null) {
    if (isRelativeModuleSpecifier(dependency, specifier)) {
      return [];
    }
    if (!index.isExternalSpecifier(dependency.getSourceFile().getFilePath(), specifier)) {
      return [];
    }
  }
  return externalBindingNames(dependency).map((name) => externalImportTarget(specifier, name));
}

function externalBindingNames(dependency: ModuleDependencyNode): Array<string | null> {
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

function moduleSpecifierValue(dependency: ModuleDependencyNode): string | null {
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

function isRelativeModuleSpecifier(dependency: ModuleDependencyNode, specifier: string): boolean {
  return Node.isImportTypeNode(dependency) ? specifier.startsWith(".") : dependency.isModuleSpecifierRelative();
}
