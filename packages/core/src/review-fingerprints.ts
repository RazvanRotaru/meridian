/** Strict, versioned source fingerprints produced inside disposable repository-analysis workers. */

import type { GraphArtifact } from "./types";

export const REVIEW_FINGERPRINT_EXTENSION = "reviewFingerprints";
export const REVIEW_FINGERPRINT_VERSION = 1 as const;

export interface ReviewContentFingerprint {
  /** Stable logical identity. Content equality alone is never enough to carry a viewed tick. */
  address: string;
  /** SHA-256 of the exact declaration/file bytes owned by this address. */
  digest: string;
}

export interface ReviewFingerprintExtension {
  version: typeof REVIEW_FINGERPRINT_VERSION;
  algorithm: "sha256-source-bytes";
  /** False means the worker hit a bound or could not read at least one source. Missing rows fail closed. */
  complete: boolean;
  units: Record<string, ReviewContentFingerprint>;
  files: Record<string, ReviewContentFingerprint>;
}

const SHA256 = /^[a-f0-9]{64}$/;
const MAX_ENTRIES = 100_000;
const MAX_TEXT_BYTES = 16 * 1024 * 1024;

/** All-or-nothing structural validation. Individual missing entries are intentionally meaningful. */
export function reviewFingerprintsFromArtifact(
  artifact: Pick<GraphArtifact, "extensions">,
): ReviewFingerprintExtension | null {
  const raw = artifact.extensions?.[REVIEW_FINGERPRINT_EXTENSION];
  if (!isRecord(raw)
    || raw.version !== REVIEW_FINGERPRINT_VERSION
    || raw.algorithm !== "sha256-source-bytes"
    || typeof raw.complete !== "boolean"
    || !isRecord(raw.units)
    || !isRecord(raw.files)) {
    return null;
  }
  const units = readEntries(raw.units);
  const files = readEntries(raw.files);
  if (units === null || files === null || Object.keys(units).length + Object.keys(files).length > MAX_ENTRIES) {
    return null;
  }
  let bytes = 0;
  for (const [key, value] of [...Object.entries(units), ...Object.entries(files)]) {
    bytes += key.length + value.address.length + value.digest.length;
    if (bytes > MAX_TEXT_BYTES) return null;
  }
  return { version: REVIEW_FINGERPRINT_VERSION, algorithm: "sha256-source-bytes", complete: raw.complete, units, files };
}

function readEntries(value: Record<string, unknown>): Record<string, ReviewContentFingerprint> | null {
  const entries: Record<string, ReviewContentFingerprint> = {};
  const addresses = new Set<string>();
  for (const [key, raw] of Object.entries(value)) {
    if (!key || !isRecord(raw) || Object.keys(raw).sort().join(",") !== "address,digest"
      || typeof raw.address !== "string" || raw.address.length === 0
      || typeof raw.digest !== "string" || !SHA256.test(raw.digest)
      || addresses.has(raw.address)) {
      return null;
    }
    addresses.add(raw.address);
    entries[key] = { address: raw.address, digest: raw.digest };
  }
  return entries;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
