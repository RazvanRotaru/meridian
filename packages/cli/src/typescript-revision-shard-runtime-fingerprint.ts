/**
 * Executable provenance for TypeScript revision shards.
 *
 * Whole repository artifacts depend on the CLI, every selected extractor, Git, and post-processing
 * behavior. A TypeScript shard is narrower: its bytes are produced by the exact installed
 * TypeScript extractor and its complete declared runtime dependency closure. The immutable
 * revision request, repository-analysis policy, schema version, and runtime coordinates are
 * fingerprinted separately by the shard policy.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import {
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import {
  computeAnalysisExecutionFingerprint,
  resolveAnalysisDependencyManifest,
  type AnalysisExecutionFingerprintOptions,
} from "./analysis-execution-fingerprint";

const TYPESCRIPT_SHARD_BUILD_FINGERPRINT_VERSION = 1;
const TYPESCRIPT_EXTRACTOR_PACKAGE = "@meridian/extractor-typescript";

export interface TypeScriptRevisionShardRuntimeProvenance {
  readonly buildFingerprint: string;
  readonly nodeVersion: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly typescriptVersion: string;
  readonly tsMorphVersion: string;
}

export interface TypeScriptRevisionShardBuildFingerprintInputs {
  /** Exact package manifest for the extractor implementation that will execute. */
  readonly extractorPackageManifest: string;
  /** Exact source or built extractor entry that Node will load. */
  readonly extractorEntry: string;
  /** Test seam; production resolution follows the package's nearest node_modules tree. */
  readonly resolveDependencyManifest?: AnalysisExecutionFingerprintOptions[
    "resolveDependencyManifest"
  ];
}

let cachedRuntimeProvenance: TypeScriptRevisionShardRuntimeProvenance | undefined;

/**
 * Hash the executable extractor subtree and every declared runtime dependency recursively.
 *
 * The underlying execution fingerprint includes canonical package roots, manifests, dependency
 * edges, modes, paths, and bytes. Domain separation prevents this narrower identity from being
 * confused with the whole-analysis execution fingerprint.
 */
export function computeTypeScriptRevisionShardBuildFingerprint(
  inputs: TypeScriptRevisionShardBuildFingerprintInputs,
): string {
  const executionFingerprint = computeAnalysisExecutionFingerprint({
    rootPackageManifest: inputs.extractorPackageManifest,
    workerEntry: inputs.extractorEntry,
    ...(inputs.resolveDependencyManifest === undefined
      ? {}
      : { resolveDependencyManifest: inputs.resolveDependencyManifest }),
  });
  return createHash("sha256")
    .update(
      `meridian-typescript-revision-shard-build-v`
      + `${TYPESCRIPT_SHARD_BUILD_FINGERPRINT_VERSION}\0`,
    )
    .update(executionFingerprint)
    .digest("hex");
}

/**
 * Stable parent-process value. Child validation deliberately uses the uncached function below.
 */
export function typeScriptRevisionShardRuntimeFingerprint(
): TypeScriptRevisionShardRuntimeProvenance {
  return cachedRuntimeProvenance ??= computeCurrentTypeScriptRevisionShardRuntimeFingerprint();
}

/**
 * Re-read the exact on-disk implementation. The disposable worker calls this before and after
 * extraction so a parent that survives a rebuild cannot authorize shards produced by other bytes.
 */
export function computeCurrentTypeScriptRevisionShardRuntimeFingerprint(
): TypeScriptRevisionShardRuntimeProvenance {
  const require = createRequire(import.meta.url);
  const cliPackageManifest = fileURLToPath(new URL("../package.json", import.meta.url));
  const extractorPackageManifest = resolveAnalysisDependencyManifest(
    TYPESCRIPT_EXTRACTOR_PACKAGE,
    cliPackageManifest,
  );
  if (extractorPackageManifest === undefined) {
    throw new Error(`runtime package manifest is unavailable for ${TYPESCRIPT_EXTRACTOR_PACKAGE}`);
  }
  const extractorEntry = importPackageEntry(extractorPackageManifest);
  const tsMorph = require("ts-morph") as { ts?: { version?: unknown } };
  const typescriptVersion = tsMorph.ts?.version;
  if (typeof typescriptVersion !== "string" || typescriptVersion.length === 0) {
    throw new Error("ts-morph embedded TypeScript version is unavailable");
  }

  return Object.freeze({
    buildFingerprint: computeTypeScriptRevisionShardBuildFingerprint({
      extractorPackageManifest,
      extractorEntry,
    }),
    nodeVersion: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    typescriptVersion,
    tsMorphVersion: installedPackageVersion(require, "ts-morph"),
  });
}

function importPackageEntry(manifestPath: string): string {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    exports?: unknown;
    main?: unknown;
  };
  const root = dirname(manifestPath);
  const target = exportTarget(manifest.exports)
    ?? (typeof manifest.main === "string" ? manifest.main : undefined);
  if (target === undefined || !target.startsWith("./")) {
    throw new Error("TypeScript extractor import entry is unavailable");
  }
  const entry = resolve(root, target);
  const relativePath = relative(root, entry);
  if (
    relativePath.length === 0
    || isAbsolute(relativePath)
    || relativePath === ".."
    || relativePath.startsWith(`..${sep}`)
  ) {
    throw new Error("TypeScript extractor import entry escapes its package");
  }
  return entry;
}

function exportTarget(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (Object.hasOwn(record, ".")) return exportTarget(record["."]);
  for (const [condition, target] of Object.entries(record)) {
    if (condition === "node" || condition === "import" || condition === "default") {
      const selected = exportTarget(target);
      if (selected !== undefined) return selected;
    }
  }
  return undefined;
}

function owningPackageManifest(entryPath: string, expectedName: string): string {
  let directory = dirname(entryPath);
  const root = parse(directory).root;
  while (true) {
    const candidate = join(directory, "package.json");
    try {
      const manifest = JSON.parse(readFileSync(candidate, "utf8")) as {
        name?: unknown;
      };
      if (manifest.name === expectedName) return candidate;
    } catch {
      // Package entry points may be nested below directories without manifests.
    }
    if (directory === root) break;
    directory = dirname(directory);
  }
  throw new Error(`runtime package manifest is unavailable for ${expectedName}`);
}

function installedPackageVersion(
  require: NodeJS.Require,
  packageName: string,
): string {
  const manifestPath = owningPackageManifest(require.resolve(packageName), packageName);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { version?: unknown };
  if (typeof manifest.version !== "string" || manifest.version.length === 0) {
    throw new Error(`${packageName} package version is unavailable`);
  }
  return manifest.version;
}
