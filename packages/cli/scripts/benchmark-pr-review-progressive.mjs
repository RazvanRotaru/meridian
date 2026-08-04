#!/usr/bin/env node

/**
 * Controlled complete-baseline vs partial-only PR review benchmark and showcase recorder.
 *
 * A default-enabled cold lane gives each variant its own fresh Meridian process/cache and starts
 * timing before PR preparation. A separate prepared-delivery lane opens exact immutable pairs in fresh
 * Chromium processes with HTTP cache disabled. GitHub is resolved before and after every PR so a
 * force-pushed head or advancing base invalidates the run instead of silently mixing revisions.
 * The complete pair is requested only through an explicit progressive:false measurement lane; it
 * is never background continuation or fallback work for the partial review.
 */

import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, rename, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { chromium } from "playwright";
import {
  createOwnedProcessTreeTracker,
  OWNED_PROCESS_REGISTRY_ENV,
  OWNED_PROCESS_TOKEN_ENV,
  readProcessTable,
  terminateOwnedProcessTree,
} from "./owned-process-tree.mjs";
import {
  LANDING_CLOCK_CALIBRATION_SAMPLE_COUNT,
  PARTIAL_ONLY_DELIVERY_CONTRACT,
  PARTIAL_RUNTIME_ONLY_DELIVERY_CONTRACT,
  PR_REVIEW_POC_SCHEMA_VERSION,
  aggregateColdEndToEnd,
  aggregatePartialOnlyResults,
  aggregatePartialRuntimeOnlyColdResults,
  aggregatePartialRuntimeOnlyResults,
  alignLandingManifestClock,
  assertStablePullRevision,
  comparisonFromPartialOnlyEvidence,
  deriveCausalWarmReadinessEvidence,
  deriveColdPreparationMilestones,
  harnessUsage,
  parseFfprobeJson,
  parseFrameMd5,
  parseGitHubPull,
  parseHarnessArgs,
  parseNdjsonText,
  parseSignalStats,
  redactSecrets,
  renderHtmlReport,
  safeRelativeMediaPath,
  summarizeVariant,
  validateNontrivialFrames,
  validateCanonicalBaselineTerminal,
  validatePartialAnalyzeTerminal,
  validatePartialPreparationStream,
  validatePreparationHandoff,
  validateProvisionalReady,
  validateSampleRevision,
  validateVideoProbe,
} from "./pr-review-poc-lib.mjs";

const execFileAsync = promisify(execFile);
const GRAPH_PATHS = new Set(["/api/graph", "/api/graph/project"]);
const CRITICAL_API_PREFIXES = ["/api/graph", "/api/pr/analyze", "/api/prs"];
const RESULTS_FILENAME = "results.json";
const REPORT_FILENAME = "report.html";
const PROJECTION_CACHE_HEADER = "x-meridian-graph-projection-cache";
const PROJECTION_KEY_HEADER = "x-meridian-graph-projection-key";
const PROJECTION_READY_HEADER = "x-meridian-graph-projection-ready";
const HARNESS_WARM_PROOF_HEADER = "x-meridian-benchmark-warm-proof";
const HARNESS_PROJECTION_PROOF_HEADER = "x-meridian-benchmark-projection-proof";
export const PR_FULL_BASELINE_BENCHMARK_HEADER = "x-meridian-pr-full-baseline";
export const PR_FULL_BASELINE_BENCHMARK_CAPABILITY = "benchmark-v1";
const FIRST_ACTIONABLE_MARK = "meridian:first-actionable-canvas";
const MANIFEST_SHELL_ACTIONABLE_MARK = "meridian:pr-manifest-shell-actionable";
const NAVIGATION_RESTORED_MARK = "meridian:navigation-restored";
const CANONICAL_RECONCILED_MARK = "meridian:pr-canonical-graph-reconciled";
const PROGRESSIVE_SYMBOL_INDEX_READY_MARK = "meridian:progressive-symbol-index-ready";
// CDP's request wallTime and PerformanceResourceTiming's timeOrigin + startTime are both epoch
// clocks. Live Chromium deltas are sub-millisecond; ten milliseconds leaves room for clock
// sampling jitter while remaining narrow enough that repeated same-URL POSTs fail closed instead
// of being paired by order or guesswork.
const RESOURCE_TIMING_CORRELATION_TOLERANCE_MS = 10;
const COLD_MEMORY_SAMPLE_INTERVAL_MS = 500;
const DWELL_WORKER_SAMPLE_INTERVAL_MS = 50;
const MAX_SHOWCASE_HYDRATION_WAIT_MS = 60_000;

let options;
let paths;
let diagnosticReasons;
let serviceProcess;
let result;
const activeColdServiceStops = new Set();
let coldSignalCleanupInstalled = false;

export async function main(argv = process.argv.slice(2)) {
  if (argv.some((argument) => argument === "--help" || argument === "-h")) {
    process.stdout.write(`${harnessUsage()}\n`);
    return;
  }

  try {
    options = parseHarnessArgs(argv);
  } catch (error) {
    process.stderr.write(`${redactSecrets(error?.message ?? error)}\n\n${harnessUsage()}\n`);
    process.exitCode = 2;
    return;
  }

  paths = await createOutputLayout(options.outputDir);
  diagnosticReasons = initialDiagnosticReasons(options);
  serviceProcess = await discoverLocalServiceProcess(options.baseUrl);
  if (serviceProcess.diagnostic !== null) diagnosticReasons.push(serviceProcess.diagnostic);
  const fullBaselineCapability = options.partialRuntimeOnly
    ? await inspectListenerFullBaselineCapability(serviceProcess.pid)
    : null;
  result = {
    schemaVersion: PR_REVIEW_POC_SCHEMA_VERSION,
    status: "running",
    generatedAt: new Date().toISOString(),
    config: {
      baseUrl: options.baseUrl,
      repository: options.repository,
      prs: options.prs,
      repetitions: options.repetitions,
      viewport: options.viewport,
      recordVideos: options.recordVideos,
      validateVideos: options.validateVideos,
      coldEndToEnd: {
        enabled: options.coldEndToEnd,
        repetitions: options.coldEndToEnd ? 1 : 0,
        isolation: options.partialRuntimeOnly
          ? "fresh-production-service-and-cache-per-progressive-lane"
          : "fresh-meridian-service-and-cache-per-variant",
      },
      deliveryContract: options.partialRuntimeOnly
        ? PARTIAL_RUNTIME_ONLY_DELIVERY_CONTRACT
        : PARTIAL_ONLY_DELIVERY_CONTRACT,
      ...(options.partialRuntimeOnly ? { fullBaselineCapability } : {}),
      mode: diagnosticReasons.length === 0 ? "publishable" : "diagnostic",
      diagnosticReasons,
    },
    environment: {
      ...await environmentFacts(),
      meridianServicePid: serviceProcess.pid,
      meridianServiceDiscovery: serviceProcess.diagnostic === null ? "local-listener" : "unavailable",
    },
    prs: [],
    aggregate: null,
    coldAggregate: null,
    diagnostic: diagnosticReasons.length === 0 ? null : { reason: diagnosticReasons.join("; ") },
  };

  await persistResults(paths, result);

  try {
    if (options.partialRuntimeOnly) {
      assertFullBaselineCapabilityAbsent(fullBaselineCapability, "normal production listener");
      await runPartialRuntimeOnlyEvidence();
      result.status = diagnosticReasons.length === 0 ? "complete" : "diagnostic-complete";
      result.generatedAt = new Date().toISOString();
      refreshResultAggregates();
      await persistResults(paths, result);
      log(`Results: ${paths.results}`);
      log(`HTML report: ${paths.report}`);
      return;
    }
    for (const [prIndex, prNumber] of options.prs.entries()) {
      log(`Resolving ${options.repository} PR #${prNumber}`);
      const initial = await resolveLivePull(prNumber);
      const entry = {
        number: prNumber,
        title: initial.title,
        url: initial.url,
        status: "preparing",
        revisions: {
          initial,
          coldInputs: { full: null, progressive: null },
          preparationInput: null,
          prepared: null,
          canonicalBaseline: null,
          final: null,
        },
        preparation: null,
        coldEndToEnd: null,
        variants: null,
        comparison: null,
        recordings: { full: null, progressive: null },
        startupRecordings: { full: null, progressive: null },
        parity: null,
      };
      result.prs.push(entry);
      await persistPrMetadata(paths, entry);
      await persistResults(paths, result);

      if (options.coldEndToEnd) {
        const coldOrder = prIndex % 2 === 0
          ? ["full", "progressive"]
          : ["progressive", "full"];
        entry.status = "measuring-cold-end-to-end";
        entry.coldEndToEnd = {
          repetitions: 1,
          isolation: "fresh-meridian-service-and-cache-per-variant",
          order: coldOrder,
          variants: { full: null, progressive: null },
          parity: null,
        };
        await persistResults(paths, result);
        for (const [sequencePosition, variant] of coldOrder.entries()) {
          log(`PR #${prNumber}: isolated cold ${variant} end-to-end sample`);
          const laneLive = await resolveLivePull(prNumber);
          assertStablePullRevision(initial, laneLive);
          entry.revisions.coldInputs[variant] = laneLive;
          await persistPrMetadata(paths, entry);
          entry.coldEndToEnd.variants[variant] = await measureColdEndToEndVariant({
            live: laneLive,
            variant,
            measurementOrder: { sequencePosition: sequencePosition + 1, variants: coldOrder },
          });
          await persistResults(paths, result);
        }
        assertReviewSurfacePair(
          prNumber,
          0,
          entry.coldEndToEnd.variants.full,
          entry.coldEndToEnd.variants.progressive,
        );
        entry.coldEndToEnd.parity = buildReviewSurfaceParity(
          prNumber,
          [entry.coldEndToEnd.variants.full],
          [entry.coldEndToEnd.variants.progressive],
        );
        result.coldAggregate = aggregateColdEndToEnd(result.prs);
        await persistResults(paths, result);
      }

      log(`Preparing exact graph pair for PR #${prNumber}`);
      const preparationInput = await resolveLivePull(prNumber);
      assertStablePullRevision(initial, preparationInput);
      entry.revisions.preparationInput = preparationInput;
      await persistPrMetadata(paths, entry);
      const preparation = await preparePull(preparationInput);
      const preparationDone = preparation.events.at(-1)?.payload;
      const terminalProof = validatePartialPreparationStream(preparationInput, preparation.events);
      const terminalProcesses = await coldServiceMemorySnapshot(serviceProcess.pid);
      if (terminalProcesses === null || terminalProcesses.repositoryAnalysisWorkerPids.length !== 0) {
        throw new Error("partial preparation reached EOF with a repository-analysis worker still running");
      }
      terminalProof.repositoryAnalysisWorkerPidsAfterTerminal = [];
      entry.preparation = {
        totalMs: preparation.totalMs,
        httpStatus: preparation.httpStatus,
        events: preparation.events,
        cache: preparationDone?.cache ?? "unknown",
        terminalProof,
        canonicalBaseline: null,
      };
      await persistPrMetadata(paths, entry);
      const prepared = terminalProof.prepared;
      entry.revisions.prepared = prepared;
      entry.preparation.cache = prepared.cache;
      log(`Preparing explicit progressive:false canonical baseline for PR #${prNumber}`);
      const canonicalPreparation = await prepareCanonicalBaseline(preparationInput, prepared);
      const canonicalPrepared = validateCanonicalBaselineTerminal(
        preparationInput,
        canonicalPreparation.events.at(-1)?.payload,
      );
      entry.revisions.canonicalBaseline = canonicalPrepared;
      entry.preparation.canonicalBaseline = {
        totalMs: canonicalPreparation.totalMs,
        httpStatus: canonicalPreparation.httpStatus,
        events: canonicalPreparation.events,
        purpose: "measurement-baseline-only",
      };
      await persistPrMetadata(paths, entry);

      const urls = {
        full: new URL(canonicalPrepared.viewUrl, options.baseUrl).href,
        progressive: new URL(prepared.viewUrl, options.baseUrl).href,
      };
      const samples = { full: [], progressive: [] };
      entry.status = "measuring";
      entry.variants = {
        full: { url: urls.full, samples: samples.full, summary: null },
        progressive: { url: urls.progressive, samples: samples.progressive, summary: null },
      };
      await persistResults(paths, result);

      for (let iteration = 0; iteration < options.repetitions; iteration += 1) {
        const order = (iteration + prIndex) % 2 === 0
          ? ["full", "progressive"]
          : ["progressive", "full"];
        for (const [sequencePosition, variant] of order.entries()) {
          log(`PR #${prNumber}: ${variant} sample ${iteration + 1}/${options.repetitions}`);
          const sample = await measureReviewPage({
            url: urls[variant],
            variant,
            iteration,
            measurementOrder: { sequencePosition: sequencePosition + 1, variants: order },
            prepared: variant === "progressive" ? prepared : canonicalPrepared,
            partialTerminalProof: variant === "progressive" ? terminalProof : null,
          });
          samples[variant].push(sample);
          await persistResults(paths, result);
        }
        assertReviewSurfacePair(prNumber, iteration, samples.full[iteration], samples.progressive[iteration]);
      }
      if (!hasCausalWarmProof(samples.progressive)) {
        addDiagnosticReason("no prepared progressive sample proved causal next-depth warm-to-ready cache reuse");
      }

      entry.parity = buildReviewSurfaceParity(prNumber, samples.full, samples.progressive);
      entry.variants.full.summary = summarizeVariant(samples.full);
      entry.variants.progressive.summary = summarizeVariant(samples.progressive);
      entry.comparison = comparisonFromPartialOnlyEvidence(
        entry.variants.full.summary,
        entry.variants.progressive.summary,
        entry.coldEndToEnd?.variants?.full,
        entry.coldEndToEnd?.variants?.progressive,
      );

      if (options.recordVideos) {
        log(`PR #${prNumber}: recording paired progressive/full showcases`);
        const progressiveVideoPath = join(paths.videos, `autopilot-pr-${prNumber}-progressive.webm`);
        const progressiveRecorded = await recordVariantShowcase({
          variant: "progressive",
          url: urls.progressive,
          prepared,
          videoPath: progressiveVideoPath,
          symbol: null,
        });
        entry.recordings.progressive = {
          relativePath: safeRelativeMediaPath(paths.report, progressiveVideoPath),
          interaction: progressiveRecorded.interaction,
          exactRevision: progressiveRecorded.exactRevision,
          analyzeRequests: progressiveRecorded.analyzeRequests,
          validation: options.validateVideos ? await validateVideo(progressiveVideoPath) : null,
        };
        const fullVideoPath = join(paths.videos, `autopilot-pr-${prNumber}-full.webm`);
        const fullRecorded = await recordVariantShowcase({
          variant: "full",
          url: urls.full,
          prepared: canonicalPrepared,
          videoPath: fullVideoPath,
          symbol: progressiveRecorded.interaction.symbol,
        });
        entry.recordings.full = {
          relativePath: safeRelativeMediaPath(paths.report, fullVideoPath),
          interaction: fullRecorded.interaction,
          exactRevision: fullRecorded.exactRevision,
          analyzeRequests: fullRecorded.analyzeRequests,
          validation: options.validateVideos ? await validateVideo(fullVideoPath) : null,
        };
        log(`PR #${prNumber}: recording separate partial-ready and canonical-baseline startup showcases`);
        for (const variant of ["full", "progressive"]) {
          const live = await resolveLivePull(prNumber);
          assertStablePullRevision(initial, live);
          const startupVideoPath = join(
            paths.videos,
            `autopilot-pr-${prNumber}-${variant}-cold-startup.webm`,
          );
          const showcase = await recordColdStartupShowcase({
            live,
            variant,
            videoPath: startupVideoPath,
          });
          entry.startupRecordings[variant] = {
            relativePath: safeRelativeMediaPath(paths.report, startupVideoPath),
            ...showcase,
            validation: options.validateVideos ? await validateVideo(startupVideoPath) : null,
          };
          await persistResults(paths, result);
        }
      }

      const final = await resolveLivePull(prNumber);
      entry.revisions.final = final;
      await persistPrMetadata(paths, entry);
      assertStablePullRevision(initial, final);
      entry.status = "complete";
      await persistPrMetadata(paths, entry);
      result.aggregate = aggregatePartialOnlyResults(result.prs);
      result.coldAggregate = aggregateColdEndToEnd(result.prs);
      await persistResults(paths, result);
    }

    result.status = diagnosticReasons.length === 0 ? "complete" : "diagnostic-complete";
    result.generatedAt = new Date().toISOString();
    refreshResultAggregates();
    await persistResults(paths, result);
    log(`Results: ${paths.results}`);
    log(`HTML report: ${paths.report}`);
  } catch (error) {
    const safeMessage = redactSecrets(error?.stack ?? error);
    const activeEntry = result.prs.at(-1);
    if (activeEntry && activeEntry.status !== "complete") {
      activeEntry.status = "failed";
      try {
        activeEntry.revisions.final = await resolveLivePull(activeEntry.number);
        await persistPrMetadata(paths, activeEntry);
      } catch {
        // Preserve the original failure; inability to take a final GitHub snapshot is reflected by null.
      }
    }
    result.status = "failed";
    result.failure = {
      message: safeMessage,
      at: new Date().toISOString(),
      clockAlignmentDiagnostic: error?.clockAlignmentDiagnostic ?? null,
    };
    result.generatedAt = new Date().toISOString();
    refreshResultAggregates();
    await persistResults(paths, result);
    process.stderr.write(`${safeMessage}\nPartial evidence: ${paths.results}\n`);
    process.exitCode = 1;
  }
}

async function runPartialRuntimeOnlyEvidence() {
  const plan = benchmarkEvidencePlan(true);
  if (!options.recordVideos || !options.validateVideos) {
    throw new Error("partial-runtime-only evidence requires two validated recordings per PR");
  }
  if (!options.coldEndToEnd) {
    throw new Error("partial-runtime-only evidence requires the isolated cold progressive lane");
  }
  if (options.allowSearchSkip) {
    throw new Error("partial-runtime-only evidence requires disconnected-symbol search hydration");
  }

  for (const [prIndex, prNumber] of options.prs.entries()) {
    log(`Resolving ${options.repository} PR #${prNumber} for partial-runtime-only evidence`);
    const initial = await resolveLivePull(prNumber);
    const entry = {
      number: prNumber,
      title: initial.title,
      url: initial.url,
      status: "preparing",
      revisions: {
        initial,
        coldInputs: { progressive: null },
        preparationInput: null,
        prepared: null,
        final: null,
      },
      preparation: null,
      coldEndToEnd: null,
      variants: null,
      recordings: { progressive: null },
      startupRecordings: { progressive: null },
    };
    result.prs.push(entry);
    await persistPrMetadata(paths, entry);
    await persistResults(paths, result);

    entry.status = "measuring-cold-end-to-end";
    entry.coldEndToEnd = {
      repetitions: 1,
      isolation: "fresh-production-service-and-cache-per-progressive-lane",
      order: [...plan.coldVariants],
      variants: { progressive: null },
    };
    const coldLive = await resolveLivePull(prNumber);
    assertStablePullRevision(initial, coldLive);
    entry.revisions.coldInputs.progressive = coldLive;
    await persistPrMetadata(paths, entry);
    log(`PR #${prNumber}: isolated cold progressive end-to-end sample`);
    entry.coldEndToEnd.variants.progressive = await measureColdEndToEndVariant({
      live: coldLive,
      variant: plan.coldVariants[0],
      measurementOrder: { sequencePosition: 1, variants: [...plan.coldVariants] },
    });
    assertFullBaselineCapabilityAbsent(
      entry.coldEndToEnd.variants.progressive.isolation.fullBaselineCapability,
      `PR #${prNumber} cold progressive service`,
    );
    refreshResultAggregates();
    await persistResults(paths, result);

    log(`Preparing exact bounded graph pair for PR #${prNumber}`);
    const preparationInput = await resolveLivePull(prNumber);
    assertStablePullRevision(initial, preparationInput);
    entry.revisions.preparationInput = preparationInput;
    await persistPrMetadata(paths, entry);
    const preparation = await preparePull(preparationInput);
    const terminalProof = validatePartialPreparationStream(preparationInput, preparation.events);
    const terminalProcesses = await coldServiceMemorySnapshot(serviceProcess.pid);
    if (terminalProcesses === null || terminalProcesses.repositoryAnalysisWorkerPids.length !== 0) {
      throw new Error("partial preparation reached EOF with a repository-analysis worker still running");
    }
    terminalProof.repositoryAnalysisWorkerPidsAfterTerminal = [];
    const prepared = terminalProof.prepared;
    entry.revisions.prepared = prepared;
    entry.preparation = {
      totalMs: preparation.totalMs,
      httpStatus: preparation.httpStatus,
      events: preparation.events,
      cache: prepared.cache,
      terminalProof,
    };
    await persistPrMetadata(paths, entry);

    const url = new URL(prepared.viewUrl, options.baseUrl).href;
    const samples = [];
    entry.status = "measuring";
    entry.variants = {
      progressive: { url, samples, summary: null },
    };
    await persistResults(paths, result);
    for (let iteration = 0; iteration < options.repetitions; iteration += 1) {
      log(`PR #${prNumber}: progressive sample ${iteration + 1}/${options.repetitions}`);
      samples.push(await measureReviewPage({
        url,
        variant: plan.preparedVariants[0],
        iteration,
        measurementOrder: { sequencePosition: 1, variants: [...plan.preparedVariants] },
        prepared,
        partialTerminalProof: terminalProof,
      }));
      await persistResults(paths, result);
    }
    if (!hasCausalWarmProof(samples)) {
      addDiagnosticReason("no prepared progressive sample proved causal next-depth warm-to-ready cache reuse");
    }
    entry.variants.progressive.summary = summarizeVariant(samples);

    log(`PR #${prNumber}: recording progressive depth/search showcase`);
    const functionalityVideoPath = join(
      paths.videos,
      `autopilot-pr-${prNumber}-progressive.webm`,
    );
    const functionality = await recordVariantShowcase({
      variant: plan.recordingVariants[0],
      url,
      prepared,
      videoPath: functionalityVideoPath,
      symbol: null,
    });
    entry.recordings.progressive = {
      relativePath: safeRelativeMediaPath(paths.report, functionalityVideoPath),
      interaction: functionality.interaction,
      exactRevision: functionality.exactRevision,
      analyzeRequests: functionality.analyzeRequests,
      partialRuntimeTransport: functionality.partialRuntimeTransport,
      validation: await validateVideo(functionalityVideoPath),
    };
    await persistResults(paths, result);

    log(`PR #${prNumber}: recording partial-ready cold startup showcase`);
    const startupLive = await resolveLivePull(prNumber);
    assertStablePullRevision(initial, startupLive);
    const startupVideoPath = join(
      paths.videos,
      `autopilot-pr-${prNumber}-progressive-cold-startup.webm`,
    );
    const startup = await recordColdStartupShowcase({
      live: startupLive,
      variant: plan.startupVariants[0],
      videoPath: startupVideoPath,
    });
    assertFullBaselineCapabilityAbsent(
      startup.isolation.fullBaselineCapability,
      `PR #${prNumber} startup recording service`,
    );
    entry.startupRecordings.progressive = {
      relativePath: safeRelativeMediaPath(paths.report, startupVideoPath),
      ...startup,
      validation: await validateVideo(startupVideoPath),
    };

    const final = await resolveLivePull(prNumber);
    entry.revisions.final = final;
    await persistPrMetadata(paths, entry);
    assertStablePullRevision(initial, final);
    entry.status = "complete";
    await persistPrMetadata(paths, entry);
    refreshResultAggregates();
    await persistResults(paths, result);
    log(`PR #${prNumber}: partial-runtime-only evidence complete (${prIndex + 1}/${options.prs.length})`);
  }
}

export function benchmarkEvidencePlan(partialRuntimeOnly) {
  if (partialRuntimeOnly === true) {
    return {
      preparedVariants: ["progressive"],
      coldVariants: ["progressive"],
      recordingVariants: ["progressive"],
      startupVariants: ["progressive"],
      fullBaselineCapabilityEnabled: false,
    };
  }
  return {
    preparedVariants: ["full", "progressive"],
    coldVariants: ["full", "progressive"],
    recordingVariants: ["full", "progressive"],
    startupVariants: ["full", "progressive"],
    fullBaselineCapabilityEnabled: true,
  };
}

export function assertRuntimeVariantAllowed(
  variant,
  lane = "benchmark lane",
  partialRuntimeOnly = options?.partialRuntimeOnly === true,
) {
  if (variant !== "full" && variant !== "progressive") {
    throw new TypeError(`${lane} has an unknown variant: ${String(variant)}`);
  }
  if (partialRuntimeOnly && variant !== "progressive") {
    throw new Error(`partial-runtime-only evidence forbids the ${variant} ${lane}`);
  }
  return variant;
}

function refreshResultAggregates() {
  if (options.partialRuntimeOnly) {
    result.aggregate = aggregatePartialRuntimeOnlyResults(result.prs);
    result.coldAggregate = aggregatePartialRuntimeOnlyColdResults(result.prs);
    return;
  }
  result.aggregate = aggregatePartialOnlyResults(result.prs);
  result.coldAggregate = aggregateColdEndToEnd(result.prs);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}

