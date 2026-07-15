/**
 * Boot sequence: read the injected contract, load the graph, build the index, wire the
 * telemetry provider, create the store, and run the first layout so the initial render shows
 * the collapsed roots. The store and boot config are handed to React from here.
 */

import { buildGraphIndex } from "../graph/graphIndex";
import {
  GraphProjectionClient,
  type GraphProjectionDataSource,
  type LoadedGraphProjection,
} from "../graph/graphProjectionClient";
import { createHttpTelemetryProvider } from "../telemetry/httpProvider";
import type { TelemetrySourceRegistration } from "../telemetry/provider";
import { createBlueprintStore, type BlueprintStore } from "../state/store";
import { restoreFromUrl, startUrlSync } from "../state/urlSync";
import { prApiUrlsFromProjectionManifest, readBootConfig, type BootConfig } from "./bootConfig";
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
    const loadedGraph = await loadBootGraph(boot);
    const { artifact, index } = loadedGraph;
    const telemetrySources = await buildTelemetrySources(boot);
    const selectedTelemetrySource = boot.preselectedTelemetrySourceId === null
      ? null
      : telemetrySources.find((source) => source.id === boot.preselectedTelemetrySourceId) ?? null;
    const prApi = prApiUrlsFromProjectionManifest(
      boot.graphSource.kind === "projections" ? boot.graphSource.manifestUrl : null,
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
      projectionDataSource: loadedGraph.dataSource,
      initialProjection: loadedGraph.projection,
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

/** Non-React embedders keep the prior all-in-one convenience entry point. */
export async function bootstrap(): Promise<BootResult> {
  const prepared = await prepareBootstrap();
  await prepared.hydrate();
  return { store: prepared.store, boot: prepared.boot };
}

interface LoadedBootGraph {
  artifact: Awaited<ReturnType<typeof loadDevSampleArtifact>>;
  index: ReturnType<typeof buildGraphIndex>;
  dataSource: GraphProjectionDataSource | null;
  projection: LoadedGraphProjection | null;
}

/** Injected sessions have one graph transport: bounded projections. The complete-artifact loader
 * exists only for Vite's non-injected sample and is unreachable from server-provided config. */
export async function loadBootGraph(boot: BootConfig): Promise<LoadedBootGraph> {
  if (boot.graphSource.kind === "dev-sample") {
    const artifact = await loadDevSampleArtifact(boot.graphSource.artifactUrl);
    return { artifact, index: buildGraphIndex(artifact), dataSource: null, projection: null };
  }
  const client = new GraphProjectionClient(boot.graphSource.manifestUrl, boot.graphSource.projectionUrl);
  const manifest = await client.loadManifest();
  const projection = await client.activate(manifest.defaultView);
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
