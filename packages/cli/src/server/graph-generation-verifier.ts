import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  createReadStream,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
  type BigIntStats,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  GraphGenerationLifecycle,
  sealGraphGenerationStage,
  type GraphGenerationStage,
  type GraphGenerationStagePublicationSeal,
} from "./graph-generation-lifecycle";
import {
  GRAPH_COMMIT_ID,
  graphGenerationContainerForNestedPath,
  type GraphGenerationContainer,
} from "./graph-cache-layout";
import type { GraphGenerationSummary } from "./graph-generation-contract";
import { readGraphProjectionManifest } from "./graph-projection-bundle";

const SHA256 = /^[0-9a-f]{64}$/;
const SEAL_FORMAT_VERSION = 2;
const SEAL_FILE = "graph-generation.seal.json";
const MAX_SEAL_BYTES = 8 * 1024 * 1024;
const MAX_VERIFIED_SEALS = 128;
const MAX_VERIFIED_SEAL_CACHE_BYTES = 4 * 1024 * 1024;

export interface UnsealedGraphGenerationIntegrity {
  readonly artifactBytes: number;
  readonly artifactSha256: string;
  readonly projectionBytes: number;
  readonly projectionSha256: string;
  readonly projectionContentId: string;
}

export interface GraphGenerationIntegrity extends UnsealedGraphGenerationIntegrity {
  readonly sealSha256: string;
}

interface GraphGenerationIdentity {
  readonly cacheRoot: string;
  readonly artifactPath: string;
  readonly projectionDirectory: string;
  readonly graphSummary: GraphGenerationSummary;
  readonly revision: GraphRevisionIdentity;
}

export type GraphRevisionIdentity =
  | { readonly kind: "git"; readonly commit: string }
  | { readonly kind: "content"; readonly contentId: string };

export interface SealGraphGenerationInput
  extends GraphGenerationIdentity, UnsealedGraphGenerationIntegrity {
  readonly stage: GraphGenerationStage;
}

export interface VerifyGraphGenerationInput
  extends GraphGenerationIdentity, GraphGenerationIntegrity {}

export interface VerifyExistingGraphGenerationInput
  extends GraphGenerationIdentity, UnsealedGraphGenerationIntegrity {}

const verifiedGraphGeneration = Symbol("verifiedGraphGeneration");
const sealedGraphGenerationStage = Symbol("sealedGraphGenerationStage");

/**
 * Integrity established while bytes are still owned by an unpublished lifecycle stage.
 *
 * This deliberately is not a `VerifiedGraphGeneration`: the stage can still be renamed into its
 * final coordinate (or discarded) and therefore must never cross the capability-publication
 * boundary.  Callers may carry these digests through publication and then adopt the exact final
 * coordinate with `verifyExistingGraphGeneration`.
 */
export interface SealedGraphGenerationStage extends GraphGenerationIntegrity {
  readonly [sealedGraphGenerationStage]: true;
  readonly artifactPath: string;
  readonly projectionDirectory: string;
  readonly stageDirectory: string;
  readonly graphSummary: GraphGenerationSummary;
  readonly revision: GraphRevisionIdentity;
}

export interface VerifiedGraphGeneration extends GraphGenerationIntegrity {
  readonly [verifiedGraphGeneration]: true;
  readonly artifactPath: string;
  readonly projectionDirectory: string;
  readonly generationDirectory: string;
  readonly graphSummary: GraphGenerationSummary;
  readonly revision: GraphRevisionIdentity;
}

interface FsIdentity {
  readonly dev: string;
  readonly ino: string;
  readonly size: string;
  readonly mtimeNs: string;
  readonly ctimeNs: string;
}

interface HashedFile {
  readonly bytes: number;
  readonly sha256: string;
  readonly identity: FsIdentity;
}

interface HashedDirectory {
  readonly bytes: number;
  readonly sha256: string;
  readonly files: readonly { readonly path: string; readonly identity: FsIdentity }[];
}

interface StagePublicationSnapshot {
  readonly root: Pick<FsIdentity, "dev" | "ino">;
  readonly directories: readonly SealedEntry[];
  readonly files: readonly SealedEntry[];
}

/** Deterministic adversarial seam used only by sealing race tests. */
export interface SealGraphGenerationHooks {
  readonly afterTrustedContentHash?: () => Promise<void> | void;
}

interface SealedEntry extends FsIdentity {
  readonly path: string;
}

interface GraphGenerationSeal {
  readonly formatVersion: typeof SEAL_FORMAT_VERSION;
  readonly root: Pick<FsIdentity, "dev" | "ino">;
  readonly artifact: { readonly path: string; readonly bytes: number; readonly sha256: string };
  readonly projection: {
    readonly path: string;
    readonly bytes: number;
    readonly sha256: string;
    readonly contentId: string;
  };
  readonly graphSummary: GraphGenerationSummary;
  readonly revision: GraphRevisionIdentity;
  readonly directories: readonly SealedEntry[];
  readonly files: readonly SealedEntry[];
}

interface CachedSeal {
  readonly sealFile: FsIdentity;
  readonly seal: GraphGenerationSeal;
  readonly weight: number;
}

interface ResolvedGenerationPaths {
  readonly cacheRoot: string;
  readonly artifactPath: string;
  readonly projectionDirectory: string;
  readonly generationDirectory: string;
}

