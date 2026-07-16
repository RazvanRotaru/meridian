/**
 * Golden: the ports pass over the real IPC fixtures — electron channels (desktop-notes),
 * fetch exits (checkout-web), express entries (orders-api). Dynamic channels must surface as
 * `channel: null`, never a guess.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Port } from "@meridian/core";
import { assignFinalIds } from "./finalize-nodes";
import { createTypeScriptExtractor } from "./index";
import { collectPorts } from "./ports-pass";
import type { PortModelCatalog } from "./port-surfaces";
import { loadProject } from "./project-loader";
import { buildResolutionIndex } from "./resolution-index";
import { buildStructure } from "./structural-pass";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

async function portsOf(fixture: string): Promise<Port[]> {
  const root = join(REPO, "examples", fixture);
  const result = await createTypeScriptExtractor().extract({ root, project: join(root, "tsconfig.json") });
  return result.ports ?? [];
}

async function portsOfExtractorFixture(fixture: string): Promise<Port[]> {
  const root = join(REPO, "packages", "extractor-typescript", "fixtures", fixture);
  const result = await createTypeScriptExtractor().extract({ root, project: join(root, "tsconfig.json") });
  return result.ports ?? [];
}

function portsOfExtractorFixtureWithModels(fixture: string, models: PortModelCatalog): Port[] {
  const root = join(REPO, "packages", "extractor-typescript", "fixtures", fixture);
  const loaded = loadProject({ root, project: join(root, "tsconfig.json") });
  const { descriptors, moduleByFilePath } = buildStructure(loaded, "ts");
  assignFinalIds(descriptors);
  const index = buildResolutionIndex(descriptors, moduleByFilePath, loaded.root);
  return collectPorts(loaded, index, moduleByFilePath, models);
}

function byChannel(ports: Port[], channel: string): Port | undefined {
  return ports.find((port) => port.channel === channel);
}

describe("electron ports over desktop-notes", () => {
  it("detects invoke/send exits, handle/on entries, and webContents pushes", async () => {
    const ports = await portsOf("desktop-notes");
    const load = ports.filter((port) => port.channel === "notes:load");
    expect(load.map((port) => port.direction).sort()).toEqual(["in", "out"]);
    expect(load.every((port) => port.protocol === "electron")).toBe(true);
    const del = ports.filter((port) => port.channel === "notes:delete");
    expect(del.map((port) => port.direction).sort()).toEqual(["in", "out"]);
    // main → renderer push and its renderer-side listener
    const changed = ports.filter((port) => port.channel === "notes:changed");
    expect(changed.map((port) => port.direction).sort()).toEqual(["in", "out"]);
    // the exit port is owned by the callable containing the call site
    expect(del.find((port) => port.direction === "out")?.nodeId).toContain("deleteNote");
  });

  it("reports a dynamic channel honestly as null", async () => {
    const ports = await portsOf("desktop-notes");
    const dynamic = ports.filter((port) => port.channel === null);
    expect(dynamic).toHaveLength(1);
    expect(dynamic[0].nodeId).toContain("sendOn");
  });
});

describe("http ports", () => {
  it("detects fetch exits with method + path (origin/query stripped)", async () => {
    const ports = await portsOf("checkout-web");
    expect(byChannel(ports, "GET /api/orders")).toBeTruthy();
    expect(byChannel(ports, "POST /api/orders")).toBeTruthy();
    expect(byChannel(ports, "GET /api/orders/123")).toBeTruthy();
    expect(ports.filter((port) => port.channel === null)).toHaveLength(1); // the template-URL fetch
    expect(ports.every((port) => port.direction === "out" && port.protocol === "http")).toBe(true);
    expect(ports.every((port) =>
      port.callSite.endLine !== undefined
      && port.callSite.endCol !== undefined
      && port.callSite.endLine >= port.callSite.line
    )).toBe(true);
  });

  it("detects express route registrations as entries", async () => {
    const ports = await portsOf("orders-api");
    const channels = ports.map((port) => port.channel).sort();
    expect(channels).toEqual(["DELETE /api/orders/:id", "GET /api/orders", "GET /api/orders/:id", "POST /api/orders"]);
    expect(ports.every((port) => port.direction === "in" && port.protocol === "http")).toBe(true);
    // routes registered inside buildServer are attributed to it
    expect(ports.every((port) => port.nodeId.includes("buildServer"))).toBe(true);
  });

  it("requires platform declaration provenance for globals while retaining Node fetch", async () => {
    const projectAmbient = await portsOfExtractorFixture("ambient-fetch");
    const nodeGlobal = await portsOfExtractorFixture("node-fetch");

    expect(projectAmbient).toEqual([]);
    expect(nodeGlobal).toHaveLength(1);
    expect(nodeGlobal[0]).toMatchObject({
      channel: "GET /jobs",
      direction: "out",
      protocol: "http",
      surfaceId: "web.fetch",
    });
  });
});

describe("generic port surfaces", () => {
  it("recognizes a supplied factory and surface without an engine branch", () => {
    const models: PortModelCatalog = {
      factories: [{
        resultId: "custom.bus",
        origin: { kind: "import", module: "custom-bus", exportName: "createBus" },
        member: null,
      }],
      surfaces: [{
        id: "custom.bus.emit",
        origin: { kind: "factory", id: "custom.bus" },
        member: "emit",
        protocol: "custom-ipc",
        direction: "out",
        operation: "notify",
        channel: { kind: "literal-argument", index: 0 },
        minimumArguments: 1,
      }],
    };

    expect(portsOfExtractorFixtureWithModels("port-custom-factory", models)).toEqual([
      expect.objectContaining({
        channel: "jobs:ready",
        direction: "out",
        protocol: "custom-ipc",
        surfaceId: "custom.bus.emit",
        operation: "notify",
        nodeId: expect.stringContaining("announceReady"),
      }),
    ]);
  });

  it("correlates Window.postMessage payloads with named message listeners", async () => {
    const ports = await portsOfExtractorFixture("port-surfaces");
    const ready = ports.filter((port) => port.protocol === "postmessage" && port.channel === "type:hook-ready");

    expect(ready.map((port) => port.direction).sort()).toEqual(["in", "out"]);
    expect(ready.find((port) => port.direction === "out")).toMatchObject({
      nodeId: expect.stringContaining("announceReady"),
      callSite: expect.objectContaining({ file: "src/messages.ts", line: 8 }),
      surfaceId: "web.window.postMessage",
      operation: "notify",
      lane: "window-message",
      confidence: 0.65,
    });
    expect(ready.find((port) => port.direction === "in")).toMatchObject({
      surfaceId: "web.window.addEventListener.message",
      operation: "subscribe",
      handlerNodeId: expect.stringContaining("receiveReady"),
      lane: "window-message",
      confidence: 0.65,
    });
  });

  it("propagates literal discriminators through a local postMessage wrapper", async () => {
    const ports = await portsOfExtractorFixture("port-surfaces");
    const ready = ports.filter((port) => port.protocol === "postmessage" && port.channel === "type:delegate-ready");

    expect(ready.map((port) => port.direction).sort()).toEqual(["in", "out"]);
    expect(ready.find((port) => port.direction === "out")).toMatchObject({
      nodeId: expect.stringContaining("announceDelegateReady"),
      callSite: expect.objectContaining({ file: "src/messages.ts", line: 38 }),
      surfaceId: "web.window.postMessage",
      operation: "notify",
      lane: "window-message",
      confidence: 0.65,
    });
    expect(ready.find((port) => port.direction === "in")).toMatchObject({
      handlerNodeId: expect.stringContaining("receiveDelegateReady"),
      surfaceId: "web.window.addEventListener.message",
    });

    const sessionChanged = ports.filter((port) =>
      port.direction === "out" && port.channel === "type:session-changed",
    );
    expect(sessionChanged).toEqual([
      expect.objectContaining({
        nodeId: expect.stringContaining("announceSessionChanged"),
        callSite: expect.objectContaining({ file: "src/messages.ts", line: 42 }),
      }),
    ]);
    expect(ports.some((port) =>
      port.channel !== null
      && port.nodeId.endsWith("#notify"),
    )).toBe(false);
  });

  it("emits every discriminator branch from an inline message-listener switch", async () => {
    const ports = await portsOfExtractorFixture("port-surfaces");
    const subscriptions = ports
      .filter((port) => port.protocol === "postmessage" && port.direction === "in")
      .map((port) => port.channel)
      .sort();

    expect(subscriptions).toEqual(["kind:created", "kind:deleted", "type:delegate-ready", "type:hook-ready"]);
  });

  it("correlates calls on a returned dispatcher with its physical message listener", async () => {
    const ports = await portsOfExtractorFixture("postmessage-dispatcher");
    const ready = ports.filter((port) => port.channel === "type:ready");
    const settled = ports.filter((port) => port.channel === "type:settled");

    expect(ready).toEqual([
      expect.objectContaining({
        direction: "in",
        protocol: "postmessage",
        lane: "window-message",
        surfaceId: "web.window.addEventListener.message.dispatcher",
        nodeId: expect.stringContaining("wireLifecycle"),
        handlerNodeId: expect.stringContaining("wireLifecycle.handleReadyFlow"),
      }),
    ]);
    expect(settled).toEqual([
      expect.objectContaining({
        direction: "in",
        nodeId: expect.stringContaining("wireLifecycle"),
        handlerNodeId: expect.stringContaining("wireLifecycle.handleSettledFlow"),
      }),
    ]);
    expect(ready[0].handlerNodeId).not.toBe(settled[0].handlerNodeId);
  });

  it("keeps the enclosing owner when nested handler attribution is ambiguous or conditional", async () => {
    const ports = await portsOfExtractorFixture("postmessage-dispatcher");
    const ambiguous = byChannel(ports, "type:ambiguous-handler");
    const conditional = byChannel(ports, "type:conditional-handler");

    expect(ambiguous?.handlerNodeId).toBe(ambiguous?.nodeId);
    expect(conditional?.handlerNodeId).toBe(conditional?.nodeId);
  });

  it("fails closed for dynamic selectors, unrelated methods, and ambiguous listener factories", async () => {
    const ports = await portsOfExtractorFixture("postmessage-dispatcher");
    const dispatcherPorts = ports.filter((port) => port.surfaceId?.endsWith(".dispatcher"));

    expect(dispatcherPorts).toHaveLength(4);
    expect(dispatcherPorts.some((port) => port.nodeId.includes("wireDynamic"))).toBe(false);
    expect(dispatcherPorts.some((port) => port.nodeId.includes("callUnrelated"))).toBe(false);
    expect(dispatcherPorts.some((port) => port.nodeId.includes("wireAmbiguous"))).toBe(false);
  });

  it("keeps a dynamic postMessage payload as an uncorrelated null channel", async () => {
    const ports = await portsOfExtractorFixture("port-surfaces");
    const dynamic = ports.filter((port) =>
      port.protocol === "postmessage" && port.direction === "out" && port.channel === null,
    );

    expect(dynamic).toHaveLength(3);
    expect(dynamic.find((port) => port.nodeId.includes("sendDynamic"))).toMatchObject({
      direction: "out",
      surfaceId: "web.window.postMessage",
      operation: "notify",
    });
    expect(dynamic.some((port) => port.nodeId.includes("sendMutableAlias"))).toBe(true);
    expect(dynamic.find((port) => port.nodeId.includes("notifyDynamic"))).toMatchObject({
      callSite: expect.objectContaining({ file: "src/messages.ts", line: 55 }),
    });
    expect(dynamic.some((port) => port.nodeId.endsWith("#notify"))).toBe(false);
  });

  it("retains unresolved postMessage members as low-confidence boundary candidates", async () => {
    const ports = await portsOfExtractorFixture("port-surfaces");

    expect(byChannel(ports, "type:dependency-ready")).toMatchObject({
      direction: "out",
      protocol: "postmessage",
      surfaceId: "web.window.postMessage.unresolved",
      operation: "notify",
      lane: "window-message",
      confidence: 0.35,
    });
    expect(byChannel(ports, "type:not-a-platform-boundary")).toBeUndefined();
  });

  it("does not model a shadowed fetch and does not invent GET for dynamic options", async () => {
    const ports = await portsOfExtractorFixture("port-surfaces");
    const cases = [
      "loadWithDynamicOptions",
      "loadWithKnownDefaults",
      "loadWithMutableAliasedOptions",
      "loadWithDuplicateMethod",
    ];
    const http = ports.filter((port) =>
      port.protocol === "http" && cases.some((name) => port.nodeId.includes(name)),
    );

    expect(http).toHaveLength(4);
    expect(byChannel(http, "GET /api/default")).toBeTruthy();
    expect(http.filter((port) => port.channel === null)).toHaveLength(3);
    expect(http.some((port) => port.label.includes("not-an-http-boundary"))).toBe(false);
    expect(byChannel(http, "GET /api/duplicate-method")).toBeUndefined();
    expect(byChannel(http, "POST /api/mutable-options")).toBeUndefined();
    expect(byChannel(http, "DELETE /api/mutable-options")).toBeUndefined();
  });

  it("scopes equal HTTP paths by their statically proven absolute origins", async () => {
    const ports = await portsOfExtractorFixture("port-surfaces");
    const first = ports.find((port) => port.nodeId.includes("loadFromFirstOrigin"));
    const second = ports.find((port) => port.nodeId.includes("loadFromSecondOrigin"));

    expect(first).toMatchObject({
      channel: "GET /api/shared",
      scope: "origin:https://one.example",
      scopeKind: "global",
    });
    expect(second).toMatchObject({
      channel: "GET /api/shared",
      scope: "origin:https://two.example",
      scopeKind: "global",
    });
  });

  it("keeps axios factory instances distinct while preserving aliases of one instance", async () => {
    const ports = await portsOfExtractorFixture("port-surfaces");
    const first = ports.find((port) => port.nodeId.endsWith("#loadFromFirstClient"));
    const alias = ports.find((port) => port.nodeId.endsWith("#loadFromFirstClientAlias"));
    const second = ports.find((port) => port.nodeId.endsWith("#loadFromSecondClient"));

    expect(first).toMatchObject({ channel: "GET /users", surfaceId: "axios.instance.get" });
    expect(alias).toMatchObject({ channel: "GET /users", surfaceId: "axios.instance.get" });
    expect(second).toMatchObject({ channel: "GET /users", surfaceId: "axios.instance.get" });
    expect(first?.scope).toBe(alias?.scope);
    expect(first?.scopeKind).toBe("artifact");
    expect(alias?.scopeKind).toBe("artifact");
    expect(second?.scopeKind).toBe("artifact");
    expect(first?.scope).toContain("baseURL=https://one.example/v1");
    expect(second?.scope).toContain("baseURL=https://two.example/v1");
    expect(first?.scope).not.toBe(second?.scope);
  });

  it("uses an absolute request URL as stronger scope evidence than an imported axios singleton", async () => {
    const ports = await portsOfExtractorFixture("port-surfaces");
    const first = ports.find((port) => port.nodeId.includes("loadDirectFromFirstOrigin"));
    const second = ports.find((port) => port.nodeId.includes("loadDirectFromSecondOrigin"));

    expect(first).toMatchObject({ channel: "GET /users", scope: "origin:https://one.example" });
    expect(second).toMatchObject({ channel: "GET /users", scope: "origin:https://two.example" });
  });

  it("does not inherit API provenance or callback identity through mutable bindings", async () => {
    const ports = await portsOfExtractorFixture("port-surfaces");

    expect(ports.some((port) => port.label.includes("not-an-http-boundary"))).toBe(false);
    expect(ports.some((port) => port.channel === "not-an-ipc-boundary")).toBe(false);
    expect(byChannel(ports, "mutable-handler")).toMatchObject({
      surfaceId: "electron.ipcMain.on",
      handlerNodeId: undefined,
    });
  });
});
