import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
} from "node:fs";
import { createRequire } from "node:module";
import {
  isAbsolute as isHostAbsolute,
  posix,
  relative,
  resolve,
  sep,
} from "node:path";
import { TextDecoder } from "node:util";
import { isExcluded } from "../glob";
import { sha256Hex } from "./canonical-json";
import { resolveLocalTypeScriptConfigExtendsAddress } from "./config-inputs";
import {
  filesystemInputKey,
  resolutionLookupInputKey,
  resolutionLookupProofKey,
} from "./fingerprints";
import type {
  GitBlobIdentity,
  GitSymlinkInputFingerprint,
  ResolutionLookupInputFingerprint,
  ResolutionLookupProofFingerprint,
  UnitInputFingerprint,
} from "./model";

const MAX_GIT_OUTPUT_BYTES = 128 * 1024 * 1024;
const UTF8 = new TextDecoder("utf-8", { fatal: true });
let cachedBundledDefaultLibraryDigests: ReadonlyMap<string, string> | null = null;

export interface GitBlobEntry {
  path: string;
  oid: string;
  mode: string;
  byteSize: number;
}

export interface GitCheckoutVerification {
  repoRoot: string;
  expectedTreeOid: string;
  headCommitOid: string;
  headTreeOid: string;
}

export interface VerifiedGitTreeInputs {
  regularBlobs: GitBlobEntry[];
  symlinks: GitSymlinkInputFingerprint[];
}

/** Lists every blob recursively using Git's NUL-delimited tree format (no shell parsing). */
export async function listGitTreeBlobs(repoRoot: string, treeOid: string): Promise<GitBlobEntry[]> {
  const exactTreeOid = normalizeExactOid(treeOid);
  await requireTreeObject(repoRoot, exactTreeOid);
  const output = await runGit(repoRoot, [
    "ls-tree",
    "-r",
    "-z",
    "--full-tree",
    "-l",
    exactTreeOid,
  ]);

  const entries: GitBlobEntry[] = [];
  for (const record of splitNul(output)) {
    const separator = record.indexOf(0x09);
    if (separator < 0) {
      throw new Error("git ls-tree returned a malformed record");
    }
    const header = record.subarray(0, separator).toString("ascii");
    const match = /^([0-7]{6}) ([a-z]+) ([0-9a-f]{40}|[0-9a-f]{64}) +([0-9]+|-)$/.exec(header);
    if (match === null) {
      throw new Error(`git ls-tree returned a malformed header: ${header}`);
    }
    const path = UTF8.decode(record.subarray(separator + 1));
    if (match[2] !== "blob") {
      throw new Error(`exact blob listing cannot represent Git ${match[2]} entry: ${path}`);
    }
    const byteSize = Number(match[4]);
    if (!Number.isSafeInteger(byteSize) || byteSize < 0) {
      throw new Error(`git blob ${match[3]} has an unsupported size`);
    }
    entries.push({
      path,
      oid: match[3],
      mode: match[1],
      byteSize,
    });
  }
  return entries;
}

/**
 * Admits only regular blobs and direct, relative links to tracked regular blobs. The returned
 * symlink topology is portable cache-key input; the checkout observations prove that the host
 * materialized the same topology before TypeScript is allowed to inspect it.
 */
