/**
 * Immutable codec for one semantic region's ordered, per-file TypeScript contributions.
 *
 * V3 deliberately contains no imports, package nodes, Promise fixed-point lane, port lane, or
 * target-wide unit summary. Imports and the remaining global reducers are recomputed from the
 * exact target; relationship/value diagnostics remain file-and-phase-owned in this payload.
 *
 * `encodeSemanticRegionContributions` routes an in-process miss through the same bounded clone and
 * decoder used for an untrusted cache hit. Callers therefore cannot accidentally materialize a
 * freshly built region from construction-order objects while hits use codec-normalized objects.
 */

import type { RawEdge } from "../edge-pass";
import {
  type UnitSemanticFileContributionV1,
} from "../unit-contributions";
import { compareCanonicalStrings } from "./canonical-json";
import { decodeUnitExtraction } from "./shard-codec";

export const SEMANTIC_REGION_CONTRIBUTION_CODEC_VERSION = 3 as const;
export const MAX_SEMANTIC_REGION_CONTRIBUTION_BYTES = 128 * 1024 * 1024;
export const MAX_SEMANTIC_REGION_FILES = 20_000;

const MAX_JSON_DEPTH = 128;
const MAX_JSON_VALUES = 5_000_000;
const MAX_JSON_ARRAY_ITEMS = 1_000_000;
const MAX_JSON_STRING_BYTES = 16 * 1024 * 1024;
const MAX_PATH_BYTES = 4_096;

const PAYLOAD_KEYS = ["files", "version"] as const;
const FILE_KEYS = [
  "behaviouralEdges",
  "diagnostics",
  "file",
  "inheritanceEdges",
  "summary",
  "valueReferenceEdges",
] as const;
const DIAGNOSTIC_KEYS = ["behavioural", "inheritance", "valueReferences"] as const;
const SUMMARY_KEYS = ["exports", "moduleId", "pendingReexports"] as const;
const BEHAVIOURAL_EDGE_KINDS = new Set([
  "calls",
  "injects",
  "instantiates",
  "references",
  "registers",
  "renders",
]);
const INHERITANCE_EDGE_KINDS = new Set(["extends", "implements"]);

export type CachedSemanticFileContributionV3 = Omit<
  UnitSemanticFileContributionV1,
  "importEdges"
>;

export interface SerializedSemanticRegionContributionsV3 {
  readonly version: typeof SEMANTIC_REGION_CONTRIBUTION_CODEC_VERSION;
  /** Exact target-program order restricted to this region. Never sort during codec traversal. */
  readonly files: readonly CachedSemanticFileContributionV3[];
}

export interface SemanticRegionCodecLimits {
  /** A caller may narrow, but never raise, the hard codec byte ceiling. */
  readonly maxBytes?: number;
  /** A caller may narrow, but never raise, the maximum files in one semantic SCC. */
  readonly maxFiles?: number;
}

export type SemanticRegionLimitBoundary =
  | "cache-context-entry-bytes"
  | "cache-shard-entry-bytes"
  | "codec-array-items"
  | "codec-json-depth"
  | "codec-json-values"
  | "codec-payload-bytes"
  | "codec-region-files"
  | "codec-string-bytes";

/**
 * A resource ceiling is an availability condition, not malformed semantic data.
 *
 * Callers may conservatively abandon region reuse only for this typed error. Schema, ownership,
 * identity, cache-corruption, and parity errors intentionally remain ordinary hard failures.
 */
export class SemanticRegionLimitError extends Error {
  constructor(
    readonly boundary: SemanticRegionLimitBoundary,
    readonly limit: number,
    readonly actual: number | null = null,
  ) {
    const unit = boundary.endsWith("-bytes") ? " bytes" : "";
    super(
      `semantic-region ${boundary} exceeds ${limit}${unit}`
      + (actual === null ? "" : ` (observed ${actual})`),
    );
    this.name = "SemanticRegionLimitError";
  }
}

export function isSemanticRegionLimitError(
  error: unknown,
): error is SemanticRegionLimitError {
  return error instanceof SemanticRegionLimitError;
}

/**
 * Encode a canonical miss. This intentionally calls the public decoder: a miss and a parsed cache
 * hit cross exactly the same JSON-safety, size, schema, ownership, and coherence boundary.
 */
