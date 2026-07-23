import { join } from "node:path";
import { resolveExtractionSubdir } from "./clone";
import {
  prepareWebCache,
  readCachedArtifactPointer,
  webAnalysisKey,
} from "./web-cache";
import { probeCheckout } from "./web-cache-checkout";
import type { GenerateRequest } from "./web-request";
import { remoteArtifactId } from "./web-request";
import type { RepositoryMirror } from "./web-repository-mirror";

export interface CacheProbeResult {
  status: "hit" | "miss";
  commit?: string;
  id?: string;
}

/** Checks remote identity and cache metadata without reading the potentially large graph artifact. */
export async function probeRemoteGraph(inputs: {
  cacheRoot: string;
  repositories: RepositoryMirror;
  request: GenerateRequest;
  cwd: string;
  token?: string;
  signal?: AbortSignal;
}): Promise<CacheProbeResult> {
  if (inputs.request.refresh) {
    return { status: "miss" };
  }
  prepareWebCache(inputs.cacheRoot);
  const checkout = await probeCheckout(
    inputs.repositories,
    inputs.request,
    inputs.cwd,
    inputs.token,
    inputs.signal,
  );
  if (!checkout) {
    return { status: "miss" };
  }
  try {
    resolveExtractionSubdir(checkout.repoDir, inputs.request.subdir);
    const analysisKey = webAnalysisKey(inputs.request);
    const entry = join(inputs.cacheRoot, "artifacts", checkout.repositoryKey, checkout.commit, analysisKey);
    const pointer = readCachedArtifactPointer(entry, checkout, analysisKey);
    if (!pointer) {
      return { status: "miss", commit: checkout.commit };
    }
    return {
      status: "hit",
      commit: checkout.commit,
      id: remoteArtifactId(
        checkout.repositoryKey,
        checkout.commit,
        analysisKey,
        inputs.request.ref,
        pointer.snapshotDigest,
      ),
    };
  } finally {
    checkout.sourceLease.release();
  }
}
