import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { materializeChannels } from "@meridian/core";
import { createTypeScriptExtractor } from "./index";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const ROOT = join(REPO, "packages", "extractor-typescript", "fixtures", "rpc-proxy-stub");

describe("typed RPC proxy/stub ports", () => {
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
