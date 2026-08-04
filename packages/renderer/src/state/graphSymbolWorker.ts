/// <reference lib="webworker" />

import type { GraphSymbolSearchResultV1 } from "@meridian/core";
import { readBoundedUtf8Response } from "./boundedUtf8Response";
import { parseBoundedGraphSymbolText } from "./graphSymbolProtocol";
import {
  createRepositoryGraphSymbolSearchIndex,
  type RepositoryGraphSymbolSearchIndex,
} from "./graphSymbolSearch";
import type {
  GraphSymbolIndexSummary,
  GraphSymbolSearchWorkerRequest,
  GraphSymbolSearchWorkerResponse,
} from "./graphSymbolSearchClient";
import type { GraphSymbolSearchQueryResult, GraphSymbolSearchScopeCounts } from "./graphSymbolSearch";

interface LegacyGraphSymbolWorkerRequest {
  url: string;
  maxBytes: number;
}

export type GraphSymbolWorkerResponse =
  | { ok: true; result: GraphSymbolSearchResultV1 }
  | { ok: false; error: string };

const worker = self as unknown as DedicatedWorkerGlobalScope;
let repository: GraphSymbolSearchResultV1 | null = null;
let searchIndex: RepositoryGraphSymbolSearchIndex | null = null;

worker.onmessage = (event: MessageEvent<LegacyGraphSymbolWorkerRequest | GraphSymbolSearchWorkerRequest>) => {
  const request = event.data;
  if (!("type" in request)) {
    // Compatibility path for fetchGraphSymbols callers/tests. The progressive store uses the
    // persistent protocol below and never transfers this repository-wide object to the UI thread.
    void load(request).then(
      (result) => worker.postMessage({ ok: true, result } satisfies GraphSymbolWorkerResponse),
      (error) => worker.postMessage({
        ok: false,
        error: errorMessage(error),
      } satisfies GraphSymbolWorkerResponse),
    );
    return;
  }
  void handleSearchRequest(request).then(
    (value) => worker.postMessage({
      requestId: request.requestId,
      ok: true,
      value,
    } satisfies GraphSymbolSearchWorkerResponse),
    (error) => worker.postMessage({
      requestId: request.requestId,
      ok: false,
      error: errorMessage(error),
    } satisfies GraphSymbolSearchWorkerResponse),
  );
};

async function handleSearchRequest(
  request: GraphSymbolSearchWorkerRequest,
): Promise<GraphSymbolIndexSummary | GraphSymbolSearchScopeCounts | GraphSymbolSearchQueryResult> {
  if (request.type === "load") {
    repository = await load(request);
    // Acceptance means the immutable rank structures are ready too, not merely that JSON parsed.
    searchIndex = createRepositoryGraphSymbolSearchIndex(repository.symbols);
    return {
      graphId: repository.graphId,
      generation: repository.generation,
      complete: repository.complete,
      indexedSymbolCount: repository.indexedSymbolCount,
      totalSymbolCount: repository.totalSymbolCount,
    };
  }
  if (repository === null || searchIndex === null) throw new Error("graph symbol index is not loaded");
  if (request.type === "synchronize") {
    return searchIndex.synchronize(request.loaded, request.isMap);
  }
  return searchIndex.query(request.request);
}

async function load(request: LegacyGraphSymbolWorkerRequest): Promise<GraphSymbolSearchResultV1> {
  const response = await fetch(request.url, { credentials: "same-origin" });
  if (!response.ok) {
    throw new Error(`graph symbol fetch failed (${response.status}) from ${request.url}`);
  }
  const text = await readBoundedUtf8Response(response, request.maxBytes, "graph symbol");
  return parseBoundedGraphSymbolText(text);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "could not index graph symbols";
}
