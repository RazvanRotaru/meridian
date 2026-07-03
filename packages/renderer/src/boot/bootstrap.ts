/**
 * Boot sequence: read the injected contract, load the graph, build the index, wire the
 * telemetry provider, create the store, and run the first layout so the initial render shows
 * the collapsed roots. The store and boot config are handed to React from here.
 */

import { isChangeOverlay, type ChangeOverlay } from "@meridian/core";
import { buildGraphIndex } from "../graph/graphIndex";
import { createHttpTelemetryProvider } from "../telemetry/httpProvider";
import type { TelemetryProvider } from "../telemetry/provider";
import { createBlueprintStore, type BlueprintStore } from "../state/store";
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
  const change = await loadChange(boot);
  const store = createBlueprintStore({
    artifact,
    index,
    provider,
    hasOverlay: boot.hasOverlay,
    change,
    fileDiffUrl: boot.fileDiffUrl ?? null,
  });
  // Deterministic hook for e2e drivers (select/dive/openDiff without brittle canvas clicks).
  (window as Window & { __MERIDIAN_STORE__?: BlueprintStore }).__MERIDIAN_STORE__ = store;
  await store.getState().relayout();
  return { store, boot };
}

/** A broken change overlay degrades to structure-only viewing, never a boot failure. */
async function loadChange(boot: BootConfig): Promise<ChangeOverlay | null> {
  if (!boot.changeUrl) {
    return null;
  }
  try {
    const response = await fetch(boot.changeUrl);
    if (!response.ok) {
      return null;
    }
    const parsed: unknown = await response.json();
    return isChangeOverlay(parsed) ? parsed : null;
  } catch {
    return null;
  }
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
