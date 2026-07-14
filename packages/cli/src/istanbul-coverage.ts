/**
 * Istanbul coverage-map JSON -> Meridian's provider-neutral execution coverage extension.
 *
 * This importer never runs or instruments tests. It accepts the `coverage-final.json` shape
 * emitted by Vitest, Jest, nyc, c8 (after Istanbul conversion), and other compatible reporters;
 * validates the relevant coverage-map structure; and joins files to graph source paths without
 * inventing evidence for files or counters absent from the report.
 */

import {
  TEST_EXECUTION_COVERAGE_EXTENSION,
  TEST_EXECUTION_COVERAGE_VERSION,
  type ExecutionCoverageSpan,
  type GraphArtifact,
  type JsonValue,
  type TestExecutionCoverage,
  type TestExecutionCoverageBranch,
  type TestExecutionCoverageFile,
  type TestExecutionCoverageFunction,
} from "@meridian/core";
import { CliError, EXIT } from "./errors";

interface RawFileCoverage {
  path: string;
  functions: TestExecutionCoverageFunction[];
  branches: TestExecutionCoverageBranch[];
}

interface ParsedPath {
  normalized: string;
  absolute: boolean;
  windows: boolean;
  drive: string | null;
  segments: string[];
}

/** Strictly parse and normalize Istanbul CoverageMapData against the files present in a graph. */
export function importIstanbulCoverage(
  candidate: unknown,
  artifact: GraphArtifact,
  extractionRoot: string,
): TestExecutionCoverage {
  const entries = parseCoverageMap(candidate);
  const graphFiles = graphSourceFiles(artifact);
  const root = parsePath(extractionRoot, "extraction root", true);
  if (!root.absolute) {
    fail("extraction root must be absolute");
  }

  const matched: Array<[string, TestExecutionCoverageFile]> = [];
  const claimed = new Map<string, string>();
  for (const [mapKey, file] of entries) {
    const keyMatch = matchCoveragePath(mapKey, root, graphFiles);
    const pathMatch = matchCoveragePath(file.path, root, graphFiles);
    if (keyMatch && pathMatch && keyMatch !== pathMatch) {
      fail(`coverage entry '${mapKey}' has path '${file.path}' that maps to a different graph file`);
    }
    const graphPath = pathMatch ?? keyMatch;
    if (!graphPath) {
      continue;
    }
    const previous = claimed.get(graphPath);
    if (previous !== undefined) {
      fail(`coverage entries '${previous}' and '${mapKey}' both map to graph file '${graphPath}'`);
    }
    claimed.set(graphPath, mapKey);
    matched.push([graphPath, { functions: file.functions, branches: file.branches }]);
  }
  matched.sort(([a], [b]) => compareString(a, b));

  return {
    version: TEST_EXECUTION_COVERAGE_VERSION,
    aggregate: true,
    producer: { inputFormat: "istanbul-coverage-map" },
    files: Object.fromEntries(matched),
  };
}

/** Return a copy with normalized runtime evidence attached; the caller revalidates the artifact. */
export function attachIstanbulCoverage(
  artifact: GraphArtifact,
  candidate: unknown,
  extractionRoot: string,
): GraphArtifact {
  const coverage = importIstanbulCoverage(candidate, artifact, extractionRoot);
  return {
    ...artifact,
    extensions: {
      ...artifact.extensions,
      [TEST_EXECUTION_COVERAGE_EXTENSION]: coverage as unknown as JsonValue,
    },
  };
}

function parseCoverageMap(candidate: unknown): Array<[string, RawFileCoverage]> {
  if (!isRecord(candidate)) {
    fail("top level must be an object keyed by covered file path");
  }
  return Object.entries(candidate).map(([key, value]) => {
    if (key.length === 0) {
      fail("coverage map contains an empty file key");
    }
    return [key, parseFileCoverage(value, key)];
  });
}

function parseFileCoverage(value: unknown, key: string): RawFileCoverage {
  const at = `coverage['${key}']`;
  if (!isRecord(value)) {
    fail(`${at} must be an object`);
  }
  if (typeof value.path !== "string" || value.path.length === 0) {
    fail(`${at}.path must be a non-empty string`);
  }
  const statementMap = requireRecord(value.statementMap, `${at}.statementMap`);
  const fnMap = requireRecord(value.fnMap, `${at}.fnMap`);
  const branchMap = requireRecord(value.branchMap, `${at}.branchMap`);
  const statementHits = requireRecord(value.s, `${at}.s`);
  const functionHits = requireRecord(value.f, `${at}.f`);
  const branchHits = requireRecord(value.b, `${at}.b`);

  validateStatementMaps(statementMap, statementHits, at);
  const functions = parseFunctions(fnMap, functionHits, at);
  const branches = parseBranches(branchMap, branchHits, at);
  return { path: value.path, functions, branches };
}

