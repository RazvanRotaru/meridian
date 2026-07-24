import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertExtractionDifferential,
  compareExtractionResults,
  type DifferentialReport,
} from "./differential";
import {
  extractRevisionCandidate,
  publishRevisionCandidate,
} from "./extract-revision";
import type {
  RevisionExtractionRequest,
  RevisionExtractionRun,
} from "./model";

export interface RevisionDifferentialRun {
  incremental: RevisionExtractionRun;
  cold: RevisionExtractionRun;
  differential: DifferentialReport;
}

/** The semantic oracle is this exact pipeline with a newly-created empty shard cache. */
export async function extractRevisionDifferential(
  request: RevisionExtractionRequest,
): Promise<RevisionDifferentialRun> {
  const incrementalCandidate = await extractRevisionCandidate(request);
  const coldCache = mkdtempSync(join(tmpdir(), "meridian-incremental-cold-"));
  try {
    const coldCandidate = await extractRevisionCandidate({ ...request, cacheDir: coldCache });
    const differential = compareExtractionResults(
      incrementalCandidate.result,
      coldCandidate.result,
    );
    assertExtractionDifferential(differential);
    if (
      incrementalCandidate.manifest.normalizedResultDigest
      !== coldCandidate.manifest.normalizedResultDigest
    ) {
      throw new Error("tree-bound revision manifests disagree after semantic differential parity");
    }
    // Only exact semantic parity admits candidate shards into the shared store. The cold oracle is
    // published solely inside its disposable cache so both returned runs keep the same shape.
    const incremental = await publishRevisionCandidate(request.cacheDir, incrementalCandidate);
    const cold = await publishRevisionCandidate(coldCache, coldCandidate);
    return { incremental, cold, differential };
  } finally {
    rmSync(coldCache, { recursive: true, force: true });
  }
}
