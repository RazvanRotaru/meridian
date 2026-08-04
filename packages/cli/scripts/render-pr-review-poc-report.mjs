#!/usr/bin/env node

/** Re-render the standalone report from a saved evidence document without rerunning browsers. */

import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  redactSecrets,
  renderHtmlReport,
  safeRelativeMediaPath,
  validateResultsDocument,
} from "./pr-review-poc-lib.mjs";

let resultsPath;
let outputPath;
try {
  ({ resultsPath, outputPath } = parseArgs(process.argv.slice(2)));
  const source = JSON.parse(await readFile(resultsPath, "utf8"));
  const document = validateResultsDocument(source);
  const sourceDirectory = dirname(resultsPath);
  const mediaPaths = collectEvidencePaths(document).map((path) => resolve(sourceDirectory, path));
  assertNoOutputCollision(outputPath, resultsPath, mediaPaths);
  for (const mediaPath of mediaPaths) {
    const metadata = await stat(mediaPath);
    if (!metadata.isFile()) throw new TypeError(`evidence path is not a regular file: ${mediaPath}`);
  }
  if (document.status === "complete") await verifyRecordingFiles(document, sourceDirectory);
  const relocated = relocateEvidencePaths(document, sourceDirectory, outputPath);
  // Exclusive creation is intentional: unlike rename(2), this cannot silently replace an existing
  // report if another renderer or the benchmark writes it between validation and publication.
  await writeFile(outputPath, renderHtmlReport(relocated), { encoding: "utf8", flag: "wx" });
  process.stdout.write(`${outputPath}\n`);
} catch (error) {
  process.stderr.write(`${redactSecrets(error?.message ?? error)}\n${usage()}\n`);
  process.exitCode = 1;
}

function parseArgs(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name?.startsWith("--") || value === undefined) throw new TypeError("invalid arguments");
    if (values.has(name)) throw new TypeError(`duplicate option: ${name}`);
    values.set(name, value);
  }
  for (const name of values.keys()) {
    if (name !== "--results" && name !== "--output") throw new TypeError(`unknown option: ${name}`);
  }
  const rawResults = values.get("--results");
  if (!rawResults) throw new TypeError("--results is required");
  const resultsPath = resolve(rawResults);
  const rawOutput = values.get("--output");
  return {
    resultsPath,
    outputPath: rawOutput === undefined ? resolve(dirname(resultsPath), "report.html") : resolve(rawOutput),
  };
}

function usage() {
  return "Usage: render-pr-review-poc-report.mjs --results /path/results.json [--output /path/report.html]";
}

function collectEvidencePaths(document) {
  const paths = [];
  for (const entry of document.prs) {
    collectRelativePaths(entry.recordings, paths);
    collectRelativePaths(entry.startupRecordings, paths);
    collectRelativePaths(entry.handoffRecordings, paths);
    collectRelativePaths(entry.evidence, paths);
    collectRelativePaths(entry.screenshots, paths);
  }
  return [...new Set(paths)];
}

function collectRelativePaths(value, paths) {
  if (value === null || value === undefined || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item) => collectRelativePaths(item, paths));
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (key === "relativePath" && typeof item === "string") paths.push(item);
    else collectRelativePaths(item, paths);
  }
}

function relocateEvidencePaths(value, sourceDirectory, reportPath) {
  if (value === null || value === undefined || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((item) => relocateEvidencePaths(item, sourceDirectory, reportPath));
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (key === "relativePath" && typeof item === "string") {
      return [key, safeRelativeMediaPath(reportPath, resolve(sourceDirectory, item))];
    }
    return [key, relocateEvidencePaths(item, sourceDirectory, reportPath)];
  }));
}

function assertNoOutputCollision(outputPath, resultsPath, mediaPaths) {
  const target = resolve(outputPath);
  const protectedPaths = [resolve(resultsPath), ...mediaPaths.map((path) => resolve(path))];
  if (protectedPaths.includes(target)) {
    throw new TypeError("report output must not overwrite results or media/evidence files");
  }
}

async function verifyRecordingFiles(document, sourceDirectory) {
  for (const entry of document.prs) {
    for (const [label, recordings] of [
      ["functionality", entry.recordings],
      ["startup", entry.startupRecordings],
      ["cold handoff", entry.handoffRecordings],
    ]) {
      if (recordings === undefined || recordings === null) continue;
      for (const [variant, recording] of Object.entries(recordings)) {
        if (recording === undefined || recording === null) continue;
        const path = resolve(sourceDirectory, recording.relativePath);
        const metadata = await stat(path);
        if (!metadata.isFile() || metadata.size !== recording.validation.sizeBytes) {
          throw new TypeError(
            `PR #${entry.number} ${variant} ${label} recording size no longer matches validated evidence`,
          );
        }
        const digest = await sha256File(path);
        if (digest !== recording.validation.sha256) {
          throw new TypeError(
            `PR #${entry.number} ${variant} ${label} recording SHA-256 no longer matches validated evidence`,
          );
        }
      }
    }
  }
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
