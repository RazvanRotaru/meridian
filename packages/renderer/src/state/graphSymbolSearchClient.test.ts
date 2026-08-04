import { describe, expect, it, vi } from "vitest";
import {
  createGraphSymbolSearchClient,
  type GraphSymbolSearchWorkerRequest,
  type GraphSymbolSearchWorkerResponse,
} from "./graphSymbolSearchClient";

describe("GraphSymbolSearchClient", () => {
  it("keeps the repository index in its worker and exchanges only bounded UI messages", async () => {
    const posted: GraphSymbolSearchWorkerRequest[] = [];
    const worker = {
      onmessage: null as ((event: MessageEvent<GraphSymbolSearchWorkerResponse>) => void) | null,
      onerror: null as ((event: ErrorEvent) => void) | null,
      postMessage(message: GraphSymbolSearchWorkerRequest) {
        posted.push(message);
        if (message.type === "load") {
          queueMicrotask(() => this.onmessage?.({ data: {
            requestId: message.requestId,
            ok: true,
            value: {
              graphId: "head",
              generation: "immutable",
              complete: true,
              indexedSymbolCount: 500_000,
              totalSymbolCount: 500_000,
            },
          } } as MessageEvent<GraphSymbolSearchWorkerResponse>));
        } else if (message.type === "synchronize") {
          queueMicrotask(() => this.onmessage?.({ data: {
            requestId: message.requestId,
            ok: true,
            value: { public: 499_999, all: 500_000, private: 1 },
          } } as MessageEvent<GraphSymbolSearchWorkerResponse>));
        } else {
          queueMicrotask(() => this.onmessage?.({ data: {
            requestId: message.requestId,
            ok: true,
            value: { results: [], counts: { public: 499_999, all: 500_000, private: 1 } },
          } } as unknown as MessageEvent<GraphSymbolSearchWorkerResponse>));
        }
      },
      terminate() {},
    };
    const client = createGraphSymbolSearchClient(() => worker);

    await client.load("/api/graph/symbols?id=head", 64 * 1024 * 1024);
    await client.synchronize([], true);
    await client.query({ query: "needle", isMap: true, scope: "public" });

    expect(posted).toEqual([
      expect.objectContaining({ type: "load", url: "/api/graph/symbols?id=head" }),
      expect.objectContaining({ type: "synchronize", loaded: [] }),
      expect.objectContaining({
        type: "query",
        request: { query: "needle", isMap: true, scope: "public" },
      }),
    ]);
    expect(posted.some((message) => Object.hasOwn(message, "symbols"))).toBe(false);
  });

  it("keeps one query active and coalesces intermediate keystrokes into one latest follow-up", async () => {
    const posted: GraphSymbolSearchWorkerRequest[] = [];
    const worker = {
      onmessage: null as ((event: MessageEvent<GraphSymbolSearchWorkerResponse>) => void) | null,
      onerror: null as ((event: ErrorEvent) => void) | null,
      postMessage(message: GraphSymbolSearchWorkerRequest) { posted.push(message); },
      terminate() {},
    };
    const client = createGraphSymbolSearchClient(() => worker);

    const first = client.query({ query: "a", isMap: true, scope: "public" });
    const intermediate = client.query({ query: "ab", isMap: true, scope: "public" });
    const latest = client.query({ query: "abc", isMap: true, scope: "public" });
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ type: "query", request: { query: "a" } });

    worker.onmessage?.({ data: {
      requestId: posted[0]!.requestId,
      ok: true,
      value: { results: [], counts: { public: 1, all: 1, private: 0 } },
    } } as unknown as MessageEvent<GraphSymbolSearchWorkerResponse>);
    await Promise.resolve();
    await Promise.resolve();
    expect(posted).toHaveLength(2);
    expect(posted[1]).toMatchObject({ type: "query", request: { query: "abc" } });

    worker.onmessage?.({ data: {
      requestId: posted[1]!.requestId,
      ok: true,
      value: { results: [], counts: { public: 3, all: 3, private: 0 } },
    } } as unknown as MessageEvent<GraphSymbolSearchWorkerResponse>);

    await expect(first).resolves.toMatchObject({ counts: { all: 1 } });
    await expect(intermediate).resolves.toMatchObject({ counts: { all: 3 } });
    await expect(latest).resolves.toMatchObject({ counts: { all: 3 } });
  });

  it("cleans abort ownership when postMessage throws synchronously", async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    let terminated = false;
    const worker = {
      onmessage: null,
      onerror: null,
      postMessage() { throw new DOMException("could not clone", "DataCloneError"); },
      terminate() { terminated = true; },
    };
    const client = createGraphSymbolSearchClient(() => worker);

    await expect(client.load("/api/graph/symbols", 1024, controller.signal))
      .rejects.toMatchObject({ name: "DataCloneError" });
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(terminated).toBe(true);
  });
});