export async function verifyGitTreeInputs(
  repoRoot: string,
  entries: readonly GitBlobEntry[],
): Promise<VerifiedGitTreeInputs> {
  const canonicalRoot = realpathSync(repoRoot);
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  const regularBlobs: GitBlobEntry[] = [];
  const symlinks: GitSymlinkInputFingerprint[] = [];

  for (const entry of entries) {
    if (entry.mode === "100644" || entry.mode === "100755") {
      regularBlobs.push({ ...entry });
      continue;
    }
    if (entry.mode !== "120000") {
      throw new Error(`POC cannot prove extraction through Git mode ${entry.mode}: ${entry.path}`);
    }

    const linkBytes = await readGitBlob(repoRoot, entry);
    const target = UTF8.decode(linkBytes);
    if (target.length === 0 || target.includes("\0") || target.includes("\\")
      || posix.isAbsolute(target)) {
      throw new Error(`tracked symlink has an unsupported target: ${entry.path}`);
    }
    const resolvedPath = posix.normalize(posix.join(posix.dirname(entry.path), target));
    if (resolvedPath === ".." || resolvedPath.startsWith("../") || posix.isAbsolute(resolvedPath)) {
      throw new Error(`tracked symlink escapes the repository: ${entry.path}`);
    }
    const resolved = byPath.get(resolvedPath);
    if (resolved === undefined) {
      throw new Error(`tracked symlink target is not in the exact Git tree: ${entry.path}`);
    }
    if (resolved.mode !== "100644" && resolved.mode !== "100755") {
      throw new Error(`tracked symlink target is not a regular Git blob: ${entry.path}`);
    }

    const absoluteLink = repositoryPath(repoRoot, entry.path);
    const absoluteTarget = repositoryPath(repoRoot, resolvedPath);
    if (!lstatSync(absoluteLink).isSymbolicLink()) {
      throw new Error(`tracked symlink is not materialized as a symlink: ${entry.path}`);
    }
    const observedTarget = readlinkSync(absoluteLink, { encoding: "buffer" });
    if (!Buffer.isBuffer(observedTarget) || !observedTarget.equals(linkBytes)) {
      throw new Error(`tracked symlink bytes differ from Git tree: ${entry.path}`);
    }
    if (!lstatSync(absoluteTarget).isFile()) {
      throw new Error(`tracked symlink target is not a regular checkout file: ${entry.path}`);
    }
    const expectedRealpath = resolve(canonicalRoot, ...resolvedPath.split("/"));
    if (realpathSync(absoluteLink) !== expectedRealpath || realpathSync(absoluteTarget) !== expectedRealpath) {
      throw new Error(`tracked symlink realpath differs from Git topology: ${entry.path}`);
    }
    verifyGitBlobBytes(readFileSync(absoluteTarget), resolved);

    symlinks.push({
      path: entry.path,
      linkBlobOid: entry.oid,
      linkByteSize: entry.byteSize,
      target,
      resolvedPath,
      resolvedBlobOid: resolved.oid,
      resolvedMode: resolved.mode,
      resolvedByteSize: resolved.byteSize,
    });
  }

  return { regularBlobs, symlinks };
}

/**
 * Revalidate an admitted unit fingerprint without constructing a TypeScript Project.
 *
 * This is intentionally narrower than ordinary fingerprinting. Repository-relative negative
 * observations are checked directly so ignored files cannot hide behind a clean Git status.
 * Dependency/external lookup observations are rejected because their ancestor search space is not
 * bound by the requested tree. Default libraries are the only untracked program inputs accepted;
 * their exact installed bytes are rehashed and provenance separately pins the TypeScript version.
 */
