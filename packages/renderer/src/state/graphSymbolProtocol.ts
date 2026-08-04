import {
  GRAPH_SYMBOL_SEARCH_VERSION,
  nodeIdSchema,
} from "@meridian/core";
import type {
  CompactGraphSymbolEntry,
  GraphSymbolSearchResultV1,
} from "@meridian/core";

export const MAX_GRAPH_SYMBOLS = 500_000;
export const MAX_GRAPH_SYMBOL_RESPONSE_BYTES = 64 * 1024 * 1024;

const MAX_ID_CHARS = 2_048;
const MAX_SYMBOL_TEXT_CHARS = 8_192;
const KIND_PATTERN = /^[a-z][a-zA-Z0-9]*$/;

export type GraphSymbolProtocolErrorFactory = (message: string) => Error;

const defaultError: GraphSymbolProtocolErrorFactory = (message) => new Error(message);

/** Standalone compact-index validator shared by the renderer fallback and its browser Worker. */
export function parseGraphSymbolResult(
  value: unknown,
  error: GraphSymbolProtocolErrorFactory = defaultError,
): GraphSymbolSearchResultV1 {
  const candidate = requireRecord(value, "graph symbol result", error);
  requireExactVersion(candidate.version, GRAPH_SYMBOL_SEARCH_VERSION, "graph symbol result", error);
  const graphId = requireBoundedString(candidate.graphId, "graphId", MAX_ID_CHARS, error);
  const generation = requireBoundedString(candidate.generation, "generation", MAX_ID_CHARS, error);
  if (typeof candidate.complete !== "boolean") throw error("complete must be a boolean");
  const indexedSymbolCount = requireBoundedInteger(
    candidate.indexedSymbolCount,
    "indexedSymbolCount",
    0,
    MAX_GRAPH_SYMBOLS,
    error,
  );
  const totalSymbolCount = requireBoundedInteger(
    candidate.totalSymbolCount,
    "totalSymbolCount",
    indexedSymbolCount,
    MAX_GRAPH_SYMBOLS,
    error,
  );
  if (candidate.complete && indexedSymbolCount !== totalSymbolCount) {
    throw error("a complete symbol result must have indexedSymbolCount equal totalSymbolCount");
  }
  const rawSymbols = requireBoundedArray(candidate.symbols, "symbols", MAX_GRAPH_SYMBOLS, error);
  if (rawSymbols.length > indexedSymbolCount) {
    throw error("symbols cannot outnumber indexedSymbolCount");
  }
  const symbols = rawSymbols.map((entry, index) => parseSymbolEntry(entry, index, error));
  if (new Set(symbols.map((entry) => entry.id)).size !== symbols.length) {
    throw error("symbol ids must not contain duplicates");
  }
  return {
    version: GRAPH_SYMBOL_SEARCH_VERSION,
    graphId,
    generation,
    complete: candidate.complete,
    indexedSymbolCount,
    totalSymbolCount,
    symbols,
  };
}

/** Bound UTF-8 input before JSON.parse; in production both operations run off the UI thread. */
export function parseGraphSymbolText(
  text: string,
  maxBytes = MAX_GRAPH_SYMBOL_RESPONSE_BYTES,
  error: GraphSymbolProtocolErrorFactory = defaultError,
): GraphSymbolSearchResultV1 {
  requirePositiveByteLimit(maxBytes, error);
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    throw error(`graph symbol response exceeds ${maxBytes} bytes`);
  }
  return parseBoundedGraphSymbolText(text, error);
}

/** Parse text that has already been bounded while its raw response bytes were streaming. */
export function parseBoundedGraphSymbolText(
  text: string,
  error: GraphSymbolProtocolErrorFactory = defaultError,
): GraphSymbolSearchResultV1 {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw error("graph symbol response is not valid JSON");
  }
  return parseGraphSymbolResult(value, error);
}

function parseSymbolEntry(
  value: unknown,
  index: number,
  error: GraphSymbolProtocolErrorFactory,
): CompactGraphSymbolEntry {
  const entry = requireRecord(value, `symbols[${index}]`, error);
  const kind = requireBoundedString(entry.kind, `symbols[${index}].kind`, 128, error);
  if (!KIND_PATTERN.test(kind)) throw error(`symbols[${index}].kind is invalid`);
  if (typeof entry.isPrivateMethod !== "boolean") {
    throw error(`symbols[${index}].isPrivateMethod must be a boolean`);
  }
  const stepCount = entry.stepCount === null
    ? null
    : requireBoundedInteger(
        entry.stepCount,
        `symbols[${index}].stepCount`,
        0,
        Number.MAX_SAFE_INTEGER,
        error,
      );
  return {
    id: requireNodeId(entry.id, `symbols[${index}].id`, error),
    fileId: requireNodeId(entry.fileId, `symbols[${index}].fileId`, error),
    displayName: requireBoundedString(
      entry.displayName,
      `symbols[${index}].displayName`,
      MAX_SYMBOL_TEXT_CHARS,
      error,
    ),
    qualifiedName: requireBoundedString(
      entry.qualifiedName,
      `symbols[${index}].qualifiedName`,
      MAX_SYMBOL_TEXT_CHARS,
      error,
    ),
    kind,
    file: requireBoundedString(entry.file, `symbols[${index}].file`, MAX_SYMBOL_TEXT_CHARS, error),
    isPrivateMethod: entry.isPrivateMethod,
    stepCount,
  };
}

function requireRecord(
  value: unknown,
  field: string,
  error: GraphSymbolProtocolErrorFactory,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireBoundedArray(
  value: unknown,
  field: string,
  maximum: number,
  error: GraphSymbolProtocolErrorFactory,
): unknown[] {
  if (!Array.isArray(value)) throw error(`${field} must be an array`);
  if (value.length > maximum) throw error(`${field} exceeds ${maximum} entries`);
  return value;
}

function requireBoundedString(
  value: unknown,
  field: string,
  maximum: number,
  error: GraphSymbolProtocolErrorFactory,
): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw error(`${field} must be a non-empty string of at most ${maximum} characters`);
  }
  return value;
}

function requireNodeId(
  value: unknown,
  field: string,
  error: GraphSymbolProtocolErrorFactory,
): string {
  const id = requireBoundedString(value, field, MAX_ID_CHARS, error);
  if (!nodeIdSchema.safeParse(id).success) throw error(`${field} is not a canonical node id`);
  return id;
}

function requireBoundedInteger(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
  error: GraphSymbolProtocolErrorFactory,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw error(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
  return value as number;
}

function requireExactVersion(
  value: unknown,
  version: number,
  field: string,
  error: GraphSymbolProtocolErrorFactory,
): void {
  if (value !== version) throw error(`${field} version must be ${version}`);
}

function requirePositiveByteLimit(value: number, error: GraphSymbolProtocolErrorFactory): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw error("maxBytes must be a positive integer");
}
