import { createHash, generateKeyPairSync } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtractionResult } from "@meridian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  RevisionShardAdmissionSigner,
  RevisionShardAdmissionVerifier,
} from "./admission";
import { canonicalJson, canonicalJsonSha256 } from "./canonical-json";
import { compareExtractionResults } from "./differential";
import { extractRevisionDifferential } from "./differential-revision";
import {
  extractRevisionCandidate,
  extractRevisionWithCache,
  publishRevisionCandidate,
  publishStagedRevisionAdmission,
  stageRevisionCandidateForAdmission,
  type PendingRevisionExtraction,
  type StoredUnitShard,
} from "./extract-revision";
import {
  resolutionLookupInputKey,
  resolutionLookupProofKey,
} from "./fingerprints";
import {
  createGitMonorepoFixture,
  type GitFixtureRevision,
  type GitMonorepoFixture,
} from "./git-fixture";
import {
  immutableJsonCachePath,
  listImmutableJsonCacheAddresses,
  readImmutableJsonCache,
  writeImmutableJsonCache,
} from "./immutable-cache";
import type { RevisionExtractionMetrics, RevisionManifest } from "./model";
import { fixtureRequest, replaceInFixture } from "./test-support";

interface AdmittedRevisionCase {
  readonly id: string;
  readonly name: string;
  readonly prepareBase?: (fixture: GitMonorepoFixture) => GitFixtureRevision;
  readonly mutateTarget: (fixture: GitMonorepoFixture) => GitFixtureRevision;
  readonly expected: {
    readonly totalUnits: number;
    readonly rebuiltUnits: number;
    readonly reusedUnits: number;
  };
  readonly semantic?: {
    readonly reusedRegions: number | { readonly atLeast: number };
    readonly stableFiles?: readonly string[];
    readonly invalidatedFiles?: readonly string[];
    readonly invalidatesEveryRegionInUnit?: string;
  };
}