export function revalidateAdmittedUnitInputsAtExactTree(
  repoRootInput: string,
  inputs: UnitInputFingerprint,
  treeBlobs: readonly GitBlobIdentity[],
): boolean {
  try {
    const repoRoot = realpathSync(repoRootInput);
    if (
      inputs.reuseEligibility.eligible !== true
      || inputs.reuseEligibility.reasons.length !== 0
      || inputs.typescriptConfig.reuseEligibility.eligible !== true
      || inputs.unattributedResolutionLookupInputKeys.length !== 0
    ) {
      return false;
    }
    const treeByPath = exactTreeBlobMap(treeBlobs);
    for (const blob of inputs.sourceBlobs) {
      const tracked = treeByPath.get(blob.path);
      if (
        tracked === undefined
        || tracked.oid !== blob.oid
        || tracked.mode !== blob.mode
        || tracked.byteSize !== blob.byteSize
        || !observedTreeBlobMatches(repoRoot, blob.path, tracked)
      ) {
        return false;
      }
    }
    if (
      !revalidateConfigInputs(repoRoot, inputs, treeByPath)
      || !revalidateUnitRootSourceSet(repoRoot, inputs)
    ) {
      return false;
    }

    const filesystemCatalog = new Map<string, UnitInputFingerprint["filesystemInputs"][number]>();
    for (const input of inputs.filesystemInputs) {
      const key = filesystemInputKey(input);
      const existing = filesystemCatalog.get(key);
      if (existing !== undefined) return false;
      filesystemCatalog.set(key, input);
      if (!revalidatePackageManifestInput(repoRoot, input, treeByPath)) return false;
    }

    const lookupCatalog = new Map<
      string,
      UnitInputFingerprint["resolutionLookupInputs"][number]
    >();
    for (const input of inputs.resolutionLookupInputs) {
      const key = resolutionLookupInputKey(input);
      if (lookupCatalog.has(key)) return false;
      lookupCatalog.set(key, input);
      if (!revalidateResolutionLookupInput(repoRoot, input, treeByPath)) return false;
    }
    const proofCatalog = new Map<string, ResolutionLookupProofFingerprint>();
    for (const proof of inputs.resolutionLookupProofs) {
      const key = resolutionLookupProofKey(proof);
      if (
        proofCatalog.has(key)
        || !isSortedUniqueCanonicalKeys(proof.resolutionLookupInputKeys)
        || proof.resolutionLookupInputKeys.some((inputKey) => !lookupCatalog.has(inputKey))
      ) {
        return false;
      }
      proofCatalog.set(key, proof);
    }
    const referencedProofKeys = new Set<string>();
    const referencedLookupKeys = new Set<string>();
    const lookupProofFor = (proofKey: string): ResolutionLookupProofFingerprint | null => {
      const proof = proofCatalog.get(proofKey);
      if (proof === undefined) return null;
      referencedProofKeys.add(proofKey);
      for (const inputKey of proof.resolutionLookupInputKeys) {
        referencedLookupKeys.add(inputKey);
      }
      return proof;
    };

    const programAddresses = new Set<string>();
    const referencedFilesystemKeys = new Set<string>();
    for (const input of inputs.programInputs) {
      if (programAddresses.has(input.address)) return false;
      programAddresses.add(input.address);
      for (const key of input.filesystemInputKeys) {
        if (!filesystemCatalog.has(key)) return false;
        referencedFilesystemKeys.add(key);
      }
      const lookupProof = lookupProofFor(input.resolutionLookupProofKey);
      if (
        lookupProof === null
        || lookupProof.resolutionLookupInputKeys.some(
          (key) => lookupCatalog.get(key)?.purpose !== "affecting",
        )
      ) {
        return false;
      }
      if (!revalidateProgramInput(repoRoot, input, treeByPath)) return false;
    }
    if (
      referencedFilesystemKeys.size !== filesystemCatalog.size
      || [...filesystemCatalog.keys()].some((key) => !referencedFilesystemKeys.has(key))
    ) {
      return false;
    }

    for (const resolution of [
      ...inputs.moduleResolutions,
      ...inputs.typeReferenceResolutions,
    ]) {
      if (
        !programAddresses.has(resolution.containingFile)
        || resolution.hasCompleteLookupProof !== true
        || resolution.alternateResult !== null
      ) {
        return false;
      }
      const lookupProof = lookupProofFor(resolution.resolutionLookupProofKey);
      if (lookupProof === null) return false;
      if (
        resolution.target !== null
        && !lookupProof.resolutionLookupInputKeys.some(
          (key) => lookupCatalog.get(key)?.purpose === "failed-lookup",
        )
      ) {
        return false;
      }
      if (
        resolution.target !== null
        && !revalidateResolutionTarget(repoRoot, resolution.target, treeByPath)
      ) {
        return false;
      }
    }
    return referencedProofKeys.size === proofCatalog.size
      && [...proofCatalog.keys()].every((key) => referencedProofKeys.has(key))
      && referencedLookupKeys.size === lookupCatalog.size
      && [...lookupCatalog.keys()].every((key) => referencedLookupKeys.has(key));
  } catch {
    return false;
  }
}

/**
 * Verifies that HEAD names the requested exact tree and that Git sees no tracked, staged,
 * untracked, or dirty-submodule changes. HEAD is re-read after status to catch revision races.
 */
export async function verifyCleanCheckoutAtTree(
  repoRoot: string,
  expectedTreeOid: string,
): Promise<GitCheckoutVerification> {
  const expected = normalizeExactOid(expectedTreeOid);
  await requireTreeObject(repoRoot, expected);

  const before = await readHeadIdentity(repoRoot);
  if (before.treeOid !== expected) {
    throw new Error(`HEAD tree ${before.treeOid} does not match requested tree ${expected}`);
  }

  const status = await runGit(repoRoot, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    "--ignore-submodules=none",
  ]);
  if (status.byteLength !== 0) {
    throw new Error(`checkout is not clean (${splitNul(status).length} status record(s))`);
  }

  const after = await readHeadIdentity(repoRoot);
  if (after.commitOid !== before.commitOid || after.treeOid !== before.treeOid) {
    throw new Error("HEAD changed while checkout cleanliness was being verified");
  }
  return {
    repoRoot,
    expectedTreeOid: expected,
    headCommitOid: after.commitOid,
    headTreeOid: after.treeOid,
  };
}

