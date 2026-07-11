/**
 * Golden: the ports pass over the real IPC fixtures — electron channels (desktop-notes),
 * fetch exits (checkout-web), express entries (orders-api). Dynamic channels must surface as
 * `channel: null`, never a guess.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Port } from "@meridian/core";
import { createTypeScriptExtractor } from "./index";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

async function portsOf(fixture: string): Promise<Port[]> {
  const root = join(REPO, "examples", fixture);
  const result = await createTypeScriptExtractor().extract({ root, project: join(root, "tsconfig.json") });
  return result.ports ?? [];
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
});
