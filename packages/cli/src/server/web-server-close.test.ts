import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createConnection } from "node:net";
import type { AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GraphArtifact } from "@meridian/core";
import type { CachedPrPreparation, PrPreparationInputs } from "./web-pr-cache";
import type { RepositoryDetachedWorktreeLease } from "./repository-mirror";
import { GraphCapabilityStore } from "./graph-capability-store";
import type { Context, WebServerHandle } from "./web-server";
import { removeEntry } from "./web-cache-storage";
import {
  defaultGraphProjectionRequest,
  writeGraphProjectionBundle,
} from "./graph-projection-bundle";
import type { GraphProjectionRegistry } from "./web-graph";

type ProjectionHandler = (
  ctx: Context,
  request: IncomingMessage,
  response: ServerResponse,
  searchParams: URLSearchParams,
) => Promise<void>;

const shutdownHarness = vi.hoisted(() => ({
  prepare: undefined as ((inputs: PrPreparationInputs) => Promise<CachedPrPreparation>) | undefined,
  projection: undefined as ProjectionHandler | undefined,
  registries: [] as GraphProjectionRegistry[],
}));

vi.mock("./web-pr-cache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./web-pr-cache")>();
  return {
    ...actual,
    cachedPrPreparation: (inputs: PrPreparationInputs) => shutdownHarness.prepare
      ? shutdownHarness.prepare(inputs)
      : actual.cachedPrPreparation(inputs),
  };
});

vi.mock("./web-graph", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./web-graph")>();
  class ObservedGraphProjectionRegistry extends actual.GraphProjectionRegistry {
    constructor(options?: ConstructorParameters<typeof actual.GraphProjectionRegistry>[0]) {
      super(options);
      shutdownHarness.registries.push(this);
    }
  }
  return {
    ...actual,
    GraphProjectionRegistry: ObservedGraphProjectionRegistry,
    handleGraphProjection: (...args: Parameters<ProjectionHandler>) => shutdownHarness.projection
      ? shutdownHarness.projection(...args)
      : actual.handleGraphProjection(...args),
  };
});

import { createWebServer } from "./web-server";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const WEB_UI = fileURLToPath(new URL("../../web-ui/index.html", import.meta.url));

let liveServers: WebServerHandle[] = [];
let workspaces: string[] = [];
let releaseDrain: (() => void) | undefined;

afterEach(async () => {
  releaseDrain?.();
  await Promise.allSettled(liveServers.map((server) => server.close()));
  for (const root of workspaces) removeEntry(root);
  shutdownHarness.prepare = undefined;
  shutdownHarness.projection = undefined;
  shutdownHarness.registries = [];
  liveServers = [];
  workspaces = [];
  releaseDrain = undefined;
  vi.restoreAllMocks();
});