function exactTreeBlobMap(
  treeBlobs: readonly GitBlobIdentity[],
): Map<string, GitBlobIdentity> {
  const result = new Map<string, GitBlobIdentity>();
  for (const blob of treeBlobs) {
    if (result.has(blob.path)) {
      throw new Error(`duplicate exact-tree blob: ${blob.path}`);
    }
    result.set(blob.path, blob);
  }
  return result;
}

function revalidateConfigInputs(
  repoRoot: string,
  inputs: UnitInputFingerprint,
  treeByPath: ReadonlyMap<string, GitBlobIdentity>,
): boolean {
  const config = inputs.typescriptConfig;
  for (const probe of config.selectionProbes) {
    const path = repoPathFromAddress(repoRoot, probe.address);
    if (path === null) return false;
    const state = observedPathState(path.absolute);
    if (state !== probe.state || existsSync(path.absolute) !== probe.exists) return false;
  }
  const configAddresses = new Set<string>();
  for (const input of config.configFiles) {
    const path = repoPathFromAddress(repoRoot, input.address);
    if (
      path === null
      || configAddresses.has(input.address)
      || input.trackedBlobOid === null
      || input.trackedMode === null
    ) {
      return false;
    }
    configAddresses.add(input.address);
    const tracked = treeByPath.get(path.relative);
    if (
      tracked === undefined
      || tracked.oid !== input.trackedBlobOid
      || tracked.mode !== input.trackedMode
      || tracked.byteSize !== input.byteSize
      || !observedTreeBlobMatches(repoRoot, path.relative, tracked)
    ) {
      return false;
    }
    const bytes = readFileSync(path.absolute);
    if (sha256Hex(bytes) !== input.digest || bytes.byteLength !== input.byteSize) {
      return false;
    }
  }
  if (
    config.selectedConfigAddress !== null
    && !configAddresses.has(config.selectedConfigAddress)
  ) {
    return false;
  }
  for (const input of config.extendsInputs) {
    const from = repoPathFromAddress(repoRoot, input.from);
    if (
      from === null
      || !configAddresses.has(input.from)
      || input.resolvedAddress === null
      || !configAddresses.has(input.resolvedAddress)
      || resolveLocalTypeScriptConfigExtendsAddress(
        repoRoot,
        from.absolute,
        input.specifier,
      ) !== input.resolvedAddress
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Re-enumerate the exact bounded unit glob without constructing a Project. This closes the
 * otherwise-unobserved hole where an ignored .ts/.tsx file appears after admission: Git status
 * remains clean, but loadUnitProject would add that file to a canonical cold Program.
 *
 * The fast path accepts only the workspace-unit include form emitted by current discovery. Any
 * future glob model must add an equally exact enumerator before it can use this path.
 */
function revalidateUnitRootSourceSet(
  repoRoot: string,
  inputs: UnitInputFingerprint,
): boolean {
  const unitDir = inputs.unit.dir;
  if (!isSafeRepoRelativePath(unitDir)) return false;
  const expectedIncludes = [
    `${unitDir}/**/*.ts`,
    `${unitDir}/**/*.tsx`,
  ];
  if (
    inputs.unit.include.length !== expectedIncludes.length
    || inputs.unit.include.some((value, index) => value !== expectedIncludes[index])
  ) {
    return false;
  }
  const programAddresses = new Set(inputs.programInputs.map((input) => input.address));
  const excludes = [...inputs.policy.exclude, ...inputs.unit.exclude];
  return everyCurrentUnitRootSourceWasObserved(
    repoRoot,
    unitDir,
    programAddresses,
    excludes,
  );
}

function everyCurrentUnitRootSourceWasObserved(
  repoRoot: string,
  directory: string,
  programAddresses: ReadonlySet<string>,
  excludes: string[],
): boolean {
  const entries = readdirSync(repositoryPath(repoRoot, directory), {
    withFileTypes: true,
  }).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  for (const entry of entries) {
    if (entry.name === "." || entry.name === ".." || entry.name.includes("\0")) return false;
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      if (isUnconditionallyExcludedDirectory(path, excludes)) continue;
      if (!everyCurrentUnitRootSourceWasObserved(
        repoRoot,
        path,
        programAddresses,
        excludes,
      )) {
        return false;
      }
      continue;
    }
    if (entry.isSymbolicLink()) {
      // Whether the host globber follows a directory or file link is platform-sensitive.
      // The fast path deliberately declines that ambiguity.
      return false;
    }
    if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".tsx")) continue;
    if (!entry.isFile() || isExcluded(path, excludes)) continue;
    if (!programAddresses.has(`repo:${path}`)) return false;
  }
  return true;
}