function validateStatementMaps(
  statementMap: Record<string, unknown>,
  statementHits: Record<string, unknown>,
  at: string,
): void {
  requireSameIds(statementMap, statementHits, `${at}.statementMap`, `${at}.s`);
  for (const id of sortedIds(statementMap, `${at}.statementMap`)) {
    if (!isRecord(statementMap[id])) {
      fail(`${at}.statementMap['${id}'] must be an object`);
    }
    readCount(statementHits[id], `${at}.s['${id}']`);
  }
}

function parseFunctions(
  fnMap: Record<string, unknown>,
  functionHits: Record<string, unknown>,
  at: string,
): TestExecutionCoverageFunction[] {
  requireSameIds(fnMap, functionHits, `${at}.fnMap`, `${at}.f`);
  return sortedIds(fnMap, `${at}.fnMap`).map((id) => {
    const entry = fnMap[id];
    if (!isRecord(entry) || typeof entry.name !== "string") {
      fail(`${at}.fnMap['${id}'] must contain a string name`);
    }
    return {
      name: entry.name,
      hits: readCount(functionHits[id], `${at}.f['${id}']`),
      decl: readSpan(entry.decl, `${at}.fnMap['${id}'].decl`),
      location: readSpan(entry.loc, `${at}.fnMap['${id}'].loc`),
    };
  });
}

function parseBranches(
  branchMap: Record<string, unknown>,
  branchHits: Record<string, unknown>,
  at: string,
): TestExecutionCoverageBranch[] {
  requireSameIds(branchMap, branchHits, `${at}.branchMap`, `${at}.b`);
  return sortedIds(branchMap, `${at}.branchMap`).map((id) => {
    const entry = branchMap[id];
    if (!isRecord(entry) || typeof entry.type !== "string" || entry.type.length === 0) {
      fail(`${at}.branchMap['${id}'] must contain a non-empty string type`);
    }
    if (!Array.isArray(entry.locations)) {
      fail(`${at}.branchMap['${id}'].locations must be an array`);
    }
    const hits = branchHits[id];
    if (!Array.isArray(hits) || hits.length !== entry.locations.length) {
      fail(`${at}.b['${id}'] must be an array matching branchMap['${id}'].locations`);
    }
    return {
      type: entry.type,
      location: readSpan(entry.loc, `${at}.branchMap['${id}'].loc`),
      paths: entry.locations.map((location, index) => {
        const parsedLocation = readOptionalSpan(
          location,
          `${at}.branchMap['${id}'].locations[${index}]`,
        );
        return {
          index,
          hits: readCount(hits[index], `${at}.b['${id}'][${index}]`),
          ...(parsedLocation ? { location: parsedLocation } : {}),
        };
      }),
    };
  });
}

function requireSameIds(
  definitions: Record<string, unknown>,
  hits: Record<string, unknown>,
  definitionsAt: string,
  hitsAt: string,
): void {
  const definitionIds = sortedIds(definitions, definitionsAt);
  const hitIds = sortedIds(hits, hitsAt);
  if (definitionIds.length !== hitIds.length || definitionIds.some((id, index) => id !== hitIds[index])) {
    fail(`${definitionsAt} and ${hitsAt} must contain the same numeric ids`);
  }
}

function sortedIds(record: Record<string, unknown>, at: string): string[] {
  const ids = Object.keys(record);
  for (const id of ids) {
    if (!/^(0|[1-9][0-9]*)$/.test(id) || !Number.isSafeInteger(Number(id))) {
      fail(`${at} contains invalid id '${id}'`);
    }
  }
  return ids.sort((a, b) => Number(a) - Number(b));
}

function readSpan(value: unknown, at: string): ExecutionCoverageSpan {
  if (!isRecord(value)) {
    fail(`${at} must be a source span`);
  }
  const start = readPosition(value.start, `${at}.start`);
  const end = readPosition(value.end, `${at}.end`);
  if (
    end.line < start.line
    || (end.line === start.line
      && start.column !== undefined
      && end.column !== undefined
      && end.column < start.column)
  ) {
    fail(`${at} ends before it starts`);
  }
  return { start, end };
}

function readOptionalSpan(value: unknown, at: string): ExecutionCoverageSpan | undefined {
  if (isEmptyIstanbulSpan(value)) {
    return undefined;
  }
  return readSpan(value, at);
}

function isEmptyIstanbulSpan(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.start) || !isRecord(value.end)) {
    return false;
  }
  return value.start.line == null && value.end.line == null
    && value.start.column == null && value.end.column == null;
}