async function resolveLivePull(number) {
  const args = ["api"];
  if (options.ghHostname !== null) args.push("--hostname", options.ghHostname);
  args.push(`repos/${options.repository}/pulls/${number}`);
  const { stdout } = await safeExec(options.ghPath, args, { maxBuffer: 8 * 1024 * 1024 });
  let json;
  try {
    json = JSON.parse(stdout);
  } catch {
    throw new Error(`gh returned invalid JSON for PR #${number}`);
  }
  const pull = parseGitHubPull(json, options.repository, number);
  const baseArgs = ["api"];
  if (options.ghHostname !== null) baseArgs.push("--hostname", options.ghHostname);
  baseArgs.push(`repos/${pull.baseRepository}/git/ref/heads/${encodeURIComponent(pull.baseRef)}`);
  const { stdout: baseStdout } = await safeExec(options.ghPath, baseArgs, { maxBuffer: 2 * 1024 * 1024 });
  let baseReference;
  try {
    baseReference = JSON.parse(baseStdout);
  } catch {
    throw new Error(`gh returned invalid JSON for ${pull.baseRepository} branch ${pull.baseRef}`);
  }
  const baseOid = parseGitReferenceTip(baseReference, pull.baseRef);
  return {
    ...pull,
    pullBaseOid: pull.baseOid,
    baseOid,
    resolvedAt: new Date().toISOString(),
  };
}

export function parseGitReferenceTip(value, expectedRef) {
  const expected = `refs/heads/${expectedRef}`;
  if (value?.ref !== expected) {
    throw new Error(`GitHub returned ${String(value?.ref ?? "no ref")} while resolving ${expected}`);
  }
  const oid = value?.object?.sha;
  if (typeof oid !== "string" || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(oid)) {
    throw new Error(`GitHub returned no valid object SHA while resolving ${expected}`);
  }
  return oid.toLowerCase();
}

async function preparePull(live, overrides = {}) {
  return requestPreparation("/api/pr/prepare", {
    repository: live.repository,
    prNumber: live.number,
    baseRef: live.baseRef,
    headRef: live.headRef,
    headSha: live.headOid,
  }, overrides);
}

/** The complete graph is retained only as an explicit control lane. Starting it requires a
 * registered GitHub source; the already-finished bounded pair provides that descriptor, but this
 * request is always `progressive:false` and is never issued by a progressive review/navigation. */
async function prepareCanonicalBaseline(live, partial, overrides = {}) {
  if (options?.partialRuntimeOnly === true) {
    throw new Error("partial-runtime-only evidence forbids prepareCanonicalBaseline");
  }
  const preparation = await requestPreparation("/api/pr/analyze", {
    id: partial.graphId,
    prNumber: live.number,
    baseRef: live.baseRef,
    headRef: live.headRef,
    progressive: false,
  }, {
    ...overrides,
    headers: {
      ...(overrides.headers ?? {}),
      [PR_FULL_BASELINE_BENCHMARK_HEADER]: PR_FULL_BASELINE_BENCHMARK_CAPABILITY,
    },
  });
  const terminal = preparation.events.at(-1)?.payload;
  if (terminal?.stage !== "done" || terminal.completeness !== undefined) {
    throw new Error("progressive:false canonical baseline did not produce a complete terminal");
  }
  return preparation;
}

