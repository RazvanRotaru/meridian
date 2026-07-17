/**
 * Boot sequence: read the injected contract, load the graph, build the index, wire the
 * telemetry provider, create the store, and run the first layout so the initial render shows
 * the collapsed roots. The store and boot config are handed to React from here.
 */

import { buildGraphIndex } from "../graph/graphIndex";
import {
  GraphProjectionClient,
  type GraphProjectionDataSource,
  type GraphProjectionEndpoints,
  type LoadedGraphProjection,
} from "../graph/graphProjectionClient";
import { createHttpTelemetryProvider } from "../telemetry/httpProvider";
import type { TelemetrySourceRegistration } from "../telemetry/provider";
import { createBlueprintStore, type BlueprintStore } from "../state/store";
import {
  DEFAULT_RECENT_ALLOCATION_BUDGET_LIMITS,
  RecentAllocationBudget,
} from "../state/recentViewProjectionCache";
import { restoreFromUrl, startUrlSync } from "../state/urlSync";
import { prApiUrlsForGraph, readBootConfig, type BootConfig } from "./bootConfig";
import { loadDevSampleArtifact } from "./loadDevSampleArtifact";
import { startPrReviewNavigationGuard } from "./prReviewNavigationGuard";

export interface BootResult {
  store: BlueprintStore;
  boot: BootConfig;
}

export interface PreparedBootstrap extends BootResult {
  /** Restore URL state, run the first scene layout/PR preparation, then start history sync. */
  hydrate(): Promise<void>;
}

/**
 * Load only the first bounded graph view and construct the store. React mounts this store before
 * `hydrate` starts, which makes real streamed PR preparation stages visible during URL restore.
 */
export async function prepareBootstrap(): Promise<PreparedBootstrap> {
  // Start synchronously, before the first artifact/provider await: a `rev=1` reload must be guarded
  // from its first splash frame, including the time before a store exists to say `preparing`.
  const navigationGuard = startPrReviewNavigationGuard();
  try {
    const boot = readBootConfig();
    const recentAllocationBudget = new RecentAllocationBudget(
      DEFAULT_RECENT_ALLOCATION_BUDGET_LIMITS,
    );
    const loadedGraph = await loadBootGraph(boot, recentAllocationBudget);
    const { artifact, index } = loadedGraph;
    const telemetrySources = await buildTelemetrySources(boot);
    const selectedTelemetrySource = boot.preselectedTelemetrySourceId === null
      ? null
      : telemetrySources.find((source) => source.id === boot.preselectedTelemetrySourceId) ?? null;
    const prApi = prApiUrlsForGraph(
      boot.graphSource.kind === "projections" ? boot.graphSource.graphId : null,
    );
    const store = createBlueprintStore({
      artifact,
      index,
      provider: selectedTelemetrySource?.provider ?? null,
      telemetrySources,
      telemetrySourceId: selectedTelemetrySource?.id ?? null,
      hasOverlay: boot.hasOverlay,
      sourceUrl: boot.sourceUrl,
      syntheticExecutionUrl: boot.syntheticExecutionUrl,
      syntheticExecutionTrust: boot.syntheticExecutionTrust,
      syntheticScenarios: boot.syntheticScenarios,
      prSessionSource: boot.githubSource,
      prsUrl: prApi.prsUrl,
      prOneUrl: prApi.prOneUrl,
      prFilesUrl: prApi.prFilesUrl,
      prRelatedUrl: prApi.prRelatedUrl,
      prCommentsUrl: prApi.prCommentsUrl,
      prChecksUrl: prApi.prChecksUrl,
      prFileUrl: prApi.prFileUrl,
      prReviewUrl: prApi.prReviewUrl,
      prepareUrl: boot.githubSource ? prApi.prepareUrl : null,
      preparedReviewUrl: boot.preparedReviewUrl,
      projectionDataSource: loadedGraph.dataSource,
      initialProjection: loadedGraph.projection,
      recentAllocationBudget,
      projectionEndpoints: boot.graphSource.kind === "projections"
        ? {
            graphId: boot.graphSource.graphId,
            manifestUrl: boot.graphSource.manifestUrl,
            projectionUrl: boot.graphSource.projectionUrl,
            searchUrl: boot.graphSource.searchUrl,
          }
        : null,
    });
    navigationGuard.bindStore(store);
    let hydration: Promise<void> | null = null;
    const hydrate = (): Promise<void> => {
      hydration ??= (async () => {
        try {
          // Restore the navigation state carried in the URL (or fall through to defaults) and run
          // the first layout, then reflect subsequent navigation back into history.
          await restoreFromUrl(store);
          navigationGuard.completeInitialRestore();
          startUrlSync(store);
        } catch (error) {
          navigationGuard.dispose();
          throw error;
        }
      })();
      return hydration;
    };
    return { store, boot, hydrate };
  } catch (error) {
    navigationGuard.dispose();
    throw error;
  }
}

interface LoadedBootGraph {
  artifact: Awaited<ReturnType<typeof loadDevSampleArtifact>>;
  index: ReturnType<typeof buildGraphIndex>;
  dataSource: GraphProjectionDataSource | null;
  projection: LoadedGraphProjection | null;
}

/** Injected sessions have one graph transport: bounded projections. The complete-artifact loader
 * exists only for Vite's non-injected sample and is unreachable from server-provided config. */
export async function loadBootGraph(
  boot: BootConfig,
  recentBudget?: RecentAllocationBudget,
): Promise<LoadedBootGraph> {
  if (boot.graphSource.kind === "dev-sample") {
    const artifact = await loadDevSampleArtifact(boot.graphSource.artifactUrl);
    return { artifact, index: buildGraphIndex(artifact), dataSource: null, projection: null };
  }
  const endpoints: GraphProjectionEndpoints = {
    graphId: boot.graphSource.graphId,
    manifestUrl: boot.graphSource.manifestUrl,
    projectionUrl: boot.graphSource.projectionUrl,
    searchUrl: boot.graphSource.searchUrl,
  };
  const client = new GraphProjectionClient({ recentBudget });
  const manifest = await client.loadManifest({ endpoints });
  const staged = await client.stage(manifest.defaultView, { endpoints });
  let projection: LoadedGraphProjection;
  try {
    projection = staged.commit();
  } finally {
    staged.release();
  }
  return {
    artifact: projection.artifact,
    index: projection.index,
    dataSource: client,
    projection,
  };
}

async function buildTelemetrySources(boot: BootConfig): Promise<TelemetrySourceRegistration[]> {
  return boot.telemetrySources.map((descriptor) => ({
    ...descriptor,
    provider: createHttpTelemetryProvider(
      boot.overlayUrl,
      boot.traceUrl,
      descriptor,
    ),
  }));
}
