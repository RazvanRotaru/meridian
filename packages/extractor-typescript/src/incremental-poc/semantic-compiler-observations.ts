/**
 * Target-recomputed compiler observations for file-grained semantic reuse.
 *
 * The cached V1 semantic lanes resolve symbols and, for container-shaped calls, inspect a
 * receiver's static type. A full-program source hash is unnecessarily broad: an unrelated global
 * script can join TypeScript's global scope without changing any decision made for another file.
 *
 * This module records a deliberately conservative superset of those decisions. Every identifier
 * binding is observed, aliases and shorthand value symbols are followed, exported symbols are
 * observed, and container receiver type identities are recorded. The transcript is hashed in
 * exact source order while declaration owners become explicit direct provider dependencies.
 *
 * No TypeScript object escapes. Any unavailable or throwing compiler observation is a fail-closed
 * reason for the owning unit rather than a partial proof.
 */

import { createHash } from "node:crypto";
import { Node, ts, type SourceFile } from "ts-morph";
import {
  deriveTargetReference,
  type TargetReferenceDerivation,
} from "../edge-resolve";
import {
  traceConstructedReceiverMember,
} from "../constructed-receiver";
import type { ImportedSymbolReference } from "../import-reference";
import type { LoadedProject } from "../project-loader";
import { toPosix } from "../paths";
import { throughLocalReexports } from "../reexport-reference";
import { canonicalJson, compareCanonicalStrings } from "./canonical-json";
import { portableFingerprintAddress } from "./fingerprints";

export const SEMANTIC_COMPILER_OBSERVATION_VERSION = 4 as const;

export interface SemanticCompilerFileObservation {
  version: typeof SEMANTIC_COMPILER_OBSERVATION_VERSION;
  address: string;
  digest: string;
  queryCount: number;
  providerAddresses: string[];
}

export interface SemanticCompilerObservationResult {
  version: typeof SEMANTIC_COMPILER_OBSERVATION_VERSION;
  files: SemanticCompilerFileObservation[];
  unsafeReasons: string[];
}

export interface InspectedSemanticCompilerFileObservation
  extends SemanticCompilerFileObservation {
  transcript: unknown[];
}

interface DeclarationObservation {
  address: string;
  end: number;
  kind: number;
  start: number;
}

interface SymbolObservation {
  declarations: DeclarationObservation[];
  flags: number;
  name: string;
}

interface TypeObservation {
  alias: SymbolObservation | null;
  symbol: SymbolObservation | null;
}

/**
 * Observe every requested source (or the whole Program when omitted). Provider addresses remain
 * valid only when they belong to this same exact Program, including non-selected dependencies.
 */