const ADMITTED_REVISION_CASES: readonly AdmittedRevisionCase[] = [
  {
    id: "ordinary-modification",
    name: "ordinary modification",
    mutateTarget: (fixture) => {
      replaceInFixture(
        fixture,
        "packages/consumer/src/index.ts",
        "normalizeOrder(raw)",
        "normalizeOrder(normalizeOrder(raw))",
      );
      return fixture.commit("modify one admitted consumer unit");
    },
    expected: { totalUnits: 3, rebuiltUnits: 1, reusedUnits: 2 },
  },
  {
    id: "source-addition",
    name: "source addition",
    mutateTarget: (fixture) => {
      fixture.writeFile(
        "packages/consumer/src/status.ts",
        'export function statusLabel(ok: boolean): string {\n  return ok ? "ok" : "failed";\n}\n',
      );
      return fixture.commit("add one admitted consumer source");
    },
    expected: { totalUnits: 3, rebuiltUnits: 1, reusedUnits: 2 },
  },
  {
    id: "source-deletion",
    name: "source deletion",
    prepareBase: (fixture) => {
      fixture.writeFile(
        "packages/consumer/src/delete-me.ts",
        "export function deletedContribution(): number {\n  return 1;\n}\n",
      );
      return fixture.commit("prepare admitted source deletion");
    },
    mutateTarget: (fixture) => {
      fixture.removeFile("packages/consumer/src/delete-me.ts");
      return fixture.commit("delete one admitted consumer source");
    },
    expected: { totalUnits: 3, rebuiltUnits: 1, reusedUnits: 2 },
  },
  {
    id: "source-rename",
    name: "source rename",
    prepareBase: (fixture) => {
      fixture.writeFile(
        "packages/provider/src/rename-me.ts",
        "export function renamedContribution(): number {\n  return 2;\n}\n",
      );
      return fixture.commit("prepare admitted source rename");
    },
    mutateTarget: (fixture) => {
      fixture.renameFile(
        "packages/provider/src/rename-me.ts",
        "packages/provider/src/renamed.ts",
      );
      return fixture.commit("rename one admitted provider source");
    },
    expected: { totalUnits: 3, rebuiltUnits: 1, reusedUnits: 2 },
  },
  {
    id: "reexport-boundary",
    name: "provider re-export boundary change",
    mutateTarget: (fixture) => {
      fixture.writeFile(
        "packages/provider/src/alternate.ts",
        [
          "export function normalizeOrder(raw: string): string {",
          "  return raw.trim().toLowerCase();",
          "}",
          "",
        ].join("\n"),
      );
      replaceInFixture(
        fixture,
        "packages/provider/src/index.ts",
        '"./normalize"',
        '"./alternate"',
      );
      return fixture.commit("change admitted provider re-export boundary");
    },
    expected: { totalUnits: 3, rebuiltUnits: 2, reusedUnits: 1 },
    semantic: {
      reusedRegions: { atLeast: 2 },
      stableFiles: [
        "packages/provider/src/normalize.ts",
        "packages/provider/src/version.ts",
      ],
      invalidatedFiles: ["packages/provider/src/index.ts"],
    },
  },
  {
    id: "recursive-reexport-external-alias",
    name: "recursive local re-export external alias change",
    prepareBase: (fixture) => {
      const config = JSON.parse(fixture.readFile("tsconfig.json")) as {
        compilerOptions: Record<string, unknown>;
      };
      const existingPaths = (
        typeof config.compilerOptions.paths === "object"
        && config.compilerOptions.paths !== null
      ) ? config.compilerOptions.paths as Record<string, unknown> : {};
      config.compilerOptions.baseUrl = ".";
      config.compilerOptions.paths = {
        ...existingPaths,
        "alias-one": ["packages/provider/src/reexport-shared.d.ts"],
        "alias-two": ["packages/provider/src/reexport-shared.d.ts"],
      };
      fixture.writeFile("tsconfig.json", `${JSON.stringify(config, null, 2)}\n`);
      fixture.writeFile(
        "packages/provider/src/reexport-a.ts",
        'export { ExternalFoo } from "./reexport-b";\n',
      );
      fixture.writeFile(
        "packages/provider/src/reexport-b.ts",
        'export { ExternalFoo } from "alias-one";\n',
      );
      fixture.writeFile(
        "packages/provider/src/reexport-consumer.ts",
        [
          'import { ExternalFoo } from "./reexport-a";',
          "export const selectedExternal = ExternalFoo;",
          "",
        ].join("\n"),
      );
      fixture.writeFile(
        "packages/provider/src/reexport-shared.d.ts",
        "export declare class ExternalFoo {}\n",
      );
      return fixture.commit("prepare recursive re-export external alias");
    },
    mutateTarget: (fixture) => {
      replaceInFixture(
        fixture,
        "packages/provider/src/reexport-b.ts",
        '"alias-one"',
        '"alias-two"',
      );
      return fixture.commit("change recursive re-export external alias");
    },
    expected: { totalUnits: 3, rebuiltUnits: 1, reusedUnits: 2 },
    semantic: {
      reusedRegions: 3,
      stableFiles: [
        "packages/provider/src/index.ts",
        "packages/provider/src/normalize.ts",
        "packages/provider/src/version.ts",
      ],
      invalidatedFiles: [
        "packages/provider/src/reexport-a.ts",
        "packages/provider/src/reexport-b.ts",
        "packages/provider/src/reexport-consumer.ts",
      ],
    },
  },
  {
    id: "root-tsconfig",
    name: "root tsconfig change",
    mutateTarget: (fixture) => {
      const config = JSON.parse(fixture.readFile("tsconfig.json")) as {
        compilerOptions: Record<string, unknown>;
      };
      config.compilerOptions.useDefineForClassFields = true;
      fixture.writeFile("tsconfig.json", `${JSON.stringify(config, null, 2)}\n`);
      return fixture.commit("change admitted root compiler configuration");
    },
    expected: { totalUnits: 3, rebuiltUnits: 3, reusedUnits: 0 },
  },
  {
    id: "package-tsconfig",
    name: "package tsconfig extends-chain change",
    prepareBase: (fixture) => {
      fixture.writeFile(
        "configs/provider-base.json",
        '{"compilerOptions":{"target":"ES2022","useDefineForClassFields":false}}\n',
      );
      fixture.writeFile(
        "packages/provider/tsconfig.json",
        '{"extends":"../../configs/provider-base.json","compilerOptions":{"module":"ESNext"}}\n',
      );
      return fixture.commit("prepare admitted provider compiler configuration");
    },
    mutateTarget: (fixture) => {
      fixture.writeFile(
        "configs/provider-base.json",
        '{"compilerOptions":{"target":"ES2022","useDefineForClassFields":true}}\n',
      );
      return fixture.commit("change admitted provider compiler configuration");
    },
    expected: { totalUnits: 3, rebuiltUnits: 1, reusedUnits: 2 },
  },
  {
    id: "declare-global-augmentation",
    name: "declare-global augmentation provider change",
    prepareBase: (fixture) => {
      fixture.writeFile(
        "packages/provider/src/global-augmentation.ts",
        [
          "export {};",
          "declare global {",
          "  interface String {",
          "    fixtureLabel(): string;",
          "  }",
          "}",
          "",
        ].join("\n"),
      );
      fixture.writeFile(
        "packages/provider/src/global-consumer.ts",
        [
          "export function readFixtureLabel(value: string): string {",
          "  return value.fixtureLabel();",
          "}",
          "",
        ].join("\n"),
      );
      return fixture.commit("prepare admitted declare-global augmentation");
    },
    mutateTarget: (fixture) => {
      replaceInFixture(
        fixture,
        "packages/provider/src/global-augmentation.ts",
        "fixtureLabel(): string;",
        "fixtureLabel(): number;",
      );
      return fixture.commit("change admitted declare-global augmentation");
    },
    expected: { totalUnits: 3, rebuiltUnits: 1, reusedUnits: 2 },
    semantic: {
      reusedRegions: 3,
      stableFiles: [
        "packages/provider/src/index.ts",
        "packages/provider/src/normalize.ts",
        "packages/provider/src/version.ts",
      ],
      invalidatedFiles: [
        "packages/provider/src/global-augmentation.ts",
        "packages/provider/src/global-consumer.ts",
      ],
    },
  },
  {
    id: "ambient-shorthand-value-symbol",
    name: "ambient shorthand value-symbol appearance",
    prepareBase: (fixture) => {
      fixture.writeFile(
        "packages/provider/src/shorthand-provider.ts",
        [
          "export function makeBinding() {",
          "  return { ambientReplay };",
          "}",
          "export const shorthandBinding = makeBinding();",
          "",
        ].join("\n"),
      );
      fixture.writeFile(
        "packages/provider/src/shorthand-consumer.ts",
        [
          'import { shorthandBinding } from "./shorthand-provider";',
          "export function invokeShorthand(): void {",
          "  shorthandBinding.ambientReplay();",
          "}",
          "",
        ].join("\n"),
      );
      return fixture.commit("prepare admitted shorthand value-symbol dependency");
    },
    mutateTarget: (fixture) => {
      fixture.writeFile(
        "packages/provider/src/shorthand-global.ts",
        "declare function ambientReplay(): void;\n",
      );
      return fixture.commit("declare ambient shorthand value symbol");
    },
    expected: { totalUnits: 3, rebuiltUnits: 1, reusedUnits: 2 },
    semantic: {
      reusedRegions: 3,
      stableFiles: [
        "packages/provider/src/index.ts",
        "packages/provider/src/normalize.ts",
        "packages/provider/src/version.ts",
      ],
      invalidatedFiles: [
        "packages/provider/src/shorthand-consumer.ts",
        "packages/provider/src/shorthand-provider.ts",
      ],
    },
  },
  {
    id: "module-augmentation",
    name: "module augmentation provider change",
    prepareBase: (fixture) => {
      fixture.writeFile(
        "packages/provider/src/augmentation-target.ts",
        [
          "export interface AugmentedContract {",
          "  label: string;",
          "}",
          "export const augmentedContract = { label: \"ready\" } as AugmentedContract;",
          "",
        ].join("\n"),
      );
      fixture.writeFile(
        "packages/provider/src/module-augmentation.ts",
        [
          'import "./augmentation-target";',
          'declare module "./augmentation-target" {',
          "  interface AugmentedContract {",
          "    revision: string;",
          "  }",
          "}",
          "export {};",
          "",
        ].join("\n"),
      );
      fixture.writeFile(
        "packages/provider/src/augmentation-consumer.ts",
        [
          'import { augmentedContract } from "./augmentation-target";',
          "export function readAugmentedRevision(): string {",
          "  return augmentedContract.revision;",
          "}",
          "",
        ].join("\n"),
      );
      return fixture.commit("prepare admitted module augmentation");
    },
    mutateTarget: (fixture) => {
      replaceInFixture(
        fixture,
        "packages/provider/src/module-augmentation.ts",
        "revision: string;",
        "revision: number;",
      );
      return fixture.commit("change admitted module augmentation");
    },
    expected: { totalUnits: 3, rebuiltUnits: 1, reusedUnits: 2 },
    semantic: {
      reusedRegions: 3,
      stableFiles: [
        "packages/provider/src/index.ts",
        "packages/provider/src/normalize.ts",
        "packages/provider/src/version.ts",
      ],
      invalidatedFiles: [
        "packages/provider/src/augmentation-consumer.ts",
        "packages/provider/src/augmentation-target.ts",
        "packages/provider/src/module-augmentation.ts",
      ],
    },
  },
  {
    id: "constructed-receiver-inherited-member",
    name: "constructed receiver inherited member appearance",
    prepareBase: (fixture) => {
      fixture.writeFile(
        "packages/provider/src/constructed-base.ts",
        "export class FrameworkBase {}\n",
      );
      fixture.writeFile(
        "packages/provider/src/constructed-framework.ts",
        [
          'import { FrameworkBase } from "./constructed-base";',
          "export class ChatFramework extends FrameworkBase {}",
          "",
        ].join("\n"),
      );
      fixture.writeFile(
        "packages/provider/src/constructed-consumer.ts",
        [
          "export class DelegateClient {",
          "  private framework: any = null;",
          "  async init(): Promise<void> {",
          '    const [{ ChatFramework }] = await Promise.all([import("./constructed-framework")]);',
          "    this.framework = new ChatFramework();",
          "    await this.framework.initialize();",
          "  }",
          "}",
          "",
        ].join("\n"),
      );
      return fixture.commit("prepare admitted constructed receiver inheritance");
    },
    mutateTarget: (fixture) => {
      replaceInFixture(
        fixture,
        "packages/provider/src/constructed-base.ts",
        "export class FrameworkBase {}",
        [
          "export class FrameworkBase {",
          "  initialize(): void {}",
          "}",
        ].join("\n"),
      );
      return fixture.commit("add inherited constructed receiver member");
    },
    expected: { totalUnits: 3, rebuiltUnits: 1, reusedUnits: 2 },
    semantic: {
      reusedRegions: 3,
      stableFiles: [
        "packages/provider/src/index.ts",
        "packages/provider/src/normalize.ts",
        "packages/provider/src/version.ts",
      ],
      invalidatedFiles: [
        "packages/provider/src/constructed-base.ts",
        "packages/provider/src/constructed-framework.ts",
        "packages/provider/src/constructed-consumer.ts",
      ],
    },
  },
  {
    id: "type-only-receiver",
    name: "type-only import and inferred receiver provider change",
    prepareBase: (fixture) => {
      fixture.writeFile(
        "packages/provider/src/receiver-type.ts",
        [
          "export interface FixtureReceiver {",
          "  run(value: string): string;",
          "}",
          "",
        ].join("\n"),
      );
      fixture.writeFile(
        "packages/provider/src/receiver-consumer.ts",
        [
          'import type { FixtureReceiver } from "./receiver-type";',
          "export function invokeReceiver(receiver: FixtureReceiver): string {",
          '  return receiver.run("ready");',
          "}",
          "",
        ].join("\n"),
      );
      return fixture.commit("prepare admitted type-only receiver dependency");
    },
    mutateTarget: (fixture) => {
      replaceInFixture(
        fixture,
        "packages/provider/src/receiver-type.ts",
        "run(value: string): string;",
        "renamed(value: string): string;",
      );
      return fixture.commit("change admitted type-only receiver provider");
    },
    expected: { totalUnits: 3, rebuiltUnits: 1, reusedUnits: 2 },
    semantic: {
      reusedRegions: { atLeast: 1 },
      stableFiles: ["packages/provider/src/version.ts"],
      invalidatedFiles: [
        "packages/provider/src/receiver-type.ts",
        "packages/provider/src/receiver-consumer.ts",
      ],
    },
  },
  {
    id: "triple-slash-path",
    name: "triple-slash path provider change",
    prepareBase: (fixture) => {
      fixture.writeFile(
        "packages/provider/src/triple-provider.ts",
        'export const tripleVersion = "one";\n',
      );
      fixture.writeFile(
        "packages/provider/src/triple-consumer.ts",
        [
          '/// <reference path="./triple-provider.ts" />',
          "export function tripleConsumer(): string {",
          '  return "consumer";',
          "}",
          "",
        ].join("\n"),
      );
      return fixture.commit("prepare admitted triple-slash dependency");
    },
    mutateTarget: (fixture) => {
      replaceInFixture(
        fixture,
        "packages/provider/src/triple-provider.ts",
        '"one"',
        '"two"',
      );
      return fixture.commit("change admitted triple-slash provider");
    },
    expected: { totalUnits: 3, rebuiltUnits: 1, reusedUnits: 2 },
    semantic: {
      reusedRegions: { atLeast: 1 },
      stableFiles: ["packages/provider/src/version.ts"],
      invalidatedFiles: [
        "packages/provider/src/triple-provider.ts",
        "packages/provider/src/triple-consumer.ts",
      ],
    },
  },
  {
    id: "jsx-factory-resolution",
    name: "classic JSX factory provider change",
    prepareBase: (fixture) => {
      const config = JSON.parse(fixture.readFile("tsconfig.json")) as {
        compilerOptions: Record<string, unknown>;
        include: string[];
      };
      config.compilerOptions.jsx = "react";
      config.compilerOptions.jsxFactory = "h";
      config.include = ["packages/**/*.ts", "packages/**/*.tsx"];
      fixture.writeFile("tsconfig.json", `${JSON.stringify(config, null, 2)}\n`);
      fixture.writeFile(
        "packages/provider/src/jsx-types.d.ts",
        [
          "declare namespace JSX {",
          "  interface IntrinsicElements {",
          "    panel: Record<string, never>;",
          "  }",
          "}",
          "",
        ].join("\n"),
      );
      fixture.writeFile(
        "packages/provider/src/jsx-factory.ts",
        [
          "export interface FixtureVNode {",
          "  tag: string;",
          "}",
          "export function h(tag: string, _props: unknown): FixtureVNode {",
          "  return { tag };",
          "}",
          "",
        ].join("\n"),
      );
      fixture.writeFile(
        "packages/provider/src/jsx-view.tsx",
        [
          'import { h, type FixtureVNode } from "./jsx-factory";',
          "export function fixtureView(): FixtureVNode {",
          "  return <panel />;",
          "}",
          "",
        ].join("\n"),
      );
      return fixture.commit("prepare admitted classic JSX factory dependency");
    },
    mutateTarget: (fixture) => {
      replaceInFixture(
        fixture,
        "packages/provider/src/jsx-factory.ts",
        "tag: string;",
        "tag: number;",
      );
      return fixture.commit("change admitted classic JSX factory provider");
    },
    expected: { totalUnits: 3, rebuiltUnits: 1, reusedUnits: 2 },
    semantic: {
      reusedRegions: { atLeast: 1 },
      stableFiles: ["packages/provider/src/version.ts"],
      invalidatedFiles: [
        "packages/provider/src/jsx-factory.ts",
        "packages/provider/src/jsx-view.tsx",
      ],
    },
  },
  {
    id: "cross-file-declaration-merging",
    name: "cross-file declaration merging provider change",
    prepareBase: (fixture) => {
      fixture.writeFile(
        "packages/provider/src/merge-label.ts",
        [
          "interface FixtureMergedContract {",
          "  label: string;",
          "}",
          "",
        ].join("\n"),
      );
      fixture.writeFile(
        "packages/provider/src/merge-count.ts",
        [
          "interface FixtureMergedContract {",
          "  count: number;",
          "}",
          "",
        ].join("\n"),
      );
      fixture.writeFile(
        "packages/provider/src/merge-consumer.ts",
        [
          "export function mergedCount(value: FixtureMergedContract): number {",
          "  return value.count;",
          "}",
          "",
        ].join("\n"),
      );
      return fixture.commit("prepare admitted cross-file declaration merging");
    },
    mutateTarget: (fixture) => {
      replaceInFixture(
        fixture,
        "packages/provider/src/merge-count.ts",
        "count: number;",
        "count: string;",
      );
      return fixture.commit("change admitted merged declaration provider");
    },
    expected: { totalUnits: 3, rebuiltUnits: 1, reusedUnits: 2 },
    semantic: {
      reusedRegions: 3,
      stableFiles: [
        "packages/provider/src/index.ts",
        "packages/provider/src/normalize.ts",
        "packages/provider/src/version.ts",
      ],
      invalidatedFiles: [
        "packages/provider/src/merge-consumer.ts",
        "packages/provider/src/merge-count.ts",
        "packages/provider/src/merge-label.ts",
      ],
    },
  },
  {
    id: "umd-global-provider",
    name: "UMD export-as-namespace provider change",
    prepareBase: (fixture) => {
      fixture.writeFile(
        "packages/provider/src/umd.ts",
        [
          "export as namespace FixtureUmd;",
          "export = FixtureUmd;",
          "declare namespace FixtureUmd {",
          "  function run(): string;",
          "}",
          "",
        ].join("\n"),
      );
      fixture.writeFile(
        "packages/provider/src/umd-consumer.ts",
        "export const umdValue = FixtureUmd.run();\n",
      );
      return fixture.commit("prepare admitted UMD global dependency");
    },
    mutateTarget: (fixture) => {
      replaceInFixture(
        fixture,
        "packages/provider/src/umd.ts",
        "function run(): string;",
        "function renamed(): string;",
      );
      return fixture.commit("change admitted UMD global provider");
    },
    expected: { totalUnits: 3, rebuiltUnits: 1, reusedUnits: 2 },
    semantic: {
      reusedRegions: 4,
      stableFiles: [
        "packages/provider/src/index.ts",
        "packages/provider/src/normalize.ts",
        "packages/provider/src/umd-consumer.ts",
        "packages/provider/src/version.ts",
      ],
      invalidatedFiles: ["packages/provider/src/umd.ts"],
    },
  },
];

