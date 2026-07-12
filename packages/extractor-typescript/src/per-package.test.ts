/**
 * Per-package extraction end to end: a multi-package workspace is analyzed one bounded
 * project at a time, and the join stitches cross-package calls, subpath imports, star
 * re-export chains, and module `imports` edges back together — producing the same graph a
 * whole-program (tsconfig) extraction yields, without ever holding the workspace in one
 * ts-morph program.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ExtractionResult, GraphEdge } from "@meridian/core";
import { extractPerPackage } from "./extract-per-package";
import { createTypeScriptExtractor } from "./index";
import { absoluteRoot } from "./paths";

let root: string;
let result: ExtractionResult;

function write(rel: string, content: string): void {
  mkdirSync(join(root, rel, ".."), { recursive: true });
  writeFileSync(join(root, rel), content);
}

beforeAll(async () => {
  // Canonicalize: mkdtemp can hand back an 8.3 short-name root on Windows, which would make
  // the tsconfig-mode comparison see every file as outside the root.
  root = absoluteRoot(mkdtempSync(join(tmpdir(), "meridian-perpkg-")));
  write("packages/util/package.json", JSON.stringify({ name: "@fix/util" }));
  write("packages/util/src/index.ts", "export function normalize(input: string): string {\n  return input.trim();\n}\n");
  write("packages/core/package.json", JSON.stringify({ name: "@fix/core" }));
  write(
    "packages/core/src/index.ts",
    'export { parseOrder } from "./orders";\nexport { helper } from "./helpers";\nexport * from "@util-alias/index";\n',
  );
  write(
    "packages/core/src/orders.ts",
    'import { normalize } from "@fix/util";\nimport { rootAliased } from "@core-local/rootAlias";\n' +
      "export function parseOrder(raw: string): string {\n  return rootAliased() + normalize(raw);\n}\n",
  );
  write("packages/core/src/rootAlias.ts", 'export function rootAliased(): string {\n  return "";\n}\n');
  write("packages/core/src/helpers.ts", "export function helper(): number {\n  return 1;\n}\n");
  write("packages/core/src/alias.ts", "export function aliasOnly(): number {\n  return 1;\n}\n");
  write("packages/ui/package.json", JSON.stringify({ name: "@fix/ui" }));
  write("packages/ui/tsconfig.json", JSON.stringify({
    compilerOptions: { baseUrl: ".", paths: { "@ui/*": ["src/*"], "@alias/*": ["../core/src/*"] } },
    include: ["src/**/*.ts"],
  }));
  write("packages/ui/src/local.ts", "export function localOnly(): number {\n  return 1;\n}\n");
  write(
    "packages/ui/src/app.ts",
    'import { helper, normalize, parseOrder } from "@fix/core";\nimport { helper as helperDirect } from "@fix/core/helpers";\n' +
      'import { localOnly } from "@ui/local";\n' +
      'import { aliasOnly } from "@alias/alias";\n' +
      "export function runApp(): string {\n  helper();\n  helperDirect();\n  localOnly();\n  aliasOnly();\n  return parseOrder(normalize(\" x \"));\n}\n",
  );
  write("tools/local.ts", "export function auditLocal(): void {}\n");
  write(
    "tools/audit.ts",
    'import { normalize } from "@fix/util";\nimport { auditLocal } from "@tools/local";\n' +
      'export function audit(): string {\n  auditLocal();\n  return normalize("z");\n}\n',
  );
  write("tsconfig.json", JSON.stringify({
    compilerOptions: {
      baseUrl: ".",
      moduleResolution: "node",
      paths: {
        "@fix/util": ["packages/util/src/index.ts"],
        "@fix/util/*": ["packages/util/src/*"],
        "@fix/core": ["packages/core/src/index.ts"],
        "@fix/core/*": ["packages/core/src/*"],
        "@ui/*": ["packages/ui/src/*"],
        "@alias/*": ["packages/core/src/*"],
        "@core-local/*": ["packages/core/src/*"],
        "@util-alias/*": ["packages/util/src/*"],
        "@tools/*": ["tools/*"],
      },
    },
    include: ["packages/**/*.ts", "tools/**/*.ts"],
  }));
  result = extractPerPackage({ root });
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

function resolvedEdge(from: ExtractionResult, kind: string, source: string, target: string): GraphEdge | undefined {
  return from.edges.find(
    (edge) => edge.kind === kind && edge.source === source && edge.target === target && edge.resolution === "resolved",
  );
}

