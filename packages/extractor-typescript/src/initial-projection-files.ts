/**
 * Cheap, syntax-only file-neighbour discovery for the first PR-review projection.
 *
 * The full extractor remains the semantic authority. This scanner deliberately keeps no
 * ts-morph project or compiler graph alive: it visits each in-scope TypeScript source once,
 * resolves literal module dependencies with the TypeScript compiler API, correlates exact
 * Electron IPC channel literals, conservatively joins compatible unresolved endpoints, and then
 * releases the source text/AST.
 */

import { Buffer } from "node:buffer";
import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  type Dirent,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { compareBinaryStrings as comparePaths } from "@meridian/core";
import { ts } from "ts-morph";
import { DEFAULT_EXCLUDES, isExcluded } from "./glob";
import { absoluteRoot, isUnderRoot, toPosix } from "./paths";
import { discoverWorkspacePaths } from "./workspace-paths";
import { manifestMemberDirs } from "./workspace-scope";

export interface InitialTypeScriptProjectionOptions {
  root: string;
  seeds: readonly string[];
  depth: number;
  exclude?: readonly string[];
  /** Internal override for focused boundary tests; production defaults to the wire topology cap. */
  maxFiles?: number;
  /** Internal stricter selection override; production never exceeds the fixed 20k slice cap. */
  maxSelectedFiles?: number;
}

export interface InitialTypeScriptProjectionFiles {
  /** Every root-relative source file in the requested weak-adjacency BFS slice. */
  files: string[];
  /** Normalized, de-duplicated root-relative seed paths. */
  seeds: string[];
  /**
   * Selected files whose canonical adjacency is not yet complete because a known neighbour is
   * outside `files`. Unresolved Electron channels are conservatively materialized as bounded
   * same-lane adjacency before BFS, so they do not create a permanent incomplete boundary.
   */
  frontier: string[];
}

/** One canonical, extraction-root-relative inventory shared by the initial BFS selector and the
 * background source index. Keeping enumeration here prevents the two progressive paths from
 * drifting on workspace members, exclusions, symlink confinement, or supplemental review files. */
export interface TypeScriptProjectionSourceInventory {
  /** Canonical absolute extraction root. */
  root: string;
  /** Every selectable TypeScript source in deterministic path order. */
  files: string[];
  /** Normalized, de-duplicated supplemental paths admitted to manifest-driven scope. */
  seeds: string[];
}

/** Compact, deterministic topology retained beside the background source-symbol index. */
export interface TypeScriptProjectionTopology {
  root: string;
  seeds: string[];
  files: Array<{
    path: string;
    /** Weak import/dynamic-import/conservative-Electron-IPC adjacency in path order. */
    neighbors: string[];
  }>;
  /** Reserved incomplete endpoints. Conservative Electron pairing currently leaves this empty. */
  uncertainFiles: string[];
}

export interface TypeScriptProjectionTopologyOptions
  extends Pick<InitialTypeScriptProjectionOptions, "root" | "seeds" | "exclude"> {
  /** Optional hard inventory bound, enforced while walking rather than after retaining all paths. */
  maxFiles?: number;
  /** Optional hard total UTF-8 path-byte bound, enforced while walking. */
  maxPathBytes?: number;
  /** Optional directed adjacency-entry bound, enforced as unique weak edges are added. */
  maxAdjacencyEntries?: number;
  /** Observe each immutable source read. The callback must not retain the source text. */
  onSource?(file: string, source: string): void;
}

type IpcRole = "ipcMain" | "ipcRenderer" | "webContents";
type IpcDirection = "in" | "out";

interface IpcRoute {
  lane: string;
  direction: IpcDirection;
}

interface IpcOccurrence extends IpcRoute {
  key: string;
}

interface IpcRouteParticipants {
  route: IpcRoute;
  files: Set<string>;
}

interface SourceScan {
  imports: string[];
  ipc: IpcOccurrence[];
  /** Potentially exact Electron routes whose channel/origin was not statically proven here. */
  uncertainIpc: IpcRoute[];
}

interface ResolutionContext {
  key: string;
  options: ts.CompilerOptions;
}

