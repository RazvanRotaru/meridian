import { symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { ExtractionProgress } from "@meridian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compareExtractionResults } from "./differential";
import { extractRevisionDifferential } from "./differential-revision";
import {
  extractRevisionCandidate,
  extractRevisionWithCache,
} from "./extract-revision";
import { extractPerPackage } from "../extract-per-package";
import { perPackageWorkspace } from "../extractor";
import { createGitMonorepoFixture, type GitMonorepoFixture } from "./git-fixture";
import { fixtureRequest, replaceInFixture } from "./test-support";

describe("revision-safe package shard differential POC", { timeout: 20_000 }, () => {
  let fixture: GitMonorepoFixture;

  beforeEach(() => {
    fixture = createGitMonorepoFixture();
  });

  afterEach(() => {
    fixture.cleanup();
  });

  it("uses the same canonical stitch for empty-cache, warm-cache, and direct extraction", async () => {
    const request = fixtureRequest(fixture, fixture.seedRevision);
    const initial = await extractRevisionWithCache(request);
    expect(initial.metrics.rebuiltUnits).toBe(initial.metrics.totalUnits);
    expect(initial.metrics.reuseRatio).toBe(0);
    expect(initial.manifest.treeOid).toBe(fixture.seedRevision.treeOid);

    const warm = await extractRevisionDifferential(request);
    expect(warm.incremental.metrics.reusedUnits).toBe(warm.incremental.metrics.totalUnits);
    expect(warm.incremental.metrics.byteReuseRatio).toBe(1);
    expect(warm.differential.equal).toBe(true);

    const options = {
      root: fixture.root,
      depth: "function" as const,
      includeExternal: true,
      includeUnresolved: false,
      valueRefs: true,
    };
    const workspace = perPackageWorkspace(options);
    expect(workspace).not.toBeNull();
    const direct = extractPerPackage(options, workspace!);
    expect(compareExtractionResults(initial.result, direct)).toMatchObject({ equal: true, mismatches: [] });

    expect(initial.result.edges.some((edge) => (edge.callSites?.length ?? 0) > 0)).toBe(true);
    expect(Object.keys(initial.result.flows ?? {})).not.toHaveLength(0);
    expect(initial.result.ports ?? []).not.toHaveLength(0);
    expect(initial.result.diagnostics).not.toHaveLength(0);
  });

  it("rebuilds only the owning unit for an ordinary isolated modification", async () => {
    const baseline = await extractRevisionWithCache(fixtureRequest(fixture, fixture.seedRevision));
    replaceInFixture(
      fixture,
      "packages/consumer/src/index.ts",
      "normalizeOrder(raw)",
      "normalizeOrder(normalizeOrder(raw))",
    );
    const revision = fixture.commit("add a second consumer call");

    const run = await extractRevisionDifferential(fixtureRequest(fixture, revision));
    expect(run.incremental.metrics).toMatchObject({ totalUnits: 3, rebuiltUnits: 1, reusedUnits: 2 });
    expect(run.incremental.manifest.normalizedResultDigest).not.toBe(
      baseline.manifest.normalizedResultDigest,
    );
  });

  it("invalidates the owning unit when a tracked source is added", async () => {
    await extractRevisionWithCache(fixtureRequest(fixture, fixture.seedRevision));
    fixture.writeFile(
      "packages/consumer/src/status.ts",
      "export function statusLabel(ok: boolean): string {\n  return ok ? \"ok\" : \"failed\";\n}\n",
    );
    const revision = fixture.commit("add consumer status source");

    const run = await extractRevisionDifferential(fixtureRequest(fixture, revision));
    expect(run.incremental.metrics).toMatchObject({ rebuiltUnits: 1, reusedUnits: 2 });
    expect(run.incremental.result.nodes.some((node) => node.location.file.endsWith("/status.ts"))).toBe(true);
  });

  it("invalidates path ownership for an isolated source deletion", async () => {
    fixture.writeFile(
      "packages/consumer/src/delete-me.ts",
      "export function deletedContribution(): number {\n  return 1;\n}\n",
    );
    const setup = fixture.commit("prepare isolated deletion");
    await extractRevisionWithCache(fixtureRequest(fixture, setup));
    fixture.removeFile("packages/consumer/src/delete-me.ts");
    const revision = fixture.commit("delete one consumer source");

    const run = await extractRevisionDifferential(fixtureRequest(fixture, revision));
    expect(run.incremental.metrics).toMatchObject({ rebuiltUnits: 1, reusedUnits: 2 });
    expect(run.incremental.result.nodes.some((node) => node.location.file.endsWith("/delete-me.ts"))).toBe(false);
  });

  it("reuses every unit for unobserved non-TypeScript changes, including beside source files", async () => {
    const baseline = await extractRevisionWithCache(fixtureRequest(fixture, fixture.seedRevision));
    fixture.writeFile("README.md", "updated repository guidance\n");
    fixture.writeFile("packages/consumer/src/theme.css", ".order { color: green; }\n");
    fixture.writeFile(".github/workflows/docs.yml", "name: docs\n");
    const revision = fixture.commit("change unobserved non-TypeScript files");

    const run = await extractRevisionDifferential(fixtureRequest(fixture, revision));
    expect(run.differential.equal).toBe(true);
    expect(run.incremental.metrics).toMatchObject({
      totalUnits: 3,
      rebuiltUnits: 0,
      reusedUnits: 3,
    });
    expect(run.incremental.manifest.normalizedResultDigest).toBe(
      baseline.manifest.normalizedResultDigest,
    );
  });

  it("rebuilds only the unit whose realized compiler program reads changed JSON", async () => {
    const config = JSON.parse(fixture.readFile("tsconfig.json")) as {
      compilerOptions: Record<string, unknown>;
    };
    config.compilerOptions.resolveJsonModule = true;
    config.compilerOptions.allowSyntheticDefaultImports = true;
    fixture.writeFile("tsconfig.json", `${JSON.stringify(config, null, 2)}\n`);
    fixture.writeFile(
      "packages/consumer/src/metadata.json",
      '{"label":"first"}\n',
    );
    fixture.writeFile(
      "packages/consumer/src/metadata.ts",
      [
        'import metadata from "./metadata.json";',
        "export function metadataLabel(): string {",
        "  return metadata.label;",
        "}",
        "",
      ].join("\n"),
    );
    const setup = fixture.commit("prepare tracked JSON compiler input");
    await extractRevisionWithCache(fixtureRequest(fixture, setup));

    fixture.writeFile(
      "packages/consumer/src/metadata.json",
      '{"label":"second"}\n',
    );
    const revision = fixture.commit("change tracked JSON compiler input");
    const run = await extractRevisionDifferential(fixtureRequest(fixture, revision));

    expect(run.differential.equal).toBe(true);
    expect(run.incremental.metrics).toMatchObject({
      totalUnits: 3,
      rebuiltUnits: 1,
      reusedUnits: 2,
    });
  });

  it("treats a rename as a path-sensitive rebuild rather than a blob-only hit", async () => {
    fixture.writeFile(
      "packages/provider/src/rename-me.ts",
      "export function renamedContribution(): number {\n  return 2;\n}\n",
    );
    const setup = fixture.commit("prepare isolated rename");
    await extractRevisionWithCache(fixtureRequest(fixture, setup));
    fixture.renameFile("packages/provider/src/rename-me.ts", "packages/provider/src/renamed.ts");
    const revision = fixture.commit("rename one provider source");

    const run = await extractRevisionDifferential(fixtureRequest(fixture, revision));
    expect(run.incremental.metrics).toMatchObject({ rebuiltUnits: 1, reusedUnits: 2 });
    expect(run.incremental.result.nodes.some((node) => node.location.file.endsWith("/renamed.ts"))).toBe(true);
    expect(run.incremental.result.nodes.some((node) => node.location.file.endsWith("/rename-me.ts"))).toBe(false);
  });

  it("rebuilds an unchanged consumer when a provider-only re-export boundary changes", async () => {
    const consumerBefore = fixture.readFile("packages/consumer/src/index.ts");
    await extractRevisionWithCache(fixtureRequest(fixture, fixture.seedRevision));
    fixture.writeFile(
      "packages/provider/src/alternate.ts",
      "export function normalizeOrder(raw: string): string {\n  return raw.trim().toLowerCase();\n}\n",
    );
    replaceInFixture(
      fixture,
      "packages/provider/src/index.ts",
      '"./normalize"',
      '"./alternate"',
    );
    const revision = fixture.commit("change provider-only re-export boundary");

    const run = await extractRevisionDifferential(fixtureRequest(fixture, revision));
    expect(fixture.readFile("packages/consumer/src/index.ts")).toBe(consumerBefore);
    expect(run.incremental.metrics).toMatchObject({ rebuiltUnits: 2, reusedUnits: 1 });
    expect(run.incremental.result.edges.some((edge) => edge.target.includes("alternate.ts#normalizeOrder"))).toBe(true);
  });

  it("conservatively invalidates every unit for compiler configuration changes", async () => {
    await extractRevisionWithCache(fixtureRequest(fixture, fixture.seedRevision));
    const config = JSON.parse(fixture.readFile("tsconfig.json")) as {
      compilerOptions: Record<string, unknown>;
    };
    config.compilerOptions.useDefineForClassFields = true;
    fixture.writeFile("tsconfig.json", `${JSON.stringify(config, null, 2)}\n`);
    const revision = fixture.commit("change compiler configuration");

    const run = await extractRevisionDifferential(fixtureRequest(fixture, revision));
    expect(run.incremental.metrics).toMatchObject({ totalUnits: 3, rebuiltUnits: 3, reusedUnits: 0 });
  });

  it("localizes a tracked package config extends-chain change to units that select it", async () => {
    fixture.writeFile(
      "configs/provider-base.json",
      '{"compilerOptions":{"target":"ES2022","useDefineForClassFields":false}}\n',
    );
    fixture.writeFile(
      "packages/provider/tsconfig.json",
      '{"extends":"../../configs/provider-base.json","compilerOptions":{"module":"ESNext"}}\n',
    );
    const setup = fixture.commit("prepare provider-local config chain");
    await extractRevisionWithCache(fixtureRequest(fixture, setup));

    fixture.writeFile(
      "configs/provider-base.json",
      '{"compilerOptions":{"target":"ES2022","useDefineForClassFields":true}}\n',
    );
    const revision = fixture.commit("change provider-local config chain");
    const run = await extractRevisionDifferential(fixtureRequest(fixture, revision));

    expect(run.differential.equal).toBe(true);
    expect(run.incremental.metrics).toMatchObject({
      totalUnits: 3,
      rebuiltUnits: 1,
      reusedUnits: 2,
    });
  });

  it("matches canonical supplemental PR scope and keeps progress observational", async () => {
    fixture.writeFile("docs/review.md", "review context\n");
    fixture.writeFile(
      "plugins/new-tool/package.json",
      '{"name":"@fixture/new-tool","private":true}\n',
    );
    const dormantRevision = fixture.commit("prepare dormant supplemental package");
    const dormant = await extractRevisionWithCache(fixtureRequest(fixture, dormantRevision));
    expect(dormant.metrics).toMatchObject({ totalUnits: 3, rebuiltUnits: 3 });

    fixture.writeFile(
      "plugins/new-tool/src/index.ts",
      "export function supplementalTool(): string {\n  return \"supplemental\";\n}\n",
    );
    const revision = fixture.commit("add source outside declared workspace scope");
    const progress: ExtractionProgress[] = [];
    const request = {
      ...fixtureRequest(fixture, revision),
      supplementalFiles: [
        "docs/review.md",
        "plugins/new-tool/src/index.ts",
        "plugins/new-tool/src/index.ts",
      ],
      onProgress: (event: ExtractionProgress) => {
        progress.push(event);
      },
    };

    const run = await extractRevisionDifferential(request);
    expect(run.differential.equal).toBe(true);
    expect(run.incremental.metrics).toMatchObject({
      totalUnits: 4,
      rebuiltUnits: 1,
      reusedUnits: 3,
    });
    expect(run.incremental.manifest.workspaceDigest).not.toBe(dormant.manifest.workspaceDigest);
    expect(
      run.incremental.result.nodes.some(
        (node) => node.location.file === "plugins/new-tool/src/index.ts",
      ),
    ).toBe(true);
    expect(progress.some((event) => event.phase === "project-load" && event.unit?.total === 4)).toBe(
      true,
    );
    expect(progress.some((event) => event.phase === "stitch")).toBe(true);

    const directOptions = {
      root: fixture.root,
      supplementalFiles: ["docs/review.md", "plugins/new-tool/src/index.ts"],
      depth: "function" as const,
      includeExternal: true,
      includeUnresolved: false,
      valueRefs: true,
    };
    const workspace = perPackageWorkspace(directOptions);
    expect(workspace?.units).toHaveLength(4);
    expect(
      compareExtractionResults(
        run.incremental.result,
        extractPerPackage(directOptions, workspace!),
      ),
    ).toMatchObject({ equal: true, mismatches: [] });
  });

  it("rebuilds a consumer when a supplemental package changes a recorded bare match", async () => {
    fixture.writeFile(
      "plugins/future/package.json",
      '{"name":"@fixture/future","private":true}\n',
    );
    fixture.writeFile(
      "packages/consumer/src/future.ts",
      [
        'import { futureValue } from "@fixture/future";',
        "export function readFuture(): string {",
        "  return futureValue();",
        "}",
        "",
      ].join("\n"),
    );
    const unresolvedRevision = fixture.commit("prepare unresolved future workspace import");
    const unresolvedRequest = fixtureRequest(fixture, unresolvedRevision);
    const unresolved = await extractRevisionWithCache(unresolvedRequest);
    expect(unresolved.metrics).toMatchObject({ totalUnits: 3, rebuiltUnits: 3 });

    fixture.writeFile(
      "plugins/future/src/index.ts",
      'export function futureValue(): string {\n  return "future";\n}\n',
    );
    const resolvedRevision = fixture.commit("materialize future supplemental package");
    const resolved = await extractRevisionDifferential({
      ...fixtureRequest(fixture, resolvedRevision),
      supplementalFiles: ["plugins/future/src/index.ts"],
    });

    expect(resolved.differential.equal).toBe(true);
    expect(resolved.incremental.metrics).toMatchObject({
      totalUnits: 4,
      rebuiltUnits: 2,
      reusedUnits: 2,
    });
    expect(
      resolved.incremental.result.edges.some(
        (edge) => edge.target.includes("plugins/future/src/index.ts#futureValue"),
      ),
    ).toBe(true);
  });

  it("reuses an unchanged consumer shard while current stitching follows a provider export change", async () => {
    fixture.writeFile(
      "plugins/pending-provider/package.json",
      '{"name":"@fixture/pending-provider","private":true}\n',
    );
    fixture.writeFile(
      "plugins/pending-provider/src/index.ts",
      'export { pendingWork } from "./first";\n',
    );
    fixture.writeFile(
      "plugins/pending-provider/src/first.ts",
      'export function pendingWork(): string {\n  return "first";\n}\n',
    );
    fixture.writeFile(
      "plugins/pending-consumer/package.json",
      '{"name":"@fixture/pending-consumer","private":true}\n',
    );
    fixture.writeFile(
      "plugins/pending-consumer/src/index.ts",
      [
        'import { pendingWork } from "@fixture/pending-provider";',
        "export function callPendingWork(): string {",
        "  return pendingWork();",
        "}",
        "",
      ].join("\n"),
    );
    const baselineRevision = fixture.commit("prepare pending supplemental packages");
    const supplementalFiles = [
      "plugins/pending-consumer/src/index.ts",
      "plugins/pending-provider/src/index.ts",
    ];
    const baselineRequest = {
      ...fixtureRequest(fixture, baselineRevision),
      supplementalFiles,
    };
    const baseline = await extractRevisionWithCache(baselineRequest);
    expect(baseline.metrics).toMatchObject({ totalUnits: 5, rebuiltUnits: 5 });
    expect(
      baseline.result.edges.some(
        (edge) => edge.target.includes("plugins/pending-provider/src/first.ts#pendingWork"),
      ),
    ).toBe(true);

    fixture.writeFile(
      "plugins/pending-provider/src/second.ts",
      'export function pendingWork(): string {\n  return "second";\n}\n',
    );
    replaceInFixture(
      fixture,
      "plugins/pending-provider/src/index.ts",
      '"./first"',
      '"./second"',
    );
    const changedRevision = fixture.commit("change pending provider export");
    const changed = await extractRevisionDifferential({
      ...fixtureRequest(fixture, changedRevision),
      supplementalFiles,
    });

    expect(changed.differential.equal).toBe(true);
    expect(changed.incremental.metrics).toMatchObject({
      totalUnits: 5,
      rebuiltUnits: 1,
      reusedUnits: 4,
    });
    expect(
      changed.incremental.result.edges.some(
        (edge) => edge.target.includes("plugins/pending-provider/src/second.ts#pendingWork"),
      ),
    ).toBe(true);
    expect(
      changed.incremental.result.edges.some(
        (edge) => edge.target.includes("plugins/pending-provider/src/first.ts#pendingWork"),
      ),
    ).toBe(false);
  });

  it("fails closed for TypeScript supplemental paths outside the exact tree", async () => {
    const request = fixtureRequest(fixture, fixture.seedRevision);
    await expect(
      extractRevisionWithCache({
        ...request,
        supplementalFiles: ["../outside.ts"],
      }),
    ).rejects.toThrow(/exact root-relative Git path/);
    await expect(
      extractRevisionWithCache({
        ...request,
        supplementalFiles: ["packages/consumer/src/missing.ts"],
      }),
    ).rejects.toThrow(/not a regular blob in the exact Git tree/);
  });

  it("reuses a complete negative-resolution proof and invalidates when a failed lookup appears", async () => {
    fixture.writeFile(".gitignore", "node_modules/missing-package/\n");
    fixture.writeFile(
      "packages/unrelated/src/index.ts",
      [
        'import { missingValue } from "missing-package";',
        "export function unrelatedScore(value: number): number {",
        "  return value * value + Number(missingValue);",
        "}",
        "",
      ].join("\n"),
    );
    const revision = fixture.commit("add unresolved external import");
    const request = fixtureRequest(fixture, revision);
    const candidate = await extractRevisionCandidate(request);
    const unrelated = candidate.pendingShards.find(
      (pending) => pending.value.inputs.unit.dir === "packages/unrelated",
    );
    const unresolved = unrelated?.value.inputs.moduleResolutions.find(
      (resolution) => resolution.specifier === "missing-package",
    );
    expect(unresolved?.target).toBeNull();
    expect(unresolved?.hasCompleteLookupProof).toBe(true);
    expect(unrelated?.value.inputs.resolutionLookupInputs.length).toBeGreaterThan(0);
    expect(
      unrelated?.value.inputs.resolutionLookupInputs
        .filter((input) => input.purpose === "failed-lookup")
        .every((input) => input.state === "absent"),
    ).toBe(true);
    expect(unrelated?.value.inputs.reuseEligibility).toEqual({
      eligible: true,
      reasons: [],
    });
    await extractRevisionWithCache(request);

    fixture.writeFile(
      "node_modules/missing-package/package.json",
      '{"name":"missing-package","version":"1.0.0","types":"index.d.ts"}\n',
    );
    fixture.writeFile(
      "node_modules/missing-package/index.d.ts",
      "export declare const missingValue: number;\n",
    );
    const changed = await extractRevisionDifferential(request);
    const changedUnit = changed.incremental.manifest.units.find(
      (unit) => unit.unitId === "packages/unrelated",
    );
    expect(changed.differential.equal).toBe(true);
    expect(changed.incremental.metrics.rebuiltUnits).toBeGreaterThanOrEqual(1);
    expect(changed.incremental.metrics.conservativelyRebuiltUnits).toBeGreaterThanOrEqual(1);
    expect(changedUnit?.reuseEligibility.eligible).toBe(false);
    expect(changedUnit?.reuseEligibility.reasons).toContain(
      "external-dependency-program-input",
    );
  });

  it("verifies irrelevant tracked symlinks without putting their topology in every unit key", async () => {
    fixture.writeFile("docs/CLAUDE.md", "shared rules\n");
    fixture.writeFile("docs/RULES.md", "shared rules\n");
    symlinkSync("CLAUDE.md", join(fixture.root, "docs", "AGENTS.md"));
    const initialRevision = fixture.commit("add tracked documentation link");
    const initial = await extractRevisionWithCache(fixtureRequest(fixture, initialRevision));
    expect(initial.metrics).toMatchObject({ rebuiltUnits: 3, reusedUnits: 0 });

    const warm = await extractRevisionDifferential(fixtureRequest(fixture, initialRevision));
    expect(warm.incremental.metrics).toMatchObject({ rebuiltUnits: 0, reusedUnits: 3 });
    expect(warm.differential.equal).toBe(true);

    unlinkSync(join(fixture.root, "docs", "AGENTS.md"));
    symlinkSync("RULES.md", join(fixture.root, "docs", "AGENTS.md"));
    const changedRevision = fixture.commit("retarget tracked documentation link");
    const changed = await extractRevisionDifferential(fixtureRequest(fixture, changedRevision));
    expect(changed.incremental.metrics).toMatchObject({ rebuiltUnits: 0, reusedUnits: 3 });
    expect(changed.differential.equal).toBe(true);
    expect(changed.incremental.manifest.normalizedResultDigest).toBe(
      initial.manifest.normalizedResultDigest,
    );
  });

  it("fingerprints ignored package manifests consulted by external resolution", async () => {
    fixture.writeFile(".gitignore", "packages/consumer/src/nested/package.json\n");
    fixture.writeFile(
      "packages/consumer/src/nested/ghost.ts",
      'import { haunt } from "ghost";\nexport function callGhost(): void {\n  haunt();\n}\n',
    );
    fixture.writeFile(
      "packages/consumer/src/nested/package.json",
      '{"dependencies":{"ghost":"1.0.0"}}\n',
    );
    const revision = fixture.commit("add ignored resolution-manifest scenario");
    const external = await extractRevisionWithCache(fixtureRequest(fixture, revision));
    expect(external.result.edges.some((edge) => edge.target.includes("ext:npm/ghost"))).toBe(true);

    fixture.writeFile("packages/consumer/src/nested/package.json", "{}\n");
    const changed = await extractRevisionDifferential(fixtureRequest(fixture, revision));
    expect(changed.incremental.metrics).toMatchObject({ rebuiltUnits: 1, reusedUnits: 2 });
    expect(changed.incremental.result.edges.some((edge) => edge.target.includes("ext:npm/ghost"))).toBe(false);
  });

  it("refuses reuse when ignored dependency resolution can change semantics", async () => {
    fixture.writeFile(".gitignore", "node_modules/ghost/\n");
    fixture.writeFile(
      "node_modules/ghost/a.d.ts",
      "export declare function haunt(): Promise<void>;\n",
    );
    fixture.writeFile(
      "node_modules/ghost/b.d.ts",
      "export declare function haunt(): string;\n",
    );
    fixture.writeFile(
      "node_modules/ghost/package.json",
      '{"name":"ghost","version":"1.0.0","types":"a.d.ts"}\n',
    );
    const consumer = fixture.readFile("packages/consumer/src/index.ts");
    fixture.writeFile(
      "packages/consumer/src/index.ts",
      [
        '/// <reference path="../../../node_modules/ghost/a.d.ts" />',
        '/// <reference path="../../../node_modules/ghost/b.d.ts" />',
        'import { haunt } from "ghost";',
        consumer,
        "export function callGhost(): void {",
        "  haunt();",
        "}",
        "",
      ].join("\n"),
    );
    const revision = fixture.commit("add ignored dependency-resolution scenario");
    const first = await extractRevisionWithCache(fixtureRequest(fixture, revision));
    const firstConsumer = first.manifest.units.find(
      (unit) => unit.unitId === "packages/consumer",
    );
    expect(firstConsumer?.reuseEligibility).toMatchObject({ eligible: false });
    expect(firstConsumer?.reuseEligibility.reasons).toContain(
      "external-dependency-program-input",
    );

    fixture.writeFile(
      "node_modules/ghost/package.json",
      '{"name":"ghost","version":"1.0.0","types":"b.d.ts"}\n',
    );
    const changed = await extractRevisionDifferential(fixtureRequest(fixture, revision));
    const changedConsumer = changed.incremental.manifest.units.find(
      (unit) => unit.unitId === "packages/consumer",
    );

    expect(changed.differential.equal).toBe(true);
    expect(changed.incremental.metrics).toMatchObject({
      rebuiltUnits: 1,
      reusedUnits: 2,
      conservativelyRebuiltUnits: 1,
    });
    expect(changed.incremental.manifest.normalizedResultDigest).not.toBe(
      first.manifest.normalizedResultDigest,
    );
    expect(changedConsumer?.shardKey).not.toBe(firstConsumer?.shardKey);
  });
});
