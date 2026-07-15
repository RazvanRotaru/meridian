#!/usr/bin/env node
/** Self-contained worker entry bundled for both compiler-child and OCI execution modes. */

import { readFileSync, statSync, writeSync } from "node:fs";
import { validateArtifact } from "@meridian/core";
import { compileInstrumentedProject } from "./server/synthetic-project";
import { SYNTHETIC_COMPILATION_RESULT_PREFIX } from "./server/synthetic-compiler-child";
import { SYNTHETIC_OCI_RESULT_PREFIX } from "./server/synthetic-oci";
import { runSyntheticScenario, runSyntheticScenarioInsideOci } from "./server/synthetic-execution";
import {
  parseSyntheticArtifactFileJob,
  parseSyntheticCompilationJob,
  parseSyntheticOciJob,
  SYNTHETIC_ARTIFACT_FILE_RESULT_PREFIX,
  syntheticWorkerErrorEnvelope,
  SYNTHETIC_WORKER_ERROR_PREFIX,
} from "./server/synthetic-worker-job";

const MAX_JOB_BYTES = 16 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;

process.umask(0o077);
try {
  const mode = process.argv[2];
  const jobPath = process.argv[3];
  if (typeof jobPath !== "string") throw new Error();
  const job = readJob(jobPath);
  if (mode === "compile") {
    const sourceRoot = process.argv[4];
    const outputRoot = process.argv[5];
    if (typeof sourceRoot !== "string" || typeof outputRoot !== "string") throw new Error();
    const parsed = parseSyntheticCompilationJob(job);
    const result = compileInstrumentedProject(sourceRoot, outputRoot, parsed.artifact, parsed.scenario);
    emit(SYNTHETIC_COMPILATION_RESULT_PREFIX, result);
  } else if (mode === "run-oci") {
    const sourceRoot = process.argv[4];
    const artifactPath = process.argv[5];
    if (sourceRoot !== "/source" || artifactPath !== "/artifact.json") throw new Error();
    const parsed = parseSyntheticOciJob(job);
    const artifact = readArtifact(artifactPath);
    const result = await runSyntheticScenarioInsideOci({ sourceRoot, artifact, ...parsed });
    emit(SYNTHETIC_OCI_RESULT_PREFIX, result);
  } else if (mode === "run-file") {
    const sourceRoot = process.argv[4];
    const artifactPath = process.argv[5];
    if (typeof sourceRoot !== "string" || typeof artifactPath !== "string") throw new Error();
    const parsed = parseSyntheticArtifactFileJob(job);
    const artifact = readArtifact(artifactPath);
    const result = await runSyntheticScenario({ sourceRoot, artifact, ...parsed });
    emit(SYNTHETIC_ARTIFACT_FILE_RESULT_PREFIX, result);
  } else {
    throw new Error();
  }
} catch (error) {
  // Source, compiler diagnostics, paths, and stacks never cross the worker boundary.
  writeSync(1, `${SYNTHETIC_WORKER_ERROR_PREFIX}${JSON.stringify(syntheticWorkerErrorEnvelope(error))}\n`);
  process.exitCode = 1;
}

function readJob(path: string): unknown {
  if (path !== "-" && statSync(path).size > MAX_JOB_BYTES) throw new Error();
  const contents = readFileSync(path === "-" ? 0 : path, "utf8");
  if (Buffer.byteLength(contents, "utf8") > MAX_JOB_BYTES) throw new Error();
  return JSON.parse(contents) as unknown;
}

function readArtifact(path: string) {
  const size = statSync(path).size;
  if (size < 1 || size > MAX_ARTIFACT_BYTES) throw new Error();
  const raw = readFileSync(path, "utf8");
  if (Buffer.byteLength(raw, "utf8") !== size) throw new Error();
  const parsed = validateArtifact(JSON.parse(raw));
  if (!parsed.ok || parsed.artifact === undefined) throw new Error();
  return parsed.artifact;
}

function emit(prefix: string, result: unknown): void {
  writeSync(1, `${prefix}${JSON.stringify({ ok: true, result })}\n`);
}
