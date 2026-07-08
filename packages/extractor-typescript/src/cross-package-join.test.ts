/**
 * The join half of per-package extraction: pending cross-package references (recorded while
 * each package was analyzed in isolation) are resolved against the other packages' export
 * summaries — including subpath imports, star/named re-export chains, and cycles — and
 * rewritten into ordinary resolved raw edges. Misses stay honestly unresolved.
 */

import { describe, expect, it } from "vitest";
import type { RawEdge } from "./edge-pass";
import type { TargetResolution } from "./edge-resolve";
import { joinCrossPackageEdges, type UnitSummary } from "./cross-package-join";

const CALL_SITE = { file: "packages/ui/src/app.ts", line: 1, col: 1 };

function pendingEdge(specifier: string, exportedName: string | null, kind = "calls"): RawEdge {
  const resolution: TargetResolution = {
    resolution: "unresolved",
    resolvedTarget: null,
    externalModulePath: null,
    externalQualname: null,
    threw: false,
    pending: { specifier, exportedName },
  };
  return { source: "ts:packages/ui/src/app.ts#runApp", kind: "calls", resolution, callSite: CALL_SITE, ...(kind === "imports" ? { kind, source: "ts:packages/ui/src/app.ts" } : {}) };
}

function summaries(): UnitSummary[] {
  return [
    {
      dir: "packages/util",
      name: "@fix/util",
      entryFile: "packages/util/src/index.ts",
      sourceDir: "packages/util/src",
      exportsByFile: new Map([
        ["packages/util/src/index.ts", new Map([["normalize", "ts:packages/util/src/index.ts#normalize"]])],
      ]),
      moduleIdByRelPath: new Map([["packages/util/src/index.ts", "ts:packages/util/src/index.ts"]]),
      pendingReexports: [],
    },
    {
      dir: "packages/core",
      name: "@fix/core",
      entryFile: "packages/core/src/index.ts",
      sourceDir: "packages/core/src",
      exportsByFile: new Map([
        // `export { parseOrder } from "./orders"` was already flattened in-package.
        ["packages/core/src/index.ts", new Map([["parseOrder", "ts:packages/core/src/orders.ts#parseOrder"]])],
        ["packages/core/src/helpers.ts", new Map([["helper", "ts:packages/core/src/helpers.ts#helper"]])],
        ["packages/core/src/widgets/index.tsx", new Map([["Widget", "ts:packages/core/src/widgets/index.tsx#Widget"]])],
      ]),
      moduleIdByRelPath: new Map([
        ["packages/core/src/index.ts", "ts:packages/core/src/index.ts"],
        ["packages/core/src/helpers.ts", "ts:packages/core/src/helpers.ts"],
        ["packages/core/src/widgets/index.tsx", "ts:packages/core/src/widgets/index.tsx"],
      ]),
      pendingReexports: [
        // `export * from "@fix/util"` in core's entry file.
        { file: "packages/core/src/index.ts", specifier: "@fix/util", names: null },
        // `export { normalize as norm2 } from "@fix/util"`.
        { file: "packages/core/src/index.ts", specifier: "@fix/util", names: [{ exported: "norm2", local: "normalize" }] },
      ],
    },
  ];
}

function joined(edge: RawEdge): RawEdge {
  return joinCrossPackageEdges([edge], summaries())[0];
}

