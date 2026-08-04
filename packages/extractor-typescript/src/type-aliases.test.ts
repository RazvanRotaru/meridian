import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTypeScriptExtractor } from "./index";
import { absoluteRoot } from "./paths";

const roots: string[] = [];
const WEB_SEARCH_FILE = "src/aria/app/src/lib/commontools/tools/WebSearchTool.ts";
const AUTHORIZER_FILE = "src/aria/lib/contracts/IToolExecutionPolicyEvaluator.ts";

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("TypeScript type aliases", () => {
  it("emits named aliases and resolves a constructor parameter precisely to its alias", async () => {
    const root = workspace({
      "tsconfig.json": JSON.stringify({
        compilerOptions: { moduleResolution: "node", strict: true },
        include: ["src/**/*.ts"],
      }),
      "src/contracts.ts": [
        "/** Authorizes one discovered target. */",
        "export type ToolExecutionTargetAuthorizer = (target: string) => Promise<void>;",
        "export namespace Policy {",
        "  export type NestedAuthorizer = (target: string) => void;",
        "}",
      ].join("\n"),
      "src/WebSearchTool.ts": [
        'import type { ToolExecutionTargetAuthorizer } from "./contracts";',
        "export class WebSearchTool {",
        "  constructor(private readonly authorizeTarget: ToolExecutionTargetAuthorizer) {}",
        "}",
      ].join("\n"),
    });

    const result = await createTypeScriptExtractor().extract({
      root,
      project: join(root, "tsconfig.json"),
      valueRefs: true,
    });
    const aliasId = "ts:src/contracts.ts#ToolExecutionTargetAuthorizer";
    const constructorId = "ts:src/WebSearchTool.ts#WebSearchTool.constructor";

    expect(result.nodes.find((node) => node.id === aliasId)).toMatchObject({
      kind: "typeAlias",
      qualifiedName: "ToolExecutionTargetAuthorizer",
      displayName: "ToolExecutionTargetAuthorizer",
      summary: "Authorizes one discovered target.",
      parentId: "ts:src/contracts.ts",
      location: { file: "src/contracts.ts", startLine: 2, endLine: 2 },
      tags: ["export"],
    });
    expect(result.nodes.find((node) => node.id === "ts:src/contracts.ts#Policy.NestedAuthorizer")).toMatchObject({
      kind: "typeAlias",
      qualifiedName: "Policy.NestedAuthorizer",
      parentId: "ts:src/contracts.ts#Policy",
      location: { file: "src/contracts.ts", startLine: 4, endLine: 4 },
      tags: ["export"],
    });

    const reference = result.edges.find(
      (edge) => edge.kind === "references" && edge.source === constructorId && edge.target === aliasId,
    );
    expect(reference).toMatchObject({
      resolution: "resolved",
      weight: 1,
      callSites: [expect.objectContaining({ file: "src/WebSearchTool.ts", line: 3 })],
    });
    expect(
      result.edges.some(
        (edge) =>
          edge.kind === "references"
          && edge.source === "ts:src/WebSearchTool.ts"
          && edge.target === "ts:src/contracts.ts"
          && edge.callSites?.some((site) => site.line === 3),
      ),
    ).toBe(false);
  });

  it("publishes an exported alias for cross-package constructor-reference stitching", async () => {
    const root = workspace({
      "package.json": JSON.stringify({ private: true, workspaces: ["packages/*"] }),
      "packages/contracts/package.json": JSON.stringify({ name: "@fixture/contracts" }),
      "packages/contracts/src/index.ts":
        "export type ToolExecutionTargetAuthorizer = (target: string) => Promise<void>;\n",
      "packages/app/package.json": JSON.stringify({ name: "@fixture/app" }),
      "packages/app/src/index.ts": [
        'import type { ToolExecutionTargetAuthorizer } from "@fixture/contracts";',
        "export class WebSearchTool {",
        "  constructor(private readonly authorizeTarget: ToolExecutionTargetAuthorizer) {}",
        "}",
      ].join("\n"),
    });

    const result = await createTypeScriptExtractor().extract({ root, valueRefs: true });
    const aliasId = "ts:packages/contracts/src/index.ts#ToolExecutionTargetAuthorizer";
    const constructorId = "ts:packages/app/src/index.ts#WebSearchTool.constructor";

    expect(result.nodes.find((node) => node.id === aliasId)).toMatchObject({
      kind: "typeAlias",
      parentId: "ts:packages/contracts/src/index.ts",
    });
    expect(
      result.edges.find(
        (edge) => edge.kind === "references" && edge.source === constructorId && edge.target === aliasId,
      ),
    ).toMatchObject({
      resolution: "resolved",
      weight: 1,
      callSites: [expect.objectContaining({ file: "packages/app/src/index.ts", line: 3 })],
    });
  });

  it("stitches a constructor type reference through a sibling-project tsconfig path alias", async () => {
    const root = autopilotPathAliasWorkspace();

    const result = await createTypeScriptExtractor().extract({ root });
    const aliasId = `ts:${AUTHORIZER_FILE}#ToolExecutionTargetAuthorizer`;
    const constructorId = `ts:${WEB_SEARCH_FILE}#WebSearchTool.constructor`;

    expect(result.nodes.find((node) => node.id === aliasId)).toMatchObject({ kind: "typeAlias" });
    expect(
      result.edges.find(
        (edge) => edge.kind === "references" && edge.source === constructorId && edge.target === aliasId,
      ),
    ).toMatchObject({
      resolution: "resolved",
      weight: 1,
      callSites: [
        expect.objectContaining({
          file: "src/aria/app/src/lib/commontools/tools/WebSearchTool.ts",
          line: 3,
        }),
      ],
    });
  });

  it("resolves the same constructor edge in an exact bounded include without widening its file set", async () => {
    const root = autopilotPathAliasWorkspace();
    const result = await createTypeScriptExtractor().extract({
      root,
      include: [WEB_SEARCH_FILE, AUTHORIZER_FILE],
      valueRefs: true,
      includeUnresolved: true,
    });
    const aliasId = `ts:${AUTHORIZER_FILE}#ToolExecutionTargetAuthorizer`;
    const constructorId = `ts:${WEB_SEARCH_FILE}#WebSearchTool.constructor`;

    expect(result.stats.files).toBe(2);
    expect(result.nodes.some((node) => node.location.file === "src/aria/lib/contracts/PolicyTarget.ts")).toBe(false);
    expect(
      result.edges.find(
        (edge) => edge.kind === "imports" && edge.source === `ts:${WEB_SEARCH_FILE}`
          && edge.target === `ts:${AUTHORIZER_FILE}`,
      ),
    ).toMatchObject({ resolution: "resolved", weight: 1 });
    expect(
      result.edges.find(
        (edge) => edge.kind === "references" && edge.source === constructorId && edge.target === aliasId,
      ),
    ).toMatchObject({
      resolution: "resolved",
      weight: 1,
      callSites: [expect.objectContaining({ file: WEB_SEARCH_FILE, line: 3 })],
    });
  });
});