async function requestPreparation(path, body, overrides = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("PR preparation timed out")), options.prepareTimeoutMs);
  const started = overrides.timelineStartedAt ?? performance.now();
  const baseUrl = overrides.baseUrl ?? options.baseUrl;
  try {
    const response = await fetch(new URL(path, baseUrl), {
      method: "POST",
      headers: {
        accept: "application/x-ndjson",
        "content-type": "application/json",
        origin: baseUrl,
        ...(overrides.headers ?? {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.body) throw new Error(`${path} returned HTTP ${response.status} without a body`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const events = [];
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = drainNdjson(buffer, events, started, false);
    }
    buffer += decoder.decode();
    drainNdjson(buffer, events, started, true);
    if (!response.ok) throw new Error(`${path} failed with HTTP ${response.status}`);
    const terminal = events.at(-1)?.payload;
    if (terminal?.stage === "error") throw new Error(`${path} failed: ${terminal.message ?? "unknown error"}`);
    return {
      httpStatus: response.status,
      totalMs: roundMs(performance.now() - started),
      events,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function measureColdEndToEndVariant({ live, variant, measurementOrder }) {
  assertRuntimeVariantAllowed(variant, "cold end-to-end measurement");
  const ownedService = await startIsolatedColdService();
  return runWithOwnedColdService(ownedService, async () => {
    let landing;
    let coldMemorySampler;
    let opened;
    let openedPromise = null;
    try {
      landing = await openColdLandingPreparation(ownedService.baseUrl);
      coldMemorySampler = startColdServiceMemorySampler(ownedService.pid);
      const coldStarted = performance.now();
      const { preparationPromise, landingStarted } = beginColdPreparationSubscribers(
        () => preparePull(live, {
          baseUrl: ownedService.baseUrl,
          timelineStartedAt: coldStarted,
        }),
        () => landing.start(live, coldStarted),
      );
      await landingStarted;
      // This is the user-visible action boundary. Production preparation terminates at `ready`;
      // the separate promise only collects the terminal bounded-pair proof for benchmark evidence.
      const landingShell = await landing.collect(live, coldStarted);
      const provisional = landingShell.provisional;
      assertLandingProvisionalPair(landingShell, provisional);
      await landing.close();

      if (variant === "progressive") {
        openedPromise = openReviewPage({
          url: new URL(provisional.viewUrl, ownedService.baseUrl).href,
          prepared: provisional,
          videoDirectory: null,
          baseUrl: ownedService.baseUrl,
          servicePid: ownedService.pid,
        });
        void openedPromise.catch(() => {});
      }

      const preparation = await preparationPromise;
      const terminalProof = validatePartialPreparationStream(live, preparation.events);
      const terminalProcesses = await coldServiceMemorySnapshot(ownedService.pid);
      if (terminalProcesses === null || terminalProcesses.repositoryAnalysisWorkerPids.length !== 0) {
        throw new Error("cold partial preparation reached EOF with an analysis worker still running");
      }
      terminalProof.repositoryAnalysisWorkerPidsAfterTerminal = [];
      let prepared = terminalProof.prepared;
      let canonicalBaselinePreparation = null;
      const readyPayload = preparation.events.find((event) => event.payload?.stage === "ready")?.payload;
      const handoff = validatePreparationHandoff(live, readyPayload, preparation.events.at(-1)?.payload);
      assertLandingPartialTerminal(landingShell, provisional, prepared, handoff);
      const evidenceEvents = coldPreparationEvidenceEvents(preparation.events);
      const milestones = deriveColdPreparationMilestones(evidenceEvents, prepared);
      if (landingShell.changedFileCount !== milestones.manifestFileCount) {
        throw new Error("landing manifest shell count contradicts the exact preparation manifest");
      }
      const manifestEvent = evidenceEvents.find((event) => event.payload?.stage === "manifest-ready");
      assertLandingRenderedManifest(landingShell, manifestEvent?.payload?.changedFiles, live.repository, prepared);
      landingShell.renderedManifestSha256 = milestones.manifestSha256;

      if (variant === "progressive") opened = await openedPromise;

      if (variant === "full") {
        // Explicit compatibility control only: it is started after the bounded bootstrap has
        // reached EOF, with `progressive:false`, and never runs behind a progressive navigation.
        const canonicalPreparation = await prepareCanonicalBaseline(live, prepared, {
          baseUrl: ownedService.baseUrl,
          timelineStartedAt: coldStarted,
        });
        prepared = validateCanonicalBaselineTerminal(
          live,
          canonicalPreparation.events.at(-1)?.payload,
        );
        canonicalBaselinePreparation = {
          progressive: false,
          httpStatus: canonicalPreparation.httpStatus,
          totalMs: canonicalPreparation.totalMs,
          terminal: canonicalPreparation.events.at(-1)?.payload,
        };
        opened = await openReviewPage({
          url: new URL(prepared.viewUrl, ownedService.baseUrl).href,
          prepared,
          videoDirectory: null,
          baseUrl: ownedService.baseUrl,
          servicePid: ownedService.pid,
        });
      }
      const transport = assertVariantTransport(variant, opened, prepared, {
        provisional: variant === "progressive" ? provisional : null,
      });
      const browserMemory = await opened.finishMemorySampling();
      const coldServiceMemory = mergeColdServiceMemory(
        await coldMemorySampler.stop(),
        browserMemory.serviceMemory,
      );
      if (coldServiceMemory.diagnostic === true) {
        addDiagnosticReason(coldServiceMemory.diagnosticMessage ?? "isolated cold service memory is unavailable");
      }
      const navigationStartedMs = roundMs(opened.navigationStartedMonotonicMs - coldStarted);
      const browserFirstActionableMs = opened.timings.firstActionableMs;
      const browserSettledMs = opened.timings.settledMs;
      const partialOnlyContinuation = variant === "progressive"
        ? await buildPartialOnlyContinuationProof(opened, ownedService.pid, terminalProof)
        : null;
      return {
      variant,
      repetition: 1,
      measurementOrder,
      measuredAt: new Date().toISOString(),
      isolation: {
        freshCache: true,
        loopbackOnly: true,
        servicePid: ownedService.pid,
        serviceInstanceId: ownedService.serviceInstanceId,
        cacheInstanceId: ownedService.cacheInstanceId,
        fullBaselineCapability: ownedService.fullBaselineCapability,
        cleanup: ownedService.cleanupEvidence,
      },
        prepared,
        provisionalPrepared: provisional,
        preparation: {
        totalMs: preparation.totalMs,
        httpStatus: preparation.httpStatus,
        cache: prepared.cache,
        milestones,
        eventCount: preparation.events.length,
          events: evidenceEvents,
          handoff,
          terminalProof,
          completionSubscriber: "complete-ndjson-drain-to-partial-eof",
        },
      chromiumVersion: opened.chromiumVersion,
      timings: {
        landingShellActionableMs: landingShell.actionableMs,
        landingShellTtaMs: landingShell.ttaMs,
        provisionalReadyMs: milestones.provisionalReadyMs,
        provisionalReadyTtaMs: landingShell.readyTtaMs,
        navigationStartedMs,
        browserFirstActionableMs,
        browserSettledMs,
        prepareToFirstActionableMs: roundMs(navigationStartedMs + browserFirstActionableMs),
        prepareToSettledMs: roundMs(navigationStartedMs + browserSettledMs),
        endToEndFirstActionableMs: roundMs(navigationStartedMs + browserFirstActionableMs),
        endToEndSettledMs: roundMs(navigationStartedMs + browserSettledMs),
        ...(options.partialRuntimeOnly ? {} : { canonicalReconciledMs: null }),
      },
      landingShell,
      firstActionableMark: opened.firstActionableMark,
      networkAtAction: opened.networkAtAction,
      networkSettled: opened.networkSettled,
      memoryAtAction: opened.memoryAtAction,
      memorySettled: opened.memorySettled,
      memoryPeak: browserMemory.memoryPeak,
      coldServiceMemory,
      domAtAction: opened.domAtAction,
      domSettled: opened.domSettled,
      sceneAtAction: opened.sceneAtAction,
      sceneSettled: opened.sceneSettled,
      exactRevision: transport.exactRevision,
      partialOnlyContinuation,
      ...(options.partialRuntimeOnly ? {} : {
        reconciliation: null,
        canonicalBaselinePreparation,
      }),
      analyzeTerminals: opened.captures.analyzeTerminals.map((entry) => ({ ...entry })),
      analyzeRequests: opened.captures.analyzeRequests.map((entry) => ({ ...entry })),
      initialProjectionCacheHits: transport.initialProjectionCacheHits,
      performanceMarks: opened.performanceMarks,
      graphs: opened.captures.graphResponses.map((entry) => ({ ...entry })),
      projections: opened.captures.projections.map(projectionEvidence),
      pageErrors: opened.captures.pageErrors,
      consoleErrors: opened.captures.consoleErrors,
      };
    } finally {
      await landing?.close().catch(() => undefined);
      await opened?.close().catch(() => undefined);
      await coldMemorySampler?.stop().catch(() => undefined);
    }
  });
}

export async function runWithOwnedColdService(ownedService, operation) {
  let operationResult;
  let operationError = null;
  try {
    operationResult = await operation(ownedService);
  } catch (error) {
    operationError = error;
  }
  let cleanupError = null;
  try {
    await ownedService.stop();
  } catch (error) {
    cleanupError = error;
  }
  if (operationError !== null && cleanupError !== null) {
    throw new AggregateError(
      [operationError, cleanupError],
      "cold benchmark operation failed and its owned process cleanup also failed",
    );
  }
  if (cleanupError !== null) throw cleanupError;
  if (operationError !== null) throw operationError;
  return operationResult;
}

export function beginColdPreparationSubscribers(startNodeSubscriber, startLandingSubscriber) {
  // The Node subscriber is deliberately initiated first: clone/checkout/extract progress is not
  // replayable, while the UI subscriber only needs the later manifest and terminal pair.
  const preparationPromise = startNodeSubscriber();
  const landingStarted = startLandingSubscriber();
  return { preparationPromise, landingStarted };
}

/** Observe the browser's actual top-level `/view` document request on the Node monotonic clock.
 * The ready callback may schedule navigation several animation frames before Chromium starts this
 * request, so callback time is not valid evidence for a terminal-before-navigation gate. */
export function observeMainDocumentViewNavigation(page, expectedOrigin, clock = () => performance.now()) {
  const origin = new URL(expectedOrigin).origin;
  const mainFrame = page.mainFrame();
  let settled = false;
  let resolveObservation;
  let rejectObservation;
  const promise = new Promise((resolve, reject) => {
    resolveObservation = resolve;
    rejectObservation = reject;
  });
  const dispose = () => page.off("request", onRequest);
  const onRequest = (request) => {
    if (settled) return;
    let url;
    try {
      url = new URL(request.url());
    } catch {
      return;
    }
    if (url.origin !== origin || url.pathname !== "/view") return;
    try {
      if (request.resourceType() !== "document"
        || request.isNavigationRequest() !== true
        || request.frame() !== mainFrame) return;
      const startedAtMonotonicMs = clock();
      if (!Number.isFinite(startedAtMonotonicMs)) {
        throw new TypeError("main-document navigation clock returned no finite timestamp");
      }
      settled = true;
      dispose();
      resolveObservation({
        source: "playwright-main-document-request",
        viewUrl: `${url.pathname}${url.search}`,
        startedAtMonotonicMs,
      });
    } catch (error) {
      settled = true;
      dispose();
      rejectObservation(error);
    }
  };
  page.on("request", onRequest);
  return { promise, dispose };
}

export function hasCausalWarmProof(samples) {
  return Array.isArray(samples)
    && samples.some((sample) => sample?.cacheReadiness?.causalWarmReadyHit === true);
}

async function openColdLandingPreparation(baseUrl) {
  const chromiumArgs = [
    "--disable-dev-shm-usage",
    "--disable-background-networking",
    "--enable-precise-memory-info",
  ];
  if (isLoopbackUrl(baseUrl)) chromiumArgs.unshift("--no-sandbox");
  const browser = await chromium.launch({ headless: !options.headed, args: chromiumArgs });
  let context;
  let closed = false;
  try {
    context = await browser.newContext({
      viewport: options.viewport,
      deviceScaleFactor: 1,
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(redactSecrets(error?.message ?? error)));
    const response = await page.goto(new URL("/", baseUrl).href, {
      waitUntil: "domcontentloaded",
      timeout: options.timeoutMs,
    });
    if (response === null || !response.ok()) {
      throw new Error(`cold landing navigation failed with HTTP ${response?.status() ?? "no response"}`);
    }
    await page.waitForFunction(
      () => typeof showPrepareProgress === "function" && typeof preparePrReview === "function",
      null,
      { polling: "raf", timeout: options.timeoutMs },
    );
    const beforeClockCalibrationSamples = [];
    for (let index = 0; index < LANDING_CLOCK_CALIBRATION_SAMPLE_COUNT; index += 1) {
      const nodeBeforeMs = performance.now();
      const browserAtMs = await page.evaluate(() => performance.now());
      const nodeAfterMs = performance.now();
      beforeClockCalibrationSamples.push({ nodeBeforeMs, nodeAfterMs, browserAtMs });
    }
    let landingClockProtocol = null;
    return {
      async start(live, coldStarted) {
        const nodeBeforeMs = performance.now();
        const browserStart = await page.evaluate((request) => {
          if (typeof showPrepareProgress !== "function" || typeof preparePrReview !== "function") {
            throw new Error("PR review preparation UI is unavailable");
          }
          // This is the real landing renderer path, invoked without the form handler so the harness
          // can observe its early shell and final pair without an automatic navigation replacing it.
          githubIntent = "review";
          showPrepareProgress("github", false, request.prNumber);
          const state = { settled: false, settledAtMs: null, ok: false, value: null, message: null };
          Object.defineProperty(window, "__MERIDIAN_COLD_PREPARE__", {
            value: state,
            configurable: false,
            writable: false,
          });
          void preparePrReview(request).then(
            (value) => Object.assign(state, {
              settled: true,
              settledAtMs: performance.now(),
              ok: true,
              value,
            }),
            (error) => Object.assign(state, {
              settled: true,
              settledAtMs: performance.now(),
              ok: false,
              message: error instanceof Error ? error.message : String(error),
            }),
          );
          return {
            browserRequestStartedAtMs: window.__MERIDIAN_PR_PREPARE_REQUEST_STARTED__?.atMs ?? null,
            browserSampleAtMs: performance.now(),
          };
        }, {
          repository: live.repository,
          prNumber: live.number,
          baseRef: live.baseRef,
          headRef: live.headRef,
          headSha: live.headOid,
        });
        const nodeAfterMs = performance.now();
        landingClockProtocol = {
          beforeSamples: beforeClockCalibrationSamples,
          nodeColdStartedMs: coldStarted,
          requestBracket: { nodeBeforeMs, nodeAfterMs, ...browserStart },
        };
      },
      async collect(live, coldStarted) {
        await page.waitForFunction(
          () => window.__MERIDIAN_PR_MANIFEST_SHELL_ACTIONABLE__ !== null,
          null,
          { polling: "raf", timeout: options.prepareTimeoutMs },
        );
        const afterClockCalibrationSamples = [];
        for (let index = 0; index < LANDING_CLOCK_CALIBRATION_SAMPLE_COUNT; index += 1) {
          const nodeBeforeMs = performance.now();
          const browserAtMs = await page.evaluate(() => performance.now());
          const nodeAfterMs = performance.now();
          afterClockCalibrationSamples.push({ nodeBeforeMs, nodeAfterMs, browserAtMs });
        }
        landingClockProtocol = {
          ...landingClockProtocol,
          afterSamples: afterClockCalibrationSamples,
        };
        // Keep the action-side clock proof adjacent to the mark. Terminal preparation can take
        // minutes longer and is deliberately awaited only after the second calibration phase.
        await page.waitForFunction(
          () => window.__MERIDIAN_COLD_PREPARE__?.settled === true,
          null,
          { polling: "raf", timeout: options.prepareTimeoutMs },
        );
        const observed = await page.evaluate((markName) => {
          const outcome = window.__MERIDIAN_COLD_PREPARE__;
          const mark = window.__MERIDIAN_PR_MANIFEST_SHELL_ACTIONABLE__;
          const shell = document.getElementById("prepare-manifest-shell");
          const performanceEntry = performance.getEntriesByName(markName, "mark").at(-1) ?? null;
          return {
            outcome,
            mark,
            performanceEntry: performanceEntry === null ? null : {
              name: performanceEntry.name,
              startTimeMs: performanceEntry.startTime,
              detail: performanceEntry.detail ?? null,
            },
            visible: shell instanceof HTMLElement
              && shell.hidden === false
              && shell.dataset.state === "actionable"
              && getComputedStyle(shell).display !== "none"
              && getComputedStyle(shell).visibility !== "hidden",
            visibleChangedFileRows: document.querySelectorAll("#prepare-manifest-files > li").length,
            rows: [...document.querySelectorAll("#prepare-manifest-files > li")].map((row) => ({
              status: row.dataset.status ?? null,
              label: row.querySelector(".prepare-manifest-path")?.textContent ?? null,
              sourceHref: row.querySelector(".prepare-manifest-source")?.href ?? null,
            })),
          };
        }, MANIFEST_SHELL_ACTIONABLE_MARK);
        if (observed.outcome?.ok !== true) {
          throw new Error(`landing PR preparation failed: ${observed.outcome?.message ?? "unknown error"}`);
        }
        if (pageErrors.length > 0) {
          throw new Error(`cold landing page raised ${pageErrors.length} error(s): ${pageErrors[0]}`);
        }
        const mark = observed.mark;
        const markFailures = landingManifestObservationFailures(observed);
        if (markFailures.length > 0) {
          throw new Error(
            `landing manifest shell emitted no authoritative visible performance mark (${markFailures.join(", ")})`,
          );
        }
        const aligned = alignLandingManifestClock(mark, landingClockProtocol);
        const requestStartedMs = roundMs(aligned.requestStartedMs);
        const actionableMs = roundMs(aligned.actionableMs);
        const provisional = validateProvisionalReady(live, observed.outcome.value);
        if (!Number.isFinite(observed.outcome.settledAtMs)
          || observed.outcome.settledAtMs < mark.requestStartedAtMs) {
          throw new Error("landing PR preparation has no causal provisional-ready time");
        }
        return {
          source: "application-performance-mark-and-visible-dom",
          markName: MANIFEST_SHELL_ACTIONABLE_MARK,
          requestStartedMs,
          actionableMs,
          ttaMs: roundMs(aligned.ttaMs),
          readyAtBrowserMs: roundMs(observed.outcome.settledAtMs),
          readyTtaMs: roundMs(observed.outcome.settledAtMs - mark.requestStartedAtMs),
          clockAlignment: aligned.clockAlignment,
          performanceEntry: observed.performanceEntry,
          visible: true,
          changedFileCount: mark.changedFileCount,
          visibleChangedFileRows: observed.visibleChangedFileRows,
          rows: observed.rows,
          headSha: mark.headSha,
          baseSha: mark.baseSha,
          mergeBaseSha: mark.mergeBaseSha,
          provisional,
          terminal: {
            ...exactRevisionEvidence(provisional),
            pairId: provisional.pairId,
            completeness: provisional.completeness,
            cache: provisional.cache,
            viewUrl: provisional.viewUrl,
            initialProjectionCache: provisional.initialProjectionCache,
          },
        };
      },
      async close() {
        if (closed) return;
        closed = true;
        await cdp.detach().catch(() => undefined);
        await context.close().catch(() => undefined);
        await browser.close().catch(() => undefined);
      },
    };
  } catch (error) {
    await context?.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
    throw error;
  }
}

export function landingManifestObservationFailures(observed) {
  const failures = [];
  const mark = observed?.mark;
  const performanceEntry = observed?.performanceEntry;
  if (observed?.visible !== true) failures.push("shell-not-visible");
  if (performanceEntry?.name !== MANIFEST_SHELL_ACTIONABLE_MARK) {
    failures.push("performance-entry-missing-or-wrong-name");
  }
  if (!Number.isFinite(mark?.atMs)) failures.push("mark-time-invalid");
  if (!Number.isFinite(mark?.requestStartedAtMs)) failures.push("request-start-time-invalid");
  if (!Number.isFinite(mark?.ttaMs)) failures.push("tta-invalid");
  if (Number.isFinite(mark?.atMs)
    && Number.isFinite(mark?.requestStartedAtMs)
    && mark.atMs < mark.requestStartedAtMs) {
    failures.push("mark-before-request-start");
  }
  if (Number.isFinite(mark?.ttaMs) && mark.ttaMs < 0) failures.push("tta-negative");
  if (Number.isFinite(mark?.atMs)
    && Number.isFinite(mark?.requestStartedAtMs)
    && Number.isFinite(mark?.ttaMs)
    && mark.atMs - mark.requestStartedAtMs !== mark.ttaMs) {
    failures.push("tta-duration-mismatch");
  }
  if (!Number.isFinite(performanceEntry?.startTimeMs)) {
    failures.push("performance-entry-time-invalid");
  } else if (Number.isFinite(mark?.atMs)
    && performanceEntry.startTimeMs !== mark.atMs) {
    failures.push("performance-entry-time-mismatch");
  }
  return failures;
}

function assertLandingProvisionalPair(landingShell, provisional) {
  if (landingShell.visibleChangedFileRows !== landingShell.changedFileCount) {
    throw new Error("landing manifest shell did not visibly render every changed file");
  }
  for (const field of ["graphId", "comparisonGraphId", "headSha", "baseSha", "mergeBaseSha", "pairId"]) {
    if (landingShell.terminal?.[field] !== provisional[field]) {
      throw new Error(`landing provisional terminal contradicts exact ${field}`);
    }
  }
  for (const field of ["headSha", "baseSha", "mergeBaseSha"]) {
    if (landingShell[field] !== provisional[field]) {
      throw new Error(`landing manifest shell contradicts exact ${field}`);
    }
  }
  if (JSON.stringify(landingShell.terminal?.initialProjectionCache)
    !== JSON.stringify(provisional.initialProjectionCache)) {
    throw new Error("landing provisional terminal contradicts initial projection cache readiness");
  }
  if (landingShell.terminal?.completeness !== "provisional"
    || !Number.isFinite(landingShell.readyAtBrowserMs)
    || !Number.isFinite(landingShell.readyTtaMs)
    || landingShell.readyTtaMs < 0) {
    throw new Error("landing preparation did not prove its provisional-ready action boundary");
  }
}

function assertLandingPartialTerminal(landingShell, provisional, terminal, handoff) {
  assertLandingProvisionalPair(landingShell, provisional);
  if (handoff?.exactRevisionBound !== true
    || handoff?.sameBoundedPair !== true
    || handoff?.canonicalContinuationObserved !== false
    || handoff?.pairId !== provisional.pairId) {
    throw new Error("landing ready pair is not bound to the authoritative partial-only terminal");
  }
  for (const field of ["graphId", "comparisonGraphId", "headSha", "baseSha", "mergeBaseSha", "pairId"]) {
    if (provisional[field] !== terminal[field]) {
      throw new Error(`landing partial ready/done contradicts exact ${field}`);
    }
  }
}

function assertLandingRenderedManifest(landingShell, changedFiles, repository, prepared) {
  if (!Array.isArray(changedFiles) || !Array.isArray(landingShell.rows)
    || changedFiles.length !== landingShell.rows.length) {
    throw new Error("landing manifest shell row evidence is incomplete");
  }
  for (let index = 0; index < changedFiles.length; index += 1) {
    const file = changedFiles[index];
    const row = landingShell.rows[index];
    const expectedLabel = file.status === "renamed" ? `${file.previousPath} → ${file.path}` : file.path;
    const expectedSha = file.status === "deleted" ? prepared.mergeBaseSha : prepared.headSha;
    const expectedHref = `https://github.com/${repository}/blob/${expectedSha}/${file.path
      .split("/").map(encodeURIComponent).join("/")}`;
    if (row?.status !== file.status || row?.label !== expectedLabel || row?.sourceHref !== expectedHref) {
      throw new Error(`landing manifest shell row ${index + 1} contradicts the exact changed-file manifest`);
    }
  }
}

function coldPreparationEvidenceEvents(events) {
  const selected = [];
  const takeFirst = (name, predicate) => {
    const event = events.find((candidate) => predicate(candidate?.payload));
    if (event === undefined) throw new Error(`cold preparation emitted no ${name} evidence`);
    selected.push(event);
  };
  takeFirst("clone", (payload) => payload?.stage === "clone");
  takeFirst("checkout", (payload) => payload?.stage === "checkout");
  takeFirst("analysis", (payload) => payload?.stage === "extract");
  takeFirst("manifest-ready", (payload) => payload?.stage === "manifest-ready");
  takeFirst("provisional ready", (payload) => payload?.stage === "ready");
  takeFirst("HEAD extraction start", (payload) => payload?.stage === "extract-head");
  takeFirst("HEAD extraction completion", (payload) => payload?.stage === "lane-complete" && payload?.lane === "head");
  takeFirst("merge-base extraction start", (payload) => payload?.stage === "extract-merge-base");
  takeFirst(
    "merge-base extraction completion",
    (payload) => payload?.stage === "lane-complete" && payload?.lane === "mergeBase",
  );
  const terminal = events.at(-1);
  if (terminal?.payload?.stage !== "done") throw new Error("cold preparation emitted no final-pair evidence");
  selected.push(terminal);
  selected.sort((left, right) => left.atMs - right.atMs);
  return selected;
}

function drainNdjson(buffer, events, started, includeTail) {
  const lines = buffer.split("\n");
  const complete = includeTail ? lines : lines.slice(0, -1);
  for (const line of complete) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let payload;
    try {
      payload = JSON.parse(trimmed);
    } catch {
      throw new Error("PR preparation returned malformed NDJSON");
    }
    events.push({ atMs: roundMs(performance.now() - started), payload });
  }
  return includeTail ? "" : lines.at(-1) ?? "";
}

async function measureReviewPage({
  url,
  variant,
  iteration,
  measurementOrder,
  prepared,
  partialTerminalProof = null,
}) {
  assertRuntimeVariantAllowed(variant, "prepared review measurement");
  const opened = await openReviewPage({ url, prepared, videoDirectory: null });
  try {
    const transport = assertVariantTransport(variant, opened, prepared);
    const cacheEvidence = variant === "progressive"
      ? await proveNextDepthCacheReadiness(opened, prepared)
      : null;
    const memoryEvidence = await opened.finishMemorySampling();
    if (memoryEvidence.serviceMemory.diagnostic === true) {
      addDiagnosticReason(memoryEvidence.serviceMemory.diagnosticMessage ?? "Meridian service memory is unproven");
    }
    const partialOnlyContinuation = variant === "progressive"
      ? await buildPartialOnlyContinuationProof(opened, serviceProcess.pid, partialTerminalProof)
      : null;
    return {
      variant,
      iteration: iteration + 1,
      measurementOrder,
      measuredAt: new Date().toISOString(),
      chromiumVersion: opened.chromiumVersion,
      timings: opened.timings,
      firstActionableMark: opened.firstActionableMark,
      networkAtAction: opened.networkAtAction,
      networkSettled: opened.networkSettled,
      memoryAtAction: opened.memoryAtAction,
      memorySettled: opened.memorySettled,
      memoryPeak: memoryEvidence.memoryPeak,
      serviceMemory: memoryEvidence.serviceMemory,
      domAtAction: opened.domAtAction,
      domSettled: opened.domSettled,
      sceneAtAction: opened.sceneAtAction,
      sceneSettled: opened.sceneSettled,
      exactRevision: transport.exactRevision,
      analyzeTerminals: opened.captures.analyzeTerminals.map((entry) => ({ ...entry })),
      analyzeRequests: opened.captures.analyzeRequests.map((entry) => ({ ...entry })),
      partialOnlyContinuation,
      initialProjectionCacheHits: transport.initialProjectionCacheHits,
      performanceMarks: opened.performanceMarks,
      graphs: opened.captures.graphResponses.map((entry) => ({ ...entry })),
      projections: opened.captures.projections.map(projectionEvidence),
      cacheReadiness: cacheEvidence?.cacheReadiness ?? null,
      cacheEvidence,
      pageErrors: opened.captures.pageErrors,
      consoleErrors: opened.captures.consoleErrors,
    };
  } finally {
    await opened.close();
  }
}

function assertVariantTransport(variant, opened, prepared, options = {}) {
  assertAuthoritativeGraphNetwork(opened.networkSettled);
  const paths = opened.networkSettled.byPath;
  const fullRequests = paths["/api/graph"]?.requests ?? 0;
  const projectionRequests = paths["/api/graph/project"]?.requests ?? 0;
  const marks = new Set(opened.performanceMarks.map((entry) => entry.name));
  if (!marks.has(FIRST_ACTIONABLE_MARK) || opened.firstActionableMark?.source !== "performance-mark") {
    throw new Error(`sample emitted no authoritative ${FIRST_ACTIONABLE_MARK} mark`);
  }
  if (variant === "full") {
    if (fullRequests === 0) throw new Error("full baseline made no canonical /api/graph request");
    if (projectionRequests !== 0) {
      throw new Error("full baseline used /api/graph/project; progressive capability was not disabled");
    }
    assertExactFullGraphResponses(opened.captures.graphResponses, prepared);
    return { exactRevision: opened.exactRevision, initialProjectionCacheHits: [] };
  }
  if (projectionRequests < 2 || opened.captures.projections.length < 2) {
    throw new Error("progressive sample did not load both exact revision projections");
  }
  if (fullRequests !== 0 || marks.has("meridian:progressive-graph-fallback")) {
    throw new Error("progressive sample fell back to a canonical full artifact");
  }
  assertNoFullAnalyzeRequests(opened.captures.analyzeRequests, "progressive sample");
  if (opened.captures.graphResponses.length !== 0) {
    throw new Error("progressive sample received a canonical full graph response");
  }
  if (!marks.has("meridian:progressive-graph-ready")) {
    throw new Error("progressive sample emitted no initial projection readiness mark");
  }
  const pairs = options.provisional === null
    || options.provisional === undefined
    || (options.provisional.graphId === prepared.graphId
      && options.provisional.comparisonGraphId === prepared.comparisonGraphId)
    ? [prepared]
    : [options.provisional, prepared];
  const seedByGraphId = new Map(pairs.flatMap((pair) => [
    [pair.graphId, pair.graphId],
    [pair.comparisonGraphId, pair.graphId],
  ]));
  const allowedGraphIds = new Set(seedByGraphId.keys());
  const graphIds = new Set();
  for (const projection of opened.captures.projections) {
    if (typeof projection?.graphId !== "string" || !allowedGraphIds.has(projection.graphId)) {
      throw new Error(`progressive sample loaded an unexpected graph projection: ${String(projection?.graphId)}`);
    }
    if (!["changed-files", "files", "file-paths"].includes(projection.rootsKind)) {
      throw new Error(`projection ${projection.graphId} used an unknown bounded root kind`);
    }
    const expectedSeed = projection.rootsKind === "changed-files"
      ? seedByGraphId.get(projection.graphId)
      : projection.graphId;
    if (projection.seedGraphId !== expectedSeed) {
      throw new Error(
        `projection ${projection.graphId} (${projection.rootsKind}) used seed `
          + `${String(projection.seedGraphId)} instead of ${expectedSeed}`,
      );
    }
    graphIds.add(projection.graphId);
  }
  if ([...allowedGraphIds].some((graphId) => !graphIds.has(graphId))) {
    throw new Error("progressive sample did not prove every exact partial graph identity");
  }
  const initialProjectionCacheHits = pairs.flatMap((pair) =>
    assertInitialProjectionCacheHits(opened.captures.projectionResponses, pair));
  return {
    exactRevision: opened.exactRevision,
    initialProjectionCacheHits,
  };
}

async function buildPartialOnlyContinuationProof(opened, servicePid, terminalProof) {
  if (terminalProof?.streamEnded !== true || terminalProof?.sameBoundedPair !== true) {
    throw new Error("partial-only continuation proof requires an observed ready/done/EOF stream");
  }
  // Pair process observations with route-count deltas from the same dwell. Whole-page counters
  // cannot authorize a worker that first appears later: the two initial projection requests are
  // expected before this boundary and must not mask a retired canonical continuation worker.
  const networkBeforeDwell = opened.tracker.snapshot();
  const workerActivity = await sampleDwellWorkerActivity(opened.page, servicePid, 300);
  await opened.captures.settle(options.timeoutMs);
  const network = opened.tracker.snapshot();
  const canonicalGraphRequests = network.byPath?.["/api/graph"]?.requests ?? 0;
  const canonicalGraphResponses = opened.captures.graphResponses.length;
  const canonicalReconciliationMarks = opened.performanceMarks
    .filter((entry) => entry.name === CANONICAL_RECONCILED_MARK).length;
  const terminals = opened.captures.analyzeTerminals;
  if (terminals.length !== 1) {
    throw new Error(`partial review emitted ${terminals.length} analyze terminals; expected one`);
  }
  validatePartialAnalyzeTerminal(
    { number: Number(new URL(opened.page.url()).searchParams.get("prn")), headOid: terminalProof.prepared.headSha },
    terminalProof.prepared,
    terminals[0],
  );
  return partialOnlyContinuationEvidence({
    terminalProof,
    canonicalGraphRequests,
    canonicalGraphResponses,
    canonicalReconciliationMarks,
    repositoryAnalysisWorkerPidsAfterTerminal:
      terminalProof.repositoryAnalysisWorkerPidsAfterTerminal ?? [],
    boundedPartialWorkerPidsAtDwellStart: workerActivity.repositoryAnalysisWorkerPidsAtStart,
    graphProjectWorkerPidsAtDwellStart: workerActivity.graphProjectWorkerPidsAtStart,
    boundedPartialWorkerPidsDuringDwell: workerActivity.repositoryAnalysisWorkerPidsObserved,
    graphProjectWorkerPidsDuringDwell: workerActivity.graphProjectWorkerPidsObserved,
    preDwellGraphWork: graphWorkEvidence(networkBeforeDwell),
    postReadyGraphWork: graphWorkDeltaEvidence(network, networkBeforeDwell),
    postTerminalDwellMs: 300,
    processSampleCount: workerActivity.processSampleCount,
  });
}

export function partialOnlyContinuationEvidence({
  terminalProof,
  canonicalGraphRequests,
  canonicalGraphResponses,
  canonicalReconciliationMarks,
  repositoryAnalysisWorkerPidsAfterTerminal,
  boundedPartialWorkerPidsAtDwellStart = [],
  graphProjectWorkerPidsAtDwellStart = [],
  boundedPartialWorkerPidsDuringDwell = [],
  graphProjectWorkerPidsDuringDwell = [],
  preDwellGraphWork,
  postReadyGraphWork,
  postTerminalDwellMs,
  processSampleCount,
}) {
  const before = preDwellGraphWork ?? {};
  const work = postReadyGraphWork ?? {};
  const prePartialProjectionRequests = before.partialProjectionRequests;
  const prePartialProjectionWarmRequests = before.partialProjectionWarmRequests;
  const preSourceIndexRequests = before.sourceIndexRequests;
  const preFullGenerationRequests = before.fullGenerationRequests;
  const partialProjectionRequests = work.partialProjectionRequests;
  const partialProjectionWarmRequests = work.partialProjectionWarmRequests;
  const sourceIndexRequests = work.sourceIndexRequests;
  const fullGenerationRequests = work.fullGenerationRequests;
  const validPids = (value) => Array.isArray(value)
    && value.every((pid) => Number.isSafeInteger(pid) && pid > 0)
    && new Set(value).size === value.length;
  const startPartialPids = validPids(boundedPartialWorkerPidsAtDwellStart)
    ? new Set(boundedPartialWorkerPidsAtDwellStart)
    : null;
  const startGraphPids = validPids(graphProjectWorkerPidsAtDwellStart)
    ? new Set(graphProjectWorkerPidsAtDwellStart)
    : null;
  const observedPartialPids = validPids(boundedPartialWorkerPidsDuringDwell)
    ? new Set(boundedPartialWorkerPidsDuringDwell)
    : null;
  const observedGraphPids = validPids(graphProjectWorkerPidsDuringDwell)
    ? new Set(graphProjectWorkerPidsDuringDwell)
    : null;
  const newPartialPids = startPartialPids === null || observedPartialPids === null
    ? []
    : [...observedPartialPids].filter((pid) => !startPartialPids.has(pid));
  const newGraphPids = startGraphPids === null || observedGraphPids === null
    ? []
    : [...observedGraphPids].filter((pid) => !startGraphPids.has(pid));
  const prePartialWorkerAuthorizations = prePartialProjectionRequests + prePartialProjectionWarmRequests;
  const preGraphWorkerAuthorizations = 2 * prePartialWorkerAuthorizations + preSourceIndexRequests;
  const dwellPartialWorkerAuthorizations = partialProjectionRequests + partialProjectionWarmRequests;
  const dwellGraphWorkerAuthorizations = 2 * dwellPartialWorkerAuthorizations + sourceIndexRequests;
  if (terminalProof?.streamEnded !== true
    || terminalProof?.sameBoundedPair !== true
    || typeof terminalProof?.pairId !== "string"
    || !/^[a-f0-9]{20}$/.test(terminalProof.pairId)
    || canonicalGraphRequests !== 0
    || canonicalGraphResponses !== 0
    || canonicalReconciliationMarks !== 0
    || !Array.isArray(repositoryAnalysisWorkerPidsAfterTerminal)
    || repositoryAnalysisWorkerPidsAfterTerminal.length !== 0
    || startPartialPids === null
    || startGraphPids === null
    || observedPartialPids === null
    || observedGraphPids === null
    || [...startPartialPids].some((pid) => !observedPartialPids.has(pid))
    || [...startGraphPids].some((pid) => !observedGraphPids.has(pid))
    || ![
      prePartialProjectionRequests,
      prePartialProjectionWarmRequests,
      preSourceIndexRequests,
      preFullGenerationRequests,
      partialProjectionRequests,
      partialProjectionWarmRequests,
      sourceIndexRequests,
      fullGenerationRequests,
    ]
      .every((value) => Number.isSafeInteger(value) && value >= 0)
    || preFullGenerationRequests !== 0
    || fullGenerationRequests !== 0
    || startPartialPids.size > prePartialWorkerAuthorizations
    || startGraphPids.size > preGraphWorkerAuthorizations
    || newPartialPids.length > dwellPartialWorkerAuthorizations
    || newGraphPids.length > dwellGraphWorkerAuthorizations
    || !Number.isSafeInteger(postTerminalDwellMs)
    || postTerminalDwellMs < 250
    || !Number.isSafeInteger(processSampleCount)
    || processSampleCount < 2) {
    throw new Error("partial review continued canonical graph extraction after navigation");
  }
  return {
    version: 2,
    delivery: options?.partialRuntimeOnly === true
      ? PARTIAL_RUNTIME_ONLY_DELIVERY_CONTRACT
      : PARTIAL_ONLY_DELIVERY_CONTRACT,
    pairId: terminalProof.pairId,
    streamEnded: true,
    readyDoneSamePair: true,
    postTerminalDwellMs,
    canonicalGraphRequests,
    canonicalGraphResponses,
    canonicalReconciliationMarks,
    repositoryAnalysisWorkerPidsAfterTerminal: [...repositoryAnalysisWorkerPidsAfterTerminal],
    boundedPartialWorkerPidsAtDwellStart: [...startPartialPids],
    graphProjectWorkerPidsAtDwellStart: [...startGraphPids],
    boundedPartialWorkerPidsDuringDwell: [...observedPartialPids],
    graphProjectWorkerPidsDuringDwell: [...observedGraphPids],
    newBoundedPartialWorkerPidsDuringDwell: newPartialPids,
    newGraphProjectWorkerPidsDuringDwell: newGraphPids,
    processObservation: {
      scope: "same-dwell-start-and-sampled-union",
      sampleIntervalMs: DWELL_WORKER_SAMPLE_INTERVAL_MS,
      sampleCount: processSampleCount,
    },
    preDwellGraphWork: {
      partialProjectionRequests: prePartialProjectionRequests,
      partialProjectionWarmRequests: prePartialProjectionWarmRequests,
      sourceIndexRequests: preSourceIndexRequests,
      fullGenerationRequests: preFullGenerationRequests,
    },
    postReadyGraphWork: {
      partialProjectionRequests,
      partialProjectionWarmRequests,
      sourceIndexRequests,
      fullGenerationRequests,
    },
    routeCounterScope: "same-dwell-request-delta",
    allowedBackgroundWork: "syntax-symbol-topology-index-and-explicit-bounded-partial-expansion-only",
  };
}

function graphWorkEvidence(network) {
  const requests = (path) => network.byPath?.[path]?.requests ?? 0;
  return {
    partialProjectionRequests: requests("/api/graph/project"),
    partialProjectionWarmRequests: requests("/api/graph/project/warm"),
    sourceIndexRequests: requests("/api/graph/symbols"),
    fullGenerationRequests: requests("/api/generate"),
  };
}

function graphWorkDeltaEvidence(network, baselineNetwork) {
  const after = graphWorkEvidence(network);
  const before = graphWorkEvidence(baselineNetwork);
  const delta = {};
  for (const key of Object.keys(after)) {
    const value = after[key] - before[key];
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error("partial review route counters moved backwards during the worker dwell");
    }
    delta[key] = value;
  }
  return delta;
}

export function assertNoFullAnalyzeRequests(requests, label = "partial-runtime evidence") {
  if (!Array.isArray(requests)
    || requests.length === 0
    || requests.some((request) => request?.method !== "POST"
      || request?.progressiveFalse !== false
      || request?.fullBaselineCapabilityHeaderPresent !== false)) {
    throw new Error(`${label} issued an explicit full-baseline analyze request`);
  }
  return requests;
}

export function assertAuthoritativeGraphNetwork(snapshot) {
  if (snapshot?.graphBytesAuthoritative !== true || snapshot?.graphAccountingComplete !== true) {
    const graphPaths = Object.fromEntries(
      [...GRAPH_PATHS]
        .filter((path) => snapshot?.byPath?.[path] !== undefined)
        .map((path) => [path, snapshot.byPath[path]]),
    );
    throw new Error(
      "sample has non-authoritative graph transfer accounting"
        + ` (authoritative=${String(snapshot?.graphBytesAuthoritative)}`
        + `, complete=${String(snapshot?.graphAccountingComplete)}`
        + `, anomalies=${String(snapshot?.accountingAnomalyCount ?? "unknown")}`
        + `, graphPaths=${JSON.stringify(graphPaths)})`,
    );
  }
}

export async function waitForGraphNetworkQuiescence(
  tracker,
  timeoutMs,
  wait = (delayMs) => new Promise((resolveWait) => setTimeout(resolveWait, delayMs)),
) {
  if (tracker === null || typeof tracker?.snapshot !== "function") {
    throw new TypeError("graph network quiescence requires a tracker snapshot function");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || typeof wait !== "function") {
    throw new TypeError("graph network quiescence requires a positive timeout and wait function");
  }
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const snapshot = tracker.snapshot();
    if (snapshot.graphAccountingComplete === true) return snapshot;
    if (Date.now() >= deadline) {
      throw new Error(
        `graph network did not quiesce after ${timeoutMs} ms`
          + ` (${snapshot.inFlightGraphRequestCount ?? "unknown"} graph request(s) still in flight)`,
      );
    }
    await wait(Math.min(100, Math.max(1, deadline - Date.now())));
  }
}

export async function awaitReadyWithIndependentTerminalDrain(
  readyPromise,
  terminalPromise,
  timeoutMs,
) {
  const terminalOutcomePromise = Promise.resolve(terminalPromise).then(
    (value) => ({ status: "fulfilled", value }),
    (reason) => ({ status: "rejected", reason }),
  );
  const terminalFailurePromise = terminalOutcomePromise.then((outcome) => {
    if (outcome.status === "rejected") throw outcome.reason;
    return new Promise(() => undefined);
  });
  const ready = await boundedOperation(
    Promise.race([readyPromise, terminalFailurePromise]),
    timeoutMs,
    "cold startup recording observed no ready pair",
  );
  const terminal = await terminalOutcomePromise;
  if (terminal.status === "rejected") throw terminal.reason;
  return { ready, terminal: terminal.value };
}

export function assertInitialProjectionCacheHits(responses, prepared) {
  const cache = prepared.initialProjectionCache;
  if (cache?.version !== 1 || cache?.ready !== true || cache?.depth !== 1 || cache?.prefetchDepth !== 3) {
    throw new Error("progressive sample has no exact prepared initial-projection cache contract");
  }
  const expected = new Map([
    [prepared.graphId, cache.headKey],
    [prepared.comparisonGraphId, cache.comparisonKey],
  ]);
  const hits = [];
  for (const [graphId, key] of expected) {
    const matches = responses.filter((entry) =>
      entry?.request?.version === 1
      && entry.request.graphId === graphId
      && entry.request.roots?.kind === "changed-files"
      && entry.request.roots.seedGraphId === prepared.graphId
      && entry.request.requestedDepth === cache.depth
      && entry.request.prefetchDepth === cache.prefetchDepth);
    if (matches.length !== 1) {
      throw new Error(`progressive sample did not make exactly one initial projection request for ${graphId}`);
    }
    const evidence = sanitizeProjectionResponse(matches[0]);
    if (evidence.status !== 200
      || evidence.cache !== "hit"
      || evidence.key !== key
      || evidence.ready !== true
      || evidence.graphId !== graphId
      || evidence.seedGraphId !== prepared.graphId
      || evidence.requestedDepth !== cache.depth
      || evidence.prefetchDepth !== cache.prefetchDepth
      || evidence.method !== "POST"
      || evidence.path !== "/api/graph/project"
      || evidence.responseBodyRead !== false
      || evidence.source !== "request-and-response-headers") {
      throw new Error(`progressive initial projection for ${graphId} was not a ready hit on its prepared exact key`);
    }
    hits.push(evidence);
  }
  return hits;
}

function assertExactFullGraphResponses(responses, prepared) {
  if (!Array.isArray(responses) || responses.length < 2) {
    throw new Error("full baseline did not capture both canonical graph responses");
  }
  const expected = new Set([prepared.graphId, prepared.comparisonGraphId]);
  const observed = new Set();
  for (const response of responses) {
    if (response?.method !== "GET" || response?.status !== 200 || !expected.has(response?.graphId)) {
      throw new Error(`full baseline loaded an unexpected canonical graph: ${String(response?.graphId)}`);
    }
    observed.add(response.graphId);
  }
  if (observed.size !== expected.size || [...expected].some((graphId) => !observed.has(graphId))) {
    throw new Error("full baseline did not prove exact HEAD and comparison graph identity");
  }
}

function exactRevisionEvidence(prepared) {
  return {
    graphId: prepared.graphId,
    comparisonGraphId: prepared.comparisonGraphId,
    headSha: prepared.headSha,
    baseSha: prepared.baseSha,
    mergeBaseSha: prepared.mergeBaseSha,
  };
}

async function recordVariantShowcase({ variant, url, prepared, videoPath, symbol }) {
  assertRuntimeVariantAllowed(variant, "functionality recording");
  const temporaryDirectory = join(
    paths.temporaryVideos,
    `${variant}-${prepared.headSha.slice(0, 12)}-${Date.now()}`,
  );
  await mkdir(temporaryDirectory, { recursive: true });
  const opened = await openReviewPage({ url, prepared, videoDirectory: temporaryDirectory });
  const video = opened.page.video();
  let interaction;
  let partialRuntimeTransport = null;
  try {
    assertVariantTransport(variant, opened, prepared);
    if (video === null) throw new Error("Playwright did not attach a video recorder");
    interaction = await performShowcaseInteraction(opened, { variant, symbol });
    if (variant === "progressive" && options.partialRuntimeOnly) {
      partialRuntimeTransport = await capturePartialRuntimeRecordingTransport(opened);
    }
  } finally {
    await opened.close();
  }
  if (video === null) throw new Error("Playwright did not attach a video recorder");
  const generatedPath = await video.path();
  await rename(generatedPath, videoPath);
  return {
    interaction,
    exactRevision: opened.exactRevision,
    analyzeRequests: opened.captures.analyzeRequests.map((entry) => ({ ...entry })),
    ...(options.partialRuntimeOnly ? { partialRuntimeTransport } : {}),
  };
}

async function capturePartialRuntimeRecordingTransport(opened) {
  await opened.captures.settle(options.timeoutMs);
  await waitForGraphNetworkQuiescence(
    opened.tracker,
    options.timeoutMs,
    (delayMs) => opened.page.waitForTimeout(delayMs),
  );
  opened.tracker.reconcileResourceTimings(await graphResourceTimingEvidence(opened.page));
  const network = opened.tracker.snapshot();
  assertAuthoritativeGraphNetwork(network);
  assertNoFullAnalyzeRequests(opened.captures.analyzeRequests, "progressive functionality recording");
  const canonicalGraphRequests = network.byPath?.["/api/graph"]?.requests ?? 0;
  const fullGenerationRequests = network.byPath?.["/api/generate"]?.requests ?? 0;
  const canonicalGraphResponses = opened.captures.graphResponses.length;
  const canonicalReconciliationMarks = await opened.page.evaluate((markName) =>
    performance.getEntriesByName(markName, "mark").length, CANONICAL_RECONCILED_MARK);
  if (canonicalGraphRequests !== 0
    || fullGenerationRequests !== 0
    || canonicalGraphResponses !== 0
    || canonicalReconciliationMarks !== 0) {
    throw new Error("progressive functionality recording observed full graph work");
  }
  return {
    canonicalGraphRequests,
    canonicalGraphResponses,
    fullGenerationRequests,
    canonicalReconciliationMarks,
    partialProjectionRequests: network.byPath?.["/api/graph/project"]?.requests ?? 0,
    partialWarmRequests: network.byPath?.["/api/graph/project/warm"]?.requests ?? 0,
    sourceIndexRequests: network.byPath?.["/api/graph/symbols"]?.requests ?? 0,
    graphAccountingComplete: network.graphAccountingComplete === true,
  };
}

/** Record two distinct startup claims. Partial-only navigates from bounded ready and proves EOF
 * quiescence; the full recording is an explicit progressive:false control, never background work. */
async function recordColdStartupShowcase({ live, variant, videoPath }) {
  assertRuntimeVariantAllowed(variant, "cold startup recording");
  const ownedService = await startIsolatedColdService();
  return runWithOwnedColdService(ownedService, async () => {
    const temporaryDirectory = join(
      paths.temporaryVideos,
      `cold-startup-${variant}-${live.number}-${Date.now()}`,
    );
    await mkdir(temporaryDirectory, { recursive: true });
    const chromiumArgs = [
      "--disable-dev-shm-usage",
      "--disable-background-networking",
    ];
    if (isLoopbackUrl(ownedService.baseUrl)) chromiumArgs.unshift("--no-sandbox");
    const browser = await chromium.launch({ headless: !options.headed, args: chromiumArgs });
    let context;
    let video;
    let navigationObserver;
    let tracker;
    let captures;
    try {
      context = await browser.newContext({
        viewport: options.viewport,
        deviceScaleFactor: 1,
        reducedMotion: "reduce",
        recordVideo: { dir: temporaryDirectory, size: options.viewport },
      });
      await installFullBaselineBenchmarkCapability(
        context,
        ownedService.baseUrl,
        variant === "full",
      );
      await context.addInitScript(firstActionableObserver);
      const page = await context.newPage();
      const cdp = await context.newCDPSession(page);
      await cdp.send("Network.enable");
      await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
      tracker = networkTracker(cdp, new URL(ownedService.baseUrl).origin);
      captures = captureResponses(page, new URL(ownedService.baseUrl).origin);
      navigationObserver = observeMainDocumentViewNavigation(page, ownedService.baseUrl);
      video = page.video();
      if (video === null) throw new Error("Playwright did not attach a cold startup video recorder");
      let readyObservedAtMs = null;
      let settleReady;
      let rejectReady;
      const readyPromise = new Promise((resolveReady, reject) => {
        settleReady = resolveReady;
        rejectReady = reject;
      });
      await page.exposeFunction("__MERIDIAN_POC_RECORD_READY__", (payload) => {
        readyObservedAtMs = performance.now();
        settleReady(payload);
      });
      await page.exposeFunction("__MERIDIAN_POC_RECORD_ERROR__", (message) => {
        rejectReady(new Error(redactSecrets(message)));
      });
      const landingResponse = await page.goto(new URL("/", ownedService.baseUrl).href, {
        waitUntil: "domcontentloaded",
        timeout: options.timeoutMs,
      });
      if (landingResponse === null || !landingResponse.ok()) {
        throw new Error(`cold recording landing navigation failed with HTTP ${landingResponse?.status() ?? "no response"}`);
      }
      await page.waitForFunction(
        () => typeof showPrepareProgress === "function" && typeof preparePrReview === "function",
        null,
        { polling: "raf", timeout: options.timeoutMs },
      );
      await addRecordingBadge(
        page,
        variant === "progressive"
          ? "Partial-only · navigate when depth-1 is ready"
          : "Full baseline · explicit progressive:false control",
      );
      const coldStarted = performance.now();
      const preparationPromise = preparePull(live, {
        baseUrl: ownedService.baseUrl,
        timelineStartedAt: coldStarted,
      });
      await page.evaluate(({ request, navigateOnReady }) => {
        githubIntent = "review";
        showPrepareProgress("github", false, request.prNumber);
        void preparePrReview(request).then(
          async (ready) => {
            await window.__MERIDIAN_POC_RECORD_READY__(ready);
            if (navigateOnReady) {
              await new Promise((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(resolveFrame)));
              window.location = ready.viewUrl;
            }
          },
          (error) => window.__MERIDIAN_POC_RECORD_ERROR__(
            error instanceof Error ? error.message : String(error),
          ),
        );
      }, {
        request: {
          repository: live.repository,
          prNumber: live.number,
          baseRef: live.baseRef,
          headRef: live.headRef,
          headSha: live.headOid,
        },
        navigateOnReady: variant === "progressive",
      });
      const startupPreparation = await awaitReadyWithIndependentTerminalDrain(
        readyPromise,
        preparationPromise,
        options.prepareTimeoutMs,
      );
      const readyPayload = startupPreparation.ready;
      const provisional = validateProvisionalReady(live, readyPayload);
      const preparation = startupPreparation.terminal;
      const donePayload = preparation.events.at(-1)?.payload;
      const terminalProof = validatePartialPreparationStream(live, preparation.events);
      const terminalProcesses = await coldServiceMemorySnapshot(ownedService.pid);
      if (terminalProcesses === null || terminalProcesses.repositoryAnalysisWorkerPids.length !== 0) {
        throw new Error("recorded partial preparation reached EOF with an analysis worker still running");
      }
      terminalProof.repositoryAnalysisWorkerPidsAfterTerminal = [];
      let prepared = terminalProof.prepared;
      let canonicalBaselineDoneMs = null;
      let canonicalBaselinePreparation = null;
      const handoff = validatePreparationHandoff(live, readyPayload, donePayload);
      let navigation = null;
      if (variant === "progressive") {
        await page.waitForURL((candidate) =>
          candidate.pathname === "/view"
          && candidate.searchParams.get("partial") === "1"
          && candidate.searchParams.get("pair") === provisional.pairId,
        { timeout: options.prepareTimeoutMs });
        navigation = await boundedOperation(
          navigationObserver.promise,
          options.prepareTimeoutMs,
          "cold progressive recording observed no main-document /view request",
        );
        const expected = new URL(provisional.viewUrl, ownedService.baseUrl);
        if (navigation.viewUrl !== `${expected.pathname}${expected.search}`) {
          throw new Error("cold progressive recording navigated to an unexpected provisional view");
        }
      } else {
        const canonicalPreparation = await prepareCanonicalBaseline(live, prepared, {
          baseUrl: ownedService.baseUrl,
          timelineStartedAt: coldStarted,
        });
        prepared = validateCanonicalBaselineTerminal(
          live,
          canonicalPreparation.events.at(-1)?.payload,
        );
        canonicalBaselineDoneMs = canonicalPreparation.totalMs;
        canonicalBaselinePreparation = {
          progressive: false,
          httpStatus: canonicalPreparation.httpStatus,
          terminal: canonicalPreparation.events.at(-1)?.payload,
        };
        const fullUrl = new URL(prepared.viewUrl, ownedService.baseUrl).href;
        const response = await page.goto(fullUrl, {
          waitUntil: "domcontentloaded",
          timeout: options.timeoutMs,
        });
        if (response === null || !response.ok()) {
          throw new Error(`cold full recording navigation failed with HTTP ${response?.status() ?? "no response"}`);
        }
        navigation = await boundedOperation(
          navigationObserver.promise,
          options.timeoutMs,
          "cold full recording observed no main-document /view request",
        );
        const expected = new URL(fullUrl);
        if (navigation.viewUrl !== `${expected.pathname}${expected.search}`) {
          throw new Error("cold full recording navigated to an unexpected baseline view");
        }
      }
      await page.waitForFunction(
        () => window.__MERIDIAN_POC_FIRST_ACTIONABLE__?.atMs !== null,
        null,
        { polling: "raf", timeout: options.timeoutMs },
      );
      await assertReviewShellVisible(page);
      let continuationProof = null;
      if (variant === "progressive") {
        const networkBeforeDwell = tracker.snapshot();
        const workerActivity = await sampleDwellWorkerActivity(
          page,
          ownedService.pid,
          options.videoDwellMs,
        );
        await captures.settle(options.timeoutMs);
        const marks = await page.evaluate(() => performance.getEntriesByType("mark").map((entry) => ({
          name: entry.name,
          startTimeMs: entry.startTime,
          detail: entry.detail ?? null,
        })));
        const network = tracker.snapshot();
        assertNoFullAnalyzeRequests(captures.analyzeRequests, "cold progressive recording");
        continuationProof = partialOnlyContinuationEvidence({
          terminalProof,
          canonicalGraphRequests: network.byPath?.["/api/graph"]?.requests ?? 0,
          canonicalGraphResponses: captures.graphResponses.length,
          canonicalReconciliationMarks: marks
            .filter((entry) => entry.name === CANONICAL_RECONCILED_MARK).length,
          repositoryAnalysisWorkerPidsAfterTerminal:
            terminalProof.repositoryAnalysisWorkerPidsAfterTerminal,
          boundedPartialWorkerPidsAtDwellStart: workerActivity.repositoryAnalysisWorkerPidsAtStart,
          graphProjectWorkerPidsAtDwellStart: workerActivity.graphProjectWorkerPidsAtStart,
          boundedPartialWorkerPidsDuringDwell: workerActivity.repositoryAnalysisWorkerPidsObserved,
          graphProjectWorkerPidsDuringDwell: workerActivity.graphProjectWorkerPidsObserved,
          preDwellGraphWork: graphWorkEvidence(networkBeforeDwell),
          postReadyGraphWork: graphWorkDeltaEvidence(network, networkBeforeDwell),
          postTerminalDwellMs: options.videoDwellMs,
          processSampleCount: workerActivity.processSampleCount,
        });
        await addRecordingBadge(page, "Partial terminal reached · no full graph running");
        await page.waitForTimeout(options.videoDwellMs);
      } else {
        await page.waitForTimeout(options.videoDwellMs);
        await addRecordingBadge(page, "Full graph baseline ready · review opened");
        await page.waitForTimeout(options.videoDwellMs);
      }
      const firstActionable = await page.evaluate(() => window.__MERIDIAN_POC_FIRST_ACTIONABLE__);
      const navigationStartedMs = roundMs(navigation.startedAtMonotonicMs - coldStarted);
      return {
        isolation: {
          freshCache: true,
          loopbackOnly: true,
          servicePid: ownedService.pid,
          serviceInstanceId: ownedService.serviceInstanceId,
          cacheInstanceId: ownedService.cacheInstanceId,
          fullBaselineCapability: ownedService.fullBaselineCapability,
          cleanup: ownedService.cleanupEvidence,
        },
        flow: variant === "progressive"
          ? options.partialRuntimeOnly
            ? "partial-ready-navigation-with-independent-terminal-drain"
            : "partial-ready-terminal-then-navigation"
          : "canonical-baseline-done-then-navigation",
        exactRevision: {
          ...exactRevisionEvidence(prepared),
          preparedBaseSha: prepared.baseSha,
          baseTipDrift: false,
        },
        handoff,
        terminalProof,
        continuationProof,
        analyzeRequests: captures.analyzeRequests.map((entry) => ({ ...entry })),
        ...(options.partialRuntimeOnly ? {} : { canonicalBaselinePreparation }),
        navigation: {
          source: navigation.source,
          viewUrl: navigation.viewUrl,
          startedMs: navigationStartedMs,
        },
        timings: {
          provisionalReadyObservedMs: roundMs(readyObservedAtMs - coldStarted),
          partialTerminalDoneMs: preparation.totalMs,
          navigationStartedMs,
          firstActionableBrowserMs: roundMs(firstActionable.atMs),
          ...(options.partialRuntimeOnly ? {} : {
            canonicalBaselineDoneMs,
            canonicalReconciledBrowserMs: null,
          }),
        },
        ...(options.partialRuntimeOnly ? {} : { reconciliation: null }),
      };
    } finally {
      navigationObserver?.dispose();
      tracker?.dispose();
      await context?.close().catch(() => undefined);
      await browser.close().catch(() => undefined);
      if (video !== undefined && video !== null) {
        const generatedPath = await video.path();
        await rename(generatedPath, videoPath);
      }
      await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  });
}

async function addRecordingBadge(page, label) {
  await page.evaluate((text) => {
    document.getElementById("meridian-poc-recording-badge")?.remove();
    const badge = document.createElement("div");
    badge.id = "meridian-poc-recording-badge";
    badge.textContent = text;
    Object.assign(badge.style, {
      position: "fixed",
      zIndex: "2147483647",
      top: "18px",
      left: "50%",
      transform: "translateX(-50%)",
      padding: "9px 14px",
      border: "1px solid rgba(124, 185, 255, .7)",
      borderRadius: "999px",
      background: "rgba(8, 14, 22, .92)",
      color: "#edf6ff",
      font: "700 13px/1.2 ui-sans-serif, system-ui, sans-serif",
      boxShadow: "0 8px 28px rgba(0, 0, 0, .38)",
      pointerEvents: "none",
    });
    document.body.append(badge);
  }, label);
}

/**
 * Full-control pages still perform the product's exact-revision revalidation after navigation.
 * Keep that request inside the same controlled benchmark lane without teaching the renderer a
 * production escape hatch: only a full benchmark browser context receives the marker.
 */
export async function installFullBaselineBenchmarkCapability(context, baseUrl, enabled) {
  if (!enabled) return;
  if (options?.partialRuntimeOnly === true) {
    throw new Error("partial-runtime-only evidence forbids installing the full-baseline capability");
  }
  const expectedOrigin = new URL(baseUrl).origin;
  await context.route("**/api/pr/analyze", async (route) => {
    const request = route.request();
    const candidate = new URL(request.url());
    if (
      candidate.origin === expectedOrigin
      && candidate.pathname === "/api/pr/analyze"
      && request.method() === "POST"
    ) {
      await route.continue({
        headers: {
          ...await request.allHeaders(),
          [PR_FULL_BASELINE_BENCHMARK_HEADER]: PR_FULL_BASELINE_BENCHMARK_CAPABILITY,
        },
      });
      return;
    }
    await route.continue();
  });
}

async function openReviewPage({
  url,
  prepared,
  videoDirectory,
  baseUrl = options.baseUrl,
  servicePid = serviceProcess.pid,
}) {
  const chromiumArgs = [
    "--disable-dev-shm-usage",
    "--disable-background-networking",
    "--enable-precise-memory-info",
  ];
  if (isLoopbackUrl(baseUrl)) chromiumArgs.unshift("--no-sandbox");
  const browser = await chromium.launch({
    headless: !options.headed,
    args: chromiumArgs,
  });
  let context;
  let memorySampler;
  try {
    context = await browser.newContext({
      viewport: options.viewport,
      deviceScaleFactor: 1,
      reducedMotion: "reduce",
      ...(videoDirectory === null ? {} : {
        recordVideo: { dir: videoDirectory, size: options.viewport },
      }),
    });
    await installFullBaselineBenchmarkCapability(
      context,
      baseUrl,
      prepared.completeness === "complete",
    );
    await context.addInitScript(firstActionableObserver);
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    const browserCdp = await browser.newBrowserCDPSession();
    await cdp.send("Network.enable");
    await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
    await cdp.send("Performance.enable");
    const tracker = networkTracker(cdp, new URL(baseUrl).origin);
    const captures = captureResponses(page, new URL(baseUrl).origin);
    const chromiumVersion = browser.version();
    memorySampler = startMemorySampler(page, cdp, browserCdp, servicePid);

    const navigationStartedMonotonicMs = performance.now();
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: options.timeoutMs });
    if (response === null || !response.ok()) {
      throw new Error(`review navigation failed with HTTP ${response?.status() ?? "no response"}`);
    }
    await page.waitForFunction(
      () => window.__MERIDIAN_POC_FIRST_ACTIONABLE__?.atMs !== null,
      null,
      { polling: "raf", timeout: options.timeoutMs },
    );
    const actionable = await page.evaluate(() => window.__MERIDIAN_POC_FIRST_ACTIONABLE__);
    const firstActionableEpochMs = await page.evaluate(
      (atMs) => performance.timeOrigin + atMs,
      actionable.atMs,
    );
    captures.setFirstActionableEpochMs(firstActionableEpochMs);
    await assertReviewShellVisible(page);
    tracker.reconcileResourceTimings(await graphResourceTimingEvidence(page));
    const networkAtAction = tracker.snapshot();
    const domAtAction = await domSnapshot(page);
    const sceneAtAction = await sceneSnapshot(page);
    const memoryAtAction = await memorySnapshot(page, cdp, browserCdp, servicePid);
    memorySampler.record(memoryAtAction);

    const settledMs = await waitForReviewSettled(page, options.timeoutMs);
    tracker.reconcileResourceTimings(await graphResourceTimingEvidence(page));
    const networkSettled = tracker.snapshot();
    const domSettled = await domSnapshot(page);
    const sceneSettled = await sceneSnapshot(page);
    const memorySettled = await memorySnapshot(page, cdp, browserCdp, servicePid);
    memorySampler.record(memorySettled);
    await captures.settle(options.timeoutMs);
    const navigation = await page.evaluate(() => {
      const entry = performance.getEntriesByType("navigation")[0];
      if (!(entry instanceof PerformanceNavigationTiming)) return null;
      return {
        responseStartMs: entry.responseStart,
        domContentLoadedMs: entry.domContentLoadedEventEnd,
        loadMs: entry.loadEventEnd,
        transferSize: entry.transferSize,
        encodedBodySize: entry.encodedBodySize,
        decodedBodySize: entry.decodedBodySize,
      };
    });
    const performanceMarks = await page.evaluate(() => performance.getEntriesByType("mark")
      .filter((entry) => entry.name.startsWith("meridian:"))
      .map((entry) => ({
        name: entry.name,
        startTimeMs: entry.startTime,
        detail: entry.detail ?? null,
      })));
    const exactRevision = validateSampleRevision(prepared, captures.analyzeTerminals);
    assertHealthyPage(captures, url);

    let closed = false;
    let memoryEvidence = null;
    const finishMemorySampling = async () => {
      if (memoryEvidence !== null) return memoryEvidence;
      const retained = await memorySnapshot(page, cdp, browserCdp, servicePid);
      memorySampler.record(retained);
      memoryEvidence = await memorySampler.stop(retained);
      return memoryEvidence;
    };
    return {
      browser,
      context,
      page,
      cdp,
      browserCdp,
      prepared,
      tracker,
      captures,
      chromiumVersion,
      navigationStartedMonotonicMs,
      timings: {
        responseStartMs: roundNullable(navigation?.responseStartMs),
        domContentLoadedMs: roundNullable(navigation?.domContentLoadedMs),
        loadMs: roundNullable(navigation?.loadMs),
        firstActionableMs: roundMs(actionable.atMs),
        settledMs: roundMs(settledMs),
      },
      firstActionableMark: {
        name: FIRST_ACTIONABLE_MARK,
        startTimeMs: roundMs(actionable.atMs),
        detail: actionable.detail ?? null,
        source: actionable.source,
      },
      networkAtAction,
      networkSettled,
      memoryAtAction,
      memorySettled,
      finishMemorySampling,
      domAtAction,
      domSettled,
      sceneAtAction,
      sceneSettled,
      exactRevision,
      reconciliation: null,
      performanceMarks,
      close: async () => {
        if (closed) return;
        closed = true;
        await memorySampler?.stop(memorySettled).catch(() => undefined);
        tracker.dispose();
        await browserCdp.detach().catch(() => undefined);
        await context.close().catch(() => undefined);
        await browser.close().catch(() => undefined);
      },
    };
  } catch (error) {
    await memorySampler?.stop(null).catch(() => undefined);
    await context?.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
    throw error;
  }
}

export async function waitForReviewSettled(page, timeoutMs) {
  await page.waitForLoadState("load", { timeout: timeoutMs });
  await page.waitForFunction(
    (markName) => performance.getEntriesByName(markName, "mark").length > 0,
    NAVIGATION_RESTORED_MARK,
    { polling: "raf", timeout: timeoutMs },
  );
  return page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(resolveFrame)));
    return performance.now();
  });
}

