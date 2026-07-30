import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { perPackageWorkspace } from "../extractor";
import { loadUnitProject } from "../project-loader";
import {
  analysisPolicy,
  extractOptions,
  extractorProvenance,
  filesystemInputKey,
  resolutionLookupInputKey,
  resolutionLookupProofKey,
  unitInputFingerprint,
  type UnitInputFingerprintProgressPosition,
} from "./fingerprints";
import { canonicalJson } from "./canonical-json";
import {
  createGitMonorepoFixture,
  type GitFixtureRevision,
  type GitMonorepoFixture,
} from "./git-fixture";
import { listGitTreeBlobs, verifyGitTreeInputs } from "./git-tree";
import { POC_SHARD_VERSION, type UnitInputFingerprint } from "./model";
import { fixtureRequest } from "./test-support";

describe("unit input fingerprint attribution", { timeout: 120_000 }, () => {
  let fixture: GitMonorepoFixture;

  beforeEach(() => {
    fixture = createGitMonorepoFixture();
  });

  afterEach(() => {
    fixture.cleanup();
  });

  it("content-addresses each program source's own ancestor manifest observations", async () => {
    const nestedManifest = "packages/provider/src/nested/package.json";
    const nestedSource = "packages/provider/src/nested/feature.ts";
    fixture.writeFile(nestedManifest, '{"name":"@fixture/provider-nested","private":true}\n');
    fixture.writeFile(nestedSource, "export const nestedFeature = true;\n");
    const inputs = await fingerprintProvider(fixture, fixture.commit("add nested source manifest"));

    expect(inputs.version).toBe(POC_SHARD_VERSION);
    expect(POC_SHARD_VERSION).toBe(12);
    const catalog = new Map(
      inputs.filesystemInputs.map((input) => [filesystemInputKey(input), input]),
    );
    expect(catalog.size).toBe(inputs.filesystemInputs.length);

    const nested = programInput(inputs, nestedSource);
    const providerIndex = programInput(inputs, "packages/provider/src/index.ts");
    expectSortedUnique(nested.filesystemInputKeys);
    expectSortedUnique(providerIndex.filesystemInputKeys);
    expectEveryKeyResolves(nested.filesystemInputKeys, catalog);
    expectEveryKeyResolves(providerIndex.filesystemInputKeys, catalog);

    const nestedManifestKey = filesystemInputKey(
      inputs.filesystemInputs.find((input) => (
        input.address === `repo:${nestedManifest}`
      ))!,
    );
    expect(nested.filesystemInputKeys).toContain(nestedManifestKey);
    expect(providerIndex.filesystemInputKeys).not.toContain(nestedManifestKey);
    expect([...catalog.keys()].sort()).toEqual(
      [...new Set(inputs.programInputs.flatMap((input) => input.filesystemInputKeys))].sort(),
    );
    const proofs = lookupProofCatalog(inputs);
    for (const input of inputs.programInputs) {
      expect(proofs.has(input.resolutionLookupProofKey)).toBe(true);
    }
  });

  it("captures lookup observations on their exact resolver callbacks", async () => {
    fixture.writeFile(
      "packages/provider/src/lookup-a.ts",
      'import type { FutureA } from "./future-a";\nexport type UsesA = FutureA;\n',
    );
    fixture.writeFile(
      "packages/provider/src/lookup-b.ts",
      'import type { FutureB } from "./future-b";\nexport type UsesB = FutureB;\n',
    );
    fixture.writeFile(
      "packages/provider/src/type-lookup.ts",
      '/// <reference types="missing-fixture-types" />\nexport const typeLookup = true;\n',
    );
    const inputs = await fingerprintProvider(fixture, fixture.commit("add distinct lookups"));
    const catalog = new Map(
      inputs.resolutionLookupInputs.map((input) => [resolutionLookupInputKey(input), input]),
    );
    const proofs = lookupProofCatalog(inputs);
    expect(catalog.size).toBe(inputs.resolutionLookupInputs.length);

    const lookupA = moduleResolution(inputs, "packages/provider/src/lookup-a.ts", "./future-a");
    const lookupB = moduleResolution(inputs, "packages/provider/src/lookup-b.ts", "./future-b");
    const lookupAKeys = lookupKeysFor(lookupA.resolutionLookupProofKey, proofs);
    const lookupBKeys = lookupKeysFor(lookupB.resolutionLookupProofKey, proofs);
    expect(lookupAKeys.length).toBeGreaterThan(0);
    expect(lookupBKeys.length).toBeGreaterThan(0);
    for (const resolution of [lookupA, lookupB]) {
      const keys = lookupKeysFor(resolution.resolutionLookupProofKey, proofs);
      expectSortedUnique(keys);
      expectEveryKeyResolves(keys, catalog);
    }
    expect(addressesFor(lookupAKeys, catalog).some(
      (address) => address.includes("future-a"),
    )).toBe(true);
    expect(addressesFor(lookupAKeys, catalog).some(
      (address) => address.includes("future-b"),
    )).toBe(false);
    expect(addressesFor(lookupBKeys, catalog).some(
      (address) => address.includes("future-b"),
    )).toBe(true);
    expect(addressesFor(lookupBKeys, catalog).some(
      (address) => address.includes("future-a"),
    )).toBe(false);

    const typeLookup = inputs.typeReferenceResolutions.find(
      (resolution) => resolution.specifier === "missing-fixture-types",
    );
    expect(typeLookup).toBeDefined();
    const typeLookupKeys = lookupKeysFor(typeLookup!.resolutionLookupProofKey, proofs);
    expect(typeLookupKeys.length).toBeGreaterThan(0);
    expectSortedUnique(typeLookupKeys);
    expectEveryKeyResolves(typeLookupKeys, catalog);
    expect(inputs.unattributedResolutionLookupInputKeys).toEqual([]);

    const referencedProofs = new Set([
      ...inputs.programInputs.map((input) => input.resolutionLookupProofKey),
      ...inputs.moduleResolutions.map((resolution) => resolution.resolutionLookupProofKey),
      ...inputs.typeReferenceResolutions.map(
        (resolution) => resolution.resolutionLookupProofKey,
      ),
    ]);
    expect([...proofs.keys()].sort()).toEqual([...referencedProofs].sort());
    const referenced = new Set([
      ...inputs.resolutionLookupProofs.flatMap(
        (proof) => proof.resolutionLookupInputKeys,
      ),
      ...inputs.unattributedResolutionLookupInputKeys,
    ]);
    expect([...catalog.keys()].sort()).toEqual([...referenced].sort());
  });

  it("reuses TypeScript's shared resolver evidence without changing its exact key set", async () => {
    fixture.writeFile(
      "packages/provider/src/shared-lookup-a.ts",
      'import type { SharedFuture } from "shared-future";\nexport type UsesA = SharedFuture;\n',
    );
    fixture.writeFile(
      "packages/provider/src/shared-lookup-b.ts",
      'import type { SharedFuture } from "shared-future";\nexport type UsesB = SharedFuture;\n',
    );
    const inputs = await fingerprintProvider(
      fixture,
      fixture.commit("add shared resolver evidence"),
    );
    const shared = inputs.moduleResolutions.filter(
      (resolution) => resolution.specifier === "shared-future",
    );
    expect(shared).toHaveLength(2);
    expect(shared[0]!.resolutionLookupProofKey).toBe(shared[1]!.resolutionLookupProofKey);

    const catalog = new Map(
      inputs.resolutionLookupInputs.map((input) => [resolutionLookupInputKey(input), input]),
    );
    const proofs = lookupProofCatalog(inputs);
    const sharedKeys = lookupKeysFor(shared[0]!.resolutionLookupProofKey, proofs);
    expect(sharedKeys.length).toBeGreaterThan(0);
    expectSortedUnique(sharedKeys);
    expectEveryKeyResolves(sharedKeys, catalog);
    expect(addressesFor(sharedKeys, catalog).some(
      (address) => address.includes("shared-future"),
    )).toBe(true);
    expect(inputs.resolutionLookupProofs.filter(
      (proof) => resolutionLookupProofKey(proof) === shared[0]!.resolutionLookupProofKey,
    )).toHaveLength(1);
  });

  it("attributes TypeScript alternate resolution targets as failed lookups", async () => {
    fixture.writeFile(
      "packages/provider/tsconfig.json",
      `${JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Node10",
          strict: true,
          noEmit: true,
        },
      }, null, 2)}\n`,
    );
    fixture.writeFile(
      "packages/provider/src/alternate.ts",
      [
        'import type { AlternateContract } from "alternate-fixture";',
        "export type UsesAlternate = AlternateContract;",
        "",
      ].join("\n"),
    );
    fixture.writeFile(
      "node_modules/alternate-fixture/package.json",
      `${JSON.stringify({
        name: "alternate-fixture",
        version: "1.0.0",
        exports: {
          ".": {
            types: "./types/index.d.ts",
            default: "./dist/index.js",
          },
        },
      }, null, 2)}\n`,
    );
    fixture.writeFile(
      "node_modules/alternate-fixture/types/index.d.ts",
      "export interface AlternateContract { readonly value: string; }\n",
    );
    const inputs = await fingerprintProvider(
      fixture,
      fixture.commit("add modern package under node resolution"),
    );
    const resolution = inputs.moduleResolutions.find((candidate) => (
      candidate.containingFile === "repo:packages/provider/src/alternate.ts"
      && candidate.specifier === "alternate-fixture"
    ));
    expect(resolution?.alternateResult).toBe(
      "<root>/node_modules/alternate-fixture/types/index.d.ts",
    );
    const catalog = new Map(
      inputs.resolutionLookupInputs.map((input) => [resolutionLookupInputKey(input), input]),
    );
    const proofs = lookupProofCatalog(inputs);
    const alternateObservation = lookupKeysFor(resolution!.resolutionLookupProofKey, proofs)
      .map((key) => catalog.get(key))
      .find((input) => (
        input?.address === "dependency:node_modules/alternate-fixture/types/index.d.ts"
      ));
    expect(alternateObservation).toMatchObject({
      purpose: "failed-lookup",
      state: "file",
    });
  });

  it("produces byte-identical canonical proof catalogs for repeated exact-tree observations", async () => {
    fixture.writeFile(
      "packages/provider/src/canonical.ts",
      [
        '/// <reference path="./future-triple.ts" />',
        'import type { SharedFuture } from "shared-future";',
        "export type Canonical = SharedFuture;",
        "",
      ].join("\n"),
    );
    const revision = fixture.commit("add canonical proof fixture");

    const first = await fingerprintProvider(fixture, revision);
    const second = await fingerprintProvider(fixture, revision);

    expect(canonicalJson(second)).toBe(canonicalJson(first));
    expect(second.resolutionLookupProofs.map(resolutionLookupProofKey))
      .toEqual(first.resolutionLookupProofs.map(resolutionLookupProofKey));
    expect(second.resolutionLookupInputs.map(resolutionLookupInputKey))
      .toEqual(first.resolutionLookupInputs.map(resolutionLookupInputKey));
  });

  it("reports bounded program-input positions, clears the file, and isolates observers", async () => {
    const observed: Array<UnitInputFingerprintProgressPosition | null> = [];
    const fingerprint = await fingerprintProvider(
      fixture,
      fixture.seedRevision,
      (position) => observed.push(position === null ? null : { ...position }),
    );

    expect(observed.at(-1)).toBeNull();
    const files = observed.filter(
      (position): position is UnitInputFingerprintProgressPosition => position !== null,
    );
    expect(files.length).toBeGreaterThan(0);
    expect(files.map((position) => position.current)).toEqual(
      Array.from({ length: files.length }, (_, index) => index + 1),
    );
    expect(files.every((position) => position.total === files.length)).toBe(true);
    expect(files.every((position) => position.path.length > 0)).toBe(true);

    const withThrowingObserver = await fingerprintProvider(
      fixture,
      fixture.seedRevision,
      () => {
        throw new Error("presentation observer failed");
      },
    );
    expect(canonicalJson(withThrowingObserver)).toBe(canonicalJson(fingerprint));
  });
});

