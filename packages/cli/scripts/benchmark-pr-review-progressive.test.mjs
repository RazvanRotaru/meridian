import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertAuthoritativeGraphNetwork,
  assertExactSymbolHydrationRequest,
  assertFullBaselineCapabilityAbsent,
  assertInitialProjectionCacheHits,
  assertNoFullAnalyzeRequests,
  assertRuntimeVariantAllowed,
  awaitPaletteHydrationOutcome,
  awaitReadyWithIndependentTerminalDrain,
  benchmarkEvidencePlan,
  beginColdPreparationSubscribers,
  captureResponses,
  hasCausalWarmProof,
  fullBaselineCapabilityEvidenceFromArguments,
  fullBaselineCapabilityEvidenceFromCommand,
  installFullBaselineBenchmarkCapability,
  isDisconnectedPaletteRow,
  isolatedColdServiceArguments,
  isolatedColdServiceEnvironment,
  landingManifestObservationFailures,
  matchesExactWarmRequest,
  networkTracker,
  observeMainDocumentViewNavigation,
  parseGitReferenceTip,
  partialOnlyContinuationEvidence,
  projectionEvidence,
  proveFrozenWarmCandidates,
  runWithOwnedColdService,
  waitForGraphNetworkQuiescence,
  waitForReviewSettled,
} from "./benchmark-pr-review-progressive.mjs";

