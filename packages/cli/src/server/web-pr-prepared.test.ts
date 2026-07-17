import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { GraphArtifact } from "@meridian/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GRAPH_PROJECTION_DIRECTORY, writeGraphProjectionBundle } from "./graph-projection-bundle";
import { graphSummaryFor } from "./graph-generation-contract";
import { GraphCapabilityStore } from "./graph-capability-store";
import {
  freezeGraphGenerationDirectory,
  measureGraphProjectionBundle,
  sealGraphGeneration,
  verifyExistingGraphGeneration,
} from "./graph-generation-verifier";
import { GraphGenerationLifecycle } from "./graph-generation-lifecycle";
import {
  finalizedGenerationDirectory,
  localArtifactGenerations,
} from "./graph-cache-layout";
import { PreparedReviewHandoffStore } from "./prepared-review-handoff-store";
import { sendPreparedReviewHandoff } from "./web-pr-prepared";
import { createWebServer, type Context, type WebServerHandle } from "./web-server";
import { removeEntry } from "./web-cache-storage";

const HEAD_ID = "pr-head-restart-test";
const BASE_ID = "pr-base-restart-test";
const HEAD_SHA = "1".repeat(40);
const BASE_SHA = "a".repeat(40);
const MERGE_BASE_SHA = "c".repeat(40);

let root: string;
let server: WebServerHandle | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "meridian-prepared-review-http-"));
});

afterEach(async () => {
  if (server) {
    await server.close();
    server = undefined;
  }
  removeEntry(root);
});

describe("prepared-review request lifecycle", () => {
  it.each(["request-aborted", "response-closed"] as const)(
    "cancels blocked resolution when the client reports %s and removes transport listeners",
    async (disconnect) => {
      const shutdown = new AbortController();
      const fixture = blockingPreparedContext(shutdown.signal);
      const request = capturedRequest();
      const response = capturedResponse();
      const pending = sendPreparedReviewHandoff(
        fixture.ctx,
        request.value,
        response.value,
        "prh-v1-blocked",
      );
      const signal = await fixture.started;

      expect(fixture.resolve).toHaveBeenCalledWith("prh-v1-blocked", { signal });
      expect(request.value.listenerCount("aborted")).toBe(1);
      expect(response.value.listenerCount("close")).toBe(1);

      if (disconnect === "request-aborted") {
        Object.assign(request.value, { aborted: true });
        request.value.emit("aborted");
      } else {
        Object.assign(response.value, { destroyed: true });
        response.value.emit("close");
      }

      expect(signal.aborted).toBe(true);
      await expect(pending).rejects.toBe(signal.reason);
      expect(request.destroy).toHaveBeenCalledOnce();
      expect(response.writeHead).not.toHaveBeenCalled();
      expect(response.end).not.toHaveBeenCalled();
      expect(request.value.listenerCount("aborted")).toBe(0);
      expect(response.value.listenerCount("close")).toBe(0);
    },
  );

  it("propagates server shutdown into resolution and tears down the owned request", async () => {
    const shutdown = new AbortController();
    const fixture = blockingPreparedContext(shutdown.signal);
    const request = capturedRequest();
    const response = capturedResponse();
    const pending = sendPreparedReviewHandoff(
      fixture.ctx,
      request.value,
      response.value,
      "prh-v1-shutdown",
    );
    const signal = await fixture.started;
    const reason = new Error("server closing");

    shutdown.abort(reason);

    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBe(reason);
    await expect(pending).rejects.toBe(reason);
    expect(request.destroy).toHaveBeenCalledOnce();
    expect(response.writeHead).not.toHaveBeenCalled();
    expect(response.end).not.toHaveBeenCalled();
    expect(request.value.listenerCount("aborted")).toBe(0);
    expect(response.value.listenerCount("close")).toBe(0);
  });

  it("checks ownership again after resolution before writing a response", async () => {
    const shutdown = new AbortController();
    const release = deferred<null>();
    const started = deferred<AbortSignal>();
    const resolve = vi.fn((_id: string | null, options: { signal?: AbortSignal } = {}) => {
      if (!options.signal) throw new Error("prepared-review resolve did not receive a signal");
      started.resolve(options.signal);
      return release.promise;
    });
    const ctx = {
      shutdownSignal: shutdown.signal,
      preparedReviewHandoffs: { resolve },
    } as unknown as Context;
    const request = capturedRequest();
    const response = capturedResponse();
    const pending = sendPreparedReviewHandoff(ctx, request.value, response.value, "prh-v1-race");
    const signal = await started.promise;

    Object.assign(response.value, { destroyed: true });
    response.value.emit("close");
    release.resolve(null);

    await expect(pending).rejects.toBe(signal.reason);
    expect(response.writeHead).not.toHaveBeenCalled();
    expect(response.end).not.toHaveBeenCalled();
    expect(request.value.listenerCount("aborted")).toBe(0);
    expect(response.value.listenerCount("close")).toBe(0);
  });
});

