/**
 * The loader's solution-style fallback: a tsconfig with `"files": []` + `references` (monorepo
 * roots) loads ZERO sources through the config, and the loader must fall back to the glob scan
 * instead of silently producing an empty project — the bug that turns a monorepo into a 0-node
 * graph. Uses a throwaway on-disk fixture (ts-morph resolves real paths).
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
});
