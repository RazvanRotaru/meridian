/**
 * `generate` is a headless export adapter over the app's canonical workspace analysis. A root
 * tsconfig must neither select a second whole-program path nor suppress another detected language
 * in a polyglot monorepo.
 */

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GraphArtifact } from "@meridian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildProgram } from "../program";
import { AnalysisCoordinator } from "../server/web-analysis-coordinator";
import { generateGraph } from "../server/web-generation";
import { WebGraphStore } from "../server/web-graph-store";
import type { Context } from "../server/web-server";
import {
  runRepositoryAnalysisChild,
  runRepositoryArtifactRestampChild,
} from "../server/repository-analysis-child";
import { runGenerate, type GenerateOptions } from "./generate";

describe("generate canonical repository analysis", () => {
  let root: string;

  beforeEach(() => {
    // Canonicalize macOS's /var -> /private/var temp path so workspace roots and ts-morph source
    // files stay under the same real path during discovery.
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
    write("pyproject.toml", "[project]\nname = \"mixed-workspace\"\n");
    write("backend/orders.py", "def calculate_total(quantity: int) -> int:\n    return quantity * 2\n");
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("uses workspace discovery even when a root tsconfig exists", async () => {
    const discoveredOut = join(root, "discovered.graph.json");
    await runGenerate(root, generateOptions(discoveredOut));
    expect(moduleFiles(discoveredOut)).toEqual([
      "backend/orders.py",
      "workspace/packages/alpha/src/index.ts",
      "workspace/packages/beta/src/index.ts",
    ]);
    expect(importPairs(discoveredOut)).toContain(
      "ts:workspace/packages/alpha/src/index.ts->ts:workspace/packages/beta/src/index.ts",
    );

    const graphStore = new WebGraphStore();
    const analysisCoordinator = new AnalysisCoordinator();
    const context = {
      cwd: root,
      graphStore,
      analysisCoordinator,
      repositoryAnalysis: runRepositoryAnalysisChild,
      repositoryArtifactRestamp: runRepositoryArtifactRestampChild,
      allowSyntheticExecution: false,
    } as unknown as Context;
    let webArtifact: GraphArtifact | undefined;
    try {
      const generated = await generateGraph(context, { kind: "path", value: root }, undefined);
      webArtifact = graphStore.loadArtifact(generated.id);
    } finally {
      await analysisCoordinator.close();
      graphStore.dispose();
    }
    const cliArtifact = readArtifact(discoveredOut);
    expect(cliArtifact.target.language).toBe("mixed");
    expect(cliArtifact.nodes.some((node) => node.id.startsWith("ts:"))).toBe(true);
    expect(cliArtifact.nodes).toContainEqual(expect.objectContaining({
      id: "py:backend.orders#calculate_total",
      location: expect.objectContaining({ file: "backend/orders.py" }),
    }));
    expect(webArtifact?.nodes).toEqual(cliArtifact.nodes);
    expect(webArtifact?.edges).toEqual(cliArtifact.edges);
  });

  it("does not expose alternate graph-shaping paths", () => {
    const generate = buildProgram().commands.find((command) => command.name() === "generate");
    const optionNames = generate?.options.map((option) => option.long) ?? [];
    expect(optionNames).not.toEqual(expect.arrayContaining([
      "--tsconfig",
      "--include",
      "--exclude",
      "--depth",
      "--include-external",
      "--include-unresolved",
      "--exclude-tests",
      "--value-refs",
      "--lang",
    ]));
  });

  it("advertises web as the only app launcher", () => {
    const commandNames = buildProgram().commands.map((command) => command.name());
    expect(commandNames).toContain("web");
    expect(commandNames).not.toContain("view");
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
