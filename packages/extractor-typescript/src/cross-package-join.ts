/**
 * The stitch half of per-package extraction. Each unit was analyzed in isolation, so a
 * cross-package reference could only be recorded as a pending (specifier, exportedName) pair.
 * This pass resolves those pairs against the other units' export summaries — pure name
 * tables, no ts-morph — following star/named re-export chains with a cycle guard, and
 * rewrites hits into ordinary resolved raw edges. Misses stay honestly unresolved (ADR 0001).
 */

import type { RawEdge } from "./edge-pass";
import type { PendingRef } from "./edge-resolve";
import { matchPackageSpecifier } from "./workspace-units";

export interface PendingReexport {
  /** Root-relative path of the file carrying the re-export declaration. */
  file: string;
  /** The cross-package specifier being re-exported from. */
  specifier: string;
  /** Workspace-relative target when the specifier is a tsconfig alias rather than a package name. */
  targetFile?: string;
  /** Renamed re-exports (`export { local as exported } from`); null for `export *`. */
  names: { exported: string; local: string }[] | null;
}

export interface UnitSummary {
  dir: string;
  name: string | null;
  entryFile: string | null;
  sourceDir: string;
  /** file -> exported name -> node id, with in-package re-export chains already flattened. */
  exportsByFile: Map<string, Map<string, string>>;
  /** file -> its module node id; doubles as the unit's file universe for subpath probing. */
  moduleIdByRelPath: Map<string, string>;
  pendingReexports: PendingReexport[];
}

export function joinCrossPackageEdges(rawEdges: RawEdge[], summaries: UnitSummary[]): RawEdge[] {
  const resolver = createResolver(summaries);
  return rawEdges.map((edge) => rewrite(edge, resolver));
}

type Resolver = (pending: PendingRef) => string | null;

function rewrite(edge: RawEdge, resolve: Resolver): RawEdge {
  const pending = edge.resolution.pending;
  if (!pending) {
    return edge;
  }
  const target = resolve(pending);
  if (target === null) {
    return edge;
  }
  return {
    ...edge,
    resolution: { resolution: "resolved", resolvedTarget: target, externalModulePath: null, externalQualname: null, threw: false },
  };
}

interface FileRef {
  summary: UnitSummary;
  file: string;
}

function createResolver(summaries: UnitSummary[]): Resolver {
  const byName = new Map(summaries.filter((summary) => summary.name !== null).map((summary) => [summary.name, summary]));
  const fileByRelPath = new Map<string, FileRef>();
  for (const summary of summaries) {
    for (const file of summary.moduleIdByRelPath.keys()) {
      fileByRelPath.set(file, { summary, file });
    }
  }
  const exportsOf = createExportTableResolver(byName, fileByRelPath);
  return (pending) => {
    // A relative import records the target FILE directly; a bare specifier resolves by package.
    const ref =
      pending.targetFile !== undefined ? fileForPath(fileByRelPath, pending.targetFile) : fileFor(byName, pending.specifier);
    if (ref === null) {
      return null;
    }
    if (pending.exportedName === null) {
      return ref.summary.moduleIdByRelPath.get(ref.file) ?? null;
    }
    return exportsOf(ref).get(pending.exportedName) ?? null;
  };
}

/** Resolve a specifier to the file that declares its exports: the entry for a bare name, an
 * extension-probed path under sourceDir for a subpath. Lookup only — no filesystem. */
function fileFor(byName: Map<string | null, UnitSummary>, specifier: string): FileRef | null {
  const match = matchName(byName, specifier);
  if (match === null) {
    return null;
  }
  const { summary, subpath } = match;
  if (subpath === null) {
    return summary.entryFile === null ? null : { summary, file: summary.entryFile };
  }
  return probeExtensions(`${summary.sourceDir}/${stripJsExtension(subpath)}`, (candidate) =>
    summary.moduleIdByRelPath.has(candidate) ? { summary, file: candidate } : null,
  );
}

