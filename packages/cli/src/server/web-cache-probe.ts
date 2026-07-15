import { join } from "node:path";
import { resolveExtractionSubdir } from "./clone";
import {
  prepareWebCache,
  probeCachedArtifact,
  webAnalysisKey,
} from "./web-cache";
import { probeCheckout } from "./web-cache-checkout";
import type { GenerateRequest } from "./web-request";
import { remoteArtifactId } from "./web-request";

export interface CacheProbeResult {
  status: "hit" | "miss";
  commit?: string;
  id?: string;
}

/** Checks remote identity and cache metadata without reading the potentially large graph artifact. */
export async function probeRemoteGraph(inputs: {
  cacheRoot: string;
  request: GenerateRequest;
  cwd: string;
  token?: string;
}): Promise<CacheProbeResult> {
  if (inputs.request.refresh) {
    return { status: "miss" };
  }
  prepareWebCache(inputs.cacheRoot);
  const checkout = await probeCheckout(inputs.cacheRoot, inputs.request, inputs.cwd, inputs.token);
  if (!checkout) {
    return { status: "miss" };
  }
  resolveExtractionSubdir(checkout.repoDir, inputs.request.subdir);
  const analysisKey = webAnalysisKey(inputs.request);
  const entry = join(inputs.cacheRoot, "artifacts", checkout.repositoryKey, checkout.commit, analysisKey);
  const cached = probeCachedArtifact(entry, checkout, analysisKey);
  return cached
    ? {
        status: "hit",
        commit: checkout.commit,
        id: remoteArtifactId(
          checkout.repositoryKey, checkout.commit, analysisKey, cached.generationId, checkout.branch ?? "",
        ),
      }
    : { status: "miss", commit: checkout.commit };
}
