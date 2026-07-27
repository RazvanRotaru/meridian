import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createGitMonorepoFixture } from "./git-fixture";
import type {
  RevisionExtractionMetrics,
  RevisionManifest,
} from "./model";
import {
  fixtureRequest,
  intersectionSize,
  replaceInFixture,
  shardKeys,
} from "./test-support";

const fixture = createGitMonorepoFixture();
try {
  const requestPath = join(dirname(fixture.cacheDir), "benchmark-request.json");
  const baselineRequest = fixtureRequest(fixture, fixture.seedRevision, fixture.cacheDir, true);
  const cold = runWorker(requestPath, baselineRequest);
  const warm = runWorker(requestPath, baselineRequest);
  requireSameDigest("baseline", warm, cold);

  replaceInFixture(
    fixture,
    "packages/consumer/src/index.ts",
    "normalizeOrder(raw)",
    "normalizeOrder(normalizeOrder(raw))",
  );
  const headARevision = fixture.commit("benchmark head a");
  const headARequest = fixtureRequest(fixture, headARevision, fixture.cacheDir, true);
  const headA = runWorker(requestPath, headARequest);
  const headACold = runWorker(requestPath, {
    ...headARequest,
    cacheDir: join(dirname(fixture.cacheDir), "benchmark-head-a-cold"),
  });
  requireSameDigest("head A", headA, headACold);

  fixture.checkoutExact(fixture.seedRevision);
  replaceInFixture(fixture, "packages/provider/src/normalize.ts", "toUpperCase()", "toLowerCase()");
  const headBRevision = fixture.commit("benchmark head b");
  const headBRequest = fixtureRequest(fixture, headBRevision, fixture.cacheDir, true);
  const headB = runWorker(requestPath, headBRequest);
  const headBCold = runWorker(requestPath, {
    ...headBRequest,
    cacheDir: join(dirname(fixture.cacheDir), "benchmark-head-b-cold"),
  });
  requireSameDigest("head B", headB, headBCold);

  process.stdout.write(`${JSON.stringify({
    version: 1,
    units: cold.metrics.totalUnits,
    cold: cold.metrics,
    warm: warm.metrics,
    ordinaryModification: headA.metrics,
    siblingHead: headB.metrics,
    freshProcessCold: cold.metrics,
    freshProcessWarm: warm.metrics,
    sharedShardCount: intersectionSize(
      shardKeys(headA.manifest),
      shardKeys(headB.manifest),
    ),
    differentialDigests: {
      baseline: warm.manifest.normalizedResultDigest,
      headA: headA.manifest.normalizedResultDigest,
      headB: headB.manifest.normalizedResultDigest,
    },
  }, null, 2)}\n`);
} finally {
  fixture.cleanup();
}

interface WorkerReport {
  manifest: RevisionManifest;
  metrics: RevisionExtractionMetrics;
  manifestPath: string;
}

function runWorker(
  requestPath: string,
  request: ReturnType<typeof fixtureRequest>,
): WorkerReport {
  writeFileSync(requestPath, JSON.stringify(request));
  const worker = fileURLToPath(new URL("./process-worker.ts", import.meta.url));
  const result = spawnSync(process.execPath, ["--import", "tsx", worker, requestPath], {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`benchmark worker failed: ${result.stderr.trim() || `exit ${result.status}`}`);
  }
  return JSON.parse(result.stdout) as WorkerReport;
}

function requireSameDigest(label: string, incremental: WorkerReport, cold: WorkerReport): void {
  if (incremental.manifest.normalizedResultDigest !== cold.manifest.normalizedResultDigest) {
    throw new Error(`${label} incremental result differs from its empty-cache oracle`);
  }
}
