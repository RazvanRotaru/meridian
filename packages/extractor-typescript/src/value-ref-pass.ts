/**
 * Optional value-reference pass. The behavioural pass only edges call / new /
 * JSX / type / heritage occurrences, so importing a symbol and using it as a plain VALUE — passing
 * a function as a callback, reading a const, a namespace receiver `Ns.member` — produces NO usage
 * edge. All that survives is a featureless module→module `imports` wire that doesn't say WHY the
 * two files are coupled. This pass fills that gap: for each such value use it emits a `references`
 * edge from the enclosing callable to the symbol's definition, so the meaning is traceable (and the
 * renderer's `suppressRedundantImports` folds away the now-redundant import).
 *
 * It also rescues UNEMITTED symbols via the module fallback: a type alias or plain const has no
 * graph node, so both the type pass and the plain path above resolve it to nothing — the dominant
 * cause of bare imports in protocol-style code (`import type { VoidRequest }` used only inside a
 * `declare module` augmentation). Those resolve to the declaring FILE's module node instead. Type
 * positions are eligible ONLY through that fallback — a type ref that resolves to a real node
 * belongs to the edge pass, and emitting it here too would double-count its weight.
 *
 * Cheap by construction. It never resolves arbitrary identifiers: it gates on the file's imported
 * local names (a syntactic prefilter), skips positions already covered by another pass, and only
 * the survivors hit the type checker via `resolveTarget`. That resolution also handles shadowing and
 * aliasing honestly — a local `const Foo` reusing an imported name resolves to the local (not the
 * import), so it never mints a spurious cross-module edge. Concrete cross-module and import-known
 * external values become edges; unresolved and intra-file values remain noise.
 */

import { Node, SyntaxKind, type SourceFile } from "ts-morph";
import type { ExtractionDiagnostic } from "@meridian/core";
import type { NodeDescriptor } from "./model";
import { callSiteOf, enclosingCallable, recordThrow, type RawEdge } from "./edge-pass";
import { resolveTarget, type CrossPackageResolver } from "./edge-resolve";
import type { ResolutionIndex } from "./resolution-index";
import type { LoadedProject } from "./project-loader";

export function collectValueRefEdges(
  loaded: LoadedProject,
  index: ResolutionIndex,
  moduleByFilePath: Map<string, NodeDescriptor>,
  diagnostics: ExtractionDiagnostic[],
  resolver?: CrossPackageResolver,
): RawEdge[] {
  const edges: RawEdge[] = [];
  for (const sourceFile of loaded.sourceFiles) {
    const names = importedLocalNames(sourceFile);
    if (names.size === 0) {
      continue; // no imports → no value references to surface; skip the identifier walk entirely
    }
    collectFileValueRefs(sourceFile, loaded.relativePathOf(sourceFile), names, index, moduleByFilePath, diagnostics, edges, resolver);
  }
  return edges;
}

function collectFileValueRefs(
  sourceFile: SourceFile,
  relPath: string,
  names: ReadonlySet<string>,
  index: ResolutionIndex,
  moduleByFilePath: Map<string, NodeDescriptor>,
  diagnostics: ExtractionDiagnostic[],
  edges: RawEdge[],
  resolver?: CrossPackageResolver,
): void {
  const moduleId = moduleByFilePath.get(sourceFile.getFilePath())?.finalId ?? "";
  for (const id of sourceFile.getDescendantsOfKind(SyntaxKind.Identifier)) {
    if (!names.has(id.getText())) {
      continue;
    }
    const position = referencePosition(id);
    if (position === null) {
      continue;
    }
    const resolution = resolveTarget(id, index, resolver, moduleByFilePath);
    recordThrow(resolution, relPath, id, diagnostics);
    if (resolution.resolution === "unresolved") {
      continue;
    }
    if (position === "type" && (resolution.resolution !== "resolved" || !resolution.viaModuleFallback)) {
      continue; // a type ref with a real node is the edge pass's edge — re-emitting doubles its weight
    }
    const source = enclosingCallable(id, index) ?? moduleId;
    if (source === "") {
      continue;
    }
    if (resolution.resolution === "resolved") {
      if (!resolution.resolvedTarget || moduleOf(source) === moduleOf(resolution.resolvedTarget)) {
        continue; // local shadow/self-reference: not a dependency
      }
    }
    edges.push({ source, kind: "references", resolution, callSite: callSiteOf(id, relPath) });
  }
}