const SOURCE_EXTENSION = /\.tsx?$/;
const DECLARATION_FILE = /\.d\.ts$/;
const ALWAYS_SKIPPED_DIRECTORIES = new Set([".git", "node_modules"]);
const NEEDS_SYNTAX_TREE =
  /\b(?:ipcMain|ipcRenderer|webContents)\b|\b(?:import|require)(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*(?:\r?\n|$))*\(/;
// TypeScript's ModuleResolutionCache retains failed lookup directories and package metadata for
// every importer/config pair. On large monorepos that compact-looking helper has reached several
// GiB. Keep only small string results in explicit LRUs and let each compiler resolution release its
// internal lookup state immediately.
const MAX_RESOLUTION_RESULTS = 32_768;
const MAX_CONFIG_CONTEXTS = 256;
const MAX_NEAREST_CONFIG_DIRECTORIES = 8_192;
const MAX_INITIAL_PROJECTION_FILES = 100_000;
export const MAX_INITIAL_PROJECTION_SELECTED_FILES = 20_000;
const MAX_INITIAL_PROJECTION_PATH_BYTES = 8 * 1024 * 1024;
const MAX_INITIAL_PROJECTION_ADJACENCY = 1_000_000;

/**
 * Select the bounded TypeScript file neighbourhood needed to make changed files actionable.
 *
 * `null` is fail-closed: the root, depth, or at least one requested seed cannot be proven to be a
 * selectable TypeScript source in this exact workspace revision. An empty seed list is valid and
 * produces an empty projection.
 */
export function selectInitialTypeScriptProjectionFiles(
  options: InitialTypeScriptProjectionOptions,
): InitialTypeScriptProjectionFiles | null {
  if (!Number.isSafeInteger(options.depth) || options.depth < 0) return null;
  const maxFiles = options.maxFiles ?? MAX_INITIAL_PROJECTION_FILES;
  if (!Number.isSafeInteger(maxFiles)
    || maxFiles <= 0
    || maxFiles > MAX_INITIAL_PROJECTION_FILES) return null;
  const maxSelectedFiles = options.maxSelectedFiles ?? MAX_INITIAL_PROJECTION_SELECTED_FILES;
  if (!Number.isSafeInteger(maxSelectedFiles)
    || maxSelectedFiles <= 0
    || maxSelectedFiles > MAX_INITIAL_PROJECTION_SELECTED_FILES) return null;
  // All-additions/all-deletions can leave one exact revision with no roots. Do not enumerate that
  // entire checkout merely to prove the already-closed empty projection.
  if (options.seeds.length === 0) {
    return existingDirectoryRoot(options.root) === null
      ? null
      : { files: [], seeds: [], frontier: [] };
  }

  const inventory = enumerateTypeScriptProjectionSources({
    ...options,
    maxFiles,
    maxPathBytes: MAX_INITIAL_PROJECTION_PATH_BYTES,
  });
  if (inventory === null) return null;
  const requestedSeeds = inventory.seeds;
  const topology = scanTypeScriptProjectionInventory(
    inventory,
    undefined,
    MAX_INITIAL_PROJECTION_ADJACENCY,
  );
  if (topology === null) return null;
  const adjacency = new Map(topology.files.map(({ path, neighbors }) => [path, new Set(neighbors)]));
  const projection = bfsProjection(requestedSeeds, adjacency, options.depth, maxSelectedFiles);
  if (projection === null) return null;
  const selected = new Set(projection.files);
  const frontier = new Set(projection.frontier);
  for (const file of topology.uncertainFiles) if (selected.has(file)) frontier.add(file);
  return { ...projection, frontier: [...frontier].sort(comparePaths) };
}

/** Scan the exact source universe once and retain only compact path adjacency. Source text and ASTs
 * are released per file; callers may use `onSource` to derive another syntax-only sidecar during
 * the same immutable read without constructing a compiler program. */
export function scanTypeScriptProjectionTopology(
  options: TypeScriptProjectionTopologyOptions,
): TypeScriptProjectionTopology | null {
  if (options.maxAdjacencyEntries !== undefined
    && (!Number.isSafeInteger(options.maxAdjacencyEntries)
      || options.maxAdjacencyEntries <= 0
      || options.maxAdjacencyEntries > MAX_INITIAL_PROJECTION_ADJACENCY)) return null;
  const inventory = enumerateTypeScriptProjectionSources(options);
  if (inventory === null) return null;
  return scanTypeScriptProjectionInventory(inventory, options.onSource, options.maxAdjacencyEntries);
}

function scanTypeScriptProjectionInventory(
  inventory: TypeScriptProjectionSourceInventory,
  onSource: TypeScriptProjectionTopologyOptions["onSource"],
  maxAdjacencyEntries: number | undefined,
): TypeScriptProjectionTopology | null {
  const { root, files: sourceFiles, seeds } = inventory;
  const fileUniverse = new Set(sourceFiles);
  const adjacency = new Map<string, Set<string>>(sourceFiles.map((file) => [file, new Set()]));
  const resolver = new WorkspaceModuleResolver(root, fileUniverse);
  const ipcByKey = new Map<string, { in: Set<string>; out: Set<string> }>();
  const exactIpcByRoute = new Map<string, IpcRouteParticipants>();
  const uncertainIpcByRoute = new Map<string, IpcRouteParticipants>();
  let adjacencyEntries = 0;
  const addBoundedEdge = (left: string, right: string): boolean => {
    adjacencyEntries += addUndirectedEdge(adjacency, left, right);
    return maxAdjacencyEntries === undefined || adjacencyEntries <= maxAdjacencyEntries;
  };

  try {
    for (const file of sourceFiles) {
      const source = readFileSync(join(root, file), "utf8");
      onSource?.(file, source);
      const scan = scanSource(file, source);
      for (const specifier of scan.imports) {
        const target = resolver.resolve(specifier, file);
        if (target !== null && !addBoundedEdge(file, target)) return null;
      }
      for (const occurrence of scan.ipc) {
        const bucket = ipcByKey.get(occurrence.key) ?? { in: new Set<string>(), out: new Set<string>() };
        bucket[occurrence.direction].add(file);
        ipcByKey.set(occurrence.key, bucket);
        addIpcRouteParticipant(exactIpcByRoute, occurrence, file);
      }
      for (const route of scan.uncertainIpc) {
        addIpcRouteParticipant(uncertainIpcByRoute, route, file);
      }
    }
  } catch {
    // A partial filesystem scan cannot truthfully prove incoming adjacency.
    return null;
  }

  for (const bucket of ipcByKey.values()) {
    for (const outbound of bucket.out) {
      for (const inbound of bucket.in) if (!addBoundedEdge(outbound, inbound)) return null;
    }
  }
  if (!addConservativeUncertainIpcEdges(
    exactIpcByRoute,
    uncertainIpcByRoute,
    addBoundedEdge,
  )) return null;

  return {
    root,
    seeds,
    files: sourceFiles.map((path) => ({
      path,
      neighbors: [...(adjacency.get(path) ?? [])].sort(comparePaths),
    })),
    // Unknown channel values cannot be matched exactly without semantic extraction. Connecting
    // each unresolved endpoint to every compatible opposite endpoint is a safe over-approximation:
    // it may widen a slice, but cannot omit an IPC neighbour the full extractor later proves.
    uncertainFiles: [],
  };
}

function addConservativeUncertainIpcEdges(
  exactIpcByRoute: ReadonlyMap<string, IpcRouteParticipants>,
  uncertainIpcByRoute: ReadonlyMap<string, IpcRouteParticipants>,
  addEdge: (left: string, right: string) => boolean,
): boolean {
  // An unresolved endpoint can share a channel only with an opposite endpoint on the same
  // transport lane. Materialize that bounded over-approximation without letting (for example) a
  // dynamic invoke handler pull in an unrelated renderer-to-main message sender.
  for (const { route, files: uncertainFiles } of uncertainIpcByRoute.values()) {
    const opposite: IpcRoute = {
      lane: route.lane,
      direction: route.direction === "in" ? "out" : "in",
    };
    const exactOpposite = exactIpcByRoute.get(ipcRouteKey(opposite))?.files;
    const uncertainOpposite = uncertainIpcByRoute.get(ipcRouteKey(opposite))?.files;
    for (const file of uncertainFiles) {
      for (const candidate of exactOpposite ?? []) if (!addEdge(file, candidate)) return false;
      for (const candidate of uncertainOpposite ?? []) if (!addEdge(file, candidate)) return false;
    }
  }
  return true;
}

/** Enumerate the exact source universe without creating a compiler project. `seeds` are
 * supplemental review files, not a filter: declared workspace members remain searchable while an
 * affected file omitted by stale manifests is still admitted exactly as it is for initial BFS. */
export function enumerateTypeScriptProjectionSources(
  options: Pick<InitialTypeScriptProjectionOptions, "root" | "seeds" | "exclude">
    & Pick<TypeScriptProjectionTopologyOptions, "maxFiles" | "maxPathBytes">,
): TypeScriptProjectionSourceInventory | null {
  if (options.maxFiles !== undefined
    && (!Number.isSafeInteger(options.maxFiles)
      || options.maxFiles <= 0
      || options.maxFiles > MAX_INITIAL_PROJECTION_FILES)) return null;
  if (options.maxPathBytes !== undefined
    && (!Number.isSafeInteger(options.maxPathBytes)
      || options.maxPathBytes <= 0
      || options.maxPathBytes > MAX_INITIAL_PROJECTION_PATH_BYTES)) return null;
  const root = existingDirectoryRoot(options.root);
  if (root === null) return null;
  const requestedSeeds = normalizeRequestedSeeds(root, options.seeds);
  if (requestedSeeds === null) return null;
  const excludes = options.exclude === undefined ? DEFAULT_EXCLUDES : [...options.exclude];
  const sourceFiles = enumerateSourceFiles(
    root,
    requestedSeeds,
    excludes,
    options.maxFiles,
    options.maxPathBytes,
  );
  if (sourceFiles === null) return null;
  const fileUniverse = new Set(sourceFiles);
  if (requestedSeeds.some((seed) => !fileUniverse.has(seed))) return null;
  return { root, files: sourceFiles, seeds: requestedSeeds };
}

function addIpcRouteParticipant(
  participants: Map<string, IpcRouteParticipants>,
  route: IpcRoute,
  file: string,
): void {
  const key = ipcRouteKey(route);
  const bucket = participants.get(key) ?? { route, files: new Set<string>() };
  bucket.files.add(file);
  participants.set(key, bucket);
}

function ipcRouteKey(route: IpcRoute): string {
  return `${route.lane}\0${route.direction}`;
}

function existingDirectoryRoot(root: string): string | null {
  try {
    const canonical = absoluteRoot(root);
    return statSync(canonical).isDirectory() ? canonical : null;
  } catch {
    return null;
  }
}

function normalizeRequestedSeeds(root: string, seeds: readonly string[]): string[] | null {
  const normalized = new Set<string>();
  for (const seed of seeds) {
    if (typeof seed !== "string" || seed.length === 0 || seed.includes("\0")) return null;
    const portableSeed = toPosix(seed);
    const absolute = isAbsolute(portableSeed) ? portableSeed : resolve(root, portableSeed);
    let canonical: string;
    try {
      canonical = toPosix(realpathSync.native(absolute));
    } catch {
      return null;
    }
    const relativePath = toPosix(relative(root, canonical));
    if (!isUnderRoot(relativePath) || !SOURCE_EXTENSION.test(relativePath) || DECLARATION_FILE.test(relativePath)) {
      return null;
    }
    normalized.add(relativePath);
  }
  return [...normalized].sort(comparePaths);
}

function enumerateSourceFiles(
  root: string,
  seeds: string[],
  excludes: readonly string[],
  maxFiles: number | undefined,
  maxPathBytes: number | undefined,
): string[] | null {
  const excludePatterns = [...excludes];
  const memberDirs = manifestMemberDirs(root, undefined, seeds)
    ?.map(canonicalPath)
    .filter((candidate): candidate is string => candidate !== null && isWithin(candidate, root))
    ?? null;
  const result = new Set<string>();
  const seenDirectories = new Set<string>();
  const pending = [root];
  let pathBytes = 0;

  try {
    while (pending.length > 0) {
      const directory = pending.pop()!;
      const canonicalDirectory = canonicalPath(directory);
      if (canonicalDirectory === null || seenDirectories.has(canonicalDirectory)) continue;
      seenDirectories.add(canonicalDirectory);
      if (!isWithin(canonicalDirectory, root)) continue;
      if (memberDirs !== null && !couldContainMember(canonicalDirectory, memberDirs)) continue;

      const entries = readdirSync(canonicalDirectory, { withFileTypes: true }).sort(compareEntries);
      for (const entry of entries) {
        if (entry.isDirectory() && ALWAYS_SKIPPED_DIRECTORIES.has(entry.name)) continue;
        const candidate = join(canonicalDirectory, entry.name);
        if (entry.isDirectory() || (entry.isSymbolicLink() && directoryTarget(candidate))) {
          pending.push(candidate);
          continue;
        }
        if (!entry.isFile() && !entry.isSymbolicLink()) continue;
        const canonicalFile = canonicalPath(candidate);
        if (canonicalFile === null || !isWithin(canonicalFile, root)) continue;
        const relativePath = toPosix(relative(root, canonicalFile));
        if (!SOURCE_EXTENSION.test(relativePath) || DECLARATION_FILE.test(relativePath)) continue;
        if (memberDirs !== null && !memberDirs.some((member) => isWithin(canonicalFile, member))) continue;
        if (isExcluded(relativePath, excludePatterns)) continue;
        if (!result.has(relativePath)) {
          result.add(relativePath);
          pathBytes += Buffer.byteLength(relativePath, "utf8");
        }
        if (maxFiles !== undefined && result.size > maxFiles) return null;
        if (maxPathBytes !== undefined && pathBytes > maxPathBytes) return null;
      }
    }
  } catch {
    return null;
  }

  return [...result].sort(comparePaths);
}

function canonicalPath(path: string): string | null {
  try {
    return toPosix(realpathSync.native(path));
  } catch {
    return null;
  }
}

function directoryTarget(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isWithin(path: string, directory: string): boolean {
  const normalizedPath = toPosix(path);
  const normalizedDirectory = toPosix(directory).replace(/\/+$/, "");
  return normalizedPath === normalizedDirectory || normalizedPath.startsWith(`${normalizedDirectory}/`);
}

/** A directory is worth walking if it is a member ancestor, member itself, or inside a member. */
function couldContainMember(directory: string, members: readonly string[]): boolean {
  return members.some((member) => isWithin(member, directory) || isWithin(directory, member));
}

function compareEntries(left: Dirent, right: Dirent): number {
  return comparePaths(left.name, right.name);
}

class WorkspaceModuleResolver {
  private readonly resolutionByConfig = new Map<string, ResolutionContext | null>();
  private readonly nearestConfigByDirectory = new Map<string, string | null>();
  private readonly resolved = new Map<string, string | null>();
  private readonly fallback: ResolutionContext;

  constructor(
    private readonly root: string,
    private readonly files: ReadonlySet<string>,
  ) {
    const workspacePaths = discoverWorkspacePaths(root);
    const options: ts.CompilerOptions = Object.keys(workspacePaths.paths).length === 0
      ? { moduleResolution: ts.ModuleResolutionKind.NodeJs }
      : {
          baseUrl: workspacePaths.baseUrl,
          paths: workspacePaths.paths,
          moduleResolution: ts.ModuleResolutionKind.NodeJs,
        };
    this.fallback = this.context("<workspace>", options);
  }

  resolve(specifier: string, importer: string): string | null {
    if (specifier.startsWith(".")) {
      const direct = this.probeRelative(importer, specifier);
      if (direct !== null) return direct;
    }
    const importerAbsolute = join(this.root, importer);
    const config = this.nearestConfig(dirname(importerAbsolute));
    const primary = config === null ? null : this.configContext(config);
    for (const context of primary === null ? [this.fallback] : [primary, this.fallback]) {
      const key = `${context.key}\0${importerAbsolute}\0${specifier}`;
      const cached = lruGet(this.resolved, key);
      if (cached.found) {
        if (cached.value !== null) return cached.value;
        continue;
      }
      const resolution = ts.resolveModuleName(specifier, importerAbsolute, context.options, ts.sys);
      const selected = this.selectResolvedFile(resolution.resolvedModule?.resolvedFileName);
      lruSet(this.resolved, key, selected, MAX_RESOLUTION_RESULTS);
      if (selected !== null) return selected;
    }
    return null;
  }

  private nearestConfig(startDirectory: string): string | null {
    const cached = lruGet(this.nearestConfigByDirectory, startDirectory);
    if (cached.found) return cached.value;
    const visited: string[] = [];
    let current = startDirectory;
    let found: string | null = null;
    while (isWithin(current, this.root)) {
      visited.push(current);
      const known = lruGet(this.nearestConfigByDirectory, current);
      if (known.found) {
        found = known.value;
        break;
      }
      const candidate = join(current, "tsconfig.json");
      if (existsSync(candidate)) {
        found = candidate;
        break;
      }
      if (toPosix(current) === this.root) break;
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
    for (const directory of visited) {
      lruSet(this.nearestConfigByDirectory, directory, found, MAX_NEAREST_CONFIG_DIRECTORIES);
    }
    return found;
  }

  private configContext(configPath: string): ResolutionContext | null {
    const cached = lruGet(this.resolutionByConfig, configPath);
    if (cached.found) return cached.value;
    const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: () => undefined,
    });
    const context = parsed === undefined ? null : this.context(configPath, parsed.options);
    lruSet(this.resolutionByConfig, configPath, context, MAX_CONFIG_CONTEXTS);
    return context;
  }

  private context(key: string, options: ts.CompilerOptions): ResolutionContext {
    return { key, options };
  }

  private selectResolvedFile(path: string | undefined): string | null {
    if (path === undefined) return null;
    const canonical = canonicalPath(path);
    if (canonical === null || !isWithin(canonical, this.root)) return null;
    const relativePath = toPosix(relative(this.root, canonical));
    return this.files.has(relativePath) ? relativePath : null;
  }

  private probeRelative(importer: string, specifier: string): string | null {
    const importerDirectory = dirname(importer);
    const joined = toPosix(join(importerDirectory, specifier));
    const base = joined.replace(/\.(?:js|jsx|mjs|cjs)$/, "");
    for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
      const normalized = toPosix(candidate);
      if (this.files.has(normalized)) return normalized;
    }
    return null;
  }
}

