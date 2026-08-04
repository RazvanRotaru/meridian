import type { GraphSymbolSearchResultV1 } from "@meridian/core";
import type {
  GraphSymbolSearchEntry,
  GraphSymbolSearchQuery,
  GraphSymbolSearchQueryResult,
  GraphSymbolSearchScopeCounts,
} from "./graphSymbolSearch";

export interface GraphSymbolIndexSummary {
  graphId: string;
  generation: string;
  complete: boolean;
  indexedSymbolCount: number;
  totalSymbolCount: number;
}

export type GraphSymbolSearchWorkerRequest =
  | { requestId: number; type: "load"; url: string; maxBytes: number }
  | { requestId: number; type: "synchronize"; loaded: GraphSymbolSearchEntry[]; isMap: boolean }
  | { requestId: number; type: "query"; request: GraphSymbolSearchQuery };

export type GraphSymbolSearchWorkerResponse =
  | { requestId: number; ok: true; value: GraphSymbolIndexSummary | GraphSymbolSearchScopeCounts | GraphSymbolSearchQueryResult }
  | { requestId: number; ok: false; error: string };

type GraphSymbolSearchWorkerPayload = GraphSymbolSearchWorkerRequest extends infer Request
  ? Request extends { requestId: number }
    ? Omit<Request, "requestId">
    : never
  : never;

