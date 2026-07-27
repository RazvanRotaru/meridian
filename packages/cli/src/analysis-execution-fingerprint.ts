import { createHash, type Hash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

const EXECUTION_FINGERPRINT_VERSION = 1;
const DEFAULT_MAX_PACKAGES = 512;
const DEFAULT_MAX_DEPENDENCY_EDGES = 8_192;
const DEFAULT_MAX_FILES = 50_000;
const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_PACKAGE_MANIFEST_BYTES = 1024 * 1024;

export interface AnalysisExecutionFingerprintLimits {
  readonly maxPackages: number;
  readonly maxDependencyEdges: number;
  readonly maxFiles: number;
  readonly maxBytes: number;
  readonly maxFileBytes: number;
}

export interface AnalysisExecutionFingerprintOptions {
  /** The package that owns the repository-analysis worker. */
  readonly rootPackageManifest: string;
  /** The exact source or built worker entry that child processes execute. */
  readonly workerEntry: string;
  /** Source-mode loaders which are intentionally dev dependencies, for example tsx. */
  readonly additionalRootDependencies?: readonly string[];
  /** Test seam; production resolution follows the package's nearest node_modules tree. */
  readonly resolveDependencyManifest?: (
    dependencyName: string,
    fromPackageManifest: string,
  ) => string | undefined;
  readonly limits?: Partial<AnalysisExecutionFingerprintLimits>;
}

interface PackageManifest {
  readonly name: string;
  readonly version: string;
  readonly dependencies?: Readonly<Record<string, unknown>>;
  readonly optionalDependencies?: Readonly<Record<string, unknown>>;
  readonly peerDependencies?: Readonly<Record<string, unknown>>;
  readonly peerDependenciesMeta?: Readonly<Record<string, unknown>>;
  readonly bundledDependencies?: readonly unknown[];
  readonly bundleDependencies?: readonly unknown[];
}

interface DependencyDescriptor {
  readonly name: string;
  readonly optional: boolean;
}

interface ResolvedPackage {
  readonly manifestPath: string;
  readonly root: string;
  readonly name: string;
  readonly version: string;
  readonly isRoot: boolean;
}

interface DependencyEdge {
  readonly fromManifest: string;
  readonly dependencyName: string;
  readonly toManifest?: string;
  readonly optional: boolean;
}

interface FingerprintBudget {
  packages: number;
  dependencyEdges: number;
  files: number;
  bytes: number;
}

interface RegularFileSnapshot {
  readonly bytes: Buffer;
  readonly mode: number;
}

/**
 * Hashes the executable worker subtree and the complete declared runtime dependency closure.
 *
 * Package roots are canonicalized once, but links inside those roots are never traversed.
 * Absolute canonical roots are intentionally part of this host-local cache identity: resolving a
 * different installed package instance must invalidate reuse even if its manifest claims the same
 * name and version.
 */
export function computeAnalysisExecutionFingerprint(
  options: AnalysisExecutionFingerprintOptions,
): string {
  const limits = normalizedLimits(options.limits);
  const budget: FingerprintBudget = {
    packages: 0,
    dependencyEdges: 0,
    files: 0,
    bytes: 0,
  };
  const rootManifestPath = canonicalRegularFile(
    options.rootPackageManifest,
    "analysis root package manifest",
  );
  const rootPackage = readResolvedPackage(rootManifestPath, true);
  const workerEntry = canonicalWorkerEntry(options.workerEntry, rootPackage.root);
  const resolveDependencyManifest = options.resolveDependencyManifest
    ?? defaultResolveDependencyManifest;
  const packages = new Map<string, ResolvedPackage>();
  const edges: DependencyEdge[] = [];
  const queue: Array<{
    readonly package: ResolvedPackage;
    readonly additionalDependencies: readonly string[];
  }> = [{
    package: rootPackage,
    additionalDependencies: options.additionalRootDependencies ?? [],
  }];

  while (queue.length > 0) {
    const next = queue.shift();
    if (next === undefined || packages.has(next.package.manifestPath)) continue;
    budget.packages += 1;
    assertWithinLimit(budget.packages, limits.maxPackages, "runtime package");
    packages.set(next.package.manifestPath, next.package);

    const manifest = parsePackageManifest(next.package.manifestPath);
    const dependencies = mergeDependencies(
      manifest,
      next.additionalDependencies,
    );
    for (const dependency of dependencies) {
      budget.dependencyEdges += 1;
      assertWithinLimit(
        budget.dependencyEdges,
        limits.maxDependencyEdges,
        "runtime dependency edge",
      );
      const selected = resolveDependencyManifest(
        dependency.name,
        next.package.manifestPath,
      );
      if (selected === undefined) {
        if (dependency.optional) {
          edges.push({
            fromManifest: next.package.manifestPath,
            dependencyName: dependency.name,
            optional: true,
          });
          continue;
        }
        throw new Error(
          `analysis runtime dependency ${dependency.name} cannot be resolved from `
          + next.package.manifestPath,
        );
      }
      const dependencyManifestPath = canonicalRegularFile(
        selected,
        `analysis runtime dependency ${dependency.name}`,
      );
      const resolvedPackage = readResolvedPackage(dependencyManifestPath, false);
      if (resolvedPackage.name !== dependency.name) {
        throw new Error(
          `analysis runtime dependency ${dependency.name} resolved to package `
          + resolvedPackage.name,
        );
      }
      edges.push({
        fromManifest: next.package.manifestPath,
        dependencyName: dependency.name,
        toManifest: dependencyManifestPath,
        optional: dependency.optional,
      });
      if (!packages.has(dependencyManifestPath)) {
        queue.push({ package: resolvedPackage, additionalDependencies: [] });
      }
    }
  }

  const hash = createHash("sha256");
  updateFramed(
    hash,
    "domain",
    `meridian-analysis-execution-v${EXECUTION_FINGERPRINT_VERSION}`,
  );
  updateFramed(hash, "worker", workerEntry);
  for (const packageEntry of [...packages.values()]
    .sort((left, right) => compareCodePoints(left.manifestPath, right.manifestPath))) {
    hashPackage(hash, packageEntry, workerEntry, budget, limits);
  }
  for (const edge of edges.sort(compareDependencyEdges)) {
    updateFramed(hash, "edge-from", edge.fromManifest);
    updateFramed(hash, "edge-name", edge.dependencyName);
    updateFramed(hash, "edge-to", edge.toManifest ?? "<missing>");
    updateFramed(hash, "edge-optional", edge.optional ? "true" : "false");
  }
  return hash.digest("hex");
}

function hashPackage(
  hash: Hash,
  packageEntry: ResolvedPackage,
  workerEntry: string,
  budget: FingerprintBudget,
  limits: AnalysisExecutionFingerprintLimits,
): void {
  updateFramed(hash, "package-manifest", packageEntry.manifestPath);
  updateFramed(hash, "package-name", packageEntry.name);
  updateFramed(hash, "package-version", packageEntry.version);
  const scanRoots = packageEntry.isRoot
    ? rootExecutionPaths(packageEntry, workerEntry)
    : [packageEntry.root];
  const files = scanRoots
    .flatMap((path) => collectPackageFiles(packageEntry.root, path))
    .sort(compareCodePoints);
  const uniqueFiles = [...new Set(files)];
  for (const file of uniqueFiles) {
    budget.files += 1;
    assertWithinLimit(budget.files, limits.maxFiles, "runtime file");
    const snapshot = readStableRegularFile(file, limits.maxFileBytes);
    budget.bytes += snapshot.bytes.byteLength;
    assertWithinLimit(budget.bytes, limits.maxBytes, "runtime byte");
    const relativePath = relative(packageEntry.root, file).split(sep).join("/");
    updateFramed(hash, "file-package", packageEntry.manifestPath);
    updateFramed(hash, "file-path", relativePath);
    updateFramed(hash, "file-mode", (snapshot.mode & 0o7777).toString(8));
    updateFramed(hash, "file-bytes", snapshot.bytes);
  }
}

function rootExecutionPaths(packageEntry: ResolvedPackage, workerEntry: string): string[] {
  const workerRelative = relative(packageEntry.root, workerEntry);
  if (!isInsideRelativePath(workerRelative) || workerRelative.length === 0) {
    throw new Error("analysis worker entry escapes its root package");
  }
  if (dirname(workerRelative) === ".") return [packageEntry.root];
  const firstSegment = workerRelative.split(sep)[0];
  if (firstSegment === undefined || firstSegment.length === 0) {
    throw new Error("analysis worker entry has no executable package subtree");
  }
  const executableSubtree = join(packageEntry.root, firstSegment);
  return executableSubtree === packageEntry.root
    ? [packageEntry.root]
    : [packageEntry.manifestPath, executableSubtree];
}

function collectPackageFiles(packageRoot: string, path: string): string[] {
  const relativePath = relative(packageRoot, path);
  if (relativePath.length > 0 && !isInsideRelativePath(relativePath)) {
    throw new Error(`analysis runtime package path escapes package root: ${path}`);
  }
  const entry = lstatSync(path);
  if (entry.isSymbolicLink()) {
    throw new Error(`analysis runtime package must not contain links: ${path}`);
  }
  if (entry.isFile()) return [path];
  if (!entry.isDirectory()) {
    throw new Error(`analysis runtime package contains a special file: ${path}`);
  }
  if (realpathSync.native(path) !== path) {
    throw new Error(`analysis runtime package directory is not canonical: ${path}`);
  }
  return readdirSync(path, { withFileTypes: true })
    .sort((left, right) => compareCodePoints(left.name, right.name))
    .flatMap((child) => {
      if (child.name === "node_modules") return [];
      const childPath = join(path, child.name);
      if (child.isSymbolicLink()) {
        throw new Error(`analysis runtime package must not contain links: ${childPath}`);
      }
      if (child.isDirectory()) return collectPackageFiles(packageRoot, childPath);
      if (child.isFile()) return [childPath];
      throw new Error(`analysis runtime package contains a special file: ${childPath}`);
    });
}

function readResolvedPackage(manifestPath: string, isRoot: boolean): ResolvedPackage {
  const manifest = parsePackageManifest(manifestPath);
  return {
    manifestPath,
    root: dirname(manifestPath),
    name: manifest.name,
    version: manifest.version,
    isRoot,
  };
}

function parsePackageManifest(manifestPath: string): PackageManifest {
  const { bytes } = readStableRegularFile(manifestPath, MAX_PACKAGE_MANIFEST_BYTES);
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`analysis runtime package manifest is not valid JSON: ${manifestPath}`);
  }
  if (!isRecord(value)) {
    throw new Error(`analysis runtime package manifest must be an object: ${manifestPath}`);
  }
  if (
    typeof value.name !== "string"
    || value.name.length === 0
    || typeof value.version !== "string"
    || value.version.length === 0
  ) {
    throw new Error(`analysis runtime package identity is unavailable: ${manifestPath}`);
  }
  validateDependencyName(value.name);
  return value as unknown as PackageManifest;
}