function lruGet<K, V>(map: Map<K, V>, key: K): { found: true; value: V } | { found: false } {
  if (!map.has(key)) return { found: false };
  const value = map.get(key)!;
  map.delete(key);
  map.set(key, value);
  return { found: true, value };
}

function lruSet<K, V>(map: Map<K, V>, key: K, value: V, capacity: number): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > capacity) {
    const oldest = map.keys().next().value as K | undefined;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

function scanSource(file: string, source: string): SourceScan {
  // Most files contain only declaration-form imports. TypeScript's own preprocessor extracts
  // those without allocating a syntax tree; retain the AST path for runtime imports/requires and
  // IPC because their literal/call shapes must be proven exactly (not guessed from text spans).
  if (!NEEDS_SYNTAX_TREE.test(source)) {
    const imports = new Set(ts.preProcessFile(source, true, true).importedFiles.map((entry) => entry.fileName));
    return { imports: [...imports].sort(comparePaths), ipc: [], uncertainIpc: [] };
  }
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    false,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const imports = new Set<string>();
  const bindings = electronBindings(sourceFile);
  const ipc: IpcOccurrence[] = [];
  const uncertainIpc = new Map<string, IpcRoute>();

  const visit = (node: ts.Node): void => {
    const dependency = moduleSpecifier(node);
    if (dependency !== null) imports.add(dependency);
    if (ts.isCallExpression(node)) {
      const occurrence = ipcOccurrence(node, bindings);
      if (occurrence !== null) ipc.push(occurrence);
      else {
        for (const route of potentialExactElectronEndpoint(node, bindings)) {
          uncertainIpc.set(ipcRouteKey(route), route);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return {
    imports: [...imports].sort(comparePaths),
    ipc,
    uncertainIpc: [...uncertainIpc.values()].sort(compareIpcRoutes),
  };
}

function compareIpcRoutes(left: IpcRoute, right: IpcRoute): number {
  return comparePaths(ipcRouteKey(left), ipcRouteKey(right));
}

function moduleSpecifier(node: ts.Node): string | null {
  if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
    return stringLiteral(node.moduleSpecifier);
  }
  if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
    return node.moduleReference.expression ? stringLiteral(node.moduleReference.expression) : null;
  }
  if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
    return stringLiteral(node.argument.literal);
  }
  if (!ts.isCallExpression(node) || node.arguments.length === 0) return null;
  const expression = unwrapExpression(node.expression);
  const isDynamicImport = expression.kind === ts.SyntaxKind.ImportKeyword;
  const isCommonJsRequire = ts.isIdentifier(expression) && expression.text === "require";
  return isDynamicImport || isCommonJsRequire ? stringLiteral(unwrapExpression(node.arguments[0]!)) : null;
}

interface ElectronBindings {
  direct: ReadonlyMap<string, Exclude<IpcRole, "webContents">>;
  namespaces: ReadonlySet<string>;
  hasElectronOrigin: boolean;
}

function electronBindings(sourceFile: ts.SourceFile): ElectronBindings {
  const direct = new Map<string, Exclude<IpcRole, "webContents">>();
  const namespaces = new Set<string>();
  let hasElectronOrigin = false;

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && stringLiteral(statement.moduleSpecifier) === "electron") {
      const clause = statement.importClause;
      if (clause?.isTypeOnly) continue;
      if (clause?.name) {
        hasElectronOrigin = true;
        namespaces.add(clause.name.text);
      }
      const bindings = clause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) {
        hasElectronOrigin = true;
        namespaces.add(bindings.name.text);
      }
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          if (element.isTypeOnly) continue;
          const imported = element.propertyName?.text ?? element.name.text;
          if (imported === "ipcMain" || imported === "ipcRenderer") {
            hasElectronOrigin = true;
            direct.set(element.name.text, imported);
          }
        }
      }
      continue;
    }
    if (ts.isImportEqualsDeclaration(statement) && electronRequire(statement.moduleReference)) {
      if (statement.isTypeOnly) continue;
      hasElectronOrigin = true;
      namespaces.add(statement.name.text);
      continue;
    }
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      const initializer = declaration.initializer && unwrapExpression(declaration.initializer);
      if (initializer === undefined) continue;
      if (electronRequire(initializer)) {
        const bound = bindElectronName(declaration.name, direct, namespaces);
        hasElectronOrigin = hasElectronOrigin || bound;
      } else if (ts.isIdentifier(initializer) && namespaces.has(initializer.text)) {
        bindElectronName(declaration.name, direct, namespaces);
      }
    }
  }
  return { direct, namespaces, hasElectronOrigin };
}

