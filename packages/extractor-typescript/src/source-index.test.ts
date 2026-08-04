import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTypeScriptExtractor, indexTypeScriptWorkspaceSources } from "./index";

const roots: string[] = [];
const LIMITS = {
  maxFiles: 100,
  maxSourceBytes: 1024 * 1024,
  maxFileBytes: 256 * 1024,
  maxSymbols: 1_000,
  maxAdjacencyEntries: 10_000,
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("syntax-only progressive source index", () => {
  it("matches canonical structural IDs and shares exact weak source topology", async () => {
    const root = workspace({
      "src/a.ts": `
        import { Service } from "./b";
        export function run(): void {
          const nested = (): void => {};
          nested();
        }
        export const api = { __private(): void {}, save(): void {} };
        export const service = new Service();
      `,
      "src/b.ts": `
        export class Service {
          load(): Promise<unknown> { return import("./c"); }
        }
        export interface Contract { execute(): void; }
      `,
      "src/c.ts": "export default function (): void {}",
    });
    const canonical = await createTypeScriptExtractor().extract({ root, include: ["src/**/*.ts"] });
    const indexed = indexTypeScriptWorkspaceSources({ root, seeds: ["src/a.ts"], limits: LIMITS });
    const canonicalIds = canonical.nodes
      .filter((node) => ["function", "method", "module", "class", "interface", "object"].includes(node.kind))
      .map((node) => node.id)
      .sort();

    expect(indexed.symbols.map(({ id }) => id).sort()).toEqual(canonicalIds);
    expect(indexed.symbols.find(({ qualifiedName }) => qualifiedName === "api.__private"))
      .toMatchObject({ isPrivateMethod: true, fileId: "ts:src/a.ts", stepCount: null });
    expect(indexed.topology).toEqual([
      { path: "src/a.ts", fileId: "ts:src/a.ts", neighbors: ["ts:src/b.ts"], uncertain: false },
      {
        path: "src/b.ts",
        fileId: "ts:src/b.ts",
        neighbors: ["ts:src/a.ts", "ts:src/c.ts"],
        uncertain: false,
      },
      { path: "src/c.ts", fileId: "ts:src/c.ts", neighbors: ["ts:src/b.ts"], uncertain: false },
    ]);
    expect(indexed).toMatchObject({ sourceFileCount: 3, adjacencyEntries: 4 });
  });

  it("matches canonical symbol ownership across workspace package ancestors and collisions", async () => {
    const root = workspace({
      "package.json": JSON.stringify({ private: true, workspaces: ["packages/*"] }),
      "packages/api/package.json": JSON.stringify({ name: "@fixture/api", main: "src/index.ts" }),
      "packages/api/src/index.ts": `
        export class Api {
          constructor(readonly value: string) {}
          resolve(input: string): string;
          resolve(input: number): number;
          resolve(input: string | number): string | number { return input; }
          get current(): string { return this.value; }
        }
        export namespace Helpers {
          export const nested = (): void => {
            const inner = (): void => {};
            inner();
          };
        }
        export const service = { save(): void {}, close: (): void => {} };
      `,
      "packages/app/package.json": JSON.stringify({ name: "@fixture/app", main: "src/index.ts" }),
      "packages/app/src/index.ts": `
        import { Api } from "@fixture/api";
        export default function boot(): Api { return new Api("ready"); }
      `,
    });
    const canonical = await createTypeScriptExtractor().extract({ root });
    expect(canonical.nodes.some((node) => node.kind === "package")).toBe(true);
    const indexed = indexTypeScriptWorkspaceSources({
      root,
      seeds: ["packages/app/src/index.ts"],
      limits: LIMITS,
    });
    const canonicalOwnership = canonical.nodes
      .filter((node) => ["function", "method", "module", "class", "interface", "object"].includes(node.kind))
      .map((node) => ({ id: node.id, fileId: `ts:${node.location.file}` }))
      .sort((left, right) => left.id.localeCompare(right.id));
    const indexedOwnership = indexed.symbols
      .map(({ id, fileId }) => ({ id, fileId }))
      .sort((left, right) => left.id.localeCompare(right.id));

    expect(indexedOwnership).toEqual(canonicalOwnership);
    expect(indexed.topology.find(({ path }) => path === "packages/app/src/index.ts")?.neighbors)
      .toEqual(["ts:packages/api/src/index.ts"]);
  });

  it("fails before retaining an unbounded source or symbol inventory", () => {
    const root = workspace({
      "src/a.ts": "export function alpha(): void {}",
      "src/b.ts": "export function beta(): void {}",
    });
    expect(() => indexTypeScriptWorkspaceSources({
      root,
      seeds: ["src/a.ts"],
      limits: { ...LIMITS, maxFiles: 1 },
    })).toThrow("source topology could not be proven");
    expect(() => indexTypeScriptWorkspaceSources({
      root,
      seeds: ["src/a.ts"],
      limits: { ...LIMITS, maxFileBytes: 4 },
    })).toThrow("oversized source file");
    expect(() => indexTypeScriptWorkspaceSources({
      root,
      seeds: ["src/a.ts"],
      limits: { ...LIMITS, maxSymbols: 1 },
    })).toThrow("symbol limit");
  });
});

function workspace(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "meridian-source-index-"));
  roots.push(root);
  for (const [path, source] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), source);
  }
  return root;
}