describe("trusted cold-oracle shard admission", { timeout: 60_000 }, () => {
  let fixture: GitMonorepoFixture;
  let signer: RevisionShardAdmissionSigner;
  let verifier: RevisionShardAdmissionVerifier;

  beforeEach(() => {
    fixture = createGitMonorepoFixture();
    ({ signer, verifier } = authority());
  });

  afterEach(() => {
    fixture.cleanup();
  });

  it("admits exact per-unit cold parity and reuses it with verifier-only authority", async () => {
    const revision = prepareLookupFreeRevision(fixture, "prepare exact-revision fast path");
    const request = fixtureRequest(fixture, revision);
    const shadow = await extractRevisionDifferential(request, { admissionSigner: signer });
    const admitted = await extractRevisionCandidate(request, {
      requiredAdmission: verifier,
    });

    expect(shadow.incremental.metrics.rebuiltUnits).toBe(shadow.incremental.metrics.totalUnits);
    expect(shadow.cold.manifestPath).toBeNull();
    expect(admitted.metrics).toMatchObject({
      rebuiltUnits: 0,
      reusedUnits: admitted.metrics.totalUnits,
      fingerprintMs: 0,
      unitExtractionMs: 0,
    });
    expect(admitted.metrics.semanticRegions.totalRegions).toBe(0);
    expect(admitted.manifest.normalizedResultDigest).toBe(
      shadow.cold.manifest.normalizedResultDigest,
    );
    expect(await listImmutableJsonCacheAddresses(
      join(fixture.cacheDir, "revision-manifest-admissions", signer.keyId),
      { trustedRoot: fixture.cacheDir },
    )).toEqual([admitted.requestKey]);
    const receiptAddresses = await listImmutableJsonCacheAddresses(
      join(fixture.cacheDir, "admissions", signer.keyId),
      { trustedRoot: fixture.cacheDir },
    );
    const expectedReceiptAddresses = [...new Set(
      shadow.incremental.manifest.units.flatMap((unit) => [
        unit.shardKey,
        ...unit.semanticRegions.map((region) => region.key),
      ]),
    )].sort();
    expect(receiptAddresses).toEqual(expectedReceiptAddresses);
  });

  it("accepts staged semantic evidence as a subset when admitted full-unit hits bypass regions", async () => {
    const request = fixtureRequest(fixture, fixture.seedRevision);
    await extractRevisionDifferential(request, { admissionSigner: signer });

    const warm = await extractRevisionDifferential(request, { admissionSigner: signer });

    expect(warm.incremental.metrics).toMatchObject({
      rebuiltUnits: 0,
      reusedUnits: warm.incremental.metrics.totalUnits,
    });
    expect(warm.incremental.metrics.semanticRegions.totalRegions).toBe(0);
    expect(warm.cold.metrics.semanticRegions.totalRegions).toBeGreaterThan(0);
    expect(warm.differential).toMatchObject({ equal: true, mismatches: [] });
  });

  it("does not publish an exact-revision fast path for an incomplete positive lookup proof", async () => {
    replaceInFixture(
      fixture,
      "packages/provider/src/index.ts",
      '"./normalize"',
      '"./normalize.ts"',
    );
    const revision = fixture.commit("use a direct TypeScript extension import");
    const request = fixtureRequest(fixture, revision);
    const shadow = await extractRevisionDifferential(request, { admissionSigner: signer });
    const provider = await admittedStoredUnit(
      fixture,
      shadow.incremental.manifest,
      "packages/provider",
    );
    const directResolution = provider.inputs.moduleResolutions.find(
      (resolution) => resolution.specifier === "./normalize.ts",
    );
    expect(directResolution).toMatchObject({
      target: { address: "repo:packages/provider/src/normalize.ts" },
      hasCompleteLookupProof: false,
    });
    expect(provider.inputs.resolutionLookupProofs.find(
      (proof) => resolutionLookupProofKey(proof) === directResolution!.resolutionLookupProofKey,
    )?.resolutionLookupInputKeys).toEqual([]);
    expect(existsSync(join(fixture.cacheDir, "revision-manifest-admissions"))).toBe(false);

    const warm = await extractRevisionCandidate(request, { requiredAdmission: verifier });
    expect(warm.metrics.fingerprintMs).toBeGreaterThan(0);
    expect(warm.metrics).toMatchObject({
      rebuiltUnits: 0,
      reusedUnits: warm.metrics.totalUnits,
    });
  });

  it("does not publish an exact-revision fast path for an external negative lookup", async () => {
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
    const revision = fixture.commit("add an external negative resolution");
    const request = fixtureRequest(fixture, revision);
    const shadow = await extractRevisionDifferential(request, { admissionSigner: signer });
    const unrelated = await admittedStoredUnit(
      fixture,
      shadow.incremental.manifest,
      "packages/unrelated",
    );
    const negative = unrelated.inputs.moduleResolutions.find(
      (resolution) => resolution.specifier === "missing-package",
    );
    expect(negative).toMatchObject({
      target: null,
      hasCompleteLookupProof: true,
    });
    expect(unrelated.inputs.resolutionLookupProofs.find(
      (proof) => resolutionLookupProofKey(proof) === negative!.resolutionLookupProofKey,
    )!.resolutionLookupInputKeys.length).toBeGreaterThan(0);
    expect(existsSync(join(fixture.cacheDir, "revision-manifest-admissions"))).toBe(false);

    const warm = await extractRevisionCandidate(request, { requiredAdmission: verifier });
    expect(warm.metrics.fingerprintMs).toBeGreaterThan(0);
    expect(warm.metrics).toMatchObject({
      rebuiltUnits: 0,
      reusedUnits: warm.metrics.totalUnits,
    });
  });

  it("owns an unresolved triple-slash input but keeps dependency lookups off the exact fast path", async () => {
    prepareLookupFreeRevision(fixture, "prepare triple-slash fast-path control");
    fixture.writeFile(
      ".gitignore",
      "packages/provider/node_modules/@types/fixture/\n",
    );
    fixture.writeFile(
      "packages/provider/src/index.ts",
      [
        '/// <reference path="../node_modules/@types/fixture/index.d.ts" />',
        'export const providerEntry = "ready";',
        "",
      ].join("\n"),
    );
    const revision = fixture.commit("add unresolved ignored triple-slash input");
    const request = fixtureRequest(fixture, revision);
    const shadow = await extractRevisionDifferential(request, { admissionSigner: signer });
    const providerManifest = shadow.incremental.manifest.units.find(
      (unit) => unit.unitId === "packages/provider",
    )!;
    expect(providerManifest.semanticPlanKind).toBe("partitioned");
    expect(providerManifest.semanticPlanReasons).toEqual([]);
    const provider = await admittedStoredUnit(
      fixture,
      shadow.incremental.manifest,
      "packages/provider",
    );
    const entry = provider.inputs.programInputs.find(
      (input) => input.address === "repo:packages/provider/src/index.ts",
    )!;
    const proof = provider.inputs.resolutionLookupProofs.find(
      (candidate) => resolutionLookupProofKey(candidate) === entry.resolutionLookupProofKey,
    )!;
    expect(proof.resolutionLookupInputKeys.map((key) => (
      provider.inputs.resolutionLookupInputs.find(
        (input) => resolutionLookupInputKey(input) === key,
      )
    ))).toContainEqual({
      address: "dependency:node_modules/@types/fixture/index.d.ts",
      purpose: "affecting",
      state: "absent",
      digest: null,
      trackedBlobOid: null,
    });
    expect(existsSync(join(fixture.cacheDir, "revision-manifest-admissions"))).toBe(false);

    fixture.writeFile(
      "packages/provider/node_modules/@types/fixture/index.d.ts",
      "declare const ignoredTripleSlashValue: string;\n",
    );
    const changedEnvironment = await extractRevisionCandidate(request, {
      requiredAdmission: verifier,
    });
    expect(changedEnvironment.metrics.fingerprintMs).toBeGreaterThan(0);
    expect(changedEnvironment.metrics.rebuiltUnits).toBeGreaterThanOrEqual(1);
    expect(changedEnvironment.manifest.units.find(
      (unit) => unit.unitId === "packages/provider",
    )?.reuseEligibility.reasons).toContain("external-dependency-program-input");
  });

  it("revalidates ignored negative manifest observations before exact-revision reuse", async () => {
    fixture.writeFile(".gitignore", "packages/provider/src/package.json\n");
    const revision = prepareLookupFreeRevision(
      fixture,
      "ignore a future nested package manifest",
    );
    const request = fixtureRequest(fixture, revision);
    const shadow = await extractRevisionDifferential(request, { admissionSigner: signer });
    const provider = await admittedStoredUnit(
      fixture,
      shadow.incremental.manifest,
      "packages/provider",
    );
    expect(provider.inputs.filesystemInputs).toContainEqual({
      address: "repo:packages/provider/src/package.json",
      digest: null,
      kind: "package-manifest",
      trackedBlobOid: null,
    });
    expect(await listImmutableJsonCacheAddresses(
      join(fixture.cacheDir, "revision-manifest-admissions", signer.keyId),
      { trustedRoot: fixture.cacheDir },
    )).toHaveLength(1);

    fixture.writeFile("packages/provider/src/package.json", '{"type":"module"}\n');
    const changedEnvironment = await extractRevisionCandidate(request, {
      requiredAdmission: verifier,
    });
    expect(changedEnvironment.metrics.fingerprintMs).toBeGreaterThan(0);
    expect(changedEnvironment.metrics.rebuiltUnits).toBeGreaterThanOrEqual(1);
    expect(changedEnvironment.manifest.units.some(
      (unit) => unit.reuseEligibility.reasons.includes("non-tree-package-manifest"),
    )).toBe(true);
  });

  it("rejects an exact hit when an ignored extensionless config shadows admitted .json extends", async () => {
    fixture.writeFile(".gitignore", "configs/exact-base\n");
    fixture.writeFile(
      "configs/exact-base.json",
      '{"compilerOptions":{"strictPropertyInitialization":true}}\n',
    );
    const config = JSON.parse(fixture.readFile("tsconfig.json")) as Record<string, unknown>;
    config.extends = "./configs/exact-base";
    fixture.writeFile("tsconfig.json", `${JSON.stringify(config, null, 2)}\n`);
    const revision = prepareLookupFreeRevision(
      fixture,
      "prepare exact local config resolution",
    );
    const request = fixtureRequest(fixture, revision);
    await extractRevisionDifferential(request, { admissionSigner: signer });
    expect(await listImmutableJsonCacheAddresses(
      join(fixture.cacheDir, "revision-manifest-admissions", signer.keyId),
      { trustedRoot: fixture.cacheDir },
    )).toHaveLength(1);

    fixture.writeFile(
      "configs/exact-base",
      '{"compilerOptions":{"strictPropertyInitialization":false}}\n',
    );
    expect(fixture.currentRevision().treeOid).toBe(revision.treeOid);
    const changedEnvironment = await extractRevisionCandidate(request, {
      requiredAdmission: verifier,
    });
    expect(changedEnvironment.metrics.fingerprintMs).toBeGreaterThan(0);
    expect(changedEnvironment.metrics.rebuiltUnits).toBeGreaterThanOrEqual(1);
    expect(changedEnvironment.manifest.units.every(
      (unit) => unit.reuseEligibility.reasons.includes("untracked-config-input"),
    )).toBe(true);

    const cold = await extractRevisionCandidate({
      ...request,
      cacheDir: join(dirname(fixture.cacheDir), "oracle-config-resolution-priority"),
    });
    expectExactCandidateParity(changedEnvironment, cold);
    expect(fixture.currentRevision().treeOid).toBe(revision.treeOid);
  });

  it("rejects exact-revision reuse when an ignored root source extends the Program", async () => {
    fixture.writeFile(".gitignore", "packages/unrelated/src/ignored-extra.ts\n");
    const revision = prepareLookupFreeRevision(
      fixture,
      "ignore a future TypeScript root source",
    );
    const request = fixtureRequest(fixture, revision);
    await extractRevisionDifferential(request, { admissionSigner: signer });
    expect(await listImmutableJsonCacheAddresses(
      join(fixture.cacheDir, "revision-manifest-admissions", signer.keyId),
      { trustedRoot: fixture.cacheDir },
    )).toHaveLength(1);

    fixture.writeFile(
      "packages/unrelated/src/ignored-extra.ts",
      "export function ignoredExtra(): string {\n  return \"observed\";\n}\n",
    );
    await expect(extractRevisionCandidate(request, {
      requiredAdmission: verifier,
    })).rejects.toThrow(
      "selected TypeScript source is not an exact Git-tree blob: "
      + "packages/unrelated/src/ignored-extra.ts",
    );
  });

  it("treats a corrupt exact-request index as a miss and repairs it after cold parity", async () => {
    const revision = prepareLookupFreeRevision(
      fixture,
      "prepare corrupt exact-request index repair",
    );
    const request = fixtureRequest(fixture, revision);
    await extractRevisionDifferential(request, { admissionSigner: signer });
    const indexRoot = join(
      fixture.cacheDir,
      "revision-manifest-admissions",
      signer.keyId,
    );
    const requestKeys = await listImmutableJsonCacheAddresses(indexRoot, {
      trustedRoot: fixture.cacheDir,
    });
    expect(requestKeys).toHaveLength(1);
    const requestKey = requestKeys[0]!;
    const indexPath = immutableJsonCachePath(indexRoot, requestKey);
    chmodSync(indexPath, 0o600);
    writeFileSync(indexPath, "corrupt");

    const fallback = await extractRevisionCandidate(request, {
      requiredAdmission: verifier,
    });
    expect(fallback.metrics.fingerprintMs).toBeGreaterThan(0);
    expect(fallback.metrics).toMatchObject({
      rebuiltUnits: 0,
      reusedUnits: fallback.metrics.totalUnits,
    });

    await expect(extractRevisionDifferential(request, {
      admissionSigner: signer,
    })).resolves.toMatchObject({ differential: { equal: true } });
    const repaired = await extractRevisionCandidate(request, {
      requiredAdmission: verifier,
    });
    expect(repaired.metrics).toMatchObject({
      fingerprintMs: 0,
      unitExtractionMs: 0,
      rebuiltUnits: 0,
      reusedUnits: repaired.metrics.totalUnits,
    });
    expect(readdirSync(join(fixture.cacheDir, ".retention-trash", "repair")).length)
      .toBeGreaterThanOrEqual(1);
  });

  it.each(ADMITTED_REVISION_CASES)(
    "matches an empty-cache oracle across verifier-only $name",
    async (scenario) => {
      const base = scenario.prepareBase?.(fixture) ?? fixture.seedRevision;
      const admittedBase = await extractRevisionDifferential(
        fixtureRequest(fixture, base),
        { admissionSigner: signer },
      );
      const target = scenario.mutateTarget(fixture);
      const request = fixtureRequest(fixture, target);

      const admitted = await extractRevisionCandidate(request, {
        requiredAdmission: verifier,
      });
      const cold = await extractRevisionCandidate({
        ...request,
        cacheDir: join(dirname(fixture.cacheDir), `oracle-${scenario.id}`),
      });

      expect(admitted.metrics).toMatchObject({
        totalUnits: scenario.expected.totalUnits,
        rebuiltUnits: scenario.expected.rebuiltUnits,
        reusedUnits: scenario.expected.reusedUnits,
      });
      expectSemanticScenarioParity(
        scenario,
        admittedBase.incremental.manifest,
        admitted,
      );
      expectExactCandidateParity(admitted, cold);
    },
  );

  it("reuses admitted shards for two different histories reaching the same target tree", async () => {
    const providerOriginal = fixture.readFile("packages/provider/src/version.ts");
    fixture.writeFile(
      "packages/provider/src/version.ts",
      'export const providerVersion = "temporary-a";\n',
    );
    fixture.commit("history a intermediate");
    fixture.writeFile("packages/provider/src/version.ts", providerOriginal);
    replaceInFixture(
      fixture,
      "packages/consumer/src/index.ts",
      "/api/orders",
      "/api/orders/v2",
    );
    const admittedBase = fixture.commit("history a target");
    await extractRevisionDifferential(
      fixtureRequest(fixture, admittedBase),
      { admissionSigner: signer },
    );

    fixture.checkoutExact(fixture.seedRevision);
    fixture.writeFile(
      "packages/consumer/src/temporary-b.ts",
      "export const temporary = true;\n",
    );
    fixture.commit("history b intermediate");
    fixture.removeFile("packages/consumer/src/temporary-b.ts");
    replaceInFixture(
      fixture,
      "packages/consumer/src/index.ts",
      "/api/orders",
      "/api/orders/v2",
    );
    const target = fixture.commit("history b target");
    expect(target.commitOid).not.toBe(admittedBase.commitOid);
    expect(target.treeOid).toBe(admittedBase.treeOid);

    const request = fixtureRequest(fixture, target);
    const admitted = await extractRevisionCandidate(request, {
      requiredAdmission: verifier,
    });
    const cold = await extractRevisionCandidate({
      ...request,
      cacheDir: join(dirname(fixture.cacheDir), "oracle-two-histories"),
    });
    expect(admitted.metrics).toMatchObject({
      totalUnits: 3,
      rebuiltUnits: 0,
      reusedUnits: 3,
    });
    expectExactCandidateParity(admitted, cold);
  });

  it("keeps staged bytes untrusted until cold graph and per-unit parity publish admission", async () => {
    const revision = prepareLookupFreeRevision(
      fixture,
      "prepare staged exact-revision lifecycle",
    );
    const request = fixtureRequest(fixture, revision);
    const candidate = await extractRevisionCandidate(request, {
      requiredAdmission: signer,
    });
    const staged = await stageRevisionCandidateForAdmission(
      fixture.cacheDir,
      candidate,
      signer,
    );

    expect(existsSync(join(fixture.cacheDir, "shards"))).toBe(true);
    expect(existsSync(join(fixture.cacheDir, "candidates"))).toBe(true);
    expect(existsSync(join(fixture.cacheDir, "admissions"))).toBe(false);
    expect(existsSync(join(fixture.cacheDir, "manifests"))).toBe(false);
    expect(existsSync(join(fixture.cacheDir, "revision-manifest-admissions"))).toBe(false);
    const beforeOracle = await extractRevisionCandidate(request, {
      requiredAdmission: verifier,
    });
    expect(beforeOracle.metrics).toMatchObject({
      rebuiltUnits: beforeOracle.metrics.totalUnits,
      reusedUnits: 0,
    });

    const coldCacheDir = join(dirname(fixture.cacheDir), "staged-lifecycle-oracle");
    const cold = await extractRevisionCandidate({
      ...request,
      cacheDir: coldCacheDir,
    });
    await publishRevisionCandidate(coldCacheDir, cold);
    expect(compareExtractionResults(candidate.result, cold.result)).toMatchObject({
      equal: true,
      mismatches: [],
    });
    const publication = await publishStagedRevisionAdmission(
      fixture.cacheDir,
      staged,
      signer,
      coldCacheDir,
      cold,
    );
    expect(publication.differential).toMatchObject({ equal: true, mismatches: [] });
    expect(publication.run.manifestPath).toContain("/manifests/");
    expect(existsSync(join(fixture.cacheDir, "admissions", signer.keyId))).toBe(true);
    expect(await listImmutableJsonCacheAddresses(
      join(fixture.cacheDir, "revision-manifest-admissions", signer.keyId),
      { trustedRoot: fixture.cacheDir },
    )).toEqual([candidate.requestKey]);

    const afterOracle = await extractRevisionCandidate(request, {
      requiredAdmission: verifier,
    });
    expect(afterOracle.metrics).toMatchObject({
      rebuiltUnits: 0,
      reusedUnits: afterOracle.metrics.totalUnits,
      fingerprintMs: 0,
      unitExtractionMs: 0,
    });
    expectExactCandidateParity(afterOracle, cold);
  });

  it("refuses admission when the supplied oracle reports any cache reuse", async () => {
    const revision = prepareLookupFreeRevision(
      fixture,
      "prepare non-cold oracle rejection",
    );
    const request = fixtureRequest(fixture, revision);
    const candidate = await extractRevisionCandidate(request, {
      requiredAdmission: signer,
    });
    const staged = await stageRevisionCandidateForAdmission(
      fixture.cacheDir,
      candidate,
      signer,
    );
    const coldCacheDir = join(dirname(fixture.cacheDir), "non-cold-oracle");
    const cold = await extractRevisionCandidate({
      ...request,
      cacheDir: coldCacheDir,
    });
    const nonCold = {
      ...cold,
      metrics: {
        ...cold.metrics,
        rebuiltUnits: cold.metrics.totalUnits - 1,
        reusedUnits: 1,
      },
    };

    await expect(publishStagedRevisionAdmission(
      fixture.cacheDir,
      staged,
      signer,
      coldCacheDir,
      nonCold,
    )).rejects.toThrow("admission oracle was not extracted with an empty cache");
    expect(existsSync(join(fixture.cacheDir, "admissions"))).toBe(false);
    expect(existsSync(join(fixture.cacheDir, "manifests"))).toBe(false);
  });

  it("reuses verifier-admitted base shards in a genuinely fresh target process", async () => {
    await extractRevisionDifferential(
      fixtureRequest(fixture, fixture.seedRevision),
      { admissionSigner: signer },
    );
    replaceInFixture(
      fixture,
      "packages/consumer/src/index.ts",
      "normalizeOrder(raw)",
      "normalizeOrder(normalizeOrder(raw))",
    );
    const target = fixture.commit("fresh admitted process target");
    const request = fixtureRequest(fixture, target);
    const requestPath = join(dirname(fixture.cacheDir), "admitted-worker-request.json");
    writeFileSync(requestPath, JSON.stringify({ request, verifier }));

    const worker = runAdmittedWorker(requestPath);
    const cold = await extractRevisionCandidate({
      ...request,
      cacheDir: join(dirname(fixture.cacheDir), "fresh-process-oracle"),
    });

    expect(worker.metrics.processId).not.toBe(process.pid);
    expect(worker.metrics).toMatchObject({
      totalUnits: 3,
      rebuiltUnits: 1,
      reusedUnits: 2,
    });
    expectWorkerParity(worker, cold);
  });

  it("rejects a forged self-consistent shard envelope when its receipt no longer matches", async () => {
    const request = fixtureRequest(fixture, fixture.seedRevision);
    const shadow = await extractRevisionDifferential(request, { admissionSigner: signer });
    const target = shadow.incremental.manifest.units[0]!;
    const shardPath = immutableJsonCachePath(
      join(fixture.cacheDir, "shards"),
      target.shardKey,
    );
    const envelope = JSON.parse(readFileSync(shardPath, "utf8")) as {
      payloadDigest: string;
      value: {
        extraction: {
          nodes: Array<{ displayName: string }>;
        };
      };
    };
    envelope.value.extraction.nodes[0]!.displayName += " forged";
    envelope.payloadDigest = canonicalJsonSha256(envelope.value);
    chmodSync(shardPath, 0o600);
    writeFileSync(shardPath, canonicalJson(envelope));
    chmodSync(shardPath, 0o400);

    const admitted = await extractRevisionCandidate(request, {
      requiredAdmission: verifier,
    });
    expect(admitted.metrics.rebuiltUnits).toBeGreaterThanOrEqual(1);
    expect(admitted.metrics.reusedUnits).toBeLessThan(admitted.metrics.totalUnits);
    expect(admitted.manifest.normalizedResultDigest).toBe(
      shadow.cold.manifest.normalizedResultDigest,
    );

    await expect(extractRevisionDifferential(request, {
      admissionSigner: signer,
    })).resolves.toMatchObject({
      differential: { equal: true },
    });
    const repaired = await extractRevisionCandidate(request, {
      requiredAdmission: verifier,
    });
    expect(repaired.metrics).toMatchObject({
      rebuiltUnits: 0,
      reusedUnits: repaired.metrics.totalUnits,
    });
    expect(readdirSync(join(fixture.cacheDir, ".retention-trash", "repair")).length)
      .toBeGreaterThanOrEqual(1);
  });

  it("does not publish canonical misses from admitted mode", async () => {
    const request = fixtureRequest(fixture, fixture.seedRevision);
    const admitted = await extractRevisionCandidate(request, {
      requiredAdmission: verifier,
    });

    expect(admitted.metrics).toMatchObject({
      reusedUnits: 0,
      rebuiltUnits: admitted.metrics.totalUnits,
    });
    expect(admitted.pendingShards).toHaveLength(admitted.metrics.totalUnits);
    expect(readdirSync(fixture.cacheDir)).toEqual([]);
  });

  it("ignores a pre-receipt cache even when its content hashes are valid", async () => {
    const request = fixtureRequest(fixture, fixture.seedRevision);
    await extractRevisionWithCache(request);
    const admitted = await extractRevisionCandidate(request, {
      requiredAdmission: verifier,
    });

    expect(admitted.metrics).toMatchObject({
      reusedUnits: 0,
      rebuiltUnits: admitted.metrics.totalUnits,
    });
  });

  it("treats a corrupt receipt as a miss and lets a later shadow run repair it", async () => {
    const request = fixtureRequest(fixture, fixture.seedRevision);
    const shadow = await extractRevisionDifferential(request, { admissionSigner: signer });
    const shardKey = shadow.incremental.manifest.units[0]!.shardKey;
    const receiptPath = immutableJsonCachePath(
      join(fixture.cacheDir, "admissions", signer.keyId),
      shardKey,
    );
    chmodSync(receiptPath, 0o600);
    writeFileSync(receiptPath, "corrupt");

    const missed = await extractRevisionCandidate(request, {
      requiredAdmission: verifier,
    });
    expect(missed.metrics.rebuiltUnits).toBeGreaterThanOrEqual(1);
    await expect(extractRevisionDifferential(request, {
      admissionSigner: signer,
    })).resolves.toMatchObject({ differential: { equal: true } });
    const repaired = await extractRevisionCandidate(request, {
      requiredAdmission: verifier,
    });
    expect(repaired.metrics.reusedUnits).toBe(repaired.metrics.totalUnits);
  });

  it("repairs corrupt semantic context, region, and receipt bytes during shadow admission", async () => {
    const baseRequest = fixtureRequest(fixture, fixture.seedRevision);
    const base = await extractRevisionDifferential(baseRequest, { admissionSigner: signer });
    const consumer = base.incremental.manifest.units.find(
      (unit) => unit.unitId === "packages/consumer",
    )!;
    const region = consumer.semanticRegions.find(
      (entry) => entry.files.includes("packages/consumer/src/index.ts"),
    )!;
    const corruptPaths = [
      immutableJsonCachePath(
        join(fixture.cacheDir, "semantic-region-contexts"),
        consumer.semanticRegionContextDigest,
      ),
      immutableJsonCachePath(
        join(
          fixture.cacheDir,
          "semantic-region-shards",
          consumer.semanticRegionContextDigest,
        ),
        region.key,
      ),
      immutableJsonCachePath(
        join(fixture.cacheDir, "admissions", signer.keyId),
        region.key,
      ),
    ];
    for (const path of corruptPaths) {
      chmodSync(path, 0o600);
      writeFileSync(path, "corrupt");
    }

    fixture.writeFile(
      "packages/consumer/src/status.ts",
      'export function statusLabel(ok: boolean): string {\n  return ok ? "ok" : "failed";\n}\n',
    );
    const target = fixture.commit("repair semantic cache while adding a region");
    await expect(extractRevisionDifferential(
      fixtureRequest(fixture, target),
      { admissionSigner: signer },
    )).resolves.toMatchObject({ differential: { equal: true } });

    replaceInFixture(
      fixture,
      "packages/consumer/src/status.ts",
      '"failed"',
      '"not-ready"',
    );
    const next = fixture.commit("reuse repaired semantic cache");
    const admitted = await extractRevisionCandidate(fixtureRequest(fixture, next), {
      requiredAdmission: verifier,
    });
    expect(admitted.metrics.semanticRegions).toMatchObject({
      totalRegions: 2,
      reusedRegions: 1,
      rebuiltRegions: 1,
    });
    expect(readdirSync(join(fixture.cacheDir, ".retention-trash", "repair")).length)
      .toBeGreaterThanOrEqual(3);
  });

  it("bounds candidate variants and conservatively rebuilds an overloaded unit", async () => {
    const request = fixtureRequest(fixture, fixture.seedRevision);
    const shadow = await extractRevisionDifferential(request, { admissionSigner: signer });
    const target = shadow.incremental.manifest.units[0]!;
    const shard = await readImmutableJsonCache<{
      baseInputKey: string;
      workspaceResolverTrace: unknown[];
    }>(
      join(fixture.cacheDir, "shards"),
      target.shardKey,
      { trustedRoot: fixture.cacheDir },
    );
    expect(shard).not.toBeNull();
    const candidateRoot = join(
      fixture.cacheDir,
      "candidates",
      shard!.value.baseInputKey,
    );
    for (let index = 0; index < 128; index += 1) {
      const address = canonicalJsonSha256({ overload: index });
      await writeImmutableJsonCache(candidateRoot, address, {
        version: 6,
        baseInputKey: shard!.value.baseInputKey,
        shardKey: address,
        workspaceResolverTrace: [],
      }, { trustedRoot: fixture.cacheDir });
    }

    const admitted = await extractRevisionCandidate(request, {
      requiredAdmission: verifier,
    });
    expect(admitted.metrics.rebuiltUnits).toBeGreaterThanOrEqual(1);
    expect(admitted.manifest.normalizedResultDigest).toBe(
      shadow.cold.manifest.normalizedResultDigest,
    );
  });
});

