import { isAbsolute, resolve } from "node:path";
import type { CrossPackageResolver } from "../edge-resolve";
import {
  isUnderRoot,
  relativeToRoot,
  toPosix,
} from "../paths";
import {
  canonicalJson,
  compareCanonicalStrings,
} from "./canonical-json";

export type WorkspaceResolverTraceEntry =
  | {
      kind: "matches";
      specifier: string;
      result: boolean;
    }
  | {
      kind: "resolve-relative";
      fromFile: string;
      specifier: string;
      result: string | null;
    }
  | {
      kind: "resolve-file";
      fromFile: string;
      targetFile: string;
      result: string | null;
    };

export interface TracedCrossPackageResolver {
  resolver: CrossPackageResolver;
  snapshot(): WorkspaceResolverTraceEntry[];
  /** A resolver exception may be swallowed by an extraction pass, so such a shard is never reusable. */
  isReusable(): boolean;
}

/**
 * Record the exact pure workspace-resolver observations made by a unit extraction. The trace is
 * plain, portable data and is replayed before a shard from a different workspace topology can hit.
 */
export function traceCrossPackageResolver(
  delegate: CrossPackageResolver,
  root: string,
): TracedCrossPackageResolver {
  const entries = new Map<string, WorkspaceResolverTraceEntry>();
  const observations = new Map<string, string>();
  let reusable = true;
  const record = (entry: WorkspaceResolverTraceEntry): void => {
    const canonical = canonicalJson(entry);
    const query = traceQueryKey(entry);
    const existing = observations.get(query);
    if (existing !== undefined && existing !== canonical) {
      // The replay proof assumes a pure resolver. Preserve the evidence for diagnostics, but never
      // admit a shard produced by an inconsistent implementation.
      reusable = false;
    }
    observations.set(query, canonical);
    if (
      ("fromFile" in entry && entry.fromFile.startsWith("external:"))
      || ("targetFile" in entry && entry.targetFile.startsWith("external:"))
    ) {
      // Absolute paths outside the exact checkout do not have portable immutable provenance here.
      reusable = false;
    }
    entries.set(canonical, entry);
  };
  const observe = <T>(
    operation: () => T,
    entry: (result: T) => WorkspaceResolverTraceEntry,
  ): T => {
    try {
      const result = operation();
      record(entry(result));
      return result;
    } catch (error) {
      // resolveTarget deliberately converts resolution exceptions to diagnostics. Remember that
      // hidden control-flow input even when extraction continues, and deny admission of the shard.
      reusable = false;
      throw error;
    }
  };
  return {
    resolver: {
      matches(specifier) {
        return observe(
          () => delegate.matches(specifier),
          (result) => ({ kind: "matches", specifier, result }),
        );
      },
      resolveRelative(fromFileAbsPath, specifier) {
        return observe(
          () => delegate.resolveRelative(fromFileAbsPath, specifier),
          (result) => ({
            kind: "resolve-relative",
            fromFile: portablePath(root, fromFileAbsPath),
            specifier,
            result,
          }),
        );
      },
      resolveFile(fromFileAbsPath, targetFileAbsPath) {
        return observe(
          () => delegate.resolveFile(fromFileAbsPath, targetFileAbsPath),
          (result) => ({
            kind: "resolve-file",
            fromFile: portablePath(root, fromFileAbsPath),
            targetFile: portablePath(root, targetFileAbsPath),
            result,
          }),
        );
      },
    },
    snapshot: () => [...entries.values()].sort(compareTraceEntries),
    isReusable: () => reusable,
  };
}

/** Replay every recorded observation against the current workspace resolver. */
export function workspaceResolverTraceMatches(
  trace: readonly WorkspaceResolverTraceEntry[],
  resolver: CrossPackageResolver,
  root: string,
): boolean {
  try {
    return trace.every((entry) => {
      switch (entry.kind) {
        case "matches":
          return resolver.matches(entry.specifier) === entry.result;
        case "resolve-relative":
          return resolver.resolveRelative(
            absolutePath(root, entry.fromFile),
            entry.specifier,
          ) === entry.result;
        case "resolve-file":
          return resolver.resolveFile(
            absolutePath(root, entry.fromFile),
            absolutePath(root, entry.targetFile),
          ) === entry.result;
      }
    });
  } catch {
    return false;
  }
}