function bindElectronName(
  name: ts.BindingName,
  direct: Map<string, Exclude<IpcRole, "webContents">>,
  namespaces: Set<string>,
): boolean {
  if (ts.isIdentifier(name)) {
    namespaces.add(name.text);
    return true;
  }
  if (!ts.isObjectBindingPattern(name)) return false;
  let bound = false;
  for (const element of name.elements) {
    if (!ts.isIdentifier(element.name)) continue;
    const imported = element.propertyName && ts.isIdentifier(element.propertyName)
      ? element.propertyName.text
      : element.name.text;
    if (imported === "ipcMain" || imported === "ipcRenderer") {
      direct.set(element.name.text, imported);
      bound = true;
    }
  }
  return bound;
}

function electronRequire(node: ts.Node): boolean {
  const expression = ts.isExternalModuleReference(node) ? node.expression : node;
  if (!expression || !ts.isCallExpression(expression)) return false;
  const callee = unwrapExpression(expression.expression);
  return ts.isIdentifier(callee)
    && callee.text === "require"
    && expression.arguments.length === 1
    && stringLiteral(unwrapExpression(expression.arguments[0]!)) === "electron";
}

function ipcOccurrence(
  call: ts.CallExpression,
  bindings: ElectronBindings,
): IpcOccurrence | null {
  if (call.arguments.length === 0) return null;
  const callee = unwrapExpression(call.expression);
  if (!ts.isPropertyAccessExpression(callee)) return null;
  const role = ipcRole(unwrapExpression(callee.expression), bindings);
  if (role === null) return null;
  const route = ipcRoute(role, callee.name.text);
  if (route === null) return null;
  const channel = stringLiteral(unwrapExpression(call.arguments[0]!));
  return channel === null ? null : { ...route, key: `${route.lane}\0${channel}` };
}

