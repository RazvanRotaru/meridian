import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { materializeChannels, type ExtractionResult } from "@meridian/core";
import { Project, SyntaxKind } from "ts-morph";
import {
  createCrossPackageResolver,
  extractLoadedUnit,
  extractPerPackage,
  type UnitExtraction,
} from "./extract-per-package";
import { createTypeScriptExtractor } from "./index";
import { loadUnitProject } from "./project-loader";
import { absoluteRoot } from "./paths";
import { isStaticRpcFactoryCallSyntax } from "./rpc-ports-pass";
import { discoverWorkspaceUnits } from "./workspace-units";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const ROOT = join(REPO, "packages", "extractor-typescript", "fixtures", "rpc-proxy-stub");

describe("typed RPC proxy/stub ports", () => {
  it("uses only accepted member-call syntax as the cheap repository gate", () => {
    const project = new Project({ useInMemoryFileSystem: true });
    const source = project.createSourceFile("gate.ts", `
      declare const factory: any;
      declare function createProxy(): void;
      factory.createProxy<Service>("service");
      factory.createStub("service", handler);
      factory?.createProxy<Service>("optional");
      factory["createProxy"]<Service>("element");
      createProxy();
      factory.createProxy;
    `);

    expect(source.getDescendantsOfKind(SyntaxKind.CallExpression)
      .filter(isStaticRpcFactoryCallSyntax)
      .map((call) => call.getText())).toEqual([
      'factory.createProxy<Service>("service")',
      'factory.createStub("service", handler)',
      'factory?.createProxy<Service>("optional")',
    ]);
  });

  it("joins typed proxy calls to concrete stub methods by static service + method", async () => {
    const result = await createTypeScriptExtractor().extract({
      root: ROOT,
      project: join(ROOT, "tsconfig.json"),
    });
    const ports = result.ports ?? [];

    expect(ports.filter((port) => port.channel === "notes/save")).toEqual(expect.arrayContaining([
      expect.objectContaining({
        direction: "out",
        protocol: "rpc",
        lane: "service-method",
        surfaceId: "rpc.typed-proxy-call",
        nodeId: expect.stringContaining("#wire"),
        confidence: 1,
        callSite: expect.objectContaining({ line: 31 }),
      }),
      expect.objectContaining({
        direction: "in",
        protocol: "rpc",
        lane: "service-method",
        surfaceId: "rpc.dynamic-stub-dispatch",
        handlerNodeId: expect.stringContaining("NotesReceiver.save"),
        confidence: 1,
        callSite: expect.objectContaining({ line: 33 }),
      }),
    ]));

    expect(ports.filter((port) => port.channel === "notes/remove")).toEqual(expect.arrayContaining([
      expect.objectContaining({
        direction: "out",
        nodeId: expect.stringContaining("#callForwarded"),
      }),
      expect.objectContaining({
        direction: "in",
        handlerNodeId: expect.stringContaining("NotesReceiver.remove"),
      }),
    ]));
    expect(ports.some((port) => port.channel === "notes/secret")).toBe(false);
    expect(ports.some((port) => port.channel === "notes/helper")).toBe(false);

    const materialized = materializeChannels(result.nodes, result.edges, ports);
    const channel = materialized.nodes.find((node) => node.displayName === "notes/save");
    expect(channel).toBeTruthy();
    expect(materialized.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "sends",
        source: expect.stringContaining("#wire"),
        target: channel?.id,
      }),
      expect.objectContaining({
        kind: "handles",
        source: channel?.id,
        target: expect.stringContaining("NotesReceiver.save"),
      }),
    ]));
  });

  it("fails closed for dynamic service names, ambiguous receivers, and coincidental factories", async () => {
    const result = await createTypeScriptExtractor().extract({
      root: ROOT,
      project: join(ROOT, "tsconfig.json"),
    });
    const ports = result.ports ?? [];

    expect(ports.some((port) => port.nodeId.includes("dynamicService"))).toBe(false);
    expect(ports.some((port) => port.channel?.startsWith("ambiguous/"))).toBe(false);
    expect(ports.some((port) => port.nodeId.includes("coincidental"))).toBe(false);
  });

  it("retains paired imported factory evidence when a bounded project erases its type to any", async () => {
    const result = await createTypeScriptExtractor().extract({
      root: ROOT,
      project: join(ROOT, "tsconfig.json"),
    });
    const correlated = (result.ports ?? []).filter((port) => port.channel === "remote/ping");

    expect(correlated).toEqual(expect.arrayContaining([
      expect.objectContaining({ direction: "out", surfaceId: "rpc.typed-proxy-call" }),
      expect.objectContaining({
        direction: "in",
        surfaceId: "rpc.dynamic-stub-dispatch",
        handlerNodeId: expect.stringContaining("RemoteReceiver.ping"),
      }),
    ]));
  });
});

