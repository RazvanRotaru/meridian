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
  // Start synchronously, before the first artifact/provider await: a `rev=1` reload must be guarded
  // from its first splash frame, including the time before a store exists to say `preparing`.
  const navigationGuard = startPrReviewNavigationGuard({
    onAcceptedPopState(search) {
      if (!initialRestoreActive) {
        return;
      }
      initialRestoreGeneration += 1;
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
    const artifact = await loadArtifact(boot.graphUrl);
    report("index");
    const index = buildGraphIndex(artifact);
    report("services");
    const telemetrySources = await buildTelemetrySources(boot);
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
    return { store, boot };
  } catch (error) {
    initialRestoreActive = false;
    initialRestoreStore = null;
    graphViewLease?.dispose();
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
