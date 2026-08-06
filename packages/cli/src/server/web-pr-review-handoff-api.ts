/** Versioned HTTP boundary for transferring prepared PR-review resources to a browser view. */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Context } from "./web-server";
import { sendJson } from "./http-response";
import { readJsonBody } from "./web-request";
import { WebError } from "./web-error";
import { PrReviewHandoffClaimError } from "./web-pr-review-handoff";

const HANDOFF_VERSION = 1 as const;
const CLAIM_ID_PATTERN = /^[A-Za-z0-9_-]{32}$/;

export function prReviewHandoffClaimIdFromPath(pathname: string): string | null {
  const match = /^\/api\/pr-review-handoffs\/([^/]+)$/.exec(pathname);
  if (match === null) return null;
  if (!CLAIM_ID_PATTERN.test(match[1]!)) {
    throw new WebError(404, "unknown prepared PR review handoff");
  }
  return match[1]!;
}

export async function handlePrReviewHandoffAttach(
  ctx: Context,
  request: IncomingMessage,
  response: ServerResponse,
  claimId: string,
): Promise<void> {
  const viewLeaseId = parseAttach(await readJsonBody(request, ctx.shutdownSignal));
  try {
    const attached = ctx.prReviewHandoffs.attach(claimId, viewLeaseId);
    sendJson(response, 200, { version: HANDOFF_VERSION, expiresAtMs: attached.expiresAtMs });
  } catch (error) {
    sendClaimError(response, error);
  }
}

export async function handlePrReviewHandoffCommit(
  ctx: Context,
  request: IncomingMessage,
  response: ServerResponse,
  claimId: string,
): Promise<void> {
  const viewLeaseId = parseCommit(await readJsonBody(request, ctx.shutdownSignal));
  try {
    let expiresAtMs = Date.now();
    try {
      expiresAtMs = ctx.prReviewHandoffs.inspectClaim(claimId).expiresAtMs;
    } catch (error) {
      if (!(error instanceof PrReviewHandoffClaimError)) throw error;
      // A lost successful response leaves only the bounded settlement tombstone. `commit` below
      // still verifies the original lease id and returns the first settlement idempotently.
    }
    const settlement = ctx.prReviewHandoffs.commit(claimId, viewLeaseId);
    if (settlement !== "committed") {
      throw new PrReviewHandoffClaimError("prepared PR review handoff was already released");
    }
    sendJson(response, 200, { version: HANDOFF_VERSION, expiresAtMs });
  } catch (error) {
    sendClaimError(response, error);
  }
}

export function handlePrReviewHandoffRelease(
  ctx: Context,
  response: ServerResponse,
  claimId: string,
): void {
  try {
    ctx.prReviewHandoffs.release(claimId);
  } catch (error) {
    // DELETE is intentionally idempotent and does not expose whether an opaque capability existed.
    if (!(error instanceof PrReviewHandoffClaimError)) throw error;
  }
  response.writeHead(204, { "cache-control": "no-store" });
  response.end();
}

function parseAttach(body: unknown): string {
  const record = exactRecord(body, ["version", "viewLeaseId"], "attach");
  if (record.version !== HANDOFF_VERSION || !validLeaseId(record.viewLeaseId)) {
    throw new WebError(400, "invalid prepared PR review attach request");
  }
  return record.viewLeaseId;
}

function parseCommit(body: unknown): string {
  const record = exactRecord(body, ["action", "version", "viewLeaseId"], "commit");
  if (
    record.version !== HANDOFF_VERSION
    || record.action !== "commit"
    || !validLeaseId(record.viewLeaseId)
  ) {
    throw new WebError(400, "invalid prepared PR review commit request");
  }
  return record.viewLeaseId;
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  operation: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WebError(400, `prepared PR review ${operation} body must be a JSON object`);
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join("\n") !== [...keys].sort().join("\n")) {
    throw new WebError(400, `prepared PR review ${operation} body has unexpected fields`);
  }
  return record;
}

function validLeaseId(value: unknown): value is string {
  return typeof value === "string" && CLAIM_ID_PATTERN.test(value);
}

function sendClaimError(response: ServerResponse, error: unknown): never | void {
  if (error instanceof PrReviewHandoffClaimError) {
    sendJson(response, 410, { error: "prepared PR review handoff is no longer available" });
    return;
  }
  if (error instanceof WebError) {
    sendJson(response, error.status, { error: error.message });
    return;
  }
  throw error;
}
