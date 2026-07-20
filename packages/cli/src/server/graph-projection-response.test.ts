import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { GRAPH_PROJECTION_MAX_REQUEST_BYTES } from "@meridian/core";
import { describe, expect, it, vi } from "vitest";
import {
  defaultGraphProjectionRequest,
  type GraphProjectionBundle,
  type GraphProjectionRequest,
  type GraphProjectionResult,
} from "./graph-projection-bundle";
import {
  GRAPH_PROJECTION_RESPONSE_CHUNK_BYTES,
  createGraphProjectionAdmission,
  graphProjectionReservationBytes,
  handleGraphProjectionRequest,
  sendGraphProjectionResponse,
} from "./graph-projection-response";
import { WeightedAdmission } from "./weighted-admission";

describe("graph projection response", () => {
  it("holds admission through a slow response and writes a 16 MiB-budget result in bounded chunks", async () => {
    const request = defaultGraphProjectionRequest();
    const result = projectionResult(request.maxResponseBytes - 512 * 1024);
    const query = vi.fn().mockResolvedValue(result);
    const admission = new WeightedAdmission(graphProjectionReservationBytes(request));
    const response = slowResponse();

    const pending = sendGraphProjectionResponse({
      admission,
      bundle: { query } as unknown as GraphProjectionBundle,
      input: request,
      response: response.value,
      signal: new AbortController().signal,
    });
    await response.firstWrite;

    expect(response.write).toHaveBeenCalledTimes(1);
    expect(Buffer.byteLength(response.chunks[0]!)).toBeLessThanOrEqual(GRAPH_PROJECTION_RESPONSE_CHUNK_BYTES);
    expect(admission.snapshot).toMatchObject({
      used: graphProjectionReservationBytes(request),
      active: 1,
    });
    expect(response.writeHead).toHaveBeenCalledWith(200, expect.not.objectContaining({
      "content-length": expect.anything(),
    }));

    const blockedResponse = slowResponse();
    const blockedQuery = vi.fn();
    await expect(sendGraphProjectionResponse({
      admission,
      bundle: { query: blockedQuery } as unknown as GraphProjectionBundle,
      input: request,
      response: blockedResponse.value,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ status: 503 });
    expect(blockedQuery).not.toHaveBeenCalled();
    expect(blockedResponse.writeHead).not.toHaveBeenCalled();

    response.flushFirstWrite();
    await pending;

    expect(response.write.mock.calls.length).toBeGreaterThan(100);
    expect(response.chunks.every(
      (chunk) => Buffer.byteLength(chunk) <= GRAPH_PROJECTION_RESPONSE_CHUNK_BYTES,
    )).toBe(true);
    expect(admission.snapshot).toMatchObject({ used: 0, active: 0 });
  });

  it("rejects aggregate memory overload before querying or committing HTTP 200", async () => {
    const request = defaultGraphProjectionRequest();
    const required = graphProjectionReservationBytes(request);
    const response = slowResponse();
    const query = vi.fn();

    await expect(sendGraphProjectionResponse({
      admission: new WeightedAdmission(required - 1),
      bundle: { query } as unknown as GraphProjectionBundle,
      input: request,
      response: response.value,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ status: 503 });

    expect(query).not.toHaveBeenCalled();
    expect(response.writeHead).not.toHaveBeenCalled();
    expect(response.setHeader).toHaveBeenCalledWith("retry-after", "1");
  });

  it("shares one close-cancellable request lifecycle across web and standalone routes", async () => {
    const request = defaultGraphProjectionRequest();
    const admission = new WeightedAdmission(graphProjectionReservationBytes(request));
    const response = slowResponse();
    const pending = handleGraphProjectionRequest({
      admission,
      bundle: { query: vi.fn().mockResolvedValue(projectionResult(128 * 1024)) } as unknown as GraphProjectionBundle,
      request: jsonRequest(request),
      response: response.value,
      lifecycleSignal: new AbortController().signal,
    });
    await response.firstWrite;

    response.close();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(admission.snapshot).toMatchObject({ used: 0, active: 0 });
  });

  it("accepts exactly the shared projection request ceiling and rejects the next UTF-8 byte", async () => {
    const exact = projectionRequestWithExactBytes(GRAPH_PROJECTION_MAX_REQUEST_BYTES);
    const oversized = projectionRequestWithExactBytes(GRAPH_PROJECTION_MAX_REQUEST_BYTES + 1);
    const expectedFailure = new Error("query reached");
    const exactQuery = vi.fn().mockRejectedValue(expectedFailure);

    expect(JSON.stringify(exact)).toContain("é");
    expect(JSON.stringify(exact).length).toBeLessThan(GRAPH_PROJECTION_MAX_REQUEST_BYTES);

    await expect(handleGraphProjectionRequest({
      admission: createGraphProjectionAdmission(),
      bundle: { query: exactQuery } as unknown as GraphProjectionBundle,
      request: jsonRequest(exact),
      response: slowResponse().value,
      lifecycleSignal: new AbortController().signal,
    })).rejects.toBe(expectedFailure);
    expect(exactQuery).toHaveBeenCalledOnce();

    const oversizedQuery = vi.fn();
    await expect(handleGraphProjectionRequest({
      admission: createGraphProjectionAdmission(),
      bundle: { query: oversizedQuery } as unknown as GraphProjectionBundle,
      request: jsonRequest(oversized),
      response: slowResponse().value,
      lifecycleSignal: new AbortController().signal,
    })).rejects.toMatchObject({ status: 413, message: "request body too large" });
    expect(oversizedQuery).not.toHaveBeenCalled();
  });

  it("keeps the canonical maximum reservation inside the safe integer range", () => {
    const reservation = graphProjectionReservationBytes(defaultGraphProjectionRequest());
    expect(Number.isSafeInteger(reservation)).toBe(true);
    expect(reservation).toBe(
      16 * 1024 * 1024 * 3 + GRAPH_PROJECTION_RESPONSE_CHUNK_BYTES * 4,
    );
    expect(() => graphProjectionReservationBytes({ maxResponseBytes: Number.MAX_SAFE_INTEGER }))
      .toThrow(/safe integer range/);
  });
});

function projectionResult(payloadBytes: number): GraphProjectionResult {
  const request = defaultGraphProjectionRequest();
  return {
    version: 6,
    contentId: "a".repeat(64),
    projectionId: "b".repeat(64),
    request,
    artifact: {
      schemaVersion: "1.1.0",
      generatedAt: "2026-07-17T00:00:00.000Z",
      generator: { name: "test", version: "1" },
      target: { name: "test", root: ".", language: "typescript" },
      nodes: [{
        id: "node",
        kind: "module",
        qualifiedName: "node",
        displayName: "node",
        parentId: null,
        summary: "x".repeat(payloadBytes),
        location: { file: "src/node.ts", startLine: 1 },
      }],
      edges: [],
    },
    hierarchy: { moduleOverviewRootIds: [], nodes: {} },
    viewFacts: { moduleOverview: null, service: null, review: null },
    analysis: { reachability: null },
    completeness: { complete: true, reasons: [], omittedNodes: 0, omittedEdges: 0 },
    residentBytes: payloadBytes * 3,
  };
}

function projectionRequestWithExactBytes(targetBytes: number): GraphProjectionRequest {
  const empty: GraphProjectionRequest = { ...defaultGraphProjectionRequest(), causalIds: [] };
  const emptyBytes = Buffer.byteLength(JSON.stringify(empty));
  for (let count = 1; count <= 2_000; count += 1) {
    const prefixes = Array.from(
      { length: count },
      (_, index) => `${index.toString().padStart(4, "0")}:`,
    );
    const idBytes = targetBytes - emptyBytes - (3 * count - 1);
    const minimum = prefixes.reduce((sum, prefix) => sum + Buffer.byteLength(prefix), 0);
    if (idBytes < minimum || idBytes > count * 2_048) continue;

    let remaining = idBytes;
    const causalIds = prefixes.map((prefix, index) => {
      const remainingMinimum = prefixes
        .slice(index + 1)
        .reduce((sum, candidate) => sum + Buffer.byteLength(candidate), 0);
      const length = Math.min(2_048, remaining - remainingMinimum);
      remaining -= length;
      return `${prefix}${"x".repeat(length - Buffer.byteLength(prefix))}`;
    });
    const lastIndex = causalIds.length - 1;
    const lastId = causalIds[lastIndex]!;
    if (!lastId.endsWith("xx")) continue;
    // Preserve the exact byte count while proving the boundary is UTF-8 bytes, not JS code units.
    causalIds[lastIndex] = `${lastId.slice(0, -2)}é`;
    const request = { ...empty, causalIds };
    if (Buffer.byteLength(JSON.stringify(request)) === targetBytes) return request;
  }
  throw new Error(`could not construct a ${targetBytes}-byte projection request`);
}

function slowResponse(): {
  readonly value: ServerResponse;
  readonly chunks: string[];
  readonly firstWrite: Promise<void>;
  readonly writeHead: ReturnType<typeof vi.fn>;
  readonly setHeader: ReturnType<typeof vi.fn>;
  readonly write: ReturnType<typeof vi.fn>;
  close(): void;
  flushFirstWrite(): void;
} {
  const events = new EventEmitter();
  const chunks: string[] = [];
  const writeHead = vi.fn();
  const setHeader = vi.fn();
  let resolveFirstWrite!: () => void;
  const firstWrite = new Promise<void>((resolve) => { resolveFirstWrite = resolve; });
  let firstCallback: ((error?: Error | null) => void) | undefined;
  let value!: ServerResponse;
  const write = vi.fn((chunk: string, callback?: (error?: Error | null) => void) => {
    chunks.push(chunk);
    if (chunks.length === 1) {
      firstCallback = callback;
      resolveFirstWrite();
      return false;
    }
    callback?.();
    return true;
  });
  const end = vi.fn(() => {
    Object.assign(value, { writableEnded: true });
    events.emit("finish");
  });
  value = Object.assign(events, {
    destroyed: false,
    writableEnded: false,
    writeHead,
    setHeader,
    write,
    end,
  }) as unknown as ServerResponse;
  return {
    value,
    chunks,
    firstWrite,
    writeHead,
    setHeader,
    write,
    close() {
      Object.assign(value, { destroyed: true });
      events.emit("close");
    },
    flushFirstWrite() {
      firstCallback?.();
      events.emit("drain");
    },
  };
}

function jsonRequest(body: unknown): IncomingMessage {
  return Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
    aborted: false,
    headers: { "content-type": "application/json" },
  }) as unknown as IncomingMessage;
}
