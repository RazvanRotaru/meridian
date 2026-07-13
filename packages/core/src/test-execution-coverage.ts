/**
 * Provider-neutral runtime test coverage carried by a graph artifact.
 *
 * Collectors are deliberately kept outside this contract. The CLI currently imports Istanbul's
 * coverage-map JSON, while renderers consume only this normalized shape. Paths use the same
 * extraction-root-relative POSIX coordinates as `GraphNode.location.file`; lines are 1-based and
 * columns are 0-based, matching Istanbul's source locations.
 */

import type { GraphArtifact } from "./types";

export const TEST_EXECUTION_COVERAGE_EXTENSION = "testExecutionCoverage";
export const TEST_EXECUTION_COVERAGE_VERSION = "1.0.0" as const;

export interface ExecutionCoveragePosition {
  line: number;
  /** 0-based when the reporter provides it; omitted when a source-map range has a null column. */
  column?: number;
}

export interface ExecutionCoverageSpan {
  start: ExecutionCoveragePosition;
  end: ExecutionCoveragePosition;
}

export interface TestExecutionCoverageFunction {
  name: string;
  hits: number;
  decl: ExecutionCoverageSpan;
  location: ExecutionCoverageSpan;
}

export interface TestExecutionCoverageBranchPath {
  index: number;
  hits: number;
  /** Some Istanbul producers synthesize an implicit arm with an empty `{start:{},end:{}}` range. */
  location?: ExecutionCoverageSpan;
}

export interface TestExecutionCoverageBranch {
  type: string;
  location: ExecutionCoverageSpan;
  paths: TestExecutionCoverageBranchPath[];
}

export interface TestExecutionCoverageFile {
  functions: TestExecutionCoverageFunction[];
  branches: TestExecutionCoverageBranch[];
}

export interface TestExecutionCoverage {
  version: typeof TEST_EXECUTION_COVERAGE_VERSION;
  /** True means the counters combine the whole test run, rather than identifying individual tests. */
  aggregate: true;
  producer: {
    inputFormat: "istanbul-coverage-map";
  };
  /** Extraction-root-relative POSIX file path -> normalized runtime evidence. */
  files: Record<string, TestExecutionCoverageFile>;
}

/**
 * Defensive extension reader. `extensions` is intentionally open JSON, so any malformed field
 * invalidates the whole payload and returns null. Explicit zero counters remain evidence and are
 * preserved; absent files/functions/branches are never synthesized here.
 */
export function readTestExecutionCoverage(artifact: GraphArtifact): TestExecutionCoverage | null {
  const raw = artifact.extensions?.[TEST_EXECUTION_COVERAGE_EXTENSION];
  if (!isRecord(raw) || raw.version !== TEST_EXECUTION_COVERAGE_VERSION || raw.aggregate !== true) {
    return null;
  }
  if (!isRecord(raw.producer) || raw.producer.inputFormat !== "istanbul-coverage-map") {
    return null;
  }
  if (!isRecord(raw.files)) {
    return null;
  }

  const files: Array<[string, TestExecutionCoverageFile]> = [];
  for (const [path, value] of Object.entries(raw.files)) {
    if (!isRelativePosixPath(path)) {
      return null;
    }
    const file = readFile(value);
    if (file === null) {
      return null;
    }
    files.push([path, file]);
  }

  return {
    version: TEST_EXECUTION_COVERAGE_VERSION,
    aggregate: true,
    producer: { inputFormat: "istanbul-coverage-map" },
    files: Object.fromEntries(files),
  };
}

function readFile(value: unknown): TestExecutionCoverageFile | null {
  if (!isRecord(value) || !Array.isArray(value.functions) || !Array.isArray(value.branches)) {
    return null;
  }
  const functions: TestExecutionCoverageFunction[] = [];
  for (const entry of value.functions) {
    const parsed = readFunction(entry);
    if (parsed === null) {
      return null;
    }
    functions.push(parsed);
  }
  const branches: TestExecutionCoverageBranch[] = [];
  for (const entry of value.branches) {
    const parsed = readBranch(entry);
    if (parsed === null) {
      return null;
    }
    branches.push(parsed);
  }
  return { functions, branches };
}

function readFunction(value: unknown): TestExecutionCoverageFunction | null {
  if (!isRecord(value) || typeof value.name !== "string" || !isCount(value.hits)) {
    return null;
  }
  const decl = readSpan(value.decl);
  const location = readSpan(value.location);
  return decl && location ? { name: value.name, hits: value.hits, decl, location } : null;
}

function readBranch(value: unknown): TestExecutionCoverageBranch | null {
  if (!isRecord(value) || typeof value.type !== "string" || value.type.length === 0 || !Array.isArray(value.paths)) {
    return null;
  }
  const location = readSpan(value.location);
  if (location === null) {
    return null;
  }
  const paths: TestExecutionCoverageBranchPath[] = [];
  const indices = new Set<number>();
  for (const entry of value.paths) {
    if (!isRecord(entry) || !isCount(entry.index) || !isCount(entry.hits) || indices.has(entry.index)) {
      return null;
    }
    const pathLocation = entry.location === undefined ? undefined : readSpan(entry.location);
    if (entry.location !== undefined && pathLocation === null) {
      return null;
    }
    indices.add(entry.index);
    paths.push({
      index: entry.index,
      hits: entry.hits,
      ...(pathLocation ? { location: pathLocation } : {}),
    });
  }
  return { type: value.type, location, paths };
}

function readSpan(value: unknown): ExecutionCoverageSpan | null {
  if (!isRecord(value)) {
    return null;
  }
  const start = readPosition(value.start);
  const end = readPosition(value.end);
  if (!start || !end || spanIsReversed(start, end)) {
    return null;
  }
  return { start, end };
}

function readPosition(value: unknown): ExecutionCoveragePosition | null {
  if (!isRecord(value) || !isPositiveInteger(value.line)) {
    return null;
  }
  if (value.column !== undefined && value.column !== null && !isCount(value.column)) {
    return null;
  }
  return value.column === undefined || value.column === null
    ? { line: value.line }
    : { line: value.line, column: value.column };
}

function spanIsReversed(start: ExecutionCoveragePosition, end: ExecutionCoveragePosition): boolean {
  if (end.line !== start.line) {
    return end.line < start.line;
  }
  return start.column !== undefined && end.column !== undefined && end.column < start.column;
}

function isRelativePosixPath(path: string): boolean {
  if (path.length === 0 || path.startsWith("/") || path.includes("\\") || /^[A-Za-z]:/.test(path)) {
    return false;
  }
  return path.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
