/** Pure, bounded Python allocator-context closure for exact incremental graph extraction. */

import { compareBinaryStrings } from "./binary-order";
import { parseNodeId } from "./ids";
import type { NodeId } from "./types";

export interface PythonPartialIdentityFile {
  fileId: NodeId | string;
  path: string;
}

export interface PythonExtractionFileClosure {
  /** Test the exact closure cardinality without materializing its sorted path payload. */
  fits(selectedFiles: readonly string[], maxFiles: number): boolean;
  /**
   * Close one caller-selected slice over the immutable topology captured by this instance.
   * Reusing the prepared closure avoids rescanning the repository for every prospective root.
   */
  close(selectedFiles: readonly string[], maxFiles: number): string[] | null;
}

interface PythonIdentityFact {
  path: string;
  graphPath: string;
  isPackage: boolean;
  hasPackageContext: boolean;
}

/**
 * Close requested Python files over the minimal parsed context that can affect production IDs or
 * package containment. Non-Python paths count against the same caller-owned cap but pass through
 * unchanged. Returns `null` rather than emitting identity-drifting output when closure cannot fit.
 */
export function closePythonExtractionFiles(
  topology: readonly PythonPartialIdentityFile[],
  selectedFiles: readonly string[],
  maxFiles: number,
): string[] | null {
  return preparePythonExtractionFileClosure(topology).close(selectedFiles, maxFiles);
}