async function fingerprintProvider(
  fixture: GitMonorepoFixture,
  revision: GitFixtureRevision,
  onProgramInputProgress?: (
    position: UnitInputFingerprintProgressPosition | null,
  ) => unknown,
): Promise<UnitInputFingerprint> {
  const request = fixtureRequest(fixture, revision);
  const policy = analysisPolicy(request.options);
  const options = extractOptions(fixture.root, policy);
  const workspace = perPackageWorkspace(options);
  if (workspace === null) throw new Error("fixture did not produce a package workspace");
  const unit = workspace.units.find((candidate) => candidate.dir === "packages/provider");
  if (unit === undefined) throw new Error("fixture provider unit is missing");
  const loaded = loadUnitProject(fixture.root, unit, options, workspace.memberPaths);
  const verified = await verifyGitTreeInputs(
    fixture.root,
    await listGitTreeBlobs(fixture.root, revision.treeOid),
  );
  const treeBlobs = verified.regularBlobs.sort((left, right) => (
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0
  ));
  return unitInputFingerprint({
    root: fixture.root,
    unit,
    loaded,
    treeBlobs,
    treeBlobIndex: new Map(treeBlobs.map((blob) => [blob.path, blob])),
    policy,
    provenance: extractorProvenance(request),
    onProgramInputProgress,
  });
}