describe("partial-runtime-only benchmark control plane", () => {
  it("schedules only progressive measurements and recordings", () => {
    expect(benchmarkEvidencePlan(true)).toEqual({
      preparedVariants: ["progressive"],
      coldVariants: ["progressive"],
      recordingVariants: ["progressive"],
      startupVariants: ["progressive"],
      fullBaselineCapabilityEnabled: false,
    });
    expect(assertRuntimeVariantAllowed("progressive", "test lane", true)).toBe("progressive");
    expect(() => assertRuntimeVariantAllowed("full", "test lane", true))
      .toThrow(/forbids the full test lane/);
  });

  it("starts isolated production services without the full-baseline capability", () => {
    const args = isolatedColdServiceArguments("/tmp/meridian-cli.js", 43123, {
      partialRuntimeOnly: true,
    });
    expect(args).not.toContain("--benchmark-pr-full-baseline");
    expect(assertFullBaselineCapabilityAbsent(
      fullBaselineCapabilityEvidenceFromArguments(args),
    )).toMatchObject({ inspected: true, present: false });

    const comparativeArgs = isolatedColdServiceArguments("/tmp/meridian-cli.js", 43123);
    expect(comparativeArgs).toContain("--benchmark-pr-full-baseline");
    expect(fullBaselineCapabilityEvidenceFromArguments(comparativeArgs)).toMatchObject({
      inspected: true,
      present: true,
    });
  });

  it("fails closed unless the listener command proves the capability absent", () => {
    const production = fullBaselineCapabilityEvidenceFromCommand(
      "node packages/cli/dist/bin.js web --host 127.0.0.1 --port 4189 --no-open",
    );
    expect(assertFullBaselineCapabilityAbsent(production)).toBe(production);
    expect(production.commandSha256).toMatch(/^[a-f0-9]{64}$/);

    const benchmarkEnabled = fullBaselineCapabilityEvidenceFromCommand(
      "node cli.js web --benchmark-pr-full-baseline --port 4189",
    );
    expect(() => assertFullBaselineCapabilityAbsent(benchmarkEnabled)).toThrow(/did not prove/);
    expect(() => assertFullBaselineCapabilityAbsent({ inspected: false, present: null }))
      .toThrow(/did not prove/);
  });

  it("rejects progressive:false bodies and full-baseline headers", () => {
    expect(assertNoFullAnalyzeRequests([{
      method: "POST",
      progressiveFalse: false,
      fullBaselineCapabilityHeaderPresent: false,
    }])).toHaveLength(1);
    expect(() => assertNoFullAnalyzeRequests([{
      progressiveFalse: true,
      fullBaselineCapabilityHeaderPresent: false,
    }])).toThrow(/full-baseline analyze/);
    expect(() => assertNoFullAnalyzeRequests([{
      progressiveFalse: false,
      fullBaselineCapabilityHeaderPresent: true,
    }])).toThrow(/full-baseline analyze/);
    expect(() => assertNoFullAnalyzeRequests([])).toThrow(/full-baseline analyze/);
    expect(() => assertNoFullAnalyzeRequests([{ method: "POST" }]))
      .toThrow(/full-baseline analyze/);
  });

  it("requires both loadable readiness and nonresident graph state for disconnected evidence", () => {
    expect(isDisconnectedPaletteRow("loadable", "false")).toBe(true);
    expect(isDisconnectedPaletteRow("loadable", "true")).toBe(false);
    expect(isDisconnectedPaletteRow("ready", "false")).toBe(false);
    expect(isDisconnectedPaletteRow("loadable", null)).toBe(false);
  });

  it("accepts only a causal exact file-rooted depth-1 symbol hydration request", () => {
    const exact = {
      request: {
        version: 1,
        graphId: "head",
        roots: { kind: "files", fileIds: ["ts:src/target.ts"] },
        requestedDepth: 1,
        prefetchDepth: 1,
      },
      method: "POST",
      path: "/api/graph/project",
      status: 200,
      requestStartedEpochMs: 1_001,
      responseBodyRead: false,
      source: "request-and-response-headers",
    };
    const symbol = { fileId: "ts:src/target.ts" };

    expect(assertExactSymbolHydrationRequest([exact], symbol, "head", 1_000)).toBe(exact);
    for (const request of [
      { ...exact.request, roots: { kind: "changed-files", seedGraphId: "head" } },
      { ...exact.request, roots: { kind: "files", fileIds: ["ts:src/other.ts"] } },
      { ...exact.request, roots: { kind: "files", fileIds: [symbol.fileId, "ts:src/other.ts"] } },
      { ...exact.request, graphId: "base" },
      { ...exact.request, requestedDepth: 2 },
      { ...exact.request, prefetchDepth: 2 },
    ]) {
      expect(() => assertExactSymbolHydrationRequest(
        [{ ...exact, request }], symbol, "head", 1_000,
      )).toThrow(/did not issue one causal exact file-rooted depth-1 projection/);
    }
    expect(() => assertExactSymbolHydrationRequest(
      [{ ...exact, requestStartedEpochMs: 999 }], symbol, "head", 1_000,
    )).toThrow(/did not issue one causal exact file-rooted depth-1 projection/);
  });

  it("lets a fresh node-ready mark win the bounded symbol hydration race", async () => {
    const failure = deferred();

    await expect(awaitPaletteHydrationOutcome(Promise.resolve(), failure.promise, 1_000))
      .resolves.toEqual({ kind: "ready" });
  });

  it("surfaces a palette retry immediately instead of waiting for a missing ready mark", async () => {
    const ready = deferred();

    await expect(awaitPaletteHydrationOutcome(
      ready.promise,
      Promise.resolve({ source: "row-retry", message: "bounded projection failed" }),
      1_000,
    )).rejects.toThrow("selected symbol hydration failed via row-retry: bounded projection failed");
  });

  it("bounds a symbol hydration with no ready or retry outcome", async () => {
    vi.useFakeTimers();
    try {
      const pending = new Promise(() => undefined);
      const observed = awaitPaletteHydrationOutcome(pending, pending, 250).then(
        () => null,
        (error) => error,
      );
      await vi.advanceTimersByTimeAsync(250);
      const error = await observed;

      expect(error).toBeInstanceOf(Error);
      expect(error.message).toBe(
        "selected symbol hydration reached neither ready nor retry after 250 ms",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for every bounded graph request to reach a terminal transport state", async () => {
    const snapshots = [
      { graphAccountingComplete: false, inFlightGraphRequestCount: 2 },
      { graphAccountingComplete: false, inFlightGraphRequestCount: 1 },
      { graphAccountingComplete: true, inFlightGraphRequestCount: 0 },
    ];
    const tracker = {
      snapshot: vi.fn(() => snapshots.shift() ?? snapshots.at(-1)),
    };
    const wait = vi.fn(async () => undefined);

    await expect(waitForGraphNetworkQuiescence(tracker, 1_000, wait))
      .resolves.toEqual({ graphAccountingComplete: true, inFlightGraphRequestCount: 0 });
    expect(tracker.snapshot).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(2);
  });

  it("allows the independent terminal drain to finish before the UI ready callback", async () => {
    let resolveReady;
    const readyPromise = new Promise((resolve) => { resolveReady = resolve; });
    const terminalPromise = Promise.resolve("terminal-first");
    const observed = awaitReadyWithIndependentTerminalDrain(
      readyPromise,
      terminalPromise,
      1_000,
    );

    await Promise.resolve();
    resolveReady("ready-second");

    await expect(observed).resolves.toEqual({
      ready: "ready-second",
      terminal: "terminal-first",
    });
  });

  it("still fails promptly when the independent terminal drain rejects", async () => {
    await expect(awaitReadyWithIndependentTerminalDrain(
      new Promise(() => undefined),
      Promise.reject(new Error("terminal failed")),
      1_000,
    )).rejects.toThrow("terminal failed");
  });

  it("attributes changed-file roots to HEAD and explicit roots to their projected graph", () => {
    expect(projectionEvidence({
      request: {
        graphId: "base",
        roots: { kind: "changed-files", seedGraphId: "head" },
        requestedDepth: 1,
        prefetchDepth: 3,
      },
    })).toMatchObject({ graphId: "base", rootsKind: "changed-files", seedGraphId: "head" });
    expect(projectionEvidence({
      request: {
        graphId: "base",
        roots: { kind: "files", fileIds: ["base:file"] },
        requestedDepth: 1,
        prefetchDepth: 1,
      },
    })).toMatchObject({ graphId: "base", rootsKind: "files", seedGraphId: "base" });
  });
});

describe("full baseline benchmark capability", () => {
  it("marks only the controlled browser context's exact analyze request", async () => {
    let handler = null;
    const context = {
      route: vi.fn(async (_pattern, candidate) => {
        handler = candidate;
      }),
    };
    await installFullBaselineBenchmarkCapability(context, "http://127.0.0.1:4189", true);
    expect(context.route).toHaveBeenCalledWith("**/api/pr/analyze", expect.any(Function));

    const continueRequest = vi.fn(async () => undefined);
    await handler({
      request: () => ({
        allHeaders: async () => ({ accept: "application/x-ndjson" }),
        method: () => "POST",
        url: () => "http://127.0.0.1:4189/api/pr/analyze",
      }),
      continue: continueRequest,
    });

    expect(continueRequest).toHaveBeenCalledWith({
      headers: {
        accept: "application/x-ndjson",
        "x-meridian-pr-full-baseline": "benchmark-v1",
      },
    });
  });

  it("does not install a request escape hatch for partial-only contexts", async () => {
    const context = { route: vi.fn() };
    await installFullBaselineBenchmarkCapability(context, "http://127.0.0.1:4189", false);
    expect(context.route).not.toHaveBeenCalled();
  });
});

describe("partial-only terminal quiescence", () => {
  const terminalProof = {
    streamEnded: true,
    sameBoundedPair: true,
    pairId: "0123456789abcdef0123",
  };
  const evidenceInput = () => ({
    terminalProof,
    canonicalGraphRequests: 0,
    canonicalGraphResponses: 0,
    canonicalReconciliationMarks: 0,
    repositoryAnalysisWorkerPidsAfterTerminal: [],
    boundedPartialWorkerPidsAtDwellStart: [],
    graphProjectWorkerPidsAtDwellStart: [],
    boundedPartialWorkerPidsDuringDwell: [],
    graphProjectWorkerPidsDuringDwell: [],
    preDwellGraphWork: {
      partialProjectionRequests: 2,
      partialProjectionWarmRequests: 2,
      sourceIndexRequests: 1,
      fullGenerationRequests: 0,
    },
    postReadyGraphWork: {
      partialProjectionRequests: 0,
      partialProjectionWarmRequests: 0,
      sourceIndexRequests: 0,
      fullGenerationRequests: 0,
    },
    postTerminalDwellMs: 300,
    processSampleCount: 3,
  });

  it("requires EOF plus zero canonical transport, marks, and repository workers", () => {
    expect(partialOnlyContinuationEvidence(evidenceInput())).toMatchObject({
      version: 2,
      streamEnded: true,
      readyDoneSamePair: true,
      canonicalGraphRequests: 0,
      repositoryAnalysisWorkerPidsAfterTerminal: [],
      routeCounterScope: "same-dwell-request-delta",
    });

    for (const mutate of [
      (value) => { value.canonicalGraphRequests = 1; },
      (value) => { value.canonicalGraphResponses = 1; },
      (value) => { value.canonicalReconciliationMarks = 1; },
      (value) => { value.repositoryAnalysisWorkerPidsAfterTerminal = [42]; },
      (value) => { value.postReadyGraphWork.fullGenerationRequests = 1; },
      (value) => { value.preDwellGraphWork.fullGenerationRequests = 1; },
      (value) => {
        value.boundedPartialWorkerPidsDuringDwell = [43];
      },
      (value) => {
        value.graphProjectWorkerPidsDuringDwell = [44];
      },
      (value) => { value.terminalProof = { ...terminalProof, streamEnded: false }; },
    ]) {
      const evidence = evidenceInput();
      mutate(evidence);
      expect(() => partialOnlyContinuationEvidence(evidence)).toThrow(/continued canonical/);
    }
  });

  it("requires same-dwell route deltas for every newly observed worker kind", () => {
    const cases = [
      {
        name: "partial projection repository worker",
        workerField: "boundedPartialWorkerPidsDuringDwell",
        workerPid: 51,
        routeField: "partialProjectionRequests",
      },
      {
        name: "partial warm repository worker",
        workerField: "boundedPartialWorkerPidsDuringDwell",
        workerPid: 52,
        routeField: "partialProjectionWarmRequests",
      },
      {
        name: "symbol graph-project worker",
        workerField: "graphProjectWorkerPidsDuringDwell",
        workerPid: 53,
        routeField: "sourceIndexRequests",
      },
    ];
    for (const { name, workerField, workerPid, routeField } of cases) {
      const unauthorized = evidenceInput();
      unauthorized[workerField] = [workerPid];
      expect(
        () => partialOnlyContinuationEvidence(unauthorized),
        `${name} must not be authorized by the positive initial counters`,
      ).toThrow(/continued canonical/);

      const authorized = evidenceInput();
      authorized[workerField] = [workerPid];
      authorized.postReadyGraphWork[routeField] = 1;
      expect(partialOnlyContinuationEvidence(authorized), name).toMatchObject({
        [workerField]: [workerPid],
        routeCounterScope: "same-dwell-request-delta",
      });
    }

    const oneRouteTwoWorkers = evidenceInput();
    oneRouteTwoWorkers.boundedPartialWorkerPidsDuringDwell = [61, 62];
    oneRouteTwoWorkers.postReadyGraphWork.partialProjectionRequests = 1;
    expect(() => partialOnlyContinuationEvidence(oneRouteTwoWorkers)).toThrow(/continued canonical/);
  });
});

describe("benchmark CDP network accounting", () => {
  it("excludes in-flight graph bytes, then uses the exact loadingFinished total without double counting", () => {
    const cdp = fakeCdp();
    const tracker = networkTracker(cdp, "http://127.0.0.1:43123");
    cdp.emit("Network.requestWillBeSent", {
      requestId: "full",
      request: { url: "http://127.0.0.1:43123/api/graph?id=head", method: "GET" },
    });
    cdp.emit("Network.responseReceived", {
      requestId: "full",
      response: {
        status: 200,
        mimeType: "application/json",
        encodedDataLength: 40,
        headers: { "Content-Length": "200" },
      },
    });
    cdp.emit("Network.dataReceived", { requestId: "full", encodedDataLength: 90 });
    cdp.emit("Network.dataReceived", { requestId: "full", encodedDataLength: 110 });

    expect(tracker.snapshot()).toMatchObject({
      encodedBytes: 0,
      graphEncodedBytes: 0,
      observedEncodedBytes: 240,
      graphObservedEncodedBytes: 240,
      requestCount: 1,
      inFlightRequestCount: 1,
      inFlightGraphRequestCount: 1,
      graphBytesAuthoritative: false,
      graphAccountingComplete: false,
    });
    cdp.emit("Network.loadingFinished", { requestId: "full", encodedDataLength: 240 });

    expect(tracker.snapshot()).toMatchObject({
      encodedBytes: 240,
      graphEncodedBytes: 240,
      observedEncodedBytes: 240,
      requestCount: 1,
      failedRequestCount: 0,
      finishedRequestCount: 1,
      inFlightRequestCount: 0,
      graphBytesAuthoritative: true,
      graphAccountingComplete: true,
      accountingAnomalyCount: 0,
      byPath: {
        "/api/graph": {
          requests: 1,
          encodedBytes: 240,
          observedEncodedBytes: 240,
          bytesAuthoritative: true,
          accountingComplete: true,
        },
      },
    });
    tracker.dispose();
    expect(cdp.listenerCount()).toBe(0);
  });

  it("keeps background symbol indexing in diagnostics without contaminating initial graph authority", () => {
    const cdp = fakeCdp();
    const tracker = networkTracker(cdp, "http://127.0.0.1:43123");
    cdp.emit("Network.requestWillBeSent", {
      requestId: "symbols",
      request: { url: "http://127.0.0.1:43123/api/graph/symbols?id=head", method: "GET" },
    });
    cdp.emit("Network.responseReceived", {
      requestId: "symbols",
      response: {
        status: 200,
        mimeType: "application/json",
        encodedDataLength: 40,
        headers: { "content-length": "200" },
      },
    });
    cdp.emit("Network.dataReceived", { requestId: "symbols", encodedDataLength: 80 });

    expect(tracker.snapshot()).toMatchObject({
      encodedBytes: 0,
      graphEncodedBytes: 0,
      observedEncodedBytes: 120,
      graphObservedEncodedBytes: 0,
      inFlightRequestCount: 1,
      inFlightGraphRequestCount: 0,
      bytesAuthoritative: false,
      graphBytesAuthoritative: true,
      accountingComplete: false,
      graphAccountingComplete: true,
      byPath: {
        "/api/graph/symbols": {
          requests: 1,
          observedEncodedBytes: 120,
          inFlightRequests: 1,
        },
      },
    });
    expect(() => assertAuthoritativeGraphNetwork(tracker.snapshot())).not.toThrow();
  });

  it("reconstructs an exact consumed ERR_ABORTED projection only from a satisfied Content-Length", () => {
    const cdp = fakeCdp();
    const tracker = networkTracker(cdp, "http://127.0.0.1:43123");
    cdp.emit("Network.requestWillBeSent", {
      requestId: "projection",
      request: { url: "http://127.0.0.1:43123/api/graph/project", method: "POST" },
    });
    cdp.emit("Network.responseReceived", {
      requestId: "projection",
      response: {
        status: 200,
        mimeType: "application/json",
        encodedDataLength: 40,
        headers: { "content-length": "200" },
      },
    });
    cdp.emit("Network.dataReceived", { requestId: "projection", encodedDataLength: 120 });
    cdp.emit("Network.dataReceived", { requestId: "projection", encodedDataLength: 80 });
    cdp.emit("Network.loadingFailed", {
      requestId: "projection",
      canceled: true,
      errorText: "net::ERR_ABORTED",
    });

    expect(tracker.snapshot()).toMatchObject({
      encodedBytes: 240,
      graphEncodedBytes: 240,
      observedEncodedBytes: 240,
      failedRequestCount: 1,
      canceledRequestCount: 1,
      blockedRequestCount: 0,
      graphBytesAuthoritative: true,
      graphAccountingComplete: true,
      byPath: {
        "/api/graph/project": {
          requests: 1,
          encodedBytes: 240,
          observedEncodedBytes: 240,
          failedRequests: 1,
          canceledRequests: 1,
          bytesAuthoritative: true,
        },
      },
    });
    expect(() => assertAuthoritativeGraphNetwork(tracker.snapshot())).not.toThrow();
  });

  it("reconciles an omitted CDP chunk from one exact network ResourceTiming record", () => {
    const cdp = fakeCdp();
    const tracker = networkTracker(cdp, "http://127.0.0.1:43123");
    const timeOriginMs = 1_900_000_000_000;
    cdp.emit("Network.requestWillBeSent", {
      requestId: "projection-resource-timing",
      wallTime: (timeOriginMs + 25.04) / 1_000,
      request: { url: "http://127.0.0.1:43123/api/graph/project", method: "POST" },
    });
    cdp.emit("Network.responseReceived", {
      requestId: "projection-resource-timing",
      response: {
        status: 200,
        mimeType: "application/json",
        encodedDataLength: 40,
        headers: { "content-length": "200" },
      },
    });
    // Chromium can omit the final dataReceived chunk when a consumed fetch is reported as aborted.
    cdp.emit("Network.dataReceived", {
      requestId: "projection-resource-timing",
      encodedDataLength: 120,
    });
    cdp.emit("Network.loadingFailed", {
      requestId: "projection-resource-timing",
      canceled: true,
      errorText: "net::ERR_ABORTED",
    });

    tracker.reconcileResourceTimings({
      timeOriginMs,
      entries: [resourceTiming({ startTimeMs: 25, contentLength: 200 })],
    });
    // Reconciliation is idempotent when sampled at first action and again at settled state.
    tracker.reconcileResourceTimings({
      timeOriginMs,
      entries: [resourceTiming({ startTimeMs: 25, contentLength: 200 })],
    });

    const snapshot = tracker.snapshot();
    expect(snapshot).toMatchObject({
      encodedBytes: 240,
      graphEncodedBytes: 240,
      observedEncodedBytes: 160,
      graphObservedEncodedBytes: 160,
      graphBytesAuthoritative: true,
      graphAccountingComplete: true,
      resourceTimingReconciliationAttemptCount: 1,
      resourceTimingReconciledRequestCount: 1,
      resourceTimingReconciliationRejections: {},
      byteAuthoritySources: { "resource-timing-exact-body": 1 },
      byPath: {
        "/api/graph/project": {
          resourceTimingReconciliationAttempts: 1,
          resourceTimingReconciledRequests: 1,
          resourceTimingReconciliationRejections: {},
          byteAuthoritySources: { "resource-timing-exact-body": 1 },
          bytesAuthoritative: true,
        },
      },
    });
    expect(() => assertAuthoritativeGraphNetwork(snapshot)).not.toThrow();
  });

  it.each([
    ["absent", []],
    ["ambiguous", [
      resourceTiming({ startTimeMs: 25, contentLength: 200 }),
      resourceTiming({ startTimeMs: 25.5, contentLength: 200 }),
    ]],
    ["stale", [resourceTiming({ startTimeMs: 36, contentLength: 200 })]],
    ["mismatched body", [resourceTiming({ startTimeMs: 25, contentLength: 199 })]],
    ["cached", [resourceTiming({ startTimeMs: 25, contentLength: 200, transferSize: 0 })]],
  ])("fails closed for %s ResourceTiming evidence", (_label, entries) => {
    const cdp = fakeCdp();
    const tracker = networkTracker(cdp, "http://127.0.0.1:43123");
    const timeOriginMs = 1_900_000_000_000;
    emitShortConsumedAbort(cdp, {
      requestId: "unproven",
      wallTime: (timeOriginMs + 25) / 1_000,
    });
    tracker.reconcileResourceTimings({ timeOriginMs, entries });

    const snapshot = tracker.snapshot();
    expect(snapshot).toMatchObject({
      graphEncodedBytes: 0,
      graphBytesAuthoritative: false,
      graphAccountingComplete: true,
      resourceTimingReconciliationAttemptCount: 1,
      resourceTimingReconciledRequestCount: 0,
    });
    expect(() => assertAuthoritativeGraphNetwork(snapshot))
      .toThrow(/non-authoritative graph transfer accounting/);
  });

  it("requires a globally unique one-to-one URL and epoch-start correlation", () => {
    const cdp = fakeCdp();
    const tracker = networkTracker(cdp, "http://127.0.0.1:43123");
    const timeOriginMs = 1_900_000_000_000;
    emitShortConsumedAbort(cdp, {
      requestId: "first",
      wallTime: (timeOriginMs + 20) / 1_000,
    });
    emitShortConsumedAbort(cdp, {
      requestId: "second",
      wallTime: (timeOriginMs + 60) / 1_000,
    });
    tracker.reconcileResourceTimings({
      timeOriginMs,
      entries: [
        resourceTiming({ startTimeMs: 20.03, contentLength: 200 }),
        resourceTiming({ startTimeMs: 59.96, contentLength: 200 }),
      ],
    });

    expect(tracker.snapshot()).toMatchObject({
      graphEncodedBytes: 480,
      graphBytesAuthoritative: true,
      resourceTimingReconciliationAttemptCount: 2,
      resourceTimingReconciledRequestCount: 2,
      byteAuthoritySources: { "resource-timing-exact-body": 2 },
    });
  });

  it("keeps arbitrary failed and incomplete graph chunks as a non-authoritative lower bound", () => {
    const cdp = fakeCdp();
    const tracker = networkTracker(cdp, "http://127.0.0.1:43123");
    for (const [requestId, graphId] of [["short", "head"], ["blocked", "base"]]) {
      cdp.emit("Network.requestWillBeSent", {
        requestId,
        request: { url: `http://127.0.0.1:43123/api/graph/project?id=${graphId}`, method: "POST" },
      });
      cdp.emit("Network.responseReceived", {
        requestId,
        response: {
          status: 200,
          mimeType: "application/json",
          encodedDataLength: 40,
          headers: { "content-length": "200" },
        },
      });
    }
    cdp.emit("Network.dataReceived", { requestId: "short", encodedDataLength: 120 });
    cdp.emit("Network.loadingFailed", {
      requestId: "short",
      canceled: true,
      errorText: "net::ERR_ABORTED",
    });
    cdp.emit("Network.dataReceived", { requestId: "blocked", encodedDataLength: 50 });
    cdp.emit("Network.loadingFailed", {
      requestId: "blocked",
      canceled: false,
      errorText: "net::ERR_BLOCKED_BY_CLIENT",
      blockedReason: "inspector",
    });

    expect(tracker.snapshot()).toMatchObject({
      encodedBytes: 0,
      graphEncodedBytes: 0,
      observedEncodedBytes: 250,
      graphObservedEncodedBytes: 250,
      failedRequestCount: 2,
      canceledRequestCount: 1,
      blockedRequestCount: 1,
      graphBytesAuthoritative: false,
      graphAccountingComplete: true,
    });
    expect(() => assertAuthoritativeGraphNetwork(tracker.snapshot()))
      .toThrow(/non-authoritative graph transfer accounting/);
  });

  it("uses loadingFinished as authoritative while surfacing an incremental mismatch", () => {
    const cdp = fakeCdp();
    const tracker = networkTracker(cdp, "http://127.0.0.1:43123");
    cdp.emit("Network.requestWillBeSent", {
      requestId: "mismatch",
      request: { url: "http://127.0.0.1:43123/api/graph", method: "GET" },
    });
    cdp.emit("Network.responseReceived", {
      requestId: "mismatch",
      response: { status: 200, mimeType: "application/json", encodedDataLength: 40, headers: {} },
    });
    cdp.emit("Network.dataReceived", { requestId: "mismatch", encodedDataLength: 200 });
    cdp.emit("Network.loadingFinished", { requestId: "mismatch", encodedDataLength: 230 });

    const snapshot = tracker.snapshot();
    expect(snapshot).toMatchObject({
      encodedBytes: 230,
      graphEncodedBytes: 230,
      observedEncodedBytes: 230,
      accountingAnomalyCount: 0,
      accountingDiagnosticCount: 1,
      graphBytesAuthoritative: true,
      graphAccountingComplete: true,
      byPath: {
        "/api/graph": {
          accountingAnomalies: 0,
          accountingDiagnostics: 1,
          bytesAuthoritative: true,
          accountingComplete: true,
        },
      },
    });
    expect(snapshot.accountingDiagnostics).toContainEqual({
      code: "finished-incremental-mismatch",
      path: "/api/graph",
    });
    expect(() => assertAuthoritativeGraphNetwork(snapshot)).not.toThrow();
  });

  it("preserves redirect hops sharing a request id and attributes each origin/path once", () => {
    const cdp = fakeCdp();
    const tracker = networkTracker(cdp, "http://127.0.0.1:43123");
    cdp.emit("Network.requestWillBeSent", {
      requestId: "redirect",
      request: { url: "http://127.0.0.1:43123/old", method: "GET" },
    });
    cdp.emit("Network.responseReceived", {
      requestId: "redirect",
      response: { status: 302, mimeType: "text/plain", encodedDataLength: 80, headers: {} },
    });
    cdp.emit("Network.dataReceived", { requestId: "redirect", encodedDataLength: 20 });
    cdp.emit("Network.requestWillBeSent", {
      requestId: "redirect",
      redirectResponse: {
        url: "http://127.0.0.1:43123/old",
        status: 302,
        mimeType: "text/plain",
        encodedDataLength: 100,
        headers: {},
      },
      request: { url: "http://127.0.0.1:43123/api/graph/project", method: "POST" },
    });
    cdp.emit("Network.responseReceived", {
      requestId: "redirect",
      response: { status: 200, mimeType: "application/json", encodedDataLength: 50, headers: {} },
    });
    cdp.emit("Network.dataReceived", { requestId: "redirect", encodedDataLength: 100 });
    cdp.emit("Network.loadingFinished", { requestId: "redirect", encodedDataLength: 150 });

    expect(tracker.snapshot()).toMatchObject({
      encodedBytes: 250,
      graphEncodedBytes: 150,
      requestCount: 2,
      finishedRequestCount: 2,
      redirectRequestCount: 1,
      graphBytesAuthoritative: true,
      byPath: {
        "/old": { requests: 1, encodedBytes: 100, redirects: 1 },
        "/api/graph/project": { requests: 1, encodedBytes: 150, redirects: 0 },
      },
    });
  });

  it("preserves unexpected request-id reuse as non-authoritative evidence instead of overwriting", () => {
    const cdp = fakeCdp();
    const tracker = networkTracker(cdp, "http://127.0.0.1:43123");
    cdp.emit("Network.requestWillBeSent", {
      requestId: "reused",
      request: { url: "http://127.0.0.1:43123/api/graph/project", method: "POST" },
    });
    cdp.emit("Network.responseReceived", {
      requestId: "reused",
      response: { status: 401, mimeType: "application/json", encodedDataLength: 30, headers: {} },
    });
    cdp.emit("Network.requestWillBeSent", {
      requestId: "reused",
      request: { url: "http://127.0.0.1:43123/api/graph/project", method: "POST" },
    });
    cdp.emit("Network.responseReceived", {
      requestId: "reused",
      response: { status: 200, mimeType: "application/json", encodedDataLength: 40, headers: {} },
    });
    cdp.emit("Network.loadingFinished", { requestId: "reused", encodedDataLength: 40 });

    expect(tracker.snapshot()).toMatchObject({
      requestCount: 2,
      finishedRequestCount: 2,
      requestIdReuseCount: 1,
      accountingAnomalyCount: 1,
      graphBytesAuthoritative: false,
      byPath: { "/api/graph/project": { requests: 2, requestIdReuses: 1 } },
    });
  });

  it("records browser cache delivery as zero wire bytes and non-authoritative graph evidence", () => {
    const cdp = fakeCdp();
    const tracker = networkTracker(cdp, "http://127.0.0.1:43123");
    cdp.emit("Network.requestWillBeSent", {
      requestId: "cached",
      request: { url: "http://127.0.0.1:43123/api/graph", method: "GET" },
    });
    cdp.emit("Network.requestServedFromCache", { requestId: "cached" });
    cdp.emit("Network.responseReceived", {
      requestId: "cached",
      response: {
        status: 200,
        mimeType: "application/json",
        encodedDataLength: 0,
        headers: { "content-length": "200" },
        fromDiskCache: true,
      },
    });
    cdp.emit("Network.dataReceived", { requestId: "cached", encodedDataLength: 200 });
    cdp.emit("Network.loadingFinished", { requestId: "cached", encodedDataLength: 0 });

    expect(tracker.snapshot()).toMatchObject({
      encodedBytes: 0,
      graphEncodedBytes: 0,
      observedEncodedBytes: 0,
      cachedRequestCount: 1,
      graphBytesAuthoritative: false,
      graphAccountingComplete: true,
      byPath: { "/api/graph": { cachedRequests: 1, bytesAuthoritative: false } },
    });
  });
});

describe("benchmark response-origin isolation", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("captures an isolated loopback service while ignoring the default and foreign origins", async () => {
    const page = fakePage();
    const captures = captureResponses(page, "http://127.0.0.1:43123");
    page.emit("response", fakeResponse("http://127.0.0.1:4188/api/pr/analyze", 200, '{"stage":"done","graphId":"wrong"}\n'));
    page.emit("response", fakeResponse("https://example.test/api/graph", 500, "failure"));
    page.emit("response", fakeResponse(
      "http://127.0.0.1:43123/api/pr/analyze",
      200,
      '{"stage":"done","graphId":"isolated"}\n',
    ));
    await captures.settle(1_000);
    expect(captures.analyzeTerminals).toEqual([{ stage: "done", graphId: "isolated" }]);
    expect(captures.failedApiResponses).toEqual([]);
  });

  it("captures exact canonical graph ids and renderer-owned symbol readiness", async () => {
    const page = fakePage();
    const captures = captureResponses(page, "http://127.0.0.1:43123");
    const headRequest = fakeRequest("http://127.0.0.1:43123/api/graph?id=head", 1_100);
    page.emit("request", headRequest);
    page.emit("response", fakeResponse(
      "http://127.0.0.1:43123/api/graph?id=head",
      200,
      "{}",
      headRequest,
    ));
    const symbolRequest = fakeRequest("http://127.0.0.1:43123/api/graph/symbols?id=head", 1_200);
    const symbolResponse = fakeResponse(
      "http://127.0.0.1:43123/api/graph/symbols?id=head",
      200,
      JSON.stringify({ graphId: "head", complete: true, symbols: [] }),
      symbolRequest,
    );
    symbolResponse.json = vi.fn(() => new Promise(() => {}));
    page.emit("request", symbolRequest);
    page.emit("response", symbolResponse);
    captures.setFirstActionableEpochMs(1_150);
    await captures.settle(1_000);
    expect(captures.graphResponses).toEqual([{ graphId: "head", method: "GET", status: 200 }]);
    expect(captures.rendererSymbolResponse("head")).toMatchObject({
      graphId: "head",
      initiatedBy: "renderer-background",
      status: 200,
    });
    expect(symbolResponse.json).not.toHaveBeenCalled();

    captures.markHarnessSymbolInteractionStarted();
    const harnessRequest = fakeRequest("http://127.0.0.1:43123/api/graph/symbols?id=other", 1_300);
    page.emit("request", harnessRequest);
    page.emit("response", fakeResponse(
      "http://127.0.0.1:43123/api/graph/symbols?id=other",
      200,
      JSON.stringify({ graphId: "other", complete: true, symbols: [] }),
      harnessRequest,
    ));
    await captures.settle(1_000);
    expect(captures.rendererSymbolResponse("other")).toBeNull();
    expect(captures.harnessSymbolResponse("other")).toMatchObject({
      graphId: "other",
      initiatedBy: "harness",
      status: 200,
    });
  });

  it("refreshes provisional symbol request timing when response headers arrive", async () => {
    const page = fakePage();
    const captures = captureResponses(page, "http://127.0.0.1:43123");
    let startTime = -1;
    const request = fakeRequest("http://127.0.0.1:43123/api/graph/symbols?id=head");
    request.timing = () => ({ startTime });
    page.emit("request", request);
    captures.setFirstActionableEpochMs(1_150);

    startTime = 1_200;
    page.emit("response", fakeResponse(
      "http://127.0.0.1:43123/api/graph/symbols?id=head",
      200,
      "{}",
      request,
    ));
    await captures.settle(1_000);

    expect(captures.rendererSymbolResponse("head")).toMatchObject({
      graphId: "head",
      requestStartedEpochMs: 1_200,
      status: 200,
    });
  });

  it("times out a stuck captured body with one precise route-only diagnostic", async () => {
    vi.useFakeTimers();
    const page = fakePage();
    const captures = captureResponses(page, "http://127.0.0.1:43123");
    const request = fakeRequest(
      "http://127.0.0.1:43123/api/pr/analyze?access_token=must-not-leak",
      1_000,
      "POST",
    );
    const response = fakeResponse(request.url(), 200, "{}", request);
    response.text = () => new Promise(() => {});
    page.emit("response", response);

    const observed = captures.settle(250).then(
      () => null,
      (error) => error,
    );
    await vi.advanceTimersByTimeAsync(250);
    const error = await observed;

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe(
      "captured response body drain timed out after 250 ms with 1 pending task: POST /api/pr/analyze (HTTP 200)",
    );
    expect(error.message).not.toContain("must-not-leak");
  });

  it("never duplicate-reads renderer projection or warm bodies", async () => {
    const page = fakePage();
    const captures = captureResponses(page, "http://127.0.0.1:43123");
    const projectionRequestBody = {
      version: 1,
      graphId: "head",
      roots: { kind: "changed-files", seedGraphId: "head" },
      requestedDepth: 1,
      prefetchDepth: 3,
    };
    const projectionRequest = fakeRequest(
      "http://127.0.0.1:43123/api/graph/project",
      1_000,
      "POST",
      projectionRequestBody,
    );
    const projectionResponse = fakeResponse(
      projectionRequest.url(),
      200,
      "{}",
      projectionRequest,
      {
        "x-meridian-graph-projection-cache": "hit",
        "x-meridian-graph-projection-key": "a".repeat(64),
        "x-meridian-graph-projection-ready": "true",
      },
    );
    projectionResponse.json = vi.fn(() => Promise.reject(new Error("Network.getResponseBody unavailable")));
    projectionResponse.text = vi.fn(() => new Promise(() => {}));
    projectionResponse.allHeaders = vi.fn(() => new Promise(() => {}));
    page.emit("response", projectionResponse);

    const warmResponses = ["head", "comparison"].map((graphId, index) => {
      const request = fakeRequest(
        "http://127.0.0.1:43123/api/graph/project/warm",
        1_010 + index,
        "POST",
        warmRequest(graphId),
      );
      const response = fakeResponse(request.url(), 202, "{}", request);
      response.json = vi.fn(() => new Promise(() => {}));
      page.emit("request", request);
      page.emit("response", response);
      return response;
    });
    await captures.settle(1_000);

    expect(captures.projections).toEqual([
      expect.objectContaining({
        graphId: "head",
        seedGraphId: "head",
        requestedDepth: 1,
        prefetchDepth: 3,
        loadedDepth: null,
        responseBodyRead: false,
        source: "request-and-response-headers",
        transportStatus: 200,
      }),
    ]);
    expect(captures.projectionResponses).toEqual([
      expect.objectContaining({
        request: projectionRequestBody,
        requestStartedEpochMs: 1_000,
        method: "POST",
        path: "/api/graph/project",
        responseBodyRead: false,
        source: "request-and-response-headers",
      }),
    ]);
    expect(captures.warmResponses).toHaveLength(2);
    expect(captures.warmResponses).toEqual(expect.arrayContaining([
      expect.objectContaining({ graphId: "head", initiatedBy: "renderer-background", status: 202 }),
      expect.objectContaining({ graphId: "comparison", initiatedBy: "renderer-background", status: 202 }),
    ]));
    expect(projectionResponse.json).not.toHaveBeenCalled();
    expect(projectionResponse.text).not.toHaveBeenCalled();
    expect(projectionResponse.allHeaders).not.toHaveBeenCalled();
    for (const response of warmResponses) expect(response.json).not.toHaveBeenCalled();
  });

  it("excludes tagged harness-owned projection proof responses", async () => {
    const page = fakePage();
    const captures = captureResponses(page, "http://127.0.0.1:43123");
    const request = fakeRequest(
      "http://127.0.0.1:43123/api/graph/project",
      1_300,
      "POST",
      { version: 1, graphId: "head" },
      { "x-meridian-benchmark-projection-proof": "1" },
    );
    const response = fakeResponse(request.url(), 200, "{}", request);
    response.json = vi.fn(() => new Promise(() => {}));
    page.emit("response", response);

    await captures.settle(1_000);

    expect(captures.projections).toEqual([]);
    expect(captures.projectionResponses).toEqual([]);
    expect(response.json).not.toHaveBeenCalled();
  });

  it("classifies tagged harness warm proof requests without reading them through Playwright", async () => {
    const page = fakePage();
    const captures = captureResponses(page, "http://127.0.0.1:43123");
    const request = fakeRequest(
      "http://127.0.0.1:43123/api/graph/project/warm",
      1_200,
      "POST",
      warmRequest("head"),
      { "x-meridian-benchmark-warm-proof": "1" },
    );
    const response = fakeResponse(request.url(), 202, "{}", request);
    response.json = vi.fn(() => new Promise(() => {}));
    page.emit("request", request);
    page.emit("response", response);

    await captures.settle(1_000);

    expect(captures.warmResponses).toEqual([
      expect.objectContaining({ initiatedBy: "harness-proof", responseBodyRead: false, status: 202 }),
    ]);
    expect(response.json).not.toHaveBeenCalled();
  });
});

describe("cold benchmark ownership and ordering", () => {
  it("pins every supported Node temp variable to the owned cold-service root", () => {
    const ownedRoot = resolve("owned", "meridian-pr-review-cold-example");
    expect(isolatedColdServiceEnvironment({
      TMPDIR: "/ambient/tmpdir",
      TMP: "/ambient/tmp",
      TEMP: "/ambient/temp",
      UNRELATED: "preserved",
    }, ownedRoot)).toEqual({
      TMPDIR: ownedRoot,
      TMP: ownedRoot,
      TEMP: ownedRoot,
      UNRELATED: "preserved",
    });
  });

  it("subscribes the authoritative NDJSON consumer before the landing UI", () => {
    const order = [];
    beginColdPreparationSubscribers(
      () => { order.push("node"); return Promise.resolve("all-nine-events"); },
      () => { order.push("landing"); return Promise.resolve("manifest-and-done"); },
    );
    expect(order).toEqual(["node", "landing"]);
  });

  it("timestamps the actual main-document request after the ready callback scheduling delay", async () => {
    const page = fakePage();
    let monotonicNow = 450;
    const observation = observeMainDocumentViewNavigation(
      page,
      "http://127.0.0.1:43123",
      () => monotonicNow,
    );
    const request = {
      url: () => "http://127.0.0.1:43123/view?id=partial&prn=4712&rev=1&progressive=1&partial=1&pair=0123456789abcdef0123",
      resourceType: () => "document",
      isNavigationRequest: () => true,
      frame: () => page.mainFrame(),
    };

    // Canonical done can land during the two requestAnimationFrame delay. The old producer recorded
    // 450 here; the request observer must instead retain the later, actual browser request time.
    monotonicNow = 801;
    page.emit("request", request);

    await expect(observation.promise).resolves.toEqual({
      source: "playwright-main-document-request",
      viewUrl: "/view?id=partial&prn=4712&rev=1&progressive=1&partial=1&pair=0123456789abcdef0123",
      startedAtMonotonicMs: 801,
    });
    expect(page.listenerCount("request")).toBe(0);
  });

  it("stops the owned service even when landing setup fails", async () => {
    let stopped = 0;
    await expect(runWithOwnedColdService(
      { stop: async () => { stopped += 1; } },
      async () => { throw new Error("landing failed"); },
    )).rejects.toThrow(/landing failed/);
    expect(stopped).toBe(1);
  });

  it("retains both the benchmark failure and an exact-cleanup failure", async () => {
    const operationFailure = new Error("landing failed");
    const cleanupFailure = new Error("term-resistant detached worker survived");
    const observed = await runWithOwnedColdService(
      { stop: async () => { throw cleanupFailure; } },
      async () => { throw operationFailure; },
    ).then(() => null, (error) => error);

    expect(observed).toBeInstanceOf(AggregateError);
    expect(observed.message).toMatch(/operation failed.*cleanup also failed/);
    expect(observed.errors).toEqual([operationFailure, cleanupFailure]);
  });

  it("accepts later preexisting hits when one repetition has causal warm proof", () => {
    expect(hasCausalWarmProof([
      { cacheReadiness: { causalWarmReadyHit: true } },
      { cacheReadiness: { causalWarmReadyHit: false, nextDepthCacheHit: true } },
    ])).toBe(true);
    expect(hasCausalWarmProof([
      { cacheReadiness: { causalWarmReadyHit: false, nextDepthCacheHit: true } },
    ])).toBe(false);
  });
});

describe("cold landing manifest mark validation", () => {
  it("accepts one visible application mark with the exact shared timestamp", () => {
    expect(landingManifestObservationFailures({
      visible: true,
      mark: { atMs: 12.5, requestStartedAtMs: 2, ttaMs: 10.5 },
      performanceEntry: {
        name: "meridian:pr-manifest-shell-actionable",
        startTimeMs: 12.5,
      },
    })).toEqual([]);
  });

  it("reports sanitized invariant names instead of collapsing mark failures", () => {
    expect(landingManifestObservationFailures({
      visible: false,
      mark: { atMs: 12.5, requestStartedAtMs: null, ttaMs: null },
      performanceEntry: {
        name: "meridian:pr-manifest-shell-actionable",
        startTimeMs: 13,
      },
    })).toEqual([
      "shell-not-visible",
      "request-start-time-invalid",
      "tta-invalid",
      "performance-entry-time-mismatch",
    ]);
  });

  it("rejects browser-local mark causality before cross-process alignment", () => {
    expect(landingManifestObservationFailures({
      visible: true,
      mark: { atMs: 8, requestStartedAtMs: 10, ttaMs: 1 },
      performanceEntry: {
        name: "meridian:pr-manifest-shell-actionable",
        startTimeMs: 8,
      },
    })).toEqual([
      "mark-before-request-start",
      "tta-duration-mismatch",
    ]);
  });
});

describe("review settled boundary", () => {
  it("uses application-owned navigation readiness without waiting on background network work", async () => {
    const calls = [];
    const page = {
      async waitForLoadState(state, options) {
        calls.push({ kind: "load", state, options });
      },
      async waitForFunction(_predicate, argument, options) {
        calls.push({ kind: "mark", argument, options });
      },
      async evaluate() {
        calls.push({ kind: "fonts-and-frames" });
        return 42.25;
      },
    };

    await expect(waitForReviewSettled(page, 1_234)).resolves.toBe(42.25);
    expect(calls).toEqual([
      { kind: "load", state: "load", options: { timeout: 1_234 } },
      {
        kind: "mark",
        argument: "meridian:navigation-restored",
        options: { polling: "raf", timeout: 1_234 },
      },
      { kind: "fonts-and-frames" },
    ]);
  });
});

describe("benchmark current-base revision resolution", () => {
  it("accepts only the exact requested branch ref and a full immutable object SHA", () => {
    const sha = "A".repeat(40);
    expect(parseGitReferenceTip({
      ref: "refs/heads/release/S201",
      object: { sha },
    }, "release/S201")).toBe(sha.toLowerCase());

    expect(() => parseGitReferenceTip({
      ref: "refs/heads/main",
      object: { sha },
    }, "release/S201")).toThrow(/while resolving refs\/heads\/release\/S201/);

    expect(() => parseGitReferenceTip({
      ref: "refs/heads/release/S201",
      object: { sha: "deadbeef" },
    }, "release/S201")).toThrow(/no valid object SHA/);
  });
});

describe("benchmark next-depth warm correlation", () => {
  it("isolates initial readiness to the exact prepared changed-files pair", () => {
    const prepared = preparedProjectionPair();
    const head = projectionCapture({
      graphId: prepared.graphId,
      roots: { kind: "changed-files", seedGraphId: prepared.graphId },
      requestedDepth: 1,
      prefetchDepth: 3,
      key: prepared.initialProjectionCache.headKey,
    });
    const comparison = projectionCapture({
      graphId: prepared.comparisonGraphId,
      roots: { kind: "changed-files", seedGraphId: prepared.graphId },
      requestedDepth: 1,
      prefetchDepth: 3,
      key: prepared.initialProjectionCache.comparisonKey,
    });
    const unrelatedSearchHydration = projectionCapture({
      graphId: prepared.graphId,
      roots: { kind: "file-paths", paths: ["src/dynamic.ts"] },
      requestedDepth: 0,
      prefetchDepth: 0,
      key: "c".repeat(64),
    });

    const initial = assertInitialProjectionCacheHits(
      [head, unrelatedSearchHydration, comparison],
      prepared,
    );

    expect(initial).toHaveLength(2);
    expect(initial.map((entry) => entry.graphId)).toEqual(["head", "comparison"]);
    expect(initial.every((entry) => entry.seedGraphId === "head")).toBe(true);
    expect(initial.every((entry) => entry.requestedDepth === 1)).toBe(true);
  });

  it("keeps the exact initial-pair boundary fail-closed", () => {
    const prepared = preparedProjectionPair();
    const head = projectionCapture({
      graphId: prepared.graphId,
      roots: { kind: "changed-files", seedGraphId: prepared.graphId },
      requestedDepth: 1,
      prefetchDepth: 3,
      key: prepared.initialProjectionCache.headKey,
    });
    const comparison = projectionCapture({
      graphId: prepared.comparisonGraphId,
      roots: { kind: "changed-files", seedGraphId: prepared.graphId },
      requestedDepth: 1,
      prefetchDepth: 3,
      key: prepared.initialProjectionCache.comparisonKey,
    });

    expect(() => assertInitialProjectionCacheHits([head], prepared))
      .toThrow(/exactly one initial projection request for comparison/);
    expect(() => assertInitialProjectionCacheHits([head, comparison, structuredClone(comparison)], prepared))
      .toThrow(/exactly one initial projection request for comparison/);
    expect(() => assertInitialProjectionCacheHits([
      head,
      projectionCapture({
        graphId: prepared.comparisonGraphId,
        roots: { kind: "changed-files", seedGraphId: prepared.graphId },
        requestedDepth: 1,
        prefetchDepth: 3,
        key: "f".repeat(64),
      }),
    ], prepared)).toThrow(/was not a ready hit on its prepared exact key/);
  });

  it("matches the real nested changed-file root contract for exact HEAD and comparison IDs", () => {
    const prepared = { graphId: "head-graph", comparisonGraphId: "base-graph" };
    const request = {
      version: 1,
      graphId: "base-graph",
      roots: { kind: "changed-files", seedGraphId: "head-graph" },
      requestedDepth: 2,
      prefetchDepth: 4,
    };
    expect(matchesExactWarmRequest(request, prepared)).toBe(true);
    expect(matchesExactWarmRequest({
      ...request,
      seedGraphId: "head-graph",
      roots: { kind: "changed-files", seedGraphId: "wrong-head" },
    }, prepared)).toBe(false);
    expect(matchesExactWarmRequest({
      ...request,
      roots: { kind: "files", seedGraphId: "head-graph", items: [] },
    }, prepared)).toBe(false);
  });

  it("waits for both asymmetric warm keys before any critical proof can preempt the other warm", async () => {
    const events = [];
    const comparisonReplay = deferred();
    const comparisonReady = deferred();
    const candidates = ["head", "comparison"].map((graphId) => ({
      status: 202,
      request: warmRequest(graphId),
    }));
    const keys = {
      head: "1".repeat(64),
      comparison: "2".repeat(64),
    };
    const proof = proveFrozenWarmCandidates(candidates, Date.now() + 10_000, {
      replayWarm(candidate) {
        const graphId = candidate.request.graphId;
        events.push(`replay:${graphId}`);
        const confirmation = {
          status: 202,
          body: {
            version: 1,
            key: keys[graphId],
            accepted: false,
            completed: false,
            cache: "coalesced",
          },
        };
        return graphId === "comparison" ? comparisonReplay.promise : Promise.resolve(confirmation);
      },
      waitUntilReady(candidate, key, deadline) {
        const graphId = candidate.request.graphId;
        events.push(`ready:${graphId}`);
        expect(deadline).toBeGreaterThan(Date.now());
        const status = { status: 200, completed: true, key };
        return graphId === "comparison" ? comparisonReady.promise : Promise.resolve(status);
      },
      requestCritical(candidate) {
        const graphId = candidate.request.graphId;
        events.push(`critical:${graphId}`);
        return Promise.resolve({
          status: 200,
          cache: "hit",
          key: keys[graphId],
          ready: true,
          graphId,
          seedGraphId: "head",
          loadedDepth: 2,
        });
      },
    });

    await vi.waitFor(() => expect(events).toEqual(["replay:head", "replay:comparison"]));
    comparisonReplay.resolve({
      status: 202,
      body: {
        version: 1,
        key: keys.comparison,
        accepted: false,
        completed: false,
        cache: "coalesced",
      },
    });
    await vi.waitFor(() => expect(events).toEqual([
      "replay:head",
      "replay:comparison",
      "ready:head",
      "ready:comparison",
    ]));
    expect(events.some((event) => event.startsWith("critical:"))).toBe(false);

    comparisonReady.resolve({ status: 200, completed: true, key: keys.comparison });
    await expect(proof).resolves.toMatchObject({
      diagnostic: null,
      probes: [{ graphId: "head" }, { graphId: "comparison" }],
    });
    expect(events).toEqual([
      "replay:head",
      "replay:comparison",
      "ready:head",
      "ready:comparison",
      "critical:head",
      "critical:comparison",
    ]);
  });

  it("fails closed before readiness or critical probes when a replay starts replacement work", async () => {
    const events = [];
    const candidates = ["head", "comparison"].map((graphId) => ({
      status: 202,
      request: warmRequest(graphId),
    }));
    const result = await proveFrozenWarmCandidates(candidates, Date.now() + 10_000, {
      async replayWarm(candidate) {
        const graphId = candidate.request.graphId;
        events.push(`replay:${graphId}`);
        return {
          status: 202,
          body: {
            version: 1,
            key: (graphId === "head" ? "1" : "2").repeat(64),
            accepted: graphId === "comparison",
            completed: false,
            cache: graphId === "comparison" ? "miss" : "coalesced",
          },
        };
      },
      async waitUntilReady() {
        events.push("unexpected-ready");
      },
      async requestCritical() {
        events.push("unexpected-critical");
      },
    });

    expect(events).toEqual(["replay:head", "replay:comparison"]);
    expect(result.diagnostic).toMatch(/started replacement work/);
    expect(result.probes).toHaveLength(2);
  });
});

function fakePage() {
  const handlers = new Map();
  const mainFrame = {};
  return {
    on(event, handler) {
      const listeners = handlers.get(event) ?? [];
      listeners.push(handler);
      handlers.set(event, listeners);
    },
    off(event, handler) {
      const listeners = handlers.get(event) ?? [];
      handlers.set(event, listeners.filter((candidate) => candidate !== handler));
    },
    emit(event, value) {
      for (const listener of handlers.get(event) ?? []) listener(value);
    },
    listenerCount(event) {
      return (handlers.get(event) ?? []).length;
    },
    mainFrame() {
      return mainFrame;
    },
  };
}

function fakeCdp() {
  const handlers = new Map();
  return {
    on(event, handler) {
      const listeners = handlers.get(event) ?? [];
      listeners.push(handler);
      handlers.set(event, listeners);
    },
    off(event, handler) {
      const listeners = handlers.get(event) ?? [];
      handlers.set(event, listeners.filter((candidate) => candidate !== handler));
    },
    emit(event, value) {
      for (const listener of handlers.get(event) ?? []) listener(value);
    },
    listenerCount() {
      return [...handlers.values()].reduce((total, listeners) => total + listeners.length, 0);
    },
  };
}

function emitShortConsumedAbort(cdp, { requestId, wallTime }) {
  cdp.emit("Network.requestWillBeSent", {
    requestId,
    wallTime,
    request: { url: "http://127.0.0.1:43123/api/graph/project", method: "POST" },
  });
  cdp.emit("Network.responseReceived", {
    requestId,
    response: {
      status: 200,
      mimeType: "application/json",
      encodedDataLength: 40,
      headers: { "content-length": "200" },
    },
  });
  cdp.emit("Network.dataReceived", { requestId, encodedDataLength: 120 });
  cdp.emit("Network.loadingFailed", {
    requestId,
    canceled: true,
    errorText: "net::ERR_ABORTED",
  });
}

function resourceTiming({ startTimeMs, contentLength, transferSize = contentLength + 300 }) {
  return {
    name: "http://127.0.0.1:43123/api/graph/project",
    entryType: "resource",
    initiatorType: "fetch",
    startTimeMs,
    responseStartMs: startTimeMs + 1,
    responseEndMs: startTimeMs + 2,
    transferSize,
    encodedBodySize: contentLength,
    decodedBodySize: contentLength,
    responseStatus: 200,
    deliveryType: "",
  };
}

function fakeRequest(url, startTime = 1_000, method = "GET", body = null, headers = {}) {
  return {
    url: () => url,
    method: () => method,
    timing: () => ({ startTime }),
    postDataJSON: () => body,
    headers: () => headers,
  };
}

function fakeResponse(url, status, text, request = fakeRequest(url), headers = {}) {
  return {
    url: () => url,
    status: () => status,
    text: async () => text,
    json: async () => JSON.parse(text),
    headers: () => ({
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    }),
    request: () => request,
  };
}

function warmRequest(graphId) {
  return {
    version: 1,
    graphId,
    roots: { kind: "changed-files", seedGraphId: "head" },
    requestedDepth: 2,
    prefetchDepth: 4,
  };
}

function preparedProjectionPair() {
  return {
    graphId: "head",
    comparisonGraphId: "comparison",
    initialProjectionCache: {
      version: 1,
      depth: 1,
      prefetchDepth: 3,
      headKey: "a".repeat(64),
      comparisonKey: "b".repeat(64),
      ready: true,
    },
  };
}

function projectionCapture({ graphId, roots, requestedDepth, prefetchDepth, key }) {
  return {
    request: {
      version: 1,
      graphId,
      roots,
      requestedDepth,
      prefetchDepth,
    },
    method: "POST",
    path: "/api/graph/project",
    status: 200,
    headers: {
      "x-meridian-graph-projection-cache": "hit",
      "x-meridian-graph-projection-key": key,
      "x-meridian-graph-projection-ready": "true",
    },
    projection: null,
    responseBodyRead: false,
    source: "request-and-response-headers",
  };
}

function deferred() {
  let resolvePromise;
  const promise = new Promise((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}
