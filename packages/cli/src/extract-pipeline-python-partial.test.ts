import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { changedFileManifestFromExtensions } from "@meridian/core";
import { indexPythonWorkspaceSources } from "@meridian/extractor-python";
import { extractToArtifact } from "./extract-pipeline";
import {
  parsePrPartialSourceTopology,
  selectPrPartialTopology,
} from "./server/web-pr-partial-topology";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("partial Python and mixed-language extraction", () => {
  it("keeps an explicit empty/docs-only partial side at zero files in a mixed repository", async () => {
    const root = workspace({
      "src/app.ts": "export const app = true;\n",
      "worker/job.py": "def run():\n    pass\n",
    });

    const result = await extractToArtifact({
      absoluteRoot: root,
      cwd: root,
      materializeBoundary: true,
      initialGraph: { depth: 1, seedFiles: [] },
    });

    expect(result.extraction).toMatchObject({
      language: "mixed",
      nodes: [],
      edges: [],
      stats: { files: 0 },
    });
    expect(result.artifact.extensions?.prInitialGraph).toEqual({
      version: 1,
      complete: false,
      depth: 1,
      seedFiles: [],
      selectedFiles: [],
      frontierFiles: [],
    });
  }, 30_000);

  it("builds only the union of exact per-language BFS slices", async () => {
    const root = workspace({
      "src/app.ts": 'import { shared } from "./shared"; export const app = shared;\n',
      "src/shared.ts": "export const shared = true;\n",
      "src/unrelated.ts": "export const unrelated = true;\n",
      "worker/job.py": "from .helper import help\ndef run():\n    help()\n",
      "worker/helper.py": "def help():\n    pass\n",
      "worker/unrelated.py": "def unrelated():\n    pass\n",
    });

    const result = await extractToArtifact({
      absoluteRoot: root,
      cwd: root,
      materializeBoundary: true,
      includeExternal: true,
      valueRefs: true,
      initialGraph: {
        depth: 1,
        seedFiles: ["src/app.ts", "worker/job.py"],
      },
    });

    expect(result.artifact.target.language).toBe("mixed");
    expect(result.artifact.extensions?.prInitialGraph).toEqual({
      version: 1,
      complete: false,
      depth: 1,
      seedFiles: ["src/app.ts", "worker/job.py"],
      selectedFiles: ["src/app.ts", "src/shared.ts", "worker/helper.py", "worker/job.py"],
      frontierFiles: [],
    });
    const sourceFiles = new Set(result.artifact.nodes.map((node) => node.location.file));
    expect(sourceFiles).toContain("src/app.ts");
    expect(sourceFiles).toContain("src/shared.ts");
    expect(sourceFiles).toContain("worker/job.py");
    expect(sourceFiles).toContain("worker/helper.py");
    expect(sourceFiles).not.toContain("src/unrelated.ts");
    expect(sourceFiles).not.toContain("worker/unrelated.py");
    expect(result.artifact.edges.filter((edge) => edge.kind === "imports")).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "ts:src/app.ts", target: "ts:src/shared.ts" }),
      expect.objectContaining({ source: "py:worker.job", target: "py:worker.helper" }),
    ]));
  }, 30_000);

  it("keeps exact single-language slices parser-scoped with one stable mixed target identity", async () => {
    const selectedTypeScript = "src/unrelated.ts";
    const selectedPython = "evaluation/computer_use/cli/__main__.py";
    const root = workspace({
      [selectedTypeScript]: "export const unrelated = true;\n",
      [selectedPython]: [
        "from evaluation.computer_use.cli.main import main",
        "main()",
      ].join("\n"),
      "evaluation/computer_use/cli/main.py": "def main():\n    pass\n",
    });
    const graphId = `pr-partial-0123456789abcdefabcd-${"e".repeat(40)}`;
    const generation = "f".repeat(64);
    const exactSlice = (selected: string) => ({
      depth: 1,
      seedFiles: [selected],
      selectedFiles: [selected],
      extractionFiles: [selected],
      frontierFiles: [selected],
      lineage: { graphId, generation },
    });
    const typeScriptResult = await extractToArtifact({
      absoluteRoot: root,
      cwd: root,
      materializeBoundary: true,
      initialGraph: exactSlice(selectedTypeScript),
    });
    const pythonResult = await extractToArtifact({
      absoluteRoot: root,
      cwd: root,
      materializeBoundary: true,
      initialGraph: exactSlice(selectedPython),
    });

    expect(typeScriptResult.extractors.map((extractor) => extractor.language)).toEqual(["typescript", "python"]);
    expect(pythonResult.extractors.map((extractor) => extractor.language)).toEqual(["typescript", "python"]);
    expect(typeScriptResult.artifact.target).toEqual(pythonResult.artifact.target);
    expect(pythonResult.artifact.target.language).toBe("mixed");
    expect(typeScriptResult.artifact.generator).toEqual(pythonResult.artifact.generator);
    expect(pythonResult.artifact.extensions?.prInitialGraph).toMatchObject({
      seedFiles: [selectedPython],
      selectedFiles: [selectedPython],
      frontierFiles: [selectedPython],
    });
    const typeScriptFiles = new Set(typeScriptResult.artifact.nodes.map((node) => node.location.file));
    expect(typeScriptFiles).toContain(selectedTypeScript);
    expect(typeScriptFiles).not.toContain(selectedPython);
    const pythonFiles = new Set(pythonResult.artifact.nodes.map((node) => node.location.file));
    expect(pythonFiles).toContain(selectedPython);
    expect(pythonFiles).not.toContain(selectedTypeScript);
    expect(pythonFiles).not.toContain("evaluation/computer_use/cli/main.py");
  }, 30_000);

  it("lands an unparseable changed Python seed as a manifest-only empty partial graph", async () => {
    const root = workspace({
      "broken.py": "def broken(:\n    pass\n",
      "unrelated.py": "def untouched():\n    pass\n",
    });
    const patch = [
      "diff --git a/broken.py b/broken.py",
      "index 1111111..2222222 100644",
      "--- a/broken.py",
      "+++ b/broken.py",
      "@@ -1 +1 @@",
      "-def valid():",
      "+def broken(:",
    ].join("\n");
    const executeDiff = async (_absoluteRoot: string, args: string[]) => (
      args.includes("--name-status") ? ["M", "broken.py", ""].join("\0") : patch
    );

    const result = await extractToArtifact({
      absoluteRoot: root,
      cwd: root,
      materializeBoundary: true,
      changedSince: "base",
      changedSinceGitExecutor: executeDiff,
      initialGraph: { depth: 1 },
    });

    expect(result.extraction).toMatchObject({ language: "python", nodes: [], edges: [], stats: { files: 0 } });
    expect(changedFileManifestFromExtensions(result.artifact.extensions)).toEqual([
      { path: "broken.py", status: "modified" },
    ]);
    expect(result.artifact.extensions?.prInitialGraph).toEqual({
      version: 1,
      complete: false,
      depth: 1,
      seedFiles: [],
      selectedFiles: [],
      frontierFiles: [],
    });
    expect(result.artifact.nodes).toEqual([]);
  }, 30_000);

  it("keeps changed TypeScript declarations manifest-only in mixed source neighbourhoods", async () => {
    const root = workspace({
      "src/app.ts": "export const app = true;\n",
      "src/types.d.ts": "declare const value: number;\n",
      "src/unrelated.ts": "export const unrelated = true;\n",
      "worker/job.py": "def run():\n    pass\n",
    });
    const patch = [
      "diff --git a/src/app.ts b/src/app.ts",
      "index 1111111..2222222 100644",
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -1 +1 @@",
      "-export const app = false;",
      "+export const app = true;",
      "diff --git a/src/types.d.ts b/src/types.d.ts",
      "index 3333333..4444444 100644",
      "--- a/src/types.d.ts",
      "+++ b/src/types.d.ts",
      "@@ -1 +1 @@",
      "-declare const value: string;",
      "+declare const value: number;",
      "diff --git a/worker/job.py b/worker/job.py",
      "index 5555555..6666666 100644",
      "--- a/worker/job.py",
      "+++ b/worker/job.py",
      "@@ -1 +1 @@",
      "-def old_run():",
      "+def run():",
    ].join("\n");
    const executeDiff = async (_absoluteRoot: string, args: string[]) => (
      args.includes("--name-status")
        ? ["M", "src/app.ts", "M", "src/types.d.ts", "M", "worker/job.py", ""].join("\0")
        : patch
    );

    const result = await extractToArtifact({
      absoluteRoot: root,
      cwd: root,
      materializeBoundary: true,
      changedSince: "base",
      changedSinceGitExecutor: executeDiff,
      initialGraph: { depth: 1 },
    });

    expect(changedFileManifestFromExtensions(result.artifact.extensions)).toEqual([
      { path: "src/app.ts", status: "modified" },
      { path: "src/types.d.ts", status: "modified" },
      { path: "worker/job.py", status: "modified" },
    ]);
    expect(result.artifact.target.language).toBe("mixed");
    expect(result.artifact.extensions?.prInitialGraph).toEqual({
      version: 1,
      complete: false,
      depth: 1,
      seedFiles: ["src/app.ts", "worker/job.py"],
      selectedFiles: ["src/app.ts", "worker/job.py"],
      frontierFiles: [],
    });
    const sourceFiles = new Set(result.artifact.nodes
      .map((node) => node.location.file)
      .filter((file) => /\.(?:tsx?|py)$/.test(file)));
    expect(sourceFiles).toEqual(new Set(["src/app.ts", "worker/job.py"]));
  }, 30_000);

  it("lands declaration-only changes as a manifest-only empty partial graph", async () => {
    const root = workspace({
      "src/types.d.ts": "declare const value: number;\n",
    });
    const patch = [
      "diff --git a/src/types.d.ts b/src/types.d.ts",
      "index 1111111..2222222 100644",
      "--- a/src/types.d.ts",
      "+++ b/src/types.d.ts",
      "@@ -1 +1 @@",
      "-declare const value: string;",
      "+declare const value: number;",
    ].join("\n");
    const executeDiff = async (_absoluteRoot: string, args: string[]) => (
      args.includes("--name-status") ? ["M", "src/types.d.ts", ""].join("\0") : patch
    );

    const result = await extractToArtifact({
      absoluteRoot: root,
      cwd: root,
      materializeBoundary: true,
      changedSince: "base",
      changedSinceGitExecutor: executeDiff,
      initialGraph: { depth: 1 },
    });

    expect(result.extraction).toMatchObject({ language: "typescript", nodes: [], edges: [], stats: { files: 0 } });
    expect(changedFileManifestFromExtensions(result.artifact.extensions)).toEqual([
      { path: "src/types.d.ts", status: "modified" },
    ]);
    expect(result.artifact.extensions?.prInitialGraph).toEqual({
      version: 1,
      complete: false,
      depth: 1,
      seedFiles: [],
      selectedFiles: [],
      frontierFiles: [],
    });
  }, 30_000);

  it("keeps incremental collision stabilizers hidden while matching full-source topology IDs", async () => {
    const root = workspace({
      "foo.py": "def same():\n    return 'module'\n",
      "foo/__init__.py": "def same():\n    return 'package'\n",
      "foo/unrelated.py": "def unrelated():\n    pass\n",
    });
    const generation = "a".repeat(64);
    const graphId = `pr-partial-0123456789abcdefabcd-${"b".repeat(40)}`;
    const indexed = await indexPythonWorkspaceSources({
      root,
      seeds: ["foo.py"],
      limits: {
        maxFiles: 100,
        maxSourceBytes: 1024 * 1024,
        maxFileBytes: 256 * 1024,
        maxSymbols: 1_000,
        maxAdjacencyEntries: 10_000,
      },
    });
    const topology = parsePrPartialSourceTopology({
      version: 1,
      graphId,
      generation,
      target: { name: "fixture", root: ".", language: "python" },
      changedSinceBaseRef: null,
      seeds: indexed.seeds,
      files: indexed.topology,
    }, { graphId, generation });
    const fooFileId = indexed.topology.find((file) => file.path === "foo.py")!.fileId;
    const selection = selectPrPartialTopology(
      topology,
      { kind: "files", fileIds: [fooFileId] },
      0,
    );
    expect(selection).toEqual({
      seeds: ["foo.py"],
      selectedFiles: ["foo.py"],
      extractionFiles: ["foo.py", "foo/__init__.py"],
      frontierFiles: [],
    });

    const result = await extractToArtifact({
      absoluteRoot: root,
      cwd: root,
      materializeBoundary: true,
      initialGraph: {
        depth: 1,
        seedFiles: selection.seeds,
        selectedFiles: selection.selectedFiles,
        extractionFiles: selection.extractionFiles,
        frontierFiles: selection.frontierFiles,
        lineage: { graphId, generation },
      },
    });

    expect(result.artifact.extensions?.prInitialGraph).toMatchObject({
      seedFiles: ["foo.py"],
      selectedFiles: ["foo.py"],
    });
    expect(result.artifact.extensions?.prInitialGraph).not.toMatchObject({
      selectedFiles: expect.arrayContaining(["foo/__init__.py"]),
    });
    expect(result.artifact.nodes.find((node) => node.location.file === "foo.py" && node.kind === "module")?.id)
      .toBe(fooFileId);
    expect(result.artifact.nodes.map((node) => node.id)).toEqual(expect.arrayContaining([
      "py:foo",
      "py:foo~1",
      "py:foo#same",
      "py:foo#same~1",
    ]));
  }, 30_000);

  it("keeps the full-source root-package shape when incrementally adding a flat Python file", async () => {
    const root = workspace({
      "selected.py": "def selected():\n    pass\n",
      "unrelated/nested.py": "def nested():\n    pass\n",
    });
    const generation = "c".repeat(64);
    const graphId = `pr-partial-0123456789abcdefabcd-${"d".repeat(40)}`;
    const indexed = await indexPythonWorkspaceSources({
      root,
      seeds: ["selected.py"],
      limits: {
        maxFiles: 100,
        maxSourceBytes: 1024 * 1024,
        maxFileBytes: 256 * 1024,
        maxSymbols: 1_000,
        maxAdjacencyEntries: 10_000,
      },
    });
    const topology = parsePrPartialSourceTopology({
      version: 1,
      graphId,
      generation,
      target: { name: "fixture", root: ".", language: "python" },
      changedSinceBaseRef: null,
      seeds: indexed.seeds,
      files: indexed.topology,
    }, { graphId, generation });
    const selectedFileId = indexed.topology.find((file) => file.path === "selected.py")!.fileId;
    const selection = selectPrPartialTopology(
      topology,
      { kind: "files", fileIds: [selectedFileId] },
      0,
    );
    expect(selection).toEqual({
      seeds: ["selected.py"],
      selectedFiles: ["selected.py"],
      extractionFiles: ["selected.py", "unrelated/nested.py"],
      frontierFiles: [],
    });

    const result = await extractToArtifact({
      absoluteRoot: root,
      cwd: root,
      materializeBoundary: true,
      initialGraph: {
        depth: 1,
        seedFiles: selection.seeds,
        selectedFiles: selection.selectedFiles,
        extractionFiles: selection.extractionFiles,
        frontierFiles: selection.frontierFiles,
        lineage: { graphId, generation },
      },
    });

    expect(result.artifact.extensions?.prInitialGraph).toMatchObject({
      depth: 1,
      seedFiles: ["selected.py"],
      selectedFiles: ["selected.py"],
      frontierFiles: [],
    });
    const selected = result.artifact.nodes.find((node) => node.location.file === "selected.py");
    expect(selected).toMatchObject({ id: selectedFileId, kind: "module", parentId: null });
    expect(result.artifact.nodes.some((node) => node.id === "py:__root__")).toBe(false);
  }, 30_000);
});

function workspace(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "meridian-mixed-partial-"));
  roots.push(root);
  for (const [path, source] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), source);
  }
  return root;
}
