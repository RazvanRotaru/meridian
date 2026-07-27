/**
 * Cache-only provenance for repository analysis.
 *
 * Artifact headers deliberately keep their release-facing generator version stable. Cache
 * identities use this stricter fingerprint instead: a build-time digest of the analysis
 * implementation and lock/config inputs, a runtime digest of the actual worker and resolved
 * dependency bytes, exact JS/TypeScript runtime coordinates, and a process nonce. The nonce is an
 * intentional fail-closed boundary while inputs outside the Node process (notably Python and Git
 * behavior) are not yet captured completely.
 */

import { createHash, randomBytes } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { join, relative, resolve, sep } from "node:path";
import { computeAnalysisExecutionFingerprint } from "./analysis-execution-fingerprint";

declare const __MERIDIAN_ANALYSIS_BUILD_FINGERPRINT__: string | undefined;

const BUILD_FINGERPRINT_VERSION = 1;
const COMBINED_BUILD_FINGERPRINT_VERSION = 2;
const RUNTIME_FINGERPRINT_VERSION = 1;
const SHA256 = /^[a-f0-9]{64}$/;
const PROCESS_INSTANCE_NONCE = randomBytes(16).toString("hex");

export const ANALYSIS_BUILD_INPUTS = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.base.json",
  "packages/core/package.json",
  "packages/core/tsconfig.json",
  "packages/core/tsup.config.ts",
  "packages/core/src",
  "packages/extractor-python/package.json",
  "packages/extractor-python/tsconfig.json",
  "packages/extractor-python/tsup.config.ts",
  "packages/extractor-python/python",
  "packages/extractor-python/src",
  "packages/extractor-typescript/package.json",
  "packages/extractor-typescript/tsconfig.json",
  "packages/extractor-typescript/tsup.config.ts",
  "packages/extractor-typescript/src",
  "packages/cli/package.json",
  "packages/cli/tsconfig.json",
  "packages/cli/tsup.config.ts",
  "packages/cli/src",
] as const;

export interface AnalysisRuntimeFingerprint {
  readonly formatVersion: 1;
  readonly buildFingerprint: string;
  readonly processInstanceNonce: string;
  readonly nodeVersion: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly typescriptVersion: string;
  readonly tsMorphVersion: string;
}

let cachedDefaultFingerprint: AnalysisRuntimeFingerprint | undefined;

/**
 * Used by tsup to inject an immutable digest and by source-mode tests/tsx as a safe fallback.
 * Paths and bytes are length-framed and visited in lexical order.
 */
export function computeAnalysisBuildFingerprint(
  workspaceRoot: string,
  inputPaths: readonly string[] = ANALYSIS_BUILD_INPUTS,
): string {
  const root = resolve(workspaceRoot);
  const files = inputPaths
    .flatMap((input) => collectInputFiles(root, input))
    .sort(compareCodePoints);
  const hash = createHash("sha256");
  hash.update(`meridian-analysis-build-v${BUILD_FINGERPRINT_VERSION}\0`);
  for (const file of files) {
    const path = relative(root, file).split(sep).join("/");
    const bytes = readFileSync(file);
    hash.update(`${Buffer.byteLength(path, "utf8")}:`);
    hash.update(path);
    hash.update(`${bytes.byteLength}:`);
    hash.update(bytes);
  }
  return hash.digest("hex");
}

export function combineAnalysisBuildFingerprints(
  sourceBuildFingerprint: string,
  executionFingerprint: string,
): string {
  if (!SHA256.test(sourceBuildFingerprint) || !SHA256.test(executionFingerprint)) {
    throw new TypeError("analysis build fingerprints must be SHA-256 digests");
  }
  const hash = createHash("sha256");
  hash.update(`meridian-analysis-combined-build-v${COMBINED_BUILD_FINGERPRINT_VERSION}\0`);
  hash.update(sourceBuildFingerprint);
  hash.update("\0");
  hash.update(executionFingerprint);
  return hash.digest("hex");
}

/**
 * The optional override is dependency injection for identity tests. Production callers omit it.
 */
export function analysisRuntimeFingerprint(
  override: Partial<AnalysisRuntimeFingerprint> = {},
): AnalysisRuntimeFingerprint {
  const base = cachedDefaultFingerprint ??= computeCurrentAnalysisRuntimeFingerprint();
  if (Object.keys(override).length === 0) return base;
  return Object.freeze({ ...base, ...override });
}

