import { describe, expect, it } from "vitest";
import type { CompactGraphSymbolEntry } from "@meridian/core";
import {
  MAX_GRAPH_SYMBOL_SEARCH_ROWS,
  createRepositoryGraphSymbolSearchIndex,
  mergeGraphSymbolSearchEntries,
  queryRankedGraphSymbols,
  type GraphSymbolSearchEntry,
} from "./graphSymbolSearch";

function indexed(
  id: string,
  displayName: string,
  overrides: Partial<CompactGraphSymbolEntry> = {},
): CompactGraphSymbolEntry {
  return {
    id,
    fileId: `ts:${id}.ts`,
    displayName,
    qualifiedName: `Example.${displayName}`,
    kind: "function",
    file: `${id}.ts`,
    isPrivateMethod: false,
    stepCount: null,
    ...overrides,
  };
}

describe("repository graph symbol search", () => {
  it("preserves loaded-row authority, deterministic ranking, scope counts, and the 40-row cap", () => {
    const repository = [
      indexed("override", "wrong", { kind: "method", isPrivateMethod: true, stepCount: 99 }),
      ...Array.from({ length: 50 }, (_, index) => indexed(`public-${index}`, `public-${String(index).padStart(2, "0")}`)),
      indexed("private", "__private", { kind: "method", isPrivateMethod: true }),
    ];
    const loaded: GraphSymbolSearchEntry[] = [{
      ...indexed("override", "authoritative", { kind: "method", stepCount: 3 }),
      isLoaded: true,
    }];
    const ranked = mergeGraphSymbolSearchEntries(repository, loaded, true);

    expect(ranked.find(({ id }) => id === "override")).toMatchObject({
      displayName: "authoritative",
      isPrivateMethod: false,
      stepCount: 3,
      isLoaded: true,
    });
    const result = queryRankedGraphSymbols(ranked, { query: "", isMap: true, scope: "public" });
    expect(result.results).toHaveLength(MAX_GRAPH_SYMBOL_SEARCH_ROWS);
    expect(result.results.map(({ displayName }) => displayName)).toEqual(
      [...result.results.map(({ displayName }) => displayName)].sort((a, b) => a.localeCompare(b)),
    );
    expect(result.counts).toEqual({ public: 51, all: 52, private: 1 });
    expect(queryRankedGraphSymbols(ranked, {
      query: "private",
      isMap: true,
      scope: "private",
    }).results.map(({ id }) => id)).toEqual(["private"]);
  });

  it("keeps logic no-query flow filtering while queries may find flowless callables", () => {
    const ranked = mergeGraphSymbolSearchEntries([
      indexed("flowless", "alpha"),
      indexed("flow", "zeta", { stepCount: 1 }),
    ], [], false);

    expect(queryRankedGraphSymbols(ranked, { query: "", isMap: false, scope: "all" }).results)
      .toMatchObject([{ id: "flow" }]);
    expect(queryRankedGraphSymbols(ranked, { query: "alpha", isMap: false, scope: "all" }).results)
      .toMatchObject([{ id: "flowless" }]);
  });

  it("includes type aliases in Map search while excluding them from Logic search", () => {
    const repository = [
      indexed("alias", "ToolExecutionTargetAuthorizer", { kind: "typeAlias" }),
      indexed("callable", "authorizeTarget"),
    ];
    expect(mergeGraphSymbolSearchEntries(repository, [], true).map(({ id }) => id))
      .toContain("alias");
    expect(mergeGraphSymbolSearchEntries(repository, [], false).map(({ id }) => id))
      .not.toContain("alias");

    const workerIndex = createRepositoryGraphSymbolSearchIndex(repository);
    workerIndex.synchronize([], true);
    expect(workerIndex.query({
      query: "ToolExecutionTargetAuthorizer",
      isMap: true,
      scope: "public",
    }).results).toMatchObject([{ id: "alias", kind: "typeAlias" }]);
    workerIndex.synchronize([], false);
    expect(workerIndex.query({
      query: "ToolExecutionTargetAuthorizer",
      isMap: false,
      scope: "public",
    }).results).toEqual([]);
  });

  it("matches the legacy merged ordering for loaded overrides in map and logic searches", () => {
    const repository = [
      indexed("z", "same", { qualifiedName: "z", stepCount: null }),
      indexed("a", "same", { qualifiedName: "a", stepCount: 2 }),
      indexed("other", "other", { kind: "class" }),
    ];
    const loaded: GraphSymbolSearchEntry[] = [{
      ...indexed("z", "same", { qualifiedName: "loaded-z", stepCount: 4 }),
      isLoaded: true,
    }, {
      ...indexed("loaded-only", "before", { stepCount: 1 }),
      isLoaded: true,
    }];

    for (const isMap of [true, false]) {
      const legacy = mergeGraphSymbolSearchEntries(repository, loaded, isMap);
      const workerIndex = createRepositoryGraphSymbolSearchIndex(repository);
      workerIndex.synchronize(loaded, isMap);
      for (const query of ["", "same", "missing"]) {
        for (const scope of ["public", "all", "private"] as const) {
          expect(workerIndex.query({ query, isMap, scope })).toEqual(
            queryRankedGraphSymbols(legacy, { query, isMap, scope }),
          );
        }
      }
    }
  });

  it("caches repository counts and materializes only the bounded returned rows per query", () => {
    let objectSpreads = 0;
    let privacyReads = 0;
    const repository = Array.from({ length: 5_000 }, (_, index) => new Proxy(
      indexed(`id-${index}`, `symbol-${String(index).padStart(5, "0")}`),
      {
        ownKeys(target) {
          objectSpreads += 1;
          return Reflect.ownKeys(target);
        },
        get(target, property, receiver) {
          if (property === "isPrivateMethod") privacyReads += 1;
          return Reflect.get(target, property, receiver);
        },
      },
    ));
    const workerIndex = createRepositoryGraphSymbolSearchIndex(repository);
    workerIndex.synchronize([], true);
    objectSpreads = 0;
    privacyReads = 0;

    const result = workerIndex.query({ query: "", isMap: true, scope: "public" });

    expect(result.results).toHaveLength(MAX_GRAPH_SYMBOL_SEARCH_ROWS);
    expect(objectSpreads).toBe(MAX_GRAPH_SYMBOL_SEARCH_ROWS);
    expect(privacyReads).toBeLessThan(200);
    expect(result.counts.all).toBe(5_000);
  });
});
