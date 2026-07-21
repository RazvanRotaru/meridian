import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ExtractionResult } from "@meridian/core";
import { createTypeScriptExtractor } from "./index";
import { absoluteRoot } from "./paths";

let root: string;
let result: ExtractionResult;

function write(relativePath: string, content: string): void {
  const path = join(root, relativePath);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

beforeAll(async () => {
  root = absoluteRoot(mkdtempSync(join(tmpdir(), "meridian-runtime-imports-")));
  write("package.json", JSON.stringify({
    name: "runtime-imports",
    dependencies: { "@vendor/widget": "1.0.0", react: "1.0.0" },
  }));
  write("tsconfig.json", JSON.stringify({
    compilerOptions: { jsx: "react-jsx", moduleResolution: "node" },
    include: ["src/**/*.ts", "src/**/*.tsx"],
  }));
  write("src/PwaChatAppEntry.tsx", "export const PwaChatApp = () => null;\n");
  write("src/App.tsx", [
    'import { lazy } from "react";',
    "",
    "export const LazyPwaChatApp = lazy(async () => {",
    '  const mod = await import("./PwaChatAppEntry");',
    "  return { default: mod.PwaChatApp };",
    "});",
    "",
    "export async function loadAgain() {",
    "  return import(`./PwaChatAppEntry`);",
    "}",
    "",
    "export async function loadComputed(name: string) {",
    "  return import(`./${name}`);",
    "}",
    "",
    "export async function loadExternal() {",
    '  return import("@vendor/widget");',
    "}",
    "",
    "export async function loadMissing() {",
    '  return import("./missing");',
    "}",
    "",
    "export async function loadWrapped() {",
    '  return import(("./PwaChatAppEntry" as const));',
    "}",
  ].join("\n"));

  result = await createTypeScriptExtractor().extract({
    root,
    project: join(root, "tsconfig.json"),
    includeExternal: true,
    includeUnresolved: true,
  });
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("runtime TypeScript imports", () => {
  it("resolves literal dynamic imports to one module edge with exact evidence", () => {
    const edge = result.edges.find(
      (candidate) =>
        candidate.kind === "imports" &&
        candidate.source === "ts:src/App.tsx" &&
        candidate.target === "ts:src/PwaChatAppEntry.tsx",
    );

    expect(edge).toMatchObject({ resolution: "resolved", weight: 3 });
    expect(edge?.callSites).toEqual([
      expect.objectContaining({ file: "src/App.tsx", line: 4 }),
      expect.objectContaining({ file: "src/App.tsx", line: 9 }),
      expect.objectContaining({ file: "src/App.tsx", line: 25 }),
    ]);
  });

  it("keeps external module identity and ignores computed targets", () => {
    expect(result.edges).toContainEqual(expect.objectContaining({
      kind: "imports",
      source: "ts:src/App.tsx",
      target: "ext:npm/@vendor/widget",
      resolution: "external",
      callSites: [expect.objectContaining({ file: "src/App.tsx", line: 17 })],
    }));
    expect(importSites().some((site) => [13, 21].includes(site.line))).toBe(false);
  });

  it("does not count import expressions as unresolved function calls", () => {
    expect(result.edges.filter(
      (edge) => edge.kind === "calls" && edge.resolution === "unresolved",
    )).toEqual([]);
    const callSites = result.edges.filter((edge) => edge.kind === "calls").flatMap((edge) => edge.callSites ?? []);
    expect(callSites.some((site) => [4, 9, 13, 17, 21, 25].includes(site.line))).toBe(false);
  });
});

function importSites() {
  return result.edges.filter((edge) => edge.kind === "imports").flatMap((edge) => edge.callSites ?? []);
}
