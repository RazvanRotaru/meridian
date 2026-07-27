import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { isAbsolute } from "node:path";

const OBJECT_OID = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const MAX_SUPPLEMENTAL_JSON_BYTES = 1024 * 1024;
const MAX_SUPPLEMENTAL_FILES = 50_000;
const MAX_SUPPLEMENTAL_PATH_BYTES = 4_096;

export interface RealWorkspaceBenchmarkArguments {
  readonly rootInput: string;
  readonly treeOid: string;
  readonly cacheDirInput: string;
  readonly benchmarkVersion: string;
  readonly supplementalFilesJsonPath: string | null;
}

export interface BenchmarkSupplementalFiles {
  readonly sourcePath: string | null;
  readonly paths: readonly string[];
  readonly digest: string;
}

export function parseRealWorkspaceBenchmarkArguments(
  args: readonly string[],
): RealWorkspaceBenchmarkArguments {
  if (args.length < 3 || args.length > 5) {
    throw new Error(
      "usage: tsx real-workspace-benchmark.ts <root> <tree-oid> <cache-dir> "
      + "[benchmark-version] [supplemental-files-json]",
    );
  }
  const [rootInput, treeOidInput, cacheDirInput, versionInput, supplementalInput] = args;
  if (
    rootInput === undefined
    || rootInput.length === 0
    || rootInput.includes("\0")
    || cacheDirInput === undefined
    || cacheDirInput.length === 0
    || cacheDirInput.includes("\0")
  ) {
    throw new TypeError("benchmark root and cache directory must be non-empty paths");
  }
  const treeOid = treeOidInput?.trim().toLowerCase() ?? "";
  if (!OBJECT_OID.test(treeOid)) {
    throw new TypeError("benchmark tree OID must be a Git SHA-1 or SHA-256 object id");
  }
  const benchmarkVersion = versionInput ?? "local-source";
  if (
    benchmarkVersion.length === 0
    || Buffer.byteLength(benchmarkVersion) > 256
    || benchmarkVersion.includes("\0")
  ) {
    throw new TypeError("benchmark version must be a non-empty string of at most 256 bytes");
  }
  if (supplementalInput !== undefined && !isAbsolute(supplementalInput)) {
    throw new TypeError("supplemental-files JSON path must be absolute");
  }
  return {
    rootInput,
    treeOid,
    cacheDirInput,
    benchmarkVersion,
    supplementalFilesJsonPath: supplementalInput ?? null,
  };
}

/**
 * Load an exact, bounded JSON array without following a final-component symlink.
 *
 * Paths are normalized only by deterministic ordering. The extractor independently proves that
 * every entry is a regular tracked blob in the requested Git tree before using it.
 */
export function loadBenchmarkSupplementalFiles(
  sourcePath: string | null,
): BenchmarkSupplementalFiles {
  if (sourcePath === null) return supplementalReport(null, []);
  if (!isAbsolute(sourcePath)) {
    throw new TypeError("supplemental-files JSON path must be absolute");
  }
  const before = lstatSync(sourcePath);
  if (
    !before.isFile()
    || before.isSymbolicLink()
    || !Number.isSafeInteger(before.size)
    || before.size > MAX_SUPPLEMENTAL_JSON_BYTES
  ) {
    throw new Error(
      `supplemental-files JSON must be a no-follow regular file of at most `
      + `${MAX_SUPPLEMENTAL_JSON_BYTES} bytes`,
    );
  }
  const descriptor = openSync(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes: Buffer;
  try {
    const opened = fstatSync(descriptor);
    if (
      !opened.isFile()
      || opened.dev !== before.dev
      || opened.ino !== before.ino
      || opened.size !== before.size
      || opened.size > MAX_SUPPLEMENTAL_JSON_BYTES
    ) {
      throw new Error("supplemental-files JSON changed while it was opened");
    }
    bytes = readFileSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  if (bytes.byteLength !== before.size || bytes.byteLength > MAX_SUPPLEMENTAL_JSON_BYTES) {
    throw new Error("supplemental-files JSON changed while it was read");
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (cause) {
    throw new Error("supplemental-files JSON is not valid UTF-8 JSON", { cause });
  }
  if (!Array.isArray(decoded) || decoded.length > MAX_SUPPLEMENTAL_FILES) {
    throw new TypeError(
      `supplemental-files JSON must be an array of at most ${MAX_SUPPLEMENTAL_FILES} paths`,
    );
  }
  const seen = new Set<string>();
  for (const value of decoded) {
    if (typeof value !== "string" || !isExactTypeScriptPath(value)) {
      throw new TypeError(
        "supplemental files must be safe root-relative POSIX .ts or .tsx paths",
      );
    }
    if (seen.has(value)) {
      throw new TypeError(`supplemental-files JSON contains a duplicate path: ${value}`);
    }
    seen.add(value);
  }
  return supplementalReport(sourcePath, [...seen].sort(compareNames));
}

function supplementalReport(
  sourcePath: string | null,
  paths: readonly string[],
): BenchmarkSupplementalFiles {
  return {
    sourcePath,
    paths,
    digest: createHash("sha256").update(JSON.stringify(paths)).digest("hex"),
  };
}

function isExactTypeScriptPath(path: string): boolean {
  return path.length > 0
    && Buffer.byteLength(path) <= MAX_SUPPLEMENTAL_PATH_BYTES
    && !path.includes("\0")
    && !path.includes("\\")
    && !isAbsolute(path)
    && /\.tsx?$/.test(path)
    && path.split("/").every(
      (part) => part !== "" && part !== "." && part !== ".." && part !== ".git",
    );
}

function compareNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
