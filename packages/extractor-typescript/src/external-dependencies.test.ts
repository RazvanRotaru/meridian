/** End-to-end POC for package/alias imports as stable external dependency boundaries. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { materializeBoundaryNodes, validateArtifact, type ExtractionResult, type GraphArtifact } from "@meridian/core";
import { createTypeScriptExtractor } from "./index";
import { loadProject } from "./project-loader";
import { absoluteRoot } from "./paths";

let workspace: string;
let root: string;
let withoutExternal: ExtractionResult;
let withExternal: ExtractionResult;

function write(relativePath: string, content: string): void {
  const path = join(workspace, relativePath);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

beforeAll(async () => {
  workspace = mkdtempSync(join(tmpdir(), "meridian-external-deps-"));
  root = join(workspace, "app");
  write("app/package.json", JSON.stringify({
    name: "external-poc",
    dependencies: {
      "@vendor/sdk": "1.0.0",
      "@missing/contracts": "1.0.0",
      "@missing/services": "1.0.0",
      "__external__": "1.0.0",
    },
  }));
  write("app/tsconfig.json", JSON.stringify({
    compilerOptions: {
      baseUrl: ".",
      moduleResolution: "node",
      paths: { "@app/*": ["src/*"], "@shared/*": ["../shared/*"], "#platform": ["../shared/platform.ts"] },
    },
    include: ["src/**/*.ts", "../shared/**/*.ts"],
  }));
  write("app/node_modules/@vendor/sdk/package.json", JSON.stringify({ name: "@vendor/sdk", types: "index.d.ts" }));
  write("app/node_modules/@vendor/sdk/index.d.ts", [
    "export interface PaymentRequest { cents: number }",
    "export interface UnusedContract { marker: string }",
    "export declare class PaymentService { name: string; charge(request: PaymentRequest): void }",
    "export declare const SDK_VERSION: string;",
    "export declare function track(): void;",
    "export default class DefaultGateway { name: string }",
  ].join("\n"));
  write("app/node_modules/@vendor/sdk/register.d.ts", "export {};\n");
  write("shared/contracts.ts", "export class SharedService { send(): void {} }\n");
  write("shared/platform.ts", "export interface PlatformContract { region: string }\n");
  write("app/src/local.ts", "export function localCheck(): void {}\n");
  write(
    "app/src/sdk-barrel.ts",
    'export { PaymentService as BarrelService, track as barrelTrack } from "@vendor/sdk";\n',
  );
  write("app/src/missing-barrel.ts", 'export { MissingService } from "@missing/services";\n');
  write("app/src/local-barrel.ts", [
    'import { PaymentService as ImportedService } from "@vendor/sdk";',
    'import * as vendorNsImport from "@vendor/sdk";',
    'import { MissingService as ImportedMissing } from "@missing/services";',
    'import * as missingNsImport from "@missing/services";',
    "export { ImportedService as LocalService, vendorNsImport, ImportedMissing as LocalMissing, missingNsImport };",
  ].join("\n"));
  write("app/src/checkout.ts", source());

  root = absoluteRoot(root);
  const extractor = createTypeScriptExtractor();
  const options = { root, project: join(root, "tsconfig.json"), valueRefs: true };
  withoutExternal = await extractor.extract(options);
  withExternal = await extractor.extract({ ...options, includeExternal: true });
});

afterAll(() => rmSync(workspace, { recursive: true, force: true }));