const verifiedSeals = new Map<string, CachedSeal>();
let verifiedSealBytes = 0;
let fullContentHashStreams = 0;
let sealFileReads = 0;

/** Hash child-authored projection bytes once so the digest can cross the IPC boundary. */
export async function measureGraphProjectionBundle(
  projectionDirectory: string,
  cacheRoot: string,
  signal?: AbortSignal,
): Promise<Pick<UnsealedGraphGenerationIntegrity, "projectionBytes" | "projectionSha256">> {
  const root = requirePlainPath(resolve(cacheRoot), "directory");
  const directory = requireContainedPlainPath(cacheRoot, projectionDirectory, "directory");
  const container = generationContainerFor(root, directory);
  const projection = container.kind === "stage"
    ? await new GraphGenerationLifecycle({ cacheRoot: root }).withOwnedStage(
        container.directory,
        () => hashDirectory(directory, signal),
        signal,
      )
    : await withGenerationOperation(
        root,
        container.directory,
        signal,
        () => hashDirectory(directory, signal),
      );
  return { projectionBytes: projection.bytes, projectionSha256: projection.sha256 };
}

/** Bounded process diagnostics used by phase timing and regression tests. */
export function graphGenerationVerificationStats(): {
  fullContentHashStreams: number;
  sealFileReads: number;
  verifiedSealEntries: number;
  verifiedSealBytes: number;
  maxVerifiedSealBytes: number;
} {
  return {
    fullContentHashStreams,
    sealFileReads,
    verifiedSealEntries: verifiedSeals.size,
    verifiedSealBytes,
    maxVerifiedSealBytes: MAX_VERIFIED_SEAL_CACHE_BYTES,
  };
}

/** Full pre-publication verification followed by a compact, immutable stat seal. */
export async function sealGraphGeneration(
  input: SealGraphGenerationInput,
  signal?: AbortSignal,
  hooks: SealGraphGenerationHooks = {},
): Promise<SealedGraphGenerationStage> {
  validateIdentity(input);
  validateUnsealedIntegrity(input);
  const trusted = snapshotSealInput(input);
  const paths = resolveGenerationPaths(
    trusted.cacheRoot,
    trusted.artifactPath,
    trusted.projectionDirectory,
    "stage",
  );
  return sealGraphGenerationStage(input.stage, paths.generationDirectory, async () => {
    const sideDirectory = dirname(paths.artifactPath);
    const sealPath = join(sideDirectory, SEAL_FILE);
    if (existsSync(sealPath)) throw new Error("graph generation seal already exists");

    const filesBefore = listPlainFiles(sideDirectory, [SEAL_FILE]);
    const directoriesBefore = listPlainDirectories(paths.projectionDirectory);
    for (const path of filesBefore) chmodIfNeeded(path, 0o400);
    for (const path of [...directoriesBefore].sort(deepestFirst)) chmodIfNeeded(path, 0o500);
    const preparedFiles = listPlainFiles(sideDirectory, [SEAL_FILE]);
    const preparedDirectories = listPlainDirectories(paths.projectionDirectory);
    if (!samePaths(filesBefore, preparedFiles)
      || !samePaths(directoriesBefore, preparedDirectories)) {
      throw new Error("graph generation changed while it was being prepared for sealing");
    }

    const artifact = await hashFile(paths.artifactPath, signal);
    if (artifact.bytes !== trusted.artifactBytes || artifact.sha256 !== trusted.artifactSha256) {
      throw new Error("graph artifact does not match its trusted extraction digest");
    }
    const projection = await hashDirectory(paths.projectionDirectory, signal);
    if (projection.bytes !== trusted.projectionBytes
      || projection.sha256 !== trusted.projectionSha256) {
      throw new Error("graph projection bundle does not match its trusted extraction digest");
    }
    await hooks.afterTrustedContentHash?.();
    throwIfAborted(signal);
    assertProjectionManifest(trusted, paths.projectionDirectory);

    const files = listPlainFiles(sideDirectory, [SEAL_FILE]);
    const directories = listPlainDirectories(paths.projectionDirectory);
    if (!samePaths(preparedFiles, files) || !samePaths(preparedDirectories, directories)) {
      throw new Error("graph generation changed while it was being sealed");
    }
    const sealedFiles = files.map((path) => sealedEntry(sideDirectory, path, "file"));
    const sealedDirectories = directories.map((path) => sealedEntry(sideDirectory, path, "directory"));
    assertHashedFileIdentity(sideDirectory, paths.artifactPath, artifact.identity, sealedFiles);
    for (const hashed of projection.files) {
      assertHashedFileIdentity(
        sideDirectory,
        join(paths.projectionDirectory, ...hashed.path.split("/")),
        hashed.identity,
        sealedFiles,
      );
    }

    const seal: GraphGenerationSeal = {
      formatVersion: SEAL_FORMAT_VERSION,
      root: rootIdentity(sideDirectory),
      artifact: {
        path: portableRelative(sideDirectory, paths.artifactPath),
        bytes: trusted.artifactBytes,
        sha256: trusted.artifactSha256,
      },
      projection: {
        path: portableRelative(sideDirectory, paths.projectionDirectory),
        bytes: trusted.projectionBytes,
        sha256: trusted.projectionSha256,
        contentId: trusted.projectionContentId,
      },
      graphSummary: trusted.graphSummary,
      revision: trusted.revision,
      directories: sealedDirectories,
      files: sealedFiles,
    };
    const serialized = `${JSON.stringify(seal)}\n`;
    const sealSha256 = createHash("sha256").update(serialized).digest("hex");
    writeFileSync(sealPath, serialized, { encoding: "utf8", flag: "wx", mode: 0o400 });
    // Freeze the entire stage only after every caller-authored metadata file and the seal exist.
    // Publication thaws just the exact root inode under lifecycle admission and refreezes it after
    // rename; no mutable stage API remains available after this operation returns.
    freezeGraphGenerationDirectory(paths.cacheRoot, paths.generationDirectory);
    assertSealedIdentities(seal, sideDirectory);
    assertNoExtraEntries(seal, sideDirectory);
    const sealedSealFile = await hashFile(sealPath, signal);
    if (sealedSealFile.sha256 !== sealSha256 || sealedSealFile.bytes !== Buffer.byteLength(serialized)) {
      throw new Error("graph generation seal changed while the stage was being frozen");
    }
    const publicationSnapshot = snapshotStagePublication(paths.generationDirectory);
    assertHashedFileIdentity(
      paths.generationDirectory,
      sealPath,
      sealedSealFile.identity,
      publicationSnapshot.files,
    );
    const publicationSeal: GraphGenerationStagePublicationSeal = Object.freeze({
      assertCurrent: (generationDirectory: string) => {
        assertStagePublicationSnapshot(publicationSnapshot, generationDirectory);
      },
    });
    return {
      value: sealedStageResult(trusted, paths, sealSha256),
      publicationSeal,
    };
  }, signal);
}

