/**
 * Minimal extension -> MIME map for the handful of asset kinds the renderer bundle emits.
 * Anything unrecognized is served as a generic binary stream rather than guessed.
 */

import { extname } from "node:path";

const BY_EXTENSION: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

export function contentTypeOf(path: string): string {
  return BY_EXTENSION[extname(path).toLowerCase()] ?? "application/octet-stream";
}
