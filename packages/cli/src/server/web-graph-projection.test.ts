import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { GraphArtifact } from "@meridian/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GRAPH_PROJECTION_DIRECTORY, writeGraphProjectionBundle } from "./graph-projection-bundle";
import { graphSummaryFor } from "./inspection-snapshot-store";
import { handleGraphProjection, handleGraphSymbolSearch, sendProjectionManifest } from "./web-graph";
import type { Context } from "./web-server";

const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("web graph projection routes", () => {
  it("advertises and serves a bounded view from a file-backed local graph", async () => {
    const { ctx, id } = context();
    const manifestResponse = capturedResponse();
    sendProjectionManifest(ctx, manifestResponse.value, id);

    expect(responseJson<{ version: number; graphId: string }>(manifestResponse)).toMatchObject({
      version: 3,
      graphId: id,
    });

    const projectionResponse = capturedResponse();
    await handleGraphProjection(
      ctx,
      jsonRequest({ view: "modules", depth: 0, focusIds: ["file"] }),
      projectionResponse.value,
      id,
    );
    const result = responseJson<{ projectionId: string; artifact: GraphArtifact; residentBytes: number }>(projectionResponse);

    expect(result.projectionId).toHaveLength(64);
    expect(result.artifact.nodes.map((node) => node.id)).toEqual(["root", "file"]);
    expect(result.artifact.nodes.some((node) => node.id === "hidden")).toBe(false);
    expect(result.residentBytes).toBeGreaterThan(0);
    expect(projectionResponse.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({
      "server-timing": expect.stringMatching(/projection_query;dur=.*projection_serialize;dur=/),
    }));
  });

  it("returns 404 capability metadata when no immutable projection bundle exists", () => {
    const response = capturedResponse();
    const ctx = {
      localGraphFiles: new Map(),
      inspectionSnapshots: { resolveArtifact: () => null },
    } as unknown as Context;

    sendProjectionManifest(ctx, response.value, "missing");

    expect(response.writeHead).toHaveBeenCalledWith(404, expect.any(Object));
  });

  it("searches the immutable catalog of a persisted generated snapshot", async () => {
    const { ctx, id, contentId } = snapshotContext();
    const response = capturedResponse();

    await handleGraphSymbolSearch(
      ctx,
      jsonRequest({ version: 1, query: "HID", mode: "map", scope: "public" }),
      response.value,
      new URLSearchParams({ id }),
    );

    expect(responseJson(response)).toMatchObject({
      version: 1,
      graphId: id,
      contentId,
      mode: "map",
      scope: "public",
      scopeCounts: { public: 3, all: 3, private: 0 },
      results: [{
        id: "hidden",
        displayName: "hidden",
        qualifiedName: "hidden",
        file: "src/a.ts",
        kind: "method",
        isPrivateMethod: false,
        stepCount: 0,
      }],
    });
    expect(response.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({
      "cache-control": "no-store",
      "server-timing": expect.stringMatching(/symbol_search;dur=.*symbol_serialize;dur=/),
    }));
  });

  it("strictly rejects missing, duplicate, and unknown graph search query parameters", async () => {
    const { ctx } = context();
    const body = { version: 1, query: "", mode: "map", scope: "public" };

    await expect(handleGraphSymbolSearch(ctx, jsonRequest(body), capturedResponse().value, new URLSearchParams()))
      .rejects.toMatchObject({ status: 400 });
    await expect(handleGraphSymbolSearch(
      ctx,
      jsonRequest(body),
      capturedResponse().value,
      new URLSearchParams("id=one&id=two"),
    )).rejects.toMatchObject({ status: 400 });
    await expect(handleGraphSymbolSearch(
      ctx,
      jsonRequest(body),
      capturedResponse().value,
      new URLSearchParams("id=local-projection&legacy=1"),
    )).rejects.toMatchObject({ status: 400 });
  });
});

function context(): { ctx: Context; id: string } {
  const root = mkdtempSync(join(tmpdir(), "meridian-web-projection-"));
  temporary.push(root);
  const artifact = fixture();
  const artifactPath = join(root, "artifact.json");
  writeFileSync(artifactPath, JSON.stringify(artifact));
  mkdirSync(join(root, GRAPH_PROJECTION_DIRECTORY));
  writeGraphProjectionBundle(join(root, GRAPH_PROJECTION_DIRECTORY), artifact);
  const id = "local-projection";
  return {
    id,
    ctx: {
      localGraphFiles: new Map([[id, { artifactPath, graphSummary: graphSummaryFor(artifact) }]]),
    } as unknown as Context,
  };
}

function snapshotContext(): { ctx: Context; id: string; contentId: string } {
  const root = mkdtempSync(join(tmpdir(), "meridian-web-projection-snapshot-"));
  temporary.push(root);
  const artifact = fixture();
  const artifactPath = join(root, "artifact.json");
  writeFileSync(artifactPath, JSON.stringify(artifact));
  mkdirSync(join(root, GRAPH_PROJECTION_DIRECTORY));
  const manifest = writeGraphProjectionBundle(join(root, GRAPH_PROJECTION_DIRECTORY), artifact);
  const id = "generated-projection";
  return {
    id,
    contentId: manifest.contentId,
    ctx: {
      localGraphFiles: new Map(),
      inspectionSnapshots: {
        resolveArtifact: (candidate: string) => candidate === id ? { path: artifactPath } : null,
      },
    } as unknown as Context,
  };
}

function fixture(): GraphArtifact {
  return {
    schemaVersion: "1.1.0",
    generatedAt: "2026-07-14T00:00:00.000Z",
    generator: { name: "test", version: "1" },
    target: { name: "test", root: ".", language: "typescript" },
    nodes: [
      { id: "root", kind: "package", qualifiedName: "root", displayName: "root", parentId: null, location: { file: "src", startLine: 1 } },
      { id: "file", kind: "module", qualifiedName: "file", displayName: "file", parentId: "root", location: { file: "src/a.ts", startLine: 1 } },
      { id: "hidden", kind: "method", qualifiedName: "hidden", displayName: "hidden", parentId: "file", location: { file: "src/a.ts", startLine: 2 } },
    ],
    edges: [],
    extensions: { logicFlow: { hidden: [] } },
  };
}

function jsonRequest(body: unknown): IncomingMessage {
  return Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
    headers: { "content-type": "application/json" },
  }) as unknown as IncomingMessage;
}

function capturedResponse(): {
  value: ServerResponse;
  writeHead: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
} {
  const emitter = new EventEmitter();
  const writeHead = vi.fn();
  const end = vi.fn();
  const value = Object.assign(emitter, { writableEnded: false, writeHead, end }) as unknown as ServerResponse;
  return { value, writeHead, end };
}

function responseJson<Value>(response: ReturnType<typeof capturedResponse>): Value {
  const value = response.end.mock.calls.at(-1)?.[0];
  if (typeof value !== "string") throw new Error("response did not contain JSON");
  return JSON.parse(value) as Value;
}