/** Validate the canonical immutable representation before replaying cache-controlled data. */
export function isCanonicalWorkspaceResolverTrace(
  value: unknown,
): value is WorkspaceResolverTraceEntry[] {
  if (!Array.isArray(value)) return false;
  const queries = new Set<string>();
  let previous: string | null = null;
  for (const entry of value) {
    if (!isTraceEntry(entry)) return false;
    const canonical = canonicalJson(entry);
    if (previous !== null && compareCanonicalStrings(previous, canonical) >= 0) {
      return false;
    }
    previous = canonical;
    const query = traceQueryKey(entry);
    if (queries.has(query)) return false;
    queries.add(query);
  }
  return true;
}

function portablePath(root: string, pathInput: string): string {
  const path = toPosix(pathInput);
  const relative = relativeToRoot(root, path);
  return isUnderRoot(relative) ? `repo:${relative}` : `external:${path}`;
}

function absolutePath(root: string, address: string): string {
  if (address.startsWith("repo:")) {
    const relative = address.slice("repo:".length);
    if (!isUnderRoot(relative)) {
      throw new Error(`invalid repository resolver-trace address: ${address}`);
    }
    return toPosix(resolve(root, ...relative.split("/")));
  }
  if (address.startsWith("external:")) {
    const path = address.slice("external:".length);
    if (!isAbsolute(path)) {
      throw new Error(`invalid external resolver-trace address: ${address}`);
    }
    return path;
  }
  throw new Error(`invalid resolver-trace address: ${address}`);
}

function compareTraceEntries(
  left: WorkspaceResolverTraceEntry,
  right: WorkspaceResolverTraceEntry,
): number {
  return compareCanonicalStrings(canonicalJson(left), canonicalJson(right));
}

function traceQueryKey(entry: WorkspaceResolverTraceEntry): string {
  switch (entry.kind) {
    case "matches":
      return canonicalJson({ kind: entry.kind, specifier: entry.specifier });
    case "resolve-relative":
      return canonicalJson({
        kind: entry.kind,
        fromFile: entry.fromFile,
        specifier: entry.specifier,
      });
    case "resolve-file":
      return canonicalJson({
        kind: entry.kind,
        fromFile: entry.fromFile,
        targetFile: entry.targetFile,
      });
  }
}

function isTraceEntry(value: unknown): value is WorkspaceResolverTraceEntry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  switch (entry.kind) {
    case "matches":
      return hasExactKeys(entry, ["kind", "result", "specifier"])
        && typeof entry.specifier === "string"
        && typeof entry.result === "boolean";
    case "resolve-relative":
      return hasExactKeys(entry, ["fromFile", "kind", "result", "specifier"])
        && isPortableAddress(entry.fromFile)
        && typeof entry.specifier === "string"
        && isWorkspaceResult(entry.result);
    case "resolve-file":
      return hasExactKeys(entry, ["fromFile", "kind", "result", "targetFile"])
        && isPortableAddress(entry.fromFile)
        && isPortableAddress(entry.targetFile)
        && isWorkspaceResult(entry.result);
    default:
      return false;
  }
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort(compareCanonicalStrings);
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function isPortableAddress(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.startsWith("repo:")) {
    const relative = value.slice("repo:".length);
    return relative.length > 0 && isUnderRoot(relative) && !relative.includes("\\");
  }
  return value.startsWith("external:") && value.length > "external:".length;
}

function isWorkspaceResult(value: unknown): value is string | null {
  return value === null
    || (typeof value === "string" && value.length > 0 && isUnderRoot(value) && !value.includes("\\"));
}