describe("typed RPC ports in a cross-package unit", () => {
  let crossRoot: string;
  let unit: UnitExtraction;
  let perPackage: ExtractionResult;
  let canonical: ExtractionResult;

  beforeAll(async () => {
    crossRoot = absoluteRoot(mkdtempSync(join(tmpdir(), "meridian-rpc-cross-package-")));
    const write = (relativePath: string, contents: string): void => {
      const path = join(crossRoot, relativePath);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, contents);
    };
    write("packages/factory/package.json", JSON.stringify({ name: "@rpc/factory" }));
    write("packages/factory/src/index.ts", `
      export interface RemoteService {
        ping(value: string): Promise<void>;
      }
      type Handler = (method: string, args: unknown[]) => unknown;
      export class RpcFactory {
        createProxy<T extends object>(_service: string): { proxy: T } {
          throw new Error("fixture");
        }
        createStub(_service: string, _handler: Handler): void {}
      }
    `);
    write("packages/app/package.json", JSON.stringify({ name: "@rpc/app" }));
    write("packages/app/src/index.ts", `
      import { RpcFactory, type RemoteService } from "@rpc/factory";
      class RemoteReceiver {
        async ping(_value: string): Promise<void> {}
        private async secret(): Promise<void> {}
      }
      function invokeThroughParameter(service: RemoteService): void {
        void service.ping("hello");
      }
      export function wireCrossPackage(receiver: RemoteReceiver): void {
        const factory = new RpcFactory();
        const { proxy: remote } = factory.createProxy<RemoteService>("cross");
        invokeThroughParameter(remote);
        factory.createStub("cross", (method, args) => (receiver as any)[method](...args));
      }
    `);
    write("tsconfig.json", JSON.stringify({
      compilerOptions: {
        baseUrl: ".",
        moduleResolution: "node",
        paths: { "@rpc/factory": ["packages/factory/src/index.ts"] },
        strict: true,
        target: "es2022",
      },
      include: ["packages/**/*.ts"],
    }));

    const workspace = discoverWorkspaceUnits(crossRoot);
    const appUnit = workspace.units.find((candidate) => candidate.dir === "packages/app");
    if (!appUnit) throw new Error("cross-package fixture app unit was not discovered");
    const options = { root: crossRoot };
    unit = extractLoadedUnit(
      appUnit,
      loadUnitProject(crossRoot, appUnit, options, workspace.memberPaths),
      options,
      createCrossPackageResolver(workspace, crossRoot),
      "function",
    );
    perPackage = extractPerPackage(options, workspace);
    canonical = await createTypeScriptExtractor().extract({
      root: crossRoot,
      project: join(crossRoot, "tsconfig.json"),
    });
  });

  afterAll(() => rmSync(crossRoot, { recursive: true, force: true }));

  it("preserves exact unit and stitched ports for imported factory types and parameter aliases", () => {
    const expected = canonical.ports ?? [];
    expect(unit.ports).toEqual(expected);
    expect(perPackage.ports).toEqual(expected);
    expect(expected.filter((port) => port.channel === "cross/ping")).toEqual([
      expect.objectContaining({
        direction: "out",
        surfaceId: "rpc.typed-proxy-call",
        nodeId: expect.stringContaining("#invokeThroughParameter"),
        confidence: 1,
      }),
      expect.objectContaining({
        direction: "in",
        surfaceId: "rpc.dynamic-stub-dispatch",
        handlerNodeId: expect.stringContaining("RemoteReceiver.ping"),
        confidence: 1,
      }),
    ]);
    expect(expected.some((port) => port.channel === "cross/secret")).toBe(false);
  });
});