describe("extractPerPackage", () => {
  it("resolves a direct cross-package named-import call", () => {
    expect(
      resolvedEdge(result, "calls", "ts:packages/core/src/orders.ts#parseOrder", "ts:packages/util/src/index.ts#normalize"),
    ).toBeDefined();
  });

  it("resolves calls through the target package's entry re-export", () => {
    expect(
      resolvedEdge(result, "calls", "ts:packages/ui/src/app.ts#runApp", "ts:packages/core/src/orders.ts#parseOrder"),
    ).toBeDefined();
  });

  it("resolves a call through a cross-package star re-export chain", () => {
    expect(
      resolvedEdge(result, "calls", "ts:packages/ui/src/app.ts#runApp", "ts:packages/util/src/index.ts#normalize"),
    ).toBeDefined();
  });

  it("resolves a subpath import call, and aggregates it with the entry import of the same target", () => {
    const viaEntryAndSubpath = resolvedEdge(
      result,
      "calls",
      "ts:packages/ui/src/app.ts#runApp",
      "ts:packages/core/src/helpers.ts#helper",
    );
    expect(viaEntryAndSubpath).toBeDefined();
    expect(viaEntryAndSubpath?.weight).toBe(2); // helper() via entry + helperDirect() via subpath fold together
  });

  it("resolves cross-package module imports edges", () => {
    expect(resolvedEdge(result, "imports", "ts:packages/ui/src/app.ts", "ts:packages/core/src/index.ts")).toBeDefined();
    expect(resolvedEdge(result, "imports", "ts:packages/core/src/orders.ts", "ts:packages/util/src/index.ts")).toBeDefined();
    expect(resolvedEdge(result, "imports", "ts:packages/ui/src/app.ts", "ts:packages/core/src/helpers.ts")).toBeDefined();
  });

  it("honours a package-local tsconfig alias without externalizing it", () => {
    expect(
      resolvedEdge(result, "calls", "ts:packages/ui/src/app.ts#runApp", "ts:packages/ui/src/local.ts#localOnly"),
    ).toBeDefined();
    expect(
      resolvedEdge(result, "imports", "ts:packages/ui/src/app.ts", "ts:packages/ui/src/local.ts"),
    ).toBeDefined();
  });

  it("joins a package-local alias whose target is in another workspace unit", () => {
    expect(
      resolvedEdge(result, "calls", "ts:packages/ui/src/app.ts#runApp", "ts:packages/core/src/alias.ts#aliasOnly"),
    ).toBeDefined();
    expect(
      resolvedEdge(result, "imports", "ts:packages/ui/src/app.ts", "ts:packages/core/src/alias.ts"),
    ).toBeDefined();
  });

  it("honours a root-only alias inside a unit with no package tsconfig", () => {
    expect(
      resolvedEdge(
        result,
        "calls",
        "ts:packages/core/src/orders.ts#parseOrder",
        "ts:packages/core/src/rootAlias.ts#rootAliased",
      ),
    ).toBeDefined();
  });

  it("keeps files outside every package in the graph (rest unit)", () => {
    expect(result.nodes.some((node) => node.id === "ts:tools/audit.ts#audit")).toBe(true);
    expect(resolvedEdge(result, "calls", "ts:tools/audit.ts#audit", "ts:packages/util/src/index.ts#normalize")).toBeDefined();
    expect(resolvedEdge(result, "calls", "ts:tools/audit.ts#audit", "ts:tools/local.ts#auditLocal")).toBeDefined();
  });

  it("produces the same nodes and resolved edges as a whole-program tsconfig extraction", async () => {
    const whole = await createTypeScriptExtractor().extract({ root, project: join(root, "tsconfig.json") });
    const ids = (extraction: ExtractionResult) => [...extraction.nodes.map((node) => node.id)].sort();
    const resolvedTuples = (extraction: ExtractionResult) =>
      extraction.edges
        .filter((edge) => edge.resolution === "resolved")
        .map((edge) => `${edge.kind}|${edge.source}|${edge.target}|${edge.weight}`)
        .sort();
    expect(ids(result)).toEqual(ids(whole));
    expect(resolvedTuples(result)).toEqual(resolvedTuples(whole));
  });
});