interface WorkerLike {
  onmessage: ((event: MessageEvent<GraphSymbolSearchWorkerResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: GraphSymbolSearchWorkerRequest): void;
  terminate(): void;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: unknown): void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface QueryWaiter {
  resolve(value: GraphSymbolSearchQueryResult): void;
  reject(error: unknown): void;
}

interface QueryBatch {
  request: GraphSymbolSearchQuery;
  waiters: QueryWaiter[];
}

export class GraphSymbolSearchSupersededError extends Error {
  constructor() {
    super("graph symbol query was superseded by a new loaded-graph revision");
    this.name = "GraphSymbolSearchSupersededError";
  }
}

export interface GraphSymbolSearchClient {
  load(url: string, maxBytes: number, signal?: AbortSignal): Promise<GraphSymbolIndexSummary>;
  synchronize(loaded: readonly GraphSymbolSearchEntry[], isMap: boolean): Promise<GraphSymbolSearchScopeCounts>;
  query(request: GraphSymbolSearchQuery): Promise<GraphSymbolSearchQueryResult>;
  dispose(reason?: unknown): void;
}

export function graphSymbolSearchWorkerAvailable(): boolean {
  return typeof Worker !== "undefined";
}

/** One worker owns fetch, validation, repository rows, ranking, and query for a graph generation.
 * The UI receives only metadata, its bounded loaded slice, and at most 40 result rows. */
export function createGraphSymbolSearchClient(
  workerFactory: () => WorkerLike = () => new Worker(
    new URL("./graphSymbolWorker.ts", import.meta.url),
    { type: "module", name: "meridian-graph-symbol-search" },
  ),
): GraphSymbolSearchClient {
  const worker = workerFactory();
  const pending = new Map<number, PendingRequest>();
  let nextRequestId = 0;
  let disposed = false;
  let queryActive = false;
  let queuedQuery: QueryBatch | null = null;

  const rejectAll = (reason: unknown) => {
    if (disposed) return;
    disposed = true;
    worker.terminate();
    for (const request of pending.values()) {
      request.signal?.removeEventListener("abort", request.onAbort!);
      request.reject(reason);
    }
    pending.clear();
    for (const waiter of queuedQuery?.waiters ?? []) waiter.reject(reason);
    queuedQuery = null;
  };

  worker.onmessage = (event) => {
    const message = event.data;
    const request = pending.get(message.requestId);
    if (request === undefined) return;
    pending.delete(message.requestId);
    request.signal?.removeEventListener("abort", request.onAbort!);
    if (message.ok) request.resolve(message.value);
    else request.reject(new Error(message.error));
  };
  worker.onerror = (event) => {
    rejectAll(new Error(event.message || "graph symbol search worker failed"));
  };

  const post = <Result>(
    message: GraphSymbolSearchWorkerPayload,
    signal?: AbortSignal,
  ): Promise<Result> => {
    if (disposed) return Promise.reject(new Error("graph symbol search worker is disposed"));
    if (signal?.aborted) return Promise.reject(abortError(signal));
    const requestId = ++nextRequestId;
    return new Promise<Result>((resolve, reject) => {
      const request: PendingRequest = { resolve, reject, signal };
      if (signal !== undefined) {
        request.onAbort = () => {
          if (!pending.delete(requestId)) return;
          reject(abortError(signal));
          // Load owns the worker's repository fetch/index. Abandon the whole generation so that a
          // canceled review cannot leave a 64 MiB parse running behind its replacement.
          if (message.type === "load") rejectAll(abortError(signal));
        };
        signal.addEventListener("abort", request.onAbort, { once: true });
      }
      pending.set(requestId, request);
      try {
        worker.postMessage({ ...message, requestId } as GraphSymbolSearchWorkerRequest);
      } catch (error) {
        pending.delete(requestId);
        signal?.removeEventListener("abort", request.onAbort!);
        reject(error);
        rejectAll(error);
        return;
      }
      if (signal?.aborted) request.onAbort?.();
    });
  };

  const runQuery = (batch: QueryBatch): void => {
    queryActive = true;
    void post<GraphSymbolSearchQueryResult>({ type: "query", request: batch.request }).then(
      (value) => {
        for (const waiter of batch.waiters) waiter.resolve(value);
      },
      (error: unknown) => {
        for (const waiter of batch.waiters) waiter.reject(error);
      },
    ).finally(() => {
      queryActive = false;
      const next = queuedQuery;
      queuedQuery = null;
      if (next !== null) {
        if (disposed) {
          for (const waiter of next.waiters) waiter.reject(new Error("graph symbol search worker is disposed"));
        } else {
          runQuery(next);
        }
      }
    });
  };

  const enqueueQuery = (request: GraphSymbolSearchQuery): Promise<GraphSymbolSearchQueryResult> =>
    new Promise((resolve, reject) => {
      const waiter = { resolve, reject };
      if (!queryActive) {
        runQuery({ request, waiters: [waiter] });
        return;
      }
      if (queuedQuery === null) queuedQuery = { request, waiters: [waiter] };
      else {
        // Every intermediate caller receives the newest queued result. React's intent sequence
        // ignores it for stale queries, while the worker sees only one latest follow-up scan.
        queuedQuery.request = request;
        queuedQuery.waiters.push(waiter);
      }
    });

  const supersedeQueuedQueries = (): void => {
    if (queuedQuery === null) return;
    const error = new GraphSymbolSearchSupersededError();
    for (const waiter of queuedQuery.waiters) waiter.reject(error);
    queuedQuery = null;
  };

  return {
    load: (url, maxBytes, signal) => post<GraphSymbolIndexSummary>({
      type: "load",
      url,
      maxBytes,
    }, signal),
    synchronize: (loaded, isMap) => {
      supersedeQueuedQueries();
      return post<GraphSymbolSearchScopeCounts>({
        type: "synchronize",
        loaded: [...loaded],
        isMap,
      });
    },
    query: enqueueQuery,
    dispose: (reason = new Error("graph symbol search worker is disposed")) => rejectAll(reason),
  };
}

/** Test/legacy fallback summary helper; keeping it here makes production and fetch-only paths stamp
 * the same graph-generation metadata and acceptance mark. */
export function graphSymbolIndexSummary(result: GraphSymbolSearchResultV1): GraphSymbolIndexSummary {
  return {
    graphId: result.graphId,
    generation: result.generation,
    complete: result.complete,
    indexedSymbolCount: result.indexedSymbolCount,
    totalSymbolCount: result.totalSymbolCount,
  };
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("aborted", "AbortError");
}
