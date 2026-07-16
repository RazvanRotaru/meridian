/** HTTP transport for immutable prepared-review navigation handoffs. */

import type { ServerResponse } from "node:http";
import { sendJson } from "./http-response";
import type { Context } from "./web-server";

export async function sendPreparedReviewHandoff(
  ctx: Context,
  response: ServerResponse,
  id: string | null,
): Promise<void> {
  const resolved = ctx.preparedReviewHandoffs.resolve(id);
  if (!resolved) {
    sendJson(response, 404, { error: "unknown prepared-review handoff" });
    return;
  }
  response.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "content-length": resolved.size,
    "cache-control": "private, max-age=31536000, immutable",
    "x-content-type-options": "nosniff",
    etag: `"${resolved.sha256}"`,
  });
  // `resolve` already schema- and digest-validated these exact bounded bytes. Do not reopen the
  // path after validation: a cache mutation must not swap the body between check and serve.
  response.end(resolved.bytes);
}