const ELECTRON_TRAVERSAL_MEMBERS = new Set([
  "send",
  "sendSync",
  "invoke",
  "postMessage",
  "on",
  "once",
  "addListener",
  "handle",
  "handleOnce",
]);

/**
 * Over-approximate calls that the semantic ports pass could prove as exact Electron endpoints.
 * False positives only delay readiness; false negatives could make a provisional depth claim
 * unsound. The semantic pass follows local receiver aliases, so any Electron-origin file using an
 * endpoint-shaped member is retained as uncertain when this scanner cannot prove the same call.
 */
function potentialExactElectronEndpoint(
  call: ts.CallExpression,
  bindings: ElectronBindings,
): IpcRoute[] {
  const callee = unwrapExpression(call.expression);
  if (!ts.isPropertyAccessExpression(callee) || !ELECTRON_TRAVERSAL_MEMBERS.has(callee.name.text)) {
    return [];
  }
  const role = ipcRole(unwrapExpression(callee.expression), bindings);
  if (role === "ipcMain" || role === "ipcRenderer" || role === "webContents") {
    const route = ipcRoute(role, callee.name.text);
    return route === null ? [] : [route];
  }
  return bindings.hasElectronOrigin ? possibleAliasedIpcRoutes(callee.name.text) : [];
}

