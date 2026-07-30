import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { perPackageWorkspace } from "../extractor";
import { loadUnitProject } from "../project-loader";
import {
  analysisPolicy,
  extractOptions,
  extractorProvenance,
  unitInputFingerprint,
  workspaceDigest,
} from "./fingerprints";
import type { UnitInputFingerprint } from "./model";
import {
  createGitMonorepoFixture,
  type GitFixtureRevision,
  type GitMonorepoFixture,
} from "./git-fixture";
import { listGitTreeBlobs, verifyGitTreeInputs } from "./git-tree";
import {
  addressSemanticRegions,
  type AddressedSemanticRegion,
  type AddressedSemanticRegionPlan,
} from "./semantic-region-inputs";
import { fixtureRequest, replaceInFixture } from "./test-support";

const PROVIDER_INDEX = "packages/provider/src/index.ts";
const NORMALIZE = "packages/provider/src/normalize.ts";
const VERSION = "packages/provider/src/version.ts";

describe("semantic region input addressing", { timeout: 120_000 }, () => {
  let fixture: GitMonorepoFixture;

  beforeEach(() => {
    fixture = createGitMonorepoFixture();
  });

  afterEach(() => {
    fixture.cleanup();
  });

  it("derives deterministic one-file keys from target-recomputed compiler observations", async () => {
    const forward = await addressProviderUnit(fixture);
    const reversed = await addressProviderUnit(fixture, { reverseSourceFiles: true });

    expect(addressedSnapshot(reversed.plan)).toEqual(addressedSnapshot(forward.plan));
    expect(forward.plan.plan.kind).toBe("partitioned");
    expect(new Set(forward.plan.regions.map((region) => region.key)).size)
      .toBe(forward.plan.regions.length);
    for (const region of forward.plan.regions) {
      expect(region.key).toMatch(/^[a-f0-9]{64}$/);
    }

    const normalize = regionFor(forward.plan, NORMALIZE);
    const providerIndex = regionFor(forward.plan, PROVIDER_INDEX);
    expect(providerIndex.files).toEqual([PROVIDER_INDEX]);
    expect(normalize.files).toEqual([NORMALIZE]);
    expect(providerIndex.dependencyRegionIds).toEqual([]);
    expect(directProviderAddresses(providerIndex)).toContain(`repo:${NORMALIZE}`);
  });

  it("propagates provider changes to reverse consumers without invalidating unrelated providers", async () => {
    const baseline = await addressProviderUnit(fixture);

    replaceInFixture(fixture, NORMALIZE, "toUpperCase()", "toLowerCase()");
    fixture.commit("change semantic provider");
    const providerChanged = await addressProviderUnit(fixture);

    expect(fileKey(providerChanged.plan, NORMALIZE)).not.toBe(fileKey(baseline.plan, NORMALIZE));
    expect(fileKey(providerChanged.plan, PROVIDER_INDEX))
      .not.toBe(fileKey(baseline.plan, PROVIDER_INDEX));
    expect(fileKey(providerChanged.plan, VERSION)).toBe(fileKey(baseline.plan, VERSION));

    fixture.checkoutExact(fixture.seedRevision);
    fixture.writeFile(
      PROVIDER_INDEX,
      `${fixture.readFile(PROVIDER_INDEX)}// consumer-only source edit\n`,
    );
    fixture.commit("change semantic consumer only");
    const consumerChanged = await addressProviderUnit(fixture);

    expect(fileKey(consumerChanged.plan, PROVIDER_INDEX))
      .not.toBe(fileKey(baseline.plan, PROVIDER_INDEX));
    expect(fileKey(consumerChanged.plan, NORMALIZE)).toBe(fileKey(baseline.plan, NORMALIZE));
    expect(fileKey(consumerChanged.plan, VERSION)).toBe(fileKey(baseline.plan, VERSION));
  });

  it("addresses add, delete, rename, and re-export topology from the target tree", async () => {
    const baseline = await addressProviderUnit(fixture);
    const extra = "packages/provider/src/extra.ts";

    fixture.writeFile(extra, "export const extra = 1;\n");
    fixture.commit("add independent source");
    const added = await addressProviderUnit(fixture);
    expect(regionFor(added.plan, extra).files).toEqual([extra]);
    for (const path of [PROVIDER_INDEX, NORMALIZE, VERSION]) {
      expect(fileKey(added.plan, path)).toBe(fileKey(baseline.plan, path));
    }

    fixture.removeFile(extra);
    const deletion = fixture.commit("delete independent source");
    const deleted = await addressProviderUnit(fixture);
    expect(deletion.treeOid).toBe(fixture.seedRevision.treeOid);
    expect(deleted.plan.regionByFile.has(extra)).toBe(false);
    expect(addressedSnapshot(deleted.plan)).toEqual(addressedSnapshot(baseline.plan));

    fixture.checkoutExact(fixture.seedRevision);
    const renamedNormalize = "packages/provider/src/normalize-renamed.ts";
    fixture.renameFile(NORMALIZE, renamedNormalize);
    replaceInFixture(fixture, PROVIDER_INDEX, '"./normalize"', '"./normalize-renamed"');
    fixture.commit("rename provider and update re-export");
    const renamed = await addressProviderUnit(fixture);
    expect(renamed.plan.regionByFile.has(NORMALIZE)).toBe(false);
    expect(directProviderAddresses(regionFor(renamed.plan, PROVIDER_INDEX)))
      .toContain(`repo:${renamedNormalize}`);

    fixture.checkoutExact(fixture.seedRevision);
    const facade = "packages/provider/src/facade.ts";
    fixture.writeFile(facade, 'export { normalizeOrder } from "./normalize";\n');
    replaceInFixture(fixture, PROVIDER_INDEX, '"./normalize"', '"./facade"');
    fixture.commit("route provider through re-export facade");
    const reexported = await addressProviderUnit(fixture);
    const normalizeRegion = regionFor(reexported.plan, NORMALIZE);
    const facadeRegion = regionFor(reexported.plan, facade);
    const indexRegion = regionFor(reexported.plan, PROVIDER_INDEX);
    expect(directProviderAddresses(facadeRegion)).toContain(`repo:${NORMALIZE}`);
    expect(directProviderAddresses(indexRegion)).toContain(`repo:${facade}`);
    expect(normalizeRegion.dependencyRegionIds).toEqual([]);
    expect(facadeRegion.dependencyRegionIds).toEqual([]);
    expect(indexRegion.dependencyRegionIds).toEqual([]);
  });

  it("invalidates every region for configuration changes but localizes an unused global", async () => {
    const baseline = await addressProviderUnit(fixture);

    replaceInFixture(fixture, "tsconfig.json", '"strict": true', '"strict": false');
    fixture.commit("change compiler configuration");
    const configChanged = await addressProviderUnit(fixture);
    expect(configChanged.plan.contextDigest).not.toBe(baseline.plan.contextDigest);
    expectEveryBaselineKeyChanged(baseline.plan, configChanged.plan);

    fixture.checkoutExact(fixture.seedRevision);
    const ambient = "packages/provider/src/ambient.ts";
    fixture.writeFile(
      ambient,
      "interface FixtureAmbientContract { readonly marker: string; }\n",
    );
    fixture.commit("add ambient provider");
    const ambientChanged = await addressProviderUnit(fixture);
    expect(ambientChanged.plan.contextDigest).toBe(baseline.plan.contextDigest);
    for (const path of [PROVIDER_INDEX, NORMALIZE, VERSION]) {
      expect(fileKey(ambientChanged.plan, path)).toBe(fileKey(baseline.plan, path));
    }
    expect(regionFor(ambientChanged.plan, ambient).files).toEqual([ambient]);
  });

  it("does not propagate a UMD return-type change when cached edge decisions stay identical", async () => {
    const umd = "packages/provider/src/umd.ts";
    const consumer = "packages/provider/src/umd-consumer.ts";
    fixture.writeFile(
      umd,
      [
        "export as namespace FixtureUmd;",
        "export = FixtureUmd;",
        "declare function FixtureUmd(): string;",
        "",
      ].join("\n"),
    );
    fixture.writeFile(
      consumer,
      "export const umdValue = FixtureUmd();\n",
    );
    fixture.commit("add UMD ambient provider and consumer");

    const baseline = await addressProviderUnit(fixture);
    const umdRegion = regionFor(baseline.plan, umd);
    for (const path of [PROVIDER_INDEX, NORMALIZE, VERSION]) {
      expect(directProviderAddresses(regionFor(baseline.plan, path)))
        .not.toContain(`repo:${umd}`);
    }

    replaceInFixture(
      fixture,
      umd,
      "declare function FixtureUmd(): string;",
      "declare function FixtureUmd(): number;",
    );
    fixture.commit("change UMD ambient provider");
    const changed = await addressProviderUnit(fixture);
    expect(fileKey(changed.plan, umd)).not.toBe(umdRegion.key);
    for (const path of [PROVIDER_INDEX, NORMALIZE, VERSION, consumer]) {
      expect(fileKey(changed.plan, path)).toBe(fileKey(baseline.plan, path));
    }
  });

  it("does not invalidate files that do not observe a non-selected global script", async () => {
    const external = "packages/consumer/src/non-selected-globals.ts";
    fixture.writeFile(
      external,
      "interface NonSelectedGlobalContract { readonly value: string; }\n",
    );
    fixture.writeFile(
      PROVIDER_INDEX,
      [
        'import "../../consumer/src/non-selected-globals";',
        fixture.readFile(PROVIDER_INDEX),
      ].join("\n"),
    );
    fixture.commit("add reachable non-selected global script");
    const baseline = await addressProviderUnit(fixture);

    expect(baseline.plan.regionByFile.has(external)).toBe(false);
    replaceInFixture(fixture, external, "value: string", "value: number");
    fixture.commit("change non-selected global script");
    const changed = await addressProviderUnit(fixture);

    expect(fileKey(changed.plan, PROVIDER_INDEX))
      .not.toBe(fileKey(baseline.plan, PROVIDER_INDEX));
    for (const path of [NORMALIZE, VERSION]) {
      expect(fileKey(changed.plan, path)).toBe(fileKey(baseline.plan, path));
    }
  });

  it("does not universalize an unused external-module augmentation", async () => {
    const augmentation = "packages/provider/src/module-augmentation.ts";
    fixture.writeFile(
      augmentation,
      [
        "export {};",
        'declare module "./normalize" {',
        "  interface FixtureNormalizeOptions { readonly value: string; }",
        "}",
        "",
      ].join("\n"),
    );
    fixture.commit("add external module augmentation");
    const baseline = await addressProviderUnit(fixture);

    replaceInFixture(fixture, augmentation, "value: string", "value: number");
    fixture.commit("change external module augmentation");
    const changed = await addressProviderUnit(fixture);

    expect(fileKey(changed.plan, augmentation))
      .not.toBe(fileKey(baseline.plan, augmentation));
    expect(fileKey(changed.plan, VERSION)).toBe(fileKey(baseline.plan, VERSION));
    expect(fileKey(changed.plan, NORMALIZE))
      .not.toBe(fileKey(baseline.plan, NORMALIZE));
    expect(fileKey(changed.plan, PROVIDER_INDEX))
      .not.toBe(fileKey(baseline.plan, PROVIDER_INDEX));
  });

  it("keeps a triple-slash lib consumer as an independently addressed file", async () => {
    const consumer = "packages/provider/src/lib-reference.ts";
    fixture.writeFile(
      consumer,
      [
        '/// <reference lib="es2022.string" />',
        "export const libReferenceConsumer = true;",
        "",
      ].join("\n"),
    );
    fixture.commit("add lib reference");
    const addressed = await addressProviderUnit(fixture);

    expect(addressed.plan.plan.kind).toBe("partitioned");
    expect(regionFor(addressed.plan, consumer)).toMatchObject({
      files: [consumer],
      dependencyRegionIds: [],
    });
  });

  it("invalidates only observations that directly consume a changed default-library input", async () => {
    const baseline = await addressProviderUnit(fixture);
    const changed = await addressProviderUnit(fixture, {
      mutateInputs: (inputs) => {
        const defaultLibraries = inputs.programInputs.filter(
          (input) => input.isDefaultLibrary,
        );
        if (defaultLibraries.length === 0) {
          throw new Error("fixture Program is missing its default library");
        }
        for (const defaultLibrary of defaultLibraries) {
          defaultLibrary.digest = "synthetic-default-library-change";
        }
      },
    });

    expect(changed.plan.contextDigest).toBe(baseline.plan.contextDigest);
    expect(fileKey(changed.plan, NORMALIZE)).not.toBe(fileKey(baseline.plan, NORMALIZE));
    expect(fileKey(changed.plan, VERSION)).toBe(fileKey(baseline.plan, VERSION));
  });

  it("addresses compiler triple-slash path directives that ts-morph import literals omit", async () => {
    const provider = "packages/provider/src/triple-provider.ts";
    const consumer = "packages/provider/src/triple-consumer.ts";
    fixture.writeFile(provider, 'export const tripleVersion = "one";\n');
    fixture.writeFile(
      consumer,
      [
        '/// <reference path="./triple-provider.ts" />',
        "export const tripleConsumer = true;",
        "",
      ].join("\n"),
    );
    fixture.commit("add triple-slash path dependency");

    const baseline = await addressProviderUnit(fixture);
    expect(regionFor(baseline.plan, consumer).dependencyRegionIds).toEqual([]);

    replaceInFixture(fixture, provider, '"one"', '"two"');
    fixture.commit("change triple-slash path provider");
    const changed = await addressProviderUnit(fixture);
    expect(fileKey(changed.plan, provider)).not.toBe(fileKey(baseline.plan, provider));
    expect(fileKey(changed.plan, consumer)).not.toBe(fileKey(baseline.plan, consumer));
    expect(fileKey(changed.plan, VERSION)).toBe(fileKey(baseline.plan, VERSION));
  });

  it("owns an absent triple-slash lookup and invalidates only its consumer when it appears", async () => {
    const consumer = "packages/provider/src/future-triple-consumer.ts";
    const provider = "packages/provider/src/future-triple-provider.ts";
    fixture.writeFile(
      consumer,
      [
        '/// <reference path="./future-triple-provider.ts" />',
        "export const futureTripleConsumer = true;",
        "",
      ].join("\n"),
    );
    fixture.commit("add absent triple-slash provider");
    const absent = await addressProviderUnit(fixture);

    expect(absent.plan.plan.kind).toBe("partitioned");
    const consumerBefore = fileKey(absent.plan, consumer);
    const versionBefore = fileKey(absent.plan, VERSION);

    fixture.writeFile(
      provider,
      "export interface FutureTripleProvider { readonly value: string; }\n",
    );
    fixture.commit("materialize triple-slash provider");
    const present = await addressProviderUnit(fixture);

    expect(present.plan.plan.kind).toBe("partitioned");
    expect(fileKey(present.plan, consumer)).not.toBe(consumerBefore);
    expect(fileKey(present.plan, VERSION)).toBe(versionBefore);
    expect(regionFor(present.plan, consumer).dependencyRegionIds).toEqual([]);
  });

  it("fails closed when an owned triple-slash proof is dangling", async () => {
    const consumer = "packages/provider/src/dangling-triple-consumer.ts";
    fixture.writeFile(
      consumer,
      [
        '/// <reference path="./missing-dangling-provider.ts" />',
        "export const danglingTripleConsumer = true;",
        "",
      ].join("\n"),
    );
    fixture.commit("add dangling triple-slash proof fixture");

    const corrupted = await addressProviderUnit(fixture, {
      mutateInputs: (inputs) => {
        const owner = inputs.programInputs.find(
          (input) => input.address === `repo:${consumer}`,
        );
        if (owner === undefined) throw new Error("triple-slash owner is missing");
        owner.resolutionLookupProofKey = "0".repeat(64);
      },
    });

    expect(corrupted.plan.plan.kind).toBe("whole-unit-fallback");
    expect(corrupted.plan.plan.reasons.some(
      (reason) => reason.includes("missing-resolution-lookup-proof"),
    )).toBe(true);
  });

  it("fails closed when compiler module evidence loses an in-Program edge", async () => {
    const corrupted = await addressProviderUnit(fixture, {
      mutateInputs: (inputs) => {
        inputs.moduleResolutions = inputs.moduleResolutions.filter(
          (resolution) => resolution.target?.address !== `repo:${NORMALIZE}`,
        );
      },
    });

    expect(corrupted.plan.plan.kind).toBe("whole-unit-fallback");
    expect(corrupted.plan.plan.reasons.some(
      (reason) => reason.includes("unmapped-compiler-module-resolution"),
    )).toBe(true);
  });

  it("ignores non-selected workspace files outside the exact compiler Program", async () => {
    const external = "packages/consumer/src/unrelated-root.ts";
    fixture.writeFile(
      external,
      'export const unrelatedConsumerRoot = "one";\n',
    );
    fixture.commit("add unrelated external module root");
    const baseline = await addressProviderUnit(fixture);

    replaceInFixture(fixture, external, '"one"', '"two"');
    fixture.commit("change unrelated external module root");
    const changed = await addressProviderUnit(fixture);

    expect(changed.plan.contextDigest).toBe(baseline.plan.contextDigest);
    expect(changed.plan.regionByFile.has(external)).toBe(false);
    for (const path of [PROVIDER_INDEX, NORMALIZE, VERSION]) {
      expect(fileKey(changed.plan, path)).toBe(fileKey(baseline.plan, path));
    }
  });

  it("invalidates only reverse consumers for an ordinary non-selected Program module", async () => {
    const external = "packages/consumer/src/provider-bridge.ts";
    fixture.writeFile(external, 'export const bridgedValue = "one";\n');
    fixture.writeFile(
      PROVIDER_INDEX,
      [
        fixture.readFile(PROVIDER_INDEX),
        'export { bridgedValue } from "../../consumer/src/provider-bridge";',
        "",
      ].join("\n"),
    );
    fixture.commit("add reachable non-selected provider");
    const baseline = await addressProviderUnit(fixture);

    replaceInFixture(fixture, external, '"one"', '"two"');
    fixture.commit("change reachable non-selected provider");
    const changed = await addressProviderUnit(fixture);

    expect(changed.plan.regionByFile.has(external)).toBe(false);
    expect(fileKey(changed.plan, PROVIDER_INDEX))
      .not.toBe(fileKey(baseline.plan, PROVIDER_INDEX));
    expect(fileKey(changed.plan, NORMALIZE))
      .toBe(fileKey(baseline.plan, NORMALIZE));
    expect(fileKey(changed.plan, VERSION))
      .toBe(fileKey(baseline.plan, VERSION));
  });

  it("localizes a failed lookup that becomes a selected provider", async () => {
    const consumer = "packages/provider/src/late-consumer.ts";
    const provider = "packages/provider/src/late-provider.ts";
    fixture.writeFile(
      consumer,
      [
        'import type { LateProvider } from "./late-provider";',
        "export type UsesLateProvider = LateProvider;",
        "",
      ].join("\n"),
    );
    fixture.commit("add unresolved selected consumer");
    const unresolved = await addressProviderUnit(fixture);

    fixture.writeFile(
      provider,
      "export interface LateProvider { readonly value: string; }\n",
    );
    fixture.commit("resolve selected consumer lookup");
    const resolved = await addressProviderUnit(fixture);

    expect(resolved.plan.contextDigest).toBe(unresolved.plan.contextDigest);
    expect(fileKey(resolved.plan, consumer)).not.toBe(fileKey(unresolved.plan, consumer));
    expect(fileKey(resolved.plan, VERSION)).toBe(fileKey(unresolved.plan, VERSION));
    expect(regionFor(resolved.plan, consumer).dependencyRegionIds).toEqual([]);
  });

  it("keeps cyclic compiler decisions file-addressed without recursive provider keys", async () => {
    const external = "packages/consumer/src/provider-cycle.ts";
    fixture.writeFile(
      external,
      [
        'import { normalizeOrder } from "../../provider/src/index";',
        'export const cycleValue = normalizeOrder(" cycle ");',
        "",
      ].join("\n"),
    );
    fixture.writeFile(
      PROVIDER_INDEX,
      [
        fixture.readFile(PROVIDER_INDEX),
        'export { cycleValue } from "../../consumer/src/provider-cycle";',
        "",
      ].join("\n"),
    );
    fixture.commit("add cross-boundary semantic cycle");
    const addressed = await addressProviderUnit(fixture);

    const indexRegion = regionFor(addressed.plan, PROVIDER_INDEX);
    expect(indexRegion.files).toEqual([PROVIDER_INDEX]);
    expect(indexRegion.inputs.programComponent.componentInput
      .containsUniversalProviderAggregate).toBe(false);
    expect(indexRegion.inputs.programComponent.componentInput.nodes).toHaveLength(1);
    expect(indexRegion.inputs.programComponent.componentInput.nodes[0]!.id)
      .toBe(`repo:${PROVIDER_INDEX}`);
    expect(directProviderAddresses(indexRegion)).toContain(`repo:${external}`);
    expect(indexRegion.dependencyRegionIds).toEqual([]);
  });

  it("uses a compact deterministic non-cacheable identity for whole-unit fallback", async () => {
    const forward = await addressProviderUnit(fixture, { forceFallback: true });
    const reversed = await addressProviderUnit(fixture, {
      forceFallback: true,
      reverseSourceFiles: true,
    });

    expect(forward.plan.plan.kind).toBe("whole-unit-fallback");
    expect(addressedSnapshot(reversed.plan)).toEqual(addressedSnapshot(forward.plan));
    const fallback = forward.plan.regions[0]!;
    const fallbackNode = fallback.inputs.programComponent.componentInput.nodes[0]!;
    expect(JSON.parse(fallbackNode.canonicalInput)).toEqual({
      cacheable: false,
      kind: "whole-unit-fallback",
      version: 6,
    });
    expect(forward.plan.context).toMatchObject({
      unattributedProgramInputs: [],
      unattributedFilesystemInputs: [],
      unattributedModuleResolutions: [],
      unattributedTypeReferenceResolutions: [],
      unattributedResolutionLookupInputs: [],
      compilerOptionsDigest: "non-cacheable-whole-unit-fallback",
      typescriptConfig: {
        selectionProbes: [],
        configFiles: [],
        extendsInputs: [],
        reuseEligibility: {
          eligible: false,
        },
      },
    });

    replaceInFixture(fixture, NORMALIZE, "toUpperCase()", "toLowerCase()");
    fixture.commit("change source under whole-unit fallback");
    const changed = await addressProviderUnit(fixture, { forceFallback: true });
    expect(changed.plan.contextDigest).toBe(forward.plan.contextDigest);
    expect(changed.plan.regions[0]!.inputs.programComponent.componentInput.nodes[0]!
      .canonicalInput).toBe(fallbackNode.canonicalInput);
    expect(changed.plan.regions[0]!.key).not.toBe(fallback.key);
  });

  it("produces identical addressed plans for different edit sequences reaching one target tree", async () => {
    const originalNormalize = fixture.readFile(NORMALIZE);

    replaceInFixture(fixture, NORMALIZE, "toUpperCase()", "toLowerCase()");
    fixture.commit("sequence a intermediate");
    fixture.writeFile(NORMALIZE, originalNormalize);
    replaceInFixture(fixture, VERSION, '"v1"', '"v2"');
    const targetA = fixture.commit("sequence a target");
    const planA = await addressProviderUnit(fixture);

    fixture.checkoutExact(fixture.seedRevision);
    const temporary = "packages/provider/src/sequence-b-temporary.ts";
    fixture.writeFile(temporary, "export const temporary = true;\n");
    fixture.commit("sequence b intermediate");
    fixture.removeFile(temporary);
    replaceInFixture(fixture, VERSION, '"v1"', '"v2"');
    const targetB = fixture.commit("sequence b target");
    const planB = await addressProviderUnit(fixture);

    expect(targetB.commitOid).not.toBe(targetA.commitOid);
    expect(targetB.treeOid).toBe(targetA.treeOid);
    expect(addressedSnapshot(planB.plan)).toEqual(addressedSnapshot(planA.plan));
  });
});