describe("extractPerPackage cross-package resolution edge cases", () => {
  let edgeRoot: string;
  let edges: ExtractionResult["edges"];

  function w(rel: string, content: string): void {
    mkdirSync(join(edgeRoot, rel, ".."), { recursive: true });
    writeFileSync(join(edgeRoot, rel), content);
  }

  beforeAll(() => {
    edgeRoot = absoluteRoot(mkdtempSync(join(tmpdir(), "meridian-perpkg-edge-")));
    w("packages/dep/package.json", JSON.stringify({ name: "@fix/dep" }));
    w(
      "packages/dep/src/index.ts",
      "export function provide(): number {\n  return 1;\n}\n" +
        "export class Registry {\n  static register(): number {\n    return 3;\n  }\n  handle(): number {\n    return 4;\n  }\n}\n" +
        "export interface Provider {\n  get(): number;\n}\n",
    );
    w("packages/dep/src/deep.ts", "export function deep(): number {\n  return 2;\n}\n");
    // A node_modules copy so a bare `@fix/dep` specifier resolves there (external) in a unit
    // project that carries no workspace aliases — the finding-5 scenario (installed monorepo).
    w("node_modules/@fix/dep/package.json", JSON.stringify({ name: "@fix/dep", types: "index.d.ts" }));
    w("node_modules/@fix/dep/index.d.ts", "export declare function provide(): number;\n");
    w("node_modules/@fix/dep/deep.d.ts", "export declare function deep(): number;\n");

    w("packages/named/package.json", JSON.stringify({ name: "@fix/named" }));
    w(
      "packages/named/src/index.ts",
      'import { provide } from "@fix/dep";\nexport function useNamed(): number {\n  return provide();\n}\n',
    );
    w("packages/ns/package.json", JSON.stringify({ name: "@fix/ns" }));
    w(
      "packages/ns/src/index.ts",
      'import * as dep from "@fix/dep";\nexport function useNamespace(): number {\n  return dep.provide();\n}\n',
    );
    w("packages/js/package.json", JSON.stringify({ name: "@fix/js" }));
    w(
      "packages/js/src/index.ts",
      'import { deep } from "@fix/dep/deep.js";\nexport function useJsExt(): number {\n  return deep();\n}\n',
    );
    w("packages/rel/package.json", JSON.stringify({ name: "@fix/rel" }));
    w(
      "packages/rel/src/index.ts",
      'import { provide } from "../../dep/src/index";\nexport function useRelative(): number {\n  return provide();\n}\n',
    );
    w("packages/member/package.json", JSON.stringify({ name: "@fix/member" }));
    w(
      "packages/member/src/index.ts",
      'import { Registry } from "@fix/dep";\nexport function useMember(): number {\n  return Registry.register();\n}\n',
    );
    // Instance-method call through a `const x = new SiblingClass()` local.
    w("packages/inst/package.json", JSON.stringify({ name: "@fix/inst" }));
    w(
      "packages/inst/src/index.ts",
      'import { Registry } from "@fix/dep";\nexport function useInstance(): number {\n  const r = new Registry();\n  return r.handle();\n}\n',
    );
    // Method call on a parameter typed by a cross-package interface.
    w("packages/iface/package.json", JSON.stringify({ name: "@fix/iface" }));
    w(
      "packages/iface/src/index.ts",
      'import type { Provider } from "@fix/dep";\nexport function useIface(p: Provider): number {\n  return p.get();\n}\n',
    );
    edges = extractPerPackage({ root: edgeRoot }).edges;
  });

  afterAll(() => rmSync(edgeRoot, { recursive: true, force: true }));

  function resolved(kind: string, source: string, target: string): boolean {
    return edges.some((e) => e.kind === kind && e.source === source && e.target === target && e.resolution === "resolved");
  }

  it("resolves a named import that resolves through an installed node_modules copy (finding 5)", () => {
    expect(resolved("calls", "ts:packages/named/src/index.ts#useNamed", "ts:packages/dep/src/index.ts#provide")).toBe(true);
  });

  it("resolves a cross-package call made through a namespace import (finding 4)", () => {
    expect(resolved("calls", "ts:packages/ns/src/index.ts#useNamespace", "ts:packages/dep/src/index.ts#provide")).toBe(true);
  });

  it("resolves a subpath import written with an explicit .js extension (finding 3)", () => {
    expect(resolved("calls", "ts:packages/js/src/index.ts#useJsExt", "ts:packages/dep/src/deep.ts#deep")).toBe(true);
  });

  it("resolves a cross-package reference written as a relative path (finding 2)", () => {
    expect(resolved("calls", "ts:packages/rel/src/index.ts#useRelative", "ts:packages/dep/src/index.ts#provide")).toBe(true);
    expect(resolved("imports", "ts:packages/rel/src/index.ts", "ts:packages/dep/src/index.ts")).toBe(true);
  });

  it("resolves a cross-package call to a member of an imported class", () => {
    expect(resolved("calls", "ts:packages/member/src/index.ts#useMember", "ts:packages/dep/src/index.ts#Registry.register")).toBe(
      true,
    );
  });

  it("resolves an instance-method call through a `new SiblingClass()` local", () => {
    expect(resolved("calls", "ts:packages/inst/src/index.ts#useInstance", "ts:packages/dep/src/index.ts#Registry.handle")).toBe(
      true,
    );
  });

  it("resolves a method call on a parameter typed by a cross-package interface", () => {
    expect(resolved("calls", "ts:packages/iface/src/index.ts#useIface", "ts:packages/dep/src/index.ts#Provider.get")).toBe(true);
  });
});