function possibleAliasedIpcRoutes(member: string): IpcRoute[] {
  if (["send", "sendSync", "postMessage"].includes(member)) {
    return [{ lane: "renderer-main-message", direction: "out" }];
  }
  if (member === "invoke") return [{ lane: "renderer-main-invoke", direction: "out" }];
  if (["handle", "handleOnce"].includes(member)) {
    return [{ lane: "renderer-main-invoke", direction: "in" }];
  }
  if (["on", "once", "addListener"].includes(member)) {
    return [
      { lane: "main-renderer-message", direction: "in" },
      { lane: "renderer-main-message", direction: "in" },
    ];
  }
  return [];
}

function ipcRole(expression: ts.Expression, bindings: ElectronBindings): IpcRole | null {
  if (ts.isIdentifier(expression)) return bindings.direct.get(expression.text) ?? null;
  if (!ts.isPropertyAccessExpression(expression)) return null;
  if (expression.name.text === "webContents") return "webContents";
  if (
    (expression.name.text === "ipcMain" || expression.name.text === "ipcRenderer")
    && ts.isIdentifier(unwrapExpression(expression.expression))
    && bindings.namespaces.has((unwrapExpression(expression.expression) as ts.Identifier).text)
  ) {
    return expression.name.text;
  }
  return null;
}