/**
 * Verify a published generation without re-reading graph/projection content. On first access after
 * restart the compact seal is hashed; warm accesses use an identity-checked bounded LRU.
 */
export async function verifyGraphGeneration(
  input: VerifyGraphGenerationInput,
  signal?: AbortSignal,
): Promise<VerifiedGraphGeneration> {
  validateIdentity(input);
  validateIntegrity(input);
  const trusted = snapshotVerifyInput(input);
  const paths = resolveGenerationPaths(
    trusted.cacheRoot,
    trusted.artifactPath,
    trusted.projectionDirectory,
    "finalized",
  );
  return withGenerationOperation(paths.cacheRoot, paths.generationDirectory, signal, () => {
    throwIfAborted(signal);
    const sideDirectory = dirname(paths.artifactPath);
    const sealPath = join(sideDirectory, SEAL_FILE);
    const cacheKey = [
      sealPath,
      trusted.sealSha256,
      trusted.artifactSha256,
      trusted.projectionSha256,
    ].join("\0");
    const sealFile = pathIdentity(requirePlainPath(sealPath, "file"), "file");
    let cached = verifiedSeals.get(cacheKey);
    if (cached && !sameIdentity(cached.sealFile, sealFile)) {
      forgetSeal(cacheKey);
      throw new Error("graph generation seal changed after verification");
    }
    if (!cached) {
      const serialized = readSmallPlainFile(sealPath, sealFile);
      if (createHash("sha256").update(serialized).digest("hex") !== trusted.sealSha256) {
        throw new Error("graph generation seal digest does not match immutable metadata");
      }
      const seal = parseSeal(serialized);
      cached = { sealFile, seal, weight: cachedSealWeight(cacheKey, serialized, seal) };
      rememberSeal(cacheKey, cached);
    } else {
      verifiedSeals.delete(cacheKey);
      verifiedSeals.set(cacheKey, cached);
    }
    assertSealMatchesInput(cached.seal, trusted, sideDirectory, paths);
    assertSealedIdentities(cached.seal, sideDirectory);
    assertNoExtraEntries(cached.seal, sideDirectory);
    return verifiedResult(trusted, paths, trusted.sealSha256);
  });
}

/**
 * Adopt a deterministic immutable generation published by this cache without trusting its seal
 * digest from a process-local staging object. The bounded no-follow seal read supplies the digest;
 * the regular verifier still requires every expected artifact/projection identity to match.
 */
export async function verifyExistingGraphGeneration(
  input: VerifyExistingGraphGenerationInput,
  signal?: AbortSignal,
): Promise<VerifiedGraphGeneration> {
  validateIdentity(input);
  validateUnsealedIntegrity(input);
  const trusted = snapshotExistingInput(input);
  const paths = resolveGenerationPaths(
    trusted.cacheRoot,
    trusted.artifactPath,
    trusted.projectionDirectory,
    "finalized",
  );
  return withGenerationOperation(paths.cacheRoot, paths.generationDirectory, signal, async () => {
    const sealPath = join(dirname(paths.artifactPath), SEAL_FILE);
    const sealFile = pathIdentity(requirePlainPath(sealPath, "file"), "file");
    const serialized = readSmallPlainFile(sealPath, sealFile);
    const sealSha256 = createHash("sha256").update(serialized).digest("hex");
    return verifyGraphGeneration({ ...trusted, sealSha256 }, signal);
  });
}

export function isVerifiedGraphGeneration(value: unknown): value is VerifiedGraphGeneration {
  return typeof value === "object" && value !== null
    && (value as { [verifiedGraphGeneration]?: unknown })[verifiedGraphGeneration] === true;
}

