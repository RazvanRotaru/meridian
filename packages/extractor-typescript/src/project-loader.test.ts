/**
 * The loader's solution-style fallback: a tsconfig with `"files": []` + `references` (monorepo
 * roots) loads ZERO sources through the config, and the loader must fall back to the glob scan
 * instead of silently producing an empty project — the bug that turns a monorepo into a 0-node
 * graph. Uses a throwaway on-disk fixture (ts-morph resolves real paths).
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ts } from "ts-morph";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { absoluteRoot } from "./paths";
import { loadProject } from "./project-loader";

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "meridian-loader-"));
  writeFileSync(
    join(root, "tsconfig.json"),
    JSON.stringify({ files: [], references: [{ path: "./sub" }] }),
  );
  mkdirSync(join(root, "sub"));
  writeFileSync(join(root, "sub", "tsconfig.json"), JSON.stringify({ include: ["*.ts"] }));
  writeFileSync(join(root, "sub", "thing.ts"), "export function thing(): number { return 1; }\n");
  mkdirSync(join(root, "plugins", "e2e-tests", "specs"), { recursive: true });
  writeFileSync(join(root, "plugins", "e2e-tests", "package.json"), JSON.stringify({ name: "e2e-tests" }));
  writeFileSync(join(root, "plugins", "e2e-tests", "tsconfig.json"), JSON.stringify({ include: ["specs/**/*"] }));
  writeFileSync(join(root, "plugins", "e2e-tests", "specs", "approve.spec.ts"), "test('approve', () => {});\n");

  mkdirSync(join(root, "bounded", "src"), { recursive: true });
  mkdirSync(join(root, "bounded", "node_modules", "workspace-link"), { recursive: true });
  writeFileSync(
    join(root, "bounded", "tsconfig.json"),
    JSON.stringify({ compilerOptions: { moduleResolution: "node" } }),
  );
  writeFileSync(
    join(root, "bounded", "src", "entry.ts"),
    'import type { Hidden } from "workspace-link";\nexport const value: Hidden = { hidden: true };\n',
  );
  writeFileSync(
    join(root, "bounded", "src", "hidden.ts"),
    "export interface Hidden { hidden: true; }\n",
  );
  writeFileSync(
    join(root, "bounded", "node_modules", "workspace-link", "package.json"),
    JSON.stringify({ name: "workspace-link", types: "../../src/hidden.ts" }),
  );
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("loadProject", () => {
  it("falls back to the glob scan when a solution-style tsconfig loads zero sources", () => {
    const loaded = loadProject({ root, project: join(root, "tsconfig.json") });
    expect(loaded.sourceFiles.map((file) => loaded.relativePathOf(file))).toContain("sub/thing.ts");
  });

  it("keeps tsconfig-selected sources when the config actually lists files", () => {
    const loaded = loadProject({ root: join(root, "sub"), project: join(root, "sub", "tsconfig.json") });
    expect(loaded.sourceFiles).toHaveLength(1);
  });

  it("loads a supplemental changed-file project outside the solution references", () => {
    const loaded = loadProject({
      root,
      project: join(root, "tsconfig.json"),
      supplementalFiles: ["plugins/e2e-tests/specs/approve.spec.ts"],
    });

    expect(loaded.sourceFiles.map((file) => loaded.relativePathOf(file))).toContain(
      "plugins/e2e-tests/specs/approve.spec.ts",
    );
  });

  it("does not widen an explicit include through an external-classified in-root package target", () => {
    const boundedRoot = join(root, "bounded");
    const entryPath = join(boundedRoot, "src", "entry.ts");
    const hiddenPath = join(boundedRoot, "src", "hidden.ts");
    const rawResolution = ts.resolveModuleName(
      "workspace-link",
      entryPath,
      { moduleResolution: ts.ModuleResolutionKind.NodeJs },
      ts.sys,
    ).resolvedModule;
    expect(rawResolution?.isExternalLibraryImport).toBe(true);
    expect(rawResolution && absoluteRoot(rawResolution.resolvedFileName)).toBe(absoluteRoot(hiddenPath));

    const loaded = loadProject({ root: boundedRoot, include: ["src/entry.ts"] });

    loaded.project.resolveSourceFileDependencies();

    expect(loaded.sourceFiles.map((file) => loaded.relativePathOf(file))).toEqual(["src/entry.ts"]);
    expect(
      loaded.project.getSourceFiles()
        .filter((file) => !file.isDeclarationFile())
        .map((file) => loaded.relativePathOf(file)),
    ).toEqual(["src/entry.ts"]);
    expect(
      loaded.sourceFiles[0]
        .getImportDeclarationOrThrow("workspace-link")
        .getModuleSpecifierSourceFile(),
    ).toBeUndefined();
  });
});
