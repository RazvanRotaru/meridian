import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type { ExtractOptions } from "@meridian/core";
import { createCrossPackageResolver } from "../extract-per-package";
import { absoluteRoot } from "../paths";
import { loadUnitProject } from "../project-loader";
import {
  extractLoadedUnitContributions,
  type UnitFileContributionV1,
} from "../unit-contributions";
import { discoverWorkspaceUnits } from "../workspace-units";
import {
  decodeSemanticRegionContributions,
  encodeSemanticRegionContributions,
  isSemanticRegionLimitError,
  SemanticRegionLimitError,
  SEMANTIC_REGION_CONTRIBUTION_CODEC_VERSION,
  type SerializedSemanticRegionContributionsV3,
} from "./semantic-region-codec";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const FIXTURE_ROOT = join(
  REPO,
  "packages",
  "extractor-typescript",
  "fixtures",
  "promise-resources",
);

let canonicalPayload: SerializedSemanticRegionContributionsV3;
let canonicalFullFiles: readonly UnitFileContributionV1[];

beforeAll(() => {
  const root = absoluteRoot(FIXTURE_ROOT);
  const options: ExtractOptions = { root, valueRefs: true };
  const workspace = discoverWorkspaceUnits(root);
  const unit = workspace.units[0]!;
  const contributions = extractLoadedUnitContributions(
    unit,
    loadUnitProject(root, unit, options, workspace.memberPaths),
    options,
    createCrossPackageResolver(workspace, root),
    "function",
  );
  canonicalFullFiles = contributions.files;
  canonicalPayload = encodeSemanticRegionContributions(contributions.files);
});