export function isSealedGraphGenerationStage(value: unknown): value is SealedGraphGenerationStage {
  return typeof value === "object" && value !== null
    && (value as { [sealedGraphGenerationStage]?: unknown })[sealedGraphGenerationStage] === true;
}

/** Freeze every plain entry only after caller-owned metadata beside the seal has been written. */
export function freezeGraphGenerationDirectory(cacheRoot: string, directory: string): void {
  requirePlainPath(resolve(cacheRoot), "directory");
  const root = requireContainedPlainPath(cacheRoot, directory, "directory");
  const files = listPlainFiles(root);
  const directories = listPlainDirectories(root);
  // Reapplying an unchanged mode still advances ctime on common filesystems. Nested graph sides
  // have already recorded their exact identities in the seal, so preserve those identities while
  // freezing newly written outer metadata and directories.
  for (const file of files) chmodIfNeeded(file, 0o400);
  for (const child of [...directories].sort(deepestFirst)) chmodIfNeeded(child, 0o500);
}

function chmodIfNeeded(path: string, mode: number): void {
  if ((lstatSync(path).mode & 0o777) !== mode) chmodSync(path, mode);
}

function assertProjectionManifest(input: SealGraphGenerationInput, projectionDirectory: string): void {
  const before = pathIdentity(projectionDirectory, "directory");
  const manifest = readGraphProjectionManifest(projectionDirectory);
  const after = pathIdentity(projectionDirectory, "directory");
  if (!sameIdentity(before, after)
    || !manifest
    || manifest.contentId !== input.projectionContentId
    || !manifestMatchesRevision(manifest, input.revision)
    || !sameGraphSummary(manifest.graphSummary, input.graphSummary)) {
    throw new Error("graph projection manifest does not match its artifact identity");
  }
}

function assertSealMatchesInput(
  seal: GraphGenerationSeal,
  input: VerifyGraphGenerationInput,
  sideDirectory: string,
  paths: ResolvedGenerationPaths,
): void {
  if (seal.artifact.path !== portableRelative(sideDirectory, paths.artifactPath)
    || seal.artifact.bytes !== input.artifactBytes
    || seal.artifact.sha256 !== input.artifactSha256
    || seal.projection.path !== portableRelative(sideDirectory, paths.projectionDirectory)
    || seal.projection.bytes !== input.projectionBytes
    || seal.projection.sha256 !== input.projectionSha256
    || seal.projection.contentId !== input.projectionContentId
    || !sameRevision(seal.revision, input.revision)
    || !sameGraphSummary(seal.graphSummary, input.graphSummary)) {
    throw new Error("graph generation seal does not match immutable metadata");
  }
}

function assertSealedIdentities(seal: GraphGenerationSeal, sideDirectory: string): void {
  const root = rootIdentity(sideDirectory);
  if (root.dev !== seal.root.dev || root.ino !== seal.root.ino) {
    throw new Error("graph generation root identity changed after publication");
  }
  for (const entry of seal.directories) assertSealedEntry(sideDirectory, entry, "directory");
  for (const entry of seal.files) assertSealedEntry(sideDirectory, entry, "file");
}

function assertNoExtraEntries(seal: GraphGenerationSeal, sideDirectory: string): void {
  const actualFiles = listPlainFiles(sideDirectory).map((path) => portableRelative(sideDirectory, path));
  const expectedFiles = [
    ...seal.files.map((entry) => entry.path),
    SEAL_FILE,
  ].sort(comparePortablePaths);
  if (!samePaths(actualFiles, expectedFiles)) {
    throw new Error("graph generation contains an unsealed file");
  }
  const actualDirectories = listPlainDirectories(sideDirectory)
    .map((path) => portableRelativeOrRoot(sideDirectory, path));
  const expectedDirectories = [
    "",
    ...seal.directories.map((entry) => entry.path),
  ].sort(comparePortablePaths);
  if (!samePaths(actualDirectories, expectedDirectories)) {
    throw new Error("graph generation contains an unsealed directory");
  }
}

function assertSealedEntry(
  sideDirectory: string,
  expected: SealedEntry,
  kind: "file" | "directory",
): void {
  const path = resolvePortableRelative(sideDirectory, expected.path);
  const actual = pathIdentity(requireContainedPlainPath(sideDirectory, path, kind), kind);
  if (!sameIdentity(actual, expected)) {
    throw new Error(`sealed graph generation ${kind} changed after publication`);
  }
}

function resolveGenerationPaths(
  cacheRootInput: string,
  artifactInput: string,
  projectionInput: string,
  expected: GraphGenerationContainer["kind"],
): ResolvedGenerationPaths {
  const cacheRoot = requirePlainPath(resolve(cacheRootInput), "directory");
  const artifactPath = requireContainedPlainPath(cacheRootInput, artifactInput, "file");
  const projectionDirectory = requireContainedPlainPath(cacheRootInput, projectionInput, "directory");
  if (dirname(artifactPath) !== dirname(projectionDirectory)) {
    throw new Error("graph artifact and projection bundle do not share one immutable side");
  }
  const container = generationContainerFor(cacheRoot, dirname(artifactPath));
  if (container.kind !== expected) {
    throw new Error(`graph generation is not ${expected === "stage" ? "stage-owned" : "finalized"}`);
  }
  return {
    cacheRoot,
    artifactPath,
    projectionDirectory,
    generationDirectory: container.directory,
  };
}