export function collectSemanticCompilerObservations(
  loaded: LoadedProject,
  requestedAddresses?: ReadonlySet<string>,
): SemanticCompilerObservationResult {
  const program = loaded.project.getProgram().compilerObject;
  const checker = program.getTypeChecker();
  const sourceFiles = program.getSourceFiles();
  const addressBySourceFile = new Map(
    sourceFiles.map((sourceFile) => [
      sourceFile,
      portableFingerprintAddress(loaded.root, toPosix(sourceFile.fileName)),
    ]),
  );
  const addressByFilePath = new Map(
    sourceFiles.map((sourceFile) => [
      toPosix(sourceFile.fileName),
      addressBySourceFile.get(sourceFile)!,
    ]),
  );
  const selectedFilePaths = new Set(
    loaded.sourceFiles.map((sourceFile) => toPosix(sourceFile.getFilePath())),
  );
  const selectedSourceFileByAddress = new Map(
    loaded.sourceFiles.map((sourceFile) => [
      portableFingerprintAddress(loaded.root, toPosix(sourceFile.getFilePath())),
      sourceFile,
    ]),
  );
  const knownAddresses = new Set(addressBySourceFile.values());
  const unsafeReasons: string[] = [];
  const files: SemanticCompilerFileObservation[] = [];

  const observedSourceFiles = requestedAddresses === undefined
    ? sourceFiles
    : sourceFiles.filter((sourceFile) => (
        requestedAddresses.has(addressBySourceFile.get(sourceFile)!)
      ));
  if (
    requestedAddresses !== undefined
    && observedSourceFiles.length !== requestedAddresses.size
  ) {
    const observedAddresses = new Set(
      observedSourceFiles.map((sourceFile) => addressBySourceFile.get(sourceFile)!),
    );
    for (const address of requestedAddresses) {
      if (!observedAddresses.has(address)) {
        unsafeReasons.push(`compiler-semantic-observation-source-absent:${address}`);
      }
    }
  }

  for (const sourceFile of observedSourceFiles) {
    const address = addressBySourceFile.get(sourceFile)!;
    const selectedSourceFile = selectedSourceFileByAddress.get(address);
    if (requestedAddresses !== undefined && selectedSourceFile === undefined) {
      unsafeReasons.push(`compiler-semantic-observation-selected-source-unmapped:${address}`);
      continue;
    }
    try {
      files.push(observeSourceFile({
        address,
        addressByFilePath,
        addressBySourceFile,
        checker,
        knownAddresses,
        selectedFilePaths,
        selectedSourceFile,
        sourceFile,
      }));
    } catch {
      unsafeReasons.push(`compiler-semantic-observation-failed:${address}`);
    }
  }

  files.sort((left, right) => compareCanonicalStrings(left.address, right.address));
  unsafeReasons.sort(compareCanonicalStrings);
  return {
    version: SEMANTIC_COMPILER_OBSERVATION_VERSION,
    files,
    unsafeReasons: [...new Set(unsafeReasons)],
  };
}

/** Expensive report-only expansion used to explain a changed digest. */
export function inspectSemanticCompilerObservation(
  loaded: LoadedProject,
  address: string,
): InspectedSemanticCompilerFileObservation {
  const program = loaded.project.getProgram().compilerObject;
  const checker = program.getTypeChecker();
  const sourceFiles = program.getSourceFiles();
  const addressBySourceFile = new Map(
    sourceFiles.map((sourceFile) => [
      sourceFile,
      portableFingerprintAddress(loaded.root, toPosix(sourceFile.fileName)),
    ]),
  );
  const addressByFilePath = new Map(
    sourceFiles.map((sourceFile) => [
      toPosix(sourceFile.fileName),
      addressBySourceFile.get(sourceFile)!,
    ]),
  );
  const selectedFilePaths = new Set(
    loaded.sourceFiles.map((candidate) => toPosix(candidate.getFilePath())),
  );
  const selectedSourceFileByAddress = new Map(
    loaded.sourceFiles.map((candidate) => [
      portableFingerprintAddress(loaded.root, toPosix(candidate.getFilePath())),
      candidate,
    ]),
  );
  const sourceFile = sourceFiles.find(
    (candidate) => addressBySourceFile.get(candidate) === address,
  );
  if (sourceFile === undefined) {
    throw new Error(`compiler semantic observation source is absent: ${address}`);
  }
  const transcript: unknown[] = [];
  return {
    ...observeSourceFile({
      address,
      addressByFilePath,
      addressBySourceFile,
      checker,
      knownAddresses: new Set(addressBySourceFile.values()),
      selectedFilePaths,
      selectedSourceFile: selectedSourceFileByAddress.get(address),
      sourceFile,
      transcript,
    }),
    transcript,
  };
}

