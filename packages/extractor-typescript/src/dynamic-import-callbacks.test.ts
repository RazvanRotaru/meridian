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
  root = absoluteRoot(mkdtempSync(join(tmpdir(), "meridian-dynamic-import-callbacks-")));
  write("tsconfig.json", JSON.stringify({
    compilerOptions: { module: "esnext", moduleResolution: "bundler", strict: true },
    include: ["src/**/*.ts"],
  }));
  write("src/composeHostSecureStore.ts", [
    "export function composeHostSecureStore(): string {",
    '  return "secure";',
    "}",
    "",
  ].join("\n"));
  write("src/delegateBackendServices.ts", [
    "export function getHostSecureStore() {",
    '  return import("./composeHostSecureStore")',
    "    .then(({ composeHostSecureStore }) => composeHostSecureStore());",
    "}",
    "",
    "export function getRenamedHostSecureStore() {",
    '  return import("./composeHostSecureStore")',
    "    .then(({ composeHostSecureStore: compose }) => compose());",
    "}",
    "",
    "export function resolveLookalike() {",
    '  return Promise.resolve({ composeHostSecureStore: () => "local" })',
    "    .then(({ composeHostSecureStore }) => composeHostSecureStore());",
    "}",
    "",
  ].join("\n"));

  result = await createTypeScriptExtractor().extract({
    root,
    project: join(root, "tsconfig.json"),
    includeExternal: true,
    includeUnresolved: true,
  });
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("dynamic import callback calls", () => {
  it("resolves a destructured export to its function declaration", () => {
    expect(callToComposeFrom("getHostSecureStore")).toMatchObject({
      kind: "calls",
      resolution: "resolved",
      target: "ts:src/composeHostSecureStore.ts#composeHostSecureStore",
      callSites: [expect.objectContaining({ file: "src/delegateBackendServices.ts", line: 3 })],
    });
  });

  it("resolves a renamed destructured export", () => {
    expect(callToComposeFrom("getRenamedHostSecureStore")).toMatchObject({
      kind: "calls",
      resolution: "resolved",
      target: "ts:src/composeHostSecureStore.ts#composeHostSecureStore",
      callSites: [expect.objectContaining({ file: "src/delegateBackendServices.ts", line: 8 })],
    });
  });

  it("does not infer module provenance from an ordinary Promise destructure", () => {
    expect(callToComposeFrom("resolveLookalike")).toBeUndefined();
  });
});

function callToComposeFrom(sourceName: string) {
  return result.edges.find((edge) => (
    edge.kind === "calls"
    && edge.source === `ts:src/delegateBackendServices.ts#${sourceName}`
    && edge.target === "ts:src/composeHostSecureStore.ts#composeHostSecureStore"
  ));
}
