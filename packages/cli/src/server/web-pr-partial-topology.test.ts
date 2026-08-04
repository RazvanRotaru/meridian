import { describe, expect, it } from "vitest";
import { buildNodeId, type CompactGraphSymbolEntry, type NodeId } from "@meridian/core";
import {
  MAX_PR_PARTIAL_SELECTED_FILES,
  filterPrPartialDepthOneSymbols,
  parsePrPartialSourceTopology,
  selectPrPartialTopology,
  type PrPartialSourceTopologyV1,
} from "./web-pr-partial-topology";

const generation = "a".repeat(64);
const graphId = `pr-partial-0123456789abcdefabcd-${"b".repeat(40)}`;

function symbol(fileId: NodeId, displayName: string): CompactGraphSymbolEntry {
  return {
    id: fileId,
    fileId,
    displayName,
    qualifiedName: displayName,
    kind: "module",
    file: fileId.startsWith("ts:") ? fileId.slice(3) : `${displayName}.py`,
    isPrivateMethod: false,
    stepCount: null,
  };
}

function payload() {
  return {
    version: 1,
    graphId,
    generation,
    target: {
      name: "fixture",
      root: ".",
      language: "typescript",
      vcs: { repository: "https://github.com/acme/repo.git", commit: "b".repeat(40) },
    },
    changedSinceBaseRef: "c".repeat(40),
    seeds: ["src/a.ts"],
    files: [
      { path: "src/a.ts", fileId: "ts:src/a.ts", neighbors: ["ts:src/b.ts"], uncertain: false },
      { path: "src/b.ts", fileId: "ts:src/b.ts", neighbors: ["ts:src/a.ts", "ts:src/c.ts"], uncertain: false },
      { path: "src/c.ts", fileId: "ts:src/c.ts", neighbors: ["ts:src/b.ts"], uncertain: true },
    ],
  } as const;
}