describe("prepared-review restart transport", () => {
  it("streams the exact v1 document and injects only a matching prepared boot URL", async () => {
    const cacheRoot = join(root, "cache");
    const rendererRoot = join(root, "renderer");
    const webUiPath = join(root, "landing.html");
    mkdirSync(rendererRoot, { recursive: true });
    writeFileSync(join(rendererRoot, "index.html"), "<!doctype html><html><head></head><body>renderer</body></html>");
    writeFileSync(webUiPath, "<!doctype html><html><head></head><body>landing</body></html>");

    const graphCapabilities = new GraphCapabilityStore({
      cacheRoot,
      repositoryMirrors: testRepositoryMirrors(),
    });
    const head = await publishGraph(graphCapabilities, cacheRoot, HEAD_ID, HEAD_SHA);
    const mergeBase = await publishGraph(graphCapabilities, cacheRoot, BASE_ID, MERGE_BASE_SHA);
    const originalStore = new PreparedReviewHandoffStore({
      cacheRoot,
      graphCapabilities,
    });
    const candidate = originalStore.prepare({
      request: {
        owner: "org", repo: "repo", subdir: "packages/app", prNumber: 41,
        baseRef: "main", headRef: "feature/review",
      },
      headSha: HEAD_SHA,
      baseSha: BASE_SHA,
      mergeBaseSha: MERGE_BASE_SHA,
      changedFiles: [
        { path: "src/added.ts", status: "added" },
        { path: "src/deleted.ts", status: "deleted" },
        { path: "src/modified.ts", status: "modified" },
        { path: "src/new.ts", previousPath: "src/old.ts", status: "renamed" },
      ],
      head,
      mergeBase,
      cache: "miss",
      timings: { resolve: 1, git: 2, "extract-head": 3, "extract-merge-base": 4, publish: 5 },
      warnings: [],
    });
    const reference = await originalStore.publish(candidate, { deliver: () => undefined });

    // A new server constructs fresh lazy stores and recovers only from cache-root files.
    server = createWebServer({ rendererRoot, webUiPath, cwd: root, cacheRoot });
    const base = await listenEphemeral(server.server);
    const prepared = await fetch(`${base}${reference.url}`);
    expect(prepared.status).toBe(200);
    expect(prepared.headers.get("cache-control")).toBe("no-store");
    expect(prepared.headers.get("etag")).toBe(`"${candidate.contentSha256}"`);
    expect(await prepared.json()).toEqual(candidate.document);
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      const wrongMethod = await fetch(`${base}${reference.url}`, {
        method,
        ...(method === "POST" ? {
          headers: { "content-type": "application/json" },
          body: "{}",
        } : {}),
      });
      expect(wrongMethod.status).toBe(405);
      expect(wrongMethod.headers.get("allow")).toBe("GET");
    }
    const getOnly = await fetch(`${base}/api/pr/prepare`);
    expect(getOnly.status).toBe(405);
    expect(getOnly.headers.get("allow")).toBe("POST");
    expect((await fetch(`${base}/api/not-real`, { method: "PUT" })).status).toBe(404);

    const view = await fetch(`${base}${reference.viewUrl}`);
    expect(view.status).toBe(200);
    expect(await view.text()).toContain(`"preparedReviewUrl":"${reference.url}"`);

    const ordinary = await fetch(`${base}/view?id=${HEAD_ID}`);
    expect(ordinary.status).toBe(200);
    expect(await ordinary.text()).toContain('"preparedReviewUrl":null');

    expect((await fetch(`${base}/view?id=${BASE_ID}&view=modules&prn=41&rev=1&prepared=${reference.id}`)).status)
      .toBe(404);
    expect((await fetch(`${base}/view?id=${HEAD_ID}&view=modules&prn=42&rev=1&prepared=${reference.id}`)).status)
      .toBe(404);
    expect((await fetch(`${base}/view?id=${HEAD_ID}&view=modules&prn=41&rev=2&prepared=${reference.id}`)).status)
      .toBe(404);
    expect((await fetch(`${base}/view?id=${HEAD_ID}&view=flows&prn=41&rev=1&prepared=${reference.id}`)).status)
      .toBe(404);
    expect((await fetch(`${base}/api/pr/prepared?id=../../outside`)).status).toBe(404);
  });
});

