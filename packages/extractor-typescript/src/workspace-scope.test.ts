import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { manifestScopeGlobs } from "./workspace-scope";

/** Lay down a directory tree from a {relativePath: contents} map under a fresh temp root. */
function scaffold(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "ws-scope-"));
  for (const [rel, contents] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, contents);
  }
  return root;
}

const SOLUTION_TSCONFIG = JSON.stringify({ files: [], references: [{ path: "./pkgs" }, { path: "./app" }] });

describe("manifestScopeGlobs", () => {
  it("follows solution references and expands nested workspaces to member globs", () => {
    const root = scaffold({
      "tsconfig.json": SOLUTION_TSCONFIG,
      "pkgs/package.json": JSON.stringify({ workspaces: ["a", "b"] }),
      "pkgs/a/package.json": JSON.stringify({ name: "a" }),
      "pkgs/b/package.json": JSON.stringify({ name: "b" }),
      "app/package.json": JSON.stringify({ name: "app" }),
      "scripts/tool.ts": "export const x = 1;", // outside every member — must be out of scope
    });
    const globs = manifestScopeGlobs(root, join(root, "tsconfig.json"));
    expect(globs).toEqual([
      `${root}/app/**/*.ts`,
      `${root}/app/**/*.tsx`,
      `${root}/pkgs/a/**/*.ts`,
      `${root}/pkgs/a/**/*.tsx`,
      `${root}/pkgs/b/**/*.ts`,
      `${root}/pkgs/b/**/*.tsx`,
    ]);
    expect(globs?.some((g) => g.includes("/scripts/"))).toBe(false);
  });

  it("expands a `packages/*` workspace glob by listing directories", () => {
    const root = scaffold({
      "package.json": JSON.stringify({ workspaces: ["packages/*"] }),
      "packages/one/package.json": JSON.stringify({ name: "one" }),
      "packages/two/package.json": JSON.stringify({ name: "two" }),
    });
    const globs = manifestScopeGlobs(root, undefined);
    expect(globs).toEqual([
      `${root}/packages/one/**/*.ts`,
      `${root}/packages/one/**/*.tsx`,
      `${root}/packages/two/**/*.ts`,
      `${root}/packages/two/**/*.tsx`,
    ]);
  });

  it("returns null for a plain package (no solution tsconfig, no workspaces)", () => {
    const root = scaffold({
      "package.json": JSON.stringify({ name: "solo" }),
      "tsconfig.json": JSON.stringify({ compilerOptions: {}, include: ["src"] }),
      "src/index.ts": "export const x = 1;",
    });
    expect(manifestScopeGlobs(root, join(root, "tsconfig.json"))).toBeNull();
  });
});