function isUnconditionallyExcludedDirectory(
  path: string,
  excludes: readonly string[],
): boolean {
  const segments = path.split("/");
  for (const pattern of excludes) {
    const anywhere = /^\*\*\/([A-Za-z0-9._-]+)\/\*\*$/.exec(pattern);
    if (anywhere !== null && segments.includes(anywhere[1]!)) return true;
    const rooted = /^([A-Za-z0-9._/-]+)\/\*\*$/.exec(pattern);
    if (
      rooted !== null
      && isSafeRepoRelativePath(rooted[1])
      && (path === rooted[1] || path.startsWith(`${rooted[1]}/`))
    ) {
      return true;
    }
  }
  return false;
}

function revalidatePackageManifestInput(
  repoRoot: string,
  input: UnitInputFingerprint["filesystemInputs"][number],
  treeByPath: ReadonlyMap<string, GitBlobIdentity>,
): boolean {
  if (input.kind !== "package-manifest") return false;
  const path = repoPathFromAddress(repoRoot, input.address);
  if (path === null) return false;
  if (input.digest === null) {
    return input.trackedBlobOid === null
      && !treeByPath.has(path.relative)
      && observedPathState(path.absolute) === "absent";
  }
  if (input.trackedBlobOid === null) return false;
  const tracked = treeByPath.get(path.relative);
  if (
    tracked === undefined
    || tracked.oid !== input.trackedBlobOid
    || !observedTreeBlobMatches(repoRoot, path.relative, tracked)
  ) {
    return false;
  }
  return sha256Hex(readFileSync(path.absolute)) === input.digest;
}

function revalidateProgramInput(
  repoRoot: string,
  input: UnitInputFingerprint["programInputs"][number],
  treeByPath: ReadonlyMap<string, GitBlobIdentity>,
): boolean {
  if (input.trackedBlobOid !== null) {
    const path = repoPathFromAddress(repoRoot, input.address);
    if (path === null) return false;
    const tracked = treeByPath.get(path.relative);
    return tracked !== undefined
      && tracked.oid === input.trackedBlobOid
      && observedTreeBlobMatches(repoRoot, path.relative, tracked)
      && sha256Hex(readFileSync(path.absolute, "utf8")) === input.digest;
  }
  if (!input.isDefaultLibrary) return false;
  return installedTypeScriptDefaultLibraryDigest(input.address) === input.digest;
}

function installedTypeScriptDefaultLibraryDigest(address: string): string | null {
  const prefix = "dependency:node_modules/typescript/";
  if (!address.startsWith(prefix)) return null;
  const relativePath = address.slice(prefix.length);
  if (
    relativePath.length === 0
    || relativePath.includes("\\")
    || relativePath.split("/").some(
      (segment) => segment === "" || segment === "." || segment === "..",
    )
  ) {
    return null;
  }
  return bundledDefaultLibraryDigests().get(relativePath) ?? null;
}