function observeSourceFile(input: {
  address: string;
  addressByFilePath: ReadonlyMap<string, string>;
  addressBySourceFile: ReadonlyMap<ts.SourceFile, string>;
  checker: ts.TypeChecker;
  knownAddresses: ReadonlySet<string>;
  selectedFilePaths: ReadonlySet<string>;
  selectedSourceFile: SourceFile | undefined;
  sourceFile: ts.SourceFile;
  transcript?: unknown[];
}): SemanticCompilerFileObservation {
  const hash = createHash("sha256");
  const providerAddresses = new Set<string>();
  let queryCount = 0;
  hash.update(canonicalJson({
    address: input.address,
    version: SEMANTIC_COMPILER_OBSERVATION_VERSION,
  }));

  const record = (kind: string, node: ts.Node, value: unknown): void => {
    queryCount += 1;
    const observation = {
      end: node.end,
      kind,
      start: node.getStart(input.sourceFile),
      value,
    };
    input.transcript?.push(observation);
    hash.update("\0");
    hash.update(canonicalJson(observation));
  };
  const observeSymbol = (
    symbol: ts.Symbol | undefined,
  ): { direct: SymbolObservation | null; aliased: SymbolObservation | null } => {
    const direct = symbolObservation(
      symbol,
      input.addressBySourceFile,
      input.knownAddresses,
      input.address,
      providerAddresses,
    );
    let aliased: SymbolObservation | null = null;
    if (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0) {
      aliased = symbolObservation(
        input.checker.getAliasedSymbol(symbol),
        input.addressBySourceFile,
        input.knownAddresses,
        input.address,
        providerAddresses,
      );
    }
    return { direct, aliased };
  };

  const visit = (node: ts.Node): void => {
    if (
      ts.isIdentifier(node)
      || ts.isPrivateIdentifier(node)
      || ts.isStringLiteralLike(node)
    ) {
      const symbol = input.checker.getSymbolAtLocation(node);
      const observed = observeSymbol(symbol);
      const shorthand = ts.isIdentifier(node)
        && ts.isShorthandPropertyAssignment(node.parent)
        && node.parent.name === node
        ? observeSymbol(
            input.checker.getShorthandAssignmentValueSymbol(node.parent),
          )
        : null;
      record("binding", node, { observed, shorthand });
    }

    if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && (
        node.expression.name.text === "register"
        || node.expression.name.text === "get"
      )
    ) {
      const receiver = node.expression.expression;
      const type = input.checker.getTypeAtLocation(receiver);
      const observedType: TypeObservation = {
        alias: symbolObservation(
          type.aliasSymbol,
          input.addressBySourceFile,
          input.knownAddresses,
          input.address,
          providerAddresses,
        ),
        symbol: symbolObservation(
          type.getSymbol(),
          input.addressBySourceFile,
          input.knownAddresses,
          input.address,
          providerAddresses,
        ),
      };
      record("container-receiver-type", receiver, observedType);
    }

    ts.forEachChild(node, visit);
  };
  visit(input.sourceFile);

  if (input.selectedSourceFile !== undefined) {
    observeConstructedReceiverMembers({
      observeDeclaration: (declaration) => declarationObservation(
        declaration.compilerNode as ts.Declaration,
        input.addressBySourceFile,
        input.knownAddresses,
        input.address,
        providerAddresses,
      ),
      observeSymbol: (symbol) => symbolObservation(
        symbol?.compilerSymbol,
        input.addressBySourceFile,
        input.knownAddresses,
        input.address,
        providerAddresses,
      ),
      record,
      sourceFile: input.selectedSourceFile,
    });
    observeLocalReexportProviders({
      addressByFilePath: input.addressByFilePath,
      consumerAddress: input.address,
      observeTargetImplementation: (node, derivation) => {
        if (derivation.shorthandValueSteps.length === 0) return;
        record(
          "target-implementation-shorthand",
          node.compilerNode,
          derivation.shorthandValueSteps.map((step) => ({
            shorthand: declarationObservation(
              step.declaration.compilerNode as ts.Declaration,
              input.addressBySourceFile,
              input.knownAddresses,
              input.address,
              providerAddresses,
            ),
            valueSymbol: symbolObservation(
              step.valueSymbol?.compilerSymbol,
              input.addressBySourceFile,
              input.knownAddresses,
              input.address,
              providerAddresses,
            ),
          })),
        );
      },
      providerAddresses,
      selectedFilePaths: input.selectedFilePaths,
      sourceFile: input.selectedSourceFile,
    });
  }

  const moduleSymbol = input.checker.getSymbolAtLocation(input.sourceFile);
  if (moduleSymbol !== undefined) {
    const exported = input.checker.getExportsOfModule(moduleSymbol)
      .map((symbol) => ({
        exportedName: symbol.getName(),
        observed: observeSymbol(symbol),
      }));
    record("module-exports", input.sourceFile, exported);
  }

  return {
    version: SEMANTIC_COMPILER_OBSERVATION_VERSION,
    address: input.address,
    digest: hash.digest("hex"),
    queryCount,
    providerAddresses: [...providerAddresses].sort(compareCanonicalStrings),
  };
}