function generationContainerFor(cacheRoot: string, nestedPath: string): GraphGenerationContainer {
  const container = graphGenerationContainerForNestedPath(cacheRoot, nestedPath);
  if (!container) throw new Error("graph artifact is not inside a current graph cache coordinate");
  return {
    ...container,
    directory: requireContainedPlainPath(cacheRoot, container.directory, "directory"),
  };
}

async function withGenerationOperation<T>(
  cacheRoot: string,
  generationDirectory: string,
  signal: AbortSignal | undefined,
  operation: () => Promise<T> | T,
): Promise<T> {
  const lifecycle = new GraphGenerationLifecycle({ cacheRoot });
  return lifecycle.withLease(
    generationDirectory,
    { purpose: "verification", signal },
    operation,
  );
}

async function hashDirectory(
  directory: string,
  signal: AbortSignal | undefined,
): Promise<HashedDirectory> {
  const before = pathIdentity(directory, "directory");
  const files = listPlainFiles(directory);
  const hash = createHash("sha256");
  const identities: Array<{ path: string; identity: FsIdentity }> = [];
  let bytes = 0;
  for (const path of files) {
    throwIfAborted(signal);
    const portable = portableRelative(directory, path);
    const result = await hashFile(path, signal);
    hash.update(`${portable}\0${result.bytes}\0`);
    hash.update(result.sha256, "hex");
    hash.update("\0");
    bytes += result.bytes;
    identities.push({ path: portable, identity: result.identity });
  }
  const after = pathIdentity(directory, "directory");
  if (!sameIdentity(before, after)) throw new Error("graph projection directory changed while hashing");
  return { bytes, sha256: hash.digest("hex"), files: Object.freeze(identities) };
}

async function hashFile(
  path: string,
  signal: AbortSignal | undefined,
): Promise<HashedFile> {
  throwIfAborted(signal);
  const visible = pathIdentity(requirePlainPath(path, "file"), "file");
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const fd = openSync(path, constants.O_RDONLY | noFollow);
  fullContentHashStreams += 1;
  let bytes = 0;
  const hash = createHash("sha256");
  try {
    const opened = identityFromStats(fstatSync(fd, { bigint: true }));
    if (!sameIdentity(visible, opened)) throw new Error("graph generation file changed before open");
    const stream = createReadStream(path, { fd, autoClose: false, highWaterMark: 64 * 1024 });
    for await (const chunk of stream) {
      throwIfAborted(signal);
      const buffer = chunk as Buffer;
      hash.update(buffer);
      bytes += buffer.byteLength;
    }
    const afterFd = identityFromStats(fstatSync(fd, { bigint: true }));
    const afterPath = pathIdentity(path, "file");
    if (!sameIdentity(opened, afterFd) || !sameIdentity(opened, afterPath)) {
      throw new Error("graph generation file changed while hashing");
    }
    return { bytes, sha256: hash.digest("hex"), identity: afterFd };
  } finally {
    closeSync(fd);
  }
}

function listPlainFiles(directory: string, ignoredBasenames: readonly string[] = []): string[] {
  const ignored = new Set(ignoredBasenames);
  const files: string[] = [];
  const visit = (path: string) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (path === directory && ignored.has(entry.name)) continue;
      const child = join(path, entry.name);
      const actual = lstatSync(child);
      if (entry.isSymbolicLink() || actual.isSymbolicLink()) {
        throw new Error("graph generation contains a symbolic link");
      }
      if (entry.isDirectory() && actual.isDirectory()) visit(child);
      else if (entry.isFile() && actual.isFile()) files.push(child);
      else throw new Error("graph generation contains an unsupported filesystem entry");
    }
  };
  visit(directory);
  return files.sort(comparePathsByBytes);
}

function listPlainDirectories(directory: string): string[] {
  const directories: string[] = [];
  const visit = (path: string) => {
    const entry = lstatSync(path);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error("graph projection bundle contains an unsafe directory");
    }
    directories.push(path);
    for (const child of readdirSync(path, { withFileTypes: true })) {
      if (child.isSymbolicLink()) throw new Error("graph projection bundle contains a symbolic link");
      if (child.isDirectory()) visit(join(path, child.name));
    }
  };
  visit(directory);
  return directories.sort(comparePathsByBytes);
}

function requireContainedPlainPath(
  rootInput: string,
  pathInput: string,
  kind: "file" | "directory",
): string {
  const root = requirePlainPath(resolve(rootInput), "directory");
  const lexicalRoot = resolve(rootInput);
  const candidate = resolve(pathInput);
  const traversalRoot = isContained(candidate, lexicalRoot)
    ? lexicalRoot
    : isContained(candidate, root)
      ? root
      : null;
  if (traversalRoot === null) throw new Error("graph generation path escaped the cache root");
  const parts = relative(traversalRoot, candidate).split(sep).filter(Boolean);
  let cursor = traversalRoot;
  for (let index = 0; index < parts.length; index += 1) {
    cursor = join(cursor, parts[index]!);
    const entry = lstatSync(cursor);
    if (entry.isSymbolicLink()) throw new Error("graph generation path contains a symbolic link");
    if (index < parts.length - 1 && !entry.isDirectory()) {
      throw new Error("graph generation path contains a non-directory component");
    }
  }
  const canonical = requirePlainPath(candidate, kind);
  if (!isContained(canonical, root)) throw new Error("graph generation path escaped the cache root");
  return canonical;
}