function firstActionableObserver() {
  const state = { atMs: null, detail: null, source: null };
  Object.defineProperty(window, "__MERIDIAN_POC_FIRST_ACTIONABLE__", {
    value: state,
    configurable: false,
    writable: false,
  });
  const accept = (entry) => {
    if (state.atMs !== null) return;
    state.atMs = entry.startTime;
    state.detail = entry.detail ?? null;
    state.source = "performance-mark";
  };
  for (const entry of performance.getEntriesByName("meridian:first-actionable-canvas", "mark")) accept(entry);
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (entry.name === "meridian:first-actionable-canvas") accept(entry);
    }
  });
  observer.observe({ type: "mark", buffered: true });
}

async function assertReviewShellVisible(page) {
  await page.waitForFunction(() => {
    const visible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0
        && rect.height > 0
        && style.visibility !== "hidden"
        && style.display !== "none";
    };
    return visible(document.querySelector('nav[aria-label="Pull request review navigation"]'))
      && visible(document.querySelector('[data-review-files-scroll="true"]'))
      && visible(document.querySelector(".react-flow"));
  }, null, { polling: "raf", timeout: options.timeoutMs });
  await page.evaluate(() => new Promise((resolveFrame) => {
    requestAnimationFrame(() => requestAnimationFrame(resolveFrame));
  }));
}