/** Record the exact extra checker query used to recover an any-typed receiver's member target. */
function observeConstructedReceiverMembers(input: {
  observeDeclaration: (declaration: Node) => DeclarationObservation;
  observeSymbol: (symbol: import("ts-morph").Symbol | undefined) => SymbolObservation | null;
  record: (kind: string, node: ts.Node, value: unknown) => void;
  sourceFile: SourceFile;
}): void {
  for (const call of input.sourceFile.getDescendantsOfKind(ts.SyntaxKind.CallExpression)) {
    const callee = call.getExpression();
    const trace = traceConstructedReceiverMember(callee);
    if (trace === null) continue;
    input.record("constructed-receiver-member", callee.compilerNode, {
      construction: {
        end: trace.construction.getEnd(),
        kind: trace.construction.getKind(),
        start: trace.construction.getStart(),
      },
      consensus: trace.consensus === null
        ? null
        : {
            declaration: input.observeDeclaration(trace.consensus.declaration),
            symbol: input.observeSymbol(trace.consensus.symbol),
          },
      memberDeclarations: trace.memberDeclarations.map(input.observeDeclaration),
      memberSymbol: input.observeSymbol(trace.memberSymbol),
      storageDeclaration: input.observeDeclaration(trace.storageDeclaration),
      typeSymbol: input.observeSymbol(trace.typeSymbol),
    });
  }
}

function observeLocalReexportProviders(input: {
  addressByFilePath: ReadonlyMap<string, string>;
  consumerAddress: string;
  observeTargetImplementation: (
    node: Node,
    derivation: TargetReferenceDerivation,
  ) => void;
  providerAddresses: Set<string>;
  selectedFilePaths: ReadonlySet<string>;
  sourceFile: SourceFile;
}): void {
  const importedReferences = new Map<string, ImportedSymbolReference>();
  for (const node of importedReferenceCandidates(input.sourceFile)) {
    const derivation = deriveTargetReference(node);
    input.observeTargetImplementation(node, derivation);
    const { imported } = derivation;
    if (imported === null) continue;
    const identity = canonicalJson({
      exportedName: imported.exportedName,
      fromFile: toPosix(imported.fromFile),
      specifier: imported.specifier,
      targetFile: imported.targetFile === null ? null : toPosix(imported.targetFile),
    });
    if (!importedReferences.has(identity)) {
      importedReferences.set(identity, imported);
    }
  }

  for (const [, imported] of [...importedReferences]
    .sort(([left], [right]) => compareCanonicalStrings(left, right))) {
    throughLocalReexports(
      imported,
      input.selectedFilePaths,
      (visitedSourceFile) => {
        const filePath = toPosix(visitedSourceFile.getFilePath());
        if (!input.selectedFilePaths.has(filePath)) {
          throw new Error(
            `local re-export traversal visited an unselected source: ${filePath}`,
          );
        }
        const providerAddress = input.addressByFilePath.get(filePath);
        if (providerAddress === undefined) {
          throw new Error(
            `local re-export traversal visited a source outside the exact Program: ${filePath}`,
          );
        }
        if (providerAddress !== input.consumerAddress) {
          input.providerAddresses.add(providerAddress);
        }
      },
    );
  }
}

/**
 * Keep checker-backed import derivation off ordinary identifiers. Property and qualified accesses
 * remain unconditional because import recovery may inspect their receiver's imported type. A bare
 * identifier can contribute an imported reference only when its spelling is a local import binding
 * or when it is written inside a supported import/export declaration. The spelling check is
 * intentionally scope-insensitive: a shadow with the same name is a harmless conservative
 * candidate whose exact symbol is still decided by deriveTargetReference.
 */
