/**
 * Immutable compact Service-view facts persisted beside a graph projection bundle.
 *
 * Extraction is the only phase that owns the complete GraphArtifact. It derives the service
 * abstraction there once, writes a content-addressed sidecar, and lets later Service projections
 * read that compact abstraction without materializing graph nodes outside the current view.
 */

import { createHash } from "node:crypto";
import { closeSync, lstatSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { GraphArtifact } from "@meridian/core";
import {
  deriveSerializedServiceTopology,
  parseSerializedServiceTopology,
  SERIALIZED_SERVICE_TOPOLOGY_VERSION,
  type SerializedServiceTopologyV1,
} from "@meridian/design-metrics";

export const SERVICE_TOPOLOGY_SIDECAR_FILE = "service-topology.json";
export const MAX_SERVICE_TOPOLOGY_SIDECAR_BYTES = 64 * 1024 * 1024;

export interface ServiceTopologySidecarDescriptor {
  version: typeof SERIALIZED_SERVICE_TOPOLOGY_VERSION;
  bytes: number;
  sha256: string;
}

export interface EncodedServiceTopologySidecar {
  descriptor: ServiceTopologySidecarDescriptor;
  topology: SerializedServiceTopologyV1;
  payload: Buffer;
}

export function encodeServiceTopologySidecar(
  artifact: Pick<GraphArtifact, "nodes" | "edges">,
): EncodedServiceTopologySidecar {
  const topology = deriveSerializedServiceTopology(artifact.nodes, artifact.edges);
  const payload = Buffer.from(JSON.stringify(topology), "utf8");
  assertPayloadSize(payload.byteLength);
  return {
    descriptor: {
      version: SERIALIZED_SERVICE_TOPOLOGY_VERSION,
      bytes: payload.byteLength,
      sha256: digest(payload),
    },
    topology,
    payload,
  };
}

/** Write a previously encoded sidecar so its exact bytes can also participate in the bundle hash. */
export function writeServiceTopologySidecar(
  bundleRoot: string,
  encoded: EncodedServiceTopologySidecar,
): void {
  assertEncodedSidecar(encoded);
  writeFileSync(serviceTopologySidecarPath(bundleRoot), encoded.payload, {
    flag: "wx",
    mode: 0o600,
  });
}

export function readServiceTopologySidecar(
  bundleRoot: string,
  descriptor: ServiceTopologySidecarDescriptor,
): SerializedServiceTopologyV1 {
  if (!isServiceTopologySidecarDescriptor(descriptor)) {
    throw new TypeError("invalid service topology sidecar descriptor");
  }
  const path = serviceTopologySidecarPath(bundleRoot);
  const entry = lstatSync(path);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size !== descriptor.bytes) {
    throw new Error("service topology sidecar does not match its descriptor");
  }
  const handle = openSync(path, "r");
  try {
    const payload = readFileSync(handle);
    if (payload.byteLength !== descriptor.bytes || digest(payload) !== descriptor.sha256) {
      throw new Error("service topology sidecar failed integrity verification");
    }
    let value: unknown;
    try {
      value = JSON.parse(payload.toString("utf8"));
    } catch {
      throw new TypeError("service topology sidecar is not valid JSON");
    }
    return parseSerializedServiceTopology(value);
  } finally {
    closeSync(handle);
  }
}

export function isServiceTopologySidecarDescriptor(
  value: unknown,
): value is ServiceTopologySidecarDescriptor {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 3
    && Object.hasOwn(record, "version")
    && Object.hasOwn(record, "bytes")
    && Object.hasOwn(record, "sha256")
    && record.version === SERIALIZED_SERVICE_TOPOLOGY_VERSION
    && Number.isSafeInteger(record.bytes)
    && Number(record.bytes) > 0
    && Number(record.bytes) <= MAX_SERVICE_TOPOLOGY_SIDECAR_BYTES
    && typeof record.sha256 === "string"
    && /^[0-9a-f]{64}$/.test(record.sha256);
}

export function serviceTopologySidecarPath(bundleRoot: string): string {
  return join(resolve(bundleRoot), SERVICE_TOPOLOGY_SIDECAR_FILE);
}

function assertEncodedSidecar(encoded: EncodedServiceTopologySidecar): void {
  if (!isServiceTopologySidecarDescriptor(encoded.descriptor)
    || encoded.payload.byteLength !== encoded.descriptor.bytes
    || digest(encoded.payload) !== encoded.descriptor.sha256) {
    throw new TypeError("encoded service topology sidecar does not match its descriptor");
  }
  parseSerializedServiceTopology(encoded.topology);
  if (!encoded.payload.equals(Buffer.from(JSON.stringify(encoded.topology), "utf8"))) {
    throw new TypeError("encoded service topology payload is not the canonical topology JSON");
  }
}

function assertPayloadSize(bytes: number): void {
  if (bytes < 1 || bytes > MAX_SERVICE_TOPOLOGY_SIDECAR_BYTES) {
    throw new RangeError(
      `service topology sidecar exceeds ${MAX_SERVICE_TOPOLOGY_SIDECAR_BYTES} bytes`,
    );
  }
}

function digest(payload: Buffer): string {
  return createHash("sha256").update(payload).digest("hex");
}