describe("partial PR source topology", () => {
  it("selects a deterministic lookahead ring and preserves its honest frontier", () => {
    const topology = parsePrPartialSourceTopology(payload(), { graphId, generation });
    expect(selectPrPartialTopology(
      topology,
      { kind: "changed-files", seedGraphId: graphId },
      1,
    )).toEqual({
      seeds: ["src/a.ts"],
      selectedFiles: ["src/a.ts", "src/b.ts"],
      extractionFiles: ["src/a.ts", "src/b.ts"],
      frontierFiles: ["src/b.ts"],
    });
    expect(selectPrPartialTopology(
      topology,
      { kind: "files", fileIds: ["ts:src/b.ts"] },
      1,
    )).toEqual({
      seeds: ["src/b.ts"],
      selectedFiles: ["src/a.ts", "src/b.ts", "src/c.ts"],
      extractionFiles: ["src/a.ts", "src/b.ts", "src/c.ts"],
      frontierFiles: ["src/c.ts"],
    });
  });

  it("canonicalizes mixed-case and Unicode child order before extractor handoff", () => {
    // Python emits Unicode-code-point order, where BMP U+E000 precedes astral U+1F600. The shared
    // protocol order is JavaScript UTF-16 code units, where the astral surrogate begins first.
    const childOrder = [
      "src/Z.ts",
      "src/a.ts",
      "src/é.ts",
      "src/\uE000.ts",
      "src/😀.ts",
    ];
    const canonical = [
      "src/Z.ts",
      "src/a.ts",
      "src/é.ts",
      "src/😀.ts",
      "src/\uE000.ts",
    ];
    const files = childOrder.map((path) => ({
      path,
      fileId: buildNodeId({ lang: "ts", modulePath: path }),
      neighbors: [],
      uncertain: false,
    }));
    const topology = parsePrPartialSourceTopology({
      ...payload(),
      seeds: childOrder,
      files,
    }, { graphId, generation });

    expect(topology.seeds).toEqual(canonical);
    expect(topology.files.map((file) => file.path)).toEqual(canonical);
    expect(selectPrPartialTopology(
      topology,
      { kind: "files", fileIds: [...files].reverse().map((file) => file.fileId) },
      0,
    )).toEqual({
      seeds: canonical,
      selectedFiles: canonical,
      extractionFiles: canonical,
      frontierFiles: [],
    });
  });

  it("preserves deletion-support path no-ops but rejects unknown symbol-hydration file IDs", () => {
    const topology = parsePrPartialSourceTopology(payload(), { graphId, generation });
    expect(selectPrPartialTopology(
      topology,
      { kind: "file-paths", paths: ["src/deleted.ts"] },
      0,
    )).toEqual({ seeds: [], selectedFiles: [], extractionFiles: [], frontierFiles: [] });
    expect(() => selectPrPartialTopology(
      topology,
      { kind: "files", fileIds: ["ts:src/deleted.ts"] },
      1,
    )).toThrow(/exact source file/);
  });

  it("validates and traverses mixed TypeScript and Python file identities", () => {
    const mixed = {
      ...payload(),
      target: { ...payload().target, language: "mixed" },
      seeds: ["src/a.ts", "worker/job.py"],
      files: [
        { path: "src/a.ts", fileId: "ts:src/a.ts", neighbors: [], uncertain: false },
        { path: "worker/helper.py", fileId: "py:worker.helper", neighbors: ["py:worker.job"], uncertain: false },
        { path: "worker/job.py", fileId: "py:worker.job", neighbors: ["py:worker.helper"], uncertain: false },
      ],
    } as const;
    const topology = parsePrPartialSourceTopology(mixed, { graphId, generation });

    expect(selectPrPartialTopology(
      topology,
      { kind: "files", fileIds: ["py:worker.job"] },
      1,
    )).toEqual({
      seeds: ["worker/job.py"],
      selectedFiles: ["worker/helper.py", "worker/job.py"],
      extractionFiles: ["worker/helper.py", "worker/job.py"],
      frontierFiles: [],
    });

    const swapped = mixed.files.map((file) => ({ ...file, neighbors: [...file.neighbors] }));
    swapped[1]!.fileId = "py:worker.job";
    swapped[1]!.neighbors = ["py:worker.helper"];
    swapped[2]!.fileId = "py:worker.helper";
    swapped[2]!.neighbors = ["py:worker.job"];
    expect(() => parsePrPartialSourceTopology({ ...mixed, files: swapped }, { graphId, generation }))
      .toThrow(/topology is invalid/);
  });

  it("rejects asymmetric adjacency and coordinate substitution", () => {
    const asymmetric = payload();
    const files = asymmetric.files.map((file) => ({ ...file, neighbors: [...file.neighbors] }));
    files[1]!.neighbors = ["ts:src/c.ts"];
    expect(() => parsePrPartialSourceTopology({ ...asymmetric, files }, { graphId, generation }))
      .toThrow(/topology is invalid/);
    expect(() => parsePrPartialSourceTopology(payload(), { graphId: "other", generation }))
      .toThrow(/topology is invalid/);
  });

  it("validates a high-degree symmetric star without linearly rescanning the hub per leaf", () => {
    const leafCount = 8_192;
    const paths = Array.from({ length: leafCount + 1 }, (_, index) => (
      `src/${String(index).padStart(5, "0")}.ts`
    ));
    const hubId = `ts:${paths[0]!}`;
    const leafIds = paths.slice(1).map((path) => `ts:${path}`);
    const topology = parsePrPartialSourceTopology({
      ...payload(),
      seeds: [paths[0]],
      files: paths.map((path, index) => ({
        path,
        fileId: `ts:${path}`,
        neighbors: index === 0 ? leafIds : [hubId],
        uncertain: false,
      })),
    }, { graphId, generation });

    expect(topology.files).toHaveLength(leafCount + 1);
    expect(topology.files[0]?.neighbors).toHaveLength(leafCount);
  });

  it("publishes only symbols whose owning file fits a depth-one selected topology", () => {
    const leafPaths = Array.from({ length: MAX_PR_PARTIAL_SELECTED_FILES }, (_, index) => (
      `src/leaf-${String(index).padStart(5, "0")}.ts`
    ));
    const hubPath = "src/hub.ts";
    const hubId = buildNodeId({ lang: "ts", modulePath: hubPath });
    const leafIds = leafPaths.map((path) => buildNodeId({ lang: "ts", modulePath: path }));
    const topology: PrPartialSourceTopologyV1 = {
      version: 1,
      graphId,
      generation,
      target: { name: "fixture", root: ".", language: "typescript" },
      changedSinceBaseRef: null,
      seeds: [],
      files: [
        { path: hubPath, fileId: hubId, neighbors: leafIds, uncertain: false },
        ...leafPaths.map((path, index) => ({
          path,
          fileId: leafIds[index]!,
          neighbors: [hubId],
          uncertain: false,
        })),
      ],
    };
    const leafSymbol = symbol(leafIds[0]!, "leaf");
    const unknownSymbol = symbol(buildNodeId({ lang: "ts", modulePath: "src/unknown.ts" }), "unknown");

    expect(() => selectPrPartialTopology(
      topology,
      { kind: "files", fileIds: [hubId] },
      1,
    )).toThrow(/exceeded its selected-file limit/);
    expect(filterPrPartialDepthOneSymbols(topology, [
      symbol(hubId, "hub"),
      leafSymbol,
      unknownSymbol,
    ])).toEqual([leafSymbol]);
  });

  it("fails symbol admission closed when Python identity stabilizers cross the slice cap", () => {
    const leafCount = MAX_PR_PARTIAL_SELECTED_FILES - 1;
    const rootId = "py:root" as NodeId;
    const leafIds = Array.from({ length: leafCount }, (_, index) => (
      `py:flat${String(index).padStart(5, "0")}` as NodeId
    ));
    const witnessId = "py:pkg.witness" as NodeId;
    const topology: PrPartialSourceTopologyV1 = {
      version: 1,
      graphId,
      generation,
      target: { name: "fixture", root: ".", language: "python" },
      changedSinceBaseRef: null,
      seeds: [],
      files: [
        { path: "root.py", fileId: rootId, neighbors: leafIds, uncertain: false },
        ...leafIds.map((fileId, index) => ({
          path: `flat${String(index).padStart(5, "0")}.py`,
          fileId,
          neighbors: [rootId],
          uncertain: false,
        })),
        { path: "pkg/witness.py", fileId: witnessId, neighbors: [], uncertain: false },
      ],
    };

    expect(() => selectPrPartialTopology(
      topology,
      { kind: "files", fileIds: [rootId] },
      1,
    )).toThrow(/exceeded its selected-file limit/);
    expect(filterPrPartialDepthOneSymbols(topology, [symbol(rootId, "root")])).toEqual([]);
  });

  it("fails with a safe refine-depth error before admitting an oversized root set", () => {
    const files = Array.from({ length: MAX_PR_PARTIAL_SELECTED_FILES + 1 }, (_, index) => {
      const path = `src/${String(index).padStart(5, "0")}.ts`;
      return { path, fileId: `ts:${path}`, neighbors: [], uncertain: false };
    });
    const topology: PrPartialSourceTopologyV1 = {
      version: 1,
      graphId,
      generation,
      target: { name: "fixture", root: ".", language: "typescript" },
      changedSinceBaseRef: null,
      seeds: files.map(({ path }) => path),
      files,
    };

    expect(() => selectPrPartialTopology(
      topology,
      { kind: "changed-files", seedGraphId: graphId },
      0,
    )).toThrow(/exceeded its selected-file limit/);
  });
});