function requirePlainPath(pathInput: string, kind: "file" | "directory"): string {
  const absolute = resolve(pathInput);
  const unresolved = lstatSync(absolute);
  if (unresolved.isSymbolicLink()
    || (kind === "file" ? !unresolved.isFile() : !unresolved.isDirectory())) {
    throw new Error(`graph generation ${kind} is not a plain ${kind}`);
  }
  const canonical = realpathSync(absolute);
  const entry = lstatSync(canonical);
  if (entry.isSymbolicLink() || (kind === "file" ? !entry.isFile() : !entry.isDirectory())) {
    throw new Error(`graph generation ${kind} is not a plain ${kind}`);
  }
  return canonical;
}

function readSmallPlainFile(path: string, expected: FsIdentity): Buffer {
  if (BigInt(expected.size) > BigInt(MAX_SEAL_BYTES)) throw new Error("graph generation seal is too large");
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const fd = openSync(path, constants.O_RDONLY | noFollow);
  sealFileReads += 1;
  try {
    const opened = identityFromStats(fstatSync(fd, { bigint: true }));
    if (!sameIdentity(expected, opened)) throw new Error("graph generation seal changed before open");
    const bytes = readFileSync(fd);
    const after = identityFromStats(fstatSync(fd, { bigint: true }));
    const afterPath = pathIdentity(path, "file");
    if (!sameIdentity(opened, after) || !sameIdentity(opened, afterPath)
      || bytes.byteLength !== Number(BigInt(opened.size))) {
      throw new Error("graph generation seal changed while reading");
    }
    return bytes;
  } finally {
    closeSync(fd);
  }
}

function parseSeal(serialized: Buffer): GraphGenerationSeal {
  let value: unknown;
  try {
    value = JSON.parse(serialized.toString("utf8"));
  } catch {
    throw new Error("graph generation seal is invalid JSON");
  }
  if (!isRecord(value)
    || value.formatVersion !== SEAL_FORMAT_VERSION
    || !isRootIdentity(value.root)
    || !isRecord(value.artifact)
    || !safeRelativePath(value.artifact.path)
    || !positiveSafeInteger(value.artifact.bytes)
    || typeof value.artifact.sha256 !== "string" || !SHA256.test(value.artifact.sha256)
    || !isRecord(value.projection)
    || !safeRelativePath(value.projection.path)
    || !positiveSafeInteger(value.projection.bytes)
    || typeof value.projection.sha256 !== "string" || !SHA256.test(value.projection.sha256)
    || typeof value.projection.contentId !== "string" || !SHA256.test(value.projection.contentId)
    || !validGraphSummary(value.graphSummary)
    || !validRevision(value.revision)
    || !isSealedEntries(value.directories)
    || !isSealedEntries(value.files)) {
    throw new Error("graph generation seal has an invalid shape");
  }
  return value as unknown as GraphGenerationSeal;
}

function isSealedEntries(value: unknown): value is SealedEntry[] {
  if (!Array.isArray(value)) return false;
  let previous: string | undefined;
  for (const entry of value) {
    if (!isRecord(entry) || !safeRelativePath(entry.path) || !isFsIdentity(entry)) return false;
    if (previous !== undefined && comparePortablePaths(previous, entry.path) >= 0) return false;
    previous = entry.path;
  }
  return true;
}

function sealedEntry(root: string, path: string, kind: "file" | "directory"): SealedEntry {
  return { path: portableRelative(root, path), ...pathIdentity(path, kind) };
}

function assertHashedFileIdentity(
  sideDirectory: string,
  path: string,
  hashedIdentity: FsIdentity,
  sealedFiles: readonly SealedEntry[],
): void {
  const relativePath = portableRelative(sideDirectory, path);
  const sealed = sealedFiles.find((entry) => entry.path === relativePath);
  if (!sealed || !sameIdentity(hashedIdentity, sealed)) {
    throw new Error("graph generation file changed after its trusted content hash");
  }
}

function snapshotStagePublication(stageDirectory: string): StagePublicationSnapshot {
  const root = requirePlainPath(stageDirectory, "directory");
  const files = listPlainFiles(root);
  const directories = listPlainDirectories(root);
  for (const path of files) assertFrozenMode(path, 0o400);
  for (const path of directories) assertFrozenMode(path, 0o500);
  return Object.freeze({
    root: Object.freeze(rootIdentity(root)),
    directories: Object.freeze(directories
      .filter((path) => path !== root)
      .map((path) => Object.freeze(sealedEntry(root, path, "directory")))),
    files: Object.freeze(files.map((path) => Object.freeze(sealedEntry(root, path, "file")))),
  });
}