interface AdmittedWorkerReport {
  result: ExtractionResult;
  manifest: RevisionManifest;
  metrics: RevisionExtractionMetrics;
  units: Array<{
    unitId: string;
    shardKey: string;
    value: unknown;
  }>;
}

function prepareLookupFreeRevision(
  fixture: GitMonorepoFixture,
  message: string,
): GitFixtureRevision {
  fixture.writeFile(
    "packages/provider/src/index.ts",
    'export const providerEntry = "ready";\n',
  );
  fixture.writeFile(
    "packages/consumer/src/index.ts",
    [
      "export function submitOrder(raw: string): string {",
      "  return raw.trim();",
      "}",
      "",
    ].join("\n"),
  );
  return fixture.commit(message);
}

async function admittedStoredUnit(
  fixture: GitMonorepoFixture,
  manifest: RevisionManifest,
  unitId: string,
): Promise<StoredUnitShard> {
  const unit = manifest.units.find((candidate) => candidate.unitId === unitId);
  if (unit === undefined) throw new Error(`manifest unit is missing: ${unitId}`);
  const shard = await readImmutableJsonCache<StoredUnitShard>(
    join(fixture.cacheDir, "shards"),
    unit.shardKey,
    { trustedRoot: fixture.cacheDir },
  );
  if (shard === null) throw new Error(`admitted unit shard is missing: ${unitId}`);
  return shard.value;
}

