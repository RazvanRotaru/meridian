import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  LANDING_CLOCK_CALIBRATION_SAMPLE_COUNT,
  LANDING_CLOCK_MAX_SELECTED_RTT_MS,
  PARTIAL_ONLY_DELIVERY_CONTRACT,
  PARTIAL_RUNTIME_ONLY_DELIVERY_CONTRACT,
  PR_REVIEW_POC_SCHEMA_VERSION,
  aggregateColdEndToEnd,
  aggregatePartialOnlyResults,
  aggregatePartialRuntimeOnlyColdResults,
  aggregatePartialRuntimeOnlyResults,
  aggregatePrResults,
  alignLandingManifestClock,
  assertStablePullRevision,
  comparisonFromPartialOnlyEvidence,
  comparisonFromSummaries,
  deriveCausalWarmReadinessEvidence,
  deriveVariantUrls,
  deriveColdPreparationMilestones,
  harnessUsage,
  parseFfprobeJson,
  parseFrameMd5,
  parseGitHubPull,
  parseHarnessArgs,
  parseNdjsonText,
  parsePrList,
  parseSignalStats,
  redactSecrets,
  renderHtmlReport,
  safeRelativeMediaPath,
  summarizeVariant,
  validateNontrivialFrames,
  validateCanonicalReconciliation,
  validateCanonicalBaselineTerminal,
  validatePartialAnalyzeTerminal,
  validatePartialPreparationStream,
  validatePartialPreparationTerminal,
  validatePreparationHandoff,
  validatePreparedTerminal,
  validateProvisionalReady,
  validateSampleRevision,
  validateResultsDocument,
  validateVideoProbe,
} from "./pr-review-poc-lib.mjs";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const MERGE_BASE = "c".repeat(40);
const INITIAL_HEAD_KEY = "d".repeat(64);
const INITIAL_COMPARISON_KEY = "e".repeat(64);
const execFileAsync = promisify(execFile);
const RENDER_SCRIPT = fileURLToPath(new URL("./render-pr-review-poc-report.mjs", import.meta.url));