function assertStagePublicationSnapshot(
  snapshot: StagePublicationSnapshot,
  generationDirectory: string,
): void {
  const root = requirePlainPath(generationDirectory, "directory");
  const rootNow = rootIdentity(root);
  if (rootNow.dev !== snapshot.root.dev || rootNow.ino !== snapshot.root.ino) {
    throw new Error("sealed graph generation stage root changed before publication");
  }
  const files = listPlainFiles(root);
  const directories = listPlainDirectories(root);
  const actualFiles = files.map((path) => portableRelative(root, path));
  const expectedFiles = snapshot.files.map((entry) => entry.path);
  const actualDirectories = directories
    .filter((path) => path !== root)
    .map((path) => portableRelative(root, path));
  const expectedDirectories = snapshot.directories.map((entry) => entry.path);
  if (!samePaths(actualFiles, expectedFiles) || !samePaths(actualDirectories, expectedDirectories)) {
    throw new Error("sealed graph generation stage entries changed before publication");
  }
  for (const entry of snapshot.directories) assertSealedEntry(root, entry, "directory");
  for (const entry of snapshot.files) assertSealedEntry(root, entry, "file");
  for (const path of files) assertFrozenMode(path, 0o400);
  for (const path of directories) assertFrozenMode(path, 0o500);
}

function assertFrozenMode(path: string, expected: number): void {
  if ((lstatSync(path).mode & 0o777) !== expected) {
    throw new Error("sealed graph generation stage contains a writable entry");
  }
}

function rootIdentity(path: string): Pick<FsIdentity, "dev" | "ino"> {
  const identity = pathIdentity(requirePlainPath(path, "directory"), "directory");
  return { dev: identity.dev, ino: identity.ino };
}

function pathIdentity(path: string, kind: "file" | "directory"): FsIdentity {
  const entry = lstatSync(path, { bigint: true });
  if (entry.isSymbolicLink() || (kind === "file" ? !entry.isFile() : !entry.isDirectory())) {
    throw new Error(`sealed graph generation ${kind} is unsafe`);
  }
  return identityFromStats(entry);
}

function identityFromStats(entry: BigIntStats): FsIdentity {
  return {
    dev: String(entry.dev),
    ino: String(entry.ino),
    size: String(entry.size),
    mtimeNs: String(entry.mtimeNs),
    ctimeNs: String(entry.ctimeNs),
  };
}