function autopilotPathAliasWorkspace(): string {
  return workspace({
    "tsconfig.json": JSON.stringify({
      files: [],
      references: [
        { path: "./src/aria/app" },
        { path: "./src/aria/lib" },
      ],
    }),
    "src/aria/app/package.json": JSON.stringify({ name: "uipath-delegate" }),
    "src/aria/app/tsconfig.json": JSON.stringify({
      compilerOptions: {
        baseUrl: ".",
        moduleResolution: "bundler",
        paths: { "@aria/lib/*": ["../lib/*"] },
      },
      include: ["src/**/*.ts", "../lib/**/*.ts"],
    }),
    [WEB_SEARCH_FILE]: [
      "import type { ToolExecutionTargetAuthorizer } from '@aria/lib/contracts/IToolExecutionPolicyEvaluator';",
      "export class WebSearchTool {",
      "  constructor(private readonly authorizeTarget: ToolExecutionTargetAuthorizer) {}",
      "}",
    ].join("\n"),
    "src/aria/lib/tsconfig.json": JSON.stringify({ include: ["**/*.ts"] }),
    [AUTHORIZER_FILE]: [
      'import type { ToolExecutionPolicyEvaluationTarget } from "./PolicyTarget";',
      "export type ToolExecutionTargetAuthorizer = (target: ToolExecutionPolicyEvaluationTarget) => Promise<void>;",
    ].join("\n"),
    "src/aria/lib/contracts/PolicyTarget.ts":
      "export interface ToolExecutionPolicyEvaluationTarget { readonly toolName: string; }\n",
  });
}

function workspace(files: Record<string, string>): string {
  const root = absoluteRoot(mkdtempSync(join(tmpdir(), "meridian-type-aliases-")));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}