function importedReferenceCandidates(sourceFile: SourceFile): Node[] {
  const candidates: Node[] = [];
  const seenCompilerNodes = new Set<ts.Node>();
  const localImportBindings = new Set<string>();
  const importDeclarations = sourceFile.getImportDeclarations();
  const exportDeclarations = sourceFile.getExportDeclarations();
  const addCandidate = (node: Node): void => {
    if (seenCompilerNodes.has(node.compilerNode)) return;
    seenCompilerNodes.add(node.compilerNode);
    candidates.push(node);
  };

  for (const declaration of importDeclarations) {
    const defaultImport = declaration.getDefaultImport();
    if (defaultImport !== undefined) {
      localImportBindings.add(defaultImport.getText());
    }
    const namespaceImport = declaration.getNamespaceImport();
    if (namespaceImport !== undefined) {
      localImportBindings.add(namespaceImport.getText());
    }
    for (const namedImport of declaration.getNamedImports()) {
      localImportBindings.add(
        (namedImport.getAliasNode() ?? namedImport.getNameNode()).getText(),
      );
    }
  }

  // Export-from and local re-export identifiers can carry the public boundary even when no local
  // import binding exists in this file. Imports are included as a fail-safe for declaration-only
  // or otherwise unused bindings.
  for (const declaration of [
    ...importDeclarations,
    ...exportDeclarations,
  ]) {
    for (const identifier of declaration.getDescendantsOfKind(ts.SyntaxKind.Identifier)) {
      addCandidate(identifier);
    }
  }

  sourceFile.forEachDescendant((node) => {
    if (Node.isPropertyAccessExpression(node) || Node.isQualifiedName(node)) {
      addCandidate(node);
      return;
    }
    if (Node.isIdentifier(node) && localImportBindings.has(node.getText())) {
      addCandidate(node);
    }
  });

  return candidates.sort((left, right) => (
    left.getStart() - right.getStart()
    || left.getEnd() - right.getEnd()
    || left.getKind() - right.getKind()
  ));
}

function symbolObservation(
  symbol: ts.Symbol | undefined,
  addressBySourceFile: ReadonlyMap<ts.SourceFile, string>,
  knownAddresses: ReadonlySet<string>,
  consumerAddress: string,
  providerAddresses: Set<string>,
): SymbolObservation | null {
  if (symbol === undefined) return null;
  const declarations = (symbol.getDeclarations() ?? [])
    .map((declaration): DeclarationObservation => declarationObservation(
      declaration,
      addressBySourceFile,
      knownAddresses,
      consumerAddress,
      providerAddresses,
    ));
  return {
    declarations,
    flags: symbol.flags,
    name: portableSymbolName(symbol.getName(), declarations),
  };
}

function declarationObservation(
  declaration: ts.Declaration,
  addressBySourceFile: ReadonlyMap<ts.SourceFile, string>,
  knownAddresses: ReadonlySet<string>,
  consumerAddress: string,
  providerAddresses: Set<string>,
): DeclarationObservation {
  const sourceFile = declaration.getSourceFile();
  const address = addressBySourceFile.get(sourceFile);
  if (address === undefined) {
    throw new Error(
      `compiler semantic declaration is outside the exact Program: ${sourceFile.fileName}`,
    );
  }
  if (knownAddresses.has(address) && address !== consumerAddress) {
    providerAddresses.add(address);
  }
  return {
    address,
    end: declaration.end,
    kind: declaration.kind,
    start: declaration.getStart(sourceFile),
  };
}

function portableSymbolName(
  name: string,
  declarations: readonly DeclarationObservation[],
): string {
  if (
    name.length >= 2
    && name.startsWith('"')
    && name.endsWith('"')
    && declarations.length > 0
    && (
      name.charAt(1) === "/"
      || /^[A-Za-z]:[\\/]/u.test(name.slice(1, -1))
    )
  ) {
    return `"${declarations[0]!.address}"`;
  }
  return name;
}