function mergeDependencies(
  manifest: PackageManifest,
  additionalDependencies: readonly string[],
): DependencyDescriptor[] {
  const selected = new Map<string, boolean>();
  addDependencyMap(selected, manifest.dependencies, false);
  addDependencyMap(selected, manifest.peerDependencies, false, manifest.peerDependenciesMeta);
  addDependencyMap(selected, manifest.optionalDependencies, true);
  for (const name of [
    ...(manifest.bundledDependencies ?? []),
    ...(manifest.bundleDependencies ?? []),
  ]) {
    if (typeof name !== "string") {
      throw new Error(`analysis runtime package ${manifest.name} has an invalid bundled dependency`);
    }
    validateDependencyName(name);
    selected.set(name, false);
  }
  for (const name of additionalDependencies) {
    validateDependencyName(name);
    selected.set(name, false);
  }
  return [...selected.entries()]
    .map(([name, optional]) => ({ name, optional }))
    .sort((left, right) => compareCodePoints(left.name, right.name));
}

function addDependencyMap(
  selected: Map<string, boolean>,
  dependencies: Readonly<Record<string, unknown>> | undefined,
  optional: boolean,
  peerMetadata?: Readonly<Record<string, unknown>>,
): void {
  if (dependencies === undefined) return;
  if (!isRecord(dependencies)) {
    throw new Error("analysis runtime package dependencies must be an object");
  }
  for (const name of Object.keys(dependencies)) {
    validateDependencyName(name);
    const metadata = peerMetadata?.[name];
    const isOptionalPeer = isRecord(metadata) && metadata.optional === true;
    selected.set(name, optional || isOptionalPeer);
  }
}

