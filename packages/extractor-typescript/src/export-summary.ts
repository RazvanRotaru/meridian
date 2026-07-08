/**
 * A unit's "index card": for every file, exported name -> node id (with in-package re-export
 * chains already flattened by the checker, which is safe here because the project only holds
 * this one package), plus the cross-package re-exports that could NOT be flattened and wait
 * for the join. Built while the unit's ts-morph project is alive; everything returned is
 * plain data so the project can be dropped afterwards.
 */

import { Node } from "ts-morph";
import type { ExportDeclaration, SourceFile } from "ts-morph";
import type { PendingReexport, UnitSummary } from "./cross-package-join";
import type { CrossPackageResolver } from "./edge-resolve";
import { nodeKey } from "./model";
import type { LoadedProject } from "./project-loader";
import type { ResolutionIndex } from "./resolution-index";
import type { WorkspaceUnit } from "./workspace-units";

export function buildUnitSummary(
  unit: WorkspaceUnit,
  loaded: LoadedProject,
  index: ResolutionIndex,
  moduleIdByRelPath: Map<string, string>,
  resolver: CrossPackageResolver,
): UnitSummary {
  const exportsByFile = new Map<string, Map<string, string>>();
  const pendingReexports: PendingReexport[] = [];
  for (const sourceFile of loaded.sourceFiles) {
    const relPath = loaded.relativePathOf(sourceFile);
    exportsByFile.set(relPath, exportTable(sourceFile, index));
    collectPendingReexports(sourceFile, relPath, resolver, pendingReexports);
  }
  return {
    dir: unit.dir,
    name: unit.name,
    entryFile: unit.entryFile,
    sourceDir: unit.sourceDir,
    exportsByFile,
    moduleIdByRelPath,
    pendingReexports,
  };
}

/** Exported name -> emitted node id; names whose declaration we did not emit contribute nothing. */
function exportTable(sourceFile: SourceFile, index: ResolutionIndex): Map<string, string> {
  const table = new Map<string, string>();
  for (const [name, declarations] of exportedDeclarationsOf(sourceFile)) {
    for (const declaration of declarations) {
      const id = index.targetByDeclKey.get(nodeKey(declaration));
      if (id !== undefined) {
        table.set(name, id);
        addMemberEntries(table, name, declaration, index);
        break;
      }
    }
  }
  return table;
}

// Also index a class/interface's members under `Export.member`, so a cross-package call to
// `ImportedClass.method()` — which the join sees as exported name `ImportedClass.method` —
// resolves to the method node, not just the class. (Whole-program mode gets these from the
// type checker; per-package must carry them in the summary.)
function addMemberEntries(table: Map<string, string>, exportName: string, declaration: Node, index: ResolutionIndex): void {
  if (!Node.isClassDeclaration(declaration) && !Node.isInterfaceDeclaration(declaration)) {
    return;
  }
  for (const member of declaration.getMembers()) {
    const memberName = (member as { getName?(): string }).getName?.();
    const id = index.targetByDeclKey.get(nodeKey(member));
    if (memberName && id !== undefined) {
      table.set(`${exportName}.${memberName}`, id);
    }
  }
}

function exportedDeclarationsOf(sourceFile: SourceFile): ReadonlyMap<string, Node[]> {
  try {
    return sourceFile.getExportedDeclarations();
  } catch {
    return new Map(); // a file whose exports the checker cannot flatten simply contributes none
  }
}

function collectPendingReexports(
  sourceFile: SourceFile,
  relPath: string,
  resolver: CrossPackageResolver,
  out: PendingReexport[],
): void {
  for (const declaration of sourceFile.getExportDeclarations()) {
    if (declaration.getModuleSpecifierSourceFile()) {
      continue; // resolved in-package: getExportedDeclarations already flattened it
    }
    const specifier = declaration.getModuleSpecifierValue();
    if (!specifier || !resolver.matches(specifier)) {
      continue;
    }
    const names = reexportedNames(declaration);
    if (names !== undefined) {
      out.push({ file: relPath, specifier, names });
    }
  }
}

/** Named re-exports as (exported, local) pairs; null for `export *`; undefined for
 * `export * as ns` — a namespace object the name-table join cannot represent. */
function reexportedNames(declaration: ExportDeclaration): PendingReexport["names"] | undefined {
  const named = declaration.getNamedExports();
  if (named.length > 0) {
    return named.map((spec) => ({
      exported: (spec.getAliasNode() ?? spec.getNameNode()).getText(),
      local: spec.getNameNode().getText(),
    }));
  }
  return declaration.getNamespaceExport() ? undefined : null;
}