function programInput(inputs: UnitInputFingerprint, path: string) {
  const input = inputs.programInputs.find((candidate) => candidate.address === `repo:${path}`);
  if (input === undefined) throw new Error(`program input is missing ${path}`);
  return input;
}

function moduleResolution(
  inputs: UnitInputFingerprint,
  containingFile: string,
  specifier: string,
) {
  const resolution = inputs.moduleResolutions.find((candidate) => (
    candidate.containingFile === `repo:${containingFile}`
    && candidate.specifier === specifier
  ));
  if (resolution === undefined) {
    throw new Error(`module resolution is missing ${containingFile} -> ${specifier}`);
  }
  return resolution;
}

function lookupProofCatalog(inputs: UnitInputFingerprint) {
  const catalog = new Map(
    inputs.resolutionLookupProofs.map((proof) => [resolutionLookupProofKey(proof), proof]),
  );
  expect(catalog.size).toBe(inputs.resolutionLookupProofs.length);
  return catalog;
}

function lookupKeysFor(
  proofKey: string,
  catalog: ReadonlyMap<
    string,
    UnitInputFingerprint["resolutionLookupProofs"][number]
  >,
): string[] {
  const proof = catalog.get(proofKey);
  if (proof === undefined) throw new Error(`resolution lookup proof is missing ${proofKey}`);
  return proof.resolutionLookupInputKeys;
}

function expectSortedUnique(keys: string[]): void {
  expect(keys).toEqual([...new Set(keys)].sort());
}

function expectEveryKeyResolves<T>(
  keys: readonly string[],
  catalog: ReadonlyMap<string, T>,
): void {
  for (const key of keys) expect(catalog.has(key)).toBe(true);
}

function addressesFor(
  keys: readonly string[],
  catalog: ReadonlyMap<string, { address: string }>,
): string[] {
  return keys.map((key) => catalog.get(key)!.address);
}