/** Prepare the exact allocator-context closure once for repeated bounded slice admission checks. */
export function preparePythonExtractionFileClosure(
  topology: readonly PythonPartialIdentityFile[],
): PythonExtractionFileClosure {
  const facts = topology
    .filter((file) => file.path.endsWith(".py") && file.fileId.startsWith("py:"))
    .map((file) => {
      // `parseNodeId` removes the terminal allocator ordinal. The source index has already run the
      // full production allocator, so `py:foo~1` must still join the `foo` collision group.
      const parsed = parseNodeId(file.fileId as NodeId);
      return {
        path: file.path,
        graphPath: parsed.modulePath,
        isPackage: file.path === "__init__.py" || file.path.endsWith("/__init__.py"),
        hasPackageContext: file.path === "__init__.py"
          || file.path.endsWith("/__init__.py")
          || parsed.modulePath.includes("."),
      };
    }) satisfies PythonIdentityFact[];
  const byPath = new Map(facts.map((fact) => [fact.path, fact]));
  const byGraphPath = new Map<string, PythonIdentityFact[]>();
  const initializers = new Map<string, string>();
  const packagePrefixes = new Set<string>();
  const descendantWitnesses = new Map<string, string>();
  for (const fact of facts) {
    const group = byGraphPath.get(fact.graphPath) ?? [];
    group.push(fact);
    byGraphPath.set(fact.graphPath, group);
    const segments = fact.graphPath.split(".");
    for (let depth = 1; depth < segments.length; depth += 1) {
      const prefix = segments.slice(0, depth).join(".");
      packagePrefixes.add(prefix);
      const witness = descendantWitnesses.get(prefix);
      if (witness === undefined || compareBinaryStrings(fact.path, witness) < 0) {
        descendantWitnesses.set(prefix, fact.path);
      }
    }
    if (fact.isPackage) {
      packagePrefixes.add(fact.graphPath);
      initializers.set(fact.graphPath, fact.path);
    }
  }
  for (const group of byGraphPath.values()) {
    group.sort((left, right) => compareBinaryStrings(left.path, right.path));
  }
  const packagePrefixWitness = facts
    .filter((fact) => fact.hasPackageContext)
    .sort((left, right) => compareBinaryStrings(left.path, right.path))[0];

  // Collision peers always enter the closure together, so model each graph-path group as one
  // weighted dependency vertex. This prevents a large collision group from becoming quadratic.
  const groups = [...byGraphPath.entries()]
    .sort(([left], [right]) => compareBinaryStrings(left, right))
    .map(([graphPath, groupFacts], index) => ({ index, graphPath, facts: groupFacts }));
  const groupByGraphPath = new Map(groups.map((group) => [group.graphPath, group]));
  const dependencies = groups.map(() => new Set<number>());
  const invalidDependencyGroups = new Set<number>();
  for (const group of groups) {
    const groupDependencies = dependencies[group.index]!;
    const segments = group.graphPath.split(".");
    for (let depth = 1; depth < segments.length; depth += 1) {
      const initializer = initializers.get(segments.slice(0, depth).join("."));
      if (initializer === undefined) continue;
      const dependency = byPath.get(initializer);
      const dependencyGroup = dependency === undefined
        ? undefined
        : groupByGraphPath.get(dependency.graphPath);
      if (dependencyGroup === undefined) invalidDependencyGroups.add(group.index);
      else groupDependencies.add(dependencyGroup.index);
    }
    if (group.facts.some((fact) => !fact.isPackage) && packagePrefixes.has(group.graphPath)) {
      const witness = initializers.get(group.graphPath)
        ?? descendantWitnesses.get(group.graphPath);
      const dependency = witness === undefined ? undefined : byPath.get(witness);
      const dependencyGroup = dependency === undefined
        ? undefined
        : groupByGraphPath.get(dependency.graphPath);
      if (dependencyGroup === undefined) invalidDependencyGroups.add(group.index);
      else groupDependencies.add(dependencyGroup.index);
    }
  }
  const witnessGroup = packagePrefixWitness === undefined
    ? undefined
    : groupByGraphPath.get(packagePrefixWitness.graphPath);
  const reachableGroups = new Map<number, readonly number[]>();
  const dependencyClosure = (start: number): readonly number[] | null => {
    const cached = reachableGroups.get(start);
    if (cached !== undefined) return cached;
    const reached = new Set<number>();
    const pending = [start];
    while (pending.length > 0) {
      const index = pending.pop()!;
      if (reached.has(index)) continue;
      const known = reachableGroups.get(index);
      if (known !== undefined) {
        for (const value of known) reached.add(value);
        continue;
      }
      if (invalidDependencyGroups.has(index)) return null;
      reached.add(index);
      for (const dependency of dependencies[index] ?? []) pending.push(dependency);
    }
    const result = [...reached].sort((left, right) => left - right);
    reachableGroups.set(start, result);
    return result;
  };

  const resolve = (
    selectedFiles: readonly string[],
    maxFiles: number,
  ): { nonPython: string[]; groupIds: Set<number> } | null => {
    if (!Number.isSafeInteger(maxFiles) || maxFiles <= 0) return null;
    const nonPython = selectedFiles.filter((path) => !path.endsWith(".py"));
    if (nonPython.length > maxFiles) return null;
    const selectedGroups = new Set<number>();
    let selectedPython = false;
    let selectedHasPackageContext = false;
    for (const path of selectedFiles) {
      if (!path.endsWith(".py")) continue;
      const fact = byPath.get(path);
      const group = fact === undefined ? undefined : groupByGraphPath.get(fact.graphPath);
      if (fact === undefined || group === undefined) return null;
      selectedPython = true;
      selectedHasPackageContext ||= fact.hasPackageContext;
      selectedGroups.add(group.index);
    }
    // Match production ordering: a flat initial slice adds the global package-prefix witness
    // before collision, ancestor, or namespace dependencies can contribute package context.
    if (selectedPython && !selectedHasPackageContext && packagePrefixWitness !== undefined) {
      if (witnessGroup === undefined) return null;
      selectedGroups.add(witnessGroup.index);
    }
    const groupIds = new Set<number>();
    let fileCount = nonPython.length;
    for (const selectedGroup of selectedGroups) {
      const reachable = dependencyClosure(selectedGroup);
      if (reachable === null) return null;
      for (const groupId of reachable) {
        if (groupIds.has(groupId)) continue;
        groupIds.add(groupId);
        fileCount += groups[groupId]!.facts.length;
        if (fileCount > maxFiles) return null;
      }
    }
    return { nonPython, groupIds };
  };

  return {
    fits(selectedFiles, maxFiles) {
      return resolve(selectedFiles, maxFiles) !== null;
    },
    close(selectedFiles, maxFiles) {
      const resolved = resolve(selectedFiles, maxFiles);
      if (resolved === null) return null;
      const python = [...resolved.groupIds]
        .flatMap((groupId) => groups[groupId]!.facts.map((fact) => fact.path));
      return [...new Set([...resolved.nonPython, ...python])].sort(compareBinaryStrings);
    },
  };
}
