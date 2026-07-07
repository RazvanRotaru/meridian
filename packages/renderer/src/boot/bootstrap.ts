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
import { readBootConfig, type BootConfig } from "./bootConfig";
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
  const store = createBlueprintStore({
    artifact,
    index,
    provider,
    hasOverlay: boot.hasOverlay,
    sourceUrl: boot.sourceUrl,
    reviewScopeRef: boot.reviewScopeRef,
    reviewTruncated: boot.reviewTruncated,
  });
  // Restore the navigation state carried in the URL (or fall through to defaults) and run the
  // first layout, then apply the PR-review boot payload as a fallback and start reflecting the
  // store back into the URL for reload/back/forward.
  await restoreFromUrl(store);
  applyReviewBoot(store, boot);
  startUrlSync(store);
  return { store, boot };
}

/**
 * PR-review boot precedence: a `?files=` link is applied by restoreFromUrl (so the store already
 * carries those files); otherwise fall back to the boot payload's affectedFiles, opening the lens
 * unless the URL explicitly named a different view. Runs before startUrlSync so seeding the payload
 * doesn't add a history entry.
 */
function applyReviewBoot(store: BlueprintStore, boot: BootConfig): void {
  if (store.getState().affectedFiles.length > 0 || boot.affectedFiles.length === 0) {
    return;
  }
  store.getState().setAffectedFiles(boot.affectedFiles);
  if (!hasExplicitView() && store.getState().viewMode !== "review") {
    store.getState().setViewMode("review");
  }
}

function hasExplicitView(): boolean {
  return typeof window !== "undefined" && new URLSearchParams(window.location.search).has("view");
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