function sameIdentity(left: FsIdentity, right: FsIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function isFsIdentity(value: Record<string, unknown>): boolean {
  return decimal(value.dev) && decimal(value.ino) && decimal(value.size)
    && decimal(value.mtimeNs) && decimal(value.ctimeNs);
}

function isRootIdentity(value: unknown): boolean {
  return isRecord(value) && decimal(value.dev) && decimal(value.ino);
}

function decimal(value: unknown): value is string {
  return typeof value === "string" && /^\d+$/.test(value);
}

function validateIdentity(input: GraphGenerationIdentity): void {
  if (!validRevision(input.revision)) throw new Error("graph generation revision is invalid");
  if (!validGraphSummary(input.graphSummary)) throw new Error("graph generation summary is invalid");
}

function validateUnsealedIntegrity(input: UnsealedGraphGenerationIntegrity): void {
  if (!positiveSafeInteger(input.artifactBytes) || !positiveSafeInteger(input.projectionBytes)
    || !SHA256.test(input.artifactSha256) || !SHA256.test(input.projectionSha256)
    || !SHA256.test(input.projectionContentId)) {
    throw new Error("graph generation integrity identity is invalid");
  }
}

function validateIntegrity(input: GraphGenerationIntegrity): void {
  validateUnsealedIntegrity(input);
  if (!SHA256.test(input.sealSha256)) throw new Error("graph generation seal identity is invalid");
}

function snapshotSealInput(input: SealGraphGenerationInput): SealGraphGenerationInput {
  return Object.freeze({
    ...input,
    graphSummary: snapshotGraphSummary(input.graphSummary),
    revision: snapshotRevision(input.revision),
  });
}

function snapshotVerifyInput(input: VerifyGraphGenerationInput): VerifyGraphGenerationInput {
  return Object.freeze({
    ...input,
    graphSummary: snapshotGraphSummary(input.graphSummary),
    revision: snapshotRevision(input.revision),
  });
}

function snapshotExistingInput(
  input: VerifyExistingGraphGenerationInput,
): VerifyExistingGraphGenerationInput {
  return Object.freeze({
    ...input,
    graphSummary: snapshotGraphSummary(input.graphSummary),
    revision: snapshotRevision(input.revision),
  });
}

function snapshotGraphSummary(summary: GraphGenerationSummary): GraphGenerationSummary {
  return Object.freeze({
    schemaVersion: summary.schemaVersion,
    generatedAt: summary.generatedAt,
    nodeCount: summary.nodeCount,
    edgeCount: summary.edgeCount,
  });
}

function snapshotRevision(revision: GraphRevisionIdentity): GraphRevisionIdentity {
  return Object.freeze({ ...revision }) as GraphRevisionIdentity;
}

function verifiedResult(
  input: GraphGenerationIdentity & UnsealedGraphGenerationIntegrity,
  paths: ResolvedGenerationPaths,
  sealSha256: string,
): VerifiedGraphGeneration {
  return Object.freeze({
    [verifiedGraphGeneration]: true as const,
    artifactPath: paths.artifactPath,
    projectionDirectory: paths.projectionDirectory,
    generationDirectory: paths.generationDirectory,
    artifactBytes: input.artifactBytes,
    artifactSha256: input.artifactSha256,
    projectionBytes: input.projectionBytes,
    projectionSha256: input.projectionSha256,
    projectionContentId: input.projectionContentId,
    sealSha256,
    graphSummary: snapshotGraphSummary(input.graphSummary),
    revision: snapshotRevision(input.revision),
  });
}

function sealedStageResult(
  input: GraphGenerationIdentity & UnsealedGraphGenerationIntegrity,
  paths: ResolvedGenerationPaths,
  sealSha256: string,
): SealedGraphGenerationStage {
  return Object.freeze({
    [sealedGraphGenerationStage]: true as const,
    artifactPath: paths.artifactPath,
    projectionDirectory: paths.projectionDirectory,
    stageDirectory: paths.generationDirectory,
    artifactBytes: input.artifactBytes,
    artifactSha256: input.artifactSha256,
    projectionBytes: input.projectionBytes,
    projectionSha256: input.projectionSha256,
    projectionContentId: input.projectionContentId,
    sealSha256,
    graphSummary: snapshotGraphSummary(input.graphSummary),
    revision: snapshotRevision(input.revision),
  });
}

function validGraphSummary(value: unknown): value is GraphGenerationSummary {
  if (!isRecord(value)) return false;
  return typeof value.schemaVersion === "string" && typeof value.generatedAt === "string"
    && Number.isSafeInteger(value.nodeCount) && (value.nodeCount as number) >= 0
    && Number.isSafeInteger(value.edgeCount) && (value.edgeCount as number) >= 0;
}

function sameGraphSummary(left: GraphGenerationSummary, right: GraphGenerationSummary): boolean {
  return left.schemaVersion === right.schemaVersion && left.generatedAt === right.generatedAt
    && left.nodeCount === right.nodeCount && left.edgeCount === right.edgeCount;
}

function manifestMatchesRevision(
  manifest: NonNullable<ReturnType<typeof readGraphProjectionManifest>>,
  revision: GraphRevisionIdentity,
): boolean {
  return revision.kind === "git"
    ? manifest.header.target.vcs?.commit?.toLowerCase() === revision.commit
    : manifest.contentId === revision.contentId;
}

function validRevision(value: unknown): value is GraphRevisionIdentity {
  if (!isRecord(value)) return false;
  if (value.kind === "git") {
    return Object.keys(value).length === 2
      && typeof value.commit === "string"
      && GRAPH_COMMIT_ID.test(value.commit);
  }
  return value.kind === "content"
    && Object.keys(value).length === 2
    && typeof value.contentId === "string"
    && SHA256.test(value.contentId);
}

function sameRevision(left: GraphRevisionIdentity, right: GraphRevisionIdentity): boolean {
  return left.kind === right.kind && (left.kind === "git"
    ? left.commit === (right as Extract<GraphRevisionIdentity, { kind: "git" }>).commit
    : left.contentId === (right as Extract<GraphRevisionIdentity, { kind: "content" }>).contentId);
}

function rememberSeal(key: string, value: CachedSeal): void {
  forgetSeal(key);
  if (value.weight > MAX_VERIFIED_SEAL_CACHE_BYTES) return;
  verifiedSeals.set(key, value);
  verifiedSealBytes += value.weight;
  while (verifiedSeals.size > MAX_VERIFIED_SEALS
    || verifiedSealBytes > MAX_VERIFIED_SEAL_CACHE_BYTES) {
    const oldest = verifiedSeals.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    forgetSeal(oldest);
  }
}

function forgetSeal(key: string): void {
  const cached = verifiedSeals.get(key);
  if (!cached) return;
  verifiedSeals.delete(key);
  verifiedSealBytes = Math.max(0, verifiedSealBytes - cached.weight);
}

function cachedSealWeight(key: string, serialized: Buffer, seal: GraphGenerationSeal): number {
  // Parsed JSON strings are UTF-16 in V8; add per-entry object overhead rather than treating the
  // compact on-disk byte size as the resident heap cost.
  return 512
    + (Buffer.byteLength(key, "utf8") * 2)
    + (serialized.byteLength * 2)
    + ((seal.files.length + seal.directories.length) * 128);
}

function portableRelative(root: string, path: string): string {
  const portable = relative(root, path).split(sep).join("/");
  if (!safeRelativePath(portable)) throw new Error("graph generation relative path is unsafe");
  return portable;
}

function portableRelativeOrRoot(root: string, path: string): string {
  if (path === root) return "";
  return portableRelative(root, path);
}

function resolvePortableRelative(root: string, portable: string): string {
  if (!safeRelativePath(portable)) throw new Error("graph generation seal path is unsafe");
  return resolve(root, ...portable.split("/"));
}

function safeRelativePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.startsWith("/") && !value.includes("\\")
    && value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

function isContained(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}${sep}`);
}

function comparePathsByBytes(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function comparePortablePaths(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function deepestFirst(left: string, right: string): number {
  const depth = right.split(sep).length - left.split(sep).length;
  return depth === 0 ? comparePathsByBytes(left, right) : depth;
}

function samePaths(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((path, index) => path === right[index]);
}

function positiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (signal.reason !== undefined) throw signal.reason;
  const error = new Error("graph generation verification aborted");
  error.name = "AbortError";
  throw error;
}
