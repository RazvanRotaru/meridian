import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ExtractionResult } from "@meridian/core";
import { createTypeScriptExtractor } from "./index";
import { absoluteRoot } from "./paths";

let root: string;
let withoutExternal: ExtractionResult;
let withExternal: ExtractionResult;

function write(relativePath: string, content: string): void {
  const path = join(root, relativePath);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

beforeAll(async () => {
  root = absoluteRoot(mkdtempSync(join(tmpdir(), "meridian-import-types-")));
  write("package.json", JSON.stringify({
    name: "import-types",
    dependencies: { "@vendor/contracts": "1.0.0" },
  }));
  write("tsconfig.json", JSON.stringify({
    compilerOptions: { moduleResolution: "node" },
    include: ["src/**/*.ts"],
  }));
  write("src/contracts.ts", "export interface HostFsWiring { root: string }\n");
  write("src/consumer.ts", [
    "export function getHostFsWiring(): Promise<import('./contracts').HostFsWiring> {",
    "  throw new Error();",
    "}",
    "export type Missing = import('./missing').MissingContract;",
    "export type Vendor = import('@vendor/contracts').VendorContract;",
  ].join("\n"));

  const extractor = createTypeScriptExtractor();
  const options = { root, project: join(root, "tsconfig.json") };
  withoutExternal = await extractor.extract(options);
  withExternal = await extractor.extract({ ...options, includeExternal: true });
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("inline TypeScript import types", () => {
  it("emits a resolved module import with the ImportTypeNode as evidence", () => {
    const edge = withoutExternal.edges.find(
      (candidate) =>
        candidate.kind === "imports" &&
        candidate.source === "ts:src/consumer.ts" &&
        candidate.target === "ts:src/contracts.ts",
    );

    expect(edge).toMatchObject({ resolution: "resolved", weight: 1 });
    expect(edge?.callSites).toEqual([
      expect.objectContaining({ file: "src/consumer.ts", line: 1 }),
    ]);
  });

  it("keeps external import-type qualifiers and does not externalize missing relative modules", () => {
    const externalImports = withExternal.edges.filter(
      (edge) => edge.kind === "imports" && edge.resolution === "external",
    );

    expect(externalImports.map((edge) => edge.target)).toContain("ext:npm/@vendor/contracts#VendorContract");
    expect(externalImports.some((edge) => edge.target.includes("missing"))).toBe(false);
  });
});
