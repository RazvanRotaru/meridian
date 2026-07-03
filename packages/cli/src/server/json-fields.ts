/**
 * Tiny, network-free readers for untrusted JSON objects (GitHub API responses). Shared by the
 * pure GitHub parsers so field validation lives in exactly one place. A malformed shape becomes a
 * WebError, never a raw TypeError whose stack could reach the client.
 */

import { WebError } from "./web-error";

export function asObject(json: unknown): Record<string, unknown> {
  if (typeof json !== "object" || json === null) {
    throw new WebError(502, "GitHub returned an unexpected (non-object) response");
  }
  return json as Record<string, unknown>;
}

export function requireString(body: Record<string, unknown>, key: string): string {
  const value = optionalString(body, key);
  if (value === null) {
    throw new WebError(502, `GitHub response missing '${key}'`);
  }
  return value;
}

export function optionalString(body: Record<string, unknown>, key: string): string | null {
  const value = body[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function requireNumber(body: Record<string, unknown>, key: string): number {
  const value = body[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new WebError(502, `GitHub response missing numeric '${key}'`);
  }
  return value;
}

export function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
