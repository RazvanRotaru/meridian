import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveExtractionSubdir } from "./clone";
import {
  prepareWebCache,
  validArtifactMetadata,
  webAnalysisKey,
} from "./web-cache";
import type { ArtifactMetadata } from "./web-cache";
import { probeCheckout } from "./web-cache-checkout";
import { readJson, touchMetadata } from "./web-cache-storage";
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
  const metadataPath = join(entry, "metadata.json");
  try {
    const metadata = readJson(metadataPath) as Partial<ArtifactMetadata>;
    if (!validArtifactMetadata(metadata, checkout, analysisKey) || !existsSync(join(entry, "artifact.json"))) {
      return { status: "miss", commit: checkout.commit };
    }
    touchMetadata(metadataPath);
    return {
      status: "hit",
      commit: checkout.commit,
      id: remoteArtifactId(checkout.repositoryKey, checkout.commit, analysisKey),
    };
  } catch {
    return { status: "miss", commit: checkout.commit };
  }
}