function bundledDefaultLibraryDigests(): ReadonlyMap<string, string> {
  if (cachedBundledDefaultLibraryDigests !== null) {
    return cachedBundledDefaultLibraryDigests;
  }
  const requireFromHere = createRequire(import.meta.url);
  const requireFromTsMorph = createRequire(requireFromHere.resolve("ts-morph"));
  const common: unknown = requireFromTsMorph("@ts-morph/common");
  if (
    common === null
    || typeof common !== "object"
    || !("getLibFiles" in common)
    || typeof common.getLibFiles !== "function"
  ) {
    throw new Error("installed ts-morph default-library bundle is unavailable");
  }
  const files: unknown = common.getLibFiles();
  if (!Array.isArray(files) || files.length === 0 || files.length > 1_024) {
    throw new Error("installed ts-morph default-library bundle is invalid");
  }
  const result = new Map<string, string>();
  for (const file of files) {
    if (
      file === null
      || typeof file !== "object"
      || !("fileName" in file)
      || !("text" in file)
      || typeof file.fileName !== "string"
      || typeof file.text !== "string"
      || !/^lib(?:\.[A-Za-z0-9-]+)*\.d\.ts$/.test(file.fileName)
      || result.has(`lib/${file.fileName}`)
    ) {
      throw new Error("installed ts-morph default-library entry is invalid");
    }
    result.set(`lib/${file.fileName}`, sha256Hex(file.text));
  }
  cachedBundledDefaultLibraryDigests = result;
  return result;
}

function revalidateResolutionLookupInput(
  repoRoot: string,
  input: ResolutionLookupInputFingerprint,
  treeByPath: ReadonlyMap<string, GitBlobIdentity>,
): boolean {
  if (input.purpose !== "failed-lookup" && input.purpose !== "affecting") return false;
  const path = repoPathFromAddress(repoRoot, input.address);
  if (path === null) return false;
  if (input.state === "absent") {
    return input.digest === null
      && input.trackedBlobOid === null
      && !treeByPath.has(path.relative)
      && observedPathState(path.absolute) === "absent";
  }
  if (input.state !== "file" || input.digest === null || input.trackedBlobOid === null) {
    return false;
  }
  const tracked = treeByPath.get(path.relative);
  return tracked !== undefined
    && tracked.oid === input.trackedBlobOid
    && observedTreeBlobMatches(repoRoot, path.relative, tracked)
    && sha256Hex(readFileSync(path.absolute)) === input.digest;
}

function isSortedUniqueCanonicalKeys(keys: readonly string[]): boolean {
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index]!;
    if (!/^[a-f0-9]{64}$/.test(key)) return false;
    if (index > 0 && keys[index - 1]! >= key) return false;
  }
  return true;
}

function revalidateResolutionTarget(
  repoRoot: string,
  target: NonNullable<
    UnitInputFingerprint["moduleResolutions"][number]["target"]
  >,
  treeByPath: ReadonlyMap<string, GitBlobIdentity>,
): boolean {
  if (target.trackedBlobOid === null) return false;
  const path = repoPathFromAddress(repoRoot, target.address);
  if (path === null) return false;
  const tracked = treeByPath.get(path.relative);
  return tracked !== undefined
    && tracked.oid === target.trackedBlobOid
    && observedTreeBlobMatches(repoRoot, path.relative, tracked);
}

function repoPathFromAddress(
  repoRoot: string,
  address: string,
): { absolute: string; relative: string } | null {
  if (!address.startsWith("repo:")) return null;
  const relativePath = address.slice("repo:".length);
  if (!isSafeRepoRelativePath(relativePath)) return null;
  return {
    absolute: repositoryPath(repoRoot, relativePath),
    relative: relativePath,
  };
}

function isSafeRepoRelativePath(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && !isHostAbsolute(value)
    && !value.includes("\\")
    && value.split("/").every(
      (segment) => segment !== "" && segment !== "." && segment !== ".." && segment !== ".git",
    );
}

function observedPathState(
  path: string,
): ResolutionLookupInputFingerprint["state"] {
  try {
    const entry = lstatSync(path);
    return entry.isFile()
      ? "file"
      : entry.isDirectory()
        ? "directory"
        : entry.isSymbolicLink()
          ? "symlink"
          : "other";
  } catch (error) {
    if (
      filesystemErrorCode(error) === "ENOENT"
      || filesystemErrorCode(error) === "ENOTDIR"
    ) {
      return "absent";
    }
    throw error;
  }
}

