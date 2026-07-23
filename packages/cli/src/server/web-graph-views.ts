/** Versioned HTTP boundary for renewable browser-view graph registration leases. */

import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJson } from "./http-response";
import { readJsonBody } from "./web-request";
import {
  WebGraphViewLeaseError,
  type WebGraphStore,
} from "./web-graph-store";
import { WebError } from "./web-error";

const VIEW_LEASE_VERSION = 1 as const;
const VIEW_LEASE_COLLECTION_URL = "/api/graph-views";

export async function handleGraphViewCreate(
  graphStore: WebGraphStore,
  request: IncomingMessage,
  response: ServerResponse,
  signal?: AbortSignal,
): Promise<void> {
  const selection = parseCreateSelection(await readJsonBody(request, signal));
  try {
    const grant = graphStore.createViewLease(selection.baseGraphId, selection.graphIds);
    sendJson(response, 201, {
      version: VIEW_LEASE_VERSION,
      leaseId: grant.leaseId,
      url: `${VIEW_LEASE_COLLECTION_URL}/${grant.leaseId}`,
      expiresAtMs: grant.expiresAtMs,
      heartbeatIntervalMs: grant.heartbeatIntervalMs,
    });
  } catch (error) {
    sendLeaseError(response, error);
  }
}

export async function handleGraphViewPut(
  graphStore: WebGraphStore,
  request: IncomingMessage,
  response: ServerResponse,
  leaseId: string,
  signal?: AbortSignal,
): Promise<void> {
  const graphIds = parseSelection(await readJsonBody(request, signal));
  try {
    const grant = graphStore.renewViewLease(requireLeaseId(leaseId), graphIds);
    sendJson(response, 200, {
      version: VIEW_LEASE_VERSION,
      expiresAtMs: grant.expiresAtMs,
    });
  } catch (error) {
    sendLeaseError(response, error);
  }
}

export function handleGraphViewDelete(
  graphStore: WebGraphStore,
  response: ServerResponse,
  leaseId: string,
): void {
  graphStore.releaseViewLease(requireLeaseId(leaseId));
  response.writeHead(204, { "cache-control": "no-store" });
  response.end();
}

function parseSelection(body: unknown): string[] {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new WebError(400, "graph view body must be a JSON object");
  }
  const record = body as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== 2 || keys[0] !== "graphIds" || keys[1] !== "version") {
    throw new WebError(400, "graph view body must contain only version and graphIds");
  }
  if (record.version !== VIEW_LEASE_VERSION) {
    throw new WebError(400, "unsupported graph view protocol version");
  }
  if (!Array.isArray(record.graphIds)) {
    throw new WebError(400, "graphIds must be an array");
  }
  return record.graphIds as string[];
}

function parseCreateSelection(body: unknown): { baseGraphId: string; graphIds: string[] } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new WebError(400, "graph view body must be a JSON object");
  }
  const record = body as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== 3
    || keys[0] !== "baseGraphId"
    || keys[1] !== "graphIds"
    || keys[2] !== "version"
  ) {
    throw new WebError(400, "graph view body must contain only version, baseGraphId, and graphIds");
  }
  if (record.version !== VIEW_LEASE_VERSION) {
    throw new WebError(400, "unsupported graph view protocol version");
  }
  if (typeof record.baseGraphId !== "string" || !Array.isArray(record.graphIds)) {
    throw new WebError(400, "baseGraphId must be a string and graphIds must be an array");
  }
  return { baseGraphId: record.baseGraphId, graphIds: record.graphIds as string[] };
}

function requireLeaseId(value: string): string {
  if (!/^[A-Za-z0-9_-]{32}$/.test(value)) {
    throw new WebError(404, "unknown graph view lease");
  }
  return value;
}

function sendLeaseError(response: ServerResponse, error: unknown): never | void {
  if (!(error instanceof WebGraphViewLeaseError)) throw error;
  if (error.code === "invalid_selection") {
    sendJson(response, 400, { error: error.message, code: error.code });
    return;
  }
  if (error.code === "capacity") {
    sendJson(response, 503, { error: error.message, code: error.code }, { "retry-after": "5" });
    return;
  }
  sendJson(response, 410, { error: error.message, code: error.code });
}