/** The local binding names an `import` introduces: default, `* as ns`, and each named/aliased import. */
function importedLocalNames(sourceFile: SourceFile): ReadonlySet<string> {
  const names = new Set<string>();
  for (const declaration of sourceFile.getImportDeclarations()) {
    const defaultImport = declaration.getDefaultImport();
    if (defaultImport) {
      names.add(defaultImport.getText());
    }
    const namespaceImport = declaration.getNamespaceImport();
    if (namespaceImport) {
      names.add(namespaceImport.getText());
    }
    for (const named of declaration.getNamedImports()) {
      names.add((named.getAliasNode() ?? named.getNameNode()).getText());
    }
  }
  return names;
}

/**
 * Keep only identifiers that are a genuine VALUE reference to the imported binding, skipping
 * positions another pass already owns or that aren't a reference at all:
 *   - the import declaration's own specifier names,
 *   - a property NAME (`x.Foo`, `{ Foo: 1 }`) — that `Foo` is not the imported binding,
 *   - the direct callee of a call/new (`Foo()`, `new Foo()`) — already `calls` / `instantiates`,
 *   - a JSX tag (`<Foo/>`) — already `renders`,
 *   - a heritage clause (`extends Foo`, `implements Foo`) — already `extends` / `implements`.
 * A type position (`: Foo`) classifies "type" — the caller emits it only via the module fallback
 * (an unemitted alias/const), because emitted type refs are the type-reference pass's edges.
 */
function referencePosition(id: Node): "value" | "type" | null {
  if (id.getFirstAncestorByKind(SyntaxKind.ImportDeclaration) || id.getFirstAncestorByKind(SyntaxKind.ExportDeclaration)) {
    return null;
  }
  if (id.getFirstAncestorByKind(SyntaxKind.HeritageClause)) {
    return null; // extends / implements — owned by the inheritance pass
  }
  const parent = id.getParent();
  if (!parent) {
    return null;
  }
  if (isJsxTagName(parent)) {
    return null; // <Foo/> tag — owned by the renders pass
  }
  if (Node.isPropertyAccessExpression(parent) && parent.getNameNode() === id) {
    return null; // the `.member` side of `receiver.member`
  }
  if ((Node.isPropertyAssignment(parent) || Node.isPropertySignature(parent)) && parent.getNameNode() === id) {
    return null; // a property KEY, not a reference
  }
  if (Node.isTypeReference(parent) || Node.isQualifiedName(parent)) {
    return "type";
  }
  if ((Node.isCallExpression(parent) || Node.isNewExpression(parent)) && parent.getExpression() === id) {
    return null; // direct callee — owned by the calls / instantiates pass
  }
  return "value";
}

/** True when the identifier's parent marks it as a JSX tag: `<Foo/>` or a dotted `<Foo.Bar/>`. */
function isJsxTagName(parent: Node): boolean {
  if (Node.isJsxOpeningElement(parent) || Node.isJsxSelfClosingElement(parent) || Node.isJsxClosingElement(parent)) {
    return true;
  }
  if (Node.isPropertyAccessExpression(parent)) {
    const grandparent = parent.getParent();
    return grandparent !== undefined && (Node.isJsxOpeningElement(grandparent) || Node.isJsxSelfClosingElement(grandparent) || Node.isJsxClosingElement(grandparent));
  }
  return false;
}

/** The module portion of a node id (`ts:path/to/file.ts` from `ts:path/to/file.ts#Qual`). */
function moduleOf(nodeId: string): string {
  const hash = nodeId.indexOf("#");
  return hash === -1 ? nodeId : nodeId.slice(0, hash);
}
