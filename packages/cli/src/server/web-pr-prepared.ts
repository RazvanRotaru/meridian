/** HTTP transport for immutable prepared-review navigation handoffs. */

import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJson } from "./http-response";
import { cancelWhenClientLeaves } from "./web-cancellation";
import type { Context } from "./web-server";

export async function sendPreparedReviewHandoff(
  ctx: Context,
  request: IncomingMessage,
  response: ServerResponse,
  id: string | null,
): Promise<void> {
  const client = cancelWhenClientLeaves(
    request,
    response,
    "The client closed the prepared-review handoff request",
  );
  const operationSignal = AbortSignal.any([client.signal, ctx.shutdownSignal]);
  const destroyRequest = () => {
    if (!request.destroyed) request.destroy();
  };
  operationSignal.addEventListener("abort", destroyRequest, { once: true });
  if (operationSignal.aborted) destroyRequest();
  try {
    operationSignal.throwIfAborted();
    const resolved = await ctx.preparedReviewHandoffs.resolve(id, { signal: operationSignal });
    // `resolve` is cancellation-aware, but retain this boundary check so a conforming alternative
    // store implementation can never write a stale 404/body after its request owner has left.
    operationSignal.throwIfAborted();
    if (!resolved) {
      sendJson(response, 404, { error: "unknown prepared-review handoff" });
      return;
    }
    response.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "content-length": resolved.size,
      // A successful server read renews both the handoff and its source capabilities. Revalidation
      // cannot be delegated to a year-long browser cache whose lifetime exceeds that server lease.
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      etag: `"${resolved.sha256}"`,
    });
    // `resolve` already schema- and digest-validated these exact bounded bytes. Do not reopen the
    // path after validation: a cache mutation must not swap the body between check and serve.
    response.end(resolved.bytes);
  } finally {
    operationSignal.removeEventListener("abort", destroyRequest);
    client.dispose();
  }
}
