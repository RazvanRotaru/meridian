import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ExtractOptions, ExtractionDiagnostic } from "@meridian/core";
import {
  moduleIdsByRelPath,
  moduleSourcesById,
  NODE_ID_LANGUAGE,
} from "./extract-common";
import {
  createCrossPackageResolver,
} from "./extract-per-package";
import { survivorIdsAtDepth } from "./extraction-depth";
import {
  collectRawEdgeContributions,
  collectRawEdges,
} from "./edge-pass";
import { buildUnitSummary } from "./export-summary";
import { assignFinalIds } from "./finalize-nodes";
import { buildLogicFlows } from "./flow-pass";
import { collectImportEdges } from "./import-pass";
import { absoluteRoot } from "./paths";
import { loadUnitProject } from "./project-loader";
import type { RelationshipFileProgress } from "./progress";
import { buildResolutionIndex } from "./resolution-index";
import { buildStructure } from "./structural-pass";
import {
  collectValueRefContributions,
  collectValueRefEdges,
} from "./value-ref-pass";
import { discoverWorkspaceUnits } from "./workspace-units";

let root: string;

beforeAll(() => {
  root = absoluteRoot(mkdtempSync(join(tmpdir(), "meridian-selective-passes-")));
  write("package.json", JSON.stringify({ name: "@fixture/selective", main: "src/b.ts" }));
  write("tsconfig.json", JSON.stringify({
    compilerOptions: {
      moduleResolution: "node",
      strict: true,
      target: "ES2022",
    },
    include: ["src/**/*.ts"],
  }));
  write(
    "src/a.ts",
    [
      "export interface Contract { run(value: string): string }",
      "export class Base { run(value: string): string { return value; } }",
      "export function helper(value: string): string { return value.trim(); }",
      'export const marker = "!";',
      "",
    ].join("\n"),
  );
  write(
    "src/b.ts",
    [
      'import { Base, helper, marker, type Contract } from "./a";',
      "export class Child extends Base implements Contract {",
      "  run(value: string): string {",
      "    const callback = helper;",
      "    return callback(value) + marker;",
      "  }",
      "}",
      'export { helper } from "./a";',
      "",
    ].join("\n"),
  );
  write(
    "src/c.ts",
    [
      'import { helper } from "./a";',
      'export function other(): string { return helper("other"); }',
      "",
    ].join("\n"),
  );
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("selective TypeScript passes", () => {
  it("uses exact target paths and preserves cold phase and target-file order", () => {
    const options: ExtractOptions = { root, valueRefs: true };
    const workspace = discoverWorkspaceUnits(root);
    const unit = workspace.units[0]!;
    const resolver = createCrossPackageResolver(workspace, root);
    const loaded = loadUnitProject(root, unit, options, workspace.memberPaths);
    const { descriptors, moduleByFilePath } = buildStructure(loaded, NODE_ID_LANGUAGE);
    assignFinalIds(descriptors);
    const index = buildResolutionIndex(descriptors, moduleByFilePath, loaded.root);
    const moduleIds = moduleIdsByRelPath(loaded, moduleByFilePath);
    const moduleSources = moduleSourcesById(loaded, moduleByFilePath);
    const fileOrder = loaded.sourceFiles.map(loaded.relativePathOf);
    const selected = new Set(["src/c.ts", "src/b.ts"]);
    const selectedOrder = fileOrder.filter((file) => selected.has(file));

    expect([...selected]).toEqual(["src/c.ts", "src/b.ts"]);
    expect(selectedOrder).toEqual(["src/b.ts", "src/c.ts"]);

    const fullRelationshipDiagnostics: ExtractionDiagnostic[] = [];
    const fullRelationships = collectRawEdges(
      loaded,
      descriptors,
      index,
      moduleByFilePath,
      fullRelationshipDiagnostics,
      resolver,
    );
    const fullRelationshipContributions = collectRawEdgeContributions(
      loaded,
      descriptors,
      index,
      moduleByFilePath,
      resolver,
    );
    expect(fullRelationships).toStrictEqual([
      ...fullRelationshipContributions.behavioural.flatMap((file) => file.edges),
      ...fullRelationshipContributions.inheritance.flatMap((file) => file.edges),
    ]);
    expect(fullRelationshipDiagnostics).toStrictEqual([
      ...fullRelationshipContributions.behavioural.flatMap((file) => file.diagnostics),
      ...fullRelationshipContributions.inheritance.flatMap((file) => file.diagnostics),
    ]);

    const relationshipProgress: ProgressEntry[] = [];
    const selectedRelationshipContributions = collectRawEdgeContributions(
      loaded,
      descriptors,
      index,
      moduleByFilePath,
      resolver,
      capture(relationshipProgress),
      selected,
    );
    const selectedRelationshipDiagnostics: ExtractionDiagnostic[] = [];
    const selectedRelationships = collectRawEdges(
      loaded,
      descriptors,
      index,
      moduleByFilePath,
      selectedRelationshipDiagnostics,
      resolver,
      undefined,
      selected,
    );
    expect(selectedRelationshipContributions.behavioural.map((file) => file.file))
      .toEqual(selectedOrder);
    expect(selectedRelationshipContributions.inheritance.map((file) => file.file))
      .toEqual(selectedOrder);
    expect(selectedRelationships).toStrictEqual(
      fullRelationships.filter((edge) => selected.has(edge.callSite.file)),
    );
    expect(selectedRelationshipDiagnostics).toStrictEqual([
      ...selectedRelationshipContributions.behavioural.flatMap((file) => file.diagnostics),
      ...selectedRelationshipContributions.inheritance.flatMap((file) => file.diagnostics),
    ]);
    expect(selectedRelationshipContributions.inheritance.flatMap((file) => file.edges)
      .map((edge) => edge.kind)).toEqual(["extends", "implements"]);
    expect(relationshipProgress).toEqual(progressFor(selectedOrder));

    const importProgress: ProgressEntry[] = [];
    const fullImports = collectImportEdges(loaded, moduleByFilePath, index, resolver);
    const selectedImports = collectImportEdges(
      loaded,
      moduleByFilePath,
      index,
      resolver,
      capture(importProgress),
      selected,
    );
    expect(selectedImports).toStrictEqual(
      fullImports.filter((edge) => selected.has(edge.callSite.file)),
    );
    expect(importProgress).toEqual(progressFor(selectedOrder));
    expect(collectImportEdges(
      loaded,
      moduleByFilePath,
      index,
      resolver,
      undefined,
      new Set(["b.ts"]),
    )).toEqual([]);

    const fullValueDiagnostics: ExtractionDiagnostic[] = [];
    const fullValueRefs = collectValueRefEdges(
      loaded,
      index,
      moduleByFilePath,
      fullValueDiagnostics,
      resolver,
    );
    const valueProgress: ProgressEntry[] = [];
    const selectedValueContributions = collectValueRefContributions(
      loaded,
      index,
      moduleByFilePath,
      resolver,
      capture(valueProgress),
      selected,
    );
    const selectedValueDiagnostics: ExtractionDiagnostic[] = [];
    const selectedValueRefs = collectValueRefEdges(
      loaded,
      index,
      moduleByFilePath,
      selectedValueDiagnostics,
      resolver,
      undefined,
      selected,
    );
    expect(selectedValueContributions.map((file) => file.file)).toEqual(selectedOrder);
    expect(selectedValueRefs).toStrictEqual(
      fullValueRefs.filter((edge) => selected.has(edge.callSite.file)),
    );
    expect(selectedValueDiagnostics).toStrictEqual(
      selectedValueContributions.flatMap((file) => file.diagnostics),
    );
    expect(valueProgress).toEqual(progressFor(selectedOrder));

    const keepIds = survivorIdsAtDepth(descriptors, "function");
    const fullFlows = buildLogicFlows(descriptors, index, keepIds, moduleSources);
    const flowProgress: ProgressEntry[] = [];
    const selectedFlows = buildLogicFlows(
      descriptors,
      index,
      keepIds,
      moduleSources,
      new Set(),
      capture(flowProgress),
      selected,
    );
    const fileByNodeId = new Map(descriptors.map((descriptor) => [
      descriptor.finalId,
      descriptor.location.file,
    ]));
    expect(selectedFlows).toStrictEqual(Object.fromEntries(
      Object.entries(fullFlows).filter(([nodeId]) => selected.has(fileByNodeId.get(nodeId) ?? "")),
    ));
    expect(flowProgress).toEqual(progressFor(selectedOrder));

    const fullSummary = buildUnitSummary(unit, loaded, index, moduleIds, resolver);
    const summaryProgress: ProgressEntry[] = [];
    const selectedSummary = buildUnitSummary(
      unit,
      loaded,
      index,
      moduleIds,
      resolver,
      capture(summaryProgress),
      selected,
    );
    expect([...selectedSummary.exportsByFile]).toStrictEqual(
      [...fullSummary.exportsByFile].filter(([file]) => selected.has(file)),
    );
    expect([...selectedSummary.moduleIdByRelPath]).toStrictEqual(
      [...fullSummary.moduleIdByRelPath].filter(([file]) => selected.has(file)),
    );
    expect(selectedSummary.pendingReexports).toStrictEqual(
      fullSummary.pendingReexports.filter((entry) => selected.has(entry.file)),
    );
    expect(summaryProgress).toEqual(progressFor(selectedOrder));
    expect([...moduleIds.keys()]).toEqual(fileOrder);
  });
});

type ProgressEntry = [path: string, current: number, total: number];

function capture(entries: ProgressEntry[]): RelationshipFileProgress {
  return (path, current, total) => entries.push([path, current, total]);
}

function progressFor(files: readonly string[]): ProgressEntry[] {
  return files.map((file, index) => [file, index + 1, files.length]);
}

function write(relativePath: string, contents: string): void {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}
