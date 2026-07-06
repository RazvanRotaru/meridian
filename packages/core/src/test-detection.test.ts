import { describe, expect, it } from "vitest";
import type { GraphNode } from "./types";
import { TEST_TAG, collectTestIds, isTestPath, tagTestNodes } from "./test-detection";

describe("isTestPath", () => {
  it.each([
    "src/orderService.test.ts",
    "src/orderService.spec.tsx",
    "src/__tests__/orderService.ts",
    "src/__mocks__/repo.ts",
    "tests/helpers.ts",
    "tests/test_order_service.py",
    "orders/validation_test.py",
    "conftest.py",
    "pkg/handler_test.go",
  ])("detects %s as test code", (file) => {
    expect(isTestPath(file)).toBe(true);
  });

  it.each([
    "src/orderService.ts",
    "src/testimonials/banner.ts", // "testimonials" must not match the "test" dir segment
    "src/latest.py",
    "contest.py",
  ])("keeps %s as production code", (file) => {
    expect(isTestPath(file)).toBe(false);
  });
});

function node(id: string, file: string, parentId: string | null = null, tags?: string[]): GraphNode {
  return {
    id,
    kind: "function",
    qualifiedName: id,
    displayName: id,
    parentId,
    location: { file, startLine: 1 },
    ...(tags ? { tags } : {}),
  };
}

describe("tagTestNodes", () => {
  it("tags test-path nodes and leaves production nodes by reference", () => {
    const prod = node("ts:src/a#f", "src/a.ts");
    const tagged = tagTestNodes([prod, node("ts:src/a.test#t", "src/a.test.ts", null, ["async"])]);
    expect(tagged[0]).toBe(prod);
    expect(tagged[1].tags).toEqual(["async", TEST_TAG]);
  });

  it("does not double-tag", () => {
    const [tagged] = tagTestNodes([node("ts:src/a.test#t", "src/a.test.ts", null, [TEST_TAG])]);
    expect(tagged.tags).toEqual([TEST_TAG]);
  });
});

describe("collectTestIds", () => {
  it("closes over descendants and all-test containers", () => {
    const nodes = [
      node("ts:src", "src"), // package containing both
      node("ts:src/__tests__", "src/__tests__", "ts:src"), // dir-path container: no self-match
      node("ts:src/__tests__/a.test", "src/__tests__/a.test.ts", "ts:src/__tests__"),
      node("ts:src/__tests__/a.test#t", "src/__tests__/a.test.ts", "ts:src/__tests__/a.test"),
      node("ts:src/b", "src/b.ts", "ts:src"),
    ];
    const testIds = collectTestIds(nodes);
    expect(testIds.has("ts:src/__tests__")).toBe(true); // absorbed: all children are tests
    expect(testIds.has("ts:src/__tests__/a.test#t")).toBe(true);
    expect(testIds.has("ts:src")).toBe(false); // has a production child
    expect(testIds.has("ts:src/b")).toBe(false);
  });
});