export function captureResponses(page, expectedOrigin) {
  const origin = new URL(expectedOrigin).origin;
  const tasks = [];
  const captureErrors = [];
  const analyzeTerminals = [];
  const analyzeRequests = [];
  const projections = [];
  const projectionResponses = [];
  const graphResponses = [];
  const warmResponses = [];
  const symbolResponses = [];
  const pageErrors = [];
  const consoleErrors = [];
  const failedApiResponses = [];
  const symbolRequestRecords = new WeakMap();
  const warmRequestRecords = new WeakMap();
  let firstActionableEpochMs = null;
  let harnessSymbolInteractionStarted = false;

  const trackResponseBody = (response, path, task) => {
    const record = {
      label: responseCaptureLabel(response, path),
      settled: false,
      promise: null,
    };
    record.promise = task.finally(() => {
      record.settled = true;
    });
    tasks.push(record);
  };

  page.on("pageerror", (error) => pageErrors.push(redactSecrets(error.message)));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(redactSecrets(message.text()).slice(0, 2_000));
  });
  page.on("request", (request) => {
    let url;
    try {
      url = new URL(request.url());
    } catch {
      return;
    }
    if (url.origin !== origin) return;
    if (url.pathname === "/api/pr/analyze") {
      let headers = {};
      try {
        headers = request.headers();
      } catch {
        captureErrors.push("analyze request headers were unavailable");
      }
      const body = parseRequestJson(request);
      analyzeRequests.push({
        method: request.method(),
        progressiveFalse: body?.progressive === false,
        fullBaselineCapabilityHeaderPresent:
          headers[PR_FULL_BASELINE_BENCHMARK_HEADER] !== undefined,
      });
    }
    if (url.pathname === "/api/graph/symbols") {
      const timing = request.timing();
      const record = {
        graphId: url.searchParams.get("id"),
        method: request.method(),
        requestStartedEpochMs: Number.isFinite(timing?.startTime) ? timing.startTime : null,
        initiatedBy: harnessSymbolInteractionStarted ? "harness" : "renderer-background",
        status: null,
      };
      symbolRequestRecords.set(request, record);
      symbolResponses.push(record);
      return;
    }
    if (url.pathname === "/api/graph/project/warm") {
      let headers = {};
      try {
        headers = request.headers();
      } catch {
        captureErrors.push("warm request headers were unavailable");
      }
      const timing = request.timing();
      const body = parseRequestJson(request);
      const record = {
        request: body,
        version: body?.version ?? null,
        graphId: body?.graphId ?? null,
        rootsKind: body?.roots?.kind ?? null,
        seedGraphId: body?.roots?.seedGraphId ?? null,
        requestedDepth: finiteOrNull(body?.requestedDepth),
        prefetchDepth: finiteOrNull(body?.prefetchDepth),
        method: request.method(),
        path: url.pathname,
        requestStartedEpochMs: Number.isFinite(timing?.startTime) ? timing.startTime : null,
        initiatedBy: headers[HARNESS_WARM_PROOF_HEADER] === "1"
          ? "harness-proof"
          : "renderer-background",
        responseBodyRead: false,
        status: null,
        contentType: null,
        cacheControl: null,
      };
      warmRequestRecords.set(request, record);
      warmResponses.push(record);
    }
  });
  page.on("response", (response) => {
    let url;
    try {
      url = new URL(response.url());
    } catch {
      return;
    }
    if (url.origin !== origin) return;
    if (response.status() >= 400 && CRITICAL_API_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))) {
      failedApiResponses.push({ path: url.pathname, status: response.status() });
    }
    if (url.pathname === "/api/pr/analyze") {
      const task = response.text().then((text) => {
        const lines = parseNdjsonText(text);
        const terminal = lines.at(-1);
        if (terminal) analyzeTerminals.push(terminal);
      }).catch((error) => captureErrors.push(redactSecrets(error?.message ?? error)));
      trackResponseBody(response, url.pathname, task);
    } else if (url.pathname === "/api/graph") {
      graphResponses.push({
        graphId: url.searchParams.get("id"),
        method: response.request().method(),
        status: response.status(),
      });
    } else if (url.pathname === "/api/graph/symbols") {
      const request = response.request();
      const record = symbolRequestRecords.get(request);
      if (record === undefined) {
        captureErrors.push("symbol response had no correlated request evidence");
      } else {
        // Playwright can expose an incomplete request timing object from the early `request` event.
        // Re-read it once response headers arrive, when Chromium has finalized startTime. Without
        // this refresh a successfully accepted background index can be misclassified as pre-action
        // (typically because the provisional value was -1) and the recording waits until timeout.
        const timing = request.timing();
        if (Number.isFinite(timing?.startTime) && timing.startTime >= 0) {
          record.requestStartedEpochMs = timing.startTime;
        }
        // The renderer owns this response body, often through a short-lived Web Worker. A second
        // Playwright-side response.json() can remain pending after that worker consumes/terminates,
        // even though Chromium and the service have no live socket. Capture transport provenance
        // only; the renderer readiness mark proves acceptance, and the showcase performs one later
        // harness-owned fetch to obtain the cached symbols used for its disconnected-node action.
        record.status = response.status();
      }
    } else if (url.pathname === "/api/graph/project/warm") {
      const record = warmRequestRecords.get(response.request());
      if (record === undefined) {
        captureErrors.push("warm response had no correlated request evidence");
      } else {
        const timing = response.request().timing();
        if (Number.isFinite(timing?.startTime)) record.requestStartedEpochMs = timing.startTime;
        let headers = {};
        try {
          headers = response.headers();
        } catch {
          captureErrors.push("warm response headers were unavailable");
        }
        // The renderer owns this small response. Playwright must never duplicate-read it: Chromium
        // can leave response.json() pending after the application fetch completes. A separately
        // tagged harness replay below obtains the opaque key from its own response body.
        record.status = response.status();
        record.contentType = headers["content-type"] ?? null;
        record.cacheControl = headers["cache-control"] ?? null;
      }
    } else if (url.pathname === "/api/graph/project") {
      const projectionRequest = response.request();
      let requestHeaders = {};
      try {
        requestHeaders = projectionRequest.headers();
      } catch {
        captureErrors.push("projection request headers were unavailable");
      }
      if (requestHeaders[HARNESS_PROJECTION_PROOF_HEADER] === "1") return;
      const requestBody = parseRequestJson(projectionRequest);
      const requestTiming = projectionRequest.timing();
      let headers = {};
      try {
        headers = response.headers();
      } catch {
        captureErrors.push("projection response headers were unavailable");
      }
      // This is the renderer's response stream. A second Playwright response.json() races Chromium's
      // body eviction after the application has consumed it (and can fail with Network.getResponseBody
      // even though the renderer parsed the projection successfully). Keep measurement bodyless just
      // like warm/symbol capture: the exact request, status/cache provenance headers, and the
      // renderer-owned progressive-ready mark together attest delivery and acceptance without adding
      // another decode or buffer to the memory/timing sample.
      const record = {
        request: requestBody,
        method: projectionRequest.method(),
        path: url.pathname,
        status: response.status(),
        requestStartedEpochMs: finiteOrNull(requestTiming?.startTime),
        headers,
        projection: null,
        responseBodyRead: false,
        source: "request-and-response-headers",
      };
      projectionResponses.push(record);
      projections.push(projectionEvidence(record));
    }
  });

  return {
    analyzeTerminals,
    analyzeRequests,
    graphResponses,
    projections,
    projectionResponses,
    warmResponses,
    symbolResponses,
    pageErrors,
    consoleErrors,
    failedApiResponses,
    setFirstActionableEpochMs(value) {
      if (Number.isFinite(value)) firstActionableEpochMs = value;
    },
    getFirstActionableEpochMs() {
      return firstActionableEpochMs;
    },
    markHarnessSymbolInteractionStarted() {
      harnessSymbolInteractionStarted = true;
    },
    rendererSymbolResponse(graphId) {
      return symbolResponses.find((entry) =>
        entry.initiatedBy === "renderer-background"
        && entry.graphId === graphId
        && entry.method === "GET"
        && entry.status === 200
        && Number.isFinite(firstActionableEpochMs)
        && Number.isFinite(entry.requestStartedEpochMs)
        && entry.requestStartedEpochMs + 0.5 >= firstActionableEpochMs,
      ) ?? null;
    },
    harnessSymbolResponse(graphId) {
      return symbolResponses.find((entry) =>
        entry.initiatedBy === "harness"
        && entry.graphId === graphId
        && entry.method === "GET"
        && entry.status === 200,
      ) ?? null;
    },
    async settle(timeoutMs) {
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
        throw new TypeError("captured response body drain timeout must be a positive integer");
      }
      let timer = null;
      const timedOut = new Promise((_, reject) => {
        timer = setTimeout(() => reject(captureDrainTimeoutError(timeoutMs, tasks)), timeoutMs);
      });
      let priorCount = -1;
      try {
        while (priorCount !== tasks.length) {
          priorCount = tasks.length;
          await Promise.race([
            Promise.all(tasks.slice(0, priorCount).map((task) => task.promise)),
            timedOut,
          ]);
          // Response handlers can append another body task while the current batch resolves. Give
          // those promise callbacks a turn, then repeat until the observed task count is stable.
          await Promise.resolve();
        }
      } finally {
        if (timer !== null) clearTimeout(timer);
      }
      if (captureErrors.length > 0) throw new Error(`could not capture a critical response body: ${captureErrors[0]}`);
    },
  };
}

function responseCaptureLabel(response, path) {
  let method = "REQUEST";
  try {
    const candidate = response.request().method();
    if (typeof candidate === "string" && /^[A-Z]{1,16}$/.test(candidate)) method = candidate;
  } catch {
    // A static route label is still enough to diagnose a malformed Playwright response object.
  }
  let status = "unknown";
  try {
    const candidate = response.status();
    if (Number.isSafeInteger(candidate) && candidate >= 100 && candidate <= 599) status = String(candidate);
  } catch {
    // Preserve the route/method diagnostic when status extraction itself fails.
  }
  return redactSecrets(`${method} ${path} (HTTP ${status})`).slice(0, 240);
}

function captureDrainTimeoutError(timeoutMs, tasks) {
  const pending = tasks.filter((task) => !task.settled);
  const shown = pending.slice(0, 5).map((task) => task.label);
  const omitted = pending.length - shown.length;
  const noun = pending.length === 1 ? "task" : "tasks";
  const summary = shown.length === 0 ? "none observed" : shown.join(", ");
  return new Error(
    `captured response body drain timed out after ${timeoutMs} ms with ${pending.length} pending ${noun}: ${summary}`
      + (omitted > 0 ? `, and ${omitted} more` : ""),
  );
}

function parseRequestJson(request) {
  try {
    return request.postDataJSON();
  } catch {
    return null;
  }
}

function assertHealthyPage(captures, url) {
  if (captures.pageErrors.length > 0) {
    throw new Error(`review page raised ${captures.pageErrors.length} error(s): ${captures.pageErrors[0]}`);
  }
  if (captures.failedApiResponses.length > 0) {
    const failure = captures.failedApiResponses[0];
    throw new Error(`critical API ${failure.path} returned HTTP ${failure.status} while opening ${url}`);
  }
}

async function proveNextDepthCacheReadiness(opened, prepared) {
  const { page, captures } = opened;
  const expectedGraphIds = new Set([prepared.graphId, prepared.comparisonGraphId]);
  const deadline = Date.now() + options.timeoutMs;
  // Only the exact prepared changed-files pair establishes the initial depth boundary. Later
  // file/file-path hydration responses share this capture stream but are independent bounded
  // projections; admitting them here would let an otherwise valid depth-0 search hydration poison
  // the causal next-depth proof. The selector remains fail-closed for missing, duplicate, malformed,
  // or wrong-key initial HEAD/comparison responses.
  const initialRequests = assertInitialProjectionCacheHits(
    captures.projectionResponses,
    prepared,
  );
  const initialDepths = new Map();
  for (const entry of initialRequests) {
    const prior = initialDepths.get(entry.graphId);
    if (Number.isSafeInteger(entry.requestedDepth)
      && (prior === undefined || entry.requestedDepth > prior)) {
      initialDepths.set(entry.graphId, entry.requestedDepth);
    }
  }
  let candidates = [];
  while (Date.now() < deadline) {
    await captures.settle(remainingTimeoutMs(deadline));
    const firstActionableEpochMs = captures.getFirstActionableEpochMs();
    const exactRendererResponses = captures.warmResponses.filter((entry) =>
      entry?.initiatedBy === "renderer-background"
      && entry?.status !== null
      && Number.isFinite(firstActionableEpochMs)
      && Number.isFinite(entry?.requestStartedEpochMs)
      && entry.requestStartedEpochMs >= firstActionableEpochMs
      && matchesExactWarmRequest(entry?.request, prepared)
      && Number.isSafeInteger(entry.request.requestedDepth)
      && entry.request.requestedDepth > (initialDepths.get(entry.request.graphId) ?? -1),
    );
    const firstByGraph = new Map();
    for (const entry of exactRendererResponses) {
      if (!firstByGraph.has(entry.request.graphId)) firstByGraph.set(entry.request.graphId, entry);
    }
    // Freeze the two application-owned observations before issuing any tagged harness replay.
    candidates = [...firstByGraph.values()].map((entry) => structuredClone(entry));
    if (candidates.length === expectedGraphIds.size) break;
    await page.waitForTimeout(100);
  }

  const observedGraphIds = new Set(candidates.map((entry) => entry.request.graphId));
  const missingGraphIds = [...expectedGraphIds].filter((graphId) => !observedGraphIds.has(graphId));
  if (missingGraphIds.length > 0) {
    return diagnosticCacheEvidence(
      candidates,
      `no next-depth warm request was observed for ${missingGraphIds.length} exact graph revision(s)`,
      [],
      captures,
      initialRequests,
    );
  }

  const phasedProof = await proveFrozenWarmCandidates(candidates, deadline, {
    replayWarm: (candidate) => requestProjectionWarmWithProvenance(page, candidate.request),
    waitUntilReady: (_candidate, key) => waitForProjectionWarm(page, key, deadline),
    requestCritical: (candidate) => requestProjectionWithProvenance(page, candidate.request),
  });
  const probes = phasedProof.probes;
  if (phasedProof.diagnostic !== null) {
    return diagnosticCacheEvidence(
      candidates,
      phasedProof.diagnostic,
      probes,
      captures,
      initialRequests,
    );
  }
  await captures.settle(remainingTimeoutMs(deadline));
  const evidence = {
    rendererCapture: {
      firstActionableEpochMs: captures.getFirstActionableEpochMs(),
      rendererResponseBodiesRead: false,
    },
    initialRequests,
    warmRequests: candidates.map(sanitizeWarmEvidence),
    probes,
  };
  try {
    return {
      ...evidence,
      cacheReadiness: deriveCausalWarmReadinessEvidence(evidence, prepared),
    };
  } catch (error) {
    return {
      ...evidence,
      cacheReadiness: diagnosticCacheReadiness(
        `the renderer warm chain was not causal: ${redactSecrets(error?.message ?? error)}`,
      ),
    };
  }
}

/** Prove a frozen pair of renderer warms without letting the harness's critical projection reads
 * preempt an asymmetrically slower renderer warm. All tagged replays acquire their opaque keys
 * first, all keys become ready second, and only then may any critical request be issued. */
export async function proveFrozenWarmCandidates(candidates, deadline, operations) {
  const probes = [];
  if (candidates.some((candidate) => candidate.status !== 202)) {
    return {
      probes,
      diagnostic: "a renderer-owned exact warm request was a preexisting hit instead of initiated or coalesced work",
    };
  }

  const confirmations = await Promise.all(candidates.map((candidate) => operations.replayWarm(candidate)));
  for (const [index, candidate] of candidates.entries()) {
    const confirmation = confirmations[index];
    const key = confirmation?.body?.key;
    probes.push({
      graphId: candidate.request.graphId,
      requestedDepth: candidate.request.requestedDepth,
      prefetchDepth: candidate.request.prefetchDepth,
      warm: {
        rendererStatus: candidate.status,
        rendererResponseBodyRead: false,
        confirmationBodyOwner: "harness-proof-page-fetch",
        confirmationStatus: confirmation?.status ?? null,
        version: confirmation?.body?.version ?? null,
        key: typeof key === "string" ? key : null,
        accepted: confirmation?.body?.accepted === true,
        completed: confirmation?.body?.completed === true,
        cache: confirmation?.body?.cache ?? null,
      },
      readiness: null,
      request: null,
    });
  }

  for (const [index, confirmation] of confirmations.entries()) {
    const key = confirmation?.body?.key;
    const warmObserved = (confirmation?.status === 200 || confirmation?.status === 202)
      && confirmation?.body?.version === 1
      && typeof key === "string"
      && /^[a-f0-9]{64}$/.test(key);
    if (!warmObserved) {
      return {
        probes,
        diagnostic: "the harness-owned exact warm replay did not acknowledge a bounded cache key",
      };
    }
    const replayCoalesced = confirmation.status === 202
      && confirmation.body.accepted === false
      && confirmation.body.completed === false
      && confirmation.body.cache === "coalesced";
    const replayHit = confirmation.status === 200
      && confirmation.body.accepted === false
      && confirmation.body.completed === true
      && confirmation.body.cache === "hit";
    if (!replayCoalesced && !replayHit) {
      return {
        probes,
        diagnostic: "the harness-owned exact warm replay started replacement work or returned a malformed disposition",
      };
    }
    probes[index].warm.key = key;
  }

  const readiness = await Promise.all(probes.map((probe, index) =>
    operations.waitUntilReady(candidates[index], probe.warm.key, deadline)));
  for (const [index, status] of readiness.entries()) probes[index].readiness = status;
  if (readiness.some((status, index) =>
    status?.completed !== true || status?.key !== probes[index].warm.key)) {
    return {
      probes,
      diagnostic: "an exact warm replay key did not complete",
    };
  }

  const criticalRequests = await Promise.all(candidates.map((candidate) =>
    operations.requestCritical(candidate)));
  for (const [index, request] of criticalRequests.entries()) probes[index].request = request;
  return { probes, diagnostic: null };
}

async function requestProjectionWarmWithProvenance(page, request) {
  return page.evaluate(async ({ body, proofHeader }) => {
    const response = await fetch("/api/graph/project/warm", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "content-type": "application/json",
        [proofHeader]: "1",
      },
      body: JSON.stringify(body),
    });
    let responseBody = null;
    try {
      responseBody = await response.json();
    } catch {
      // The caller validates the versioned body and will retain diagnostic-only evidence.
    }
    return { status: response.status, body: responseBody };
  }, { body: request, proofHeader: HARNESS_WARM_PROOF_HEADER });
}

async function waitForProjectionWarm(page, key, deadline) {
  for (;;) {
    const status = await page.evaluate(async (cacheKey) => {
      const response = await fetch(`/api/graph/project/warm/status?key=${encodeURIComponent(cacheKey)}`, {
        credentials: "same-origin",
      });
      let body = null;
      try {
        body = await response.json();
      } catch {
        // The returned status below is sufficient to surface an old or malformed server contract.
      }
      return { status: response.status, body };
    }, key);
    if (
      status.status === 200
      && status.body?.version === 1
      && status.body?.key === key
      && status.body?.completed === true
    ) {
      return { status: status.status, completed: true, key };
    }
    if (status.status !== 202 || status.body?.key !== key || status.body?.completed !== false) {
      return { status: status.status, completed: false, key };
    }
    if (Date.now() >= deadline) return { status: status.status, completed: false, key };
    await page.waitForTimeout(100);
  }
}

async function requestProjectionWithProvenance(page, request) {
  return page.evaluate(async ({ body, cacheHeader, keyHeader, readyHeader, proofHeader }) => {
    const response = await fetch("/api/graph/project", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", [proofHeader]: "1" },
      body: JSON.stringify(body),
    });
    let projection = null;
    try {
      projection = await response.json();
    } catch {
      // Preserve the response metadata so the harness can diagnose a malformed deployment.
    }
    return {
      status: response.status,
      cache: response.headers.get(cacheHeader),
      key: response.headers.get(keyHeader),
      ready: response.headers.get(readyHeader) === "true",
      graphId: projection?.graphId ?? null,
      seedGraphId: projection?.seedGraphId ?? null,
      loadedDepth: projection?.loadedDepth ?? null,
    };
  }, {
    body: request,
    cacheHeader: PROJECTION_CACHE_HEADER,
    keyHeader: PROJECTION_KEY_HEADER,
    readyHeader: PROJECTION_READY_HEADER,
    proofHeader: HARNESS_PROJECTION_PROOF_HEADER,
  });
}

function diagnosticCacheEvidence(
  candidates,
  diagnostic,
  probes = [],
  captures = null,
  initialRequests = null,
) {
  return {
    rendererCapture: {
      firstActionableEpochMs: captures?.getFirstActionableEpochMs?.() ?? null,
      rendererResponseBodiesRead: false,
    },
    initialRequests: initialRequests ?? captures?.projectionResponses?.map(sanitizeProjectionResponse) ?? [],
    warmRequests: candidates.map(sanitizeWarmEvidence),
    probes,
    cacheReadiness: diagnosticCacheReadiness(diagnostic, candidates.length > 0),
  };
}

function diagnosticCacheReadiness(diagnostic, warmObserved = true) {
  return {
    warmObserved,
    cacheReady: false,
    speculativeWorkAcceptedOrCoalesced: false,
    nextDepthCacheHit: false,
    causalWarmReadyHit: false,
    authoritative: false,
    rendererTransportBodyless: true,
    keyAcquiredByHarnessReplay: false,
    diagnostic,
  };
}

function sanitizeProjectionResponse(entry) {
  const request = entry?.request;
  const projection = entry?.projection;
  const ready = entry?.headers?.[PROJECTION_READY_HEADER] === "true";
  return {
    graphId: projection?.graphId ?? request?.graphId ?? null,
    seedGraphId: projection?.seedGraphId ?? request?.roots?.seedGraphId ?? null,
    requestedDepth: finiteOrNull(projection?.requestedDepth ?? request?.requestedDepth),
    prefetchDepth: finiteOrNull(projection?.prefetchDepth ?? request?.prefetchDepth),
    // Body-only diagnostics intentionally stay unknown in the measurement lane. Exact request/key
    // provenance plus the renderer-owned acceptance/action marks are the publication contract.
    loadedDepth: finiteOrNull(projection?.loadedDepth),
    method: entry?.method ?? null,
    path: entry?.path ?? null,
    status: entry?.status ?? null,
    cache: entry?.headers?.[PROJECTION_CACHE_HEADER] ?? null,
    key: entry?.headers?.[PROJECTION_KEY_HEADER] ?? null,
    ready,
    responseBodyRead: entry?.responseBodyRead === false ? false : null,
    source: entry?.source ?? null,
  };
}

function sanitizeWarmEvidence(entry) {
  return {
    graphId: entry?.graphId ?? null,
    version: entry?.version ?? null,
    rootsKind: entry?.rootsKind ?? null,
    seedGraphId: entry?.seedGraphId ?? null,
    requestedDepth: finiteOrNull(entry?.requestedDepth),
    prefetchDepth: finiteOrNull(entry?.prefetchDepth),
    method: entry?.method ?? null,
    path: entry?.path ?? null,
    requestStartedEpochMs: finiteOrNull(entry?.requestStartedEpochMs),
    initiatedBy: entry?.initiatedBy ?? null,
    responseBodyRead: entry?.responseBodyRead === false ? false : null,
    status: entry?.status ?? null,
    contentType: entry?.contentType ?? null,
    cacheControl: entry?.cacheControl ?? null,
  };
}

async function graphResourceTimingEvidence(page) {
  return page.evaluate((graphPaths) => {
    const allowed = new Set(graphPaths);
    return {
      timeOriginMs: performance.timeOrigin,
      entries: performance.getEntriesByType("resource").flatMap((candidate) => {
        if (!(candidate instanceof PerformanceResourceTiming)) return [];
        let url;
        try {
          url = new URL(candidate.name);
        } catch {
          return [];
        }
        if (url.origin !== location.origin || !allowed.has(url.pathname)) return [];
        return [{
          name: candidate.name,
          entryType: candidate.entryType,
          initiatorType: candidate.initiatorType,
          startTimeMs: candidate.startTime,
          responseStartMs: candidate.responseStart,
          responseEndMs: candidate.responseEnd,
          transferSize: candidate.transferSize,
          encodedBodySize: candidate.encodedBodySize,
          decodedBodySize: candidate.decodedBodySize,
          responseStatus: Number.isFinite(candidate.responseStatus)
            ? candidate.responseStatus
            : null,
          deliveryType: typeof candidate.deliveryType === "string"
            ? candidate.deliveryType
            : null,
        }];
      }),
    };
  }, [...GRAPH_PATHS]);
}

export function matchesExactWarmRequest(request, prepared) {
  return request !== null
    && typeof request === "object"
    && (request.graphId === prepared.graphId || request.graphId === prepared.comparisonGraphId)
    && request.roots?.kind === "changed-files"
    && request.roots.seedGraphId === prepared.graphId;
}

