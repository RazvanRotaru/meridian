/**
 * `generate` must use the same workspace/per-package discovery as `web` unless the caller
 * explicitly opts into a tsconfig program. An implicit root tsconfig used to disable the bounded
 * workspace extractor and could silently drop most cross-package relationships in monorepos.
 */

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GraphArtifact } from "@meridian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runGenerate, type GenerateOptions } from "./generate";

describe("generate TypeScript project selection", () => {
  let root: string;

  beforeEach(() => {
    // Canonicalize macOS's /var -> /private/var temp path so an explicit tsconfig and its source
    // files stay under the same real root during project selection.
    root = realpathSync(mkdtempSync(join(tmpdir(), "meridian-generate-workspace-")));
    write("tsconfig.json", JSON.stringify({ files: [], references: [{ path: "./workspace" }] }));
    write("workspace/package.json", JSON.stringify({ private: true, workspaces: ["packages/*"] }));
    write("workspace/packages/alpha/package.json", JSON.stringify({ name: "@fixture/alpha" }));
    write("workspace/packages/alpha/tsconfig.json", JSON.stringify({
      compilerOptions: {
        baseUrl: ".",
        paths: { "@fixture/beta-alias": ["../beta/src/index.ts"] },
      },
      include: ["src/**/*.ts"],
    }));
    write(
      "workspace/packages/alpha/src/index.ts",
      'import { beta } from "@fixture/beta-alias";\nexport function alpha(): string { return beta(); }\n',
    );
    write("workspace/packages/beta/package.json", JSON.stringify({ name: "@fixture/beta" }));
    write("workspace/packages/beta/src/index.ts", "export function beta(): string { return 'beta'; }\n");
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("uses workspace discovery even when a root tsconfig exists", async () => {
    const discoveredOut = join(root, "discovered.graph.json");
    await runGenerate(root, generateOptions(discoveredOut));
    expect(moduleFiles(discoveredOut)).toEqual([
      "workspace/packages/alpha/src/index.ts",
      "workspace/packages/beta/src/index.ts",
    ]);
    expect(importPairs(discoveredOut)).toContain(
      "ts:workspace/packages/alpha/src/index.ts->ts:workspace/packages/beta/src/index.ts",
    );
  });

  it("honors an explicit --tsconfig relative to --cwd", async () => {
    const explicitRoot = join(root, "explicit-project");
    write("explicit-project/package.json", JSON.stringify({ name: "explicit-project" }));
    write("explicit-project/src/included.ts", "export const included = true;\n");
    write("explicit-project/src/excluded.ts", "export const excluded = true;\n");
    write("explicit-project/tsconfig.json", JSON.stringify({
      include: ["src/included.ts"],
      exclude: ["src/excluded.ts"],
    }));

    const explicitOut = join(explicitRoot, "explicit.graph.json");
    await runGenerate(explicitRoot, {
      ...generateOptions(explicitOut),
      cwd: explicitRoot,
      tsconfig: "tsconfig.json",
    });
    expect(moduleFiles(explicitOut)).toEqual(["src/included.ts"]);
  });

  function write(relativePath: string, contents: string): void {
    const absolutePath = join(root, relativePath);
    mkdirSync(join(absolutePath, ".."), { recursive: true });
    writeFileSync(absolutePath, contents);
  }

  function generateOptions(out: string): GenerateOptions {
    return {
      cwd: root,
      out,
      lang: "typescript",
      depth: "function",
      quiet: true,
    };
  }
});

function moduleFiles(path: string): string[] {
  return readArtifact(path).nodes
    .filter((node) => node.kind === "module")
    .map((node) => node.location.file)
    .sort();
}

function importPairs(path: string): string[] {
  return readArtifact(path).edges
    .filter((edge) => edge.kind === "imports" && edge.resolution === "resolved")
    .map((edge) => `${edge.source}->${edge.target}`);
}

function readArtifact(path: string): GraphArtifact {
  return JSON.parse(readFileSync(path, "utf8")) as GraphArtifact;
}