function defaultResolveDependencyManifest(
  dependencyName: string,
  fromPackageManifest: string,
): string | undefined {
  validateDependencyName(dependencyName);
  const packageSegments = dependencyName.split("/");
  let directory = dirname(fromPackageManifest);
  const root = parse(directory).root;
  while (true) {
    const candidate = join(directory, "node_modules", ...packageSegments, "package.json");
    try {
      const entry = lstatSync(candidate);
      if (entry.isFile()) return candidate;
    } catch {
      // Continue with the parent node_modules directory.
    }
    if (directory === root) break;
    directory = dirname(directory);
  }

  const require = createRequire(fromPackageManifest);
  try {
    return require.resolve(`${dependencyName}/package.json`);
  } catch {
    try {
      return owningPackageManifest(require.resolve(dependencyName), dependencyName);
    } catch {
      return undefined;
    }
  }
}

function owningPackageManifest(entryPath: string, packageName: string): string | undefined {
  let directory = dirname(entryPath);
  const root = parse(directory).root;
  while (true) {
    const candidate = join(directory, "package.json");
    try {
      const manifest = parsePackageManifest(canonicalRegularFile(
        candidate,
        `analysis runtime dependency ${packageName}`,
      ));
      if (manifest.name === packageName) return candidate;
    } catch {
      // The entry can be nested below package-internal directories.
    }
    if (directory === root) return undefined;
    directory = dirname(directory);
  }
}