export function networkTracker(cdp, origin) {
  const expectedOrigin = new URL(origin).origin;
  const active = new Map();
  const hops = [];
  const unattributedAnomalies = [];

  const noteUnattributed = (code) => unattributedAnomalies.push({ code, path: null });
  const noteHop = (hop, code, affectsAuthority = true) => {
    hop.anomalies.push({ code, affectsAuthority });
  };
  const isExpectedGraphHop = (hop) => {
    try {
      const url = new URL(hop.url);
      return url.origin === expectedOrigin
        && ((url.pathname === "/api/graph" && hop.method === "GET")
          || (url.pathname === "/api/graph/project" && hop.method === "POST"));
    } catch {
      return false;
    }
  };
  const startHop = (event) => {
    const wallTimeSeconds = Number(event.wallTime);
    const hop = {
      requestId: event.requestId,
      url: event.request?.url ?? "",
      method: event.request?.method ?? null,
      requestEpochMs: Number.isFinite(wallTimeSeconds) && wallTimeSeconds > 0
        ? wallTimeSeconds * 1_000
        : null,
      status: null,
      mimeType: null,
      responseObserved: false,
      responseEncodedBytes: null,
      dataEncodedBytes: 0,
      dataEventCount: 0,
      contentLength: null,
      terminalEncodedBytes: null,
      state: "in-flight",
      failed: false,
      canceled: false,
      blocked: false,
      errorText: null,
      redirected: false,
      requestIdReused: false,
      cacheSources: new Set(),
      resourceTimingReconciliation: null,
      anomalies: [],
    };
    hops.push(hop);
    active.set(event.requestId, hop);
    return hop;
  };
  const currentHop = (requestId, eventName) => {
    const current = active.get(requestId);
    if (current === undefined) noteUnattributed(`${eventName}-without-request`);
    return current;
  };
  const validByteCount = (value) => Number.isSafeInteger(value) && value >= 0;
  const applyResponse = (hop, response, duplicateIsAnomaly = true, updateEncodedBytes = true) => {
    if (hop.responseObserved && duplicateIsAnomaly) noteHop(hop, "duplicate-response");
    hop.responseObserved = true;
    hop.status = Number.isFinite(response?.status) ? response.status : null;
    hop.mimeType = typeof response?.mimeType === "string" ? response.mimeType : null;
    if (updateEncodedBytes) {
      const encoded = Number(response?.encodedDataLength);
      if (validByteCount(encoded)) hop.responseEncodedBytes = encoded;
      else noteHop(hop, "invalid-response-encoded-length");
    }
    hop.contentLength = responseContentLength(response?.headers);
    if (response?.fromDiskCache === true) hop.cacheSources.add("disk-cache");
    if (response?.fromPrefetchCache === true) hop.cacheSources.add("prefetch-cache");
    if (response?.fromServiceWorker === true) hop.cacheSources.add("service-worker");
  };
  const observedBytes = (hop) => (hop.responseEncodedBytes ?? 0) + hop.dataEncodedBytes;
  const finalizeWithTotal = (hop, total, state) => {
    if (!validByteCount(total)) {
      noteHop(hop, `invalid-${state}-encoded-length`);
      hop.terminalEncodedBytes = null;
    } else {
      hop.terminalEncodedBytes = total;
      if (hop.cacheSources.size === 0 && observedBytes(hop) !== total) {
        // CDP defines loadingFinished/redirect encodedDataLength as the terminal total. Incremental
        // response/data events are explicitly lower-bound observations and may be coalesced or
        // omitted under load. Keep their mismatch visible as a diagnostic, but do not demote the
        // authoritative terminal total or make otherwise identical repetitions flaky.
        noteHop(hop, `${state}-incremental-mismatch`, false);
      }
    }
    hop.state = state;
    active.delete(hop.requestId);
  };
  const onRequest = (event) => {
    const prior = active.get(event.requestId);
    if (event.redirectResponse !== undefined) {
      let redirect = prior;
      if (redirect === undefined) {
        redirect = startHop({
          requestId: event.requestId,
          request: {
            url: event.redirectResponse?.url ?? "",
            method: null,
          },
        });
        noteHop(redirect, "redirect-without-request");
      }
      // redirectResponse.encodedDataLength is the terminal total for the previous hop, not a new
      // response-time baseline to add to any already observed data chunks.
      applyResponse(redirect, event.redirectResponse, false, !redirect.responseObserved);
      redirect.redirected = true;
      finalizeWithTotal(
        redirect,
        Number(event.redirectResponse?.encodedDataLength),
        "redirected",
      );
    } else if (prior !== undefined) {
      // CDP also reuses ids for authentication retries. Preserve the prior hop instead of silently
      // overwriting it; without an explicit redirect total its bytes are only a lower bound.
      prior.requestIdReused = true;
      prior.state = "request-id-reused";
      noteHop(prior, "request-id-reused-without-redirect");
      active.delete(event.requestId);
    }
    startHop(event);
  };
  const onResponse = (event) => {
    const current = currentHop(event.requestId, "response");
    if (!current) return;
    if (current.state !== "in-flight") {
      noteHop(current, "response-after-terminal");
      return;
    }
    applyResponse(current, event.response);
  };
  const onData = (event) => {
    const current = currentHop(event.requestId, "data");
    if (!current) return;
    if (current.state !== "in-flight") {
      noteHop(current, "data-after-terminal");
      return;
    }
    const encoded = Number(event.encodedDataLength);
    if (!validByteCount(encoded)) {
      noteHop(current, "invalid-data-encoded-length");
      return;
    }
    current.dataEncodedBytes += encoded;
    current.dataEventCount += 1;
  };
  const onFinished = (event) => {
    const current = currentHop(event.requestId, "finish");
    if (!current) return;
    if (current.state !== "in-flight") {
      noteHop(current, "duplicate-terminal");
      return;
    }
    // CDP defines this as the total. It replaces, and is never added to or maxed with, chunks.
    finalizeWithTotal(current, Number(event.encodedDataLength), "finished");
  };
  const onFailed = (event) => {
    const current = currentHop(event.requestId, "failure");
    if (!current) return;
    if (current.state !== "in-flight") {
      noteHop(current, "duplicate-terminal");
      return;
    }
    current.failed = true;
    current.canceled = event.canceled === true;
    current.blocked = event.blockedReason !== undefined || event.corsErrorStatus !== undefined;
    current.errorText = typeof event.errorText === "string" ? event.errorText : null;
    current.state = "failed";
    active.delete(event.requestId);
  };
  const onServedFromCache = (event) => {
    const current = currentHop(event.requestId, "cache");
    if (!current) return;
    current.cacheSources.add("memory-cache");
  };
  cdp.on("Network.requestWillBeSent", onRequest);
  cdp.on("Network.responseReceived", onResponse);
  cdp.on("Network.dataReceived", onData);
  cdp.on("Network.loadingFinished", onFinished);
  cdp.on("Network.loadingFailed", onFailed);
  cdp.on("Network.requestServedFromCache", onServedFromCache);

  return {
    reconcileResourceTimings(evidence) {
      const pending = hops.filter((hop) =>
        isExpectedGraphHop(hop)
        && isResourceTimingAbortCandidate(hop)
        && hop.dataEncodedBytes < hop.contentLength
        && hop.resourceTimingReconciliation?.status !== "reconciled");
      if (pending.length === 0) return;
      if (
        evidence === null
        || typeof evidence !== "object"
        || !Number.isFinite(evidence.timeOriginMs)
        || evidence.timeOriginMs <= 0
        || !Array.isArray(evidence.entries)
      ) {
        for (const hop of pending) hop.resourceTimingReconciliation = { status: "invalid-evidence" };
        return;
      }

      const candidateIndexes = new Map();
      const candidateHopCounts = new Map();
      for (const hop of pending) {
        const indexes = [];
        for (let index = 0; index < evidence.entries.length; index += 1) {
          if (!matchesResourceTimingAbort(hop, evidence.entries[index], evidence.timeOriginMs)) continue;
          indexes.push(index);
          candidateHopCounts.set(index, (candidateHopCounts.get(index) ?? 0) + 1);
        }
        candidateIndexes.set(hop, indexes);
      }

      for (const hop of pending) {
        const indexes = candidateIndexes.get(hop) ?? [];
        if (indexes.length === 0) {
          hop.resourceTimingReconciliation = { status: "no-exact-match" };
          continue;
        }
        if (indexes.length !== 1) {
          hop.resourceTimingReconciliation = { status: "ambiguous-timing" };
          continue;
        }
        const index = indexes[0];
        if (candidateHopCounts.get(index) !== 1) {
          hop.resourceTimingReconciliation = { status: "shared-timing" };
          continue;
        }
        const entry = evidence.entries[index];
        hop.resourceTimingReconciliation = {
          status: "reconciled",
          source: "resource-timing-exact-body",
          requestStartDeltaMs: (evidence.timeOriginMs + entry.startTimeMs) - hop.requestEpochMs,
        };
      }
    },
    snapshot() {
      let encodedBytes = 0;
      let graphEncodedBytes = 0;
      let observedEncodedBytes = 0;
      let graphObservedEncodedBytes = 0;
      let requestCount = 0;
      let failedRequestCount = 0;
      let finishedRequestCount = 0;
      let inFlightRequestCount = 0;
      let inFlightGraphRequestCount = 0;
      let canceledRequestCount = 0;
      let blockedRequestCount = 0;
      let cachedRequestCount = 0;
      let redirectRequestCount = 0;
      let requestIdReuseCount = 0;
      let resourceTimingReconciliationAttemptCount = 0;
      let resourceTimingReconciledRequestCount = 0;
      const resourceTimingReconciliationRejections = {};
      const byteAuthoritySources = {};
      let bytesAuthoritative = unattributedAnomalies.length === 0;
      let graphBytesAuthoritative = unattributedAnomalies.length === 0;
      let accountingComplete = true;
      let graphAccountingComplete = true;
      const byPath = {};
      const accountingAnomalies = [...unattributedAnomalies];
      const accountingDiagnostics = [];
      for (const request of hops) {
        let url;
        try {
          url = new URL(request.url);
        } catch {
          continue;
        }
        if (url.origin !== expectedOrigin) continue;
        const isGraph = GRAPH_PATHS.has(url.pathname);
        const resolution = resolveNetworkHopBytes(request);
        const hopAnomalies = request.anomalies.filter(({ affectsAuthority }) => affectsAuthority);
        const hopAuthoritative = resolution.authoritative && hopAnomalies.length === 0;
        requestCount += 1;
        failedRequestCount += Number(request.failed);
        finishedRequestCount += Number(request.state !== "in-flight");
        inFlightRequestCount += Number(request.state === "in-flight");
        inFlightGraphRequestCount += Number(isGraph && request.state === "in-flight");
        canceledRequestCount += Number(request.canceled);
        blockedRequestCount += Number(request.blocked);
        cachedRequestCount += Number(request.cacheSources.size > 0);
        redirectRequestCount += Number(request.redirected);
        requestIdReuseCount += Number(request.requestIdReused);
        if (request.resourceTimingReconciliation !== null) {
          resourceTimingReconciliationAttemptCount += 1;
          if (request.resourceTimingReconciliation.status === "reconciled") {
            resourceTimingReconciledRequestCount += 1;
          } else {
            const status = request.resourceTimingReconciliation.status;
            resourceTimingReconciliationRejections[status]
              = (resourceTimingReconciliationRejections[status] ?? 0) + 1;
          }
        }
        if (resolution.authoritative) {
          byteAuthoritySources[resolution.source] = (byteAuthoritySources[resolution.source] ?? 0) + 1;
        }
        encodedBytes += resolution.encodedBytes;
        observedEncodedBytes += resolution.observedEncodedBytes;
        if (isGraph) {
          graphEncodedBytes += resolution.encodedBytes;
          graphObservedEncodedBytes += resolution.observedEncodedBytes;
        }
        accountingComplete &&= request.state !== "in-flight";
        graphAccountingComplete &&= !isGraph || request.state !== "in-flight";
        bytesAuthoritative &&= hopAuthoritative;
        // Browser cache/service-worker delivery is a real zero-wire result but contaminates this
        // cache-disabled graph comparison, so publishable graph accounting must fail closed.
        graphBytesAuthoritative &&= !isGraph
          || (hopAuthoritative && request.cacheSources.size === 0);
        for (const anomaly of request.anomalies) {
          const entry = { code: anomaly.code, path: url.pathname };
          if (anomaly.affectsAuthority) accountingAnomalies.push(entry);
          else accountingDiagnostics.push(entry);
        }
        const prior = byPath[url.pathname] ?? {
          requests: 0,
          encodedBytes: 0,
          observedEncodedBytes: 0,
          finishedRequests: 0,
          inFlightRequests: 0,
          failedRequests: 0,
          canceledRequests: 0,
          blockedRequests: 0,
          cachedRequests: 0,
          redirects: 0,
          requestIdReuses: 0,
          resourceTimingReconciliationAttempts: 0,
          resourceTimingReconciledRequests: 0,
          resourceTimingReconciliationRejections: {},
          byteAuthoritySources: {},
          accountingAnomalies: 0,
          accountingDiagnostics: 0,
          bytesAuthoritative: true,
          accountingComplete: true,
        };
        prior.requests += 1;
        prior.encodedBytes += resolution.encodedBytes;
        prior.observedEncodedBytes += resolution.observedEncodedBytes;
        prior.finishedRequests += Number(request.state !== "in-flight");
        prior.inFlightRequests += Number(request.state === "in-flight");
        prior.failedRequests += Number(request.failed);
        prior.canceledRequests += Number(request.canceled);
        prior.blockedRequests += Number(request.blocked);
        prior.cachedRequests += Number(request.cacheSources.size > 0);
        prior.redirects += Number(request.redirected);
        prior.requestIdReuses += Number(request.requestIdReused);
        if (request.resourceTimingReconciliation !== null) {
          prior.resourceTimingReconciliationAttempts += 1;
          if (request.resourceTimingReconciliation.status === "reconciled") {
            prior.resourceTimingReconciledRequests += 1;
          } else {
            const status = request.resourceTimingReconciliation.status;
            prior.resourceTimingReconciliationRejections[status]
              = (prior.resourceTimingReconciliationRejections[status] ?? 0) + 1;
          }
        }
        if (resolution.authoritative) {
          prior.byteAuthoritySources[resolution.source]
            = (prior.byteAuthoritySources[resolution.source] ?? 0) + 1;
        }
        prior.accountingAnomalies += hopAnomalies.length;
        prior.accountingDiagnostics += request.anomalies.length - hopAnomalies.length;
        prior.bytesAuthoritative &&= hopAuthoritative
          && (!isGraph || request.cacheSources.size === 0);
        prior.accountingComplete &&= request.state !== "in-flight";
        byPath[url.pathname] = prior;
      }
      return {
        encodedBytes,
        graphEncodedBytes,
        observedEncodedBytes,
        graphObservedEncodedBytes,
        requestCount,
        failedRequestCount,
        finishedRequestCount,
        inFlightRequestCount,
        inFlightGraphRequestCount,
        canceledRequestCount,
        blockedRequestCount,
        cachedRequestCount,
        redirectRequestCount,
        requestIdReuseCount,
        resourceTimingReconciliationAttemptCount,
        resourceTimingReconciledRequestCount,
        resourceTimingReconciliationRejections,
        byteAuthoritySources,
        accountingAnomalyCount: accountingAnomalies.length,
        accountingAnomalies,
        accountingDiagnosticCount: accountingDiagnostics.length,
        accountingDiagnostics,
        bytesAuthoritative,
        graphBytesAuthoritative,
        accountingComplete,
        graphAccountingComplete,
        byPath,
      };
    },
    dispose() {
      cdp.off("Network.requestWillBeSent", onRequest);
      cdp.off("Network.responseReceived", onResponse);
      cdp.off("Network.dataReceived", onData);
      cdp.off("Network.loadingFinished", onFinished);
      cdp.off("Network.loadingFailed", onFailed);
      cdp.off("Network.requestServedFromCache", onServedFromCache);
    },
  };
}

function responseContentLength(headers) {
  if (headers === null || typeof headers !== "object") return null;
  const match = Object.entries(headers).find(([name]) => name.toLowerCase() === "content-length");
  if (match === undefined) return null;
  const raw = typeof match[1] === "number" ? String(match[1]) : match[1];
  if (typeof raw !== "string" || !/^(?:0|[1-9]\d*)$/.test(raw.trim())) return null;
  const value = Number(raw.trim());
  return Number.isSafeInteger(value) ? value : null;
}

function isResourceTimingAbortCandidate(hop) {
  return hop.state === "failed"
    && hop.failed === true
    && hop.canceled === true
    && hop.errorText === "net::ERR_ABORTED"
    && Number.isFinite(hop.status)
    && hop.status >= 200
    && hop.status < 300
    && hop.blocked === false
    && hop.cacheSources.size === 0
    && hop.mimeType === "application/json"
    && Number.isFinite(hop.requestEpochMs)
    && hop.requestEpochMs > 0
    && hop.responseEncodedBytes !== null
    && hop.responseEncodedBytes > 0
    && hop.contentLength !== null
    && hop.contentLength > 0;
}

function matchesResourceTimingAbort(hop, entry, timeOriginMs) {
  if (entry === null || typeof entry !== "object") return false;
  const epochStartMs = timeOriginMs + entry.startTimeMs;
  return entry.name === hop.url
    && entry.entryType === "resource"
    && entry.initiatorType === "fetch"
    && Number.isFinite(entry.startTimeMs)
    && entry.startTimeMs >= 0
    && Number.isFinite(epochStartMs)
    && Math.abs(epochStartMs - hop.requestEpochMs) <= RESOURCE_TIMING_CORRELATION_TOLERANCE_MS
    && entry.responseStatus === hop.status
    && Number.isSafeInteger(entry.encodedBodySize)
    && entry.encodedBodySize === hop.contentLength
    && Number.isSafeInteger(entry.decodedBodySize)
    && entry.decodedBodySize === hop.contentLength
    && Number.isSafeInteger(entry.transferSize)
    && entry.transferSize >= hop.contentLength
    && Number.isFinite(entry.responseStartMs)
    && entry.responseStartMs >= entry.startTimeMs
    && Number.isFinite(entry.responseEndMs)
    && entry.responseEndMs > entry.responseStartMs
    // The empty delivery type is Chromium's network-delivery value. Reject cache/prefetch delivery
    // even though CDP separately reports cache provenance, so the two independent records agree.
    && (entry.deliveryType === "" || entry.deliveryType === null);
}

function resolveNetworkHopBytes(hop) {
  const observedEncodedBytes = hop.terminalEncodedBytes
    ?? ((hop.responseEncodedBytes ?? 0) + hop.dataEncodedBytes);
  if (hop.cacheSources.size > 0) {
    return {
      encodedBytes: 0,
      observedEncodedBytes,
      authoritative: true,
      source: "browser-cache",
    };
  }
  if ((hop.state === "finished" || hop.state === "redirected")
    && hop.terminalEncodedBytes !== null) {
    return {
      encodedBytes: hop.terminalEncodedBytes,
      observedEncodedBytes,
      authoritative: true,
      source: "cdp-terminal-total",
    };
  }
  const exactConsumedAbort = hop.state === "failed"
    && hop.canceled === true
    && hop.errorText === "net::ERR_ABORTED"
    && Number.isFinite(hop.status)
    && hop.status >= 200
    && hop.status < 300
    && hop.blocked === false
    && hop.responseEncodedBytes !== null
    && hop.contentLength !== null
    && hop.dataEncodedBytes >= hop.contentLength;
  if (exactConsumedAbort) {
    return {
      encodedBytes: hop.responseEncodedBytes + hop.contentLength,
      observedEncodedBytes,
      authoritative: true,
      source: "cdp-exact-consumed-abort",
    };
  }
  if (
    isResourceTimingAbortCandidate(hop)
    && hop.resourceTimingReconciliation?.status === "reconciled"
    && hop.resourceTimingReconciliation.source === "resource-timing-exact-body"
  ) {
    return {
      encodedBytes: hop.responseEncodedBytes + hop.contentLength,
      observedEncodedBytes,
      authoritative: true,
      source: "resource-timing-exact-body",
    };
  }
  return {
    encodedBytes: 0,
    observedEncodedBytes,
    authoritative: false,
    source: "unresolved",
  };
}

async function memorySnapshot(page, cdp, browserCdp, servicePid) {
  const [runtime, precise, processMemory, service] = await Promise.all([
    cdp.send("Runtime.getHeapUsage").catch(() => null),
    page.evaluate(() => {
      const memory = performance.memory;
      return memory ? {
        usedJSHeapSize: memory.usedJSHeapSize,
        totalJSHeapSize: memory.totalJSHeapSize,
        jsHeapSizeLimit: memory.jsHeapSizeLimit,
      } : null;
    }).catch(() => null),
    processMemorySnapshot(browserCdp),
    serviceMemorySnapshot(servicePid),
  ]);
  const jsHeapUsedBytes = finiteOrNull(precise?.usedJSHeapSize ?? runtime?.usedSize);
  const processRssBytes = processMemory?.totalRssBytes ?? null;
  return {
    browserJsHeapUsedBytes: jsHeapUsedBytes,
    browserProcessRssBytes: processRssBytes,
    jsHeapUsedBytes: finiteOrNull(precise?.usedJSHeapSize ?? runtime?.usedSize),
    jsHeapTotalBytes: finiteOrNull(precise?.totalJSHeapSize ?? runtime?.totalSize),
    jsHeapLimitBytes: finiteOrNull(precise?.jsHeapSizeLimit),
    embedderHeapUsedBytes: finiteOrNull(runtime?.embedderHeapUsedSize),
    backingStorageBytes: finiteOrNull(runtime?.backingStorageSize),
    processRssBytes,
    processRssByType: processMemory?.byType ?? null,
    serviceRssBytes: service?.serviceRssBytes ?? null,
    workerRssBytes: service?.workerRssBytes ?? null,
    serviceWorkerPids: service?.workerPids ?? [],
  };
}

function startMemorySampler(page, cdp, browserCdp, servicePid) {
  const snapshots = [];
  let stopped = false;
  let timer = null;
  let active = Promise.resolve();
  const tick = () => {
    if (stopped) return;
    active = memorySnapshot(page, cdp, browserCdp, servicePid)
      .then((snapshot) => snapshots.push(snapshot))
      .catch(() => undefined)
      .finally(() => {
        if (!stopped) timer = setTimeout(tick, 100);
      });
  };
  tick();
  let evidence = null;
  return {
    record(snapshot) {
      if (snapshot !== null) snapshots.push(snapshot);
    },
    async stop(retained) {
      if (evidence !== null) return evidence;
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      await active;
      if (retained !== null) snapshots.push(retained);
      const memoryPeak = peakMemorySnapshot(snapshots);
      const serviceAvailable = servicePid !== null
        && snapshots.some((snapshot) => Number.isFinite(snapshot.serviceRssBytes));
      evidence = {
        memoryPeak,
        serviceMemory: {
          peakRssBytes: memoryPeak.serviceRssBytes,
          retainedRssBytes: retained?.serviceRssBytes ?? null,
          workerPeakRssBytes: memoryPeak.workerRssBytes,
          workerRetainedRssBytes: retained?.workerRssBytes ?? null,
          sampleCount: snapshots.length,
          diagnostic: serviceAvailable ? false : true,
          diagnosticMessage: serviceAvailable ? null : "Meridian service process memory was unavailable",
        },
      };
      return evidence;
    },
  };
}

function peakMemorySnapshot(snapshots) {
  const fields = [
    "browserJsHeapUsedBytes",
    "browserProcessRssBytes",
    "jsHeapUsedBytes",
    "jsHeapTotalBytes",
    "jsHeapLimitBytes",
    "embedderHeapUsedBytes",
    "backingStorageBytes",
    "processRssBytes",
    "serviceRssBytes",
    "workerRssBytes",
  ];
  const result = {};
  for (const field of fields) {
    const values = snapshots.map((snapshot) => snapshot?.[field]).filter(Number.isFinite);
    result[field] = values.length === 0 ? null : Math.max(...values);
  }
  return result;
}

async function processMemorySnapshot(browserCdp) {
  if (process.platform === "win32") return null;
  let processInfo;
  try {
    processInfo = await browserCdp.send("SystemInfo.getProcessInfo");
  } catch {
    return null;
  }
  const rows = Array.isArray(processInfo?.processInfo) ? processInfo.processInfo : [];
  const ids = rows.map((entry) => Number(entry.id)).filter((id) => Number.isSafeInteger(id) && id > 0);
  if (ids.length === 0) return null;
  let stdout;
  try {
    ({ stdout } = await safeExec("ps", ["-o", "pid=,rss=", "-p", ids.join(",")], { maxBuffer: 1024 * 1024 }));
  } catch {
    return null;
  }
  const rssByPid = new Map();
  for (const line of stdout.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (match) rssByPid.set(Number(match[1]), Number(match[2]) * 1024);
  }
  if (rssByPid.size === 0) return null;
  const byType = {};
  for (const entry of rows) {
    const bytes = rssByPid.get(Number(entry.id));
    if (bytes === undefined) continue;
    const type = typeof entry.type === "string" && entry.type !== "" ? entry.type : "unknown";
    byType[type] = (byType[type] ?? 0) + bytes;
  }
  return { totalRssBytes: [...rssByPid.values()].reduce((sum, value) => sum + value, 0), byType };
}

async function serviceMemorySnapshot(servicePid) {
  if (servicePid === null || process.platform === "win32") return null;
  let stdout;
  try {
    ({ stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid=,rss=,command="], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    }));
  } catch {
    return null;
  }
  const rows = [];
  for (const line of stdout.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
    if (match === null) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      rssBytes: Number(match[3]) * 1024,
      command: match[4],
    });
  }
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const service = byPid.get(servicePid);
  if (service === undefined) return null;
  const descendants = new Set([servicePid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (!descendants.has(row.pid) && descendants.has(row.ppid)) {
        descendants.add(row.pid);
        changed = true;
      }
    }
  }
  const workers = rows.filter((row) =>
    descendants.has(row.pid) && /graph-project-worker\.(?:js|ts)(?:\s|$)/.test(row.command),
  );
  return {
    serviceRssBytes: service.rssBytes,
    workerRssBytes: workers.reduce((sum, worker) => sum + worker.rssBytes, 0),
    workerPids: workers.map((worker) => worker.pid).sort((left, right) => left - right),
  };
}

/** Cold preparation has no browser yet, so sample the owned service and every disposable child
 * independently. `workerRssBytes` intentionally covers analysis and projection workers here. */
async function coldServiceMemorySnapshot(servicePid) {
  if (servicePid === null || process.platform === "win32") return null;
  let stdout;
  try {
    ({ stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid=,rss=,command="], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    }));
  } catch {
    return null;
  }
  const rows = [];
  for (const line of stdout.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
    if (match === null) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      rssBytes: Number(match[3]) * 1024,
      command: match[4],
    });
  }
  const service = rows.find((row) => row.pid === servicePid);
  if (service === undefined) return null;
  const descendants = new Set([servicePid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (!descendants.has(row.pid) && descendants.has(row.ppid)) {
        descendants.add(row.pid);
        changed = true;
      }
    }
  }
  const workers = rows.filter((row) => row.pid !== servicePid && descendants.has(row.pid));
  const repositoryAnalysisWorkers = workers.filter((row) =>
    /repository-analysis-worker\.(?:js|ts)(?:\s|$)/.test(row.command),
  );
  const graphProjectWorkers = workers.filter((row) =>
    /graph-project-worker\.(?:js|ts)(?:\s|$)/.test(row.command),
  );
  return {
    serviceRssBytes: service.rssBytes,
    workerRssBytes: workers.reduce((sum, worker) => sum + worker.rssBytes, 0),
    workerPids: workers.map((worker) => worker.pid).sort((left, right) => left - right),
    repositoryAnalysisWorkerPids: repositoryAnalysisWorkers
      .map((worker) => worker.pid)
      .sort((left, right) => left - right),
    graphProjectWorkerPids: graphProjectWorkers
      .map((worker) => worker.pid)
      .sort((left, right) => left - right),
  };
}

/** Observe the union of relevant workers across the same interval used for route-count deltas.
 * A start/end-only snapshot can miss a short-lived worker, which would make the absence proof
 * depend on process lifetime rather than on whether work actually ran. */