function observedTreeBlobMatches(
  repoRoot: string,
  path: string,
  tracked: GitBlobIdentity,
): boolean {
  if (tracked.path !== path) return false;
  const absolute = repositoryPath(repoRoot, path);
  if (!lstatSync(absolute).isFile()) return false;
  const bytes = readFileSync(absolute);
  if (bytes.byteLength !== tracked.byteSize) return false;
  const algorithm = tracked.oid.length === 40
    ? "sha1"
    : tracked.oid.length === 64
      ? "sha256"
      : null;
  if (algorithm === null) return false;
  return createHash(algorithm)
    .update(`blob ${bytes.byteLength}\0`)
    .update(bytes)
    .digest("hex") === tracked.oid;
}

async function readHeadIdentity(repoRoot: string): Promise<{ commitOid: string; treeOid: string }> {
  const [commit, tree] = await Promise.all([
    runGit(repoRoot, ["rev-parse", "--verify", "HEAD^{commit}"]),
    runGit(repoRoot, ["rev-parse", "--verify", "HEAD^{tree}"]),
  ]);
  return {
    commitOid: normalizeGitOutputOid(commit),
    treeOid: normalizeGitOutputOid(tree),
  };
}

async function requireTreeObject(repoRoot: string, oid: string): Promise<void> {
  const type = (await runGit(repoRoot, ["cat-file", "-t", oid])).toString("ascii").trim();
  if (type !== "tree") {
    throw new Error(`Git object ${oid} is ${type}, not a tree`);
  }
}

function normalizeGitOutputOid(output: Buffer): string {
  return normalizeExactOid(output.toString("ascii").trim());
}

function normalizeExactOid(oid: string): string {
  if (!/^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/.test(oid)) {
    throw new TypeError("expected an exact 40- or 64-character Git object ID");
  }
  return oid.toLowerCase();
}

async function readGitBlob(repoRoot: string, entry: GitBlobEntry): Promise<Buffer> {
  const type = (await runGit(repoRoot, ["cat-file", "-t", entry.oid])).toString("ascii").trim();
  if (type !== "blob") {
    throw new Error(`Git object ${entry.oid} is ${type}, not a blob`);
  }
  const bytes = await runGit(repoRoot, ["cat-file", "blob", entry.oid]);
  if (bytes.byteLength !== entry.byteSize) {
    throw new Error(`git blob ${entry.oid} size differs from its tree entry`);
  }
  return bytes;
}

function repositoryPath(repoRoot: string, relativePath: string): string {
  const root = resolve(repoRoot);
  const absolute = resolve(root, ...relativePath.split("/"));
  const rel = relative(root, absolute);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isHostAbsolute(rel)) {
    throw new Error(`Git tree path escapes the repository: ${relativePath}`);
  }
  return absolute;
}

function verifyGitBlobBytes(bytes: Buffer, entry: GitBlobEntry): void {
  // Ask Git to hash with the repository's configured object format.
  // This keeps SHA-1 and SHA-256 repositories on the same verification path.
  const algorithm = entry.oid.length === 40 ? "sha1" : entry.oid.length === 64 ? "sha256" : null;
  if (algorithm === null) throw new Error(`unsupported Git object id length: ${entry.oid.length}`);
  const actual = createHash(algorithm)
    .update(`blob ${bytes.byteLength}\0`)
    .update(bytes)
    .digest("hex");
  if (actual !== entry.oid) {
    throw new Error(`tracked symlink target bytes differ from Git tree: ${entry.path}`);
  }
}

function splitNul(output: Buffer): Buffer[] {
  const records: Buffer[] = [];
  let start = 0;
  for (let cursor = 0; cursor < output.length; cursor += 1) {
    if (output[cursor] === 0) {
      records.push(output.subarray(start, cursor));
      start = cursor + 1;
    }
  }
  if (start !== output.length) {
    throw new Error("Git returned a non-NUL-terminated record");
  }
  return records.filter((record) => record.byteLength > 0);
}

function filesystemErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}

function runGit(repoRoot: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["-C", repoRoot, ...args],
      { encoding: "buffer", maxBuffer: MAX_GIT_OUTPUT_BYTES },
      (error, stdout, stderr) => {
        if (error !== null) {
          const detail = Buffer.isBuffer(stderr) ? stderr.toString("utf8").trim() : String(stderr).trim();
          reject(new Error(`git ${args[0]} failed${detail === "" ? "" : `: ${detail}`}`, { cause: error }));
          return;
        }
        resolve(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout));
      },
    );
  });
}
