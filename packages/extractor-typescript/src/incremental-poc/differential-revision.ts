import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertExtractionDifferential,
  compareExtractionResults,
  type DifferentialReport,
} from "./differential";
import {
  discardStagedRevisionAdmissionEvidence,
  extractRevisionCandidate,
  publishRevisionCandidate,
  publishStagedRevisionAdmission,
  stageRevisionCandidateForAdmission,
  type PendingRevisionExtraction,
} from "./extract-revision";
import { canonicalJson } from "./canonical-json";
import type { RevisionShardAdmissionSigner } from "./admission";
import type {
  RevisionExtractionRequest,
  RevisionExtractionRun,
} from "./model";

export interface RevisionDifferentialRun {
  incremental: RevisionExtractionRun;
  cold: Omit<RevisionExtractionRun, "manifestPath"> & { manifestPath: null };
  differential: DifferentialReport;
}

/** The semantic oracle is this exact pipeline with a newly-created empty shard cache. */
export async function extractRevisionDifferential(
  request: RevisionExtractionRequest,
  options: { admissionSigner?: RevisionShardAdmissionSigner } = {},
): Promise<RevisionDifferentialRun> {
  const coldCache = mkdtempSync(join(tmpdir(), "meridian-incremental-cold-"));
  let staged: Awaited<ReturnType<typeof stageRevisionCandidateForAdmission>> | null = null;
  try {
    let incrementalCandidate: PendingRevisionExtraction | null = await extractRevisionCandidate(
      request,
      { requiredAdmission: options.admissionSigner },
    );
    staged = options.admissionSigner === undefined
      ? null
      : await stageRevisionCandidateForAdmission(
          request.cacheDir,
          incrementalCandidate,
          options.admissionSigner,
        );
    // Authenticated shadow keeps exact disk-backed semantic/unit evidence while the cold oracle
    // runs. Unadmitted immutable bytes are safe to leave staged after a crash: admitted mode
    // ignores them.
    if (staged !== null) incrementalCandidate = null;
    const coldCandidate = await extractRevisionCandidate({ ...request, cacheDir: coldCache });
    // Materialize the disposable cold unit shards with the same immutable writer so shadow can
    // compare the exact envelope bytes that would be admitted, not only their addresses/digests.
    if (staged !== null) {
      await publishRevisionCandidate(coldCache, coldCandidate);
    }
    let differential: DifferentialReport;
    let incremental: RevisionExtractionRun;
    if (staged === null) {
      differential = compareExtractionResults(
        incrementalCandidate!.result,
        coldCandidate.result,
      );
      assertExtractionDifferential(differential);
      if (canonicalJson(incrementalCandidate!.manifest) !== canonicalJson(coldCandidate.manifest)) {
        throw new Error("tree-bound revision manifests disagree after semantic differential parity");
      }
      assertRevisionUnitShardParity(incrementalCandidate!, coldCandidate);
      incremental = await publishRevisionCandidate(request.cacheDir, incrementalCandidate!);
    } else {
      const publication = await publishStagedRevisionAdmission(
        request.cacheDir,
        staged,
        options.admissionSigner!,
        coldCache,
        coldCandidate,
      );
      incremental = publication.run;
      differential = publication.differential;
    }
    const cold = {
      result: coldCandidate.result,
      manifest: coldCandidate.manifest,
      manifestPath: null,
      metrics: coldCandidate.metrics,
    } as const;
    // Do not publish an entire disposable cold cache. The cold result is already the served oracle,
    // and dropping its unit evidence prevents it from surviving alongside the returned graph.
    coldCandidate.pendingShards.length = 0;
    coldCandidate.unitShards.length = 0;
    return { incremental, cold, differential };
  } finally {
    if (staged !== null) discardStagedRevisionAdmissionEvidence(staged);
    rmSync(coldCache, { recursive: true, force: true });
  }
}

function assertRevisionUnitShardParity(
  incremental: PendingRevisionExtraction,
  cold: PendingRevisionExtraction,
): void {
  if (incremental.unitShards.length !== cold.unitShards.length) {
    throw new Error("incremental unit shards differ from the empty-cache cold oracle");
  }
  for (const [index, incrementalUnit] of incremental.unitShards.entries()) {
    const coldUnit = cold.unitShards[index];
    if (
      coldUnit === undefined
      || incrementalUnit.unitId !== coldUnit.unitId
      || incrementalUnit.shardKey !== coldUnit.shardKey
      || canonicalJson(incrementalUnit.value) !== canonicalJson(coldUnit.value)
    ) {
      throw new Error(
        `incremental unit shard differs from the empty-cache cold oracle: ${incrementalUnit.unitId}`,
      );
    }
  }
}