async function publishGraph(
  graphCapabilities: GraphCapabilityStore,
  cacheRoot: string,
  id: string,
  commit: string,
) {
  const lifecycle = new GraphGenerationLifecycle({ cacheRoot });
  const stage = await lifecycle.reserveStage();
  const graphRoot = stage.directory;
  const generationDirectory = finalizedGenerationDirectory(
    dirname(localArtifactGenerations(cacheRoot)),
    id,
  );
  mkdirSync(dirname(generationDirectory), { recursive: true, mode: 0o700 });
  const sourceRoot = join(cacheRoot, "test-sources", id);
  const artifactPath = join(graphRoot, "artifact.json");
  mkdirSync(join(sourceRoot, "packages", "app"), { recursive: true });
  writeFileSync(join(sourceRoot, "packages", "app", "index.ts"), "export const value = 1;\n");
  const artifact: GraphArtifact = {
    schemaVersion: "1.1.0",
    generatedAt: "2026-07-16T00:00:00.000Z",
    generator: { name: "test", version: "1" },
    target: {
      name: "org/repo",
      root: ".",
      language: "typescript",
      vcs: { repository: "https://github.com/org/repo.git", commit },
    },
    nodes: [],
    edges: [],
  };
  const serialized = JSON.stringify(artifact);
  writeFileSync(artifactPath, serialized);
  const projectionDirectory = join(graphRoot, GRAPH_PROJECTION_DIRECTORY);
  const manifest = writeGraphProjectionBundle(projectionDirectory, artifact);
  const projectionIntegrity = await measureGraphProjectionBundle(projectionDirectory, cacheRoot);
  let generationLease: Awaited<ReturnType<GraphGenerationLifecycle["acquire"]>> | undefined;
  try {
    const sealed = await sealGraphGeneration({
      cacheRoot,
      stage,
      artifactPath,
      projectionDirectory,
      artifactBytes: Buffer.byteLength(serialized),
      artifactSha256: createHash("sha256").update(serialized).digest("hex"),
      ...projectionIntegrity,
      projectionContentId: manifest.contentId,
      graphSummary: graphSummaryFor(artifact),
      revision: { kind: "git", commit },
    });
    generationLease = await lifecycle.acquire(generationDirectory, {
      purpose: "publication",
      allowMissing: true,
    });
    if (!await stage.publish(generationLease)) {
      throw new Error(`prepared-review fixture generation already exists: ${id}`);
    }
    freezeGraphGenerationDirectory(cacheRoot, generationDirectory);
    const finalizedArtifactPath = join(generationDirectory, "artifact.json");
    const finalizedProjectionDirectory = join(generationDirectory, GRAPH_PROJECTION_DIRECTORY);
    const generation = await verifyExistingGraphGeneration({
      cacheRoot,
      artifactPath: finalizedArtifactPath,
      projectionDirectory: finalizedProjectionDirectory,
      artifactBytes: sealed.artifactBytes,
      artifactSha256: sealed.artifactSha256,
      projectionBytes: sealed.projectionBytes,
      projectionSha256: sealed.projectionSha256,
      projectionContentId: sealed.projectionContentId,
      graphSummary: sealed.graphSummary,
      revision: sealed.revision,
    });
    await graphCapabilities.publish({
      id,
      generation,
      sourceRoot,
      sourceSubdir: "packages/app",
      source: { kind: "github", owner: "org", repo: "repo", subdir: "packages/app" },
    });
    const encoded = encodeURIComponent(id);
    return {
      graphId: id,
      manifestUrl: `/api/graph/manifest?id=${encoded}`,
      projectionUrl: `/api/graph/projection?id=${encoded}`,
      searchUrl: `/api/graph/search?id=${encoded}`,
      sourceUrl: `/api/source?id=${encoded}`,
      metaUrl: `/api/meta?id=${encoded}`,
      graphSummary: graphSummaryFor(artifact),
    };
  } finally {
    await stage.release();
    await generationLease?.release();
  }
}

function testRepositoryMirrors() {
  return {
    async retainSource() { return true; },
    async releaseSource() {},
  };
}

async function listenEphemeral(active: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    active.once("error", reject);
    active.listen(0, "127.0.0.1", () => {
      active.off("error", reject);
      resolve();
    });
  });
  const address = active.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

function blockingPreparedContext(shutdownSignal: AbortSignal): {
  ctx: Context;
  started: Promise<AbortSignal>;
  resolve: ReturnType<typeof vi.fn>;
} {
  const started = deferred<AbortSignal>();
  const resolve = vi.fn((_id: string | null, options: { signal?: AbortSignal } = {}) => {
    const signal = options.signal;
    if (!signal) throw new Error("prepared-review resolve did not receive a signal");
    started.resolve(signal);
    return new Promise<never>((_resolve, reject) => {
      const onAbort = () => {
        signal.removeEventListener("abort", onAbort);
        reject(signal.reason);
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
  });
  return {
    ctx: {
      shutdownSignal,
      preparedReviewHandoffs: { resolve },
    } as unknown as Context,
    started: started.promise,
    resolve,
  };
}

function capturedRequest(): {
  value: IncomingMessage;
  destroy: ReturnType<typeof vi.fn>;
} {
  const emitter = new EventEmitter();
  let value!: IncomingMessage;
  const destroy = vi.fn(() => {
    Object.assign(value, { destroyed: true });
    return value;
  });
  value = Object.assign(emitter, {
    aborted: false,
    destroyed: false,
    destroy,
  }) as unknown as IncomingMessage;
  return { value, destroy };
}

function capturedResponse(): {
  value: ServerResponse;
  writeHead: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
} {
  const emitter = new EventEmitter();
  const writeHead = vi.fn();
  let value!: ServerResponse;
  const end = vi.fn(() => {
    Object.assign(value, { writableEnded: true });
    return value;
  });
  value = Object.assign(emitter, {
    destroyed: false,
    writableEnded: false,
    writeHead,
    setHeader: vi.fn(),
    end,
  }) as unknown as ServerResponse;
  return { value, writeHead, end };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}