async function sampleDwellWorkerActivity(page, servicePid, dwellMs) {
  const snapshots = [];
  const capture = async () => {
    const snapshot = await coldServiceMemorySnapshot(servicePid);
    if (snapshot === null) {
      throw new Error("could not inspect the Meridian process tree during the partial terminal dwell");
    }
    snapshots.push(snapshot);
  };
  await capture();
  const deadline = performance.now() + dwellMs;
  do {
    const remaining = deadline - performance.now();
    if (remaining <= 0) break;
    await page.waitForTimeout(Math.min(DWELL_WORKER_SAMPLE_INTERVAL_MS, Math.ceil(remaining)));
    await capture();
  } while (performance.now() < deadline);
  if (snapshots.length < 2) await capture();

  const atStart = snapshots[0];
  const observed = (field) => [...new Set(snapshots.flatMap((snapshot) => snapshot[field]))]
    .sort((left, right) => left - right);
  return {
    repositoryAnalysisWorkerPidsAtStart: [...atStart.repositoryAnalysisWorkerPids],
    graphProjectWorkerPidsAtStart: [...atStart.graphProjectWorkerPids],
    repositoryAnalysisWorkerPidsObserved: observed("repositoryAnalysisWorkerPids"),
    graphProjectWorkerPidsObserved: observed("graphProjectWorkerPids"),
    processSampleCount: snapshots.length,
  };
}

function startColdServiceMemorySampler(servicePid) {
  const snapshots = [];
  let stopped = false;
  let timer = null;
  let active = Promise.resolve();
  let evidence = null;
  const tick = () => {
    if (stopped) return;
    active = coldServiceMemorySnapshot(servicePid)
      .then((snapshot) => {
        if (snapshot !== null) snapshots.push(snapshot);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!stopped) timer = setTimeout(tick, COLD_MEMORY_SAMPLE_INTERVAL_MS);
      });
  };
  tick();
  return {
    async stop() {
      if (evidence !== null) return evidence;
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      await active;
      const retained = await coldServiceMemorySnapshot(servicePid).catch(() => null);
      if (retained !== null) snapshots.push(retained);
      const serviceValues = snapshots.map((snapshot) => snapshot.serviceRssBytes).filter(Number.isFinite);
      const workerValues = snapshots.map((snapshot) => snapshot.workerRssBytes).filter(Number.isFinite);
      evidence = {
        peakRssBytes: serviceValues.length === 0 ? null : Math.max(...serviceValues),
        retainedRssBytes: retained?.serviceRssBytes ?? null,
        workerPeakRssBytes: workerValues.length === 0 ? null : Math.max(...workerValues),
        workerRetainedRssBytes: retained?.workerRssBytes ?? null,
        sampleCount: snapshots.length,
        intervalMs: COLD_MEMORY_SAMPLE_INTERVAL_MS,
        workerScope: "all-owned-analysis-and-projection-descendants",
        diagnostic: retained === null || serviceValues.length === 0,
        diagnosticMessage: retained === null || serviceValues.length === 0
          ? "isolated cold service process-tree RSS was unavailable"
          : null,
      };
      return evidence;
    },
  };
}

function mergeColdServiceMemory(cold, browserPhase) {
  const maximum = (...values) => {
    const finite = values.filter(Number.isFinite);
    return finite.length === 0 ? null : Math.max(...finite);
  };
  const browserSampleCount = Number.isSafeInteger(browserPhase?.sampleCount) ? browserPhase.sampleCount : 0;
  const diagnostic = cold.diagnostic === true || browserPhase?.diagnostic === true || browserSampleCount <= 0;
  return {
    ...cold,
    peakRssBytes: maximum(cold.peakRssBytes, browserPhase?.peakRssBytes),
    workerPeakRssBytes: maximum(cold.workerPeakRssBytes, browserPhase?.workerPeakRssBytes),
    retainedRssBytes: cold.retainedRssBytes,
    workerRetainedRssBytes: cold.workerRetainedRssBytes,
    lifecyclePeakRssBytes: cold.peakRssBytes,
    lifecycleWorkerPeakRssBytes: cold.workerPeakRssBytes,
    browserPhasePeakRssBytes: browserPhase?.peakRssBytes ?? null,
    browserPhaseWorkerPeakRssBytes: browserPhase?.workerPeakRssBytes ?? null,
    sampleCount: cold.sampleCount + browserSampleCount,
    preparationAndEndToEndSampleCount: cold.sampleCount,
    browserPhaseSampleCount: browserSampleCount,
    browserPhaseIntervalMs: 100,
    peakAggregation: "max-of-500ms-lifecycle-and-100ms-review-browser-phase",
    retainedSource: "500ms-lifecycle-final-snapshot-after-review-settled",
    browserPhaseWorkerScope: "owned-projection-workers",
    diagnostic,
    diagnosticMessage: diagnostic
      ? cold.diagnosticMessage ?? browserPhase?.diagnosticMessage ?? "merged cold service memory is incomplete"
      : null,
  };
}

async function domSnapshot(page) {
  return page.evaluate(() => ({
    documentNodes: document.getElementsByTagName("*").length,
    canvasNodes: document.querySelectorAll(".react-flow__node").length,
    canvasEdges: document.querySelectorAll(".react-flow__edge").length,
    reviewFileRows: document.querySelectorAll([
      '[data-review-files-scroll="true"] button[title*="click to reveal on the graph"]',
      '[data-review-files-scroll="true"] button[title*="click to view the changed source"]',
    ].join(",")).length,
  }));
}

async function sceneSnapshot(page) {
  return page.evaluate(() => {
    const uniqueSorted = (values) => [...new Set(values.filter((value) => value !== ""))]
      .sort((left, right) => left.localeCompare(right));
    const elementId = (element) => element.getAttribute("data-id")
      ?? element.getAttribute("data-testid")
      ?? element.id
      ?? "";
    const reviewFiles = [...document.querySelectorAll([
      '[data-review-files-scroll="true"] button[title*="click to reveal on the graph"]',
      '[data-review-files-scroll="true"] button[title*="click to view the changed source"]',
    ].join(","))].map((element) => {
      const title = element.getAttribute("title") ?? "";
      return title
        .replace(/\s+—\s+click to reveal on the graph.*$/i, "")
        .replace(/\s+—\s+click to view the changed source.*$/i, "")
        .trim();
    });
    return {
      nodeIds: uniqueSorted([...document.querySelectorAll(".react-flow__node")].map(elementId)),
      edgeIds: uniqueSorted([...document.querySelectorAll(".react-flow__edge")].map(elementId)),
      reviewFiles: uniqueSorted(reviewFiles),
    };
  });
}

function assertScenePair(prNumber, iteration, fullSample, progressiveSample) {
  if (fullSample === undefined || progressiveSample === undefined) {
    throw new Error(`PR #${prNumber} sample ${iteration + 1} is missing a paired variant`);
  }
  for (const stage of ["sceneAtAction", "sceneSettled"]) {
    for (const field of ["nodeIds", "edgeIds", "reviewFiles"]) {
      const full = fullSample[stage]?.[field];
      const progressive = progressiveSample[stage]?.[field];
      if (!Array.isArray(full) || !Array.isArray(progressive) || JSON.stringify(full) !== JSON.stringify(progressive)) {
        throw new Error(`PR #${prNumber} sample ${iteration + 1} ${stage} visible ${field} parity failed`);
      }
    }
  }
}

function buildSceneParity(prNumber, fullSamples, progressiveSamples) {
  const fullHashes = fullSamples.map((sample) => hashScene(sample.sceneSettled));
  const progressiveHashes = progressiveSamples.map((sample) => hashScene(sample.sceneSettled));
  if (new Set(fullHashes).size !== 1 || new Set(progressiveHashes).size !== 1) {
    throw new Error(`PR #${prNumber} visible scene was not deterministic across repetitions`);
  }
  if (fullHashes[0] !== progressiveHashes[0]) {
    throw new Error(`PR #${prNumber} full/progressive visible scene hashes differ`);
  }
  return {
    exact: true,
    fullSceneHash: fullHashes[0],
    progressiveSceneHash: progressiveHashes[0],
    fields: { nodeIds: true, edgeIds: true, reviewFiles: true },
  };
}

function assertReviewSurfacePair(prNumber, iteration, fullSample, progressiveSample) {
  if (fullSample === undefined || progressiveSample === undefined) {
    throw new Error(`PR #${prNumber} sample ${iteration + 1} is missing a paired variant`);
  }
  for (const stage of ["sceneAtAction", "sceneSettled"]) {
    const fullFiles = fullSample[stage]?.reviewFiles;
    const partialFiles = progressiveSample[stage]?.reviewFiles;
    if (!Array.isArray(fullFiles)
      || !Array.isArray(partialFiles)
      || JSON.stringify(fullFiles) !== JSON.stringify(partialFiles)) {
      throw new Error(`PR #${prNumber} sample ${iteration + 1} ${stage} changed-file surface parity failed`);
    }
    if ((progressiveSample[stage]?.nodeIds?.length ?? 0) === 0) {
      throw new Error(`PR #${prNumber} sample ${iteration + 1} ${stage} partial canvas is empty`);
    }
  }
}

function buildReviewSurfaceParity(prNumber, fullSamples, progressiveSamples) {
  const reviewHashes = (samples) => samples.map((sample) => createHash("sha256")
    .update(JSON.stringify(sample.sceneSettled?.reviewFiles ?? null)).digest("hex"));
  const full = reviewHashes(fullSamples);
  const progressive = reviewHashes(progressiveSamples);
  if (new Set(full).size !== 1 || new Set(progressive).size !== 1 || full[0] !== progressive[0]) {
    throw new Error(`PR #${prNumber} changed-file review surface was not deterministic and preserved`);
  }
  return {
    exactReviewFiles: true,
    fullReviewFilesHash: full[0],
    progressiveReviewFilesHash: progressive[0],
    graphSetsIntentionallyPartial: true,
  };
}

function hashScene(scene) {
  return createHash("sha256").update(JSON.stringify(scene)).digest("hex");
}

export function projectionEvidence(value) {
  if (typeof value !== "object" || value === null) return { invalid: true };
  const projection = value.projection && typeof value.projection === "object"
    ? value.projection
    : value;
  const request = value.request && typeof value.request === "object" ? value.request : null;
  const rootsKind = projection.rootsKind ?? request?.roots?.kind ?? null;
  const requestSeedGraphId = rootsKind === "changed-files"
    ? request?.roots?.seedGraphId
    : rootsKind === "files" || rootsKind === "file-paths"
      ? request?.graphId
      : null;
  const requestedDepth = finiteOrNull(projection.requestedDepth ?? request?.requestedDepth);
  const counts = projection.counts && typeof projection.counts === "object" ? projection.counts : null;
  return {
    version: projection.version ?? request?.version ?? null,
    graphId: typeof (projection.graphId ?? request?.graphId) === "string"
      ? projection.graphId ?? request.graphId
      : null,
    rootsKind,
    seedGraphId: typeof (projection.seedGraphId ?? requestSeedGraphId) === "string"
      ? projection.seedGraphId ?? requestSeedGraphId
      : null,
    generation: typeof projection.generation === "string" ? projection.generation : null,
    requestedDepth,
    prefetchDepth: finiteOrNull(projection.prefetchDepth ?? request?.prefetchDepth),
    loadedDepth: finiteOrNull(projection.loadedDepth),
    rootCount: Array.isArray(projection.rootFileIds) ? projection.rootFileIds.length : null,
    readyRootCount: Array.isArray(projection.readyFileIds) ? projection.readyFileIds.length : null,
    loadedFileCount: Array.isArray(projection.loadedFileIds) ? projection.loadedFileIds.length : null,
    counts: counts === null ? null : counts,
    responseBodyRead: value.responseBodyRead === false ? false : null,
    transportStatus: Number.isSafeInteger(value.status)
      ? value.status
      : Number.isSafeInteger(value.transportStatus) ? value.transportStatus : null,
    source: value.source ?? null,
  };
}

async function performShowcaseInteraction(opened, { variant, symbol: requestedSymbol }) {
  const { page, captures } = opened;
  await page.waitForTimeout(options.videoDwellMs);
  // Prove and cache the renderer-owned background index before changing depth. A critical depth
  // request is allowed to preempt speculative symbol work; opening Cmd+P would normally retry it,
  // but the showcase intentionally waits for proof before opening the palette. Reversing these two
  // actions can therefore create an unrecoverable wait in the recorder even though the user flow is
  // healthy. Once the index is accepted, depth expansion cannot invalidate its immutable cache.
  const backgroundSymbolProof = variant === "progressive"
    ? await waitForRendererSymbolIndex(opened, opened.prepared.graphId)
    : null;
  const depthAdjusted = variant === "progressive" ? await tryAdjustDepth(page) : false;
  if (depthAdjusted) {
    await captures.settle(options.timeoutMs);
    await page.waitForTimeout(options.videoDwellMs);
  }
  captures.markHarnessSymbolInteractionStarted();
  const shortcut = process.platform === "darwin" ? "Meta+P" : "Control+P";
  await page.keyboard.press(shortcut);
  const dialog = page.getByRole("dialog", { name: /Reveal or add a node in the current view/i });
  await dialog.waitFor({ state: "visible", timeout: options.timeoutMs });
  const symbol = requestedSymbol === null
    ? await chooseDisconnectedSymbolFromPalette(
        dialog,
        backgroundSymbolProof?.index.symbols ?? [],
      )
    : requestedSymbol;
  if (symbol === null && !options.allowSearchSkip) {
    throw new Error(requestedSymbol === null
      ? "no nonresident public symbol was exposed by the command palette for hydration"
      : "the paired recording could not resolve the same exact symbol");
  }

  let searchHydrated = false;
  let disconnectedBeforeSearch = false;
  let beforeNodes = await page.locator(".react-flow__node").count();
  let afterNodes = beforeNodes;
  if (symbol !== null) {
    const input = dialog.locator("input").first();
    await input.fill(symbol.displayName);
    const mainButton = dialog.getByTitle(symbol.id, { exact: true });
    await mainButton.waitFor({ state: "visible", timeout: options.timeoutMs });
    await page.waitForTimeout(options.videoDwellMs);
    const row = mainButton.locator("..");
    const [readiness, resident] = await Promise.all([
      row.getAttribute("data-symbol-readiness"),
      row.getAttribute("data-symbol-resident"),
    ]);
    disconnectedBeforeSearch = isDisconnectedPaletteRow(readiness, resident);
    if (variant === "progressive" && !disconnectedBeforeSearch) {
      throw new Error("the selected progressive showcase symbol was not loadable and nonresident before its add action");
    }
    if (variant === "progressive" && disconnectedBeforeSearch) {
      const priorReadyMarks = await page.evaluate((nodeId) => performance
        .getEntriesByName("meridian:progressive-node-ready", "mark")
        .filter((entry) => entry.detail?.nodeId === nodeId).length, symbol.id);
      const projectionResponseStart = captures.projectionResponses.length;
      const hydrationStartedEpochMs = await page.evaluate(() => performance.timeOrigin + performance.now());
      const hydrationDeadline = Date.now() + Math.min(options.timeoutMs, MAX_SHOWCASE_HYDRATION_WAIT_MS);
      await mainButton.click();
      const waitTimeoutMs = remainingTimeoutMs(hydrationDeadline);
      const readyOperation = page.waitForFunction(
        ({ nodeId, prior }) => performance.getEntriesByName("meridian:progressive-node-ready", "mark")
          .filter((entry) => entry.detail?.nodeId === nodeId).slice(prior).length > 0,
        { nodeId: symbol.id, prior: priorReadyMarks },
        { polling: "raf", timeout: waitTimeoutMs },
      );
      const retryOperation = page.waitForFunction(
        (nodeId) => Array.from(document.querySelectorAll("[data-symbol-id]"))
          .some((candidate) => candidate.getAttribute("data-symbol-id") === nodeId
            && candidate.getAttribute("data-symbol-readiness") === "retry"),
        symbol.id,
        { polling: "raf", timeout: waitTimeoutMs },
      ).then(() => ({ source: "row-retry", message: "" }));
      const alert = dialog.getByRole("alert");
      const alertOperation = alert.waitFor({ state: "visible", timeout: waitTimeoutMs }).then(async () => ({
        source: "palette-alert",
        message: (await alert.innerText()).trim(),
      }));
      await awaitPaletteHydrationOutcome(
        readyOperation,
        Promise.race([retryOperation, alertOperation]),
        remainingTimeoutMs(hydrationDeadline),
      );
      await page.waitForFunction(
        (nodeId) => Array.from(document.querySelectorAll("[data-symbol-id]"))
          .some((candidate) => candidate.getAttribute("data-symbol-id") === nodeId
            && candidate.getAttribute("data-symbol-readiness") === "ready"),
        symbol.id,
        { polling: "raf", timeout: remainingTimeoutMs(hydrationDeadline) },
      );
      await captures.settle(remainingTimeoutMs(hydrationDeadline));
      assertExactSymbolHydrationRequest(
        captures.projectionResponses.slice(projectionResponseStart),
        symbol,
        opened.prepared.graphId,
        hydrationStartedEpochMs,
      );
    }
    await row.getByRole("button", { name: `Add ${symbol.displayName} to the current view`, exact: true }).click();
    await page.waitForFunction(
      (count) => document.querySelectorAll(".react-flow__node").length > count,
      beforeNodes,
      { polling: "raf", timeout: options.timeoutMs },
    );
    afterNodes = await page.locator(".react-flow__node").count();
    searchHydrated = afterNodes > beforeNodes;
    await page.waitForTimeout(options.videoDwellMs);
  }
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden", timeout: options.timeoutMs });
  await page.waitForTimeout(options.videoDwellMs);
  return {
    summary: symbol === null
      ? `${variant} PR review reached first action and opened background symbol search.`
      : `${variant} PR review reached first action, indexed symbols, and added ${symbol.displayName} to the canvas.`,
    variant,
    depthAdjusted,
    searchHydrated,
    disconnectedBeforeSearch: variant === "progressive" ? disconnectedBeforeSearch : null,
    backgroundSymbolIndex: backgroundSymbolProof === null ? null : {
      rendererInitiated: true,
      afterFirstActionable: true,
      beforeHarnessInteraction: true,
      graphId: backgroundSymbolProof.index.graphId,
      complete: backgroundSymbolProof.index.complete,
      indexedSymbolCount: backgroundSymbolProof.index.indexedSymbolCount,
      totalSymbolCount: backgroundSymbolProof.index.totalSymbolCount,
      acceptanceMark: backgroundSymbolProof.acceptanceMark,
      rendererTransport: backgroundSymbolProof.rendererTransport,
      harnessFetch: backgroundSymbolProof.harnessFetch,
    },
    symbol: symbol === null ? null : {
      id: symbol.id,
      fileId: symbol.fileId,
      displayName: symbol.displayName,
      file: symbol.file,
    },
    canvasNodesBeforeSearch: beforeNodes,
    canvasNodesAfterSearch: afterNodes,
  };
}

async function tryAdjustDepth(page) {
  const preferences = page.getByRole("button", { name: "Review preferences", exact: true });
  if (await preferences.count() === 0) return false;
  await preferences.first().click();
  const closePreferences = page.getByRole("button", { name: "Close review preferences", exact: true });
  const control = page.getByLabel(/Loaded context depth/i).first();
  if (await control.count() === 0) {
    await closePreferences.click();
    return false;
  }
  const priorReadyMarks = await page.evaluate(() => performance.getEntriesByName("meridian:progressive-depth-ready").length);
  let changed = false;
  let desiredDepth = null;
  const tag = await control.evaluate((element) => element.tagName.toLowerCase());
  if (tag === "select") {
    const values = await control.locator("option").evaluateAll((options) => options.map((option) => option.value));
    const current = await control.inputValue();
    const desired = values.includes("2") && current !== "2"
      ? "2"
      : values.find((value) => Number(value) > Number(current));
    if (desired !== undefined) {
      await control.selectOption(desired);
      changed = true;
      desiredDepth = Number(desired);
    }
  } else {
    await control.focus();
    await control.press("ArrowRight");
    changed = true;
    desiredDepth = 2;
  }
  if (!changed || !Number.isSafeInteger(desiredDepth)) {
    await closePreferences.click();
    return false;
  }

  // Keep the pane open until the store either marks the fully laid-out slice ready or exposes its
  // bounded error. Closing it first made a fast projection failure indistinguishable from a
  // ten-minute transport stall because the recorder waited only on a mark the failed action could
  // never emit.
  const depthContainer = control.locator("..").locator("..");
  const alert = depthContainer.getByRole("alert");
  try {
    const outcome = await Promise.race([
      page.waitForFunction(
        ({ prior, depth }) => performance.getEntriesByName("meridian:progressive-depth-ready")
          .slice(prior)
          .some((entry) => entry.detail?.depth === depth),
        { prior: priorReadyMarks, depth: desiredDepth },
        { polling: "raf", timeout: options.timeoutMs },
      ).then(() => ({ kind: "ready" })),
      alert.waitFor({ state: "visible", timeout: options.timeoutMs }).then(async () => ({
        kind: "error",
        message: (await alert.innerText()).trim(),
      })),
    ]);
    if (outcome.kind === "error") {
      throw new Error(`depth ${desiredDepth} expansion failed: ${outcome.message || "unknown bounded projection error"}`);
    }
    return true;
  } finally {
    if (await closePreferences.isVisible()) await closePreferences.click();
  }
}

async function waitForRendererSymbolIndex(opened, graphId) {
  const deadline = Date.now() + options.timeoutMs;
  await opened.page.waitForFunction(
    ({ markName, expectedGraphId }) => {
      const actionableAt = window.__MERIDIAN_POC_FIRST_ACTIONABLE__?.atMs;
      if (!Number.isFinite(actionableAt)) return false;
      return performance.getEntriesByName(markName, "mark").some((entry) =>
        entry.startTime + 0.5 >= actionableAt
        && entry.detail?.graphId === expectedGraphId
        && entry.detail?.source === "renderer-symbol-worker-accepted"
        && entry.detail?.workerBacked === 1
        && Number.isFinite(entry.detail?.requestStartedAtMs)
        && entry.detail.requestStartedAtMs + 0.5 >= actionableAt
        && Number.isSafeInteger(entry.detail?.symbols)
        && entry.detail.symbols > 0);
    },
    { markName: PROGRESSIVE_SYMBOL_INDEX_READY_MARK, expectedGraphId: graphId },
    { polling: "raf", timeout: remainingTimeoutMs(deadline) },
  );
  const acceptanceMark = await opened.page.evaluate(({ markName, expectedGraphId }) => {
    const actionableAt = window.__MERIDIAN_POC_FIRST_ACTIONABLE__?.atMs;
    const entries = performance.getEntriesByName(markName, "mark");
    const entry = [...entries].reverse().find((candidate) =>
      Number.isFinite(actionableAt)
      && candidate.startTime + 0.5 >= actionableAt
      && candidate.detail?.graphId === expectedGraphId
      && candidate.detail?.source === "renderer-symbol-worker-accepted"
      && candidate.detail?.workerBacked === 1
      && Number.isFinite(candidate.detail?.requestStartedAtMs)
      && candidate.detail.requestStartedAtMs + 0.5 >= actionableAt
      && Number.isSafeInteger(candidate.detail?.symbols)
      && candidate.detail.symbols > 0);
    return entry === undefined ? null : {
      name: entry.name,
      startTimeMs: entry.startTime,
      indexedSymbolCount: entry.detail.symbols,
      graphId: entry.detail.graphId,
      generation: entry.detail.generation,
      requestStartedAtMs: entry.detail.requestStartedAtMs,
      firstActionableAtMs: actionableAt,
      workerBacked: entry.detail.workerBacked === 1,
      source: entry.detail.source,
    };
  }, { markName: PROGRESSIVE_SYMBOL_INDEX_READY_MARK, expectedGraphId: graphId });
  if (acceptanceMark === null) {
    throw new Error("renderer symbol readiness mark disappeared before it could be captured");
  }

  // The application-owned mark proves the renderer consumed and accepted its worker response. Read
  // the now-cached index through a separate page-owned request so Playwright never duplicates the
  // renderer Web Worker's response stream merely to choose a disconnected showcase symbol.
  opened.captures.markHarnessSymbolInteractionStarted();
  const harnessResult = await boundedOperation(
    opened.page.evaluate(async (id) => {
      const url = new URL("/api/graph/symbols", window.location.origin);
      url.searchParams.set("id", id);
      const response = await fetch(url, { credentials: "same-origin" });
      if (!response.ok) throw new Error(`background symbol evidence fetch returned HTTP ${response.status}`);
      return { status: response.status, body: await response.json() };
    }, graphId),
    remainingTimeoutMs(deadline),
    "background symbol evidence fetch timed out",
  );
  const index = harnessResult?.body;
  if (
    harnessResult?.status !== 200
    || index?.graphId !== graphId
    || index.complete !== true
    || !Array.isArray(index.symbols)
    || !Number.isSafeInteger(index.indexedSymbolCount)
    || index.indexedSymbolCount <= 0
    || !Number.isSafeInteger(index.totalSymbolCount)
    || index.totalSymbolCount < index.indexedSymbolCount
  ) {
    throw new Error("background symbol evidence fetch returned an invalid exact-revision index");
  }
  if (acceptanceMark.indexedSymbolCount !== index.indexedSymbolCount) {
    throw new Error("renderer symbol readiness count contradicted the cached exact-revision index");
  }
  return {
    index,
    acceptanceMark,
    rendererTransport: {
      graphId: acceptanceMark.graphId,
      generation: acceptanceMark.generation,
      requestStartedAtMs: acceptanceMark.requestStartedAtMs,
      firstActionableAtMs: acceptanceMark.firstActionableAtMs,
      workerBacked: acceptanceMark.workerBacked,
      accepted: true,
      source: acceptanceMark.source,
    },
    harnessFetch: {
      graphId,
      status: harnessResult.status,
    },
  };
}

function remainingTimeoutMs(deadline) {
  return Math.max(1, Math.ceil(deadline - Date.now()));
}

