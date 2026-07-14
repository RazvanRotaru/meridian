/**
 * Request trust-boundary guards for the `/api/*` surface. The web UI is a localhost server, so a
 * malicious page in the same browser could otherwise blind-fire state-changing requests. The Origin
 * check (host-relative, so it survives the port walking forward on a collision) plus a JSON
 * content-type requirement — which forces a CORS preflight we never grant — close that path.
 */

import type { IncomingMessage } from "node:http";
import { WebError } from "./web-error";

export function assertSameOrigin(request: IncomingMessage): void {
  if (!isSameOrigin(requestHeader(request, "origin"), requestHeader(request, "host"))) {
    throw new WebError(403, "cross-origin request rejected");
  }
}

/** Code execution is intentionally loopback-only. Same-Origin alone is insufficient for a local
 * HTTP server because a DNS-rebinding page can make its own Origin and Host agree while both name
 * the attacker's domain and the socket resolves to 127.0.0.1. */
export function assertLoopbackHost(request: IncomingMessage): void {
  if (!isLoopbackHost(requestHeader(request, "host"))) {
    throw new WebError(403, "synthetic execution is available on loopback only");
  }
}

export function assertJsonContentType(request: IncomingMessage): void {
  const contentType = requestHeader(request, "content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new WebError(415, "expected content-type: application/json");
  }
}

/** A missing Origin (same-origin GETs omit it) is trusted; a present one must match the Host. */
export function isSameOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (!origin) {
    return true;
  }
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  const raw = host.trim().toLowerCase().replace(/\.$/, "");
  if (raw === "::1" || raw === "[::1]") return true;
  try {
    const parsed = new URL(`http://${raw}`).hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
    if (parsed === "localhost" || parsed === "::1") return true;
    const octets = parsed.split(".").map((part) => Number(part));
    return octets.length === 4
      && octets[0] === 127
      && octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255);
  } catch {
    return false;
  }
}

export function requestHeader(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}