describe("external package and tsconfig-alias dependencies", () => {
  it("loads the in-scope tsconfig alias through TypeScript", () => {
    const loaded = loadProject({ root, project: join(root, "tsconfig.json") });
    const checkout = loaded.sourceFiles.find((file) => file.getBaseName() === "checkout.ts");
    const local = checkout?.getImportDeclarations().find((declaration) => declaration.getModuleSpecifierValue() === "@app/local");
    expect(local?.getModuleSpecifierSourceFile()?.getBaseName()).toBe("local.ts");
  });

  it("keeps the existing opt-in policy while detecting what was dropped", () => {
    expect(withoutExternal.edges.some((edge) => edge.resolution === "external")).toBe(false);
    expect(withoutExternal.stats.externalCallsDropped).toBeGreaterThan(0);
    expect(resolved("imports", "ts:src/checkout.ts", "ts:src/local.ts", withoutExternal)).toBe(true);
  });

  it("inventories named, type-only, default, namespace, side-effect, and missing package imports", () => {
    const targets = externalTargets("imports");
    for (const target of [
      "ext:npm/@vendor/sdk/register",
      "ext:npm/@vendor/sdk#default",
      "ext:npm/@vendor/sdk#PaymentService",
      "ext:npm/@vendor/sdk#SDK_VERSION",
      "ext:npm/@vendor/sdk#PaymentRequest",
      "ext:npm/@vendor/sdk#UnusedContract",
      "ext:npm/@vendor/sdk",
      "ext:npm/@missing/services",
      "ext:npm/@missing/contracts#MissingContract",
      "ext:npm/%23platform#PlatformContract",
      "ext:npm/%5F%5Fexternal%5F%5F",
      "ext:npm/node:fs#readFile",
    ]) {
      expect(targets).toContain(target);
    }
    expect(targets).not.toContain("ext:npm/./missing#MissingLocal");
    expect(targets).not.toContain("ext:npm/@vendro/sdk#TypoContract");
    expect(targets).not.toContain("ext:__external__");
  });

  it("uses public import identities for external type and service usage", () => {
    expect(externalTargets("references")).toEqual(expect.arrayContaining([
      "ext:npm/@vendor/sdk#PaymentRequest",
      "ext:npm/@vendor/sdk#SDK_VERSION",
      "ext:npm/@vendor/sdk",
      "ext:npm/@missing/services",
      "ext:npm/@missing/contracts#MissingContract",
      "ext:npm/@shared/contracts#SharedService",
      "ext:npm/%23platform#PlatformContract",
    ]));
    expect(externalTargets("instantiates")).toEqual(expect.arrayContaining([
      "ext:npm/@vendor/sdk#default",
      "ext:npm/@vendor/sdk#PaymentService",
      "ext:npm/@missing/services#MissingService",
    ]));
    expect(externalTargets("calls")).toEqual(expect.arrayContaining([
      "ext:npm/@vendor/sdk#PaymentService.charge",
      "ext:npm/@vendor/sdk#track",
      "ext:npm/@shared/contracts#SharedService.send",
      "ext:npm/@missing/services#MissingService.run",
      "ext:npm/@missing/services#run",
    ]));
    const publicTargets = withExternal.edges
      .filter((edge) => edge.resolution === "external" && /vendor|missing|shared|platform/.test(edge.target))
      .map((edge) => edge.target);
    expect(
      publicTargets.some(
        (target) => target.includes("node_modules") || target.includes(".d.ts") || target.includes(workspace),
      ),
    ).toBe(false);
    expect(withExternal.edges.some((edge) => /^ext:npm\/(contracts|platform)\.ts/.test(edge.target))).toBe(false);
    expect(withExternal.edges.some((edge) => edge.target === "ext:npm/@vendor/sdk#PaymentService.map")).toBe(false);
    expect(
      withExternal.edges.some(
        (edge) =>
          edge.kind === "calls" &&
          edge.source === "ts:src/checkout.ts#ExternalApp.run" &&
          edge.target === "ext:npm/@vendor/sdk#PaymentService.charge",
      ),
    ).toBe(true);
    expect(
      withExternal.edges.some(
        (edge) =>
          edge.kind === "calls" &&
          edge.source === "ts:src/checkout.ts#MissingApp.run" &&
          edge.target === "ext:npm/@missing/services#MissingService.run",
      ),
    ).toBe(true);
  });

  it("retains explicit external service composition behind the same option", () => {
    expect(externalTargets("registers")).toContain("ext:npm/@vendor/sdk#PaymentService");
    expect(externalTargets("injects")).toContain("ext:npm/@vendor/sdk#PaymentService");
  });

  it("uses the same npm-qualified external id in dependency edges and Logic-flow calls", () => {
    const edge = withExternal.edges.find(
      (entry) => entry.kind === "calls" && entry.source === "ts:src/checkout.ts#ExternalApp.run",
    );
    const flow = withExternal.flows?.["ts:src/checkout.ts#ExternalApp.run"] ?? [];
    const call = flow.find((step) => step.kind === "call" && step.label === "charge");

    expect(edge?.target).toBe("ext:npm/@vendor/sdk#PaymentService.charge");
    expect(call).toMatchObject({ resolution: "external", target: edge?.target });
  });

  it("materializes valid boundary nodes and keeps an in-scope tsconfig alias resolved", () => {
    const nodes = materializeBoundaryNodes(withExternal.nodes, withExternal.edges);
    expect(nodes.find((node) => node.id === "ext:npm/@vendor/sdk#PaymentService")?.displayName).toBe("PaymentService");
    expect(resolved("imports", "ts:src/checkout.ts", "ts:src/local.ts", withExternal)).toBe(true);
    expect(validateArtifact(artifact(nodes)).errors).toEqual([]);
  });
});