function expectExactCandidateParity(
  admitted: PendingRevisionExtraction,
  cold: PendingRevisionExtraction,
): void {
  expect(compareExtractionResults(admitted.result, cold.result)).toMatchObject({
    equal: true,
    mismatches: [],
  });
  expect(canonicalJson(admitted.manifest)).toBe(canonicalJson(cold.manifest));
  expect(admitted.unitShards.map((unit) => ({
    unitId: unit.unitId,
    shardKey: unit.shardKey,
    value: canonicalJson(unit.value),
  }))).toEqual(cold.unitShards.map((unit) => ({
    unitId: unit.unitId,
    shardKey: unit.shardKey,
    value: canonicalJson(unit.value),
  })));
  expectCanonicalSubset(
    admitted.semanticRegionContexts,
    cold.semanticRegionContexts,
    (context) => context,
  );
  expectCanonicalSubset(
    admitted.semanticRegionEvidence,
    cold.semanticRegionEvidence,
    (region) => ({
      unitId: region.unitId,
      regionId: region.regionId,
      key: region.key,
      baseInputKey: region.baseInputKey,
      payloadDigest: region.payloadDigest,
      value: region.value,
    }),
  );
}

function expectSemanticScenarioParity(
  scenario: AdmittedRevisionCase,
  base: RevisionManifest,
  target: PendingRevisionExtraction,
): void {
  const semantic = scenario.semantic;
  if (semantic === undefined) return;

  if (typeof semantic.reusedRegions === "number") {
    expect(target.metrics.semanticRegions.reusedRegions)
      .toBe(semantic.reusedRegions);
  } else {
    expect(target.metrics.semanticRegions.reusedRegions)
      .toBeGreaterThanOrEqual(semantic.reusedRegions.atLeast);
  }
  expect(target.semanticRegionEvidence).not.toHaveLength(0);

  for (const file of semantic.stableFiles ?? []) {
    expect(semanticRegionKey(target.manifest, file))
      .toBe(semanticRegionKey(base, file));
  }
  for (const file of semantic.invalidatedFiles ?? []) {
    expect(semanticRegionKey(target.manifest, file))
      .not.toBe(semanticRegionKey(base, file));
  }

  if (semantic.invalidatesEveryRegionInUnit !== undefined) {
    const baseUnit = requireManifestUnit(base, semantic.invalidatesEveryRegionInUnit);
    const targetUnit = requireManifestUnit(
      target.manifest,
      semantic.invalidatesEveryRegionInUnit,
    );
    expect(targetUnit.semanticRegions.map((region) => region.regionId))
      .toEqual(baseUnit.semanticRegions.map((region) => region.regionId));
    const targetKeys = new Map(
      targetUnit.semanticRegions.map((region) => [region.regionId, region.key]),
    );
    for (const baseRegion of baseUnit.semanticRegions) {
      expect(targetKeys.get(baseRegion.regionId)).not.toBe(baseRegion.key);
    }
  }
}

