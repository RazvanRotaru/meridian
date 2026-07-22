/**
 * Constant-extra-space JSON publication for a validated graph artifact.
 *
 * `JSON.stringify(artifact)` briefly duplicates the complete graph as one giant string before it
 * can be written. Extraction already owns the object graph, so the worker writes the same JSON
 * token stream incrementally and hashes those exact bytes as they reach the file. Property order,
 * omitted object values, and null array slots deliberately match native JSON.stringify semantics.
 */

import { createHash } from "node:crypto";
import { closeSync, openSync, rmSync, writeSync } from "node:fs";
import type { GraphArtifact } from "@meridian/core";
import { artifactSummary, type WebGraphArtifactSummary } from "./web-graph-store";

const FLUSH_BYTES = 64 * 1024;

export interface WrittenRepositoryArtifact {
  byteDigest: string;
  byteLength: number;
  summary: WebGraphArtifactSummary;
}

/** Write `JSON.stringify(artifact) + "\n"` without materializing the complete JSON string. */
export function writeValidatedRepositoryArtifact(
  path: string,
  artifact: GraphArtifact,
): WrittenRepositoryArtifact {
  const descriptor = openSync(path, "wx", 0o600);
  const hash = createHash("sha256");
  let byteLength = 0;
  let descriptorOpen = true;
  let pending: string[] = [];
  let pendingBytes = 0;

  const flush = () => {
    if (pending.length === 0) return;
    const chunk = Buffer.from(pending.join(""), "utf8");
    let offset = 0;
    while (offset < chunk.byteLength) {
      const written = writeSync(descriptor, chunk, offset, chunk.byteLength - offset);
      if (written <= 0) throw new Error("artifact writer made no forward progress");
      offset += written;
    }
    hash.update(chunk);
    byteLength += chunk.byteLength;
    pending = [];
    pendingBytes = 0;
  };
  const write = (chunk: string) => {
    pending.push(chunk);
    pendingBytes += Buffer.byteLength(chunk, "utf8");
    if (pendingBytes >= FLUSH_BYTES) flush();
  };

  try {
    writeJsonValue(artifact, write, false);
    write("\n");
    flush();
    closeSync(descriptor);
    descriptorOpen = false;
  } catch (error) {
    try {
      if (descriptorOpen) closeSync(descriptor);
    } catch {
      // Preserve the serialization/write failure; the unpublished file is removed below.
    } finally {
      rmSync(path, { force: true });
    }
    throw error;
  }

  return {
    byteDigest: hash.digest("hex"),
    byteLength,
    summary: artifactSummary(artifact),
  };
}

type JsonWriter = (chunk: string) => void;

function writeJsonValue(value: unknown, write: JsonWriter, arrayElement: boolean): void {
  if (value === null) {
    write("null");
    return;
  }
  switch (typeof value) {
    case "string":
    case "boolean":
    case "number": {
      const serialized = JSON.stringify(value);
      write(serialized === undefined ? "null" : serialized);
      return;
    }
    case "object":
      if (Array.isArray(value)) {
        write("[");
        for (let index = 0; index < value.length; index += 1) {
          if (index > 0) write(",");
          // Nodes, edges, and extension arrays are emitted one item at a time. A graph-sized array
          // never becomes a graph-sized string, while native JSON handles each bounded item's
          // optional fields and escaping efficiently.
          const serialized = JSON.stringify(value[index]);
          write(serialized === undefined ? "null" : serialized);
        }
        write("]");
        return;
      }
      writeJsonObject(value as Record<string, unknown>, write);
      return;
    default:
      // Valid GraphArtifact values never reach this branch. Matching JSON.stringify keeps this
      // helper exact for optional object fields and sparse/undefined array slots in focused tests.
      write(arrayElement ? "null" : "");
  }
}

function writeJsonObject(value: Record<string, unknown>, write: JsonWriter): void {
  write("{");
  let first = true;
  for (const key of Object.keys(value)) {
    const entry = value[key];
    if (entry === undefined || typeof entry === "function" || typeof entry === "symbol") continue;
    if (!first) write(",");
    first = false;
    write(JSON.stringify(key));
    write(":");
    writeJsonValue(entry, write, false);
  }
  write("}");
}