interface AddressedFixturePlan {
  revision: GitFixtureRevision;
  plan: AddressedSemanticRegionPlan;
}

async function addressProviderUnit(
  fixture: GitMonorepoFixture,
  options: {
    forceFallback?: boolean;
    reverseSourceFiles?: boolean;
    mutateInputs?: (inputs: UnitInputFingerprint) => void;
  } = {},
): Promise<AddressedFixturePlan> {
  const revision = fixture.currentRevision();
  const request = fixtureRequest(fixture, revision);
  const policy = analysisPolicy(request.options);
  const extractionOptions = extractOptions(fixture.root, policy);
  const workspace = perPackageWorkspace(extractionOptions);
  if (workspace === null) throw new Error("fixture did not produce a package workspace");
  const unit = workspace.units.find((candidate) => candidate.dir === "packages/provider");
  if (unit === undefined) throw new Error("fixture provider unit is missing");
  const loaded = loadUnitProject(
    fixture.root,
    unit,
    extractionOptions,
    workspace.memberPaths,
  );
  if (options.reverseSourceFiles) {
    loaded.sourceFiles = [...loaded.sourceFiles].reverse();
  }
  const verified = await verifyGitTreeInputs(
    fixture.root,
    await listGitTreeBlobs(fixture.root, revision.treeOid),
  );
  const treeBlobs = verified.regularBlobs.sort((left, right) => (
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0
  ));
  const inputs = unitInputFingerprint({
    root: fixture.root,
    unit,
    loaded,
    treeBlobs,
    treeBlobIndex: new Map(treeBlobs.map((blob) => [blob.path, blob])),
    policy,
    provenance: extractorProvenance(request),
  });
  expect(inputs.reuseEligibility).toEqual({ eligible: true, reasons: [] });
  options.mutateInputs?.(inputs);
  const addressedInputs = options.forceFallback
    ? {
      ...inputs,
      reuseEligibility: {
        eligible: false,
        reasons: ["forced-test-fallback"],
      },
    }
    : inputs;
  return {
    revision,
    plan: addressSemanticRegions({
      loaded,
      unitInputs: addressedInputs,
      workspaceDigest: workspaceDigest(workspace),
    }),
  };
}

function addressedSnapshot(plan: AddressedSemanticRegionPlan) {
  return {
    plan: plan.plan,
    context: plan.context,
    contextDigest: plan.contextDigest,
    regions: plan.regions,
    evaluationOrder: plan.evaluationOrder,
  };
}

function regionFor(plan: AddressedSemanticRegionPlan, file: string): AddressedSemanticRegion {
  const region = plan.regionByFile.get(file);
  if (region === undefined) throw new Error(`addressed semantic region is missing ${file}`);
  return region;
}

function fileKey(plan: AddressedSemanticRegionPlan, file: string): string {
  return regionFor(plan, file).key;
}

function directProviderAddresses(region: AddressedSemanticRegion): string[] {
  return region.inputs.programComponent.componentInput.dependencies.map(
    (dependency) => dependency.provider,
  );
}

function expectEveryBaselineKeyChanged(
  baseline: AddressedSemanticRegionPlan,
  changed: AddressedSemanticRegionPlan,
): void {
  for (const file of baseline.regionByFile.keys()) {
    expect(fileKey(changed, file)).not.toBe(fileKey(baseline, file));
  }
}