/** Resolve a relative import's workspace-relative base path to its file across all units. */
function fileForPath(fileByRelPath: Map<string, FileRef>, base: string): FileRef | null {
  return probeExtensions(stripJsExtension(base), (candidate) => fileByRelPath.get(candidate) ?? null);
}

/** Try the extension-less base, then the source extensions TS resolution would (`.ts`/`.tsx`/index). */
function probeExtensions(base: string, lookup: (candidate: string) => FileRef | null): FileRef | null {
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
    const ref = lookup(candidate);
    if (ref !== null) {
      return ref;
    }
  }
  return null;
}

// NodeNext/ESM imports carry the OUTPUT extension (`./util.js`) even though the source is
// `util.ts`; strip it so the probe below lands on the real source file.
function stripJsExtension(subpath: string): string {
  return subpath.replace(/\.(js|jsx|mjs|cjs)$/, "");
}

function matchName(
  byName: Map<string | null, UnitSummary>,
  specifier: string,
): { summary: UnitSummary; subpath: string | null } | null {
  for (const [name, summary] of byName) {
    const match = name === null ? null : matchPackageSpecifier(name, specifier);
    if (match !== null) {
      return { summary, subpath: match.subpath };
    }
  }
  return null;
}

interface ResolvedTable {
  table: Map<string, string>;
  /** False if assembly consumed a dependency that was still on the stack (a re-export cycle),
   * so the table may be missing names and MUST NOT be memoized. */
  complete: boolean;
}

/**
 * A file's effective export table: its own exports overlaid on whatever its cross-package
 * re-exports pull in (own names shadow star re-exports, matching ES module semantics).
 * Memoized per file — but only COMPLETE tables: a table assembled while one of its re-export
 * dependencies was mid-recursion (a cycle) is returned for this query yet left uncached, so a
 * later top-level query recomputes it fully instead of inheriting a name-losing snapshot.
 */
function createExportTableResolver(
  byName: Map<string | null, UnitSummary>,
  fileByRelPath: Map<string, FileRef>,
): (ref: FileRef) => Map<string, string> {
  const memo = new Map<string, Map<string, string>>();
  const onStack = new Set<string>();
  const resolve = (ref: FileRef): ResolvedTable => {
    const key = `${ref.summary.dir}|${ref.file}`;
    const cached = memo.get(key);
    if (cached) {
      return { table: cached, complete: true };
    }
    if (onStack.has(key)) {
      return { table: new Map(), complete: false };
    }
    onStack.add(key);
    const resolved = assembleExports(ref, byName, fileByRelPath, resolve);
    onStack.delete(key);
    if (resolved.complete) {
      memo.set(key, resolved.table);
    }
    return resolved;
  };
  return (ref) => resolve(ref).table;
}

function assembleExports(
  ref: FileRef,
  byName: Map<string | null, UnitSummary>,
  fileByRelPath: Map<string, FileRef>,
  resolve: (ref: FileRef) => ResolvedTable,
): ResolvedTable {
  const table = new Map<string, string>();
  let complete = true;
  for (const reexport of ref.summary.pendingReexports) {
    if (reexport.file !== ref.file) {
      continue;
    }
    const target = reexport.targetFile === undefined
      ? fileFor(byName, reexport.specifier)
      : fileForPath(fileByRelPath, reexport.targetFile);
    if (target === null) {
      continue;
    }
    const resolved = resolve(target);
    complete &&= resolved.complete;
    for (const [exported, local] of reexportedNames(reexport, resolved.table)) {
      const id = resolved.table.get(local);
      if (id !== undefined) {
        table.set(exported, id);
      }
    }
  }
  for (const [name, id] of ref.summary.exportsByFile.get(ref.file) ?? []) {
    table.set(name, id); // own exports shadow re-exported ones
  }
  return { table, complete };
}

function reexportedNames(reexport: PendingReexport, targetExports: Map<string, string>): [string, string][] {
  if (reexport.names !== null) {
    return reexport.names.map((name) => [name.exported, name.local]);
  }
  // `export *` does not re-export the default, per the spec.
  return [...targetExports.keys()].filter((name) => name !== "default").map((name) => [name, name]);
}