describe("semantic-region contribution codec", () => {
  it("routes a miss and parsed hit through the same versioned JSON-safe representation", () => {
    const parsedHit = decodeSemanticRegionContributions(
      JSON.parse(JSON.stringify(canonicalPayload)),
    );

    expect(parsedHit).toStrictEqual(canonicalPayload);
    expect(parsedHit).not.toBe(canonicalPayload);
    expect(parsedHit.files[0]).not.toBe(canonicalPayload.files[0]);
    expect(Object.keys(parsedHit)).toEqual(["files", "version"]);
    expect(parsedHit.version).toBe(SEMANTIC_REGION_CONTRIBUTION_CODEC_VERSION);
    expect(parsedHit).not.toHaveProperty("packageNodes");
    expect(parsedHit).not.toHaveProperty("promiseLane");
    expect(parsedHit).not.toHaveProperty("portsLane");
    expect(parsedHit).not.toHaveProperty("diagnosticLanes");
    expect(parsedHit.files[0]).not.toHaveProperty("structuralNodes");
    expect(parsedHit.files[0]).not.toHaveProperty("implementationMembers");
    expect(parsedHit.files[0]).not.toHaveProperty("flows");
    expect(parsedHit.files[0]).not.toHaveProperty("importEdges");
    expect(JSON.stringify(parsedHit)).toBe(JSON.stringify(canonicalPayload));
  });

  it("omits fresh import, structural, implementation-member, and flow lanes from immutable bytes", () => {
    const files = structuredClone(canonicalFullFiles) as UnitFileContributionV1[];
    const first = files[0]!;
    const fresh = first as unknown as {
      structuralNodes: unknown[];
      implementationMembers: unknown[];
      flows: unknown[];
      importEdges: unknown[];
    };
    fresh.structuralNodes = [];
    fresh.implementationMembers = [];
    fresh.flows = [];
    fresh.importEdges = [];

    expect(encodeSemanticRegionContributions(files)).toStrictEqual(canonicalPayload);
  });

  it("preserves file, export, and pending-reexport array order exactly", () => {
    const payload = mutablePayload();
    const file = payload.files[0]!;
    file.summary.exports.reverse();
    file.summary.pendingReexports.push(
      {
        file: file.file,
        specifier: "./second-provider",
        names: [{ exported: "second", local: "localSecond" }],
      },
      {
        file: file.file,
        specifier: "./first-provider",
        names: null,
      },
    );
    const expectedExports = structuredClone(file.summary.exports);
    const expectedReexports = structuredClone(file.summary.pendingReexports);

    const decoded = decodeSemanticRegionContributions(payload);

    expect(decoded.files.map((entry) => entry.file))
      .toEqual(payload.files.map((entry) => entry.file));
    expect(decoded.files[0]!.summary.exports).toEqual(expectedExports);
    expect(decoded.files[0]!.summary.pendingReexports).toEqual(expectedReexports);
  });

  it.each([
    "",
    "/absolute.ts",
    "C:/absolute.ts",
    "../escape.ts",
    "src/../escape.ts",
    "src//double.ts",
    "src\\windows.ts",
    "src/\0nul.ts",
  ])("rejects malformed contribution path %j", (file) => {
    const payload = mutablePayload();
    payload.files[0]!.file = file;
    expect(() => decodeSemanticRegionContributions(payload))
      .toThrow(/canonical root-relative POSIX path|invalid semantic-region file contribution/);
  });

  it("rejects duplicate file records", () => {
    const payload = mutablePayload();
    payload.files.push(structuredClone(payload.files[0]!));
    expect(() => decodeSemanticRegionContributions(payload))
      .toThrow(/duplicate semantic-region file contribution/);
  });

  it("classifies the region file-count ceiling as an availability limit", () => {
    const payload = mutablePayload();
    payload.files.push(structuredClone(payload.files[0]!));
    let limitError: unknown;
    try {
      decodeSemanticRegionContributions(payload, { maxFiles: 1 });
    } catch (error) {
      limitError = error;
    }
    expect(limitError).toBeInstanceOf(SemanticRegionLimitError);
    expect(limitError).toMatchObject({
      boundary: "codec-region-files",
      limit: 1,
      actual: 2,
    });
  });

  it("rejects edge and summary records owned by another file", () => {
    const edge = mutablePayload();
    expect(edge.files[0]!.behaviouralEdges.length).toBeGreaterThan(0);
    edge.files[0]!.behaviouralEdges[0]!.callSite.file = "src/other.ts";
    expect(() => decodeSemanticRegionContributions(edge))
      .toThrow(/edge belongs to another file/);

    const summary = mutablePayload();
    summary.files[0]!.summary.pendingReexports.push({
      file: "src/other.ts",
      specifier: "./provider",
      names: null,
    });
    expect(() => decodeSemanticRegionContributions(summary))
      .toThrow(/pending re-export belongs to another file/);
  });

  it.each([
    ["behaviouralEdges", "imports", "behavioural"],
    ["inheritanceEdges", "calls", "inheritance"],
    ["valueReferenceEdges", "calls", "value-reference"],
  ] as const)("rejects %s entries with the wrong lane kind", (lane, kind, label) => {
    const payload = mutablePayload();
    const file = payload.files[0]!;
    const seed = structuredClone(file.behaviouralEdges[0]!);
    seed.kind = kind;
    file[lane].push(seed);

    expect(() => decodeSemanticRegionContributions(payload))
      .toThrow(new RegExp(`invalid ${label} lane edge kind`));
  });

  it("accepts cross-file export targets and rejects malformed summaries", () => {
    const module = mutablePayload();
    module.files[0]!.summary.moduleId = "";
    expect(() => decodeSemanticRegionContributions(module))
      .toThrow(/invalid semantic-region file summary/);

    const crossFileTarget = mutablePayload();
    crossFileTarget.files[0]!.summary.exports.push([
      "reexported",
      "ts:src/provider.ts#provided",
    ]);
    expect(
      decodeSemanticRegionContributions(crossFileTarget).files[0]!.summary.exports,
    ).toContainEqual(["reexported", "ts:src/provider.ts#provided"]);

    const emptyTarget = mutablePayload();
    emptyTarget.files[0]!.summary.exports.push(["missing", ""]);
    expect(() => decodeSemanticRegionContributions(emptyTarget))
      .toThrow(/invalid semantic-region export summary/);

    const duplicateName = mutablePayload();
    const existing = duplicateName.files[0]!.summary.exports[0]!;
    duplicateName.files[0]!.summary.exports.push(structuredClone(existing));
    expect(() => decodeSemanticRegionContributions(duplicateName))
      .toThrow(/duplicate semantic-region export name/);
  });

  it("rejects target-wide lanes and unsupported versions", () => {
    const targetLane = mutablePayload() as unknown as Record<string, unknown>;
    targetLane.promiseLane = { nodes: [], edges: [] };
    expect(() => decodeSemanticRegionContributions(targetLane))
      .toThrow(/invalid semantic-region contribution payload/);

    const fileLane = mutablePayload() as unknown as {
      files: Array<Record<string, unknown>>;
    };
    fileLane.files[0]!.flows = [];
    expect(() => decodeSemanticRegionContributions(fileLane))
      .toThrow(/invalid semantic-region file contribution/);

    const legacyImportLane = mutablePayload() as unknown as {
      files: Array<Record<string, unknown>>;
    };
    legacyImportLane.files[0]!.importEdges = [];
    expect(() => decodeSemanticRegionContributions(legacyImportLane))
      .toThrow(/invalid semantic-region file contribution/);

    const version = mutablePayload() as unknown as { version: number };
    version.version = SEMANTIC_REGION_CONTRIBUTION_CODEC_VERSION + 1;
    expect(() => decodeSemanticRegionContributions(version))
      .toThrow(/invalid semantic-region contribution payload/);
  });

  it("enforces byte bounds and rejects non-JSON values before schema validation", () => {
    let limitError: unknown;
    try {
      decodeSemanticRegionContributions(canonicalPayload, { maxBytes: 256 });
    } catch (error) {
      limitError = error;
    }
    expect(limitError).toBeInstanceOf(SemanticRegionLimitError);
    expect(isSemanticRegionLimitError(limitError)).toBe(true);
    expect(limitError).toMatchObject({
      boundary: "codec-payload-bytes",
      limit: 256,
    });
    expect((limitError as Error).message).toMatch(/exceeds 256 bytes/);

    const nonFinite = mutablePayload();
    (nonFinite.files[0]!.summary as { moduleId: unknown }).moduleId = Number.NaN;
    let malformedError: unknown;
    try {
      decodeSemanticRegionContributions(nonFinite);
    } catch (error) {
      malformedError = error;
    }
    expect(malformedError).toBeInstanceOf(Error);
    expect((malformedError as Error).message).toMatch(/non-finite number/);
    expect(isSemanticRegionLimitError(malformedError)).toBe(false);

    const cyclic = mutablePayload() as unknown as {
      version: number;
      files: unknown[];
      self?: unknown;
    };
    cyclic.self = cyclic;
    expect(() => decodeSemanticRegionContributions(cyclic))
      .toThrow(/cycle/);

    const accessor = mutablePayload() as unknown as Record<string, unknown>;
    Object.defineProperty(accessor, "version", {
      configurable: true,
      enumerable: true,
      get: () => 1,
    });
    expect(() => decodeSemanticRegionContributions(accessor))
      .toThrow(/accessor/);
  });
});

type MutablePayload = {
  version: number;
  files: Array<{
    file: string;
    behaviouralEdges: MutableEdge[];
    inheritanceEdges: MutableEdge[];
    valueReferenceEdges: MutableEdge[];
    diagnostics: {
      behavioural: unknown[];
      inheritance: unknown[];
      valueReferences: unknown[];
    };
    summary: {
      exports: Array<[string, string]>;
      moduleId: string;
      pendingReexports: Array<{
        file: string;
        specifier: string;
        targetFile?: string;
        names: null | Array<{ exported: string; local: string }>;
      }>;
    };
  }>;
};

interface MutableEdge {
  kind: string;
  callSite: { file: string };
  [key: string]: unknown;
}

function mutablePayload(): MutablePayload {
  return JSON.parse(JSON.stringify(canonicalPayload)) as MutablePayload;
}