function semanticRegionKey(manifest: RevisionManifest, file: string): string {
  for (const unit of manifest.units) {
    const region = unit.semanticRegions.find((candidate) => candidate.files.includes(file));
    if (region !== undefined) return region.key;
  }
  throw new Error(`semantic region is missing manifest file ${file}`);
}

function requireManifestUnit(
  manifest: RevisionManifest,
  unitId: string,
): RevisionManifest["units"][number] {
  const unit = manifest.units.find((candidate) => candidate.unitId === unitId);
  if (unit === undefined) throw new Error(`revision manifest is missing unit ${unitId}`);
  return unit;
}

function expectCanonicalSubset<T, TRecord>(
  actual: readonly T[],
  expectedSuperset: readonly T[],
  record: (entry: T) => TRecord,
): void {
  const available = new Map<string, number>();
  for (const entry of expectedSuperset) {
    const bytes = canonicalJson(record(entry));
    available.set(bytes, (available.get(bytes) ?? 0) + 1);
  }
  for (const entry of actual) {
    const bytes = canonicalJson(record(entry));
    const count = available.get(bytes) ?? 0;
    expect(count).toBeGreaterThan(0);
    if (count === 1) {
      available.delete(bytes);
    } else {
      available.set(bytes, count - 1);
    }
  }
}