export function encodeSemanticRegionContributions(
  files: readonly UnitSemanticFileContributionV1[],
  limits: SemanticRegionCodecLimits = {},
): SerializedSemanticRegionContributionsV3 {
  return decodeSemanticRegionContributions({
    version: SEMANTIC_REGION_CONTRIBUTION_CODEC_VERSION,
    files: files.map((file) => ({
      file: file.file,
      behaviouralEdges: file.behaviouralEdges,
      inheritanceEdges: file.inheritanceEdges,
      valueReferenceEdges: file.valueReferenceEdges,
      diagnostics: file.diagnostics,
      summary: file.summary,
    })),
  }, limits);
}

/** Decode one untrusted immutable region payload into a detached, JSON-safe plain-data value. */
export function decodeSemanticRegionContributions(
  value: unknown,
  limits: SemanticRegionCodecLimits = {},
): SerializedSemanticRegionContributionsV3 {
  const safe = boundedJsonClone(value, normalizedMaxBytes(limits.maxBytes));
  if (!isRecord(safe)
    || !hasExactKeys(safe, PAYLOAD_KEYS)
    || safe.version !== SEMANTIC_REGION_CONTRIBUTION_CODEC_VERSION
    || !Array.isArray(safe.files)
    || safe.files.length === 0) {
    throw new Error("invalid semantic-region contribution payload");
  }
  const maxFiles = normalizedMaxFiles(limits.maxFiles);
  if (safe.files.length > maxFiles) {
    throw new SemanticRegionLimitError(
      "codec-region-files",
      maxFiles,
      safe.files.length,
    );
  }

  const seenFiles = new Set<string>();
  for (const [index, file] of safe.files.entries()) {
    validateFileContribution(file, index, seenFiles);
  }
  return safe as unknown as SerializedSemanticRegionContributionsV3;
}

function validateFileContribution(
  value: unknown,
  index: number,
  seenFiles: Set<string>,
): void {
  if (!isRecord(value)
    || !hasExactKeys(value, FILE_KEYS)
    || typeof value.file !== "string"
    || !Array.isArray(value.behaviouralEdges)
    || !Array.isArray(value.inheritanceEdges)
    || !Array.isArray(value.valueReferenceEdges)
    || !isRecord(value.diagnostics)
    || !hasExactKeys(value.diagnostics, DIAGNOSTIC_KEYS)
    || !Array.isArray(value.diagnostics.behavioural)
    || !Array.isArray(value.diagnostics.inheritance)
    || !Array.isArray(value.diagnostics.valueReferences)
    || !isRecord(value.summary)
    || !hasExactKeys(value.summary, SUMMARY_KEYS)) {
    throw new Error(`invalid semantic-region file contribution at ${index + 1}`);
  }
  const file = canonicalRelativePath(value.file, "region file");
  if (seenFiles.has(file)) {
    throw new Error(`duplicate semantic-region file contribution: ${file}`);
  }
  seenFiles.add(file);

  const summary = value.summary;
  if (typeof summary.moduleId !== "string"
    || summary.moduleId.length === 0
    || !Array.isArray(summary.exports)
    || !Array.isArray(summary.pendingReexports)) {
    throw new Error(`invalid semantic-region file summary: ${file}`);
  }

  // Reuse the existing immutable unit-shard validators for complex edge, diagnostic, export, and
  // pending-reexport shapes. Region payloads deliberately contain no target-wide/fresh lanes.
  try {
    decodeUnitExtraction({
      nodes: [],
      rawEdges: [
        ...value.behaviouralEdges,
        ...value.inheritanceEdges,
        ...value.valueReferenceEdges,
      ],
      implementationMembers: [],
      flows: {},
      ports: [],
      summary: {
        dir: directoryOf(file),
        name: null,
        entryFile: null,
        sourceDir: directoryOf(file),
        exportsByFile: [[file, summary.exports]],
        moduleIdByRelPath: [[file, summary.moduleId]],
        pendingReexports: summary.pendingReexports,
      },
      diagnostics: [
        ...value.diagnostics.behavioural,
        ...value.diagnostics.inheritance,
        ...value.diagnostics.valueReferences,
      ],
      files: 1,
    });
  } catch (cause) {
    throw new Error(`invalid semantic-region contribution data for ${file}`, { cause });
  }

  assertEdgeLane(
    value.behaviouralEdges as RawEdge[],
    file,
    "behavioural",
    BEHAVIOURAL_EDGE_KINDS,
  );
  assertEdgeLane(
    value.inheritanceEdges as RawEdge[],
    file,
    "inheritance",
    INHERITANCE_EDGE_KINDS,
  );
  assertEdgeLane(
    value.valueReferenceEdges as RawEdge[],
    file,
    "value-reference",
    new Set(["references"]),
  );
  validateFileSummary(
    file,
    summary as {
      exports: Array<[string, string]>;
      moduleId: string;
      pendingReexports: Array<{
        file: string;
        specifier: string;
        targetFile?: string;
        names: null | Array<{ exported: string; local: string }>;
      }>;
    },
  );
}

