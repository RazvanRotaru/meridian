/**
 * Workspace path auto-discovery: every in-project package.json contributes a `name` -> source
 * alias, and (the payoff) a plain glob extraction then resolves cross-package `@scope/pkg`
 * imports into real `imports` edges without any hand-written tsconfig.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ExtractionResult } from "@meridian/core";
import { createTypeScriptExtractor } from "./index";
import { discoverWorkspacePaths } from "./workspace-paths";

let root: string;

function writePackage(dir: string, name: string, files: Record<string, string>): void {
  mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, dir, "package.json"), JSON.stringify({ name }));
  for (const [rel, source] of Object.entries(files)) {
    mkdirSync(join(root, dir, rel, ".."), { recursive: true });
    writeFileSync(join(root, dir, rel), source);
  }
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "meridian-wspaths-"));
  writePackage("packages/pkg-b", "@scope/pkg-b", { "src/index.ts": "export const b = 2;\n" });
  writePackage("packages/pkg-a", "@scope/pkg-a", {
    "src/index.ts": "import { b } from '@scope/pkg-b';\nexport const a = b + 1;\n",
  });
  // A plain directory with no package.json contributes no alias.
  mkdirSync(join(root, "packages/plain"), { recursive: true });
  writeFileSync(join(root, "packages/plain", "c.ts"), "export const c = 3;\n");
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("discoverWorkspacePaths", () => {
  it("maps each package name (and name/*) to its source, ignoring package-less dirs", () => {
    const { baseUrl, paths } = discoverWorkspacePaths(root);
    expect(baseUrl).toBe(root);
    expect(paths["@scope/pkg-b"]).toEqual(["packages/pkg-b/src/index.ts"]);
    expect(paths["@scope/pkg-b/*"]).toEqual(["packages/pkg-b/src/*"]);
    expect(paths["@scope/pkg-a"]).toEqual(["packages/pkg-a/src/index.ts"]);
    // No spurious alias for the package-less directory.
    expect(Object.keys(paths).some((key) => key.includes("plain"))).toBe(false);
  });

  it("returns no aliases for a tree without package.json files", () => {
    const bare = mkdtempSync(join(tmpdir(), "meridian-bare-"));
    writeFileSync(join(bare, "only.ts"), "export const x = 1;\n");
    try {
      expect(discoverWorkspacePaths(bare).paths).toEqual({});
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});

describe("cross-package resolution via auto-discovered aliases", () => {
  let result: ExtractionResult;
  beforeAll(async () => {
    result = await createTypeScriptExtractor().extract({ root });
  });

  it("resolves a bare `@scope/pkg` import into an in-project imports edge", () => {
    const crossPackage = result.edges.find(
      (edge) =>
        edge.kind === "imports" &&
        edge.source.includes("pkg-a") &&
        edge.target.includes("pkg-b") &&
        edge.resolution === "resolved",
    );
    expect(crossPackage, "pkg-a should import pkg-b via the @scope alias").toBeDefined();
  });
});
