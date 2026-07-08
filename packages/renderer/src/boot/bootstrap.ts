/**
 * Boot sequence: read the injected contract, load the graph, build the index, wire the
 * telemetry provider, create the store, and run the first layout so the initial render shows
 * the collapsed roots. The store and boot config are handed to React from here.
 */

import { buildGraphIndex } from "../graph/graphIndex";
import { createHttpTelemetryProvider } from "../telemetry/httpProvider";
import type { TelemetryProvider } from "../telemetry/provider";
import { createBlueprintStore, type BlueprintStore } from "../state/store";
import { restoreFromUrl, startUrlSync } from "../state/urlSync";
import { prApiUrlsFromGraphUrl, readBootConfig, type BootConfig } from "./bootConfig";
import { loadArtifact } from "./loadArtifact";
import { loadEnvironments } from "./loadEnvironments";

export interface BootResult {
  store: BlueprintStore;
  boot: BootConfig;
}

export async function bootstrap(): Promise<BootResult> {
  const boot = readBootConfig();
  const artifact = await loadArtifact(boot.graphUrl);
  const index = buildGraphIndex(artifact);
  const provider = await buildProvider(boot);
  const prApi = prApiUrlsFromGraphUrl(boot.graphUrl);
  const store = createBlueprintStore({
    artifact,
    index,
    provider,
    hasOverlay: boot.hasOverlay,
    sourceUrl: boot.sourceUrl,
    prsUrl: prApi.prsUrl,
    prFilesUrl: prApi.prFilesUrl,
  });
  // Restore the navigation state carried in the URL (or fall through to defaults) and run the
  // first layout, then start reflecting the store back into the URL for reload/back/forward.
  await restoreFromUrl(store);
  startUrlSync(store);
  return { store, boot };
}

async function buildProvider(boot: BootConfig): Promise<TelemetryProvider | null> {
  if (!boot.hasOverlay) {
    return null;
  }
  const environments = await loadEnvironments(boot.metaUrl);
  // A live Tempo overlay is labelled "tempo"; a mock or a saved file both ride the same static
  // HTTP transport, so they share the "mock" provider label.
  const providerKind = boot.overlayKind === "tempo" ? "tempo" : "mock";
  return createHttpTelemetryProvider(boot.overlayUrl, environments, providerKind);
}
