#!/usr/bin/env node

/**
 * Timestamp every NDJSON milestone emitted by the PR preparation endpoint.
 *
 * This deliberately measures the public HTTP contract rather than importing server internals, so
 * the same command covers landing-page and renderer-triggered preparations.
 */

import { performance } from "node:perf_hooks";

const options = parseArgs(process.argv.slice(2));
const startedAt = performance.now();
const response = await fetch(new URL("/api/pr/prepare", options.url), {
  method: "POST",
  headers: {
    accept: "application/x-ndjson",
    "content-type": "application/json",
    origin: options.url.origin,
  },
  body: JSON.stringify({
    repository: options.repository,
    prNumber: options.prNumber,
    baseRef: options.baseRef,
    headRef: options.headRef,
    headSha: options.headSha,
  }),
});

if (!response.body) {
  throw new Error(`PR preparation returned HTTP ${response.status} without a response body`);
}

const events = [];
const reader = response.body.getReader();
const decoder = new TextDecoder();
let buffer = "";

for (;;) {
  const { value, done } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  buffer = drainLines(buffer, false);
}
buffer += decoder.decode();
drainLines(buffer, true);

const totalMs = elapsedMs();
process.stdout.write(`${JSON.stringify({
  type: "summary",
  httpStatus: response.status,
  totalMs,
  eventCount: events.length,
  terminal: events.at(-1)?.payload ?? null,
})}\n`);

if (!response.ok || events.at(-1)?.payload?.stage === "error") {
  process.exitCode = 1;
}

function drainLines(value, includeTail) {
  const lines = value.split("\n");
  const complete = includeTail ? lines : lines.slice(0, -1);
  for (const line of complete) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const payload = JSON.parse(trimmed);
    const event = { type: "event", atMs: elapsedMs(), payload };
    events.push(event);
    process.stdout.write(`${JSON.stringify(event)}\n`);
  }
  return includeTail ? "" : lines.at(-1) ?? "";
}

function elapsedMs() {
  return Math.round((performance.now() - startedAt) * 10) / 10;
}

function parseArgs(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name?.startsWith("--") || value === undefined) {
      usage();
    }
    values.set(name.slice(2), value);
  }
  const url = new URL(required(values, "url"));
  const prNumber = Number(required(values, "pr"));
  if (!Number.isSafeInteger(prNumber) || prNumber <= 0) usage();
  return {
    url,
    repository: required(values, "repository"),
    prNumber,
    baseRef: required(values, "base"),
    headRef: required(values, "head"),
    headSha: required(values, "head-sha"),
  };
}

function required(values, name) {
  const value = values.get(name);
  if (!value) usage();
  return value;
}

function usage() {
  process.stderr.write(
    "Usage: benchmark-pr-prepare.mjs --url URL --repository OWNER/REPO --pr N "
      + "--base REF --head REF --head-sha SHA\n",
  );
  process.exit(2);
}
