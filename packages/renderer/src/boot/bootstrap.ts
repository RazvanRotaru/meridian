/**
 * Boot sequence: read the injected contract, load the graph, build the index, wire the
 * telemetry provider, create the store, and run the first layout so the initial render shows
 * the collapsed roots. The store and boot config are handed to React from here.
 */

import { buildGraphIndex } from "../graph/graphIndex";
import {
  createPrReviewProgressSnapshot,
  reducePrReviewProgress,
  type PrReviewProgressSnapshot,
} from "@meridian/core";
import { createHttpTelemetryProvider } from "../telemetry/httpProvider";
import type { TelemetrySourceDescriptor, TelemetrySourceRegistration } from "../telemetry/provider";
import { createBlueprintStore, type BlueprintStore } from "../state/store";
import {
  changedFileProjectionRequest,
  fetchGraphProjection,
  isProjectionReadyForCanvas,
  projectionToArtifact,
} from "../state/progressiveGraph";
import type { GraphArtifact, GraphProjectionV1 } from "@meridian/core";
import { restoreFromUrl, startUrlSync } from "../state/urlSync";
import {
  progressStageFromReviewState,
  readStoredPrReviewProgressHandoff,
  type BootProgressPath,
  type BootProgressStage,
  type BootstrapProgressOptions,
} from "./bootProgress";
import { prApiUrlsFromGraphUrl, readBootConfig, type BootConfig } from "./bootConfig";
import { loadArtifact } from "./loadArtifact";
import { loadEnvironments } from "./loadEnvironments";
import {
  reviewRestorePrNumber,
  reviewRestoreRequested,
  startPrReviewNavigationGuard,
} from "./prReviewNavigationGuard";
import { startGraphViewLease } from "./graphViewLease";

export interface BootResult {
  store: BlueprintStore;
  boot: BootConfig;
}