function canonicalWorkerEntry(workerEntry: string, packageRoot: string): string {
  const lexical = resolve(workerEntry);
  const lexicalEntry = lstatSync(lexical);
  if (!lexicalEntry.isFile()) {
    throw new Error("analysis worker entry must be a regular file, not a link or special file");
  }
  const canonical = realpathSync.native(lexical);
  const relativePath = relative(packageRoot, canonical);
  if (!isInsideRelativePath(relativePath) || relativePath.length === 0) {
    throw new Error("analysis worker entry escapes its root package");
  }
  return canonical;
}

function canonicalRegularFile(path: string, label: string): string {
  const lexical = resolve(path);
  const lexicalEntry = lstatSync(lexical);
  if (!lexicalEntry.isFile()) {
    throw new Error(`${label} must be a regular file, not a link or special file`);
  }
  const canonical = realpathSync.native(lexical);
  const canonicalEntry = lstatSync(canonical);
  if (!canonicalEntry.isFile()) {
    throw new Error(`${label} must resolve to a regular file`);
  }
  return canonical;
}

function readStableRegularFile(path: string, maxFileBytes: number): RegularFileSnapshot {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile()) {
      throw new Error(`analysis runtime path is not a regular file: ${path}`);
    }
    assertWithinLimit(before.size, maxFileBytes, "runtime file byte");
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || bytes.byteLength !== after.size
    ) {
      throw new Error(`analysis runtime file changed while fingerprinting: ${path}`);
    }
    return { bytes, mode: after.mode };
  } finally {
    closeSync(descriptor);
  }
}

function normalizedLimits(
  limits: Partial<AnalysisExecutionFingerprintLimits> | undefined,
): AnalysisExecutionFingerprintLimits {
  return {
    maxPackages: positiveInteger(limits?.maxPackages, DEFAULT_MAX_PACKAGES, "maxPackages"),
    maxDependencyEdges: positiveInteger(
      limits?.maxDependencyEdges,
      DEFAULT_MAX_DEPENDENCY_EDGES,
      "maxDependencyEdges",
    ),
    maxFiles: positiveInteger(limits?.maxFiles, DEFAULT_MAX_FILES, "maxFiles"),
    maxBytes: positiveInteger(limits?.maxBytes, DEFAULT_MAX_BYTES, "maxBytes"),
    maxFileBytes: positiveInteger(
      limits?.maxFileBytes,
      DEFAULT_MAX_FILE_BYTES,
      "maxFileBytes",
    ),
  };
}

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
  return selected;
}

function assertWithinLimit(value: number, limit: number, label: string): void {
  if (value > limit) throw new Error(`analysis ${label} limit exceeded`);
}

function validateDependencyName(name: string): void {
  const segments = name.startsWith("@") ? name.split("/") : [name];
  if (
    (name.startsWith("@") && segments.length !== 2)
    || (!name.startsWith("@") && name.includes("/"))
    || segments.some((segment) => (
      segment.length === 0
      || segment === "."
      || segment === ".."
      || segment.includes("\\")
      || segment.includes("\0")
    ))
  ) {
    throw new Error(`invalid analysis runtime package name: ${name}`);
  }
}

function compareDependencyEdges(left: DependencyEdge, right: DependencyEdge): number {
  return compareCodePoints(
    `${left.fromManifest}\0${left.dependencyName}\0${left.toManifest ?? ""}\0${left.optional}`,
    `${right.fromManifest}\0${right.dependencyName}\0${right.toManifest ?? ""}\0${right.optional}`,
  );
}

function updateFramed(hash: Hash, label: string, value: string | Buffer): void {
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  hash.update(`${Buffer.byteLength(label, "utf8")}:`);
  hash.update(label);
  hash.update(`${bytes.byteLength}:`);
  hash.update(bytes);
}

function isInsideRelativePath(path: string): boolean {
  return !isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
