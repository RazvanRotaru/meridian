/**
 * `resolveEntryModules` must map a package.json's BUILD entry (`main: ./out/main/main.js`)
 * back to the SOURCE module the extractor emitted (`src/main.ts`), never the build-output
 * decoy — and stay silent (`[]`) when a repo declares no entry.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GraphNode } from "@meridian/core";
import { resolveEntryModules } from "./entry-points";

/** Minimal but correctly-shaped module node; `file` is relative to the extraction root. */
function moduleNode(file: string, language: "typescript" | "python" = "typescript"): GraphNode {
  const prefix = language === "python" ? "py" : "ts";
  return {
    id: `${prefix}:${file}`,
    kind: "module",
    qualifiedName: file,
    displayName: file,
    language,
    location: { file, startLine: 1, endLine: 1 },
  };
}

describe("resolveEntryModules", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "meridian-entry-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function writePackageJson(dir: string, contents: Record<string, unknown>): void {
    const abs = join(root, dir);
    mkdirSync(abs, { recursive: true });
    writeFileSync(join(abs, "package.json"), JSON.stringify(contents));
  }

  it("resolves a build entry to the source module, skipping the build-output decoy", () => {
    writePackageJson(".", { main: "./out/main/main.js" });
    const nodes = [moduleNode("src/main.ts"), moduleNode("out/main/main.ts"), moduleNode("src/util.ts")];

    expect(resolveEntryModules(root, nodes)).toEqual(["ts:src/main.ts"]);
  });

  it("matches .tsx and prefers a src/ location over a sibling", () => {
    writePackageJson(".", { main: "dist/index.js" });
    const nodes = [moduleNode("index.tsx"), moduleNode("src/index.tsx")];

    expect(resolveEntryModules(root, nodes)).toEqual(["ts:src/index.tsx"]);
  });

  it("never resolves a package.json entry to a same-basename Python module", () => {
    writePackageJson(".", { main: "dist/index.js" });
    const nodes = [moduleNode("src/index.py", "python"), moduleNode("lib/index.ts")];

    expect(resolveEntryModules(root, nodes)).toEqual(["ts:lib/index.ts"]);
  });

  it("falls back to module then exports['.'] when main is absent", () => {
    writePackageJson("pkg-a", { module: "./esm/a.js" });
    writePackageJson("pkg-b", { exports: { ".": { import: "./out/b.js" } } });
    const nodes = [moduleNode("pkg-a/src/a.ts"), moduleNode("pkg-b/src/b.ts")];

    expect(resolveEntryModules(root, nodes).sort()).toEqual(["ts:pkg-a/src/a.ts", "ts:pkg-b/src/b.ts"]);
  });

  it("contributes nothing for a package with no entry field", () => {
    writePackageJson(".", { name: "no-entry", version: "1.0.0" });
    const nodes = [moduleNode("src/main.ts")];

    expect(resolveEntryModules(root, nodes)).toEqual([]);
  });

  it("returns [] when there are no module nodes", () => {
    writePackageJson(".", { main: "./out/main/main.js" });

    expect(resolveEntryModules(root, [])).toEqual([]);
  });

  it("ranks the shallower app entry first (best-first ordering)", () => {
    writePackageJson(".", { main: "./out/root.js" });
    writePackageJson("packages/deep", { main: "./out/main.js" });
    const nodes = [moduleNode("packages/deep/src/main.ts"), moduleNode("src/root.ts")];

    expect(resolveEntryModules(root, nodes)).toEqual(["ts:src/root.ts", "ts:packages/deep/src/main.ts"]);
  });
});