function assertEdgeLane(
  edges: readonly RawEdge[],
  file: string,
  lane: string,
  allowedKinds: ReadonlySet<string>,
): void {
  for (const edge of edges) {
    if (!allowedKinds.has(edge.kind)) {
      throw new Error(`invalid ${lane} lane edge kind: ${edge.kind}`);
    }
    if (edge.callSite.file !== file || edge.source.length === 0) {
      throw new Error(`${lane} edge belongs to another file: ${edge.source}`);
    }
    const targetFile = edge.resolution.pending?.targetFile;
    if (targetFile !== undefined) {
      canonicalRelativePath(targetFile, `${lane} edge pending target`);
    }
  }
}

function validateFileSummary(
  file: string,
  summary: {
    exports: Array<[string, string]>;
    moduleId: string;
    pendingReexports: Array<{
      file: string;
      specifier: string;
      targetFile?: string;
      names: null | Array<{ exported: string; local: string }>;
    }>;
  },
): void {
  const exportNames = new Set<string>();
  for (const [index, entry] of summary.exports.entries()) {
    if (!Array.isArray(entry)
      || entry.length !== 2
      || typeof entry[0] !== "string"
      || entry[0].length === 0
      || typeof entry[1] !== "string"
      || entry[1].length === 0) {
      throw new Error(`invalid semantic-region export summary for ${file} at ${index + 1}`);
    }
    if (exportNames.has(entry[0])) {
      throw new Error(`duplicate semantic-region export name for ${file}: ${entry[0]}`);
    }
    exportNames.add(entry[0]);
  }

  for (const reexport of summary.pendingReexports) {
    if (reexport.file !== file || reexport.specifier.length === 0) {
      throw new Error(`pending re-export belongs to another file: ${file}`);
    }
    if (reexport.targetFile !== undefined) {
      canonicalRelativePath(reexport.targetFile, "pending re-export target");
    }
    if (reexport.names !== null) {
      const exportedNames = new Set<string>();
      for (const name of reexport.names) {
        if (name.exported.length === 0
          || name.local.length === 0
          || exportedNames.has(name.exported)) {
          throw new Error(`incoherent pending re-export summary for ${file}`);
        }
        exportedNames.add(name.exported);
      }
    }
  }
}

function canonicalRelativePath(value: string, label: string): string {
  if (value.length === 0
    || Buffer.byteLength(value) > MAX_PATH_BYTES
    || value.includes("\0")
    || value.includes("\\")
    || value.startsWith("/")
    || /^[A-Za-z]:\//.test(value)
    || value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`${label} is not a canonical root-relative POSIX path: ${value}`);
  }
  return value;
}

function directoryOf(file: string): string {
  const slash = file.lastIndexOf("/");
  return slash === -1 ? "" : file.slice(0, slash);
}

function normalizedMaxBytes(value: number | undefined): number {
  if (value === undefined) return MAX_SEMANTIC_REGION_CONTRIBUTION_BYTES;
  if (!Number.isSafeInteger(value)
    || value <= 0
    || value > MAX_SEMANTIC_REGION_CONTRIBUTION_BYTES) {
    throw new TypeError("semantic-region codec maxBytes must narrow the hard byte limit");
  }
  return value;
}