function expectWorkerParity(
  worker: AdmittedWorkerReport,
  cold: PendingRevisionExtraction,
): void {
  expect(compareExtractionResults(worker.result, cold.result)).toMatchObject({
    equal: true,
    mismatches: [],
  });
  expect(canonicalJson(worker.manifest)).toBe(canonicalJson(cold.manifest));
  expect(worker.units.map((unit) => ({
    unitId: unit.unitId,
    shardKey: unit.shardKey,
    value: canonicalJson(unit.value),
  }))).toEqual(cold.unitShards.map((unit) => ({
    unitId: unit.unitId,
    shardKey: unit.shardKey,
    value: canonicalJson(unit.value),
  })));
}

function runAdmittedWorker(requestPath: string): AdmittedWorkerReport {
  const worker = fileURLToPath(new URL("./admitted-process-worker.ts", import.meta.url));
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", worker, requestPath],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `fresh admitted worker failed: ${result.stderr.trim() || `exit ${result.status}`}`,
    );
  }
  return JSON.parse(result.stdout) as AdmittedWorkerReport;
}

function authority(): {
  signer: RevisionShardAdmissionSigner;
  verifier: RevisionShardAdmissionVerifier;
} {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicDer = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  const keyId = createHash("sha256").update(publicDer).digest("hex");
  return {
    signer: {
      version: 1,
      kind: "signer",
      keyId,
      publicKeySpki: publicDer.toString("base64"),
      privateKeyPkcs8: (privateKey.export({ format: "der", type: "pkcs8" }) as Buffer)
        .toString("base64"),
    },
    verifier: {
      version: 1,
      kind: "verifier",
      keyId,
      publicKeySpki: publicDer.toString("base64"),
    },
  };
}
