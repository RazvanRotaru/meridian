/**
 * Workspace partitioning for per-package extraction: every named package.json dir becomes a
 * unit claiming its own files (nested packages excluded from the parent), leftover files fall
 * into a root "rest" unit, and import specifiers match back to their owning unit.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { absoluteRoot } from "./paths";
import { discoverWorkspaceUnits, type Workspace } from "./workspace-units";

let root: string;
let workspace: Workspace;

function write(rel: string, content: string): void {
  mkdirSync(join(root, rel, ".."), { recursive: true });
  writeFileSync(join(root, rel), content);
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "meridian-wsunits-"));
  write("packages/core/package.json", JSON.stringify({ name: "@fix/core" }));
  write("packages/core/src/index.ts", "export const c = 1;\n");
  // A package nested INSIDE another package's tree: owns its own files.
  write("packages/core/embedded/package.json", JSON.stringify({ name: "@fix/embedded" }));
  write("packages/core/embedded/index.ts", "export const e = 1;\n");
  write("packages/util/package.json", JSON.stringify({ name: "@fix/util" }));
  write("packages/util/src/index.ts", "export const u = 1;\n");
  // A package.json without a name claims files but matches no specifier.
  write("packages/anon/package.json", "{}");
  write("packages/anon/x.ts", "export const x = 1;\n");
  // A file under no package at all: belongs to the rest unit.
  write("tools/audit.ts", "export const a = 1;\n");
  workspace = discoverWorkspaceUnits(absoluteRoot(root));
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("discoverWorkspaceUnits", () => {
  it("emits one unit per package.json dir plus a rest unit, sorted by dir", () => {
    expect(workspace.units.map((unit) => unit.dir)).toEqual([
      "",
      "packages/anon",
      "packages/core",
      "packages/core/embedded",
      "packages/util",
    ]);
  });

  it("names units from package.json and leaves the rest unit and nameless packages unnamed", () => {
    const byDir = new Map(workspace.units.map((unit) => [unit.dir, unit]));
    expect(byDir.get("packages/core")?.name).toBe("@fix/core");
    expect(byDir.get("packages/util")?.name).toBe("@fix/util");
    expect(byDir.get("packages/anon")?.name).toBeNull();
    expect(byDir.get("")?.name).toBeNull();
  });

  it("claims each unit's own tree and excludes nested units from their parents", () => {
    const byDir = new Map(workspace.units.map((unit) => [unit.dir, unit]));
    const core = byDir.get("packages/core");
    expect(core?.include).toEqual(["packages/core/**/*.ts", "packages/core/**/*.tsx"]);
    expect(core?.exclude).toEqual(["packages/core/embedded/**"]);
    const rest = byDir.get("");
    expect(rest?.include).toEqual(["**/*.ts", "**/*.tsx"]);
    expect(rest?.exclude).toEqual([
      "packages/anon/**",
      "packages/core/**",
      "packages/util/**",
    ]);
  });

  it("records each named unit's entry file and source dir for specifier resolution", () => {
    const byDir = new Map(workspace.units.map((unit) => [unit.dir, unit]));
    expect(byDir.get("packages/core")?.entryFile).toBe("packages/core/src/index.ts");
    expect(byDir.get("packages/core")?.sourceDir).toBe("packages/core/src");
    expect(byDir.get("packages/core/embedded")?.entryFile).toBe("packages/core/embedded/index.ts");
    expect(byDir.get("packages/core/embedded")?.sourceDir).toBe("packages/core/embedded");
  });
});

describe("matchSpecifier", () => {
  it("matches a bare package name to its unit with no subpath", () => {
    const match = workspace.matchSpecifier("@fix/core");
    expect(match?.unit.dir).toBe("packages/core");
    expect(match?.subpath).toBeNull();
  });

  it("matches a subpath specifier and returns the path under the package source dir", () => {
    const match = workspace.matchSpecifier("@fix/core/helpers/format");
    expect(match?.unit.dir).toBe("packages/core");
    expect(match?.subpath).toBe("helpers/format");
  });

  it("rejects lookalike prefixes, unknown packages, and relative specifiers", () => {
    expect(workspace.matchSpecifier("@fix/core-extra")).toBeNull();
    expect(workspace.matchSpecifier("@other/pkg")).toBeNull();
    expect(workspace.matchSpecifier("./local")).toBeNull();
  });
});