function ipcRoute(role: IpcRole, member: string): IpcRoute | null {
  if (role === "ipcRenderer") {
    if (["send", "sendSync", "postMessage"].includes(member)) {
      return { lane: "renderer-main-message", direction: "out" };
    }
    if (member === "invoke") return { lane: "renderer-main-invoke", direction: "out" };
    if (["on", "once", "addListener"].includes(member)) {
      return { lane: "main-renderer-message", direction: "in" };
    }
    return null;
  }
  if (role === "ipcMain") {
    if (["on", "once", "addListener"].includes(member)) {
      return { lane: "renderer-main-message", direction: "in" };
    }
    if (["handle", "handleOnce"].includes(member)) {
      return { lane: "renderer-main-invoke", direction: "in" };
    }
    return null;
  }
  return ["send", "postMessage"].includes(member)
    ? { lane: "main-renderer-message", direction: "out" }
    : null;
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isSatisfiesExpression(current)
    || ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function stringLiteral(node: ts.Node): string | null {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : null;
}

function addUndirectedEdge(adjacency: Map<string, Set<string>>, left: string, right: string): number {
  if (left === right || !adjacency.has(left) || !adjacency.has(right)) return 0;
  const leftNeighbors = adjacency.get(left)!;
  if (leftNeighbors.has(right)) return 0;
  leftNeighbors.add(right);
  adjacency.get(right)!.add(left);
  return 2;
}

function bfsProjection(
  seeds: string[],
  adjacency: ReadonlyMap<string, ReadonlySet<string>>,
  depth: number,
  maxFiles: number,
): InitialTypeScriptProjectionFiles | null {
  const distance = new Map<string, number>();
  const queue: string[] = [];
  for (const seed of seeds) {
    distance.set(seed, 0);
    queue.push(seed);
  }
  if (distance.size > maxFiles) return null;
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index]!;
    const nextDepth = distance.get(current)! + 1;
    if (nextDepth > depth) continue;
    for (const neighbour of [...(adjacency.get(current) ?? [])].sort(comparePaths)) {
      if (distance.has(neighbour)) continue;
      distance.set(neighbour, nextDepth);
      if (distance.size > maxFiles) return null;
      queue.push(neighbour);
    }
  }
  const files = [...distance.keys()].sort(comparePaths);
  const selected = new Set(files);
  const frontier = files.filter((file) =>
    [...(adjacency.get(file) ?? [])].some((neighbour) => !selected.has(neighbour)));
  return { files, seeds, frontier };
}
