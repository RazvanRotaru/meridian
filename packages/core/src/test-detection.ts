/**
 * Test-code detection: ONE shared heuristic for "does this path belong to test code?".
 *
 * The verdict rides the schema's existing open `tags` vocabulary (`"test"`), so the contract
 * is unchanged (ADR 0001 untouched). The CLI pipeline tags nodes after extraction —
 * extractors stay pure — and the renderer falls back to the same path heuristic for
 * artifacts generated before tagging existed.
 */

import type { GraphNode } from "./types";

export const TEST_TAG = "test";

/** Directory segments that mark everything beneath them as test code. */
const TEST_DIR_SEGMENTS = new Set([
  "__tests__",
  "__test__",
  "__mocks__",
  "__mock__",
  "test",
  "tests",
  "e2e",
  "spec",
  "specs",
  "testing",
]);

/** Filename shapes: `.test.` / `.spec.` infixes (JS/TS), `test_` / `_test` (Python/Go), conftest. */
const TEST_FILE_PATTERNS = [
  /\.(test|spec)\.[a-z0-9]+$/i,
  /(^|\/)test_[^/]+\.py$/,
  /_test\.(py|go)$/,
  /(^|\/)conftest\.py$/,
];

/**
 * Compound test-support DIRECTORY/package names the exact-segment set can't catch: a hyphen-delimited
 * `e2e`/`test(s)`/`testbench`/`testkit` token — e.g. `autopilot-delegate-e2e-testbench`, `web-tests`.
 * Token-scoped (bounded by `^`/`-`/`$`) so a word that merely CONTAINS the letters, like `latest`,
 * never matches.
 */
const TEST_DIR_PATTERN = /(^|-)(e2e|tests?|testbench|testkit)(-|$)/i;

export function isTestPath(file: string): boolean {
  const normalized = file.replace(/\\/g, "/");
  if (TEST_FILE_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return true;
  }
  // Only parent segments count as directories; the last segment is the file itself. Match
  // case-insensitively so a `QA/E2E/…` or `Tests/…` tree is caught the same as its lower-cased form.
  return normalized
    .split("/")
    .slice(0, -1)
    .some((segment) => TEST_DIR_SEGMENTS.has(segment.toLowerCase()) || TEST_DIR_PATTERN.test(segment));
}

export function isTestNode(node: GraphNode): boolean {
  return (node.tags?.includes(TEST_TAG) ?? false) || isTestPath(node.location.file);
}

/** Return nodes with test-code nodes tagged `"test"`; untouched nodes pass through by reference. */
export function tagTestNodes(nodes: GraphNode[]): GraphNode[] {
  return nodes.map((node) => {
    if (!isTestPath(node.location.file) || node.tags?.includes(TEST_TAG)) {
      return node;
    }
    return { ...node, tags: [...(node.tags ?? []), TEST_TAG] };
  });
}

/**
 * The full set of test node ids, closed over containment in both directions: descendants of a
 * test node are test code, and a container whose children are ALL test code (e.g. a
 * `__tests__` package, whose own location is a directory path) is test code itself.
 */
export function collectTestIds(nodes: GraphNode[]): Set<string> {
  const testIds = new Set(nodes.filter(isTestNode).map((node) => node.id));
  propagateToDescendants(nodes, testIds);
  absorbAllTestContainers(nodes, testIds);
  return testIds;
}

function propagateToDescendants(nodes: GraphNode[], testIds: Set<string>): void {
  const parentOf = new Map(nodes.map((node) => [node.id, node.parentId ?? null]));
  for (const node of nodes) {
    if (!testIds.has(node.id) && hasTestAncestor(node.id, parentOf, testIds)) {
      testIds.add(node.id);
    }
  }
}

function hasTestAncestor(
  nodeId: string,
  parentOf: ReadonlyMap<string, string | null>,
  testIds: ReadonlySet<string>,
): boolean {
  const seen = new Set<string>();
  let current = parentOf.get(nodeId) ?? null;
  // A parentId cycle is tolerated by the lenient viewer, so guard against spinning forever.
  while (current && !seen.has(current)) {
    if (testIds.has(current)) {
      return true;
    }
    seen.add(current);
    current = parentOf.get(current) ?? null;
  }
  return false;
}

function absorbAllTestContainers(nodes: GraphNode[], testIds: Set<string>): void {
  const childrenOf = new Map<string, GraphNode[]>();
  for (const node of nodes) {
    if (node.parentId) {
      const siblings = childrenOf.get(node.parentId) ?? [];
      siblings.push(node);
      childrenOf.set(node.parentId, siblings);
    }
  }
  // Fixpoint (bounded by tree depth) so absorption is independent of the nodes-array order.
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of nodes) {
      const children = childrenOf.get(node.id);
      if (
        !testIds.has(node.id) &&
        children &&
        children.length > 0 &&
        children.every((child) => testIds.has(child.id))
      ) {
        testIds.add(node.id);
        changed = true;
      }
    }
  }
}