/**
 * Recompute the executable identity from current on-disk bytes.
 *
 * Repository-analysis children call this immediately before and after shard-enabled extraction.
 * The parent may remain alive across a rebuild, so its cached startup identity is not sufficient
 * evidence for the bytes a newly spawned child actually executes.
 */
export function computeCurrentAnalysisRuntimeFingerprint(): AnalysisRuntimeFingerprint {
  return Object.freeze({
    formatVersion: RUNTIME_FINGERPRINT_VERSION,
    buildFingerprint: computeCurrentAnalysisBuildFingerprint(),
    processInstanceNonce: PROCESS_INSTANCE_NONCE,
    nodeVersion: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    typescriptVersion: embeddedTypeScriptVersion(),
    tsMorphVersion: installedPackageVersion("ts-morph"),
  });
}

function computeCurrentAnalysisBuildFingerprint(): string {
  let sourceBuildFingerprint: string;
  if (
    typeof __MERIDIAN_ANALYSIS_BUILD_FINGERPRINT__ === "string"
    && SHA256.test(__MERIDIAN_ANALYSIS_BUILD_FINGERPRINT__)
  ) {
    sourceBuildFingerprint = __MERIDIAN_ANALYSIS_BUILD_FINGERPRINT__;
  } else {
    try {
      const workspaceRoot = fileURLToPath(new URL("../../../", import.meta.url));
      sourceBuildFingerprint = computeAnalysisBuildFingerprint(workspaceRoot);
    } catch {
      // Never let two source-mode processes share analysis artifacts when complete source
      // provenance cannot be calculated.
      sourceBuildFingerprint = createHash("sha256")
        .update(`unavailable-source-build:${PROCESS_INSTANCE_NONCE}`)
        .digest("hex");
    }
  }
  try {
    const sourceMode = fileURLToPath(import.meta.url).endsWith(".ts");
    const executionFingerprint = computeAnalysisExecutionFingerprint({
      rootPackageManifest: fileURLToPath(new URL("../package.json", import.meta.url)),
      workerEntry: fileURLToPath(new URL(
        sourceMode ? "./repository-analysis-worker.ts" : "./repository-analysis-worker.js",
        import.meta.url,
      )),
      additionalRootDependencies: sourceMode ? ["tsx"] : [],
    });
    return combineAnalysisBuildFingerprints(
      sourceBuildFingerprint,
      executionFingerprint,
    );
  } catch {
    // Shard reuse deliberately crosses process boundaries. If the exact executable closure cannot
    // be proven, bind the build identity to this process and fail closed across restarts.
    return createHash("sha256")
      .update(`unavailable-execution-build:${sourceBuildFingerprint}:${PROCESS_INSTANCE_NONCE}`)
      .digest("hex");
  }
}

function installedPackageVersion(packageName: "ts-morph"): string {
  const require = createRequire(import.meta.url);
  const manifestPath = require.resolve(`${packageName}/package.json`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { version?: unknown };
  if (typeof manifest.version !== "string" || manifest.version.length === 0) {
    throw new Error(`${packageName} package version is unavailable`);
  }
  return manifest.version;
}

function embeddedTypeScriptVersion(): string {
  const require = createRequire(import.meta.url);
  const tsMorph = require("ts-morph") as { ts?: { version?: unknown } };
  const version = tsMorph.ts?.version;
  if (typeof version !== "string" || version.length === 0) {
    throw new Error("ts-morph embedded TypeScript version is unavailable");
  }
  return version;
}

function collectInputFiles(workspaceRoot: string, input: string): string[] {
  const absolute = resolve(workspaceRoot, input);
  const relativePath = relative(workspaceRoot, absolute);
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`)) {
    throw new Error(`analysis build input escapes workspace: ${input}`);
  }
  const entry = lstatSync(absolute);
  if (entry.isDirectory()) return collectDirectoryFiles(absolute);
  if (entry.isFile()) return [absolute];
  throw new Error(`analysis build input must not be a link or special file: ${input}`);
}

function collectDirectoryFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "__pycache__" || entry.name.endsWith(".pyc") || entry.name.endsWith(".pyo")) {
      return [];
    }
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return collectDirectoryFiles(path);
    if (entry.isFile()) return [path];
    throw new Error(`analysis build input must not contain links or special files: ${path}`);
  });
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