function normalizedMaxFiles(value: number | undefined): number {
  if (value === undefined) return MAX_SEMANTIC_REGION_FILES;
  if (!Number.isSafeInteger(value)
    || value <= 0
    || value > MAX_SEMANTIC_REGION_FILES) {
    throw new TypeError("semantic-region codec maxFiles must narrow the hard file limit");
  }
  return value;
}

function boundedJsonClone(value: unknown, maxBytes: number): unknown {
  const state: JsonCloneState = {
    active: new Set<object>(),
    values: 0,
    stringBytes: 0,
  };
  const cloned = cloneJsonValue(value, "$", 0, state, maxBytes);
  const bytes = Buffer.byteLength(JSON.stringify(cloned), "utf8");
  if (bytes > maxBytes) {
    throw new SemanticRegionLimitError("codec-payload-bytes", maxBytes, bytes);
  }
  return cloned;
}

interface JsonCloneState {
  active: Set<object>;
  values: number;
  stringBytes: number;
}

function cloneJsonValue(
  value: unknown,
  path: string,
  depth: number,
  state: JsonCloneState,
  maxBytes: number,
): unknown {
  state.values += 1;
  if (state.values > MAX_JSON_VALUES) {
    throw new SemanticRegionLimitError(
      "codec-json-values",
      MAX_JSON_VALUES,
      state.values,
    );
  }
  if (depth > MAX_JSON_DEPTH) {
    throw new SemanticRegionLimitError("codec-json-depth", MAX_JSON_DEPTH, depth);
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    const bytes = Buffer.byteLength(value);
    if (bytes > MAX_JSON_STRING_BYTES) {
      throw new SemanticRegionLimitError(
        "codec-string-bytes",
        MAX_JSON_STRING_BYTES,
        bytes,
      );
    }
    state.stringBytes += bytes;
    if (state.stringBytes > maxBytes) {
      throw new SemanticRegionLimitError(
        "codec-payload-bytes",
        maxBytes,
        state.stringBytes,
      );
    }
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`semantic-region contribution contains a non-finite number at ${path}`);
    }
    return value;
  }
  if (typeof value !== "object") {
    throw new Error(`semantic-region contribution contains non-JSON ${typeof value} at ${path}`);
  }
  if (state.active.has(value)) {
    throw new Error(`semantic-region contribution contains a cycle at ${path}`);
  }
  state.active.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > MAX_JSON_ARRAY_ITEMS) {
        throw new SemanticRegionLimitError(
          "codec-array-items",
          MAX_JSON_ARRAY_ITEMS,
          value.length,
        );
      }
      const keys = Reflect.ownKeys(value);
      if (keys.some((key) => typeof key !== "string" || !isArrayIndex(key, value.length))) {
        throw new Error(`semantic-region contribution has a non-index array property at ${path}`);
      }
      return Array.from({ length: value.length }, (_, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, index);
        if (descriptor === undefined
          || !("value" in descriptor)
          || descriptor.value === undefined) {
          throw new Error(`semantic-region contribution has a sparse array at ${path}[${index}]`);
        }
        return cloneJsonValue(
          descriptor.value,
          `${path}[${index}]`,
          depth + 1,
          state,
          maxBytes,
        );
      });
    }
    if (!isRecord(value)) {
      throw new Error(`semantic-region contribution contains a non-plain object at ${path}`);
    }
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string")) {
      throw new Error(`semantic-region contribution contains a symbol key at ${path}`);
    }
    const output: Record<string, unknown> = {};
    for (const key of (keys as string[]).sort(compareCanonicalStrings)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
        throw new Error(`semantic-region contribution contains an accessor at ${path}.${key}`);
      }
      if (descriptor.value === undefined) {
        throw new Error(`semantic-region contribution contains undefined at ${path}.${key}`);
      }
      output[key] = cloneJsonValue(
        descriptor.value,
        `${path}.${key}`,
        depth + 1,
        state,
        maxBytes,
      );
    }
    return output;
  } finally {
    state.active.delete(value);
  }
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort(compareCanonicalStrings);
  const sortedExpected = [...expected].sort(compareCanonicalStrings);
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isArrayIndex(key: string, length: number): boolean {
  if (key === "length") return true;
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === key;
}
