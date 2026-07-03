/**
 * Serving the bundled SPA: real files straight from `renderer-dist`, everything else falling
 * back to the (boot-injected) `index.html` so client-side routes resolve. Requests are
 * confined to the renderer root — a `..` escape falls back to index rather than reading up.
 */

import { readFileSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { ServerResponse } from "node:http";
import { contentTypeOf } from "./content-type";

export interface StaticAssets {
  rendererRoot: string;
  /** `index.html` already rewritten with the `window.__MERIDIAN__` boot script. */
  indexHtml: string;
}

export function serveStatic(assets: StaticAssets, pathname: string, response: ServerResponse): void {
  const filePath = pathname === "/" ? null : safeJoin(assets.rendererRoot, pathname);
  if (filePath && isFile(filePath)) {
    sendFile(response, filePath);
    return;
  }
  sendIndex(response, assets.indexHtml);
}

function safeJoin(rendererRoot: string, pathname: string): string | null {
  // Normalize first so a trailing slash on the root never breaks the containment check.
  const root = resolve(rendererRoot);
  const decoded = decodePathname(pathname);
  if (decoded === null) {
    return null;
  }
  const candidate = resolve(root, `.${decoded.startsWith("/") ? decoded : `/${decoded}`}`);
  const withinRoot = candidate === root || candidate.startsWith(root + sep);
  return withinRoot ? candidate : null;
}

/** Decode a URL path, treating malformed percent-encoding as out-of-root (never throwing). */
function decodePathname(pathname: string): string | null {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return null;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function sendFile(response: ServerResponse, path: string): void {
  response.writeHead(200, { "content-type": contentTypeOf(path) });
  response.end(readFileSync(path));
}

function sendIndex(response: ServerResponse, indexHtml: string): void {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(indexHtml);
}