export async function bootstrap(options: BootstrapProgressOptions = {}): Promise<BootResult> {
  let initialRestoreActive = true;
  let initialRestoreGeneration = 0;
  let pendingInitialRestoreSearch: string | null = null;
  let initialRestoreStore: BlueprintStore | null = null;
  let initialProjectionAbort: AbortController | null = null;
  let initialProjectionGeneration: number | null = null;
  // Start synchronously, before the first artifact/provider await: a `rev=1` reload must be guarded
  // from its first splash frame, including the time before a store exists to say `preparing`.
  const navigationGuard = startPrReviewNavigationGuard({
    onAcceptedPopState(search) {
      if (!initialRestoreActive) {
        return;
      }
      initialRestoreGeneration += 1;
      initialProjectionAbort?.abort();
      pendingInitialRestoreSearch = search;
      const state = initialRestoreStore?.getState();
      if (state?.prReviewStatus === "preparing") {
        state.cancelPrReviewPreparation();
      }
    },
  });
  let graphViewLease: ReturnType<typeof startGraphViewLease> | null = null;
  const restoringReview = typeof window !== "undefined" && reviewRestoreRequested(window.location.search);
  const restoringPrNumber = typeof window === "undefined"
    ? null
    : reviewRestorePrNumber(window.location.search);
  let progressPath: BootProgressPath = restoringReview ? "review-analysis" : "graph";
  let activeRestorePrNumber = restoringPrNumber;
  const storedReviewProgress = restoringReview
    ? options.reviewProgressHandoff ?? readStoredPrReviewProgressHandoff(true)
    : null;
  let activeReviewProgress: PrReviewProgressSnapshot | null = restoringReview
    ? reducePrReviewProgress(
        storedReviewProgress ?? createPrReviewProgressSnapshot(restoringPrNumber),
        {
        type: "stage",
        stage: "load-artifacts",
        },
      )
    : null;
  let lastProgress: {
    stage: BootProgressStage;
    path: BootProgressPath;
    reviewProgress: PrReviewProgressSnapshot | null;
  } | null = null;
  const report = (
    stage: BootProgressStage,
    reviewProgress: PrReviewProgressSnapshot | null = activeReviewProgress,
  ) => {
    if (
      lastProgress?.stage === stage
      && lastProgress.path === progressPath
      && lastProgress.reviewProgress === reviewProgress
    ) {
      return;
    }
    activeReviewProgress = reviewProgress;
    lastProgress = { stage, path: progressPath, reviewProgress };
    options.onProgress?.({ stage, path: progressPath, reviewProgress });
  };
  try {
    report("graph");
    const boot = readBootConfig();
    const prApi = prApiUrlsFromGraphUrl(boot.graphUrl);
    if (prApi.graphId !== null && boot.graphViewLease === null) {
      throw new Error("boot contract violation: registered graph views require a graphViewLease");
    }
    if (boot.graphViewLease !== null) {
      if (prApi.graphId === null) {
        throw new Error("boot contract violation: graph view lease requires a graph id");
      }
      graphViewLease = startGraphViewLease(boot.graphViewLease, prApi.graphId);
    }
    let initialGraphProjection: GraphProjectionV1 | null = null;
    let artifact: GraphArtifact;
    const initialSearch = typeof window === "undefined" ? "" : window.location.search;
    const bootSearch = new URLSearchParams(initialSearch);
    const progressiveRequested = progressiveGraphDeliveryEnabled(restoringReview, initialSearch);
    const partialMarkers = bootSearch.getAll("partial");
    const pairMarkers = bootSearch.getAll("pair");
    const progressiveMarkers = bootSearch.getAll("progressive");
    const hasProvisionalMarker = partialMarkers.length > 0 || pairMarkers.length > 0;
    const provisionalBoot = hasProvisionalMarker
      && partialMarkers.length === 1
      && partialMarkers[0] === "1"
      && pairMarkers.length === 1
      && /^[a-f0-9]{20}$/.test(pairMarkers[0]!)
      && progressiveMarkers.length === 1
      && progressiveMarkers[0] === "1";
    if (hasProvisionalMarker && !provisionalBoot) {
      throw new Error("malformed provisional PR graph URL");
    }
    const progressiveRestore = restoringReview
      && progressiveRequested
      && boot.graphProjectUrl !== null
      && boot.graphProjectUrl !== undefined
      && boot.graphSymbolsUrl !== null
      && boot.graphSymbolsUrl !== undefined
      && prApi.graphId !== null;
    if (provisionalBoot && !progressiveRestore) {
      throw new Error("the provisional PR graph cannot boot without its verified depth-one projection");
    }
    if (restoringReview && progressiveRequested && !progressiveRestore) {
      throw new Error("the partial PR graph cannot boot without projection and symbol capabilities");
    }
    if (progressiveRestore) {
      performanceMark("meridian:progressive-graph-request-start");
      const projectionGeneration = initialRestoreGeneration;
      const controller = new AbortController();
      initialProjectionAbort = controller;
      try {
        const projection = await fetchGraphProjection(
          boot.graphProjectUrl!,
          // The worker returns only the required depth-1 slice. The renderer requests predicted
          // depth-2 warming only after the first actionable canvas, so admission wins CPU priority.
          changedFileProjectionRequest(prApi.graphId!, prApi.graphId!, 1, 3),
          { signal: controller.signal },
        );
        if (!isInitialProgressiveProjectionReady(projection)) {
          throw new Error("the affected-file projection is not ready through depth 1");
        }
        // Back/Forward can arrive while the worker is running. Never construct a store for the new
        // history entry from the old review's partial graph, even if abort raced with a resolved fetch.
        if (projectionGeneration !== initialRestoreGeneration) {
          throw new Error(
            `${provisionalBoot ? "the provisional" : "the partial"} PR graph history entry changed during bootstrap`,
          );
        } else {
          initialGraphProjection = projection;
          initialProjectionGeneration = projectionGeneration;
          artifact = projectionToArtifact(projection);
          performanceMark("meridian:progressive-graph-ready");
        }
      } catch (error) {
        // A partial artifact is not a complete-artifact fallback. Falling through to the raw graph
        // route would silently claim that omitted nodes are the complete repository graph.
        throw new Error(
          `${provisionalBoot ? "the provisional" : "the partial"} PR graph projection is unavailable`,
          { cause: error },
        );
      } finally {
        if (initialProjectionAbort === controller) initialProjectionAbort = null;
      }
    } else {
      artifact = await loadArtifact(boot.graphUrl);
    }
    report("index");
    const index = buildGraphIndex(artifact);
    report("services");
    const telemetrySources = await buildTelemetrySources(boot);
    // A history transition can also land while telemetry services initialize, after the projection
    // request itself has settled. Fail this generation instead of treating its bounded backing
    // artifact as a complete compatibility baseline.
    if (
      initialGraphProjection !== null
      && initialProjectionGeneration !== initialRestoreGeneration
    ) {
      // The registered backing artifact is the bounded projection source, not a complete graph.
      // A late history transition must restart outside this bootstrap generation instead of
      // silently installing that raw artifact as a complete map.
      throw new Error(
        `${provisionalBoot ? "the provisional" : "the partial"} PR graph projection is unavailable`,
        {
          cause: new Error(
            `${provisionalBoot ? "the provisional" : "the partial"} PR graph history entry changed during bootstrap`,
          ),
        },
      );
    }
    const selectedTelemetrySource = boot.preselectedTelemetrySourceId === null
      ? null
      : telemetrySources.find((source) => source.id === boot.preselectedTelemetrySourceId) ?? null;
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
      prViewedFilesUrl: boot.githubSource ? prApi.prViewedFilesUrl : undefined,
      prRelatedUrl: prApi.prRelatedUrl,
      prCommentsUrl: prApi.prCommentsUrl,
      prChecksUrl: prApi.prChecksUrl,
      prFileUrl: prApi.prFileUrl,
      graphUrl: boot.graphUrl,
      graphProjectUrl: boot.graphProjectUrl ?? null,
      graphSymbolsUrl: boot.graphSymbolsUrl ?? null,
      initialGraphProjection,
      initialGraphProvisional: provisionalBoot && initialGraphProjection !== null,
      loadCanonicalBootArtifact: initialGraphProjection === null || provisionalBoot
        ? null
        : (signal) => loadArtifact(boot.graphUrl, { signal }),
      metaUrl: boot.metaUrl,
      prReviewUrl: prApi.prReviewUrl,
      analyzeUrl: boot.githubSource ? prApi.analyzeUrl : null,
      graphId: boot.githubSource ? prApi.graphId : null,
      graphViewLease,
    });
    if (activeReviewProgress !== null) {
      store.setState({ prReviewProgress: activeReviewProgress });
    }
    if (graphViewLease !== null) {
      const lease = graphViewLease;
      store.subscribe((state, previous) => {
        if (
          state.prPreparedGraphId === previous.prPreparedGraphId
          && state.prPreparedComparisonGraphId === previous.prPreparedComparisonGraphId
        ) {
          return;
        }
        const preparedIds = [state.prPreparedGraphId, state.prPreparedComparisonGraphId]
          .filter((id): id is string => id !== null);
        void lease.replacePreparedGraphIds(preparedIds).catch(() => undefined);
      });
    }
    navigationGuard.bindStore(store);
    initialRestoreStore = store;
    const stopProgress = restoringReview
      ? store.subscribe((state) => {
          if (activeRestorePrNumber === null) {
            report("initial-layout", null);
            return;
          }
          const stage = progressStageFromReviewState(state);
          const progress = stage === "review-details" && state.prReviewProgress.status === "idle"
            ? reducePrReviewProgress(state.prReviewProgress, { type: "stage", stage: "details" })
            : state.prReviewProgress;
          report(stage ?? lastProgress?.stage ?? "review-resolve", progress);
        })
      : () => {};
    // Restore the navigation state carried in the URL (or fall through to defaults) and run the
    // first layout, then start reflecting the store back into the URL for reload/back/forward.
    report("initial-layout");
    try {
      for (;;) {
        const generation = initialRestoreGeneration;
        const search = pendingInitialRestoreSearch ?? undefined;
        pendingInitialRestoreSearch = null;
        const targetPrNumber = reviewRestorePrNumber(search ?? window.location.search);
        activeRestorePrNumber = targetPrNumber;
        progressPath = targetPrNumber === null ? "graph" : "review-analysis";
        if (targetPrNumber === null) {
          report("initial-layout", null);
        }
        const currentProgress = store.getState().prReviewProgress;
        if (
          targetPrNumber === null
          || currentProgress.prNumber !== targetPrNumber
        ) {
          const resetProgress = createPrReviewProgressSnapshot(targetPrNumber);
          if (targetPrNumber !== null) {
            report("initial-layout", resetProgress);
          }
          store.setState({
            prReviewProgress: resetProgress,
          });
        }
        try {
          await restoreFromUrl(store, search, {
            onReviewDetails() {
              store.setState((state) => ({
                prReviewProgress: reducePrReviewProgress(state.prReviewProgress, {
                  type: "stage",
                  stage: "details",
                }),
              }));
            },
            isCurrent() {
              return generation === initialRestoreGeneration;
            },
          });
        } catch (error) {
          // A stale restore may reject while its cancellation is settling. The accepted history
          // entry is still authoritative; only a failure from its own generation aborts bootstrap.
          if (generation === initialRestoreGeneration) {
            throw error;
          }
        }
        if (pendingInitialRestoreSearch === null) {
          break;
        }
      }
    } finally {
      initialRestoreActive = false;
      initialRestoreStore = null;
      stopProgress();
    }
    navigationGuard.completeInitialRestore();
    startUrlSync(store);
    performanceMark("meridian:navigation-restored");
    return { store, boot };
  } catch (error) {
    initialRestoreActive = false;
    initialRestoreStore = null;
    graphViewLease?.dispose();
    navigationGuard.dispose();
    throw error;
  }
}

function performanceMark(name: string): void {
  if (typeof performance !== "undefined" && typeof performance.mark === "function") {
    performance.mark(name);
  }
}

export function progressiveGraphDeliveryEnabled(restoringReview: boolean, search: string): boolean {
  return !restoringReview || new URLSearchParams(search).get("progressive") !== "0";
}

export function progressiveGraphDeliveryForAcceptedSearch(
  pendingSearch: string | null,
  currentSearch: string,
): boolean {
  const acceptedSearch = pendingSearch ?? currentSearch;
  return progressiveGraphDeliveryEnabled(
    reviewRestoreRequested(acceptedSearch),
    acceptedSearch,
  );
}

/** A changed-file HEAD can legitimately be empty for a deletion-only PR. Its merge-base projection
 * supplies the review tombstones later; admitting the empty immutable HEAD here avoids needlessly
 * falling back to the complete artifact while the pair-level gate still protects review entry. */
export function isInitialProgressiveProjectionReady(projection: GraphProjectionV1): boolean {
  return isProjectionReadyForCanvas(projection)
    || (
      projection.rootFileIds.length === 0
      && projection.readyFileIds.length === 0
      && projection.loadedDepth >= projection.requestedDepth
    );
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
