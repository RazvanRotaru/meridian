/**
 * Boot sequence: read the injected contract, load the graph, build the index, wire the
 * telemetry provider, create the store, and run the first layout so the initial render shows
 * the collapsed roots. The store and boot config are handed to React from here.
 */

import { buildGraphIndex } from "../graph/graphIndex";
import { createHttpTelemetryProvider } from "../telemetry/httpProvider";
import type { TelemetrySourceDescriptor, TelemetrySourceRegistration } from "../telemetry/provider";
import { createBlueprintStore, type BlueprintStore } from "../state/store";
import { restoreFromUrl, startUrlSync } from "../state/urlSync";
import { prApiUrlsFromGraphUrl, readBootConfig, type BootConfig } from "./bootConfig";
import { loadArtifact } from "./loadArtifact";
import { loadEnvironments } from "./loadEnvironments";
import { startPrReviewNavigationGuard } from "./prReviewNavigationGuard";

export interface BootResult {
  store: BlueprintStore;
  boot: BootConfig;
}

export async function bootstrap(): Promise<BootResult> {
  // Start synchronously, before the first artifact/provider await: a `rev=1` reload must be guarded
  // from its first splash frame, including the time before a store exists to say `preparing`.
  const navigationGuard = startPrReviewNavigationGuard();
  try {
    const boot = readBootConfig();
    const artifact = await loadArtifact(boot.graphUrl);
    const index = buildGraphIndex(artifact);
    const telemetrySources = await buildTelemetrySources(boot);
    const selectedTelemetrySource = boot.preselectedTelemetrySourceId === null
      ? null
      : telemetrySources.find((source) => source.id === boot.preselectedTelemetrySourceId) ?? null;
    const prApi = prApiUrlsFromGraphUrl(boot.graphUrl);
    const store = createBlueprintStore({
      artifact,
      index,
      provider: selectedTelemetrySource?.provider ?? null,
      telemetrySources,
      telemetrySourceId: selectedTelemetrySource?.id ?? null,
      hasOverlay: boot.hasOverlay,
      sourceUrl: boot.sourceUrl,
      prSessionSource: boot.githubSource,
      prsUrl: prApi.prsUrl,
      prOneUrl: prApi.prOneUrl,
      prFilesUrl: prApi.prFilesUrl,
      prRelatedUrl: prApi.prRelatedUrl,
      prCommentsUrl: prApi.prCommentsUrl,
      prChecksUrl: prApi.prChecksUrl,
      prFileUrl: prApi.prFileUrl,
      graphUrl: boot.graphUrl,
      prReviewUrl: prApi.prReviewUrl,
      analyzeUrl: boot.githubSource ? prApi.analyzeUrl : null,
      graphId: boot.githubSource ? prApi.graphId : null,
    });
    navigationGuard.bindStore(store);
    // Restore the navigation state carried in the URL (or fall through to defaults) and run the
    // first layout, then start reflecting the store back into the URL for reload/back/forward.
    await restoreFromUrl(store);
    navigationGuard.completeInitialRestore();
    startUrlSync(store);
    return { store, boot };
  } catch (error) {
    navigationGuard.dispose();
    throw error;
  }
}

async function buildTelemetrySources(boot: BootConfig): Promise<TelemetrySourceRegistration[]> {
  const descriptors = boot.telemetrySources.length > 0
    ? boot.telemetrySources
    : boot.preselectedTelemetrySourceId !== null
      ? await legacyTelemetrySources(boot)
      : [];
  return descriptors.map((descriptor) => ({
    ...descriptor,
    provider: createHttpTelemetryProvider(
      boot.overlayUrl,
      boot.traceUrl,
      descriptor,
    ),
  }));
}

/** Older servers advertise one overlay rather than a catalog. Boot normalization turns that
 * explicit legacy capability into the matching preselected id; a present empty catalog stays off. */
async function legacyTelemetrySources(boot: BootConfig): Promise<TelemetrySourceDescriptor[]> {
  if (!boot.hasOverlay || boot.overlayKind === null) return [];
  const environments = await loadEnvironments(boot.metaUrl);
  if (boot.overlayKind === "tempo") {
    return [{
      id: "tempo",
      kind: "tempo",
      label: "Tempo",
      provenance: "observed",
      environments,
      supportsMetrics: true,
      supportsTraces: boot.traceAvailable,
    }];
  }
  if (boot.overlayKind === "file") {
    return [{
      id: "file",
      kind: "file",
      label: "Saved telemetry snapshot",
      provenance: "saved",
      environments,
      supportsMetrics: true,
      supportsTraces: false,
    }];
  }
  return [{
    id: "mock",
    kind: "mock",
    label: "Synthetic demo",
    provenance: "synthetic",
    environments,
    supportsMetrics: true,
    supportsTraces: boot.traceAvailable,
  }];
}