async function boundedOperation(operation, timeoutMs, message) {
  let timer = null;
  const timedOut = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${message} after ${timeoutMs} ms`)), timeoutMs);
  });
  try {
    return await Promise.race([operation, timedOut]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

async function chooseDisconnectedSymbolFromPalette(dialog, symbols) {
  const byId = new Map(symbols.map((symbol) => [symbol?.id, symbol]));
  const loadableRows = dialog.locator(
    '[data-symbol-readiness="loadable"][data-symbol-resident="false"]',
  );
  await loadableRows.first().waitFor({
    state: "visible",
    timeout: Math.min(options.timeoutMs, 10_000),
  }).catch(() => undefined);
  const visibleTop = await firstVisibleDisconnectedSymbol(loadableRows, byId);
  if (visibleTop !== null) return visibleTop;

  // A tiny loaded graph could occupy the worker's initial top 40. Probe deterministic, unique public
  // names until the palette itself labels one both loadable and nonresident. This keeps the proof at
  // the user-facing readiness/residency boundary and avoids rereading any projection response body.
  const input = dialog.locator("input").first();
  for (const candidate of disconnectedSymbolCandidates(symbols).slice(0, 24)) {
    await input.fill(candidate.displayName);
    const button = dialog.getByTitle(candidate.id, { exact: true });
    await button.waitFor({
      state: "visible",
      timeout: Math.min(options.timeoutMs, 2_000),
    }).catch(() => undefined);
    if (await button.count() === 0 || !await button.isVisible()) continue;
    const row = button.locator("..");
    const [readiness, resident] = await Promise.all([
      row.getAttribute("data-symbol-readiness"),
      row.getAttribute("data-symbol-resident"),
    ]);
    if (isDisconnectedPaletteRow(readiness, resident)) return candidate;
  }
  return null;
}

export function isDisconnectedPaletteRow(readiness, resident) {
  return readiness === "loadable" && resident === "false";
}

export async function awaitPaletteHydrationOutcome(readyOperation, failureOperation, timeoutMs) {
  const outcome = await boundedOperation(
    Promise.race([
      Promise.resolve(readyOperation).then(() => ({ kind: "ready" })),
      Promise.resolve(failureOperation).then((failure) => ({ kind: "failure", failure })),
    ]),
    timeoutMs,
    "selected symbol hydration reached neither ready nor retry",
  );
  if (outcome.kind === "failure") {
    const message = typeof outcome.failure?.message === "string" && outcome.failure.message.trim().length > 0
      ? `: ${outcome.failure.message.trim()}`
      : "";
    throw new Error(`selected symbol hydration failed via ${outcome.failure?.source ?? "palette error"}${message}`);
  }
  return outcome;
}

export function assertExactSymbolHydrationRequest(records, symbol, graphId, actionEpochMs) {
  if (!Array.isArray(records)
    || typeof symbol?.fileId !== "string"
    || typeof graphId !== "string"
    || !Number.isFinite(actionEpochMs)) {
    throw new TypeError("exact symbol hydration proof requires captured records, a file root, graph id, and action time");
  }
  const matches = records.filter((record) => {
    const request = record?.request;
    const fileIds = request?.roots?.fileIds;
    return record?.method === "POST"
      && record?.path === "/api/graph/project"
      && record?.status === 200
      && record?.responseBodyRead === false
      && record?.source === "request-and-response-headers"
      && Number.isFinite(record?.requestStartedEpochMs)
      && record.requestStartedEpochMs + 0.5 >= actionEpochMs
      && request?.version === 1
      && request?.graphId === graphId
      && request?.roots?.kind === "files"
      && Array.isArray(fileIds)
      && fileIds.length === 1
      && fileIds[0] === symbol.fileId
      && request?.requestedDepth === 1
      && request?.prefetchDepth === 1;
  });
  if (matches.length !== 1) {
    throw new Error(
      `selected symbol hydration did not issue one causal exact file-rooted depth-1 projection for ${symbol.fileId}`
        + ` (observed ${matches.length} exact request(s) across ${records.length} captured response(s))`,
    );
  }
  return matches[0];
}

async function firstVisibleDisconnectedSymbol(rows, byId) {
  const count = await rows.count();
  for (let index = 0; index < count; index += 1) {
    const row = rows.nth(index);
    if (!await row.isVisible()) continue;
    const [readiness, resident] = await Promise.all([
      row.getAttribute("data-symbol-readiness"),
      row.getAttribute("data-symbol-resident"),
    ]);
    if (!isDisconnectedPaletteRow(readiness, resident)) continue;
    const id = await row.getAttribute("data-symbol-id");
    const symbol = id === null ? null : byId.get(id);
    if (symbol !== undefined && symbol !== null) return symbol;
  }
  return null;
}

function disconnectedSymbolCandidates(symbols) {
  const counts = new Map();
  for (const symbol of symbols) {
    if (typeof symbol?.displayName === "string") {
      const key = symbol.displayName.toLowerCase();
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const candidates = symbols.filter((symbol) =>
    symbol
    && typeof symbol.id === "string"
    && typeof symbol.fileId === "string"
    && typeof symbol.displayName === "string"
    && symbol.displayName.length >= 3
    && symbol.displayName.length <= 80
    && typeof symbol.file === "string"
    && !/(^|\/)(?:test|tests|__tests__)(\/|$)|\.(?:test|spec)\.[^.]+$/i.test(symbol.file)
    && symbol.isPrivateMethod !== true
    && counts.get(symbol.displayName.toLowerCase()) === 1,
  );
  candidates.sort((left, right) =>
    Number(right.stepCount !== null) - Number(left.stepCount !== null)
    || stableTextCompare(left.displayName, right.displayName)
    || stableTextCompare(left.id, right.id));
  return candidates;
}

function stableTextCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function validateVideo(videoPath) {
  const { stdout: probeText } = await safeExec(options.ffprobePath, [
    "-v", "error",
    "-count_frames",
    "-select_streams", "v:0",
    "-show_entries", "stream=codec_type,codec_name,width,height,duration,avg_frame_rate,nb_frames,nb_read_frames:format=duration,size",
    "-of", "json",
    videoPath,
  ], { maxBuffer: 8 * 1024 * 1024 });
  const probe = validateVideoProbe(parseFfprobeJson(probeText), options.viewport);
  const { stdout: frameText } = await safeExec(options.ffmpegPath, [
    "-v", "error", "-i", videoPath,
    "-vf", "fps=2,scale=160:-1",
    "-an", "-f", "framemd5", "-",
  ], { maxBuffer: 32 * 1024 * 1024 });
  const signal = await safeExec(options.ffmpegPath, [
    "-v", "error", "-i", videoPath,
    "-vf", "fps=1,signalstats,metadata=print:file=-",
    "-an", "-f", "null", "-",
  ], { maxBuffer: 32 * 1024 * 1024 });
  const nontrivial = validateNontrivialFrames(
    parseFrameMd5(frameText),
    parseSignalStats(`${signal.stdout}\n${signal.stderr}`),
  );
  return {
    ...probe,
    ...nontrivial,
    sha256: await sha256File(videoPath),
    validatedAt: new Date().toISOString(),
  };
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function environmentFacts() {
  const facts = {
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
    meridianCommit: null,
    worktreeDirty: null,
  };
  try {
    const head = await safeExec("git", ["rev-parse", "HEAD"], { maxBuffer: 1024 * 1024 });
    facts.meridianCommit = head.stdout.trim();
    const status = await safeExec("git", ["status", "--porcelain"], { maxBuffer: 4 * 1024 * 1024 });
    facts.worktreeDirty = status.stdout.trim() !== "";
  } catch {
    // Report remains usable outside a Git worktree.
  }
  return facts;
}

function initialDiagnosticReasons(harnessOptions) {
  const reasons = [];
  if (harnessOptions.repository !== "UiPath/Autopilot") reasons.push("corpus is not UiPath/Autopilot");
  if (harnessOptions.prs.length < 2) reasons.push("corpus contains fewer than two PRs");
  if (harnessOptions.repetitions < 2) {
    reasons.push(harnessOptions.partialRuntimeOnly
      ? "fewer than two progressive repetitions were requested"
      : "fewer than two counterbalanced repetitions were requested");
  }
  if (!harnessOptions.recordVideos) {
    reasons.push(harnessOptions.partialRuntimeOnly
      ? "required progressive recordings were disabled"
      : "paired recordings were disabled");
  }
  if (!harnessOptions.validateVideos) reasons.push("recording validation was disabled");
  if (harnessOptions.allowSearchSkip) reasons.push("disconnected-symbol search hydration may be skipped");
  if (!harnessOptions.coldEndToEnd) reasons.push("isolated cold end-to-end evidence was disabled");
  return reasons;
}

function addDiagnosticReason(reason) {
  if (typeof reason !== "string" || reason.trim() === "" || diagnosticReasons.includes(reason)) return;
  diagnosticReasons.push(reason);
  result.config.mode = "diagnostic";
  result.config.diagnosticReasons = diagnosticReasons;
  result.diagnostic = { reason: diagnosticReasons.join("; ") };
}

function isLoopbackUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const hostname = url.hostname.toLowerCase();
  return hostname === "localhost"
    || hostname.endsWith(".localhost")
    || hostname === "127.0.0.1"
    || hostname === "::1"
    || hostname === "[::1]";
}

async function startIsolatedColdService() {
  // Do not create a detached service until this harness can obtain the OS identity proof required
  // to clean it. In restricted sandboxes `spawn ps` may fail with EPERM; discovering that after the
  // service fork would leave no safe way to distinguish its detached PIDs from later PID reuse.
  if (process.platform !== "win32") await readProcessTable();
  const cli = resolve(options.coldCliPath);
  const cliStat = await stat(cli).catch(() => null);
  if (cliStat === null || !cliStat.isFile()) {
    throw new Error(`isolated cold service needs a built CLI at ${cli}`);
  }
  const root = await mkdtemp(join(tmpdir(), "meridian-pr-review-cold-"));
  const cacheDir = join(root, "cache");
  const ownedProcessRegistry = join(root, "owned-processes.ndjson");
  const ownedProcessToken = createHash("sha256").update(randomUUID()).digest("hex");
  await mkdir(cacheDir, { mode: 0o700 });
  await writeFile(ownedProcessRegistry, "", { encoding: "utf8", flag: "wx", mode: 0o600 });
  const requestedPort = await reserveLoopbackPort();
  const ambientNodeOptions = (process.env.NODE_OPTIONS ?? "").trim();
  const nodeOptions = ambientNodeOptions.includes("--max-old-space-size")
    ? ambientNodeOptions
    : `${ambientNodeOptions} --max-old-space-size=8192`.trim();
  let child;
  const serviceArguments = isolatedColdServiceArguments(cli, requestedPort, {
    partialRuntimeOnly: options.partialRuntimeOnly,
  });
  const fullBaselineCapability = fullBaselineCapabilityEvidenceFromArguments(serviceArguments);
  if (options.partialRuntimeOnly) {
    assertFullBaselineCapabilityAbsent(fullBaselineCapability, "isolated cold service arguments");
  }
  try {
    child = spawn(process.execPath, serviceArguments, {
      cwd: process.cwd(),
      env: isolatedColdServiceEnvironment({
        ...process.env,
        MERIDIAN_CACHE_DIR: cacheDir,
        NODE_OPTIONS: nodeOptions,
        GH_PAGER: "cat",
        NO_COLOR: "1",
        ...(process.platform === "win32" ? {} : {
          [OWNED_PROCESS_TOKEN_ENV]: ownedProcessToken,
          [OWNED_PROCESS_REGISTRY_ENV]: ownedProcessRegistry,
        }),
      }, root),
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
  const serviceInstanceId = createHash("sha256")
    .update(`${randomUUID()}:${child.pid ?? "unavailable"}`)
    .digest("hex");
  const cacheInstanceId = createHash("sha256").update(`${randomUUID()}:${root}`).digest("hex");
  if (!Number.isSafeInteger(child.pid) || child.pid <= 0) {
    child.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
    throw new Error("isolated Meridian service has no PID");
  }
  const processTracker = process.platform === "win32"
    ? null
    : createOwnedProcessTreeTracker(child.pid, {
      scanIntervalMs: 100,
      ownerToken: ownedProcessToken,
      registryPath: ownedProcessRegistry,
      isRootAlive: () => !childExited(child),
    });
  const cleanupEvidence = {
    strategy: processTracker === null ? "child-process" : "tracked-owned-process-tree-and-groups",
    rootPid: child.pid,
    verifiedEmpty: false,
    tempDirectoryRemoved: false,
  };
  let stdout = "";
  let stderr = "";
  let stopPromise = null;
  let unregisterSignalCleanup = () => {};
  const stop = () => {
    if (stopPromise !== null) return stopPromise;
    stopPromise = (async () => {
      let shutdownError = null;
      try {
        if (processTracker !== null) {
          Object.assign(cleanupEvidence, await terminateOwnedProcessTree(processTracker, {
            gracefulTimeoutMs: options.coldServiceTimeoutMs,
            killTimeoutMs: 5_000,
          }));
          if (cleanupEvidence.verifiedEmpty !== true) {
            shutdownError = new Error(`isolated Meridian process tree ${child.pid} did not stop`);
          }
        } else if (!childExited(child)) {
          signalOwnedProcess(child, "SIGTERM");
          if (!await waitForChildExit(child, options.coldServiceTimeoutMs)) {
            signalOwnedProcess(child, "SIGKILL");
            if (!await waitForChildExit(child, 5_000)) {
              shutdownError = new Error(`isolated Meridian service ${child.pid ?? "unknown"} did not stop`);
            }
          }
          cleanupEvidence.verifiedEmpty = shutdownError === null;
        }
      } catch (error) {
        shutdownError = error instanceof Error ? error : new Error(String(error));
      } finally {
        try {
          const parsed = parse(resolve(root));
          if (resolve(parsed.dir) !== resolve(tmpdir()) || !parsed.base.startsWith("meridian-pr-review-cold-")) {
            throw new Error("refusing to clean an unowned cold-service directory");
          }
          if (cleanupEvidence.verifiedEmpty === true) {
            await rm(root, { recursive: true, force: true });
            cleanupEvidence.tempDirectoryRemoved = await stat(root).then(() => false, () => true);
          }
        } finally {
          unregisterSignalCleanup();
        }
      }
      if (shutdownError !== null) throw shutdownError;
    })();
    return stopPromise;
  };
  unregisterSignalCleanup = registerColdServiceSignalCleanup(stop);

  try {
    await processTracker?.start();
    const baseUrl = await new Promise((resolveReady, rejectReady) => {
      let settled = false;
      let timer = null;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        child.off("error", onError);
        child.off("exit", onExit);
        callback(value);
      };
      const inspect = () => {
        const match = `${stdout}\n${stderr}`.match(/Blueprint web UI at (http:\/\/127\.0\.0\.1:\d+)/);
        if (match !== null) finish(resolveReady, match[1]);
      };
      const appendStdout = (chunk) => {
        stdout = appendBoundedOutput(stdout, chunk);
        inspect();
      };
      const appendStderr = (chunk) => {
        stderr = appendBoundedOutput(stderr, chunk);
        inspect();
      };
      const onError = (error) => finish(rejectReady, error);
      const onExit = (code, signal) => finish(
        rejectReady,
        new Error(`isolated Meridian service exited before readiness (${code ?? signal ?? "unknown"})`),
      );
      timer = setTimeout(() => finish(
        rejectReady,
        new Error("isolated Meridian service startup timed out"),
      ), options.coldServiceTimeoutMs);
      child.stdout.on("data", appendStdout);
      child.stderr.on("data", appendStderr);
      child.once("error", onError);
      child.once("exit", onExit);
    });
    if (!isLoopbackUrl(baseUrl)) throw new Error("isolated Meridian service announced a non-loopback origin");
    await requireHealthyOrigin(baseUrl);
    return {
      baseUrl,
      pid: child.pid,
      serviceInstanceId,
      cacheInstanceId,
      fullBaselineCapability,
      cleanupEvidence,
      stop,
    };
  } catch (error) {
    let cleanupError = null;
    try {
      await stop();
    } catch (stopError) {
      cleanupError = stopError;
    }
    const diagnostic = redactSecrets(`${stderr}\n${stdout}`).trim().slice(-4_000);
    const startupError = new Error(
      `${error instanceof Error ? error.message : String(error)}${diagnostic ? `: ${diagnostic}` : ""}`,
      { cause: error },
    );
    if (cleanupError !== null) {
      throw new AggregateError(
        [startupError, cleanupError],
        `isolated cold service startup failed and exact cleanup was not proved; preserved ${root}`,
      );
    }
    throw startupError;
  }
}

export function isolatedColdServiceArguments(cli, port, mode = {}) {
  if (typeof cli !== "string" || cli.trim() === "") {
    throw new TypeError("isolated cold service requires a CLI path");
  }
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) {
    throw new TypeError("isolated cold service requires a valid loopback port");
  }
  const argumentsList = [
    cli,
    "web",
    "--host", "127.0.0.1",
    "--port", String(port),
    "--no-open",
    "--typescript-incremental", "admitted",
    "--experimental-pr-revision-cache",
  ];
  if (mode.partialRuntimeOnly !== true) argumentsList.push("--benchmark-pr-full-baseline");
  return argumentsList;
}

export function fullBaselineCapabilityEvidenceFromArguments(argumentsList) {
  if (!Array.isArray(argumentsList)
    || argumentsList.some((argument) => typeof argument !== "string")) {
    throw new TypeError("full-baseline capability inspection requires string arguments");
  }
  const marker = "--benchmark-pr-full-baseline";
  return {
    inspected: true,
    present: argumentsList.includes(marker),
    source: "isolated-service-spawn-arguments",
    argument: marker,
    commandSha256: createHash("sha256").update(argumentsList.join("\0")).digest("hex"),
  };
}

/** Keep every Node temporary store created by the isolated service inside its owned cleanup root. */
export function isolatedColdServiceEnvironment(environment, root) {
  const ownedRoot = resolve(root);
  return {
    ...environment,
    TMPDIR: ownedRoot,
    TMP: ownedRoot,
    TEMP: ownedRoot,
  };
}

export function registerColdServiceSignalCleanup(stop) {
  activeColdServiceStops.add(stop);
  if (!coldSignalCleanupInstalled) {
    coldSignalCleanupInstalled = true;
    let handlingSignal = false;
    const handle = (signal) => {
      if (handlingSignal) return;
      handlingSignal = true;
      const exitCode = signal === "SIGINT" ? 130 : 143;
      void Promise.allSettled([...activeColdServiceStops].map((activeStop) => activeStop()))
        .then((settlements) => {
          const failures = settlements.filter((settlement) => settlement.status === "rejected");
          if (failures.length > 0) {
            process.stderr.write(`[pr-review-poc] ${failures.length} owned cleanup operation(s) failed during ${signal}\n`);
          }
        })
        .finally(() => process.exit(exitCode));
    };
    process.once("SIGINT", () => handle("SIGINT"));
    process.once("SIGTERM", () => handle("SIGTERM"));
  }
  return () => activeColdServiceStops.delete(stop);
}

async function reserveLoopbackPort() {
  const server = createServer();
  return new Promise((resolvePort, rejectPort) => {
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : null;
      server.close((error) => {
        if (error) rejectPort(error);
        else if (!Number.isSafeInteger(port) || port <= 0) rejectPort(new Error("could not reserve a loopback port"));
        else resolvePort(port);
      });
    });
  });
}

async function requireHealthyOrigin(baseUrl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("isolated Meridian health check timed out")), 10_000);
  try {
    const response = await fetch(baseUrl, { signal: controller.signal });
    if (!response.ok) throw new Error(`isolated Meridian health check returned HTTP ${response.status}`);
    await response.body?.cancel();
  } finally {
    clearTimeout(timer);
  }
}

function appendBoundedOutput(current, chunk) {
  const next = `${current}${String(chunk)}`;
  return next.length <= 256_000 ? next : next.slice(-256_000);
}

function childExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function signalOwnedProcess(child, signal) {
  if (!Number.isSafeInteger(child.pid) || child.pid <= 0 || childExited(child)) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

async function waitForChildExit(child, timeoutMs) {
  if (childExited(child)) return true;
  return new Promise((resolveExit) => {
    let settled = false;
    let timer = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      child.off("exit", onExit);
      resolveExit(value);
    };
    const onExit = () => finish(true);
    child.once("exit", onExit);
    timer = setTimeout(() => finish(false), timeoutMs);
  });
}

async function discoverLocalServiceProcess(baseUrl) {
  if (!isLoopbackUrl(baseUrl)) {
    return { pid: null, diagnostic: "Meridian service RSS is unavailable for a non-loopback benchmark URL" };
  }
  if (process.platform === "win32") {
    return { pid: null, diagnostic: "Meridian service RSS discovery is unavailable on Windows" };
  }
  const url = new URL(baseUrl);
  const port = url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
  try {
    const { stdout } = await execFileAsync("lsof", [
      "-nP",
      `-iTCP:${port}`,
      "-sTCP:LISTEN",
      "-t",
    ], { encoding: "utf8", maxBuffer: 1024 * 1024 });
    const pids = [...new Set(stdout.split(/\s+/)
      .filter((value) => /^\d+$/.test(value))
      .map(Number)
      .filter((pid) => Number.isSafeInteger(pid) && pid > 0))];
    if (pids.length !== 1) {
      return {
        pid: null,
        diagnostic: `expected one local Meridian listener on port ${port}, found ${pids.length}`,
      };
    }
    return { pid: pids[0], diagnostic: null };
  } catch {
    return { pid: null, diagnostic: `could not discover the local Meridian listener on port ${port}` };
  }
}

async function inspectListenerFullBaselineCapability(pid) {
  const unavailable = (diagnostic) => ({
    inspected: false,
    present: null,
    source: "listener-process-command",
    argument: "--benchmark-pr-full-baseline",
    commandSha256: null,
    listenerPid: Number.isSafeInteger(pid) && pid > 0 ? pid : null,
    diagnostic,
  });
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return unavailable("local listener PID is unavailable");
  }
  try {
    const { stdout } = await execFileAsync("ps", ["-ww", "-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    const command = stdout.trim();
    if (command === "") return unavailable("listener process command is unavailable");
    return {
      ...fullBaselineCapabilityEvidenceFromCommand(command),
      listenerPid: pid,
    };
  } catch {
    return unavailable("listener process command inspection failed");
  }
}

export function fullBaselineCapabilityEvidenceFromCommand(command) {
  if (typeof command !== "string" || command.trim() === "") {
    throw new TypeError("full-baseline capability inspection requires a non-empty command");
  }
  const normalized = command.trim();
  const marker = "--benchmark-pr-full-baseline";
  return {
    inspected: true,
    present: new RegExp(`(?:^|\\s)${marker}(?:\\s|$)`).test(normalized),
    source: "listener-process-command",
    argument: marker,
    commandSha256: createHash("sha256").update(normalized).digest("hex"),
  };
}

export function assertFullBaselineCapabilityAbsent(evidence, label = "Meridian service") {
  if (evidence?.inspected !== true
    || evidence?.present !== false
    || evidence?.argument !== "--benchmark-pr-full-baseline"
    || typeof evidence?.commandSha256 !== "string"
    || !/^[a-f0-9]{64}$/.test(evidence.commandSha256)) {
    throw new Error(`${label} did not prove the full-baseline benchmark capability absent`);
  }
  return evidence;
}

async function createOutputLayout(outputDir) {
  const root = resolve(outputDir);
  const parsed = parse(root);
  if (root === parsed.root || root === resolve(process.cwd())) throw new Error("refusing to use a broad output directory");
  await mkdir(dirname(root), { recursive: true });
  try {
    await stat(root);
    throw new Error(`output directory already exists: ${root}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await mkdir(root);
  const metadata = join(root, "metadata");
  const videos = join(root, "videos");
  const temporaryVideos = join(root, ".video-tmp");
  await Promise.all([
    mkdir(metadata),
    mkdir(videos),
    mkdir(temporaryVideos),
  ]);
  return {
    root,
    metadata,
    videos,
    temporaryVideos,
    results: join(root, RESULTS_FILENAME),
    report: join(root, REPORT_FILENAME),
  };
}

async function persistPrMetadata(outputPaths, entry) {
  await atomicWriteJson(join(outputPaths.metadata, `autopilot-pr-${entry.number}.json`), {
    number: entry.number,
    title: entry.title,
    url: entry.url,
    status: entry.status,
    revisions: entry.revisions,
    preparation: entry.preparation,
    coldEndToEnd: entry.coldEndToEnd,
  });
}

async function persistResults(outputPaths, document) {
  await atomicWriteJson(outputPaths.results, document);
  await atomicWriteText(outputPaths.report, renderHtmlReport(document));
}

async function atomicWriteJson(path, value) {
  await atomicWriteText(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function atomicWriteText(path, value) {
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, value, { encoding: "utf8", flag: "wx" });
  await rename(temporary, path);
}

async function safeExec(command, args, execOptions = {}) {
  try {
    return await execFileAsync(command, args, {
      encoding: "utf8",
      env: { ...process.env, GH_PAGER: "cat", NO_COLOR: "1" },
      ...execOptions,
    });
  } catch (error) {
    const stderr = redactSecrets(error?.stderr ?? "").trim().slice(0, 4_000);
    throw new Error(`${command} failed${stderr ? `: ${stderr}` : ""}`);
  }
}

function finiteOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function roundMs(value) {
  return Math.round(value * 10) / 10;
}

function roundNullable(value) {
  return typeof value === "number" && Number.isFinite(value) ? roundMs(value) : null;
}

function log(message) {
  process.stdout.write(`[pr-review-poc] ${message}\n`);
}