describe("PR review POC harness helpers", () => {
  it("parses deterministic defaults and rejects unsafe/duplicate PR lists", () => {
    const parsed = parseHarnessArgs(["--url", "http://127.0.0.1:4188"], {
      cwd: "/tmp/worktree",
      now: new Date("2026-07-31T12:34:56.789Z"),
    });
    expect(parsed.prs).toEqual([4712, 4703, 3851]);
    expect(parsed.outputDir).toBe("/tmp/worktree/artifacts/pr-review-progressive-poc-2026-07-31T12-34-56-789Z");
    expect(parsed.repetitions).toBe(3);
    expect(parsed.coldEndToEnd).toBe(true);
    expect(parsed.partialRuntimeOnly).toBe(false);
    expect(parsed.coldCliPath).toBe("/tmp/worktree/packages/cli/dist/bin.js");
    expect(parseHarnessArgs(["--url", "http://127.0.0.1:4188", "--no-cold"]).coldEndToEnd).toBe(false);
    expect(parseHarnessArgs([
      "--url", "http://127.0.0.1:4189",
      "--partial-runtime-only",
    ]).partialRuntimeOnly).toBe(true);
    expect(parseHarnessArgs([
      "--url", "http://localhost:4317",
      "--partial-runtime-only",
    ]).partialRuntimeOnly).toBe(true);
    expect(() => parseHarnessArgs([
      "--url", "https://example.com",
      "--partial-runtime-only",
    ])).toThrow(/loopback production origin/);
    expect(() => parseHarnessArgs([
      "--url", "http://127.0.0.1:4189",
      "--partial-runtime-only",
      "--no-recordings",
    ])).toThrow(/requires both progressive recordings/);
    expect(harnessUsage()).toContain("--no-cold");
    expect(harnessUsage()).toContain("--partial-runtime-only");
    expect(harnessUsage()).toContain("--cold-cli PATH");
    expect(harnessUsage()).toContain("--cold-service-timeout-ms N");
    expect(parsePrList("7,8,7")).toEqual([7, 8]);
    expect(() => parsePrList("7, nope")).toThrow(/invalid PR number/);
    expect(() => parseHarnessArgs(["--url", "http://localhost:4000/path"])).toThrow(/origin/);
    expect(() => parseHarnessArgs(["--url", "http://localhost:4000", "--mystery", "x"])).toThrow(/unknown/);
  });

  it("validates GitHub revisions before, during, and after preparation", () => {
    const live = parseGitHubPull({
      number: 4712,
      title: "Fast graph",
      html_url: "https://github.example/UiPath/Autopilot/pull/4712",
      state: "open",
      updated_at: "2026-07-31T10:00:00Z",
      head: { ref: "feature/fast", sha: HEAD, repo: { full_name: "UiPath/Autopilot" } },
      base: { ref: "main", sha: BASE, repo: { full_name: "UiPath/Autopilot" } },
    }, "UiPath/Autopilot", 4712);
    const prepared = validatePreparedTerminal(live, terminal());
    expect(prepared).toMatchObject({
      headSha: HEAD,
      baseSha: BASE,
      mergeBaseSha: MERGE_BASE,
      initialProjectionCache: { ready: true, depth: 1, prefetchDepth: 3 },
    });
    expect(validateSampleRevision(prepared, [terminal()])).toMatchObject({ graphId: "head-graph" });
    const movedBase = "d".repeat(40);
    expect(validatePreparedTerminal(live, terminal({
      baseSha: movedBase,
      preparedPair: { ...terminal().preparedPair, baseSha: movedBase },
    }))).toMatchObject({ baseSha: movedBase });
    expect(validateSampleRevision(prepared, [terminal({ baseSha: movedBase })])).toMatchObject({
      baseSha: movedBase,
      preparedBaseSha: BASE,
      baseTipDrift: true,
    });
    expect(() => validatePreparedTerminal(live, terminal({ headSha: "d".repeat(40) }))).toThrow(/stale HEAD/);
    expect(() => validatePreparedTerminal(live, terminal({
      initialProjectionCache: { ...initialProjectionCache(), ready: false },
    }))).toThrow(/ready exact depth-1/);
    expect(() => validatePreparedTerminal(live, terminal({
      viewUrl: "/view?id=head-graph&view=modules&prn=4712&rev=1",
    }))).toThrow(/progressive review/);
    expect(() => validateSampleRevision(prepared, [])).toThrow(/exactly one revalidation/);
    expect(() => validateSampleRevision(prepared, [terminal(), terminal()])).toThrow(/2 .*terminal events/);
    expect(() => validateSampleRevision(prepared, [{ stage: "error" }])).toThrow(/ended with error/);
    expect(() => assertStablePullRevision(live, { ...live, baseOid: movedBase })).not.toThrow();
    expect(() => assertStablePullRevision(live, { ...live, headOid: movedBase })).toThrow(/moved/);
    expect(() => validateSampleRevision(prepared, [terminal({
      baseSha: movedBase,
      mergeBaseSha: movedBase,
    })])).toThrow(/mergeBaseSha/);
  });

  it("derives full and progressive URLs without changing immutable coordinates", () => {
    const urls = deriveVariantUrls(
      "http://127.0.0.1:4188",
      "/view?id=head-graph&view=modules&prn=4712&rev=1&progressive=1",
    );
    expect(new URL(urls.full).searchParams.get("progressive")).toBe("0");
    expect(new URL(urls.progressive).searchParams.get("progressive")).toBe("1");
    for (const name of ["id", "view", "prn", "rev"]) {
      expect(new URL(urls.full).searchParams.get(name)).toBe(new URL(urls.progressive).searchParams.get(name));
    }
  });

  it("aligns a negative raw browser start only through measured two-phase clock intervals", () => {
    const mark = { requestStartedAtMs: 900, atMs: 910, ttaMs: 10 };
    const aligned = alignLandingManifestClock(mark, {
      beforeSamples: clockSamples({ startNodeMs: 900, offsetMs: 99.8 }),
      afterSamples: clockSamples({ startNodeMs: 1_011, offsetMs: 100 }),
      nodeColdStartedMs: 1_000,
      requestBracket: {
        nodeBeforeMs: 1_000.1,
        nodeAfterMs: 1_000.3,
        browserRequestStartedAtMs: 900,
        browserSampleAtMs: 900.05,
      },
    });

    expect(aligned.clockAlignment.before.selectedSampleIndex).toBe(1);
    expect(aligned.clockAlignment.after.selectedSampleIndex).toBe(1);
    expect(aligned.clockAlignment.rawRequest.estimateMs).toBeCloseTo(-0.2, 10);
    expect(aligned.requestStartedMs).toBeCloseTo(0.2, 10);
    expect(aligned.actionableMs).toBeCloseTo(10.2, 10);
    expect(aligned.actionableMs - aligned.requestStartedMs).toBe(10);
    expect(Math.abs(aligned.clockAlignment.causalResolutionShiftMs)).toBeLessThanOrEqual(
      aligned.clockAlignment.before.uncertaintyMs,
    );
  });

  it("rejects unbounded or causally disjoint cross-process clock evidence", () => {
    const mark = { requestStartedAtMs: 900, atMs: 910, ttaMs: 10 };
    const base = {
      beforeSamples: clockSamples({ startNodeMs: 900, offsetMs: 100 }),
      afterSamples: clockSamples({ startNodeMs: 1_011, offsetMs: 100 }),
      nodeColdStartedMs: 1_000,
      requestBracket: {
        nodeBeforeMs: 1_000.1,
        nodeAfterMs: 1_000.3,
        browserRequestStartedAtMs: 900,
        browserSampleAtMs: 900.05,
      },
    };
    expect(() => alignLandingManifestClock(mark, {
      ...base,
      afterSamples: clockSamples({
        startNodeMs: 1_011,
        offsetMs: 100,
        roundTrips: Array(LANDING_CLOCK_CALIBRATION_SAMPLE_COUNT)
          .fill(LANDING_CLOCK_MAX_SELECTED_RTT_MS + 1),
        spacingMs: LANDING_CLOCK_MAX_SELECTED_RTT_MS + 2,
      }),
    })).toThrow(/after-selected-rtt-exceeds-budget/);
    expect(() => alignLandingManifestClock(mark, {
      ...base,
      afterSamples: clockSamples({ startNodeMs: 1_021, offsetMs: 110 }),
    })).toThrow(/causal-clock-interval-empty/);
    expect(() => alignLandingManifestClock({ ...mark, ttaMs: -1 }, base))
      .toThrow(/browser-mark-causality-invalid/);

    let diagnostic = null;
    try {
      alignLandingManifestClock(mark, { ...base, beforeSamples: [] });
    } catch (error) {
      diagnostic = error.clockAlignmentDiagnostic;
    }
    expect(diagnostic).toMatchObject({
      version: 2,
      invariant: "before-sample-count-invalid",
      providedBeforeSampleCount: 0,
      providedAfterSampleCount: LANDING_CLOCK_CALIBRATION_SAMPLE_COUNT,
      beforeSamples: [],
    });
    expect(Object.keys(diagnostic.requestBracket).sort()).toEqual([
      "browserRequestStartedAtMs",
      "browserSampleAtMs",
      "nodeAfterMs",
      "nodeBeforeMs",
    ]);
  });

  it("derives causal warm readiness only from bodyless renderer transport and same-key proof", () => {
    const prepared = { graphId: "head", comparisonGraphId: "comparison" };
    const evidence = causalWarmEvidence(prepared);
    expect(deriveCausalWarmReadinessEvidence(evidence, prepared)).toEqual({
      warmObserved: true,
      cacheReady: true,
      speculativeWorkAcceptedOrCoalesced: true,
      nextDepthCacheHit: true,
      causalWarmReadyHit: true,
      authoritative: true,
      rendererTransportBodyless: true,
      keyAcquiredByHarnessReplay: true,
      diagnostic: null,
    });

    const replayHit = structuredClone(evidence);
    replayHit.probes[0].warm = {
      ...replayHit.probes[0].warm,
      confirmationStatus: 200,
      accepted: false,
      completed: true,
      cache: "hit",
    };
    expect(deriveCausalWarmReadinessEvidence(replayHit, prepared).causalWarmReadyHit).toBe(true);
  });

  it("rejects preexisting renderer hits, harness-started replacements, and forged warm keys", () => {
    const prepared = { graphId: "head", comparisonGraphId: "comparison" };
    const cases = [
      ["renderer preexisting hit", (value) => { value.warmRequests[0].status = 200; }, /renderer-warm-transport/],
      ["harness replacement", (value) => {
        Object.assign(value.probes[0].warm, {
          confirmationStatus: 202,
          accepted: true,
          completed: false,
          cache: "miss",
        });
      }, /warm-replay-started-or-malformed/],
      ["readiness key", (value) => { value.probes[0].readiness.key = "f".repeat(64); }, /same-key-ready-hit/],
      ["renderer body ownership", (value) => { value.warmRequests[0].responseBodyRead = true; }, /renderer-warm-transport/],
      ["missing graph", (value) => { value.probes.pop(); value.warmRequests.pop(); }, /evidence-cardinality/],
    ];
    for (const [name, mutate, expected] of cases) {
      const evidence = causalWarmEvidence(prepared);
      mutate(evidence);
      expect(() => deriveCausalWarmReadinessEvidence(evidence, prepared), name).toThrow(expected);
    }
  });

  it("parses NDJSON and summarizes medians without treating absent RSS as zero", () => {
    expect(parseNdjsonText('{"stage":"reuse-head"}\n{"stage":"done"}\n')).toHaveLength(2);
    expect(() => parseNdjsonText('{"stage":')).toThrow(/line 1/);
    const summary = summarizeVariant([
      sample(100, 1000, 500, null),
      sample(80, 800, 300, 9000),
      sample(120, 1200, 400, 11000),
    ]);
    expect(summary.firstActionableMs).toBe(100);
    expect(summary.firstActionableFirstMs).toBe(100);
    expect(summary.firstActionableWarmMedianMs).toBe(100);
    expect(summary.graphBytesAtAction).toBe(400);
    expect(summary.processRssBytes).toBe(10000);
    expect(summary.browserJsHeapPeakBytes).toBe(1000);
    expect(summary.browserJsHeapRetainedBytes).toBe(800);
    expect(summary.serviceRssPeakBytes).toBe(20000);
    expect(summary.workerRssRetainedBytes).toBe(2000);
    expect(comparisonFromSummaries(
      { firstActionableMs: 100, settledMs: 200, graphBytesAtAction: 1000, jsHeapUsedBytes: 500, processRssBytes: null },
      { firstActionableMs: 60, settledMs: 150, graphBytesAtAction: 250, jsHeapUsedBytes: 400, processRssBytes: null },
    )).toMatchObject({ firstActionableImprovementPct: 40, graphBytesAtActionReductionPct: 75, processRssReductionPct: null });
  });

  it("requires a monotonic exact cache-miss timeline for cold preparation", () => {
    const prepared = {
      graphId: "cold-head",
      comparisonGraphId: "cold-base",
      headSha: HEAD,
      baseSha: BASE,
      mergeBaseSha: MERGE_BASE,
      counts: { nodes: 100, edges: 200 },
      cache: "miss",
      viewUrl: "/view?id=cold-head&view=modules&prn=4712&rev=1&progressive=1",
      initialProjectionCache: initialProjectionCache(),
    };
    const events = coldPreparationEvents(4712, prepared, 800);
    expect(deriveColdPreparationMilestones(events, prepared)).toMatchObject({
      cloneStartedMs: 0,
      manifestReadyMs: 320,
      provisionalReadyMs: 400,
      initialProjectionPairReadyMs: 400,
      finalPairReadyMs: 800,
      canonicalCompletionLagMs: 400,
      manifestFileCount: 2,
      exactRevisionBound: true,
      source: "client-observed-ndjson-arrival",
    });
    const ready = events.find((event) => event.payload.stage === "ready").payload;
    expect(validateProvisionalReady({ number: 4712, headOid: HEAD }, ready)).toMatchObject({
      pairId: "00000000000000001268",
      completeness: "provisional",
      headSha: HEAD,
      mergeBaseSha: MERGE_BASE,
    });
    expect(validatePreparationHandoff(
      { number: 4712, headOid: HEAD },
      ready,
      events.at(-1).payload,
    )).toMatchObject({
      exactRevisionBound: true,
      provisional: { headSha: HEAD, mergeBaseSha: MERGE_BASE },
      canonical: { headSha: HEAD, mergeBaseSha: MERGE_BASE },
    });
    expect(() => deriveColdPreparationMilestones(
      events.filter((event) => event.payload.stage !== "ready"),
      prepared,
    )).toThrow(/provisional ready/);
    const staleReady = structuredClone(events);
    staleReady.find((event) => event.payload.stage === "ready").payload.headSha = "f".repeat(40);
    expect(() => deriveColdPreparationMilestones(staleReady, prepared)).toThrow(/stale provisional HEAD/);
    expect(() => deriveColdPreparationMilestones(
      events.filter((event) => event.payload.stage !== "manifest-ready"),
      prepared,
    )).toThrow(/manifest-ready/);
    expect(() => deriveColdPreparationMilestones(
      coldPreparationEvents(4712, { ...prepared, cache: "hit" }, 800),
      { ...prepared, cache: "hit" },
    )).toThrow(/cache miss/);
    const staleManifest = structuredClone(events);
    staleManifest.find((event) => event.payload.stage === "manifest-ready").payload.headSha = "f".repeat(40);
    expect(() => deriveColdPreparationMilestones(staleManifest, prepared)).toThrow(/exact headSha/);
  });

  it("treats ready followed by the same partial done and EOF as terminal", () => {
    const canonical = {
      graphId: "canonical-head",
      comparisonGraphId: "canonical-base",
      headSha: HEAD,
      baseSha: BASE,
      mergeBaseSha: MERGE_BASE,
      counts: { nodes: 100, edges: 200 },
      cache: "miss",
      viewUrl: "/view?id=canonical-head&view=modules&prn=4712&rev=1&progressive=1",
      initialProjectionCache: initialProjectionCache(),
    };
    const legacyEvents = coldPreparationEvents(4712, canonical, 800);
    const ready = legacyEvents.find((event) => event.payload.stage === "ready").payload;
    const done = { ...structuredClone(ready), stage: "done" };
    const events = [
      ...legacyEvents.filter((event) => event.payload.stage !== "ready" && event.payload.stage !== "done"),
      { atMs: 800, payload: ready },
      { atMs: 801, payload: done },
    ];
    const live = { number: 4712, headOid: HEAD };

    expect(validatePartialPreparationTerminal(live, ready, done)).toMatchObject({
      completeness: "provisional",
      graphId: ready.graphId,
      pairId: ready.pairId,
    });
    const prepared = validateProvisionalReady(live, ready);
    const {
      viewUrl: _navigationAuthority,
      preparedPair: _landingPair,
      ...analyzeDone
    } = structuredClone(done);
    expect(validatePartialAnalyzeTerminal(live, prepared, analyzeDone)).toMatchObject({
      completeness: "provisional",
      graphId: ready.graphId,
      pairId: ready.pairId,
      preparedBaseSha: BASE,
      baseTipDrift: false,
    });
    expect(validatePartialAnalyzeTerminal(live, prepared, {
      ...analyzeDone,
      baseSha: "d".repeat(40),
    })).toMatchObject({
      preparedBaseSha: BASE,
      baseSha: "d".repeat(40),
      baseTipDrift: true,
    });
    expect(() => validatePartialAnalyzeTerminal(live, {
      ...prepared,
      viewUrl: prepared.viewUrl.replace("partial=1", "partial=0"),
    }, analyzeDone)).toThrow(/viewUrl does not bind the exact ready pair/);
    const otherPairId = "f".repeat(20);
    expect(() => validatePartialAnalyzeTerminal(live, prepared, {
      ...analyzeDone,
      pairId: otherPairId,
      graphId: `pr-partial-${otherPairId}-${HEAD}`,
      comparisonGraphId: `pr-partial-base-${otherPairId}-${MERGE_BASE}`,
    })).toThrow(/changed exact graphId/);
    expect(() => validatePartialAnalyzeTerminal(live, prepared, done)).toThrow(
      /must omit landing navigation fields/,
    );
    expect(validatePartialPreparationStream(live, events)).toMatchObject({
      delivery: PARTIAL_ONLY_DELIVERY_CONTRACT,
      streamEnded: true,
      postReadyStages: ["done"],
      sameBoundedPair: true,
      canonicalContinuationObserved: false,
    });
    expect(() => validatePartialPreparationStream(live, [
      ...events.slice(0, -1),
      { atMs: 800.5, payload: { stage: "extract-head" } },
      events.at(-1),
    ])).toThrow(/adjacent ready, done, and EOF/);
    expect(() => validatePartialPreparationTerminal(live, ready, {
      ...done,
      graphId: "canonical-head",
    })).toThrow(/provisional graph ids|changed exact graphId/);

    expect(validateCanonicalBaselineTerminal(live, {
      stage: "done",
      graphId: "canonical-head",
      comparisonGraphId: "canonical-base",
      headSha: HEAD,
      baseSha: BASE,
      mergeBaseSha: MERGE_BASE,
      counts: { nodes: 100, edges: 200 },
      changedFiles: ready.changedFiles,
      cache: "miss",
    })).toMatchObject({
      completeness: "complete",
      viewUrl: "/view?id=canonical-head&view=modules&prn=4712&rev=1&progressive=0",
    });
  });

  it("renders partial-only diagnostic copy without claiming canonical reconciliation", () => {
    const html = renderHtmlReport({
      schemaVersion: PR_REVIEW_POC_SCHEMA_VERSION,
      status: "running",
      generatedAt: "2026-08-03T12:00:00.000Z",
      config: {
        deliveryContract: PARTIAL_ONLY_DELIVERY_CONTRACT,
        repository: "UiPath/Autopilot",
        prs: [4712, 4704],
      },
      prs: [{
        number: 4712,
        status: "preparing",
        startupRecordings: {
          progressive: { relativePath: "videos/autopilot-pr-4712-progressive-cold-startup.webm" },
        },
      }],
    });
    expect(html).toContain("Action first. The production review path never builds a full graph.");
    expect(html).toContain("syntax-only scan");
    expect(html).toContain("recordings, plural");
    expect(html).toContain("progressive:false");
    expect(html).toContain("Extract + project depth 1");
    expect(html).toContain("initial ghost frontier");
    expect(html).toContain("videos/autopilot-pr-4712-progressive-cold-startup.webm");
    expect(html).not.toContain("Reconcile canonically");
  });

  it("validates a complete partial-only corpus and rejects hidden canonical continuation", () => {
    const document = partialOnlyCompleteDocument();
    const validated = validateResultsDocument(document);
    expect(validated.prs).toHaveLength(2);
    const html = renderHtmlReport(document);
    expect(html).toContain("Publishable partial-only evidence");
    expect(html).toContain("ready → same-pair done → EOF");
    expect(html).toContain("recordings, plural");
    expect(html).not.toContain("background canonical");

    const canonicalRequest = structuredClone(document);
    canonicalRequest.prs[0].variants.progressive.samples[0]
      .partialOnlyContinuation.canonicalGraphRequests = 1;
    expect(() => validateResultsDocument(canonicalRequest)).toThrow(/zero canonical continuation/);

    const worker = structuredClone(document);
    worker.prs[0].startupRecordings.progressive
      .continuationProof.repositoryAnalysisWorkerPidsAfterTerminal = [1234];
    expect(() => validateResultsDocument(worker)).toThrow(/zero canonical continuation/);

    const unauthorizedWorker = structuredClone(document);
    const unauthorizedProof = unauthorizedWorker.prs[0].startupRecordings.progressive.continuationProof;
    unauthorizedProof.boundedPartialWorkerPidsDuringDwell = [1235];
    unauthorizedProof.newBoundedPartialWorkerPidsDuringDwell = [1235];
    unauthorizedProof.postReadyGraphWork.partialProjectionRequests = 0;
    unauthorizedProof.postReadyGraphWork.partialProjectionWarmRequests = 0;
    expect(() => validateResultsDocument(unauthorizedWorker)).toThrow(/route-authorized partial work/);

    const authorizedWorker = structuredClone(document);
    const authorizedProof = authorizedWorker.prs[0].startupRecordings.progressive.continuationProof;
    authorizedProof.graphProjectWorkerPidsDuringDwell = [1236];
    authorizedProof.newGraphProjectWorkerPidsDuringDwell = [1236];
    authorizedProof.postReadyGraphWork.sourceIndexRequests = 1;
    expect(() => validateResultsDocument(authorizedWorker)).not.toThrow();

    const missingRecording = structuredClone(document);
    delete missingRecording.prs[1].startupRecordings.progressive;
    expect(() => validateResultsDocument(missingRecording)).toThrow(/progressive startup recording/);
  });

  it("validates strict partial-runtime-only absolute evidence with no full lane", () => {
    const document = partialRuntimeOnlyCompleteDocument();
    const validated = validateResultsDocument(document);
    expect(validated.aggregate).toEqual(aggregatePartialRuntimeOnlyResults(validated.prs));
    expect(validated.coldAggregate).toEqual(aggregatePartialRuntimeOnlyColdResults(validated.prs));
    expect(validated.aggregate).not.toHaveProperty("comparison");
    expect(validated.coldAggregate).not.toHaveProperty("comparison");
    expect(validated.prs.every((entry) => Object.keys(entry.variants).join() === "progressive")).toBe(true);

    const html = renderHtmlReport(document);
    expect(html).toContain("No full graph lane was enabled or run");
    expect(html).toContain("Zero-full proof");
    expect(html).toContain("Full-baseline capability on the normal listener and every isolated service");
    expect(html).toContain("Canonical graph requests across");
    expect(html).toContain("Full graph generation requests before or after navigation");
    expect(html).toContain("exactly two validated progressive videos");
    expect(html.match(/<video /g)).toHaveLength(4);
    expect(html).not.toContain("<th>Reduction</th>");
    expect(html).not.toMatch(/[−+]\d+(?:\.\d+)?%/);
    expect(html).not.toContain("progressive:false");

    const running = partialRuntimeOnlyCompleteDocument();
    running.status = "running";
    const runningHtml = renderHtmlReport(running);
    expect(runningHtml).toContain("The zero-full claim is not yet verified");
    expect(runningHtml).toContain("no zero-full claim is made from this report");
    expect(runningHtml).not.toContain("Absolute production evidence. No full graph lane was enabled or run.");
  });

  it("accepts an isolated startup pair id only when its local graph chain keeps the main SHAs", () => {
    const document = partialRuntimeOnlyCompleteDocument();
    const startup = document.prs[0].startupRecordings.progressive;
    rebindRuntimeOnlyStartupPair(startup, document.prs[0].number, "1".repeat(20));

    expect(startup.exactRevision.graphId)
      .not.toBe(document.prs[0].revisions.prepared.graphId);
    expect(startup.timings.partialTerminalDoneMs)
      .toBeLessThan(startup.timings.provisionalReadyObservedMs);
    expect(() => validateResultsDocument(document)).not.toThrow();
  });

  it("accepts a strictly bound isolated cold pair with the main immutable SHAs", () => {
    const document = partialRuntimeOnlyCompleteDocument();
    const entry = document.prs[0];
    const cold = entry.coldEndToEnd.variants.progressive;

    expect(cold.prepared.graphId).not.toBe(entry.revisions.prepared.graphId);
    expect(cold.prepared.pairId).not.toBe(entry.revisions.prepared.pairId);
    expect(cold.prepared).toMatchObject({
      headSha: entry.revisions.prepared.headSha,
      baseSha: entry.revisions.prepared.baseSha,
      mergeBaseSha: entry.revisions.prepared.mergeBaseSha,
    });
    expect(cold.preparation.events).toHaveLength(10);
    expect(cold.preparation.terminalProof).toMatchObject({
      readyIndex: 40,
      doneIndex: 41,
      eventCount: 42,
    });
    expect(() => validateResultsDocument(document)).not.toThrow();
  });

  it("rejects cold-local graph, pair, handoff, and projection mismatches", () => {
    for (const [name, mutate, expected] of [
      ["exact graph", (cold) => { cold.exactRevision.graphId = "wrong-cold-head"; }, /cold progressive exact revision/],
      ["stored pair", (cold) => { cold.prepared.graphId = "wrong-cold-head"; }, /graph ids do not bind/],
      ["terminal pair", (cold) => { cold.preparation.terminalProof.pairId = "f".repeat(20); }, /terminal proof changed pairId/],
      ["handoff graph", (cold) => { cold.preparation.handoff.partial.graphId = "wrong-cold-head"; }, /cold progressive handoff/],
      ["projection graph", (cold) => { cold.projections[0].graphId = "wrong-cold-head"; }, /unexpected partial projection/],
    ]) {
      const document = partialRuntimeOnlyCompleteDocument();
      mutate(document.prs[0].coldEndToEnd.variants.progressive);
      expect(() => validateResultsDocument(document), name).toThrow(expected);
    }
  });

  it("rejects invalid original-stream terminal arithmetic without indexing the selected rows", () => {
    const document = partialRuntimeOnlyCompleteDocument();
    document.prs[0].coldEndToEnd.variants.progressive
      .preparation.terminalProof.doneIndex = 42;

    expect(() => validateResultsDocument(document))
      .toThrow(/cold partial terminal proof has invalid full-stream coordinates/);
  });

  it("allows an internally consistent cold base-tip observation to differ from the main run", () => {
    const document = partialRuntimeOnlyCompleteDocument();
    const entry = document.prs[0];
    const driftedBaseSha = "f".repeat(40);
    const coldInput = entry.revisions.coldInputs.progressive;
    coldInput.baseOid = driftedBaseSha;
    coldInput.pullBaseOid = driftedBaseSha;
    driftRuntimeOnlyColdBaseSha(entry.coldEndToEnd.variants.progressive, driftedBaseSha);

    expect(entry.coldEndToEnd.variants.progressive.prepared.baseSha)
      .not.toBe(entry.revisions.prepared.baseSha);
    expect(() => validateResultsDocument(document)).not.toThrow();
  });

  it("rejects internally consistent cold merge-base drift from the main run", () => {
    const document = partialRuntimeOnlyCompleteDocument();
    driftRuntimeOnlyColdMergeBaseSha(
      document.prs[0].coldEndToEnd.variants.progressive,
      "e".repeat(40),
    );

    expect(() => validateResultsDocument(document))
      .toThrow(/cold progressive changed immutable mergeBaseSha/);
  });

  it("rejects isolated startup graph-chain mismatches and internally consistent SHA drift", () => {
    const graphMismatch = partialRuntimeOnlyCompleteDocument();
    rebindRuntimeOnlyStartupPair(
      graphMismatch.prs[0].startupRecordings.progressive,
      graphMismatch.prs[0].number,
      "1".repeat(20),
    );
    graphMismatch.prs[0].startupRecordings.progressive.exactRevision.graphId = "wrong-startup-head";
    expect(() => validateResultsDocument(graphMismatch)).toThrow(/startup exact revision changed exact graphId/);

    const shaDrift = partialRuntimeOnlyCompleteDocument();
    const driftedStartup = shaDrift.prs[0].startupRecordings.progressive;
    const driftedBaseSha = "f".repeat(40);
    driftedStartup.terminalProof.prepared.baseSha = driftedBaseSha;
    driftedStartup.exactRevision.baseSha = driftedBaseSha;
    driftedStartup.exactRevision.preparedBaseSha = driftedBaseSha;
    driftedStartup.handoff.partial.baseSha = driftedBaseSha;
    expect(() => validateResultsDocument(shaDrift))
      .toThrow(/startup changed immutable baseSha from the main prepared pair/);
  });

  it("rejects every full-lane or forged capability path in partial-runtime-only evidence", () => {
    const cases = [
      ["listener capability", (value) => {
        value.config.fullBaselineCapability.present = true;
      }, /capability was absent/],
      ["listener source", (value) => {
        value.config.fullBaselineCapability.source = "isolated-service-spawn-arguments";
      }, /capability was absent/],
      ["listener PID", (value) => {
        value.config.fullBaselineCapability.listenerPid += 1;
      }, /capability was absent/],
      ["canonical revision", (value) => {
        value.prs[0].revisions.canonicalBaseline = {};
      }, /canonical baseline revision must be omitted/],
      ["cold full input", (value) => {
        value.prs[0].revisions.coldInputs.full = revisionSnapshot(4712);
      }, /cold input revisions must contain only the progressive lane/],
      ["canonical preparation", (value) => {
        value.prs[0].preparation.canonicalBaseline = null;
      }, /canonical baseline preparation must be omitted/],
      ["comparison parity", (value) => {
        value.prs[0].parity = {};
      }, /scene comparison parity must be omitted/],
      ["prepared full lane", (value) => {
        value.prs[0].variants.full = null;
      }, /must contain only the progressive lane/],
      ["sample canonical preparation", (value) => {
        value.prs[0].variants.progressive.samples[0].canonicalBaselinePreparation = null;
      }, /canonical baseline preparation must be omitted/],
      ["sample reconciliation", (value) => {
        value.prs[0].variants.progressive.samples[0].reconciliation = null;
      }, /canonical reconciliation must be omitted/],
      ["full analyze body", (value) => {
        value.prs[0].variants.progressive.samples[0].analyzeRequests[0].progressiveFalse = true;
      }, /progressive:false/],
      ["full capability header", (value) => {
        value.prs[0].recordings.progressive.analyzeRequests[0]
          .fullBaselineCapabilityHeaderPresent = true;
      }, /capability header/],
      ["functionality full generation", (value) => {
        value.prs[0].recordings.progressive.partialRuntimeTransport.fullGenerationRequests = 1;
      }, /complete progressive-only graph transport/],
      ["functionality incomplete graph accounting", (value) => {
        value.prs[0].recordings.progressive.partialRuntimeTransport.graphAccountingComplete = false;
      }, /complete progressive-only graph transport/],
      ["canonical graph request", (value) => {
        value.prs[0].coldEndToEnd.variants.progressive
          .partialOnlyContinuation.canonicalGraphRequests = 1;
      }, /zero canonical continuation/],
      ["missing bounded root provenance", (value) => {
        delete value.prs[0].variants.progressive.samples[0].projections[0].rootsKind;
      }, /no bounded root provenance/],
      ["explicit root wrong seed", (value) => {
        value.prs[0].variants.progressive.samples[0].projections[1].rootsKind = "files";
      }, /projection is not rooted/],
      ["full generation", (value) => {
        value.prs[0].startupRecordings.progressive
          .continuationProof.preDwellGraphWork.fullGenerationRequests = 1;
      }, /zero canonical continuation/],
      ["cold capability", (value) => {
        value.prs[0].coldEndToEnd.variants.progressive
          .isolation.fullBaselineCapability.present = true;
      }, /capability was absent/],
      ["startup capability source", (value) => {
        value.prs[0].startupRecordings.progressive
          .isolation.fullBaselineCapability.source = "listener-process-command";
      }, /capability was absent/],
      ["residual isolated worker", (value) => {
        value.prs[0].startupRecordings.progressive.isolation.cleanup.residualPids = [98765];
      }, /tracked process-tree\/group cleanup/],
      ["startup navigation before ready", (value) => {
        value.prs[0].startupRecordings.progressive.navigation.startedMs = 399;
        value.prs[0].startupRecordings.progressive.timings.navigationStartedMs = 399;
      }, /ready-first navigation and independent terminal drain/],
      ["missing functionality video", (value) => {
        delete value.prs[0].recordings.progressive;
      }, /only the progressive lane/],
      ["aggregate full lane", (value) => {
        value.aggregate.full = null;
      }, /aggregate full lane must be omitted/],
      ["cold comparison", (value) => {
        value.coldAggregate.comparison = {};
      }, /cold aggregate comparison must be omitted/],
    ];
    for (const [name, mutate, expected] of cases) {
      const document = partialRuntimeOnlyCompleteDocument();
      mutate(document);
      expect(() => validateResultsDocument(document), name).toThrow(expected);
    }
  });

  it("rejects tampered partial-only revision, schedule, isolation, projection, cache, and renderer proof", () => {
    const cases = [
      ["initial revision", (value) => { value.prs[0].revisions.initial.headOid = "f".repeat(40); }, /initial GitHub revision contradicts/],
      ["final revision", (value) => { value.prs[0].revisions.final.headRef = "moved"; }, /headRef moved/],
      ["cold input", (value) => { value.prs[0].revisions.coldInputs.full.baseRef = "release"; }, /cold full input changed/],
      ["prepared order", (value) => {
        value.prs[0].variants.progressive.samples[0].measurementOrder.sequencePosition = 1;
      }, /prepared counterbalancing schedule/],
      ["cold order", (value) => {
        value.prs[0].coldEndToEnd.order = ["progressive", "full"];
      }, /cold order contradicts/],
      ["global service identity", (value) => {
        value.prs[1].coldEndToEnd.variants.full.isolation.serviceInstanceId =
          value.prs[0].coldEndToEnd.variants.full.isolation.serviceInstanceId;
      }, /reused a service or cache/],
      ["partial projection", (value) => {
        value.prs[0].variants.progressive.samples[0].projections[0].graphId = "wrong-partial";
      }, /unexpected partial projection/],
      ["partial cache key", (value) => {
        value.prs[0].variants.progressive.samples[0].initialProjectionCacheHits[0].key = "f".repeat(64);
      }, /invalid prepared initial projection cache hit/],
      ["cold projection", (value) => {
        value.prs[0].coldEndToEnd.variants.progressive.projections[1].graphId = "wrong-base";
      }, /unexpected partial projection/],
      ["paired symbol", (value) => {
        value.prs[0].recordings.full.interaction.symbol.id = "different-symbol";
      }, /same exact symbol/],
      ["renderer index ownership", (value) => {
        value.prs[0].recordings.progressive.interaction.backgroundSymbolIndex.rendererInitiated = false;
      }, /renderer-initiated background/],
      ["renderer acceptance", (value) => {
        value.prs[0].recordings.progressive.interaction.backgroundSymbolIndex
          .acceptanceMark.indexedSymbolCount += 1;
      }, /renderer acceptance/],
      ["renderer transport timing", (value) => {
        value.prs[0].recordings.progressive.interaction.backgroundSymbolIndex
          .rendererTransport.requestStartedAtMs = 1_000;
      }, /post-action renderer symbol transport/],
      ["startup timing", (value) => {
        value.prs[0].startupRecordings.progressive.timings.navigationStartedMs = 399;
        value.prs[0].startupRecordings.progressive.navigation.startedMs = 399;
      }, /terminal-before-navigation/],
    ];
    for (const [name, mutate, expected] of cases) {
      const document = partialOnlyCompleteDocument();
      mutate(document);
      expect(() => validateResultsDocument(document), name).toThrow(expected);
    }
  });

  it("sources service and worker comparisons only from isolated cold lanes", () => {
    const document = partialOnlyCompleteDocument();
    const expectedServiceReduction = document.prs[0].comparison.serviceRssPeakReductionPct;
    for (const sample of document.prs[0].variants.progressive.samples) {
      sample.serviceMemory.peakRssBytes = 9_999_999;
      sample.serviceMemory.retainedRssBytes = 9_000_000;
    }
    document.prs[0].variants.progressive.summary = summarizeVariant(
      document.prs[0].variants.progressive.samples,
    );
    document.prs[0].comparison = comparisonFromPartialOnlyEvidence(
      document.prs[0].variants.full.summary,
      document.prs[0].variants.progressive.summary,
      document.prs[0].coldEndToEnd.variants.full,
      document.prs[0].coldEndToEnd.variants.progressive,
    );
    document.aggregate = aggregatePartialOnlyResults(document.prs);

    const validated = validateResultsDocument(document);
    expect(validated.prs[0].comparison.serviceRssPeakReductionPct).toBe(expectedServiceReduction);
    expect(validated.prs[0].comparison.memoryScopes).toEqual({
      browser: "prepared-lane-local-browser-process",
      serviceAndWorker: "isolated-cold-fresh-service-and-cache-per-variant",
    });
    const html = renderHtmlReport(document);
    expect(html).toContain("Prepared browser heap peak (lane-local)");
    expect(html).toContain("Isolated cold service RSS peak");
    expect(html).toContain("prepared full/partial samples alternate against one long-lived service");
    expect(html).not.toContain("Prepared service RSS");
  });

  it("surfaces functionality and startup proof inside every partial-only video card", () => {
    const html = renderHtmlReport(partialOnlyCompleteDocument());
    for (const label of [
      "Depth adjustment",
      "Selected symbol",
      "Disconnected before search",
      "Background index accepted",
      "Canvas growth",
    ]) {
      expect(html.split(`<dt>${label}</dt>`)).toHaveLength(5);
    }
    for (const label of [
      "Ready → same-pair done → EOF",
      "Zero full continuation",
      "Post-terminal dwell",
      "Bounded work delta",
    ]) {
      expect(html.split(`<dt>${label}</dt>`)).toHaveLength(5);
    }
    expect(html).toContain("ReviewSymbol4712");
    expect(html).toContain("videos/autopilot-pr-4712-progressive.webm");
    expect(html).toContain("videos/autopilot-pr-4712-progressive-cold-startup.webm");
    expect(html).not.toContain("file://");
  });

  it("requires decodable, moving, non-black video evidence", () => {
    const probe = parseFfprobeJson(JSON.stringify({
      streams: [{ codec_type: "video", codec_name: "vp8", width: 1440, height: 900, duration: "4.5", nb_read_frames: "90", avg_frame_rate: "20/1" }],
      format: { duration: "4.5", size: "200000" },
    }));
    expect(validateVideoProbe(probe)).toMatchObject({ codec: "vp8", frameCount: 90 });
    const hashes = parseFrameMd5("#format: frame checksums\n0, 0, 0, 1, abcdefabcdefabcdefabcdefabcdefab\n0, 1, 1, 1, 12345678123456781234567812345678\n");
    const luma = parseSignalStats("lavfi.signalstats.YAVG=7.5\nlavfi.signalstats.YAVG=21.25\n");
    expect(validateNontrivialFrames(hashes, luma)).toMatchObject({ sampledFrames: 2, distinctFrames: 2, maximumLuma: 21.25 });
    expect(() => validateNontrivialFrames([hashes[0], hashes[0]], [20, 20])).toThrow(/identical/);
    expect(() => validateNontrivialFrames(hashes, [0, 1])).toThrow(/black/);
  });

  it("renders a standalone, escaped report with relative recordings and embedded evidence", () => {
    const document = completeDocument();
    document.prs[0].title = "</script><script>alert(1)</script>";
    const html = renderHtmlReport(document);
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain('src="videos/autopilot-pr-4712-full.webm"');
    expect(html).toContain('src="videos/autopilot-pr-4712-progressive.webm"');
    expect(html).toContain('src="videos/autopilot-pr-4712-full-cold-handoff.webm"');
    expect(html).toContain('src="videos/autopilot-pr-4712-progressive-cold-handoff.webm"');
    expect(html).toContain("Warm settled loading");
    expect(html).toContain("Cold end-to-end: fresh clone to early shell and canvas");
    expect(html).toContain("Cold final pair ready");
    expect(html).toContain("Cumulative prepare request → canvas");
    expect(html).toContain("Cold provisional projection pair ready");
    expect(html).toContain("Cold handoff recordings");
    expect(html).toContain("Functionality recordings");
    expect(html).toContain("meridian:pr-canonical-graph-reconciled");
    expect(html).toContain("exact provisional pair IDs derived from the pair ID and revisions");
    expect(html).toContain("321ms ± 0.10ms");
    expect(html).toContain("2/2 configured PRs complete");
    expect(html).toContain("Causal warm proof");
    expect(html).toContain("transport-only; not duplicate-read");
    expect(html).toContain("tagged exact replay");
    expect(html).toContain("Semantic graph identity &amp; live base-tip provenance");
    expect(html).toContain("Base-tip movement");
    expect(html).toContain("Cold prepared base tips");
    expect(html).toContain("Total measured RSS scope-sum");
    expect(html).toContain("none observed; all lane semantic identities stayed exact");
    expect(html).toContain("\\u003c/script>");
    expect(html).not.toContain("</script><script>alert(1)");
    expect(safeRelativeMediaPath("/tmp/report/report.html", "/tmp/report/videos/demo.webm")).toBe("videos/demo.webm");
    expect(() => safeRelativeMediaPath("/tmp/report/report.html", "/tmp/outside.webm")).toThrow(/inside/);
    expect(() => renderHtmlReport({
      schemaVersion: PR_REVIEW_POC_SCHEMA_VERSION,
      prs: [{ number: 1, recording: { relativePath: "javascript:alert(1)" } }],
    })).toThrow(/unsafe/);
  });

  it("recomputes publishable summaries and rejects contradictory or incomplete evidence", () => {
    const document = completeDocument();
    const validated = validateResultsDocument(document);
    expect(validated.aggregate).toEqual(aggregatePrResults(validated.prs));

    const movedBase = structuredClone(document);
    const observedBase = "f".repeat(40);
    for (const variant of ["full", "progressive"]) {
      movedBase.prs[0].revisions.coldInputs[variant].baseOid = observedBase;
      movedBase.prs[0].variants[variant].samples[0].exactRevision.baseSha = observedBase;
      movedBase.prs[0].variants[variant].samples[0].exactRevision.baseTipDrift = true;
      movedBase.prs[0].recordings[variant].exactRevision.baseSha = observedBase;
      movedBase.prs[0].recordings[variant].exactRevision.baseTipDrift = true;
    }
    movedBase.prs[0].revisions.preparationInput.baseOid = observedBase;
    movedBase.prs[0].revisions.final.baseOid = observedBase;
    expect(() => validateResultsDocument(movedBase)).not.toThrow();
    expect(renderHtmlReport(movedBase)).toContain(
      "observed (2 tips); allowed because all lane semantic identities stayed exact",
    );

    const semanticDrift = structuredClone(document);
    semanticDrift.prs[0].variants.progressive.samples[0].exactRevision.mergeBaseSha = observedBase;
    expect(() => validateResultsDocument(semanticDrift)).toThrow(/mergeBaseSha/);

    const graphDriftWithBaseMovement = structuredClone(document);
    Object.assign(graphDriftWithBaseMovement.prs[0].variants.progressive.samples[0].exactRevision, {
      graphId: "different-head-graph",
      baseSha: observedBase,
      baseTipDrift: true,
    });
    expect(() => validateResultsDocument(graphDriftWithBaseMovement)).toThrow(/graphId/);

    const wrongPreparedBase = structuredClone(document);
    wrongPreparedBase.prs[0].variants.full.samples[0].exactRevision.preparedBaseSha = observedBase;
    expect(() => validateResultsDocument(wrongPreparedBase)).toThrow(/base-tip drift provenance/);

    const wrongDriftFlag = structuredClone(document);
    wrongDriftFlag.prs[0].variants.full.samples[0].exactRevision.baseSha = observedBase;
    expect(() => validateResultsDocument(wrongDriftFlag)).toThrow(/base-tip drift provenance/);

    const invalidObservedBase = structuredClone(document);
    invalidObservedBase.prs[0].revisions.final.baseOid = "not-an-oid";
    expect(() => validateResultsDocument(invalidObservedBase)).toThrow(/observed base tip/);

    const movedEnvelope = structuredClone(document);
    movedEnvelope.prs[0].revisions.coldInputs.full.baseRef = "release";
    expect(() => validateResultsDocument(movedEnvelope)).toThrow(/envelope field baseRef/);

    const missingPreparationInput = structuredClone(document);
    missingPreparationInput.prs[0].revisions.preparationInput = null;
    expect(() => validateResultsDocument(missingPreparationInput)).toThrow(/preparation input revision/);

    const contradictory = structuredClone(document);
    contradictory.prs[0].variants.full.summary.firstActionableMs += 1;
    expect(() => validateResultsDocument(contradictory)).toThrow(/contradicts recomputed/);

    const missingCorpus = structuredClone(document);
    missingCorpus.config.prs = [4712];
    missingCorpus.prs = missingCorpus.prs.slice(0, 1);
    missingCorpus.aggregate = aggregatePrResults(missingCorpus.prs);
    expect(() => validateResultsDocument(missingCorpus)).toThrow(/at least 2/);

    const unprovenCache = structuredClone(document);
    for (const sample of unprovenCache.prs[0].variants.progressive.samples) {
      sample.cacheReadiness.authoritative = false;
    }
    expect(() => validateResultsDocument(unprovenCache)).toThrow(/contradicts recomputed/);

    const missingRecording = structuredClone(document);
    delete missingRecording.prs[0].recordings.full;
    expect(() => validateResultsDocument(missingRecording)).toThrow(/no full recording/);

    const missingHandoffRecording = structuredClone(document);
    delete missingHandoffRecording.prs[0].handoffRecordings.full;
    expect(() => validateResultsDocument(missingHandoffRecording)).toThrow(/no full cold handoff recording/);

    const missingCold = structuredClone(document);
    delete missingCold.prs[0].coldEndToEnd;
    missingCold.coldAggregate = aggregateColdEndToEnd(missingCold.prs);
    expect(() => validateResultsDocument(missingCold)).toThrow(/no requested cold/);

    const reusedColdCache = structuredClone(document);
    reusedColdCache.prs[0].coldEndToEnd.variants.progressive.isolation.cacheInstanceId =
      reusedColdCache.prs[0].coldEndToEnd.variants.full.isolation.cacheInstanceId;
    expect(() => validateResultsDocument(reusedColdCache)).toThrow(/reused a service or cache/);
  });

  it("rejects tampered cold, transport, schedule, warm, recording, and status proof", () => {
    const cases = [
      ["diagnostic status", (value) => { value.config.mode = "diagnostic"; }, /publishable\/diagnostic status/],
      ["prepared order", (value) => {
        value.prs[0].variants.full.samples[0].measurementOrder.sequencePosition = 2;
      }, /prepared counterbalancing schedule/],
      ["full graph identity", (value) => {
        value.prs[0].variants.full.samples[0].graphs[0].graphId = "stale-head";
      }, /unexpected canonical graph response/],
      ["landing manifest row", (value) => {
        value.prs[0].coldEndToEnd.variants.full.landingShell.rows[0].label = "src/wrong.ts";
      }, /landing row 1 contradicts/],
      ["landing clock proof", (value) => {
        value.prs[0].coldEndToEnd.variants.full.landingShell
          .clockAlignment.before.selectedSampleIndex = 0;
      }, /landing clock alignment.*contradicts recomputed/],
      ["landing mark identity", (value) => {
        value.prs[0].coldEndToEnd.variants.full.landingShell.performanceEntry.startTimeMs += 1;
      }, /authoritative landing-shell timing proof/],
      ["completion subscriber", (value) => {
        value.prs[0].coldEndToEnd.variants.progressive.preparation.completionSubscriber = "landing-reader";
      }, /independent canonical completion subscriber/],
      ["progressive navigation gate", (value) => {
        value.prs[0].coldEndToEnd.variants.progressive.timings.navigationStartedMs = 800;
      }, /end-to-end timing decomposition/],
      ["full navigation gate", (value) => {
        value.prs[0].coldEndToEnd.variants.full.timings.navigationStartedMs = 700;
      }, /end-to-end timing decomposition/],
      ["canonical reconciliation graph", (value) => {
        value.prs[0].coldEndToEnd.variants.progressive.reconciliation.mark.detail.graphId = "wrong-head";
      }, /canonical reconciliation mark/],
      ["handoff recording order", (value) => {
        const recording = value.prs[0].handoffRecordings.progressive;
        recording.timings.navigationStartedMs = 800;
        recording.navigation.startedMs = 800;
      }, /ready\/action\/reconcile order/],
      ["process cleanup", (value) => {
        value.prs[0].coldEndToEnd.variants.full.isolation.cleanup.verifiedEmpty = false;
      }, /process-tree\/group cleanup/],
      ["registry integrity", (value) => {
        value.prs[0].coldEndToEnd.variants.full.isolation.cleanup.registryProofHealthy = false;
      }, /process-tree\/group cleanup/],
      ["detached cleanup", (value) => {
        value.prs[0].coldEndToEnd.variants.full.isolation.cleanup.detachedGroupCount = 0;
      }, /process-tree\/group cleanup/],
      ["freeze proof", (value) => {
        value.prs[0].coldEndToEnd.variants.full.isolation.cleanup.sigstopGroupCount = 0;
      }, /process-tree\/group cleanup/],
      ["TERM proof", (value) => {
        value.prs[0].coldEndToEnd.variants.full.isolation.cleanup.sigtermGroupCount = 0;
      }, /process-tree\/group cleanup/],
      ["memory merge", (value) => {
        value.prs[0].coldEndToEnd.variants.full.coldServiceMemory.browserPhasePeakRssBytes = 999_999;
      }, /merged peak memory contradicts/],
      ["preexisting warm hit", (value) => {
        for (const sample of value.prs[0].variants.progressive.samples) {
          sample.cacheReadiness.speculativeWorkAcceptedOrCoalesced = false;
          sample.cacheReadiness.causalWarmReadyHit = false;
        }
      }, /contradicts recomputed/],
      ["prepared initial readiness", (value) => {
        value.prs[0].preparation.events.at(-1).payload.initialProjectionCache.ready = false;
      }, /ready exact depth-1/],
      ["prepared initial key hit", (value) => {
        value.prs[0].variants.progressive.samples[0].initialProjectionCacheHits[0].cache = "miss";
      }, /invalid prepared initial projection cache hit/],
      ["cold initial key hit", (value) => {
        value.prs[0].coldEndToEnd.variants.progressive.initialProjectionCacheHits[1].key = "f".repeat(64);
      }, /invalid prepared initial projection cache hit/],
      ["cold zero graph bytes", (value) => {
        const network = value.prs[0].coldEndToEnd.variants.progressive.networkAtAction;
        Object.assign(network, {
          encodedBytes: 0,
          graphEncodedBytes: 0,
          observedEncodedBytes: 0,
          graphObservedEncodedBytes: 0,
        });
        Object.assign(network.byPath["/api/graph/project"], {
          encodedBytes: 0,
          observedEncodedBytes: 0,
        });
      }, /no positive graph transfer evidence/],
      ["prepared zero graph bytes", (value) => {
        const pr = value.prs[0];
        const network = pr.variants.progressive.samples[0].networkAtAction;
        Object.assign(network, {
          encodedBytes: 100,
          graphEncodedBytes: 0,
          observedEncodedBytes: 100,
          graphObservedEncodedBytes: 0,
        });
        Object.assign(network.byPath["/api/graph/project"], {
          encodedBytes: 0,
          observedEncodedBytes: 0,
        });
        pr.variants.progressive.summary = summarizeVariant(pr.variants.progressive.samples);
        pr.comparison = comparisonFromSummaries(
          pr.variants.full.summary,
          pr.variants.progressive.summary,
        );
        value.aggregate = aggregatePrResults(value.prs);
      }, /no positive graph transfer evidence/],
      ["cold unauthoritative graph bytes", (value) => {
        value.prs[0].coldEndToEnd.variants.progressive
          .networkSettled.graphBytesAuthoritative = false;
      }, /no authoritative complete graph transfer accounting/],
      ["prepared incomplete graph accounting", (value) => {
        value.prs[0].variants.progressive.samples[0]
          .networkAtAction.graphAccountingComplete = false;
      }, /no authoritative complete graph transfer accounting/],
      ["prepared graph route byte drift", (value) => {
        const row = value.prs[0].variants.progressive.samples[0]
          .networkAtAction.byPath["/api/graph/project"];
        row.encodedBytes += 1;
        row.observedEncodedBytes += 1;
      }, /graph byte totals contradict/],
      ["prepared graph observed-byte drift", (value) => {
        value.prs[0].variants.progressive.samples[0]
          .networkSettled.graphObservedEncodedBytes += 1;
      }, /graph byte totals contradict/],
      ["prepared missing route ledger", (value) => {
        delete value.prs[0].variants.progressive.samples[0].networkAtAction.byPath;
      }, /networkAtAction\.byPath/],
      ["prepared opposite graph route", (value) => {
        const network = value.prs[0].variants.progressive.samples[0].networkAtAction;
        network.byPath["/api/graph"] = network.byPath["/api/graph/project"];
        delete network.byPath["/api/graph/project"];
      }, /does not contain only the expected \/api\/graph\/project/],
      ["prepared in-flight graph route", (value) => {
        const network = value.prs[0].variants.progressive.samples[0].networkAtAction;
        network.inFlightGraphRequestCount = 1;
        network.byPath["/api/graph/project"].finishedRequests = 1;
        network.byPath["/api/graph/project"].inFlightRequests = 1;
      }, /in-flight initial graph requests/],
      ["prepared cached graph route", (value) => {
        value.prs[0].variants.progressive.samples[0]
          .networkAtAction.byPath["/api/graph/project"].cachedRequests = 1;
      }, /contaminated or incomplete/],
      ["prepared blocked graph route", (value) => {
        value.prs[0].variants.progressive.samples[0]
          .networkAtAction.byPath["/api/graph/project"].blockedRequests = 1;
      }, /contaminated or incomplete/],
      ["prepared reused graph request ID", (value) => {
        value.prs[0].variants.progressive.samples[0]
          .networkAtAction.byPath["/api/graph/project"].requestIdReuses = 1;
      }, /contaminated or incomplete/],
      ["prepared graph row anomaly", (value) => {
        value.prs[0].variants.progressive.samples[0]
          .networkAtAction.byPath["/api/graph/project"].accountingAnomalies = 1;
      }, /contaminated or incomplete/],
      ["prepared graph path anomaly", (value) => {
        const network = value.prs[0].variants.progressive.samples[0].networkAtAction;
        network.accountingAnomalies.push({
          code: "tampered-ledger",
          path: "/api/graph/project",
        });
        network.accountingAnomalyCount += 1;
      }, /initial graph accounting anomaly/],
      ["prepared unauthoritative graph row", (value) => {
        value.prs[0].variants.progressive.samples[0]
          .networkAtAction.byPath["/api/graph/project"].bytesAuthoritative = false;
      }, /contaminated or incomplete/],
      ["prepared incomplete graph row", (value) => {
        value.prs[0].variants.progressive.samples[0]
          .networkAtAction.byPath["/api/graph/project"].accountingComplete = false;
      }, /contaminated or incomplete/],
      ["prepared action scene parity", (value) => {
        value.prs[0].variants.progressive.samples[0].sceneAtAction.nodeIds.push("node:extra");
      }, /sceneAtAction nodeIds differ/],
      ["hidden prewarm timing", (value) => {
        value.prs[0].coldEndToEnd.variants.progressive.timings.prepareToFirstActionableMs -= 10;
      }, /timing decomposition/],
      ["forged renderer warm status", (value) => {
        value.prs[0].variants.progressive.samples[0]
          .cacheEvidence.warmRequests[0].status = 200;
      }, /causal warm evidence is invalid \(renderer-warm-transport\)/],
      ["widened renderer warm", (value) => {
        value.prs[0].variants.progressive.samples[0]
          .cacheEvidence.warmRequests[0].prefetchDepth = 3;
      }, /causal warm evidence is invalid \(renderer-warm-transport\)/],
      ["forged warm acquisition", (value) => {
        Object.assign(
          value.prs[0].variants.progressive.samples[0].cacheEvidence.probes[0].warm,
          { confirmationStatus: 202, accepted: true, completed: false, cache: "miss" },
        );
      }, /causal warm evidence is invalid \(warm-replay-started-or-malformed\)/],
      ["forged warm hit key", (value) => {
        value.prs[0].variants.progressive.samples[0]
          .cacheEvidence.probes[0].request.key = "f".repeat(64);
      }, /causal warm evidence is invalid \(same-key-ready-hit\)/],
      ["depth recording", (value) => {
        value.prs[0].recordings.progressive.interaction.depthAdjusted = false;
      }, /adjustable depth/],
      ["disconnected search", (value) => {
        value.prs[0].recordings.progressive.interaction.disconnectedBeforeSearch = false;
      }, /disconnected search/],
      ["background indexing", (value) => {
        value.prs[0].recordings.progressive.interaction.backgroundSymbolIndex.rendererInitiated = false;
      }, /renderer-initiated background/],
      ["renderer symbol acceptance", (value) => {
        value.prs[0].recordings.progressive.interaction.backgroundSymbolIndex.acceptanceMark.indexedSymbolCount = 19;
      }, /renderer acceptance/],
      ["renderer symbol transport", (value) => {
        value.prs[0].recordings.progressive.interaction.backgroundSymbolIndex
          .rendererTransport.requestStartedAtMs = 999;
      }, /post-action renderer symbol transport/],
      ["symbol evidence fetch", (value) => {
        value.prs[0].recordings.progressive.interaction.backgroundSymbolIndex.harnessFetch.graphId = "wrong-head";
      }, /exact-revision harness/],
      ["paired symbol", (value) => {
        value.prs[0].recordings.full.interaction.symbol.id = "different-symbol";
      }, /same exact symbol/],
      ["short recording", (value) => {
        value.prs[0].recordings.full.validation.durationSeconds = 1;
      }, /too short/],
      ["wrong viewport", (value) => {
        value.prs[0].recordings.full.validation.width = 1280;
      }, /expected 1440x900/],
    ];
    for (const [name, mutate, expected] of cases) {
      const document = completeDocument();
      mutate(document);
      expect(() => validateResultsDocument(document), name).toThrow(expected);
    }
  });

  it("rejects a progressive recording when canonical done lands during the two-frame navigation delay", () => {
    const document = completeDocument();
    const recording = document.prs[0].handoffRecordings.progressive;
    expect(recording.timings.provisionalReadyObservedMs).toBeLessThan(recording.timings.canonicalDoneMs);
    // The ready callback scheduled navigation before done, but the actual main-document request was
    // not emitted until after done. Publishability must use the request time, not the scheduling time.
    recording.timings.navigationStartedMs = 801;
    recording.navigation.startedMs = 801;
    expect(() => validateResultsDocument(document)).toThrow(/ready\/action\/reconcile order/);
  });

  it("keeps background symbol traffic outside the graph ledger and accepts authoritative consumed aborts", () => {
    const withBackgroundSymbolIndex = completeDocument();
    const backgroundNetwork = withBackgroundSymbolIndex.prs[0]
      .variants.progressive.samples[0].networkAtAction;
    backgroundNetwork.byPath["/api/graph/symbols"] = networkPathRow({
      requests: 1,
      encodedBytes: 0,
      observedEncodedBytes: 50,
      finishedRequests: 0,
      inFlightRequests: 1,
      bytesAuthoritative: false,
      accountingComplete: false,
    });
    backgroundNetwork.observedEncodedBytes += 50;
    backgroundNetwork.requestCount += 1;
    backgroundNetwork.inFlightRequestCount += 1;
    backgroundNetwork.bytesAuthoritative = false;
    backgroundNetwork.accountingComplete = false;
    expect(() => validateResultsDocument(withBackgroundSymbolIndex)).not.toThrow();

    const withConsumedGraphAborts = completeDocument();
    const abortNetwork = withConsumedGraphAborts.prs[0]
      .variants.progressive.samples[0].networkSettled;
    const abortRow = abortNetwork.byPath["/api/graph/project"];
    abortRow.failedRequests = 2;
    abortRow.canceledRequests = 2;
    abortRow.observedEncodedBytes += 20;
    abortNetwork.failedRequestCount = 2;
    abortNetwork.canceledRequestCount = 2;
    abortNetwork.observedEncodedBytes += 20;
    abortNetwork.graphObservedEncodedBytes += 20;
    expect(() => validateResultsDocument(withConsumedGraphAborts)).not.toThrow();
  });

  it("recomputes recording hashes before publishing a standalone rerender", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pr-review-complete-report-"));
    try {
      const document = completeDocument();
      const videos = join(directory, "videos");
      await mkdir(videos);
      for (const entry of document.prs) {
        for (const [groupIndex, group] of ["recordings", "handoffRecordings"].entries()) {
          for (const variant of ["full", "progressive"]) {
            const bytes = Buffer.alloc(
              60_000,
              (entry.number + groupIndex * 7 + (variant === "full" ? 1 : 2)) % 251,
            );
            const recording = entry[group][variant];
            await writeFile(join(directory, recording.relativePath), bytes);
            recording.validation.sizeBytes = bytes.length;
            recording.validation.sha256 = createHash("sha256").update(bytes).digest("hex");
          }
        }
      }
      const results = join(directory, "results.json");
      await writeFile(results, JSON.stringify(document));
      await execFileAsync(process.execPath, [
        RENDER_SCRIPT,
        "--results", results,
        "--output", join(directory, "verified.html"),
      ]);

      const replaced = document.prs[0].handoffRecordings.progressive;
      await writeFile(join(directory, replaced.relativePath), Buffer.alloc(replaced.validation.sizeBytes, 255));
      await expect(execFileAsync(process.execPath, [
        RENDER_SCRIPT,
        "--results", results,
        "--output", join(directory, "tampered.html"),
      ])).rejects.toMatchObject({ code: 1 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 15_000);

  it("re-hashes every partial-only startup and functionality recording", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pr-review-partial-only-report-"));
    try {
      const document = partialOnlyCompleteDocument();
      await mkdir(join(directory, "videos"));
      for (const entry of document.prs) {
        for (const [groupIndex, group] of ["recordings", "startupRecordings"].entries()) {
          for (const variant of ["full", "progressive"]) {
            const recordingValue = entry[group][variant];
            const bytes = Buffer.alloc(
              60_000,
              (entry.number + groupIndex * 11 + (variant === "full" ? 3 : 5)) % 251,
            );
            await writeFile(join(directory, recordingValue.relativePath), bytes);
            recordingValue.validation.sizeBytes = bytes.length;
            recordingValue.validation.sha256 = createHash("sha256").update(bytes).digest("hex");
          }
        }
      }
      const results = join(directory, "results.json");
      await writeFile(results, JSON.stringify(document));
      await execFileAsync(process.execPath, [
        RENDER_SCRIPT,
        "--results", results,
        "--output", join(directory, "report.html"),
      ]);
      const startup = document.prs[0].startupRecordings.progressive;
      await writeFile(join(directory, startup.relativePath), Buffer.alloc(startup.validation.sizeBytes, 255));
      await expect(execFileAsync(process.execPath, [
        RENDER_SCRIPT,
        "--results", results,
        "--output", join(directory, "tampered.html"),
      ])).rejects.toMatchObject({ code: 1 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 20_000);

  it("re-renders complete partial-runtime-only evidence with only present progressive videos", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pr-review-runtime-only-report-"));
    try {
      const document = partialRuntimeOnlyCompleteDocument();
      await mkdir(join(directory, "videos"));
      for (const entry of document.prs) {
        for (const [groupIndex, group] of ["recordings", "startupRecordings"].entries()) {
          const recordingValue = entry[group].progressive;
          const bytes = Buffer.alloc(60_000, (entry.number + groupIndex * 13 + 7) % 251);
          await writeFile(join(directory, recordingValue.relativePath), bytes);
          recordingValue.validation.sizeBytes = bytes.length;
          recordingValue.validation.sha256 = createHash("sha256").update(bytes).digest("hex");
        }
      }
      const results = join(directory, "results.json");
      const report = join(directory, "report.html");
      await writeFile(results, JSON.stringify(document));
      await execFileAsync(process.execPath, [
        RENDER_SCRIPT,
        "--results", results,
        "--output", report,
      ]);
      const html = await readFile(report, "utf8");
      expect(html.match(/<video /g)).toHaveLength(4);
      expect(html).toContain("Zero-full proof");
      expect(html).not.toContain("full.webm");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 20_000);

  it("renders diagnostic and failed runs with an explicit reason and corpus denominator", () => {
    const html = renderHtmlReport({
      schemaVersion: PR_REVIEW_POC_SCHEMA_VERSION,
      status: "failed",
      generatedAt: "2026-07-31T12:00:00.000Z",
      config: { prs: [4712, 4704, 3851] },
      failure: { message: "projection cache proof was unavailable" },
      prs: [{ number: 4712, status: "complete" }],
    });
    expect(html).toContain("Not publishable");
    expect(html).toContain("1/3 configured PRs complete");
    expect(html).toContain("projection cache proof was unavailable");
    expect(html).toContain("observations are partial and not verified for publication");
    expect(html).not.toContain("verified: HEAD + merge base + graph IDs");
  });

  it("renders media relatively while refusing output collisions and destructive overwrite", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pr-review-report-"));
    try {
      const videos = join(directory, "videos");
      await mkdir(videos);
      await writeFile(join(videos, "demo.webm"), "video evidence");
      const results = join(directory, "results.json");
      await writeFile(results, JSON.stringify({
        schemaVersion: PR_REVIEW_POC_SCHEMA_VERSION,
        status: "failed",
        config: { prs: [1, 2] },
        failure: { message: "diagnostic" },
        prs: [{
          number: 1,
          status: "failed",
          recordings: { progressive: { relativePath: "videos/demo.webm" } },
        }],
      }));

      const report = join(directory, "standalone.html");
      await execFileAsync(process.execPath, [RENDER_SCRIPT, "--results", results, "--output", report]);
      expect(await readFile(report, "utf8")).toContain('src="videos/demo.webm"');

      await expect(execFileAsync(
        process.execPath,
        [RENDER_SCRIPT, "--results", results, "--output", report],
      )).rejects.toMatchObject({ code: 1 });
      await expect(execFileAsync(
        process.execPath,
        [RENDER_SCRIPT, "--results", results, "--output", results],
      )).rejects.toMatchObject({ code: 1 });
      await expect(execFileAsync(
        process.execPath,
        [RENDER_SCRIPT, "--results", results, "--output", join(videos, "demo.webm")],
      )).rejects.toMatchObject({ code: 1 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 15_000);

  it("redacts tokens from failures", () => {
    expect(redactSecrets("Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz")).not.toContain("ghp_");
    expect(redactSecrets("token=github_pat_abcdefghijklmnopqrstuvwxyz")).toContain("[REDACTED]");
  });
});

function livePull() {
  return {
    repository: "UiPath/Autopilot",
    number: 4712,
    title: "Fast graph",
    url: "https://github.example/UiPath/Autopilot/pull/4712",
    headRef: "feature/fast",
    headOid: HEAD,
    headRepository: "UiPath/Autopilot",
    baseRef: "main",
    baseOid: BASE,
    baseRepository: "UiPath/Autopilot",
    updatedAt: "2026-07-31T10:00:00.000Z",
    resolvedAt: "2026-07-31T10:01:00.000Z",
  };
}

function terminal(overrides = {}) {
  return {
    stage: "done",
    graphId: "head-graph",
    comparisonGraphId: "base-graph",
    headSha: HEAD,
    baseSha: BASE,
    mergeBaseSha: MERGE_BASE,
    counts: { nodes: 100, edges: 200 },
    changedFiles: [{ path: "src/a.ts", status: "modified" }],
    cache: "hit",
    viewUrl: "/view?id=head-graph&view=modules&prn=4712&rev=1&progressive=1",
    initialProjectionCache: initialProjectionCache(),
    preparedPair: {
      version: 1,
      prNumber: 4712,
      headGraphId: "head-graph",
      mergeBaseGraphId: "base-graph",
      headSha: HEAD,
      baseSha: BASE,
      mergeBaseSha: MERGE_BASE,
    },
    ...overrides,
  };
}

function initialProjectionCache() {
  return {
    version: 1,
    depth: 1,
    prefetchDepth: 3,
    headKey: INITIAL_HEAD_KEY,
    comparisonKey: INITIAL_COMPARISON_KEY,
    ready: true,
  };
}

function preparedTerminal(number, prepared) {
  return {
    stage: "done",
    graphId: prepared.graphId,
    comparisonGraphId: prepared.comparisonGraphId,
    headSha: prepared.headSha,
    baseSha: prepared.baseSha,
    mergeBaseSha: prepared.mergeBaseSha,
    counts: prepared.counts,
    changedFiles: prepared.changedFiles ?? [
      { path: "src/a.ts", status: "modified" },
      { path: "src/b.ts", status: "added" },
    ],
    cache: prepared.cache,
    viewUrl: prepared.viewUrl,
    initialProjectionCache: prepared.initialProjectionCache,
    preparedPair: {
      version: 1,
      prNumber: number,
      headGraphId: prepared.graphId,
      mergeBaseGraphId: prepared.comparisonGraphId,
      headSha: prepared.headSha,
      baseSha: prepared.baseSha,
      mergeBaseSha: prepared.mergeBaseSha,
    },
  };
}

function initialProjectionCacheHits(prepared) {
  return [
    [prepared.graphId, prepared.initialProjectionCache.headKey],
    [prepared.comparisonGraphId, prepared.initialProjectionCache.comparisonKey],
  ].map(([graphId, key]) => ({
    graphId,
    seedGraphId: prepared.graphId,
    requestedDepth: 1,
    prefetchDepth: 3,
    loadedDepth: null,
    method: "POST",
    path: "/api/graph/project",
    status: 200,
    cache: "hit",
    key,
    ready: true,
    responseBodyRead: false,
    source: "request-and-response-headers",
  }));
}

function networkPathRow({
  requests,
  encodedBytes,
  observedEncodedBytes = encodedBytes,
  finishedRequests = requests,
  inFlightRequests = 0,
  failedRequests = 0,
  canceledRequests = failedRequests,
  blockedRequests = 0,
  cachedRequests = 0,
  redirects = 0,
  requestIdReuses = 0,
  accountingAnomalies = 0,
  bytesAuthoritative = true,
  accountingComplete = true,
}) {
  return {
    requests,
    encodedBytes,
    observedEncodedBytes,
    finishedRequests,
    inFlightRequests,
    failedRequests,
    canceledRequests,
    blockedRequests,
    cachedRequests,
    redirects,
    requestIdReuses,
    accountingAnomalies,
    bytesAuthoritative,
    accountingComplete,
  };
}

function networkSnapshot(path, graphBytes, {
  nonGraphBytes = 0,
  graphObservedBytes = graphBytes,
  failedRequests = 0,
  canceledRequests = failedRequests,
} = {}) {
  const byPath = {
    [path]: networkPathRow({
      requests: 2,
      encodedBytes: graphBytes,
      observedEncodedBytes: graphObservedBytes,
      failedRequests,
      canceledRequests,
    }),
  };
  let requestCount = 2;
  if (nonGraphBytes > 0) {
    byPath["/assets/test.js"] = networkPathRow({ requests: 1, encodedBytes: nonGraphBytes });
    requestCount += 1;
  }
  return {
    encodedBytes: graphBytes + nonGraphBytes,
    graphEncodedBytes: graphBytes,
    observedEncodedBytes: graphObservedBytes + nonGraphBytes,
    graphObservedEncodedBytes: graphObservedBytes,
    requestCount,
    failedRequestCount: failedRequests,
    finishedRequestCount: requestCount,
    inFlightRequestCount: 0,
    inFlightGraphRequestCount: 0,
    canceledRequestCount: canceledRequests,
    blockedRequestCount: 0,
    cachedRequestCount: 0,
    redirectRequestCount: 0,
    requestIdReuseCount: 0,
    accountingAnomalyCount: 0,
    accountingAnomalies: [],
    bytesAuthoritative: true,
    graphBytesAuthoritative: true,
    accountingComplete: true,
    graphAccountingComplete: true,
    byPath,
  };
}

function sample(actionable, settled, graphBytes, rss, graphPath = "/api/graph") {
  return {
    timings: { firstActionableMs: actionable, settledMs: settled },
    networkAtAction: networkSnapshot(graphPath, graphBytes, { nonGraphBytes: 100 }),
    networkSettled: networkSnapshot(graphPath, graphBytes + 50, { nonGraphBytes: 150 }),
    memoryPeak: {
      browserJsHeapUsedBytes: graphBytes * 2.5,
      browserProcessRssBytes: rss === null ? null : rss + 1000,
    },
    memorySettled: { browserJsHeapUsedBytes: graphBytes * 2, browserProcessRssBytes: rss },
    serviceMemory: {
      peakRssBytes: 20000,
      retainedRssBytes: 10000,
      workerPeakRssBytes: 5000,
      workerRetainedRssBytes: 2000,
      sampleCount: 4,
      diagnostic: false,
    },
    domSettled: { documentNodes: 1000, canvasNodes: 50, canvasEdges: 80 },
  };
}

function completeDocument() {
  const entries = [
    completeEntry(4712, 100, 50, ["full", "progressive"]),
    completeEntry(4704, 120, 60, ["progressive", "full"]),
  ];
  return {
    schemaVersion: PR_REVIEW_POC_SCHEMA_VERSION,
    status: "complete",
    generatedAt: "2026-07-31T12:00:00.000Z",
    config: {
      repository: "UiPath/Autopilot",
      prs: [4712, 4704],
      repetitions: 2,
      viewport: { width: 1440, height: 900 },
      recordVideos: true,
      validateVideos: true,
      mode: "publishable",
      diagnosticReasons: [],
      coldEndToEnd: {
        enabled: true,
        repetitions: 1,
        isolation: "fresh-meridian-service-and-cache-per-variant",
      },
    },
    prs: entries,
    diagnostic: null,
    aggregate: aggregatePrResults(entries),
    coldAggregate: aggregateColdEndToEnd(entries),
  };
}

function completeEntry(number, fullActionable, progressiveActionable, coldOrder) {
  const prepared = {
    graphId: `head-${number}`,
    comparisonGraphId: `base-${number}`,
    headSha: HEAD,
    baseSha: BASE,
    mergeBaseSha: MERGE_BASE,
    counts: { nodes: 100, edges: 200 },
    cache: "hit",
    viewUrl: `/view?id=head-${number}&view=modules&prn=${number}&rev=1&progressive=1`,
    initialProjectionCache: initialProjectionCache(),
  };
  const fullSamples = [
    publicationSample(number, "full", fullActionable, 1000, 500, 9000, 1, coldOrder),
    publicationSample(number, "full", fullActionable - 10, 900, 450, 8500, 2, [...coldOrder].reverse()),
  ];
  const progressiveSamples = [
    publicationSample(number, "progressive", progressiveActionable, 300, 250, 5000, 1, coldOrder),
    publicationSample(number, "progressive", progressiveActionable - 5, 250, 220, 4800, 2, [...coldOrder].reverse()),
  ];
  const variants = {
    full: { samples: fullSamples, summary: summarizeVariant(fullSamples) },
    progressive: { samples: progressiveSamples, summary: summarizeVariant(progressiveSamples) },
  };
  const coldFull = coldPublicationSample(number, "full", 950, coldOrder.indexOf("full") + 1, coldOrder);
  const coldProgressive = coldPublicationSample(
    number,
    "progressive",
    880,
    coldOrder.indexOf("progressive") + 1,
    coldOrder,
  );
  return {
    number,
    title: `PR ${number}`,
    status: "complete",
    revisions: {
      prepared,
      initial: revisionSnapshot(number),
      coldInputs: {
        full: revisionSnapshot(number),
        progressive: revisionSnapshot(number),
      },
      preparationInput: revisionSnapshot(number),
      final: revisionSnapshot(number),
    },
    preparation: {
      totalMs: 10,
      httpStatus: 200,
      cache: "hit",
      events: [{ atMs: 10, payload: preparedTerminal(number, prepared) }],
    },
    variants,
    coldEndToEnd: {
      repetitions: 1,
      isolation: "fresh-meridian-service-and-cache-per-variant",
      order: coldOrder,
      variants: { full: coldFull, progressive: coldProgressive },
      parity: {
        exact: true,
        fullSceneHash: coldSceneHash(),
        progressiveSceneHash: coldSceneHash(),
        fields: { nodeIds: true, edgeIds: true, reviewFiles: true },
      },
    },
    parity: {
      exact: true,
      fullSceneHash: "same-scene-hash",
      progressiveSceneHash: "same-scene-hash",
      fields: { nodeIds: true, edgeIds: true, reviewFiles: true },
    },
    recordings: {
      full: recording(number, "full"),
      progressive: recording(number, "progressive"),
    },
    handoffRecordings: {
      full: handoffRecording(number, "full"),
      progressive: handoffRecording(number, "progressive"),
    },
  };
}

function partialOnlyCompleteDocument() {
  const document = completeDocument();
  document.config.deliveryContract = PARTIAL_ONLY_DELIVERY_CONTRACT;
  for (const entry of document.prs) {
    const canonical = {
      ...entry.revisions.prepared,
      completeness: "complete",
      viewUrl: `/view?id=head-${entry.number}&view=modules&prn=${entry.number}&rev=1`,
    };
    const oldEvents = coldPreparationEvents(entry.number, canonical, 800);
    const ready = structuredClone(oldEvents.find((event) => event.payload.stage === "ready").payload);
    const done = { ...structuredClone(ready), stage: "done" };
    const events = [
      { atMs: 400, payload: ready },
      { atMs: 401, payload: done },
    ];
    const terminalProof = validatePartialPreparationStream(
      { number: entry.number, headOid: HEAD },
      events,
    );
    const {
      viewUrl: _analyzeViewUrl,
      preparedPair: _analyzePreparedPair,
      ...analyzeDone
    } = done;
    terminalProof.repositoryAnalysisWorkerPidsAfterTerminal = [];
    const partial = terminalProof.prepared;
    entry.revisions.prepared = partial;
    entry.revisions.canonicalBaseline = canonical;
    entry.preparation = {
      totalMs: 401,
      httpStatus: 200,
      cache: "miss",
      events,
      terminalProof,
      canonicalBaseline: { purpose: "measurement-baseline-only" },
    };

    for (const [variant, variantResult] of Object.entries(entry.variants)) {
      const expected = variant === "progressive" ? partial : canonical;
      for (const sample of variantResult.samples) {
        Object.assign(sample.exactRevision, {
          graphId: expected.graphId,
          comparisonGraphId: expected.comparisonGraphId,
          preparedBaseSha: expected.baseSha,
        });
        sample.analyzeTerminals = [variant === "progressive" ? analyzeDone : {
          stage: "done",
          graphId: canonical.graphId,
          comparisonGraphId: canonical.comparisonGraphId,
          headSha: canonical.headSha,
          baseSha: canonical.baseSha,
          mergeBaseSha: canonical.mergeBaseSha,
        }];
        sample.performanceMarks = [];
        if (variant === "progressive") {
          sample.projections = [
            { graphId: partial.graphId, rootsKind: "changed-files", seedGraphId: partial.graphId },
            { graphId: partial.comparisonGraphId, rootsKind: "changed-files", seedGraphId: partial.graphId },
          ];
          sample.initialProjectionCacheHits = initialProjectionCacheHits(partial);
          const cacheEvidence = causalWarmEvidence(partial);
          sample.cacheEvidence = {
            ...cacheEvidence,
            cacheReadiness: deriveCausalWarmReadinessEvidence(cacheEvidence, partial),
          };
          sample.cacheReadiness = sample.cacheEvidence.cacheReadiness;
        }
        sample.partialOnlyContinuation = variant === "progressive" ? {
          version: 2,
          delivery: PARTIAL_ONLY_DELIVERY_CONTRACT,
          pairId: partial.pairId,
          streamEnded: true,
          readyDoneSamePair: true,
          postTerminalDwellMs: 300,
          canonicalGraphRequests: 0,
          canonicalGraphResponses: 0,
          canonicalReconciliationMarks: 0,
          repositoryAnalysisWorkerPidsAfterTerminal: [],
          boundedPartialWorkerPidsAtDwellStart: [],
          graphProjectWorkerPidsAtDwellStart: [],
          boundedPartialWorkerPidsDuringDwell: [],
          graphProjectWorkerPidsDuringDwell: [],
          newBoundedPartialWorkerPidsDuringDwell: [],
          newGraphProjectWorkerPidsDuringDwell: [],
          processObservation: {
            scope: "same-dwell-start-and-sampled-union",
            sampleIntervalMs: 50,
            sampleCount: 3,
          },
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
          routeCounterScope: "same-dwell-request-delta",
          allowedBackgroundWork: "syntax-symbol-topology-index-and-explicit-bounded-partial-expansion-only",
        } : null;
      }
      variantResult.summary = summarizeVariant(variantResult.samples);
    }

    for (const variant of ["full", "progressive"]) {
      const expected = variant === "progressive" ? partial : canonical;
      const recordingValue = entry.recordings[variant];
      Object.assign(recordingValue.exactRevision, {
        graphId: expected.graphId,
        comparisonGraphId: expected.comparisonGraphId,
        preparedBaseSha: expected.baseSha,
      });
      if (variant === "progressive") {
        const background = recordingValue.interaction.backgroundSymbolIndex;
        background.graphId = partial.graphId;
        background.rendererTransport.graphId = partial.graphId;
        background.harnessFetch.graphId = partial.graphId;
      }
    }
    const continuationProof = {
      version: 2,
      delivery: PARTIAL_ONLY_DELIVERY_CONTRACT,
      pairId: partial.pairId,
      streamEnded: true,
      readyDoneSamePair: true,
      postTerminalDwellMs: 300,
      canonicalGraphRequests: 0,
      canonicalGraphResponses: 0,
      canonicalReconciliationMarks: 0,
      repositoryAnalysisWorkerPidsAfterTerminal: [],
      boundedPartialWorkerPidsAtDwellStart: [],
      graphProjectWorkerPidsAtDwellStart: [],
      boundedPartialWorkerPidsDuringDwell: [],
      graphProjectWorkerPidsDuringDwell: [],
      newBoundedPartialWorkerPidsDuringDwell: [],
      newGraphProjectWorkerPidsDuringDwell: [],
      processObservation: {
        scope: "same-dwell-start-and-sampled-union",
        sampleIntervalMs: 50,
        sampleCount: 3,
      },
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
      routeCounterScope: "same-dwell-request-delta",
      allowedBackgroundWork: "syntax-symbol-topology-index-and-explicit-bounded-partial-expansion-only",
    };
    entry.startupRecordings = {
      full: {
        ...structuredClone(entry.handoffRecordings.full),
        relativePath: `videos/autopilot-pr-${entry.number}-full-cold-startup.webm`,
        flow: "canonical-baseline-done-then-navigation",
        exactRevision: {
          ...entry.handoffRecordings.full.exactRevision,
          graphId: canonical.graphId,
          comparisonGraphId: canonical.comparisonGraphId,
          preparedBaseSha: canonical.baseSha,
        },
        navigation: {
          source: "playwright-main-document-request",
          viewUrl: canonical.viewUrl,
          startedMs: 850,
        },
        terminalProof,
        continuationProof: null,
        timings: {
          provisionalReadyObservedMs: 400,
          partialTerminalDoneMs: 401,
          canonicalBaselineDoneMs: 800,
          navigationStartedMs: 850,
          firstActionableBrowserMs: 500,
          canonicalReconciledBrowserMs: null,
        },
        canonicalBaselinePreparation: {
          progressive: false,
          httpStatus: 200,
          terminal: {
            stage: "done",
            graphId: canonical.graphId,
            comparisonGraphId: canonical.comparisonGraphId,
            headSha: canonical.headSha,
            baseSha: canonical.baseSha,
            mergeBaseSha: canonical.mergeBaseSha,
          },
        },
      },
      progressive: {
        ...structuredClone(entry.handoffRecordings.progressive),
        relativePath: `videos/autopilot-pr-${entry.number}-progressive-cold-startup.webm`,
        flow: "partial-ready-terminal-then-navigation",
        exactRevision: {
          ...entry.handoffRecordings.progressive.exactRevision,
          graphId: partial.graphId,
          comparisonGraphId: partial.comparisonGraphId,
          preparedBaseSha: partial.baseSha,
        },
        navigation: {
          source: "playwright-main-document-request",
          viewUrl: partial.viewUrl,
          startedMs: 450,
        },
        terminalProof,
        continuationProof,
        timings: {
          provisionalReadyObservedMs: 400,
          partialTerminalDoneMs: 401,
          canonicalBaselineDoneMs: null,
          navigationStartedMs: 450,
          firstActionableBrowserMs: 500,
          canonicalReconciledBrowserMs: null,
        },
      },
    };
    delete entry.handoffRecordings;

    for (const variant of ["full", "progressive"]) {
      const expected = variant === "progressive" ? partial : canonical;
      const cold = entry.coldEndToEnd.variants[variant];
      Object.assign(cold.exactRevision, {
        graphId: expected.graphId,
        comparisonGraphId: expected.comparisonGraphId,
        preparedBaseSha: expected.baseSha,
      });
      cold.partialOnlyContinuation = variant === "progressive" ? continuationProof : null;
      if (variant === "progressive") {
        cold.projections = [
          { graphId: partial.graphId, rootsKind: "changed-files", seedGraphId: partial.graphId },
          { graphId: partial.comparisonGraphId, rootsKind: "changed-files", seedGraphId: partial.graphId },
        ];
        cold.initialProjectionCacheHits = initialProjectionCacheHits(partial);
      } else {
        cold.graphs = [
          { graphId: canonical.graphId, method: "GET", status: 200 },
          { graphId: canonical.comparisonGraphId, method: "GET", status: 200 },
        ];
      }
      if (variant === "progressive") {
        cold.preparation.terminalProof = terminalProof;
        cold.canonicalBaselinePreparation = null;
      } else {
        cold.canonicalBaselinePreparation = {
          progressive: false,
          httpStatus: 200,
          totalMs: 800,
          terminal: {
            stage: "done",
            graphId: canonical.graphId,
            comparisonGraphId: canonical.comparisonGraphId,
            headSha: canonical.headSha,
            baseSha: canonical.baseSha,
            mergeBaseSha: canonical.mergeBaseSha,
          },
        };
      }
    }
    entry.comparison = comparisonFromPartialOnlyEvidence(
      entry.variants.full.summary,
      entry.variants.progressive.summary,
      entry.coldEndToEnd.variants.full,
      entry.coldEndToEnd.variants.progressive,
    );
  }
  document.aggregate = aggregatePartialOnlyResults(document.prs);
  document.coldAggregate = aggregateColdEndToEnd(document.prs);
  return document;
}

function partialRuntimeOnlyCompleteDocument() {
  const document = partialOnlyCompleteDocument();
  document.config = {
    ...document.config,
    baseUrl: "http://127.0.0.1:4189",
    deliveryContract: PARTIAL_RUNTIME_ONLY_DELIVERY_CONTRACT,
    coldEndToEnd: {
      enabled: true,
      repetitions: 1,
      isolation: "fresh-production-service-and-cache-per-progressive-lane",
    },
    fullBaselineCapability: fullBaselineCapabilityProof("listener-process-command", {
      listenerPid: 41_890,
    }),
  };
  document.environment = {
    meridianServicePid: 41_890,
    meridianServiceDiscovery: "local-listener",
    meridianCommit: "f".repeat(40),
    worktreeDirty: true,
    node: process.version,
  };
  for (const [entryIndex, entry] of document.prs.entries()) {
    const partial = entry.revisions.prepared;
    delete entry.revisions.canonicalBaseline;
    entry.revisions.coldInputs = {
      progressive: entry.revisions.coldInputs.progressive,
    };
    delete entry.preparation.canonicalBaseline;
    delete entry.parity;
    delete entry.comparison;

    entry.variants = { progressive: entry.variants.progressive };
    for (const [index, sample] of entry.variants.progressive.samples.entries()) {
      sample.measurementOrder = { sequencePosition: 1, variants: ["progressive"] };
      sample.analyzeRequests = [partialAnalyzeRequest()];
      sample.partialOnlyContinuation.delivery = PARTIAL_RUNTIME_ONLY_DELIVERY_CONTRACT;
      delete sample.canonicalBaselinePreparation;
      delete sample.reconciliation;
      sample.iteration = index + 1;
    }
    entry.variants.progressive.summary = summarizeVariant(entry.variants.progressive.samples);

    const functionality = entry.recordings.progressive;
    functionality.analyzeRequests = [partialAnalyzeRequest()];
    functionality.partialRuntimeTransport = {
      canonicalGraphRequests: 0,
      canonicalGraphResponses: 0,
      fullGenerationRequests: 0,
      canonicalReconciliationMarks: 0,
      partialProjectionRequests: 4,
      partialWarmRequests: 2,
      sourceIndexRequests: 1,
      graphAccountingComplete: true,
    };
    entry.recordings = { progressive: functionality };

    const startup = entry.startupRecordings.progressive;
    startup.terminalProof = structuredClone(startup.terminalProof);
    startup.continuationProof = structuredClone(startup.continuationProof);
    startup.flow = "partial-ready-navigation-with-independent-terminal-drain";
    startup.navigation.startedMs = 401;
    startup.timings.navigationStartedMs = 401;
    startup.timings.partialTerminalDoneMs = 399;
    startup.analyzeRequests = [partialAnalyzeRequest()];
    startup.continuationProof.delivery = PARTIAL_RUNTIME_ONLY_DELIVERY_CONTRACT;
    startup.handoff = validatePreparationHandoff(
      { number: entry.number, headOid: HEAD },
      entry.preparation.events.at(-2).payload,
      entry.preparation.events.at(-1).payload,
    );
    delete startup.canonicalBaselinePreparation;
    delete startup.timings.canonicalBaselineDoneMs;
    delete startup.timings.canonicalReconciledBrowserMs;
    startup.isolation = isolatedRuntimeOnlyProof(
      entry.number,
      entryIndex * 4 + 3,
      entryIndex * 4 + 4,
    );
    entry.startupRecordings = { progressive: startup };

    const cold = entry.coldEndToEnd.variants.progressive;
    cold.measurementOrder = { sequencePosition: 1, variants: ["progressive"] };
    cold.analyzeRequests = [partialAnalyzeRequest()];
    cold.partialOnlyContinuation.delivery = PARTIAL_RUNTIME_ONLY_DELIVERY_CONTRACT;
    cold.isolation.fullBaselineCapability = fullBaselineCapabilityProof(
      "isolated-service-spawn-arguments",
    );
    delete cold.canonicalBaselinePreparation;
    delete cold.reconciliation;
    delete cold.timings.canonicalReconciledMs;
    const coldEvents = partialRuntimeOnlyColdPreparationEvents(entry.number, partial);
    const coldStream = validatePartialPreparationStream(
      { number: entry.number, headOid: HEAD },
      coldEvents,
    );
    const coldPrepared = coldStream.prepared;
    Object.assign(coldStream, { readyIndex: 40, doneIndex: 41, eventCount: 42 });
    coldStream.repositoryAnalysisWorkerPidsAfterTerminal = [];
    cold.prepared = structuredClone(coldPrepared);
    cold.provisionalPrepared = structuredClone(coldPrepared);
    cold.exactRevision = {
      graphId: coldPrepared.graphId,
      comparisonGraphId: coldPrepared.comparisonGraphId,
      headSha: coldPrepared.headSha,
      baseSha: coldPrepared.baseSha,
      mergeBaseSha: coldPrepared.mergeBaseSha,
      preparedBaseSha: coldPrepared.baseSha,
      baseTipDrift: false,
    };
    cold.preparation.events = coldEvents;
    cold.preparation.eventCount = coldStream.eventCount;
    cold.preparation.totalMs = coldEvents.at(-1).atMs + 0.1;
    cold.preparation.httpStatus = 200;
    cold.preparation.cache = "miss";
    cold.preparation.milestones = deriveColdPreparationMilestones(coldEvents, coldPrepared);
    cold.preparation.handoff = validatePreparationHandoff(
      { number: entry.number, headOid: HEAD },
      coldEvents.at(-2).payload,
      coldEvents.at(-1).payload,
    );
    cold.preparation.terminalProof = coldStream;
    cold.preparation.completionSubscriber = "complete-ndjson-drain-to-partial-eof";
    cold.projections = [
      { graphId: coldPrepared.graphId, rootsKind: "changed-files", seedGraphId: coldPrepared.graphId },
      { graphId: coldPrepared.comparisonGraphId, rootsKind: "changed-files", seedGraphId: coldPrepared.graphId },
    ];
    cold.initialProjectionCacheHits = initialProjectionCacheHits(coldPrepared);
    const {
      viewUrl: _coldViewUrl,
      preparedPair: _coldPreparedPair,
      ...coldAnalyzeTerminal
    } = coldEvents.at(-1).payload;
    cold.analyzeTerminals = [{ ...coldAnalyzeTerminal, cache: "hit" }];
    cold.partialOnlyContinuation = {
      ...structuredClone(cold.partialOnlyContinuation),
      pairId: coldPrepared.pairId,
    };
    cold.landingShell.terminal = {
      graphId: coldPrepared.graphId,
      comparisonGraphId: coldPrepared.comparisonGraphId,
      headSha: coldPrepared.headSha,
      baseSha: coldPrepared.baseSha,
      mergeBaseSha: coldPrepared.mergeBaseSha,
      pairId: coldPrepared.pairId,
      completeness: "provisional",
      cache: "miss",
      viewUrl: coldPrepared.viewUrl,
      initialProjectionCache: coldPrepared.initialProjectionCache,
    };
    cold.landingShell.renderedManifestSha256 = cold.preparation.milestones.manifestSha256;
    entry.coldEndToEnd = {
      repetitions: 1,
      isolation: "fresh-production-service-and-cache-per-progressive-lane",
      order: ["progressive"],
      variants: { progressive: cold },
    };
  }
  document.aggregate = aggregatePartialRuntimeOnlyResults(document.prs);
  document.coldAggregate = aggregatePartialRuntimeOnlyColdResults(document.prs);
  return document;
}

function partialAnalyzeRequest() {
  return {
    method: "POST",
    progressiveFalse: false,
    fullBaselineCapabilityHeaderPresent: false,
  };
}

function partialRuntimeOnlyColdPreparationEvents(number, mainPrepared) {
  const source = coldPreparationEvents(number, mainPrepared, 410);
  const ready = structuredClone(source.find((event) => event.payload.stage === "ready"));
  const pairId = `c${number.toString(16).padStart(19, "0")}`;
  const graphId = `pr-partial-${pairId}-${mainPrepared.headSha}`;
  const comparisonGraphId = `pr-partial-base-${pairId}-${mainPrepared.mergeBaseSha}`;
  const viewUrl = `/view?${new URLSearchParams({
    id: graphId,
    view: "modules",
    prn: String(number),
    rev: "1",
    progressive: "1",
    partial: "1",
    pair: pairId,
  }).toString()}`;
  Object.assign(ready.payload, {
    pairId,
    graphId,
    comparisonGraphId,
    viewUrl,
    initialProjectionCache: {
      ...ready.payload.initialProjectionCache,
      headKey: "5".repeat(64),
      comparisonKey: "6".repeat(64),
    },
  });
  Object.assign(ready.payload.preparedPair, {
    pairId,
    headGraphId: graphId,
    mergeBaseGraphId: comparisonGraphId,
  });
  const headComplete = structuredClone(source.find((event) =>
    event.payload.stage === "lane-complete" && event.payload.lane === "head"));
  headComplete.atMs = 390;
  return [
    ...structuredClone(source.slice(0, 7)),
    headComplete,
    ready,
    { atMs: 401, payload: { ...structuredClone(ready.payload), stage: "done" } },
  ];
}

function driftRuntimeOnlyColdBaseSha(cold, baseSha) {
  cold.prepared.baseSha = baseSha;
  cold.provisionalPrepared.baseSha = baseSha;
  cold.exactRevision.baseSha = baseSha;
  cold.exactRevision.preparedBaseSha = baseSha;
  for (const event of cold.preparation.events) {
    if (["manifest-ready", "ready", "done"].includes(event.payload.stage)) {
      event.payload.baseSha = baseSha;
    }
    if (event.payload.preparedPair) event.payload.preparedPair.baseSha = baseSha;
  }
  cold.preparation.terminalProof.prepared.baseSha = baseSha;
  cold.preparation.handoff.partial.baseSha = baseSha;
  cold.analyzeTerminals[0].baseSha = baseSha;
  cold.landingShell.baseSha = baseSha;
  cold.landingShell.performanceEntry.detail.baseSha = baseSha;
  cold.landingShell.terminal.baseSha = baseSha;
}

function driftRuntimeOnlyColdMergeBaseSha(cold, mergeBaseSha) {
  const oldComparisonGraphId = cold.prepared.comparisonGraphId;
  const comparisonGraphId = `pr-partial-base-${cold.prepared.pairId}-${mergeBaseSha}`;
  for (const prepared of [cold.prepared, cold.provisionalPrepared]) {
    prepared.mergeBaseSha = mergeBaseSha;
    prepared.comparisonGraphId = comparisonGraphId;
  }
  cold.exactRevision.mergeBaseSha = mergeBaseSha;
  cold.exactRevision.comparisonGraphId = comparisonGraphId;
  for (const event of cold.preparation.events) {
    if (["manifest-ready", "ready", "done"].includes(event.payload.stage)) {
      event.payload.mergeBaseSha = mergeBaseSha;
    }
    if (["ready", "done"].includes(event.payload.stage)) {
      event.payload.comparisonGraphId = comparisonGraphId;
    }
    if (event.payload.preparedPair) {
      event.payload.preparedPair.mergeBaseSha = mergeBaseSha;
      event.payload.preparedPair.mergeBaseGraphId = comparisonGraphId;
    }
  }
  Object.assign(cold.preparation.terminalProof, { comparisonGraphId });
  Object.assign(cold.preparation.terminalProof.prepared, {
    comparisonGraphId,
    mergeBaseSha,
  });
  Object.assign(cold.preparation.handoff.partial, {
    comparisonGraphId,
    mergeBaseSha,
  });
  cold.preparation.milestones = deriveColdPreparationMilestones(
    cold.preparation.events,
    cold.prepared,
  );
  for (const projection of cold.projections) {
    if (projection.graphId === oldComparisonGraphId) projection.graphId = comparisonGraphId;
  }
  for (const hit of cold.initialProjectionCacheHits) {
    if (hit.graphId === oldComparisonGraphId) hit.graphId = comparisonGraphId;
  }
  Object.assign(cold.analyzeTerminals[0], { comparisonGraphId, mergeBaseSha });
  cold.landingShell.mergeBaseSha = mergeBaseSha;
  cold.landingShell.performanceEntry.detail.mergeBaseSha = mergeBaseSha;
  Object.assign(cold.landingShell.terminal, { comparisonGraphId, mergeBaseSha });
}

function rebindRuntimeOnlyStartupPair(startup, prNumber, pairId) {
  const prepared = startup.terminalProof.prepared;
  const graphId = `pr-partial-${pairId}-${prepared.headSha}`;
  const comparisonGraphId = `pr-partial-base-${pairId}-${prepared.mergeBaseSha}`;
  const viewUrl = `/view?${new URLSearchParams({
    id: graphId,
    view: "modules",
    prn: String(prNumber),
    rev: "1",
    progressive: "1",
    partial: "1",
    pair: pairId,
  }).toString()}`;

  Object.assign(startup.exactRevision, { graphId, comparisonGraphId });
  Object.assign(startup.terminalProof, { pairId, graphId, comparisonGraphId });
  Object.assign(prepared, {
    pairId,
    graphId,
    comparisonGraphId,
    viewUrl,
    initialProjectionCache: {
      ...prepared.initialProjectionCache,
      headKey: "c".repeat(64),
      comparisonKey: "d".repeat(64),
    },
  });
  Object.assign(startup.handoff, { pairId });
  Object.assign(startup.handoff.partial, { graphId, comparisonGraphId });
  startup.continuationProof.pairId = pairId;
  startup.navigation.viewUrl = viewUrl;
}

function fullBaselineCapabilityProof(source, extra = {}) {
  return {
    inspected: true,
    present: false,
    source,
    argument: "--benchmark-pr-full-baseline",
    commandSha256: "9".repeat(64),
    ...extra,
  };
}

function isolatedRuntimeOnlyProof(number, serviceSalt, cacheSalt) {
  const servicePid = number * 10 + serviceSalt;
  return {
    freshCache: true,
    loopbackOnly: true,
    servicePid,
    serviceInstanceId: opaqueEvidenceId(number, "progressive", serviceSalt),
    cacheInstanceId: opaqueEvidenceId(number, "progressive", cacheSalt),
    fullBaselineCapability: fullBaselineCapabilityProof("isolated-service-spawn-arguments"),
    cleanup: {
      strategy: "tracked-owned-process-tree-and-groups",
      rootPid: servicePid,
      rootProcessGroupId: servicePid,
      scanIntervalMs: 100,
      registryProofHealthy: true,
      registeredProcessCount: 3,
      registeredGroupCount: 2,
      registeredGroupIds: [servicePid, servicePid + 100_000],
      detachedGroupCount: 1,
      sigstopGroupCount: 2,
      sigtermGroupCount: 2,
      sigkillGroupCount: 0,
      verifiedRecordedPidsAbsent: true,
      verifiedRecordedGroupsAbsent: true,
      verifiedEmpty: true,
      residualPids: [],
      residualGroupIds: [],
      tempDirectoryRemoved: true,
    },
  };
}

function revisionSnapshot(number, baseOid = BASE) {
  return {
    repository: "UiPath/Autopilot",
    number,
    title: `PR ${number}`,
    url: `https://github.example/UiPath/Autopilot/pull/${number}`,
    headRef: `feature/pr-${number}`,
    headOid: HEAD,
    headRepository: "UiPath/Autopilot",
    baseRef: "main",
    baseOid,
    pullBaseOid: baseOid,
    baseRepository: "UiPath/Autopilot",
    updatedAt: "2026-07-31T10:00:00.000Z",
    resolvedAt: "2026-07-31T10:01:00.000Z",
  };
}

function coldPublicationSample(number, variant, endToEndActionable, sequencePosition, order) {
  const graphId = `cold-${variant}-head-${number}`;
  const comparisonGraphId = `cold-${variant}-base-${number}`;
  const prepared = {
    graphId,
    comparisonGraphId,
    headSha: HEAD,
    baseSha: BASE,
    mergeBaseSha: MERGE_BASE,
    counts: { nodes: 100, edges: 200 },
    cache: "miss",
    viewUrl: `/view?id=${graphId}&view=modules&prn=${number}&rev=1&progressive=1`,
    initialProjectionCache: initialProjectionCache(),
  };
  const finalPairReadyMs = variant === "full" ? 800 : 780;
  const navigationStartedMs = variant === "full" ? 850 : 450;
  const browserFirstActionableMs = endToEndActionable - navigationStartedMs;
  const browserSettledMs = browserFirstActionableMs + 250;
  const events = coldPreparationEvents(number, prepared, finalPairReadyMs);
  const readyPayload = events.find((event) => event.payload.stage === "ready").payload;
  const provisionalPrepared = validateProvisionalReady(
    { number, headOid: HEAD },
    readyPayload,
  );
  const handoff = validatePreparationHandoff(
    { number, headOid: HEAD },
    readyPayload,
    events.at(-1).payload,
  );
  const reconciliationMark = {
    name: "meridian:pr-canonical-graph-reconciled",
    startTimeMs: browserFirstActionableMs + 100,
    detail: { graphId },
  };
  const reconciliation = variant === "progressive"
    ? validateCanonicalReconciliation(
        provisionalPrepared,
        prepared,
        [events.at(-1).payload],
        [reconciliationMark],
      )
    : null;
  const scene = {
    nodeIds: ["node:a", "node:b"],
    edgeIds: ["edge:a-b"],
    reviewFiles: ["src/a.ts", "src/b.ts"],
  };
  const landingClock = publicationLandingClock();
  return {
    variant,
    repetition: 1,
    measurementOrder: { sequencePosition, variants: order },
    measuredAt: "2026-07-31T12:00:00.000Z",
    isolation: {
      freshCache: true,
      loopbackOnly: true,
      servicePid: number * 10 + (variant === "full" ? 1 : 2),
      serviceInstanceId: opaqueEvidenceId(number, variant, 1),
      cacheInstanceId: opaqueEvidenceId(number, variant, 2),
      cleanup: {
        strategy: "tracked-owned-process-tree-and-groups",
        rootPid: number * 10 + (variant === "full" ? 1 : 2),
        rootProcessGroupId: number * 10 + (variant === "full" ? 1 : 2),
        scanIntervalMs: 100,
        registryProofHealthy: true,
        leaderExitedBeforeStop: false,
        registeredProcessCount: 3,
        registeredGroupCount: 2,
        detachedGroupCount: 1,
        registeredGroupIds: [
          number * 10 + (variant === "full" ? 1 : 2),
          number * 10 + (variant === "full" ? 101 : 102),
        ],
        sigstopGroupCount: 2,
        sigtermGroupCount: 2,
        sigkillGroupCount: 0,
        verifiedRecordedPidsAbsent: true,
        verifiedRecordedGroupsAbsent: true,
        verifiedEmpty: true,
        residualPids: [],
        residualGroupIds: [],
        tempDirectoryRemoved: true,
      },
    },
    prepared,
    provisionalPrepared,
    preparation: {
      totalMs: finalPairReadyMs + 0.1,
      httpStatus: 200,
      cache: "miss",
      milestones: deriveColdPreparationMilestones(events, prepared),
      eventCount: events.length,
      events,
      handoff,
      completionSubscriber: "independent-ndjson-drain",
    },
    timings: {
      landingShellActionableMs: 321,
      landingShellTtaMs: 320,
      provisionalReadyMs: 400,
      provisionalReadyTtaMs: 500,
      navigationStartedMs,
      browserFirstActionableMs,
      browserSettledMs,
      prepareToFirstActionableMs: endToEndActionable,
      prepareToSettledMs: navigationStartedMs + browserSettledMs,
      endToEndFirstActionableMs: endToEndActionable,
      endToEndSettledMs: navigationStartedMs + browserSettledMs,
      canonicalReconciledMs: reconciliation?.mark?.startTimeMs ?? null,
    },
    landingShell: {
      source: "application-performance-mark-and-visible-dom",
      markName: "meridian:pr-manifest-shell-actionable",
      requestStartedMs: 1,
      actionableMs: 321,
      ttaMs: 320,
      readyAtBrowserMs: 1_401,
      readyTtaMs: 500,
      clockAlignment: landingClock.clockAlignment,
      performanceEntry: {
        name: "meridian:pr-manifest-shell-actionable",
        startTimeMs: 1_221,
        detail: {
          atMs: 1_221,
          requestStartedAtMs: 901,
          ttaMs: 320,
          changedFileCount: 2,
          headSha: HEAD,
          baseSha: BASE,
          mergeBaseSha: MERGE_BASE,
        },
      },
      visible: true,
      changedFileCount: 2,
      visibleChangedFileRows: 2,
      renderedManifestSha256: deriveColdPreparationMilestones(events, prepared).manifestSha256,
      headSha: HEAD,
      baseSha: BASE,
      mergeBaseSha: MERGE_BASE,
      terminal: {
        graphId: provisionalPrepared.graphId,
        comparisonGraphId: provisionalPrepared.comparisonGraphId,
        headSha: HEAD,
        baseSha: BASE,
        mergeBaseSha: MERGE_BASE,
        pairId: provisionalPrepared.pairId,
        completeness: "provisional",
        cache: "miss",
        viewUrl: provisionalPrepared.viewUrl,
        initialProjectionCache: provisionalPrepared.initialProjectionCache,
      },
      rows: [
        {
          status: "modified",
          label: "src/a.ts",
          sourceHref: `https://github.com/UiPath/Autopilot/blob/${HEAD}/src/a.ts`,
        },
        {
          status: "added",
          label: "src/b.ts",
          sourceHref: `https://github.com/UiPath/Autopilot/blob/${HEAD}/src/b.ts`,
        },
      ],
    },
    firstActionableMark: {
      name: "meridian:first-actionable-canvas",
      startTimeMs: browserFirstActionableMs,
      source: "performance-mark",
    },
    networkAtAction: networkSnapshot(
      variant === "full" ? "/api/graph" : "/api/graph/project",
      variant === "full" ? 500 : 200,
    ),
    networkSettled: networkSnapshot(
      variant === "full" ? "/api/graph" : "/api/graph/project",
      variant === "full" ? 550 : 250,
    ),
    memoryPeak: {
      browserJsHeapUsedBytes: variant === "full" ? 20_000 : 12_000,
      browserProcessRssBytes: variant === "full" ? 40_000 : 30_000,
    },
    memorySettled: {
      browserJsHeapUsedBytes: variant === "full" ? 18_000 : 10_000,
      browserProcessRssBytes: variant === "full" ? 36_000 : 27_000,
    },
    coldServiceMemory: {
      peakRssBytes: variant === "full" ? 80_000 : 75_000,
      retainedRssBytes: variant === "full" ? 40_000 : 38_000,
      workerPeakRssBytes: variant === "full" ? 90_000 : 85_000,
      workerRetainedRssBytes: 0,
      sampleCount: 8,
      intervalMs: 500,
      preparationAndEndToEndSampleCount: 5,
      browserPhaseSampleCount: 3,
      browserPhaseIntervalMs: 100,
      workerScope: "all-owned-analysis-and-projection-descendants",
      browserPhaseWorkerScope: "owned-projection-workers",
      peakAggregation: "max-of-500ms-lifecycle-and-100ms-review-browser-phase",
      retainedSource: "500ms-lifecycle-final-snapshot-after-review-settled",
      lifecyclePeakRssBytes: variant === "full" ? 78_000 : 73_000,
      lifecycleWorkerPeakRssBytes: variant === "full" ? 88_000 : 83_000,
      browserPhasePeakRssBytes: variant === "full" ? 80_000 : 75_000,
      browserPhaseWorkerPeakRssBytes: variant === "full" ? 90_000 : 85_000,
      diagnostic: false,
    },
    sceneAtAction: scene,
    sceneSettled: scene,
    exactRevision: {
      graphId,
      comparisonGraphId,
      headSha: HEAD,
      baseSha: BASE,
      mergeBaseSha: MERGE_BASE,
      preparedBaseSha: BASE,
      baseTipDrift: false,
    },
    reconciliation,
    graphs: variant === "full"
      ? [
        { graphId, method: "GET", status: 200 },
        { graphId: comparisonGraphId, method: "GET", status: 200 },
      ]
      : [],
    projections: variant === "progressive"
      ? [{ graphId }, { graphId: comparisonGraphId }]
      : [],
    initialProjectionCacheHits: variant === "progressive"
      ? [...initialProjectionCacheHits(provisionalPrepared), ...initialProjectionCacheHits(prepared)]
      : [],
  };
}

function publicationLandingClock() {
  return alignLandingManifestClock(
    { requestStartedAtMs: 901, atMs: 1_221, ttaMs: 320 },
    {
      beforeSamples: clockSamples({ startNodeMs: 900, offsetMs: 100 }),
      afterSamples: clockSamples({ startNodeMs: 1_322, offsetMs: 100 }),
      nodeColdStartedMs: 1_000,
      requestBracket: {
        nodeBeforeMs: 1_000.9,
        nodeAfterMs: 1_001.1,
        browserRequestStartedAtMs: 901,
        browserSampleAtMs: 901.05,
      },
    },
  );
}

function clockSamples({
  startNodeMs,
  offsetMs,
  roundTrips = [2, 1, 1, 1.5, 2, 1.25, 1.75, 2.25, 1.4],
  spacingMs = 4,
}) {
  return roundTrips.map((roundTripMs, index) => {
    const nodeBeforeMs = startNodeMs + index * spacingMs;
    const nodeAfterMs = nodeBeforeMs + roundTripMs;
    return {
      nodeBeforeMs,
      nodeAfterMs,
      browserAtMs: ((nodeBeforeMs + nodeAfterMs) / 2) - offsetMs,
    };
  });
}

function coldPreparationEvents(number, prepared, finalPairReadyMs) {
  const changedFiles = [
    { path: "src/a.ts", status: "modified" },
    { path: "src/b.ts", status: "added" },
  ];
  const pairId = number.toString(16).padStart(20, "0");
  const provisional = {
    graphId: `pr-partial-${pairId}-${prepared.headSha}`,
    comparisonGraphId: `pr-partial-base-${pairId}-${prepared.mergeBaseSha}`,
    initialProjectionCache: {
      ...initialProjectionCache(),
      headKey: "1".repeat(64),
      comparisonKey: "2".repeat(64),
    },
  };
  return [
    { atMs: 0, payload: { stage: "clone" } },
    { atMs: 10, payload: { stage: "checkout" } },
    { atMs: 20, payload: { stage: "extract" } },
    { atMs: 30, payload: { stage: "extract-merge-base", progress: { phase: "project-load" } } },
    { atMs: 300, payload: { stage: "lane-complete", lane: "mergeBase" } },
    { atMs: 310, payload: { stage: "extract-head", progress: { phase: "project-load" } } },
    { atMs: 320, payload: {
      stage: "manifest-ready",
      headSha: prepared.headSha,
      baseSha: prepared.baseSha,
      mergeBaseSha: prepared.mergeBaseSha,
      changedFiles,
    } },
    { atMs: 400, payload: {
      stage: "ready",
      pairId,
      completeness: "provisional",
      graphId: provisional.graphId,
      comparisonGraphId: provisional.comparisonGraphId,
      headSha: prepared.headSha,
      baseSha: prepared.baseSha,
      mergeBaseSha: prepared.mergeBaseSha,
      counts: { nodes: 20, edges: 30 },
      changedFiles,
      cache: "miss",
      viewUrl: `/view?id=${provisional.graphId}&view=modules&prn=${number}&rev=1&progressive=1&partial=1&pair=${pairId}`,
      initialProjectionCache: provisional.initialProjectionCache,
      preparedPair: {
        version: 1,
        prNumber: number,
        headGraphId: provisional.graphId,
        mergeBaseGraphId: provisional.comparisonGraphId,
        headSha: prepared.headSha,
        baseSha: prepared.baseSha,
        mergeBaseSha: prepared.mergeBaseSha,
        completeness: "provisional",
        pairId,
      },
    } },
    { atMs: finalPairReadyMs - 10, payload: { stage: "lane-complete", lane: "head" } },
    { atMs: finalPairReadyMs, payload: {
      stage: "done",
      graphId: prepared.graphId,
      comparisonGraphId: prepared.comparisonGraphId,
      headSha: prepared.headSha,
      baseSha: prepared.baseSha,
      mergeBaseSha: prepared.mergeBaseSha,
      counts: prepared.counts ?? { nodes: 100, edges: 200 },
      changedFiles,
      cache: prepared.cache,
      viewUrl: prepared.viewUrl,
      initialProjectionCache: prepared.initialProjectionCache,
      preparedPair: {
        version: 1,
        prNumber: number,
        headGraphId: prepared.graphId,
        mergeBaseGraphId: prepared.comparisonGraphId,
        headSha: prepared.headSha,
        baseSha: prepared.baseSha,
        mergeBaseSha: prepared.mergeBaseSha,
      },
    } },
  ];
}

function opaqueEvidenceId(number, variant, salt) {
  const prefix = `${number.toString(16).padStart(8, "0")}${variant === "full" ? "f" : "e"}${salt}`;
  return prefix.padEnd(64, String(salt));
}

function coldSceneHash() {
  return createHash("sha256").update(JSON.stringify({
    nodeIds: ["node:a", "node:b"],
    edgeIds: ["edge:a-b"],
    reviewFiles: ["src/a.ts", "src/b.ts"],
  })).digest("hex");
}

function publicationSample(number, variant, actionable, settled, graphBytes, rss, iteration, order) {
  const value = sample(
    actionable,
    settled,
    graphBytes,
    rss,
    variant === "full" ? "/api/graph" : "/api/graph/project",
  );
  const cacheEvidence = variant === "progressive"
    ? publicationCacheEvidence(number)
    : null;
  const scene = {
    nodeIds: ["node:a", "node:b"],
    edgeIds: ["edge:a-b"],
    reviewFiles: ["src/a.ts", "src/b.ts"],
  };
  return {
    ...value,
    variant,
    iteration,
    measurementOrder: { sequencePosition: order.indexOf(variant) + 1, variants: order },
    exactRevision: {
      graphId: `head-${number}`,
      comparisonGraphId: `base-${number}`,
      headSha: HEAD,
      baseSha: BASE,
      mergeBaseSha: MERGE_BASE,
      preparedBaseSha: BASE,
      baseTipDrift: false,
    },
    sceneAtAction: structuredClone(scene),
    sceneSettled: scene,
    projections: variant === "progressive"
      ? [{ graphId: `head-${number}` }, { graphId: `base-${number}` }]
      : [],
    initialProjectionCacheHits: variant === "progressive"
      ? initialProjectionCacheHits({
        graphId: `head-${number}`,
        comparisonGraphId: `base-${number}`,
        initialProjectionCache: initialProjectionCache(),
      })
      : [],
    graphs: variant === "full"
      ? [
        { graphId: `head-${number}`, method: "GET", status: 200 },
        { graphId: `base-${number}`, method: "GET", status: 200 },
      ]
      : [],
    cacheReadiness: cacheEvidence?.cacheReadiness ?? null,
    cacheEvidence,
  };
}

function publicationCacheEvidence(number) {
  const prepared = {
    graphId: `head-${number}`,
    comparisonGraphId: `base-${number}`,
  };
  const evidence = causalWarmEvidence(prepared);
  return {
    ...evidence,
    cacheReadiness: deriveCausalWarmReadinessEvidence(evidence, prepared),
  };
}

function causalWarmEvidence(prepared) {
  const graphIds = [prepared.graphId, prepared.comparisonGraphId];
  const keys = ["1".repeat(64), "2".repeat(64)];
  return {
    rendererCapture: {
      firstActionableEpochMs: 1_000,
      rendererResponseBodiesRead: false,
    },
    initialRequests: graphIds.map((graphId, index) => ({
      graphId,
      seedGraphId: prepared.graphId,
      requestedDepth: 1,
      prefetchDepth: 3,
      status: 200,
      cache: "miss",
      key: String(index + 3).repeat(64),
      ready: true,
    })),
    warmRequests: graphIds.map((graphId, index) => ({
      graphId,
      version: 1,
      rootsKind: "changed-files",
      seedGraphId: prepared.graphId,
      requestedDepth: 2,
      prefetchDepth: 2,
      method: "POST",
      path: "/api/graph/project/warm",
      requestStartedEpochMs: 1_100 + index,
      initiatedBy: "renderer-background",
      responseBodyRead: false,
      status: 202,
      contentType: "application/json; charset=utf-8",
      cacheControl: "no-store",
    })),
    probes: graphIds.map((graphId, index) => ({
      graphId,
      requestedDepth: 2,
      prefetchDepth: 2,
      warm: {
        rendererStatus: 202,
        rendererResponseBodyRead: false,
        confirmationBodyOwner: "harness-proof-page-fetch",
        confirmationStatus: 202,
        version: 1,
        key: keys[index],
        accepted: false,
        completed: false,
        cache: "coalesced",
      },
      readiness: { status: 200, completed: true, key: keys[index] },
      request: {
        status: 200,
        cache: "hit",
        key: keys[index],
        ready: true,
        graphId,
        seedGraphId: prepared.graphId,
        loadedDepth: 2,
      },
    })),
  };
}

function recording(number, variant) {
  const symbol = {
    id: `symbol-${number}`,
    fileId: `file-${number}`,
    displayName: `ReviewSymbol${number}`,
    file: "src/disconnected.ts",
  };
  return {
    relativePath: `videos/autopilot-pr-${number}-${variant}.webm`,
    exactRevision: {
      graphId: `head-${number}`,
      comparisonGraphId: `base-${number}`,
      headSha: HEAD,
      baseSha: BASE,
      mergeBaseSha: MERGE_BASE,
      preparedBaseSha: BASE,
      baseTipDrift: false,
    },
    interaction: {
      summary: `${variant} review`,
      variant,
      depthAdjusted: variant === "progressive",
      searchHydrated: true,
      disconnectedBeforeSearch: variant === "progressive" ? true : null,
      backgroundSymbolIndex: variant === "progressive" ? {
        rendererInitiated: true,
        afterFirstActionable: true,
        beforeHarnessInteraction: true,
        graphId: `head-${number}`,
        complete: true,
        indexedSymbolCount: 20,
        totalSymbolCount: 20,
        acceptanceMark: {
          name: "meridian:progressive-symbol-index-ready",
          startTimeMs: 125.5,
          indexedSymbolCount: 20,
        },
        rendererTransport: {
          graphId: `head-${number}`,
          generation: "immutable-generation",
          requestStartedAtMs: 1_250,
          firstActionableAtMs: 1_200,
          workerBacked: true,
          accepted: true,
          source: "renderer-symbol-worker-accepted",
        },
        harnessFetch: {
          graphId: `head-${number}`,
          status: 200,
        },
      } : null,
      symbol,
      canvasNodesBeforeSearch: 10,
      canvasNodesAfterSearch: 11,
    },
    validation: {
      sha256: variant === "full" ? "d".repeat(64) : "e".repeat(64),
      codec: "vp8",
      durationSeconds: 5,
      width: 1440,
      height: 900,
      sizeBytes: 200000,
      sampledFrames: 10,
      distinctFrames: 8,
      minimumLuma: 8,
      maximumLuma: 42,
      validatedAt: "2026-07-31T12:00:00.000Z",
    },
  };
}

function handoffRecording(number, variant) {
  const prepared = {
    graphId: `record-${variant}-head-${number}`,
    comparisonGraphId: `record-${variant}-base-${number}`,
    headSha: HEAD,
    baseSha: BASE,
    mergeBaseSha: MERGE_BASE,
    counts: { nodes: 100, edges: 200 },
    cache: "miss",
    viewUrl: `/view?id=record-${variant}-head-${number}&view=modules&prn=${number}&rev=1&progressive=1`,
    initialProjectionCache: initialProjectionCache(),
  };
  const events = coldPreparationEvents(number, prepared, 800);
  const ready = events.find((event) => event.payload.stage === "ready").payload;
  const provisional = validateProvisionalReady({ number, headOid: HEAD }, ready);
  const handoff = validatePreparationHandoff({ number, headOid: HEAD }, ready, events.at(-1).payload);
  const mark = {
    name: "meridian:pr-canonical-graph-reconciled",
    startTimeMs: 600,
    detail: { graphId: prepared.graphId },
  };
  return {
    relativePath: `videos/autopilot-pr-${number}-${variant}-cold-handoff.webm`,
    flow: variant === "progressive"
      ? "provisional-ready-then-background-canonical-reconciliation"
      : "canonical-done-then-navigation",
    exactRevision: {
      graphId: prepared.graphId,
      comparisonGraphId: prepared.comparisonGraphId,
      headSha: HEAD,
      baseSha: BASE,
      mergeBaseSha: MERGE_BASE,
      preparedBaseSha: BASE,
      baseTipDrift: false,
    },
    handoff,
    navigation: {
      source: "playwright-main-document-request",
      viewUrl: variant === "progressive"
        ? ready.viewUrl
        : `/view?id=${prepared.graphId}&view=modules&prn=${number}&rev=1`,
      startedMs: variant === "progressive" ? 450 : 850,
    },
    timings: {
      provisionalReadyObservedMs: 400,
      canonicalDoneMs: 800,
      navigationStartedMs: variant === "progressive" ? 450 : 850,
      firstActionableBrowserMs: 500,
      canonicalReconciledBrowserMs: variant === "progressive" ? 600 : null,
    },
    reconciliation: variant === "progressive"
      ? validateCanonicalReconciliation(provisional, prepared, [events.at(-1).payload], [mark])
      : null,
    validation: {
      sha256: variant === "full" ? "4".repeat(64) : "5".repeat(64),
      codec: "vp8",
      durationSeconds: 5,
      width: 1440,
      height: 900,
      sizeBytes: 200000,
      sampledFrames: 10,
      distinctFrames: 8,
      minimumLuma: 8,
      maximumLuma: 42,
      validatedAt: "2026-07-31T12:00:00.000Z",
    },
  };
}
