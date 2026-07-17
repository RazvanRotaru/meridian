/** Single authority for the current on-disk graph cache coordinate grammar. */

import { lstat, opendir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export const GRAPH_GENERATION_ID = /^[a-z0-9][a-z0-9-]{0,95}$/;
export const GRAPH_COMMIT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

const HASH_24 = /^[0-9a-f]{24}$/;
const HASH_64 = /^[0-9a-f]{64}$/;
const BASE_VARIANT = /^(?:populated|empty-[0-9a-f]{24})$/;
const STAGING_SEGMENT = /^stage-[0-9a-f]{48}$/;
const DEFAULT_VISIT_ENTRY_LIMIT = 100_000;

interface CoordinateSchema {
  readonly kind: "repository" | "pr-head" | "pr-base" | "local";
  readonly root: string;
  readonly coordinates: readonly RegExp[];
}

const FINALIZED_SCHEMAS: readonly CoordinateSchema[] = Object.freeze([
  { kind: "repository", root: "artifacts", coordinates: [HASH_24, GRAPH_COMMIT_ID, HASH_24] },
  {
    kind: "pr-head",
    root: "pr-artifacts",
    coordinates: [HASH_24, HASH_64, HASH_24, GRAPH_COMMIT_ID, GRAPH_COMMIT_ID, HASH_24],
  },
  {
    kind: "pr-base",
    root: "pr-base-artifacts",
    coordinates: [HASH_24, HASH_64, HASH_24, GRAPH_COMMIT_ID, HASH_24, BASE_VARIANT],
  },
  { kind: "local", root: "local-artifacts", coordinates: [] },
]);

const EXACT_LOOKUP_COORDINATES = Object.freeze([
  HASH_24,
  HASH_64,
  HASH_24,
  GRAPH_COMMIT_ID,
  GRAPH_COMMIT_ID,
  HASH_24,
]);

export interface PrHeadGenerationCoordinate {
  readonly kind: "pr-head";
  readonly repositoryKey: string;
  readonly securityDigest: string;
  readonly subdirKey: string;
  readonly headSha: string;
  readonly mergeBaseSha: string;
  readonly analysisKey: string;
  readonly generationId: string;
}

export interface PrBaseGenerationCoordinate {
  readonly kind: "pr-base";
  readonly repositoryKey: string;
  readonly securityDigest: string;
  readonly subdirKey: string;
  readonly mergeBaseSha: string;
  readonly analysisKey: string;
  readonly variant: string;
  readonly generationId: string;
}

export type FinalizedGraphGenerationCoordinate =
  | PrHeadGenerationCoordinate
  | PrBaseGenerationCoordinate
  | {
    readonly kind: "repository";
    readonly repositoryKey: string;
    readonly commit: string;
    readonly analysisKey: string;
    readonly generationId: string;
  }
  | { readonly kind: "local"; readonly generationId: string };

export interface GraphGenerationStageCoordinate {
  readonly kind: "stage";
  readonly token: string;
  readonly directory: string;
}

export type GraphGenerationContainer =
  | { readonly kind: "finalized"; readonly directory: string; readonly coordinate: FinalizedGraphGenerationCoordinate }
  | GraphGenerationStageCoordinate;

export interface PrExactLookupCoordinate {
  readonly path: string;
  readonly repositoryKey: string;
  readonly securityDigest: string;
  readonly subdirKey: string;
  readonly headSha: string;
  readonly baseSha: string;
  readonly analysisKey: string;
}

export interface GraphCacheVisitOptions {
  readonly signal?: AbortSignal;
  /** Bounds corrupt or adversarial directory fan-out before traversal fails closed. */
  readonly maxEntries?: number;
}

export function repositoryArtifactEntry(
  cacheRoot: string,
  repositoryKey: string,
  commit: string,
  analysisKey: string,
): string {
  return join(
    resolve(cacheRoot),
    "artifacts",
    coordinate(repositoryKey, HASH_24, "repository key"),
    coordinate(commit, GRAPH_COMMIT_ID, "commit"),
    coordinate(analysisKey, HASH_24, "analysis key"),
  );
}

export function prHeadArtifactEntry(
  cacheRoot: string,
  repositoryKey: string,
  securityDigest: string,
  subdirKey: string,
  headSha: string,
  mergeBaseSha: string,
  analysisKey: string,
): string {
  return join(
    resolve(cacheRoot),
    "pr-artifacts",
    coordinate(repositoryKey, HASH_24, "repository key"),
    coordinate(securityDigest, HASH_64, "security digest"),
    coordinate(subdirKey, HASH_24, "subdirectory key"),
    coordinate(headSha, GRAPH_COMMIT_ID, "HEAD revision"),
    coordinate(mergeBaseSha, GRAPH_COMMIT_ID, "merge-base revision"),
    coordinate(analysisKey, HASH_24, "analysis key"),
  );
}

export function prBaseArtifactEntry(
  cacheRoot: string,
  repositoryKey: string,
  securityDigest: string,
  subdirKey: string,
  mergeBaseSha: string,
  analysisKey: string,
  variant: string,
): string {
  return join(
    resolve(cacheRoot),
    "pr-base-artifacts",
    coordinate(repositoryKey, HASH_24, "repository key"),
    coordinate(securityDigest, HASH_64, "security digest"),
    coordinate(subdirKey, HASH_24, "subdirectory key"),
    coordinate(mergeBaseSha, GRAPH_COMMIT_ID, "merge-base revision"),
    coordinate(analysisKey, HASH_24, "analysis key"),
    coordinate(variant, BASE_VARIANT, "merge-base variant"),
  );
}

export function prExactLookupFile(
  cacheRoot: string,
  repositoryKey: string,
  securityDigest: string,
  subdirKey: string,
  headSha: string,
  baseSha: string,
  analysisKey: string,
): string {
  return join(
    resolve(cacheRoot),
    "pr-exact-lookups",
    coordinate(repositoryKey, HASH_24, "repository key"),
    coordinate(securityDigest, HASH_64, "security digest"),
    coordinate(subdirKey, HASH_24, "subdirectory key"),
    coordinate(headSha, GRAPH_COMMIT_ID, "HEAD revision"),
    coordinate(baseSha, GRAPH_COMMIT_ID, "base revision"),
    coordinate(analysisKey, HASH_24, "analysis key"),
    "current.json",
  );
}

export function localArtifactGenerations(cacheRoot: string): string {
  return join(resolve(cacheRoot), "local-artifacts", "generations");
}

export function graphGenerationStagingRoot(cacheRoot: string): string {
  return join(resolve(cacheRoot), "graph-generation-staging", "v1", "generations");
}

export function graphGenerationStagePath(cacheRoot: string, token: string): string {
  return join(
    graphGenerationStagingRoot(cacheRoot),
    coordinate(`stage-${token}`, STAGING_SEGMENT, "stage token"),
  );
}

export function finalizedGenerationDirectory(entry: string, generationId: string): string {
  return join(
    resolve(entry),
    "generations",
    coordinate(generationId, GRAPH_GENERATION_ID, "generation id"),
  );
}

/** Cooperative, bounded traversal of current-schema finalized generation roots. */
export async function visitFinalizedGenerationRootsAsync(
  cacheRoot: string,
  visitor: (path: string) => Promise<void> | void,
  options: GraphCacheVisitOptions = {},
): Promise<void> {
  const root = await realpath(resolve(cacheRoot));
  const budget = visitBudget(options.maxEntries);
  for (const schema of FINALIZED_SCHEMAS) {
    throwIfAborted(options.signal);
    const schemaRoot = join(root, schema.root);
    if (!await ownedDirectoryIfPresentAsync(schemaRoot)) continue;
    await visitCoordinatesAsync(
      schemaRoot,
      schema.coordinates,
      0,
      [],
      async (_names, entry) => {
        const generations = join(entry, "generations");
        if (await ownedDirectoryIfPresentAsync(generations)) await visitor(generations);
      },
      budget,
      options.signal,
    );
  }
}

/** Cooperative, bounded traversal of current-schema exact lookup files. */
export async function visitPrExactLookupFilesAsync(
  cacheRoot: string,
  visitor: (coordinate: PrExactLookupCoordinate) => Promise<void> | void,
  options: GraphCacheVisitOptions = {},
): Promise<void> {
  const canonicalCacheRoot = await realpath(resolve(cacheRoot));
  const root = join(canonicalCacheRoot, "pr-exact-lookups");
  if (!await ownedDirectoryIfPresentAsync(root)) return;
  const budget = visitBudget(options.maxEntries);
  await visitCoordinatesAsync(
    root,
    EXACT_LOOKUP_COORDINATES,
    0,
    [],
    async (names, entry) => {
      const path = join(entry, "current.json");
      if (!await ownedFileIfPresentAsync(path)) return;
      await visitor({
        path,
        repositoryKey: names[0]!,
        securityDigest: names[1]!,
        subdirKey: names[2]!,
        headSha: names[3]!,
        baseSha: names[4]!,
        analysisKey: names[5]!,
      });
    },
    budget,
    options.signal,
  );
}

export function parseFinalizedGenerationPath(
  cacheRoot: string,
  generationPath: string,
): FinalizedGraphGenerationCoordinate | null {
  const parts = cacheRelativeParts(cacheRoot, generationPath);
  if (!parts) return null;
  const generationId = parts.at(-1);
  if (!generationId || !GRAPH_GENERATION_ID.test(generationId)) return null;
  if (parts.length === 6 && parts[0] === "artifacts"
    && HASH_24.test(parts[1]!) && GRAPH_COMMIT_ID.test(parts[2]!)
    && HASH_24.test(parts[3]!) && parts[4] === "generations") {
    return {
      kind: "repository",
      repositoryKey: parts[1]!,
      commit: parts[2]!,
      analysisKey: parts[3]!,
      generationId,
    };
  }
  if (parts.length === 9 && parts[0] === "pr-artifacts"
    && HASH_24.test(parts[1]!) && HASH_64.test(parts[2]!) && HASH_24.test(parts[3]!)
    && GRAPH_COMMIT_ID.test(parts[4]!) && GRAPH_COMMIT_ID.test(parts[5]!)
    && HASH_24.test(parts[6]!) && parts[7] === "generations") {
    return {
      kind: "pr-head",
      repositoryKey: parts[1]!,
      securityDigest: parts[2]!,
      subdirKey: parts[3]!,
      headSha: parts[4]!,
      mergeBaseSha: parts[5]!,
      analysisKey: parts[6]!,
      generationId,
    };
  }
  if (parts.length === 9 && parts[0] === "pr-base-artifacts"
    && HASH_24.test(parts[1]!) && HASH_64.test(parts[2]!) && HASH_24.test(parts[3]!)
    && GRAPH_COMMIT_ID.test(parts[4]!) && HASH_24.test(parts[5]!)
    && BASE_VARIANT.test(parts[6]!) && parts[7] === "generations") {
    return {
      kind: "pr-base",
      repositoryKey: parts[1]!,
      securityDigest: parts[2]!,
      subdirKey: parts[3]!,
      mergeBaseSha: parts[4]!,
      analysisKey: parts[5]!,
      variant: parts[6]!,
      generationId,
    };
  }
  if (parts.length === 3 && parts[0] === "local-artifacts" && parts[1] === "generations") {
    return { kind: "local", generationId };
  }
  return null;
}

export function parseGraphGenerationStagePath(
  cacheRoot: string,
  stagePath: string,
): GraphGenerationStageCoordinate | null {
  const parts = cacheRelativeParts(cacheRoot, stagePath);
  if (!parts || parts.length !== 4
    || parts[0] !== "graph-generation-staging"
    || parts[1] !== "v1"
    || parts[2] !== "generations"
    || !STAGING_SEGMENT.test(parts[3]!)) return null;
  return {
    kind: "stage",
    token: parts[3]!.slice("stage-".length),
    directory: resolve(stagePath),
  };
}

export function graphGenerationContainerForNestedPath(
  cacheRoot: string,
  nestedPath: string,
): GraphGenerationContainer | null {
  const root = resolve(cacheRoot);
  let cursor = resolve(nestedPath);
  while (cursor !== root) {
    const finalized = parseFinalizedGenerationPath(root, cursor);
    if (finalized) return { kind: "finalized", directory: cursor, coordinate: finalized };
    const stage = parseGraphGenerationStagePath(root, cursor);
    if (stage) return stage;
    const parent = resolve(cursor, "..");
    if (parent === cursor || !isContained(parent, root)) return null;
    cursor = parent;
  }
  return null;
}

interface VisitBudget { remaining: number }

async function visitCoordinatesAsync(
  parent: string,
  patterns: readonly RegExp[],
  depth: number,
  names: readonly string[],
  visitor: (names: readonly string[], path: string) => Promise<void> | void,
  budget: VisitBudget,
  signal: AbortSignal | undefined,
): Promise<void> {
  throwIfAborted(signal);
  if (depth === patterns.length) {
    await visitor(names, parent);
    return;
  }
  const pattern = patterns[depth]!;
  const directory = await opendir(parent);
  for await (const entry of directory) {
    throwIfAborted(signal);
    budget.remaining -= 1;
    if (budget.remaining < 0) {
      throw new Error("graph cache coordinate traversal exceeded its entry limit");
    }
    if (!pattern.test(entry.name)) continue;
    const child = join(parent, entry.name);
    const childEntry = await lstat(child);
    if (childEntry.isSymbolicLink() || !childEntry.isDirectory()) unsafeCoordinate();
    // Re-resolve immediately before recursive admission. Exact coordinates may never redirect.
    if (await realpath(child) !== resolve(child)) unsafeCoordinate();
    await visitCoordinatesAsync(
      child,
      patterns,
      depth + 1,
      [...names, entry.name],
      visitor,
      budget,
      signal,
    );
  }
  throwIfAborted(signal);
}

function visitBudget(value: number | undefined): VisitBudget {
  const remaining = value ?? DEFAULT_VISIT_ENTRY_LIMIT;
  if (!Number.isSafeInteger(remaining) || remaining <= 0) {
    throw new RangeError("graph cache visit entry limit must be positive");
  }
  return { remaining };
}

async function ownedDirectoryIfPresentAsync(path: string): Promise<boolean> {
  const entry = await entryIfPresentAsync(path);
  if (!entry) return false;
  if (entry.isSymbolicLink() || !entry.isDirectory()) unsafeCoordinate();
  if (await realpath(path) !== resolve(path)) unsafeCoordinate();
  return true;
}

async function ownedFileIfPresentAsync(path: string): Promise<boolean> {
  const entry = await entryIfPresentAsync(path);
  if (!entry) return false;
  if (entry.isSymbolicLink() || !entry.isFile()) unsafeCoordinate();
  return true;
}

async function entryIfPresentAsync(path: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(path);
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) return null;
    throw error;
  }
}

function coordinate(value: string, pattern: RegExp, label: string): string {
  if (!pattern.test(value)) throw new Error(`graph cache ${label} is invalid`);
  return value;
}

function cacheRelativeParts(cacheRoot: string, path: string): string[] | null {
  const root = resolve(cacheRoot);
  const candidate = resolve(path);
  const rel = relative(root, candidate);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return rel.split(sep);
}

function isContained(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function unsafeCoordinate(): never {
  throw new Error("graph cache owned coordinate is unsafe");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason ?? new Error("graph cache traversal aborted");
}

function isErrnoCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as { code?: unknown }).code === code;
}
