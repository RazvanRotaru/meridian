/** Follow a selected local barrel until an import reaches the real external/workspace boundary. */

import type { ExportDeclaration, SourceFile } from "ts-morph";
import {
  importedBindingReference,
  referenceFromCarrier,
  type ImportedSymbolReference,
} from "./import-reference";

export function throughLocalReexports(
  imported: ImportedSymbolReference,
  selectedFiles: ReadonlySet<string>,
): ImportedSymbolReference | null {
  if (!isSelectedTarget(imported, selectedFiles) || imported.targetSourceFile === null || imported.exportedName === null) {
    return null;
  }
  return findReexport(imported.targetSourceFile, imported.exportedName, selectedFiles, new Set());
}

function findReexport(
  sourceFile: SourceFile,
  exportedName: string,
  selectedFiles: ReadonlySet<string>,
  visited: Set<string>,
): ImportedSymbolReference | null {
  const key = `${sourceFile.getFilePath()}#${exportedName}`;
  if (visited.has(key)) {
    return null;
  }
  visited.add(key);
  const { root, suffix } = splitRoot(exportedName);
  for (const declaration of sourceFile.getExportDeclarations()) {
    for (const candidate of reexportCandidates(declaration, root, suffix)) {
      if (!isSelectedTarget(candidate, selectedFiles)) {
        return candidate;
      }
      if (candidate.targetSourceFile !== null && candidate.exportedName !== null) {
        const nested = findReexport(candidate.targetSourceFile, candidate.exportedName, selectedFiles, visited);
        if (nested !== null) {
          return nested;
        }
      }
    }
  }
  return null;
}

function reexportCandidates(
  declaration: ExportDeclaration,
  root: string,
  suffix: string,
): ImportedSymbolReference[] {
  if (!declaration.getModuleSpecifierValue()) {
    return localImportCandidates(declaration, root, suffix);
  }
  const mapped = mappedExport(declaration, root);
  if (mapped === undefined) {
    return [];
  }
  const exportedName = mapped === null ? (suffix === "" ? null : suffix.slice(1)) : `${mapped}${suffix}`;
  const candidate = referenceFromCarrier(declaration, exportedName);
  return candidate === null ? [] : [candidate];
}

function localImportCandidates(
  declaration: ExportDeclaration,
  root: string,
  suffix: string,
): ImportedSymbolReference[] {
  const candidates: ImportedSymbolReference[] = [];
  for (const named of declaration.getNamedExports()) {
    const exported = (named.getAliasNode() ?? named.getNameNode()).getText();
    if (exported !== root) {
      continue;
    }
    for (const target of named.getLocalTargetDeclarations()) {
      const imported = importedBindingReference(target);
      if (imported !== null) {
        candidates.push(appendSuffix(imported, suffix));
      }
    }
  }
  return candidates;
}

function appendSuffix(imported: ImportedSymbolReference, suffix: string): ImportedSymbolReference {
  if (suffix === "") {
    return imported;
  }
  const tail = suffix.slice(1);
  const exportedName = imported.exportedName === null ? tail : `${imported.exportedName}.${tail}`;
  return { ...imported, exportedName };
}

/** Export-side root -> target-side root; null means the target module namespace itself. */
function mappedExport(declaration: ExportDeclaration, root: string): string | null | undefined {
  for (const named of declaration.getNamedExports()) {
    const exported = (named.getAliasNode() ?? named.getNameNode()).getText();
    if (exported === root) {
      return named.getNameNode().getText();
    }
  }
  const namespace = declaration.getNamespaceExport()?.getName();
  if (namespace !== undefined) {
    return namespace === root ? null : undefined;
  }
  return declaration.getNamedExports().length === 0 ? root : undefined; // `export * from`
}

function splitRoot(exportedName: string): { root: string; suffix: string } {
  const dot = exportedName.indexOf(".");
  return dot === -1
    ? { root: exportedName, suffix: "" }
    : { root: exportedName.slice(0, dot), suffix: exportedName.slice(dot) };
}

function isSelectedTarget(
  imported: ImportedSymbolReference,
  selectedFiles: ReadonlySet<string>,
): boolean {
  return imported.targetFile !== null && selectedFiles.has(imported.targetFile);
}
