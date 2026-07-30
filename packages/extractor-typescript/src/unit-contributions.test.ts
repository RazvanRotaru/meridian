import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  ExtractOptions,
  ExtractionDepth,
  ExtractionResult,
} from "@meridian/core";
import {
  createCrossPackageResolver,
  extractLoadedUnit,
  stitchUnitExtractions,
  type UnitExtraction,
} from "./extract-per-package";
import {
  encodeUnitExtraction,
  type SerializedUnitExtraction,
} from "./incremental-poc/shard-codec";
import { absoluteRoot } from "./paths";
import { loadUnitProject } from "./project-loader";
import {
  extractLoadedUnitContributions,
  materializeUnitContributionSetV1,
  replaceUnitSemanticFileContributions,
} from "./unit-contributions";
import { discoverWorkspaceUnits } from "./workspace-units";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const FIXTURES = join(REPO, "packages", "extractor-typescript", "fixtures");

let workspaceRoot: string;

beforeAll(() => {
  workspaceRoot = absoluteRoot(mkdtempSync(join(tmpdir(), "meridian-unit-contributions-")));
  write("packages/provider/package.json", JSON.stringify({
    name: "@fixture/provider",
    main: "src/index.ts",
  }));
  write(
    "packages/provider/src/index.ts",
    [
      "export interface Contract { normalize(value: string): string }",
      "export function normalize(value: string): string { return value.trim(); }",
      "",
    ].join("\n"),
  );
  write("packages/provider/src/barrel.ts", 'export * from "./index";\n');
  write("packages/consumer/package.json", JSON.stringify({
    name: "@fixture/consumer",
    main: "src/index.ts",
  }));
  write(
    "packages/consumer/src/index.ts",
    [
      'import { normalize, type Contract } from "@fixture/provider/barrel";',
      "export function consume(contract: Contract, value: string): string {",
      "  contract.normalize(value);",
      "  return normalize(value);",
      "}",
      "",
    ].join("\n"),
  );
  write("tsconfig.json", JSON.stringify({
    compilerOptions: {
      baseUrl: ".",
      moduleResolution: "node",
      paths: {
        "@fixture/provider": ["packages/provider/src/index.ts"],
        "@fixture/provider/*": ["packages/provider/src/*"],
        "@fixture/consumer": ["packages/consumer/src/index.ts"],
      },
    },
  }));
});

afterAll(() => rmSync(workspaceRoot, { recursive: true, force: true }));