describe("web server shutdown drain", () => {
  it("seals admission before a queued keep-alive request callback can enter", { timeout: 15_000 }, async () => {
    const fixture = await startServer();
    let close: Promise<void> | undefined;
    const closeStarted = deferred<void>();
    fixture.server.server.prependOnceListener("request", () => {
      close = fixture.server.close();
      closeStarted.resolve();
    });
    const target = new URL(fixture.base);
    const socket = createConnection({ host: target.hostname, port: Number(target.port) });
    socket.on("error", () => undefined);
    const socketClosed = new Promise<void>((resolveClose) => socket.once("close", () => resolveClose()));
    await new Promise<void>((resolveConnect) => socket.once("connect", resolveConnect));

    socket.write([
      "POST /api/generate HTTP/1.1",
      `Host: ${target.host}`,
      "Content-Type: application/json",
      "Content-Length: 1024",
      "Connection: keep-alive",
      "",
      "{",
    ].join("\r\n"));

    await closeStarted.promise;
    await close;
    await socketClosed;
    expect(socket.destroyed).toBe(true);
  });

  it("aborts graph capability verification and drains its request before close resolves", { timeout: 15_000 }, async () => {
    const started = deferred<void>();
    const aborted = deferred<void>();
    vi.spyOn(GraphCapabilityStore.prototype, "acquire").mockImplementation(async (_id, options = {}) => {
      const signal = options.signal as AbortSignal;
      started.resolve();
      return new Promise<never>((_resolve, reject) => {
        const onAbort = () => {
          aborted.resolve();
          reject(signal.reason);
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      });
    });
    const fixture = await startServer();
    const requestDone = postWithoutWaiting(
      fixture.base,
      "/api/graph/projection?id=verification-in-flight",
      defaultGraphProjectionRequest(),
    );
    await started.promise;

    const close = fixture.server.close();
    await aborted.promise;
    await close;
    await requestDone;
  });

  it("disposes the server-owned projection registry after request drain", async () => {
    const fixture = await startServer();
    const registry = shutdownHarness.registries.at(-1) as GraphProjectionRegistry;
    const projectionRoot = join(fixture.root, "projection-cache-fixture");
    writeGraphProjectionBundle(projectionRoot, projectionArtifact());
    await registry.get("close-cache", projectionRoot).query(defaultGraphProjectionRequest());
    expect(registry.cacheStats().entries).toBeGreaterThan(0);

    await fixture.server.close();

    expect(registry.cacheStats()).toMatchObject({ entries: 0, residentBytes: 0, trackedNamespaces: 0 });
  });

  it.each([
    ["PR preparation", "/api/pr/prepare"],
    ["graph generation", "/api/generate"],
  ])("closes with a partial %s JSON body instead of retaining its request task", { timeout: 15_000 }, async (_label, path) => {
    const fixture = await startServer();
    const socket = await openPartialJsonPost(fixture.server.server, fixture.base, path);
    const socketClosed = new Promise<void>((resolveClose) => socket.once("close", () => resolveClose()));

    const close = fixture.server.close();
    const closedPromptly = await settlesWithin(close, 5_000, () => socket.destroy());
    await socketClosed;

    expect(closedPromptly).toBe(true);
    expect(socket.destroyed).toBe(true);
  });

  it("waits for an active PR base flight, its transferred lease, and request task before resolving", async () => {
    const fixture = await startServer();
    const started = deferred<void>();
    const aborted = deferred<void>();
    const drain = deferred<void>();
    releaseDrain = () => drain.resolve();
    const activeDirectory = join(fixture.cacheRoot, "active-pr-base-flight");
    shutdownHarness.prepare = (inputs) => {
      mkdirSync(activeDirectory, { recursive: true, mode: 0o700 });
      writeFileSync(join(activeDirectory, "stage.json"), "{}\n", { mode: 0o600 });
      const lease = {
        release: async () => { removeEntry(activeDirectory); },
      } as unknown as RepositoryDetachedWorktreeLease;
      const subscription = inputs.baseInspectionCoordinator.subscribe(
        "close-proof",
        lease,
        inputs.signal,
        (signal) => {
          started.resolve();
          return new Promise<never>((_resolve, reject) => {
            const onAbort = () => {
              aborted.resolve();
              void drain.promise.then(() => reject(signal.reason));
            };
            if (signal.aborted) onAbort();
            else signal.addEventListener("abort", onAbort, { once: true });
          });
        },
      );
      return subscription.promise.then<never>(() => {
        throw new Error("shutdown test base flight unexpectedly completed");
      });
    };
    const requestDone = postWithoutWaiting(fixture.base, "/api/pr/prepare", {
      owner: "org",
      repo: "repo",
      prNumber: 41,
      baseRef: "main",
      headRef: "feature/close",
    });
    await started.promise;

    const firstClose = fixture.server.close();
    expect(fixture.server.close()).toBe(firstClose);
    await aborted.promise;
    let closeSettled = false;
    void firstClose.then(() => { closeSettled = true; });
    await Promise.resolve();
    expect(closeSettled).toBe(false);
    expect(existsSync(activeDirectory)).toBe(true);

    drain.resolve();
    await firstClose;
    await requestDone;
    expect(existsSync(activeDirectory)).toBe(false);
    removeEntry(fixture.root);
    expect(existsSync(fixture.root)).toBe(false);
  });

  it("keeps identical base flights isolated between two live web servers", async () => {
    const serverA = await startServer();
    const serverB = await startServer();
    const startedA = deferred<void>();
    const startedB = deferred<void>();
    const abortedA = deferred<void>();
    const drainA = deferred<void>();
    const drainB = deferred<void>();
    let signalB: AbortSignal | undefined;
    releaseDrain = () => {
      drainA.resolve();
      drainB.resolve();
    };
    shutdownHarness.prepare = (inputs) => {
      const isA = inputs.cacheRoot === serverA.cacheRoot;
      const activeDirectory = join(inputs.cacheRoot, "identical-base-flight");
      mkdirSync(activeDirectory, { recursive: true, mode: 0o700 });
      const lease = {
        release: async () => { removeEntry(activeDirectory); },
      } as unknown as RepositoryDetachedWorktreeLease;
      const subscription = inputs.baseInspectionCoordinator.subscribe(
        "identical-key",
        lease,
        inputs.signal,
        (signal) => {
          if (isA) startedA.resolve();
          else {
            signalB = signal;
            startedB.resolve();
          }
          return new Promise<never>((_resolve, reject) => {
            const onAbort = () => {
              if (isA) abortedA.resolve();
              void (isA ? drainA.promise : drainB.promise).then(() => reject(signal.reason));
            };
            if (signal.aborted) onAbort();
            else signal.addEventListener("abort", onAbort, { once: true });
          });
        },
      );
      return subscription.promise.then<never>(() => {
        throw new Error("shutdown isolation flight unexpectedly completed");
      });
    };
    const requestBody = {
      owner: "org",
      repo: "repo",
      prNumber: 41,
      baseRef: "main",
      headRef: "feature/isolation",
    };
    const requestA = postWithoutWaiting(serverA.base, "/api/pr/prepare", requestBody);
    const requestB = postWithoutWaiting(serverB.base, "/api/pr/prepare", requestBody);
    await Promise.all([startedA.promise, startedB.promise]);

    const closeA = serverA.server.close();
    await abortedA.promise;
    expect(signalB?.aborted).toBe(false);
    drainA.resolve();
    await closeA;
    await requestA;
    expect(signalB?.aborted).toBe(false);

    const closeB = serverB.server.close();
    expect(signalB?.aborted).toBe(true);
    drainB.resolve();
    await closeB;
    await requestB;
  });

  it("aborts an active projection and joins its physical request drain before resolving", async () => {
    const fixture = await startServer();
    const started = deferred<void>();
    const aborted = deferred<void>();
    const drain = deferred<void>();
    releaseDrain = () => drain.resolve();
    shutdownHarness.projection = async (ctx) => {
      started.resolve();
      await new Promise<never>((_resolve, reject) => {
        const onAbort = () => {
          aborted.resolve();
          void drain.promise.then(() => reject(ctx.shutdownSignal.reason));
        };
        if (ctx.shutdownSignal.aborted) onAbort();
        else ctx.shutdownSignal.addEventListener("abort", onAbort, { once: true });
      });
    };
    const requestDone = postWithoutWaiting(fixture.base, "/api/graph/projection?id=close-proof", {});
    await started.promise;

    const close = fixture.server.close();
    await aborted.promise;
    let closeSettled = false;
    void close.then(() => { closeSettled = true; });
    await Promise.resolve();
    expect(closeSettled).toBe(false);

    drain.resolve();
    await close;
    await requestDone;
    removeEntry(fixture.root);
    expect(existsSync(fixture.root)).toBe(false);
  });
});

async function startServer(): Promise<{
  root: string;
  cacheRoot: string;
  server: WebServerHandle;
  base: string;
}> {
  const root = mkdtempSync(join(tmpdir(), "meridian-web-close-"));
  const rendererRoot = join(root, "renderer");
  const cacheRoot = join(root, "cache");
  mkdirSync(join(rendererRoot, "assets"), { recursive: true });
  writeFileSync(join(rendererRoot, "index.html"), "<!doctype html><html><body></body></html>\n");
  writeFileSync(join(rendererRoot, "assets", "app.js"), "export const ready = true;\n");
  const server = createWebServer({ rendererRoot, webUiPath: WEB_UI, cwd: REPO_ROOT, cacheRoot });
  workspaces.push(root);
  liveServers.push(server);
  return { root, cacheRoot, server, base: await listenEphemeral(server.server) };
}

function postWithoutWaiting(base: string, path: string, body: unknown): Promise<void> {
  return new Promise((resolveRequest) => {
    const serialized = JSON.stringify(body);
    const request = httpRequest(`${base}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(serialized),
      },
    }, (response) => {
      response.resume();
      response.once("end", resolveRequest);
      response.once("error", resolveRequest);
    });
    request.once("error", resolveRequest);
    request.end(serialized);
  });
}

async function openPartialJsonPost(server: Server, base: string, path: string): Promise<Socket> {
  const seen = deferred<IncomingMessage>();
  const onRequest = (request: IncomingMessage) => {
    if (request.url === path) seen.resolve(request);
  };
  server.on("request", onRequest);
  const target = new URL(base);
  const socket = createConnection({ host: target.hostname, port: Number(target.port) });
  socket.on("error", () => undefined);
  await new Promise<void>((resolveConnect) => socket.once("connect", resolveConnect));
  socket.write([
    `POST ${path} HTTP/1.1`,
    `Host: ${target.host}`,
    "Content-Type: application/json",
    "Content-Length: 1024",
    "Connection: keep-alive",
    "",
    "{",
  ].join("\r\n"));
  const incoming = await seen.promise;
  server.off("request", onRequest);
  await waitForDataConsumer(incoming);
  return socket;
}

async function waitForDataConsumer(request: IncomingMessage): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (request.listenerCount("data") === 0) {
    if (Date.now() >= deadline) throw new Error("request body reader did not start");
    await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
  }
}

async function settlesWithin(
  promise: Promise<void>,
  milliseconds: number,
  onTimeout: () => void,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settled = await Promise.race([
    promise.then(() => true),
    new Promise<false>((resolveTimeout) => {
      timer = setTimeout(() => resolveTimeout(false), milliseconds);
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  if (!settled) {
    onTimeout();
    await promise;
  }
  return settled;
}

function listenEphemeral(server: Server): Promise<string> {
  return new Promise((resolveBase) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolveBase(`http://127.0.0.1:${port}`);
    });
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function projectionArtifact(): GraphArtifact {
  return {
    schemaVersion: "1.1.0",
    generatedAt: "2026-07-17T00:00:00.000Z",
    generator: { name: "test", version: "1" },
    target: { name: "shutdown", root: ".", language: "typescript" },
    nodes: [{
      id: "root",
      kind: "package",
      qualifiedName: "root",
      displayName: "root",
      location: { file: "src", startLine: 1 },
    }],
    edges: [],
  };
}
