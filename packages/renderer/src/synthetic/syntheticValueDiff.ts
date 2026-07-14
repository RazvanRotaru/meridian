import type { JsonValue } from "@meridian/core";

export type SyntheticDiffDepth = "shallow" | "deep";

export type SyntheticValueChange =
  | { kind: "added"; path: string; after: JsonValue }
  | { kind: "removed"; path: string; before: JsonValue }
  | { kind: "changed"; path: string; before: JsonValue; after: JsonValue };

/**
 * Compare JSON structure at the first level or recursively. Added/removed entries retain the full
 * subtree value; changed entries recurse until a leaf/type boundary in deep mode. Object keys are
 * sorted so producer property order never changes the result.
 */
export function diffSyntheticValues(
  before: JsonValue,
  after: JsonValue,
  depth: SyntheticDiffDepth = "deep",
): SyntheticValueChange[] {
  const changes: SyntheticValueChange[] = [];
  walkDiff(before, after, "$", 0, depth === "shallow" ? 1 : Number.POSITIVE_INFINITY, changes);
  return changes;
}

function walkDiff(
  before: JsonValue,
  after: JsonValue,
  path: string,
  currentDepth: number,
  maxDepth: number,
  changes: SyntheticValueChange[],
): void {
  if (sameJsonValue(before, after)) return;
  if (currentDepth >= maxDepth) {
    changes.push({ kind: "changed", path, before, after });
    return;
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    const length = Math.max(before.length, after.length);
    for (let index = 0; index < length; index += 1) {
      const childPath = `${path}[${index}]`;
      if (index >= before.length) {
        changes.push({ kind: "added", path: childPath, after: after[index]! });
      } else if (index >= after.length) {
        changes.push({ kind: "removed", path: childPath, before: before[index]! });
      } else {
        walkDiff(before[index]!, after[index]!, childPath, currentDepth + 1, maxDepth, changes);
      }
    }
    return;
  }
  if (isJsonRecord(before) && isJsonRecord(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    for (const key of keys) {
      const childPath = propertyPath(path, key);
      const hadBefore = Object.prototype.hasOwnProperty.call(before, key);
      const hasAfter = Object.prototype.hasOwnProperty.call(after, key);
      if (!hadBefore) {
        changes.push({ kind: "added", path: childPath, after: after[key]! });
      } else if (!hasAfter) {
        changes.push({ kind: "removed", path: childPath, before: before[key]! });
      } else {
        walkDiff(before[key]!, after[key]!, childPath, currentDepth + 1, maxDepth, changes);
      }
    }
    return;
  }
  changes.push({ kind: "changed", path, before, after });
}

function sameJsonValue(left: JsonValue, right: JsonValue): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => sameJsonValue(value, right[index]!));
  }
  if (isJsonRecord(left) && isJsonRecord(right)) {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return leftKeys.length === rightKeys.length
      && leftKeys.every((key, index) => key === rightKeys[index] && sameJsonValue(left[key]!, right[key]!));
  }
  return false;
}

function isJsonRecord(value: JsonValue): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function propertyPath(parent: string, key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)
    ? `${parent}.${key}`
    : `${parent}[${JSON.stringify(key)}]`;
}
