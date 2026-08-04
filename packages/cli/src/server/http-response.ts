/**
 * The two response writers the web server and its auth routes share. Kept in one place so setting
 * a cookie (an extra header alongside the content type) has a single, tested path — and so both
 * modules can import it without a cycle back through `web-server`.
 */

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { OutgoingHttpHeaders, ServerResponse } from "node:http";
import { pipeline } from "node:stream/promises";

export function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: OutgoingHttpHeaders = {},
): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...extraHeaders,
  });
  response.end(JSON.stringify(body));
}

export function sendHtml(
  response: ServerResponse,
  html: string,
  status = 200,
  extraHeaders: OutgoingHttpHeaders = {},
): void {
  response.writeHead(status, { "content-type": "text/html; charset=utf-8", ...extraHeaders });
  response.end(html);
}

/** Stream an already-serialized JSON document. `pipeline` observes writable backpressure and does
 * not construct a second whole-artifact string or Buffer in the server process. */
export async function sendJsonFile(
  response: ServerResponse,
  path: string,
  extraHeaders: OutgoingHttpHeaders = {},
): Promise<void> {
  // Graph artifacts and projections are immutable once registered. Publishing their exact length
  // lets clients enforce bounded reads before allocation and gives transport observers an exact
  // payload size even when Chromium reports an application-consumed stream as ERR_ABORTED rather
  // than emitting loadingFinished.
  const file = await stat(path);
  response.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...extraHeaders,
    "content-length": file.size,
  });
  await pipeline(createReadStream(path), response);
}
