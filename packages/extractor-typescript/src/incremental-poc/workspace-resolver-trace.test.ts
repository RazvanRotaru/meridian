import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CrossPackageResolver } from "../edge-resolve";
import {
  isCanonicalWorkspaceResolverTrace,
  traceCrossPackageResolver,
  workspaceResolverTraceMatches,
  type WorkspaceResolverTraceEntry,
} from "./workspace-resolver-trace";

const ROOT = resolve("/fixture/workspace");
const FROM_FILE = resolve(ROOT, "packages/consumer/src/index.ts");
const TARGET_FILE = resolve(ROOT, "packages/provider/src/index.ts");

describe("workspace resolver trace", () => {
  it("records all three methods, including false/null observations, in deterministic deduplicated order", () => {
    const delegate: CrossPackageResolver = {
      matches: vi.fn(() => false),
      resolveRelative: vi.fn(() => null),
      resolveFile: vi.fn(() => null),
    };
    const traced = traceCrossPackageResolver(delegate, ROOT);

    traced.resolver.resolveRelative(FROM_FILE, "../../provider/src/index");
    traced.resolver.matches("@fixture/missing");
    traced.resolver.resolveFile(FROM_FILE, TARGET_FILE);
    traced.resolver.matches("@fixture/missing");
    traced.resolver.resolveRelative(FROM_FILE, "../../provider/src/index");
    traced.resolver.resolveFile(FROM_FILE, TARGET_FILE);

    expect(traced.snapshot()).toEqual([
      {
        kind: "resolve-file",
        fromFile: "repo:packages/consumer/src/index.ts",
        targetFile: "repo:packages/provider/src/index.ts",
        result: null,
      },
      {
        kind: "resolve-relative",
        fromFile: "repo:packages/consumer/src/index.ts",
        specifier: "../../provider/src/index",
        result: null,
      },
      {
        kind: "matches",
        specifier: "@fixture/missing",
        result: false,
      },
    ]);
    expect(traced.isReusable()).toBe(true);
  });

  it("replays portable repository paths and accepts only identical observations", () => {
    const trace: WorkspaceResolverTraceEntry[] = [
      {
        kind: "matches",
        specifier: "@fixture/provider",
        result: true,
      },
      {
        kind: "resolve-file",
        fromFile: "repo:packages/consumer/src/index.ts",
        targetFile: "repo:packages/provider/src/index.ts",
        result: "packages/provider/src/index.ts",
      },
      {
        kind: "resolve-relative",
        fromFile: "repo:packages/consumer/src/index.ts",
        specifier: "../../provider/src/index",
        result: "packages/provider/src/index",
      },
    ];
    const matching: CrossPackageResolver = {
      matches: vi.fn(() => true),
      resolveRelative: vi.fn(() => "packages/provider/src/index"),
      resolveFile: vi.fn(() => "packages/provider/src/index.ts"),
    };

    expect(workspaceResolverTraceMatches(trace, matching, ROOT)).toBe(true);
    expect(matching.resolveRelative).toHaveBeenCalledWith(
      FROM_FILE,
      "../../provider/src/index",
    );
    expect(matching.resolveFile).toHaveBeenCalledWith(FROM_FILE, TARGET_FILE);

    const mismatchedMatches: CrossPackageResolver = {
      ...matching,
      matches: () => false,
    };
    const mismatchedRelative: CrossPackageResolver = {
      ...matching,
      resolveRelative: () => null,
    };
    const mismatchedFile: CrossPackageResolver = {
      ...matching,
      resolveFile: () => null,
    };
    expect(workspaceResolverTraceMatches(trace, mismatchedMatches, ROOT)).toBe(false);
    expect(workspaceResolverTraceMatches(trace, mismatchedRelative, ROOT)).toBe(false);
    expect(workspaceResolverTraceMatches(trace, mismatchedFile, ROOT)).toBe(false);
  });

  it("marks traces with external resolver path inputs as non-reusable", () => {
    const outside = resolve(ROOT, "..", "outside.ts");
    const delegate: CrossPackageResolver = {
      matches: () => false,
      resolveRelative: () => null,
      resolveFile: () => null,
    };

    const externalSource = traceCrossPackageResolver(delegate, ROOT);
    externalSource.resolver.resolveRelative(outside, "./sibling");
    expect(externalSource.snapshot()).toEqual([
      {
        kind: "resolve-relative",
        fromFile: `external:${outside.replaceAll("\\", "/")}`,
        specifier: "./sibling",
        result: null,
      },
    ]);
    expect(externalSource.isReusable()).toBe(false);

    const externalTarget = traceCrossPackageResolver(delegate, ROOT);
    externalTarget.resolver.resolveFile(FROM_FILE, outside);
    expect(externalTarget.isReusable()).toBe(false);
  });

  it("marks a resolver that returns inconsistent results for the same query as non-reusable", () => {
    let matches = false;
    const traced = traceCrossPackageResolver(
      {
        matches: () => {
          matches = !matches;
          return matches;
        },
        resolveRelative: () => null,
        resolveFile: () => null,
      },
      ROOT,
    );

    expect(traced.resolver.matches("@fixture/provider")).toBe(true);
    expect(traced.resolver.matches("@fixture/provider")).toBe(false);
    expect(traced.snapshot()).toEqual([
      {
        kind: "matches",
        specifier: "@fixture/provider",
        result: false,
      },
      {
        kind: "matches",
        specifier: "@fixture/provider",
        result: true,
      },
    ]);
    expect(traced.isReusable()).toBe(false);
  });

  it("propagates delegate errors and remains non-reusable when the caller swallows them", () => {
    const failure = new Error("resolver failed");
    const traced = traceCrossPackageResolver(
      {
        matches: () => false,
        resolveRelative: () => null,
        resolveFile: () => {
          throw failure;
        },
      },
      ROOT,
    );

    expect(() => traced.resolver.resolveFile(FROM_FILE, TARGET_FILE)).toThrow(failure);
    expect(traced.isReusable()).toBe(false);

    try {
      traced.resolver.resolveFile(FROM_FILE, TARGET_FILE);
    } catch {
      // Mirrors resolveTarget: the extraction pass may convert the exception to a diagnostic.
    }
    expect(traced.isReusable()).toBe(false);
    expect(traced.snapshot()).toEqual([]);
  });

  it("fails replay closed when the current resolver throws", () => {
    const trace: WorkspaceResolverTraceEntry[] = [
      {
        kind: "matches",
        specifier: "@fixture/provider",
        result: false,
      },
    ];
    const resolver: CrossPackageResolver = {
      matches: () => {
        throw new Error("current resolver failed");
      },
      resolveRelative: () => null,
      resolveFile: () => null,
    };

    expect(workspaceResolverTraceMatches(trace, resolver, ROOT)).toBe(false);
  });

  it("accepts only sorted, unique, structurally valid immutable traces", () => {
    const canonical: WorkspaceResolverTraceEntry[] = [
      {
        kind: "resolve-relative",
        fromFile: "repo:packages/consumer/src/index.ts",
        specifier: "../provider",
        result: null,
      },
      {
        kind: "matches",
        specifier: "@fixture/provider",
        result: true,
      },
    ];
    expect(isCanonicalWorkspaceResolverTrace(canonical)).toBe(true);
    expect(isCanonicalWorkspaceResolverTrace([...canonical].reverse())).toBe(false);
    expect(isCanonicalWorkspaceResolverTrace([canonical[0]!, canonical[0]!])).toBe(false);
    expect(isCanonicalWorkspaceResolverTrace([{
      ...canonical[0]!,
      fromFile: "repo:../outside.ts",
    }])).toBe(false);
    expect(isCanonicalWorkspaceResolverTrace([{
      ...canonical[0]!,
      result: "../outside",
    }])).toBe(false);
    expect(isCanonicalWorkspaceResolverTrace([{
      ...canonical[0]!,
      unexpected: true,
    }])).toBe(false);
  });
});
