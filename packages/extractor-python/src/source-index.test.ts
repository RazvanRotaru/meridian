import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseNodeId } from "@meridian/core";
import {
  createPythonExtractor,
  indexPythonWorkspaceSources,
  selectInitialPythonProjectionFiles,
} from "./index";

const roots: string[] = [];
const LIMITS = {
  maxFiles: 100,
  maxSourceBytes: 1024 * 1024,
  maxFileBytes: 256 * 1024,
  maxSymbols: 1_000,
  maxAdjacencyEntries: 10_000,
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("syntax-only progressive Python source index", () => {
  it("matches canonical structural IDs, package ownership, and weak import topology", async () => {
    const root = workspace({
      "src/acme/__init__.py": "from .service import Service\n",
      "src/acme/service.py": [
        "from .types import Payload",
        "class Service:",
        "    def run(self, value: Payload):",
        "        def nested():",
        "            return value",
        "        return nested()",
      ].join("\n"),
      "src/acme/types.py": "class Payload:\n    pass\n",
      "src/unrelated.py": "def nope():\n    pass\n",
    });
    const canonical = await createPythonExtractor().extract({ root });
    const indexed = await indexPythonWorkspaceSources({
      root,
      seeds: ["src/acme/service.py"],
      limits: LIMITS,
    });
    const canonicalIds = canonical.nodes
      .filter((node) => ["function", "method", "module", "class", "interface"].includes(node.kind))
      .map((node) => node.id)
      .sort();

    expect(indexed.symbols.map(({ id }) => id).sort()).toEqual(canonicalIds);
    expect(indexed.symbols.find(({ id }) => id === "py:acme.service#Service.run"))
      .toMatchObject({ fileId: "py:acme.service", kind: "method" });
    expect(indexed.topology).toEqual([
      { path: "src/acme/__init__.py", fileId: "py:acme", neighbors: ["py:acme.service"], uncertain: false },
      {
        path: "src/acme/service.py",
        fileId: "py:acme.service",
        neighbors: ["py:acme", "py:acme.types"],
        uncertain: false,
      },
      { path: "src/acme/types.py", fileId: "py:acme.types", neighbors: ["py:acme.service"], uncertain: false },
      { path: "src/unrelated.py", fileId: "py:unrelated", neighbors: [], uncertain: false },
    ]);
    expect(indexed.topology.find(({ path }) => path === "src/acme/__init__.py")?.fileId)
      .toBe(canonical.nodes.find(({ location }) => location.file === "src/acme/__init__.py")?.id);
  });

  it("selects incoming and outgoing neighbours with a truthful bounded frontier", async () => {
    const root = workspace({
      "pkg/seed.py": "from .outgoing import value\n",
      "pkg/outgoing.py": "from .tail import tail\nvalue = tail\n",
      "pkg/tail.py": "tail = 1\n",
      "pkg/incoming.py": "from .seed import value\n",
      "other.py": "pass\n",
    });

    await expect(selectInitialPythonProjectionFiles({
      root,
      seeds: ["pkg/seed.py"],
      depth: 1,
    })).resolves.toEqual({
      files: ["pkg/incoming.py", "pkg/outgoing.py", "pkg/seed.py"],
      extractionFiles: ["pkg/incoming.py", "pkg/outgoing.py", "pkg/seed.py"],
      seeds: ["pkg/seed.py"],
      frontier: ["pkg/outgoing.py"],
    });
  });

  it("fails closed for missing seeds and bounded inventory overflow", async () => {
    const root = workspace({
      "a.py": "def a():\n    pass\n",
      "b.py": "def b():\n    pass\n",
    });
    await expect(selectInitialPythonProjectionFiles({ root, seeds: ["missing.py"], depth: 1 }))
      .resolves.toBeNull();
    await expect(indexPythonWorkspaceSources({
      root,
      seeds: ["a.py"],
      limits: { ...LIMITS, maxFiles: 1 },
    })).rejects.toThrow("file limit");
  });

  it("drops an unparseable initializer seed without perturbing a valid colliding module ID", async () => {
    const root = workspace({
      "foo.py": "def valid():\n    return True\n",
      "foo/__init__.py": "def broken(:\n    pass\n",
    });

    await expect(selectInitialPythonProjectionFiles({
      root,
      seeds: ["foo/__init__.py"],
      depth: 1,
    })).resolves.toEqual({ files: [], extractionFiles: [], seeds: [], frontier: [] });

    const indexed = await indexPythonWorkspaceSources({
      root,
      seeds: ["foo.py"],
      limits: LIMITS,
    });
    expect(indexed.topology).toEqual([
      { path: "foo.py", fileId: "py:foo", neighbors: [], uncertain: false },
    ]);
    expect(indexed.symbols).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "py:foo", fileId: "py:foo" }),
      expect.objectContaining({ id: "py:foo#valid", fileId: "py:foo" }),
    ]));
  });

  it("stabilizes a module/package collision and same-qualname member IDs without widening BFS", async () => {
    const root = workspace({
      "foo.py": "def same():\n    return 'module'\n",
      "foo/__init__.py": "def same():\n    return 'package'\n",
      "foo/unrelated.py": "def unrelated():\n    pass\n",
    });
    const canonical = await createPythonExtractor().extract({ root });
    const selection = await selectInitialPythonProjectionFiles({ root, seeds: ["foo.py"], depth: 1 });

    expect(selection).toEqual({
      files: ["foo.py"],
      extractionFiles: ["foo.py", "foo/__init__.py"],
      seeds: ["foo.py"],
      frontier: [],
    });
    const partial = await createPythonExtractor().extract({ root, include: selection!.extractionFiles });
    const expectedIds = canonical.nodes
      .filter((node) => selection!.extractionFiles.includes(node.location.file))
      .map((node) => node.id)
      .sort();
    expect(partial.nodes.map((node) => node.id).sort()).toEqual(expectedIds);
    expect(expectedIds).toEqual(expect.arrayContaining(["py:foo", "py:foo~1", "py:foo#same", "py:foo#same~1"]));
    expect(parseNodeId("py:foo~1")).toEqual({ lang: "py", modulePath: "foo", ordinal: 1 });

    const indexed = await indexPythonWorkspaceSources({ root, seeds: ["foo.py"], limits: LIMITS });
    expect(partial.nodes.find((node) => node.location.file === "foo.py" && node.kind === "module")?.id)
      .toBe(indexed.topology.find((file) => file.path === "foo.py")?.fileId);
  });

  it("adds one parsed descendant when a namespace package reserves a selected module base", async () => {
    const root = workspace({
      "foo.py": "def root():\n    pass\n",
      "foo/bar.py": "def child():\n    pass\n",
    });
    const canonical = await createPythonExtractor().extract({ root });
    const selection = await selectInitialPythonProjectionFiles({ root, seeds: ["foo.py"], depth: 1 });

    expect(selection).toEqual({
      files: ["foo.py"],
      extractionFiles: ["foo.py", "foo/bar.py"],
      seeds: ["foo.py"],
      frontier: [],
    });
    const partial = await createPythonExtractor().extract({ root, include: selection!.extractionFiles });
    expect(partial.nodes.map((node) => node.id).sort()).toEqual(canonical.nodes.map((node) => node.id).sort());
    await expect(selectInitialPythonProjectionFiles({
      root,
      seeds: ["foo.py"],
      depth: 1,
      maxSelectedFiles: 1,
    })).resolves.toBeNull();
  });

  it("reproduces the global synthetic-root switch with one hidden package-prefix witness", async () => {
    const root = workspace({
      "selected.py": "def selected():\n    pass\n",
      "unrelated/nested.py": "def nested():\n    pass\n",
    });
    const canonical = await createPythonExtractor().extract({ root });
    const selection = await selectInitialPythonProjectionFiles({ root, seeds: ["selected.py"], depth: 0 });

    expect(selection).toEqual({
      files: ["selected.py"],
      extractionFiles: ["selected.py", "unrelated/nested.py"],
      seeds: ["selected.py"],
      frontier: [],
    });
    const partial = await createPythonExtractor().extract({ root, include: selection!.extractionFiles });
    const canonicalSelected = canonical.nodes.find(
      (node) => node.kind === "module" && node.location.file === "selected.py",
    );
    expect(partial.nodes.find((node) => node.id === canonicalSelected?.id)).toEqual(canonicalSelected);
    expect(partial.nodes.some((node) => node.id === "py:__root__")).toBe(false);
    await expect(selectInitialPythonProjectionFiles({
      root,
      seeds: ["selected.py"],
      depth: 0,
      maxSelectedFiles: 1,
    })).resolves.toBeNull();
  });

  it("keeps the synthetic root reservation when the full source universe is flat", async () => {
    const root = workspace({
      "__root__.py": "def selected():\n    pass\n",
      "other.py": "def other():\n    pass\n",
    });
    const canonical = await createPythonExtractor().extract({ root });
    const selection = await selectInitialPythonProjectionFiles({ root, seeds: ["__root__.py"], depth: 0 });

    expect(selection).toEqual({
      files: ["__root__.py"],
      extractionFiles: ["__root__.py"],
      seeds: ["__root__.py"],
      frontier: [],
    });
    const partial = await createPythonExtractor().extract({ root, include: selection!.extractionFiles });
    const canonicalIds = canonical.nodes
      .filter((node) => node.location.file === "." || node.location.file === "__root__.py")
      .map((node) => node.id)
      .sort();
    expect(partial.nodes.map((node) => node.id).sort()).toEqual(canonicalIds);
    expect(canonicalIds).toEqual(expect.arrayContaining(["py:__root__", "py:__root__~1"]));
  });

  it("includes ancestor initializers so package location payloads match full extraction", async () => {
    const root = workspace({
      "pkg/__init__.py": "PACKAGE = True\n",
      "pkg/sub/__init__.py": "SUBPACKAGE = True\n",
      "pkg/sub/selected.py": "def selected():\n    pass\n",
      "other.py": "pass\n",
    });
    const canonical = await createPythonExtractor().extract({ root });
    const selection = await selectInitialPythonProjectionFiles({
      root,
      seeds: ["pkg/sub/selected.py"],
      depth: 0,
    });

    expect(selection).toEqual({
      files: ["pkg/sub/selected.py"],
      extractionFiles: ["pkg/__init__.py", "pkg/sub/__init__.py", "pkg/sub/selected.py"],
      seeds: ["pkg/sub/selected.py"],
      frontier: [],
    });
    const partial = await createPythonExtractor().extract({ root, include: selection!.extractionFiles });
    for (const id of ["py:pkg", "py:pkg.sub", "py:pkg.sub.selected"]) {
      expect(partial.nodes.find((node) => node.id === id))
        .toEqual(canonical.nodes.find((node) => node.id === id));
    }
  });

  it("canonicalizes Python code-point output to the shared UTF-16 binary path order", async () => {
    const childOrder = ["Z.py", "a.py", "é.py", "\uE000.py", "😀.py"];
    const canonical = ["Z.py", "a.py", "é.py", "😀.py", "\uE000.py"];
    const root = workspace(Object.fromEntries(childOrder.map((path) => [path, "pass\n"])));

    const indexed = await indexPythonWorkspaceSources({
      root,
      seeds: childOrder,
      limits: LIMITS,
    });

    expect(indexed.seeds).toEqual(canonical);
    expect(indexed.topology.map((file) => file.path)).toEqual(canonical);
  });

  it("rejects source symlinks that escape the immutable workspace", async () => {
    const outside = workspace({ "outside.py": "def outside():\n    pass\n" });
    const root = workspace({ "inside.py": "def inside():\n    pass\n" });
    symlinkSync(join(outside, "outside.py"), join(root, "escaped.py"));

    await expect(indexPythonWorkspaceSources({
      root,
      seeds: ["inside.py"],
      limits: LIMITS,
    })).rejects.toThrow("outside its exact workspace");
  });
});

function workspace(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "meridian-python-source-index-"));
  roots.push(root);
  for (const [path, source] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), source);
  }
  return root;
}
