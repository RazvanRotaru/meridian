/**
 * Focused regression coverage for repository-shaped Python projects. Each fixture is written to
 * a temporary directory so these tests exercise discovery, import identity, and resolution as a
 * consumer would, without depending on a checked-in sample project.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ExtractOptions, ExtractionResult, GraphEdge } from "@meridian/core";
import { createPythonExtractor } from "./index";

type ProjectFiles = Record<string, string>;

async function withProject<T>(files: ProjectFiles, run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "meridian-python-upgraded-"));
  try {
    for (const [file, source] of Object.entries(files)) {
      const path = join(root, file);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, source);
    }
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function extract(root: string, options: Omit<ExtractOptions, "root"> = {}): Promise<ExtractionResult> {
  return createPythonExtractor().extract({ root, ...options });
}

function findEdge(
  result: ExtractionResult,
  kind: GraphEdge["kind"],
  source: string,
  target: string,
): GraphEdge | undefined {
  return result.edges.find(
    (edge) =>
      edge.kind === kind &&
      edge.resolution === "resolved" &&
      edge.source === source &&
      edge.target === target,
  );
}

describe("PythonExtractor repository discovery and resolution", () => {
  it("uses package import identity for a repo-root src layout and resolves its call and import", async () => {
    await withProject(
      {
        "pyproject.toml": "[project]\nname = \"sample\"\n",
        "src/acme/__init__.py": "\"\"\"Application package.\"\"\"\n",
        "src/acme/services/service.py": [
          "def build_message(name: str) -> str:",
          "    return f\"hello {name}\"",
          "",
        ].join("\n"),
        "src/acme/api.py": [
          "from acme.services.service import build_message",
          "",
          "def endpoint() -> str:",
          "    return build_message(\"world\")",
          "",
        ].join("\n"),
      },
      async (root) => {
        const result = await extract(root);
        const packageResult = await extract(join(root, "src", "acme"));
        const namespaceResult = await extract(join(root, "src", "acme", "services"));
        const moduleIds = result.nodes.filter((node) => node.kind === "module").map((node) => node.id);

        expect(moduleIds).toEqual(expect.arrayContaining(["py:acme.api", "py:acme.services.service"]));
        expect(moduleIds.some((id) => id.startsWith("py:src."))).toBe(false);
        expect(result.nodes).toContainEqual(
          expect.objectContaining({ id: "py:acme", kind: "package", location: expect.objectContaining({ file: "src/acme/__init__.py" }) }),
        );
        expect(moduleIds).not.toContain("py:acme.__init__");
        expect(findEdge(result, "calls", "py:acme.api#endpoint", "py:acme.services.service#build_message")).toBeDefined();
        expect(findEdge(result, "imports", "py:acme.api", "py:acme.services.service")).toBeDefined();
        expect(findEdge(packageResult, "calls", "py:acme.api#endpoint", "py:acme.services.service#build_message")).toBeDefined();
        expect(namespaceResult.nodes).toContainEqual(expect.objectContaining({ id: "py:acme.services.service" }));
      },
    );
  });

  it("follows a symbol re-exported by __init__.py to its defining module", async () => {
    await withProject(
      {
        "pkg/__init__.py": "from .impl import exported\n",
        "pkg/impl.py": [
          "def exported() -> str:",
          "    return \"ok\"",
          "",
        ].join("\n"),
        "consumer.py": [
          "from pkg import exported",
          "",
          "def consume() -> str:",
          "    return exported()",
          "",
        ].join("\n"),
      },
      async (root) => {
        const result = await extract(root);

        expect(result.nodes).toContainEqual(
          expect.objectContaining({
            id: "py:pkg",
            kind: "package",
            location: expect.objectContaining({ file: "pkg/__init__.py" }),
          }),
        );
        expect(result.nodes.some((node) => node.id === "py:pkg.__init__")).toBe(false);
        expect(findEdge(result, "imports", "py:consumer", "py:pkg")).toBeDefined();
        expect(findEdge(result, "calls", "py:consumer#consume", "py:pkg.impl#exported")).toBeDefined();
      },
    );
  });

  it("keeps nested callables lexical and emits an opt-in callback value reference", async () => {
    await withProject(
      {
        "callbacks.py": [
          "def leaf() -> int:",
          "    return 7",
          "",
          "def invoke(callback):",
          "    return callback()",
          "",
          "def outer() -> int:",
          "    def helper() -> int:",
          "        return leaf()",
          "",
          "    def inner() -> int:",
          "        return helper()",
          "",
          "    invoke(inner)",
          "    return inner()",
          "",
        ].join("\n"),
      },
      async (root) => {
        const withoutRefs = await extract(root);
        const withRefs = await extract(root, { valueRefs: true });

        expect(withRefs.nodes).toContainEqual(
          expect.objectContaining({
            id: "py:callbacks#outer.inner",
            kind: "function",
            parentId: "py:callbacks#outer",
          }),
        );
        expect(findEdge(withRefs, "calls", "py:callbacks#outer.helper", "py:callbacks#leaf")).toBeDefined();
        expect(findEdge(withRefs, "calls", "py:callbacks#outer.inner", "py:callbacks#outer.helper")).toBeDefined();
        expect(findEdge(withRefs, "calls", "py:callbacks#outer", "py:callbacks#outer.inner")).toBeDefined();
        expect(findEdge(withoutRefs, "references", "py:callbacks#outer", "py:callbacks#outer.inner")).toBeUndefined();
        expect(findEdge(withRefs, "references", "py:callbacks#outer", "py:callbacks#outer.inner")).toBeDefined();
      },
    );
  });

  it("honors include/exclude globs while pruning worktrees even when explicitly included", async () => {
    await withProject(
      {
        "src/included.py": "def included():\n    return 1\n",
        "src/excluded.py": "def excluded():\n    return 2\n",
        "outside.py": "def outside():\n    return 3\n",
        "worktrees/copy.py": "def copied():\n    return 4\n",
      },
      async (root) => {
        const result = await extract(root, {
          include: ["src/**/*.py", "worktrees/**/*.py"],
          exclude: ["**/excluded.py"],
        });
        const files = result.nodes
          .filter((node) => node.kind === "module")
          .map((node) => node.location.file);

        expect(files).toEqual(["src/included.py"]);
        expect(result.stats.files).toBe(1);
      },
    );
  });
});
