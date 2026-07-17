import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import type { GraphArtifact } from "@meridian/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  defaultGraphProjectionRequest,
  GRAPH_PROJECTION_DIRECTORY,
  GRAPH_PROJECTION_FORMAT_VERSION,
  writeGraphProjectionBundle,
} from "./graph-projection-bundle";
import { graphSummaryFor } from "./graph-generation-contract";
import type { GraphCapabilityHandle } from "./graph-capability-store";
import { createGraphProjectionAdmission } from "./graph-projection-response";
import {
  GraphProjectionRegistry,
  handleGraphProjection,
  handleGraphSymbolSearch,
  sendProjectionManifest,
} from "./web-graph";
import type { Context } from "./web-server";

const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("web graph projection routes", () => {
  it("advertises and serves a bounded view from a file-backed local graph", async () => {
    const { ctx, id } = context();
    const manifestResponse = capturedResponse();
    await sendProjectionManifest(ctx, jsonRequest({}), manifestResponse.value, id);

    const advertised = responseJson<{
      version: number;
      graphId: string;
      repositorySummary: {
        overviewPackageCount: number;
        sourceFileCount: number;
        testSourceFileCount: number;
      };
    }>(manifestResponse);
    expect(advertised).toMatchObject({
      version: GRAPH_PROJECTION_FORMAT_VERSION,
      graphId: id,
      repositorySummary: { overviewPackageCount: 1, sourceFileCount: 1, testSourceFileCount: 0 },
    });
    expect(advertised).not.toHaveProperty("moduleOverviewRoots");

    const projectionResponse = capturedResponse();
    await handleGraphProjection(
      ctx,
      jsonRequest({ ...defaultGraphProjectionRequest(), depth: 0, focusIds: ["file"] }),
      projectionResponse.value,
      new URLSearchParams({ id }),
    );
    const result = responseJson<{
      version: number;
      contentId: string;
      projectionId: string;
      artifact: GraphArtifact;
      hierarchy: { moduleOverviewRootIds: string[]; nodes: Record<string, unknown> };
      residentBytes: number;
    }>(projectionResponse);

    expect(result.version).toBe(GRAPH_PROJECTION_FORMAT_VERSION);
    expect(result.contentId).toHaveLength(64);
    expect(result.projectionId).toHaveLength(64);
    expect(result.artifact.nodes.map((node) => node.id)).toEqual(["root", "file"]);
    expect(result.artifact.nodes.some((node) => node.id === "hidden")).toBe(false);
    expect(result.hierarchy).toMatchObject({
      moduleOverviewRootIds: [],
      nodes: {
        root: { isTest: false, childKindCounts: { module: 1 }, descendantSourceFileCount: 1, ownedSourceFileCount: 1 },
        file: { isTest: false, childKindCounts: { method: 1 }, descendantSourceFileCount: 0, ownedSourceFileCount: 0 },
      },
    });
    expect(result.residentBytes).toBeGreaterThan(0);
    expect(projectionResponse.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({
      "x-meridian-projection-id": result.projectionId,
      "x-meridian-resident-bytes": String(result.residentBytes),
      "server-timing": expect.stringMatching(/^projection_query;dur=/),
    }));
    expect(projectionResponse.writeHead.mock.calls[0]?.[1]).not.toHaveProperty("content-length");
  });

  it("returns 404 capability metadata when no immutable projection bundle exists", async () => {
    const response = capturedResponse();
    const ctx = {
      shutdownSignal: new AbortController().signal,
      graphCapabilities: { acquire: async () => null },
      graphProjectionRegistry: new GraphProjectionRegistry(),
    } as unknown as Context;

    await sendProjectionManifest(ctx, jsonRequest({}), response.value, "missing");

    expect(response.writeHead).toHaveBeenCalledWith(404, expect.any(Object));
  });

  it("cancels a projection and releases admission when the client has disconnected", async () => {
    const { ctx, id } = context();
    const response = capturedResponse();
    const pending = handleGraphProjection(
      ctx,
      jsonRequest({ ...defaultGraphProjectionRequest(), depth: 0, focusIds: ["file"] }),
      response.value,
      new URLSearchParams({ id }),
    );
    setImmediate(() => {
      Object.assign(response.value, { destroyed: true });
      response.value.emit("close");
    });

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(response.writeHead).not.toHaveBeenCalled();
    expect(ctx.graphProjectionAdmission.snapshot).toMatchObject({ used: 0, active: 0 });
  });

  it("propagates shutdown into capability verification before reading the request body", async () => {
    const shutdown = new AbortController();
    let resolveStarted!: (signal: AbortSignal) => void;
    const started = new Promise<AbortSignal>((resolve) => { resolveStarted = resolve; });
    const acquire = vi.fn((_id: string, options: { signal?: AbortSignal } = {}) => new Promise<null>((_resolve, reject) => {
      const signal = options.signal as AbortSignal;
      resolveStarted(signal);
      const onAbort = () => reject(signal.reason);
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }));
    const ctx = {
      shutdownSignal: shutdown.signal,
      graphCapabilities: { acquire },
      graphProjectionAdmission: createGraphProjectionAdmission(),
      graphProjectionRegistry: new GraphProjectionRegistry(),
    } as unknown as Context;
    const request = jsonRequest({ ...defaultGraphProjectionRequest(), focusIds: ["file"] });
    const response = capturedResponse();
    const pending = handleGraphProjection(
      ctx,
      request,
      response.value,
      new URLSearchParams({ id: "verification-in-flight" }),
    );
    const verificationSignal = await started;
    const reason = new Error("server closing");

    shutdown.abort(reason);

    expect(verificationSignal.aborted).toBe(true);
    await expect(pending).rejects.toBe(reason);
    expect(request.destroyed).toBe(true);
    expect(response.writeHead).not.toHaveBeenCalled();
  });

  it("strictly rejects missing, duplicate, unknown, and invalid projection graph ids", async () => {
    const { ctx } = context();
    const body = { ...defaultGraphProjectionRequest(), depth: 0, focusIds: ["file"] };

    for (const searchParams of [
      new URLSearchParams(),
      new URLSearchParams("id=one&id=two"),
      new URLSearchParams("id=local-projection&legacy=1"),
      new URLSearchParams("id=../../artifact"),
    ]) {
      await expect(handleGraphProjection(ctx, jsonRequest(body), capturedResponse().value, searchParams))
        .rejects.toMatchObject({ status: 400 });
    }
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
  const handle = projectionCapability(
    id,
    artifactPath,
    join(root, GRAPH_PROJECTION_DIRECTORY),
    graphSummaryFor(artifact),
  );
  return {
    id,
    ctx: {
      shutdownSignal: new AbortController().signal,
      graphCapabilities: {
        acquire: async (candidate: string) => candidate === id ? handle : null,
      },
      graphProjectionRegistry: new GraphProjectionRegistry(),
      graphProjectionAdmission: createGraphProjectionAdmission(),
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
  const handle = projectionCapability(
    id,
    artifactPath,
    join(root, GRAPH_PROJECTION_DIRECTORY),
    graphSummaryFor(artifact),
  );
  return {
    id,
    contentId: manifest.contentId,
    ctx: {
      shutdownSignal: new AbortController().signal,
      graphCapabilities: {
        acquire: async (candidate: string) => candidate === id ? handle : null,
      },
      graphProjectionRegistry: new GraphProjectionRegistry(),
    } as unknown as Context,
  };
}

function projectionCapability(
  id: string,
  artifactPath: string,
  projectionDirectory: string,
  graphSummary: ReturnType<typeof graphSummaryFor>,
): GraphCapabilityHandle {
  const sha = "a".repeat(64);
  return {
    descriptor: {
      formatVersion: 10,
      id,
      publishedAt: "2026-07-17T00:00:00.000Z",
      graphSummary,
      artifact: {
        path: "artifacts/test/generations/test/artifact.json",
        projectionPath: "artifacts/test/generations/test/graph-projection",
        generationPath: "artifacts/test/generations/test",
        bytes: 1,
        sha256: sha,
        projectionBytes: 1,
        projectionSha256: sha,
        projectionContentId: sha,
        sealSha256: sha,
        revision: { kind: "git", commit: "1".repeat(40) },
        vcsBranch: null,
      },
      source: {
        kind: "managed-cache",
        rootPath: "sources/test",
        subdir: "",
        metadata: { kind: "other" },
        owner: null,
      },
      synthetic: null,
      reviewContext: null,
    },
    artifactPath,
    projectionDirectory,
    generationDirectory: dirname(artifactPath),
    source: {
      rootDir: dirname(artifactPath),
      sourceDir: dirname(artifactPath),
      subdir: "",
      metadata: { kind: "other" },
      owner: null,
    },
    synthetic: null,
    review: null,
    signal: new AbortController().signal,
    renew: async () => {},
    release: async () => {},
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
  write: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
} {
  const emitter = new EventEmitter();
  const chunks: string[] = [];
  const writeHead = vi.fn();
  let value!: ServerResponse;
  const write = vi.fn((chunk: string, callback?: (error?: Error | null) => void) => {
    chunks.push(chunk);
    callback?.();
    return true;
  });
  const end = vi.fn((chunk?: string) => {
    if (chunk !== undefined) chunks.push(chunk);
    Object.assign(value, { writableEnded: true });
    emitter.emit("finish");
  });
  value = Object.assign(emitter, {
    destroyed: false,
    writableEnded: false,
    writeHead,
    setHeader: vi.fn(),
    write,
    end,
  }) as unknown as ServerResponse;
  return { value, writeHead, write, end };
}

function responseJson<Value>(response: ReturnType<typeof capturedResponse>): Value {
  const values = [
    ...response.write.mock.calls.map((call) => call[0]),
    ...response.end.mock.calls.map((call) => call[0]).filter((value) => value !== undefined),
  ];
  if (!values.every((value) => typeof value === "string")) throw new Error("response did not contain JSON");
  return JSON.parse(values.join("")) as Value;
}