describe("joinCrossPackageEdges", () => {
  it("resolves a named export against the target package's entry file", () => {
    const edge = joined(pendingEdge("@fix/core", "parseOrder"));
    expect(edge.resolution.resolution).toBe("resolved");
    expect(edge.resolution.resolvedTarget).toBe("ts:packages/core/src/orders.ts#parseOrder");
  });

  it("resolves through a cross-package star re-export chain", () => {
    const edge = joined(pendingEdge("@fix/core", "normalize"));
    expect(edge.resolution.resolvedTarget).toBe("ts:packages/util/src/index.ts#normalize");
  });

  it("resolves a renamed cross-package re-export", () => {
    const edge = joined(pendingEdge("@fix/core", "norm2"));
    expect(edge.resolution.resolvedTarget).toBe("ts:packages/util/src/index.ts#normalize");
  });

  it("resolves a subpath specifier against that file's exports, probing extensions", () => {
    expect(joined(pendingEdge("@fix/core/helpers", "helper")).resolution.resolvedTarget).toBe(
      "ts:packages/core/src/helpers.ts#helper",
    );
    expect(joined(pendingEdge("@fix/core/widgets", "Widget")).resolution.resolvedTarget).toBe(
      "ts:packages/core/src/widgets/index.tsx#Widget",
    );
  });

  it("resolves a module-level pending (imports edge) to the target module node", () => {
    expect(joined(pendingEdge("@fix/core", null, "imports")).resolution.resolvedTarget).toBe(
      "ts:packages/core/src/index.ts",
    );
    expect(joined(pendingEdge("@fix/core/helpers", null, "imports")).resolution.resolvedTarget).toBe(
      "ts:packages/core/src/helpers.ts",
    );
  });

  it("leaves unknown names and unknown packages honestly unresolved", () => {
    expect(joined(pendingEdge("@fix/core", "nope")).resolution.resolution).toBe("unresolved");
    expect(joined(pendingEdge("@zzz/pkg", "f")).resolution.resolution).toBe("unresolved");
  });

  it("terminates on a star re-export cycle and still resolves reachable names", () => {
    const cyclic: UnitSummary[] = [
      {
        dir: "packages/a",
        name: "@fix/a",
        entryFile: "packages/a/index.ts",
        sourceDir: "packages/a",
        exportsByFile: new Map([["packages/a/index.ts", new Map([["fromA", "ts:packages/a/index.ts#fromA"]])]]),
        moduleIdByRelPath: new Map([["packages/a/index.ts", "ts:packages/a/index.ts"]]),
        pendingReexports: [{ file: "packages/a/index.ts", specifier: "@fix/b", names: null }],
      },
      {
        dir: "packages/b",
        name: "@fix/b",
        entryFile: "packages/b/index.ts",
        sourceDir: "packages/b",
        exportsByFile: new Map([["packages/b/index.ts", new Map([["fromB", "ts:packages/b/index.ts#fromB"]])]]),
        moduleIdByRelPath: new Map([["packages/b/index.ts", "ts:packages/b/index.ts"]]),
        pendingReexports: [{ file: "packages/b/index.ts", specifier: "@fix/a", names: null }],
      },
    ];
    const edge = joinCrossPackageEdges([pendingEdge("@fix/a", "fromB")], cyclic)[0];
    expect(edge.resolution.resolvedTarget).toBe("ts:packages/b/index.ts#fromB");
  });

  it("does not poison the memo when a name is reachable only through a re-export cycle (finding 6)", () => {
    // A `export * from B`, B `export * from A`; querying B#fromA first must not cache a
    // B-table built while A was in-progress (which would omit A's names permanently).
    const cyclic: UnitSummary[] = [
      {
        dir: "packages/a",
        name: "@fix/a",
        entryFile: "packages/a/index.ts",
        sourceDir: "packages/a",
        exportsByFile: new Map([["packages/a/index.ts", new Map([["fromA", "ts:packages/a/index.ts#fromA"]])]]),
        moduleIdByRelPath: new Map([["packages/a/index.ts", "ts:packages/a/index.ts"]]),
        pendingReexports: [{ file: "packages/a/index.ts", specifier: "@fix/b", names: null }],
      },
      {
        dir: "packages/b",
        name: "@fix/b",
        entryFile: "packages/b/index.ts",
        sourceDir: "packages/b",
        exportsByFile: new Map([["packages/b/index.ts", new Map([["fromB", "ts:packages/b/index.ts#fromB"]])]]),
        moduleIdByRelPath: new Map([["packages/b/index.ts", "ts:packages/b/index.ts"]]),
        pendingReexports: [{ file: "packages/b/index.ts", specifier: "@fix/a", names: null }],
      },
    ];
    // Query order matters: resolve B#fromA (assembles B first, hitting A mid-flight), THEN A#fromB.
    const out = joinCrossPackageEdges([pendingEdge("@fix/b", "fromA"), pendingEdge("@fix/a", "fromB")], cyclic);
    expect(out[0].resolution.resolvedTarget).toBe("ts:packages/a/index.ts#fromA");
    expect(out[1].resolution.resolvedTarget).toBe("ts:packages/b/index.ts#fromB");
  });

  it("resolves a relative cross-package import recorded by target file path (finding 2)", () => {
    const relative: RawEdge = {
      source: "ts:tests/foo.test.ts#t",
      kind: "calls",
      resolution: {
        resolution: "unresolved",
        resolvedTarget: null,
        externalModulePath: null,
        externalQualname: null,
        threw: false,
        pending: { specifier: "../../packages/core/src/helpers", exportedName: "helper", targetFile: "packages/core/src/helpers" },
      },
      callSite: CALL_SITE,
    };
    const out = joinCrossPackageEdges([relative], summaries())[0];
    expect(out.resolution.resolvedTarget).toBe("ts:packages/core/src/helpers.ts#helper");
  });

  it("resolves a relative cross-package module import (targetFile, null name) to the module node", () => {
    const relative: RawEdge = {
      source: "ts:tests/foo.test.ts",
      kind: "imports",
      resolution: {
        resolution: "unresolved",
        resolvedTarget: null,
        externalModulePath: null,
        externalQualname: null,
        threw: false,
        pending: { specifier: "../../packages/core/src/helpers.js", exportedName: null, targetFile: "packages/core/src/helpers.js" },
      },
      callSite: CALL_SITE,
    };
    const out = joinCrossPackageEdges([relative], summaries())[0];
    expect(out.resolution.resolvedTarget).toBe("ts:packages/core/src/helpers.ts");
  });

  it("passes non-pending edges through untouched", () => {
    const plain: RawEdge = {
      source: "ts:x.ts#f",
      kind: "calls",
      resolution: { resolution: "resolved", resolvedTarget: "ts:x.ts#g", externalModulePath: null, externalQualname: null, threw: false },
      callSite: CALL_SITE,
    };
    expect(joinCrossPackageEdges([plain], summaries())[0]).toEqual(plain);
  });
});
