#!/usr/bin/env node

/**
 * Measure the renderer's synchronous artifact-read, JSON-decode, and index-build lane.
 *
 * The browser pays the same decode/index costs after an HTTP transfer. Keeping this harness file-
 * based isolates renderer CPU and memory from Git, extraction, and loopback throughput.
 */

import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import type { GraphArtifact } from "@meridian/core";
import { buildGraphIndex } from "../src/graph/graphIndex";

const artifactPath = process.argv[2];
if (!artifactPath) {
  process.stderr.write("Usage: benchmark-graph-load.ts /absolute/path/to/artifact.json\n");
  process.exit(2);
}

const startedAt = performance.now();
const bytes = readFileSync(artifactPath);
const readAt = performance.now();
const artifact = JSON.parse(bytes.toString("utf8")) as GraphArtifact;
const parsedAt = performance.now();
const index = buildGraphIndex(artifact);
const indexedAt = performance.now();

process.stdout.write(`${JSON.stringify({
  artifactPath,
  artifactBytes: bytes.byteLength,
  nodes: artifact.nodes.length,
  edges: artifact.edges.length,
  indexedNodes: index.nodesById.size,
  readMs: rounded(readAt - startedAt),
  parseMs: rounded(parsedAt - readAt),
  indexMs: rounded(indexedAt - parsedAt),
  totalMs: rounded(indexedAt - startedAt),
  rssBytes: process.memoryUsage().rss,
  heapUsedBytes: process.memoryUsage().heapUsed,
})}\n`);

function rounded(value: number): number {
  return Math.round(value * 10) / 10;
}