function source(): string {
  return [
    'import "@vendor/sdk/register";',
    'import "__external__";',
    'import { readFile } from "node:fs";',
    'import DefaultGateway, { PaymentService as Billing, SDK_VERSION } from "@vendor/sdk";',
    'import type { PaymentRequest, UnusedContract } from "@vendor/sdk";',
    'import * as sdk from "@vendor/sdk";',
    'import type { MissingContract } from "@missing/contracts";',
    'import { localCheck } from "@app/local";',
    'import { SharedService } from "@shared/contracts";',
    'import type { PlatformContract } from "#platform";',
    'import type { MissingLocal } from "./missing";',
    'import type { TypoContract } from "@vendro/sdk";',
    'import { BarrelService, barrelTrack } from "./sdk-barrel";',
    'import { MissingService } from "./missing-barrel";',
    'import { LocalService, vendorNsImport, LocalMissing, missingNsImport } from "./local-barrel";',
    "class ServiceContainer { register(_key: string, _value: unknown): void {} get<T>(): T { throw new Error(); } }",
    "class ExternalApp { constructor(private injected: Billing) {} run(request: PaymentRequest): void { this.injected.charge(request); } }",
    "class MissingApp { constructor(private injected: MissingService) {} run(): void { this.injected.run(); } }",
    "class ServiceCollection { constructor(private services: Billing[]) {} names(): string[] { return this.services.map((service) => service.name); } }",
    "const container = new ServiceContainer();",
    "export function checkout(request: PaymentRequest, missing: MissingContract, payment: Billing, nullable: Billing | null, shared: SharedService, platform: PlatformContract): string {",
    "  const gateway = new DefaultGateway(); const created = new Billing();",
    "  const barrel = new BarrelService(); const absent = new MissingService();",
    "  const local = new LocalService(); const localMissing = new LocalMissing();",
    "  payment.charge(request); nullable?.charge(request); sdk.track(); barrelTrack(); vendorNsImport.track();",
    "  absent.run(); localMissing.run(); missingNsImport.run(); shared.send(); localCheck();",
    '  container.register("payment", Billing); container.get<Billing>();',
    "  return SDK_VERSION + gateway.name + created.name + barrel.name + local.name + missing.id + platform.region;",
    "}",
  ].join("\n");
}

function externalTargets(kind: string): string[] {
  return withExternal.edges.filter((edge) => edge.kind === kind && edge.resolution === "external").map((edge) => edge.target);
}

function resolved(kind: string, sourceId: string, targetId: string, result: ExtractionResult): boolean {
  return result.edges.some((edge) => edge.kind === kind && edge.source === sourceId && edge.target === targetId && edge.resolution === "resolved");
}

function artifact(nodes: ExtractionResult["nodes"]): GraphArtifact {
  return {
    schemaVersion: "1.0.0", generatedAt: new Date().toISOString(), generator: { name: "test", version: "0" },
    target: { name: "external-poc", root: ".", language: "typescript" }, nodes, edges: withExternal.edges,
  };
}
