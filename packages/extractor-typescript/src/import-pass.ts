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
import type { CallSite } from "@meridian/core";
import { lineColOf, type NodeDescriptor } from "./model";
import type { RawEdge } from "./edge-pass";
import type { TargetResolution } from "./edge-resolve";
import type { LoadedProject } from "./project-loader";

// Both declaration forms expose their target through the same ts-morph method, so one type
// covers `import ... from "x"` and re-exports alike.
type ModuleDependencyDecl = ImportDeclaration | ExportDeclaration;

export function collectImportEdges(loaded: LoadedProject, moduleByFilePath: Map<string, NodeDescriptor>): RawEdge[] {
  const edges: RawEdge[] = [];
  for (const sourceFile of loaded.sourceFiles) {
    collectFileImports(sourceFile, loaded.relativePathOf(sourceFile), moduleByFilePath, edges);
  }
  return edges;
}

function collectFileImports(
  sourceFile: SourceFile,
  relPath: string,
  moduleByFilePath: Map<string, NodeDescriptor>,
  edges: RawEdge[],
): void {
  const importer = moduleByFilePath.get(sourceFile.getFilePath());
  if (!importer) {
    return; // a selected file always has a module node; guard only for a caller passing a stray file
  }
  for (const declaration of moduleDependencyDecls(sourceFile)) {
    addImportEdge(declaration, importer.finalId, relPath, moduleByFilePath, edges);
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
): void {
  const targetFile = declaration.getModuleSpecifierSourceFile();
  if (!targetFile) {
    return; // no specifier, or one we cannot statically resolve to a file in the Project
  }
  const target = moduleByFilePath.get(targetFile.getFilePath());
  if (!target || target.finalId === source) {
    return; // external / excluded (absent from the module index) or a self-import
  }
  edges.push({ source, kind: "imports", resolution: resolvedTo(target.finalId), callSite: callSiteOf(declaration, relPath) });
}

function resolvedTo(target: string): TargetResolution {
  return { resolution: "resolved", resolvedTarget: target, externalModulePath: null, externalQualname: null, threw: false };
}

function callSiteOf(declaration: ModuleDependencyDecl, relPath: string): CallSite {
  const position = lineColOf(declaration);
  return { file: relPath, line: position.line, col: position.column };
}