describe("UnitContributionSet V1", () => {
  it.each([
    {
      name: "Promise resource fixed-point lane",
      root: () => join(FIXTURES, "promise-resources"),
      options: { valueRefs: true },
    },
    {
      name: "postMessage dispatcher whole-unit port lane",
      root: () => join(FIXTURES, "postmessage-dispatcher"),
      options: {},
    },
    {
      name: "typed RPC whole-unit port lane",
      root: () => join(FIXTURES, "rpc-proxy-stub"),
      options: {},
    },
    {
      name: "multi-file value-reference lane",
      root: () => join(FIXTURES, "value-refs"),
      options: { valueRefs: true },
    },
    {
      name: "cross-package summaries and stitch",
      root: () => workspaceRoot,
      options: { valueRefs: true },
    },
  ])("materializes exact cold bytes for $name", ({ root: rootOf, options: overrides }) => {
    const root = absoluteRoot(rootOf());
    const options: ExtractOptions = { root, ...overrides };
    const depth = options.depth ?? "function";
    const { legacy, contributed } = extractBoth(root, options, depth);

    expect(contributed.encodedUnits).toStrictEqual(legacy.encodedUnits);
    expect(JSON.stringify(contributed.encodedUnits))
      .toBe(JSON.stringify(legacy.encodedUnits));
    expect(contributed.result).toStrictEqual(legacy.result);
    expect(JSON.stringify(contributed.result)).toBe(JSON.stringify(legacy.result));
  });

  it("keeps phase order separate from file order", () => {
    const root = absoluteRoot(join(FIXTURES, "value-refs"));
    const options: ExtractOptions = { root, valueRefs: true };
    const workspace = discoverWorkspaceUnits(root);
    const unit = workspace.units[0]!;
    const resolver = createCrossPackageResolver(workspace, root);
    const loaded = loadUnitProject(root, unit, options, workspace.memberPaths);
    const contributions = extractLoadedUnitContributions(
      unit,
      loaded,
      options,
      resolver,
      "function",
    );
    const materialized = materializeUnitContributionSetV1(contributions);

    expect(contributions.files.map((file) => file.file)).toEqual(contributions.fileOrder);
    expect(materialized.rawEdges).toEqual([
      ...contributions.files.flatMap((file) => file.behaviouralEdges),
      ...contributions.files.flatMap((file) => file.inheritanceEdges),
      ...contributions.files.flatMap((file) => file.importEdges),
      ...contributions.files.flatMap((file) => file.valueReferenceEdges),
      ...contributions.promiseLane.edges,
    ]);
  });

  it("materializes fresh target import edges even when a semantic cache hit is stale", () => {
    const root = absoluteRoot(workspaceRoot);
    const options: ExtractOptions = { root, valueRefs: true };
    const workspace = discoverWorkspaceUnits(root);
    const unit = workspace.units.find((candidate) => candidate.dir === "packages/consumer");
    if (unit === undefined) throw new Error("consumer fixture unit is missing");
    const resolver = createCrossPackageResolver(workspace, root);
    const fresh = extractLoadedUnitContributions(
      unit,
      loadUnitProject(root, unit, options, workspace.memberPaths),
      options,
      resolver,
      "function",
    );
    const targetFile = fresh.files.find((file) => file.file.endsWith("/src/index.ts"));
    if (targetFile === undefined) throw new Error("consumer fixture file is missing");
    expect(targetFile.importEdges).not.toEqual([]);

    // Simulate a semantic hit produced for an older revision. The hit remains useful for the
    // expensive semantic lanes, but its import output must never reach target materialization.
    const staleHit = {
      ...targetFile,
      importEdges: [],
    };
    const staleHits = new Map([[targetFile.file, staleHit]]);
    const mixed = extractLoadedUnitContributions(
      unit,
      loadUnitProject(root, unit, options, workspace.memberPaths),
      options,
      resolver,
      "function",
      undefined,
      undefined,
      staleHits,
    );

    expect(mixed.files.find((file) => file.file === targetFile.file)?.importEdges)
      .toStrictEqual(targetFile.importEdges);

    // Semantic-region extraction normalizes hits through this final overlay. It too must preserve
    // the fresh import lane even if an old codec payload still carries importEdges.
    const overlaid = replaceUnitSemanticFileContributions(fresh, staleHits);
    expect(overlaid.files.find((file) => file.file === targetFile.file)?.importEdges)
      .toStrictEqual(targetFile.importEdges);
  });

  it("rejects cached semantic targets that do not exist in fresh target structure", () => {
    const root = absoluteRoot(workspaceRoot);
    const options: ExtractOptions = { root, valueRefs: true };
    const workspace = discoverWorkspaceUnits(root);
    const unit = workspace.units.find((candidate) => candidate.dir === "packages/consumer");
    if (unit === undefined) throw new Error("consumer fixture unit is missing");
    const resolver = createCrossPackageResolver(workspace, root);
    const fresh = extractLoadedUnitContributions(
      unit,
      loadUnitProject(root, unit, options, workspace.memberPaths),
      options,
      resolver,
      "function",
    );
    const targetFile = fresh.files.find((file) => file.file.endsWith("/src/index.ts"));
    const firstEdge = targetFile?.behaviouralEdges[0];
    const firstExport = targetFile?.summary.exports[0];
    if (targetFile === undefined || firstEdge === undefined || firstExport === undefined) {
      throw new Error("consumer semantic fixture is incomplete");
    }

    const staleEdgeTarget = {
      ...targetFile,
      behaviouralEdges: [{
        ...firstEdge,
        resolution: {
          resolution: "resolved" as const,
          resolvedTarget: "ts:missing-target",
          externalModulePath: null,
          externalQualname: null,
          threw: false,
        },
      }, ...targetFile.behaviouralEdges.slice(1)],
    };
    expect(() => replaceUnitSemanticFileContributions(
      fresh,
      new Map([[targetFile.file, staleEdgeTarget]]),
    )).toThrow(
      "semantic replacement edge target differs from target structure: ts:missing-target",
    );

    const staleExportTarget = {
      ...targetFile,
      summary: {
        ...targetFile.summary,
        exports: [
          [firstExport[0], "ts:missing-export"] as const,
          ...targetFile.summary.exports.slice(1),
        ],
      },
    };
    expect(() => replaceUnitSemanticFileContributions(
      fresh,
      new Map([[targetFile.file, staleExportTarget]]),
    )).toThrow(
      `semantic replacement export target differs from target structure: `
      + `${firstExport[0]} -> ts:missing-export`,
    );
  });
});

function extractBoth(
  root: string,
  options: ExtractOptions,
  depth: ExtractionDepth,
): {
  legacy: {
    encodedUnits: SerializedUnitExtraction[];
    result: ExtractionResult;
  };
  contributed: {
    encodedUnits: SerializedUnitExtraction[];
    result: ExtractionResult;
  };
} {
  const workspace = discoverWorkspaceUnits(root);
  const resolver = createCrossPackageResolver(workspace, root);
  const legacyUnits: UnitExtraction[] = [];
  const contributedUnits: UnitExtraction[] = [];
  for (const unit of workspace.units) {
    const legacyLoaded = loadUnitProject(root, unit, options, workspace.memberPaths);
    legacyUnits.push(extractLoadedUnit(
      unit,
      legacyLoaded,
      options,
      resolver,
      depth,
    ));

    const contributionLoaded = loadUnitProject(root, unit, options, workspace.memberPaths);
    contributedUnits.push(materializeUnitContributionSetV1(
      extractLoadedUnitContributions(
        unit,
        contributionLoaded,
        options,
        resolver,
        depth,
      ),
    ));
  }

  // stitchUnitExtractions appends aggregate drop diagnostics to the materialized UnitExtraction.
  // Capture the exact persisted unit representation first, where the revision-shard path does.
  const legacyEncodedUnits = legacyUnits.map(encodeUnitExtraction);
  const contributedEncodedUnits = contributedUnits.map(encodeUnitExtraction);
  return {
    legacy: {
      encodedUnits: legacyEncodedUnits,
      result: stitchUnitExtractions(legacyUnits, options, depth),
    },
    contributed: {
      encodedUnits: contributedEncodedUnits,
      result: stitchUnitExtractions(contributedUnits, options, depth),
    },
  };
}

function write(relativePath: string, contents: string): void {
  const path = join(workspaceRoot, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}
