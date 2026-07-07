/**
 * The structural pass tags a `package` node `npm-package` when its directory holds a package.json,
 * and leaves plain directories untagged — the signal the renderer's package-fold groups files by.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ExtractionResult } from "@meridian/core";
import { createTypeScriptExtractor } from "./index";

let root: string;
let result: ExtractionResult;

function writePackage(dir: string, name: string, file: string, source: string): void {
  mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, dir, "package.json"), JSON.stringify({ name }));
  writeFileSync(join(root, dir, file), source);
}

function tagsOf(id: string): string[] {
  return result.nodes.find((node) => node.id === id)?.tags ?? [];
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "meridian-npmpkg-"));
  writePackage("pkg-a", "pkg-a", "a.ts", "export const a = 1;\n");
  writePackage("pkg-b", "pkg-b", "b.ts", "export const b = 2;\n");
  // A plain directory with source but no package.json.
  mkdirSync(join(root, "plain"), { recursive: true });
  writeFileSync(join(root, "plain", "c.ts"), "export const c = 3;\n");
  result = await createTypeScriptExtractor().extract({ root });
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("structural pass npm-package tagging", () => {
  it("tags a package node whose directory holds a package.json", () => {
    expect(tagsOf("ts:pkg-a")).toContain("npm-package");
    expect(tagsOf("ts:pkg-b")).toContain("npm-package");
  });

  it("leaves a plain directory's package node untagged", () => {
    const plain = result.nodes.find((node) => node.id === "ts:plain");
    expect(plain?.kind).toBe("package");
    expect(tagsOf("ts:plain")).not.toContain("npm-package");
  });
});