function readPosition(value: unknown, at: string): { line: number; column?: number } {
  if (!isRecord(value) || !isPositiveInteger(value.line)) {
    fail(`${at} must contain a 1-based line`);
  }
  if (value.column !== undefined && value.column !== null && !isCount(value.column)) {
    fail(`${at}.column must be a non-negative safe integer, null, or absent`);
  }
  return value.column === undefined || value.column === null
    ? { line: value.line }
    : { line: value.line, column: value.column };
}

function readCount(value: unknown, at: string): number {
  if (!isCount(value)) {
    fail(`${at} must be a non-negative safe integer`);
  }
  return value;
}

function graphSourceFiles(artifact: GraphArtifact): string[] {
  const files = new Set<string>();
  for (const node of artifact.nodes) {
    // Boundary containers deliberately have no source coordinate. They are valid graph structure,
    // but cannot participate in an Istanbul file join and must not make coverage attachment fail.
    if (node.location.file.length === 0) {
      continue;
    }
    const path = parsePath(node.location.file, `node '${node.id}' location`, false);
    if (!path.absolute && path.segments.length > 0 && !path.segments.includes("..")) {
      files.add(path.segments.join("/"));
    }
  }
  return [...files].sort(compareString);
}

function matchCoveragePath(raw: string, root: ParsedPath, graphFiles: readonly string[]): string | null {
  const path = parsePath(raw, `coverage path '${raw}'`, false);

  // Exact extraction-root coordinates are authoritative and avoid false ambiguity with a shorter
  // graph suffix (for example `src/a.ts` versus an unrelated graph file named just `a.ts`).
  const relativeToRoot = path.absolute ? relativeInside(path, root) : safeRelative(path);
  if (relativeToRoot && graphFiles.includes(relativeToRoot)) {
    return relativeToRoot;
  }

  // Reports are sometimes produced in a container or another checkout. A unique full-segment
  // suffix can still join them; multiple candidates are refused instead of guessing the longest.
  const comparableRaw = comparable(path.normalized, path.windows);
  const suffixMatches = graphFiles.filter((file) => {
    const comparableFile = comparable(file, path.windows);
    return comparableRaw === comparableFile || comparableRaw.endsWith(`/${comparableFile}`);
  });
  if (suffixMatches.length > 1) {
    fail(`coverage path '${raw}' ambiguously matches graph files: ${suffixMatches.join(", ")}`);
  }
  return suffixMatches[0] ?? null;
}

function relativeInside(path: ParsedPath, root: ParsedPath): string | null {
  if (!path.absolute || !root.absolute || path.windows !== root.windows) {
    return null;
  }
  if (path.windows && comparable(path.drive ?? "", true) !== comparable(root.drive ?? "", true)) {
    return null;
  }
  if (path.segments.length <= root.segments.length) {
    return null;
  }
  for (let index = 0; index < root.segments.length; index++) {
    if (comparable(path.segments[index]!, path.windows) !== comparable(root.segments[index]!, path.windows)) {
      return null;
    }
  }
  return path.segments.slice(root.segments.length).join("/");
}

function safeRelative(path: ParsedPath): string | null {
  if (path.absolute || path.segments.length === 0 || path.segments.includes("..")) {
    return null;
  }
  return path.segments.join("/");
}

function parsePath(raw: string, at: string, allowParentSegments: boolean): ParsedPath {
  if (typeof raw !== "string" || raw.length === 0 || raw.includes("\0")) {
    fail(`${at} must be a non-empty path`);
  }
  const slashed = raw.replace(/\\/g, "/");
  const driveMatch = /^([A-Za-z]:)(?:\/|$)/.exec(slashed);
  const windows = driveMatch !== null;
  const drive = driveMatch?.[1] ?? null;
  const absolute = windows || slashed.startsWith("/");
  const withoutRoot = windows ? slashed.slice(drive!.length).replace(/^\/+/, "") : slashed.replace(/^\/+/, "");
  const segments: string[] = [];
  for (const segment of withoutRoot.split("/")) {
    if (segment.length === 0 || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (segments.length > 0 && segments[segments.length - 1] !== "..") {
        segments.pop();
      } else if (!absolute) {
        segments.push(segment);
      }
      continue;
    }
    segments.push(segment);
  }
  if (!allowParentSegments && !absolute && segments.includes("..")) {
    fail(`${at} escapes its relative root`);
  }
  const prefix = windows ? `${drive}/` : absolute ? "/" : "";
  return { normalized: `${prefix}${segments.join("/")}`, absolute, windows, drive, segments };
}

function comparable(value: string, windows: boolean): string {
  return windows ? value.toLowerCase() : value;
}

function requireRecord(value: unknown, at: string): Record<string, unknown> {
  if (!isRecord(value)) {
    fail(`${at} must be an object`);
  }
  return value;
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

function compareString(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function fail(message: string): never {
  throw new CliError(EXIT.validation, "test coverage failed validation", [`  - ${message}`]);
}
