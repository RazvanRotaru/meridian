import { createHash } from "node:crypto";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export const PR_REVIEW_POC_SCHEMA_VERSION = 3;
/** Fresh evidence produced after the partial graph became the lasting review model. Schema v3
 * remains readable because report-v19/v20 artifacts already use it; this explicit contract is the
 * semantic discriminator for v21+ evidence. */
export const PARTIAL_ONLY_DELIVERY_CONTRACT = "partial-only-v1";
/** Absolute, progressive-lane-only evidence collected against the normal production listener.
 * This contract deliberately has no full/canonical comparison lane and therefore cannot publish
 * reduction percentages. */
export const PARTIAL_RUNTIME_ONLY_DELIVERY_CONTRACT = "partial-runtime-only-v1";
export const LANDING_CLOCK_CALIBRATION_SAMPLE_COUNT = 9;
export const LANDING_CLOCK_MAX_SELECTED_RTT_MS = 100;
export const DEFAULT_AUTOPILOT_PRS = Object.freeze([4712, 4703, 3851]);
export const DEFAULT_VIEWPORT = Object.freeze({ width: 1440, height: 900 });

const OID_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const GRAPH_TRANSFER_PATHS = Object.freeze(["/api/graph", "/api/graph/project"]);
const SECRET_PATTERNS = [
  /\b(?:ghp|github_pat|gho|ghu|ghs|ghr)_[A-Za-z0-9_]+\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\b(?:token|authorization)\s*[:=]\s*[^\s,;]+/gi,
];

export function parseHarnessArgs(argv, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const now = options.now ?? new Date();
  const values = new Map();
  const flags = new Set();
  const booleanFlags = new Set([
    "headed",
    "no-recordings",
    "skip-video-validation",
    "allow-search-skip",
    "no-cold",
    "partial-runtime-only",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token?.startsWith("--")) throw new TypeError(`unexpected argument: ${token ?? "<missing>"}`);
    const name = token.slice(2);
    if (booleanFlags.has(name)) {
      if (flags.has(name) || values.has(name)) throw new TypeError(`duplicate option: --${name}`);
      flags.add(name);
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new TypeError(`--${name} requires a value`);
    if (flags.has(name) || values.has(name)) throw new TypeError(`duplicate option: --${name}`);
    values.set(name, value);
    index += 1;
  }

  const known = new Set([
    "url",
    "repository",
    "prs",
    "output",
    "repetitions",
    "timeout-ms",
    "prepare-timeout-ms",
    "video-dwell-ms",
    "gh",
    "gh-hostname",
    "ffmpeg",
    "ffprobe",
    "cold-cli",
    "cold-service-timeout-ms",
  ]);
  for (const key of values.keys()) {
    if (!known.has(key)) throw new TypeError(`unknown option: --${key}`);
  }

  const rawUrl = required(values, "url");
  const baseUrl = normalizeBaseUrl(rawUrl);
  const partialRuntimeOnly = flags.has("partial-runtime-only");
  if (partialRuntimeOnly && !isLoopbackOrigin(baseUrl)) {
    throw new TypeError("--partial-runtime-only requires a loopback production origin");
  }
  if (partialRuntimeOnly && flags.has("no-recordings")) {
    throw new TypeError("--partial-runtime-only requires both progressive recordings per PR");
  }
  if (partialRuntimeOnly && flags.has("skip-video-validation")) {
    throw new TypeError("--partial-runtime-only requires validated progressive recordings");
  }
  if (partialRuntimeOnly && flags.has("allow-search-skip")) {
    throw new TypeError("--partial-runtime-only requires disconnected-symbol search hydration evidence");
  }
  if (partialRuntimeOnly && flags.has("no-cold")) {
    throw new TypeError("--partial-runtime-only requires isolated cold progressive evidence");
  }
  const repository = values.get("repository") ?? "UiPath/Autopilot";
  if (!REPOSITORY_PATTERN.test(repository) || repository.endsWith(".git")) {
    throw new TypeError("--repository must be an exact owner/repository name");
  }
  const prs = parsePrList(values.get("prs") ?? DEFAULT_AUTOPILOT_PRS.join(","));
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const outputDir = resolve(cwd, values.get("output") ?? `artifacts/pr-review-progressive-poc-${stamp}`);

  return {
    baseUrl,
    repository,
    prs,
    outputDir,
    repetitions: boundedInteger(values.get("repetitions") ?? "3", "--repetitions", 1, 10),
    timeoutMs: boundedInteger(values.get("timeout-ms") ?? "180000", "--timeout-ms", 5_000, 900_000),
    prepareTimeoutMs: boundedInteger(
      values.get("prepare-timeout-ms") ?? "1200000",
      "--prepare-timeout-ms",
      30_000,
      3_600_000,
    ),
    videoDwellMs: boundedInteger(values.get("video-dwell-ms") ?? "1400", "--video-dwell-ms", 250, 10_000),
    headed: flags.has("headed"),
    recordVideos: !flags.has("no-recordings"),
    validateVideos: !flags.has("skip-video-validation"),
    allowSearchSkip: flags.has("allow-search-skip"),
    coldEndToEnd: !flags.has("no-cold"),
    partialRuntimeOnly,
    coldCliPath: resolve(cwd, values.get("cold-cli") ?? "packages/cli/dist/bin.js"),
    coldServiceTimeoutMs: boundedInteger(
      values.get("cold-service-timeout-ms") ?? "60000",
      "--cold-service-timeout-ms",
      5_000,
      300_000,
    ),
    ghPath: executableOption(values, "gh", "gh"),
    ghHostname: optionalNonEmpty(values.get("gh-hostname")),
    ffmpegPath: executableOption(values, "ffmpeg", "ffmpeg"),
    ffprobePath: executableOption(values, "ffprobe", "ffprobe"),
    viewport: { ...DEFAULT_VIEWPORT },
  };
}

export function harnessUsage() {
  return [
    "Usage: benchmark-pr-review-progressive.mjs --url URL [options]",
    "",
    "Required:",
    "  --url URL                    Running Meridian origin, e.g. http://127.0.0.1:4189",
    "",
    "Options:",
    "  --repository OWNER/REPO      GitHub repository (default: UiPath/Autopilot)",
    "  --prs N,N,N                  PRs (default: 4712,4703,3851)",
    "  --output DIRECTORY           New output directory (default: timestamped artifacts path)",
    "  --repetitions N              Fresh-browser samples per variant (default: 3)",
    "  --timeout-ms N               Per-navigation timeout (default: 180000)",
    "  --prepare-timeout-ms N       Exact pair preparation timeout (default: 1200000)",
    "  --video-dwell-ms N           Human-readable pause between recorded actions (default: 1400)",
    "  --headed                     Show Chromium while measuring",
    "  --no-recordings              Metrics-only diagnostic run",
    "  --skip-video-validation      Do not require ffprobe/ffmpeg verification",
    "  --allow-search-skip          Permit a recording without disconnected-symbol hydration",
    "  --no-cold                    Disable isolated cold end-to-end evidence (diagnostic only)",
    "  --partial-runtime-only       Collect absolute production evidence with no full graph lane",
    "  --cold-cli PATH              Built Meridian CLI used by isolated cold services",
    "                               (default: packages/cli/dist/bin.js)",
    "  --cold-service-timeout-ms N  Isolated service startup/shutdown timeout (default: 60000)",
    "  --gh PATH                    gh executable (default: gh)",
    "  --gh-hostname HOST           GitHub Enterprise hostname",
    "  --ffmpeg PATH                ffmpeg executable (default: ffmpeg)",
    "  --ffprobe PATH               ffprobe executable (default: ffprobe)",
  ].join("\n");
}

export function parsePrList(value) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError("--prs must not be empty");
  const result = [];
  const seen = new Set();
  for (const raw of value.split(",")) {
    if (!/^[1-9]\d*$/.test(raw.trim())) throw new TypeError(`invalid PR number: ${raw}`);
    const number = Number(raw.trim());
    if (!Number.isSafeInteger(number) || number > 2_147_483_647) throw new TypeError(`invalid PR number: ${raw}`);
    if (!seen.has(number)) result.push(number);
    seen.add(number);
  }
  if (result.length === 0 || result.length > 20) throw new TypeError("--prs must contain between 1 and 20 PR numbers");
  return result;
}

export function parseGitHubPull(value, repository, expectedNumber) {
  const pull = record(value, "GitHub pull request");
  const head = record(pull.head, "GitHub pull request head");
  const base = record(pull.base, "GitHub pull request base");
  const number = positiveInteger(pull.number, "GitHub pull request number");
  if (number !== expectedNumber) throw new TypeError(`GitHub returned PR #${number}, expected #${expectedNumber}`);
  const state = string(pull.state, "GitHub pull request state");
  if (state !== "open") throw new TypeError(`PR #${number} is ${state}; benchmark inputs must remain open`);
  const baseRepository = nullableRepositoryName(base.repo) ?? repository;
  if (baseRepository.toLowerCase() !== repository.toLowerCase()) {
    throw new TypeError(`PR #${number} belongs to ${baseRepository}, expected ${repository}`);
  }
  return {
    repository,
    number,
    title: string(pull.title, "GitHub pull request title"),
    url: safeWebUrl(pull.html_url, "GitHub pull request URL"),
    headRef: gitRef(head.ref, "GitHub head ref"),
    headOid: oid(head.sha, "GitHub head OID"),
    headRepository: nullableRepositoryName(head.repo),
    baseRef: gitRef(base.ref, "GitHub base ref"),
    baseOid: oid(base.sha, "GitHub base OID"),
    baseRepository,
    updatedAt: isoTimestamp(pull.updated_at, "GitHub pull request updated_at"),
    resolvedAt: new Date().toISOString(),
  };
}

export function assertStablePullRevision(before, after) {
  // The target branch tip is moving provenance, not semantic review identity. Meridian's immutable
  // review pair is keyed by HEAD + merge-base; a base-only advance is explicitly reused by the
  // production analyzer when those coordinates and both graph ids remain exact.
  for (const field of [
    "repository",
    "number",
    "headRef",
    "headOid",
    "headRepository",
    "baseRef",
    "baseRepository",
  ]) {
    if (before[field] !== after[field]) {
      throw new Error(
        `PR #${before.number} moved while benchmarking (${field}: ${before[field]} -> ${after[field]}); results rejected`,
      );
    }
  }
}

export function validatePreparedTerminal(live, terminal) {
  const value = record(terminal, "PR preparation terminal event");
  if (value.stage !== "done") throw new TypeError("PR preparation did not finish with a done event");
  const headSha = oid(value.headSha, "prepared head SHA");
  const baseSha = oid(value.baseSha, "prepared base SHA");
  const mergeBaseSha = oid(value.mergeBaseSha, "prepared merge-base SHA");
  if (headSha !== live.headOid) {
    throw new Error(`PR #${live.number} prepared stale HEAD ${headSha}; live HEAD is ${live.headOid}`);
  }
  const graphId = nonEmptyString(value.graphId, "prepared graphId");
  const comparisonGraphId = nonEmptyString(value.comparisonGraphId, "prepared comparisonGraphId");
  const viewUrl = relativeViewUrl(value.viewUrl);
  const destination = new URL(viewUrl, "http://meridian.local");
  if (destination.searchParams.get("id") !== graphId
    || destination.searchParams.get("prn") !== String(live.number)
    || destination.searchParams.get("rev") !== "1"
    || destination.searchParams.get("progressive") !== "1"
    || destination.searchParams.has("partial")
    || destination.searchParams.has("pair")) {
    throw new TypeError("prepared viewUrl does not opt the exact PR pair into progressive review");
  }
  const initialProjectionCache = validateInitialProjectionCache(
    value.initialProjectionCache,
    "prepared initial projection cache",
  );
  const preparedPair = record(value.preparedPair, "prepared pair");
  if (
    preparedPair.version !== 1
    || preparedPair.prNumber !== live.number
    || preparedPair.headGraphId !== graphId
    || preparedPair.mergeBaseGraphId !== comparisonGraphId
    || preparedPair.headSha !== headSha
    || preparedPair.baseSha !== baseSha
    || preparedPair.mergeBaseSha !== mergeBaseSha
  ) {
    throw new TypeError("preparedPair does not correlate with the terminal preparation event");
  }
  const counts = countPair(value.counts, "prepared graph counts");
  const changedFiles = canonicalChangedManifest(value.changedFiles, "prepared changedFiles");
  return {
    graphId,
    comparisonGraphId,
    headSha,
    baseSha,
    mergeBaseSha,
    viewUrl,
    initialProjectionCache,
    counts,
    changedFiles,
    cache: value.cache === "hit" || value.cache === "miss" ? value.cache : "unknown",
  };
}

/** Validate the bounded pair that authorizes the landing page to navigate. The same pair is the
 * lasting partial-only review model; no canonical extraction follows this gate. */
export function validateProvisionalReady(live, terminal) {
  const value = record(terminal, "PR preparation ready event");
  if (value.stage !== "ready" || value.completeness !== "provisional") {
    throw new TypeError("PR preparation did not emit a provisional ready event");
  }
  const provisional = validateProvisionalPair(live, value, "provisional");
  const viewUrl = validateProvisionalViewUrl(live, provisional, value.viewUrl, "provisional");
  const preparedPair = record(value.preparedPair, "provisional prepared pair");
  if (preparedPair.version !== 1
    || preparedPair.prNumber !== live.number
    || preparedPair.headGraphId !== provisional.graphId
    || preparedPair.mergeBaseGraphId !== provisional.comparisonGraphId
    || preparedPair.headSha !== provisional.headSha
    || preparedPair.baseSha !== provisional.baseSha
    || preparedPair.mergeBaseSha !== provisional.mergeBaseSha
    || preparedPair.completeness !== "provisional"
    || preparedPair.pairId !== provisional.pairId) {
    throw new TypeError("provisional preparedPair does not correlate with the ready event");
  }
  return {
    ...provisional,
    viewUrl,
  };
}

/** Validate the renderer's exact-revision revalidation response. `/api/pr/analyze` deliberately
 * carries graph/revision facts only: the already-validated landing preparation remains the sole
 * source of navigation authority, so this terminal must omit `viewUrl` and `preparedPair`. */
export function validatePartialAnalyzeTerminal(live, prepared, done) {
  const landing = record(prepared, "prepared provisional landing pair");
  if (landing.completeness !== "provisional") {
    throw new TypeError("prepared landing pair is not provisional");
  }
  const expected = validateProvisionalPair(live, landing, "prepared provisional");
  validateProvisionalViewUrl(live, expected, landing.viewUrl, "prepared provisional");

  const terminal = record(done, "partial analyze terminal event");
  if (terminal.stage !== "done" || terminal.completeness !== "provisional") {
    throw new TypeError("partial analyze did not finish with a provisional done event");
  }
  if (terminal.viewUrl !== undefined || terminal.preparedPair !== undefined) {
    throw new TypeError("partial analyze terminal must omit landing navigation fields");
  }
  const actual = validateProvisionalPair(live, terminal, "partial analyze");
  for (const field of [
    "graphId",
    "comparisonGraphId",
    "headSha",
    "mergeBaseSha",
    "pairId",
    "completeness",
  ]) {
    if (actual[field] !== expected[field]) {
      throw new TypeError(`partial analyze changed exact ${field}`);
    }
  }
  for (const field of ["initialProjectionCache", "counts", "changedFiles"]) {
    if (JSON.stringify(actual[field]) !== JSON.stringify(expected[field])) {
      throw new TypeError(`partial analyze changed ${field}`);
    }
  }
  return {
    ...actual,
    preparedBaseSha: expected.baseSha,
    baseTipDrift: actual.baseSha !== expected.baseSha,
  };
}

/** Validate the authoritative terminal for a partial-only preparation. `ready` is the navigation
 * gate; the immediately following `done` is an EOF-friendly acknowledgement of the exact same
 * bounded pair, not a second or more-complete graph generation. */
export function validatePartialPreparationTerminal(live, ready, done) {
  const provisional = validateProvisionalReady(live, ready);
  const terminal = record(done, "partial-only PR preparation terminal event");
  if (terminal.stage !== "done" || terminal.completeness !== "provisional") {
    throw new TypeError("partial-only PR preparation did not finish with a provisional done event");
  }
  const completed = validateProvisionalReady(live, { ...terminal, stage: "ready" });
  for (const field of [
    "graphId",
    "comparisonGraphId",
    "headSha",
    "baseSha",
    "mergeBaseSha",
    "pairId",
    "completeness",
    "viewUrl",
    "cache",
  ]) {
    if (completed[field] !== provisional[field]) {
      throw new TypeError(`partial-only ready/done changed exact ${field}`);
    }
  }
  for (const field of ["initialProjectionCache", "counts", "changedFiles"]) {
    if (JSON.stringify(completed[field]) !== JSON.stringify(provisional[field])) {
      throw new TypeError(`partial-only ready/done changed ${field}`);
    }
  }
  return completed;
}

/** Prove the complete streamed lifecycle. This must be called only after the NDJSON reader reaches
 * EOF; the returned `streamEnded` flag therefore records an observed transport boundary rather
 * than inferring quiescence from a UI mark. */
export function validatePartialPreparationStream(live, events) {
  if (!Array.isArray(events) || events.length < 2) {
    throw new TypeError("partial-only preparation has no complete streamed lifecycle");
  }
  const payloads = events.map((event) => event?.payload ?? event);
  const readyIndexes = payloads.flatMap((payload, index) => payload?.stage === "ready" ? [index] : []);
  const doneIndexes = payloads.flatMap((payload, index) => payload?.stage === "done" ? [index] : []);
  if (readyIndexes.length !== 1 || doneIndexes.length !== 1) {
    throw new TypeError("partial-only preparation must emit exactly one ready and one done event");
  }
  const readyIndex = readyIndexes[0];
  const doneIndex = doneIndexes[0];
  if (doneIndex !== payloads.length - 1 || readyIndex !== doneIndex - 1) {
    throw new TypeError("partial-only preparation must end with adjacent ready, done, and EOF");
  }
  const prepared = validatePartialPreparationTerminal(
    live,
    payloads[readyIndex],
    payloads[doneIndex],
  );
  const postReadyStages = payloads.slice(readyIndex + 1).map((payload) => payload?.stage ?? null);
  if (JSON.stringify(postReadyStages) !== JSON.stringify(["done"])) {
    throw new TypeError("partial-only preparation continued work after the ready pair");
  }
  return {
    version: 1,
    delivery: PARTIAL_ONLY_DELIVERY_CONTRACT,
    streamEnded: true,
    readyIndex,
    doneIndex,
    eventCount: payloads.length,
    postReadyStages,
    sameBoundedPair: true,
    canonicalContinuationObserved: false,
    pairId: prepared.pairId,
    graphId: prepared.graphId,
    comparisonGraphId: prepared.comparisonGraphId,
    prepared,
  };
}

/** Validate the explicit `progressive:false` compatibility lane used only as the full-artifact
 * measurement baseline. Unlike direct progressive preparation, `/api/pr/analyze` returns no view
 * URL, so the harness constructs the ordinary immutable review URL after validating all revision
 * coordinates. */
export function validateCanonicalBaselineTerminal(live, terminal) {
  const value = record(terminal, "canonical baseline terminal event");
  if (value.stage !== "done" || value.completeness !== undefined || value.pairId !== undefined) {
    throw new TypeError("canonical baseline did not finish with a complete done event");
  }
  const headSha = oid(value.headSha, "canonical baseline head SHA");
  const baseSha = oid(value.baseSha, "canonical baseline base SHA");
  const mergeBaseSha = oid(value.mergeBaseSha, "canonical baseline merge-base SHA");
  if (headSha !== live.headOid) {
    throw new Error(`PR #${live.number} prepared stale canonical HEAD ${headSha}; live HEAD is ${live.headOid}`);
  }
  const graphId = nonEmptyString(value.graphId, "canonical baseline graphId");
  const comparisonGraphId = nonEmptyString(
    value.comparisonGraphId,
    "canonical baseline comparisonGraphId",
  );
  if (graphId.startsWith("pr-partial-") || comparisonGraphId.startsWith("pr-partial-base-")) {
    throw new TypeError("canonical baseline reused a bounded partial graph id");
  }
  const viewUrl = `/view?${new URLSearchParams({
    id: graphId,
    view: "modules",
    prn: String(live.number),
    rev: "1",
    progressive: "0",
  }).toString()}`;
  return {
    graphId,
    comparisonGraphId,
    headSha,
    baseSha,
    mergeBaseSha,
    viewUrl,
    counts: countPair(value.counts, "canonical baseline graph counts"),
    changedFiles: canonicalChangedManifest(value.changedFiles, "canonical baseline changedFiles"),
    cache: value.cache === "hit" || value.cache === "miss" ? value.cache : "unknown",
    completeness: "complete",
  };
}

/** Prove that early navigation and the independently drained canonical terminal describe one PR revision. */
export function validatePreparationHandoff(live, ready, done) {
  if (done?.completeness === "provisional") {
    const prepared = validatePartialPreparationTerminal(live, ready, done);
    const manifest = JSON.stringify(prepared.changedFiles);
    return {
      version: 2,
      delivery: PARTIAL_ONLY_DELIVERY_CONTRACT,
      pairId: prepared.pairId,
      exactRevisionBound: true,
      manifestSha256: createHash("sha256").update(manifest).digest("hex"),
      sameBoundedPair: true,
      canonicalContinuationObserved: false,
      partial: exactPreparedPair(prepared),
    };
  }
  const provisional = validateProvisionalReady(live, ready);
  const canonical = validatePreparedTerminal(live, done);
  for (const field of ["headSha", "baseSha", "mergeBaseSha"]) {
    if (provisional[field] !== canonical[field]) {
      throw new TypeError(`provisional/canonical handoff changed exact ${field}`);
    }
  }
  if (provisional.graphId === canonical.graphId
    || provisional.comparisonGraphId === canonical.comparisonGraphId) {
    throw new TypeError("provisional/canonical handoff reused a bounded graph id as canonical");
  }
  const provisionalManifest = JSON.stringify(provisional.changedFiles);
  const canonicalManifest = JSON.stringify(canonical.changedFiles);
  if (provisionalManifest !== canonicalManifest) {
    throw new TypeError("provisional/canonical handoff changed the exact file manifest");
  }
  return {
    version: 1,
    pairId: provisional.pairId,
    exactRevisionBound: true,
    manifestSha256: createHash("sha256").update(canonicalManifest).digest("hex"),
    provisional: exactPreparedPair(provisional),
    canonical: exactPreparedPair(canonical),
  };
}

/** Validate the renderer-owned terminal and its canonical reconciliation mark after provisional boot. */
export function validateCanonicalReconciliation(provisional, canonical, terminals, performanceMarks) {
  const exactRevision = validateSampleRevision(canonical, terminals);
  for (const field of ["headSha", "baseSha", "mergeBaseSha"]) {
    if (provisional?.[field] !== canonical?.[field]) {
      throw new TypeError(`renderer reconciliation changed exact ${field}`);
    }
  }
  if (!Array.isArray(performanceMarks)) throw new TypeError("renderer reconciliation marks are missing");
  const marks = performanceMarks.filter((entry) => entry?.name === "meridian:pr-canonical-graph-reconciled");
  if (marks.length !== 1) {
    throw new TypeError(`renderer emitted ${marks.length} canonical reconciliation marks; expected one`);
  }
  const mark = marks[0];
  if (!finiteNumber(mark.startTimeMs) || mark.startTimeMs < 0
    || mark.detail?.graphId !== canonical.graphId) {
    throw new TypeError("renderer canonical reconciliation mark does not bind the canonical HEAD graph");
  }
  return {
    version: 1,
    required: true,
    pairId: provisional.pairId,
    provisionalGraphId: provisional.graphId,
    provisionalComparisonGraphId: provisional.comparisonGraphId,
    canonicalGraphId: canonical.graphId,
    canonicalComparisonGraphId: canonical.comparisonGraphId,
    exactRevisionBound: true,
    mark: {
      name: mark.name,
      startTimeMs: mark.startTimeMs,
      detail: { graphId: mark.detail.graphId },
    },
    exactRevision,
  };
}

function exactPreparedPair(value) {
  return {
    graphId: value.graphId,
    comparisonGraphId: value.comparisonGraphId,
    headSha: value.headSha,
    baseSha: value.baseSha,
    mergeBaseSha: value.mergeBaseSha,
  };
}

function validateProvisionalPair(live, input, name) {
  const value = record(input, `${name} pair`);
  if (value.completeness !== "provisional") {
    throw new TypeError(`${name} pair is not provisional`);
  }
  const pairId = nonEmptyString(value.pairId, `${name} pairId`);
  if (!/^[a-f0-9]{20}$/.test(pairId)) throw new TypeError(`${name} pairId is invalid`);
  const headSha = oid(value.headSha, `${name} head SHA`);
  const baseSha = oid(value.baseSha, `${name} base SHA`);
  const mergeBaseSha = oid(value.mergeBaseSha, `${name} merge-base SHA`);
  if (headSha !== live.headOid) {
    throw new Error(`PR #${live.number} prepared stale ${name} HEAD ${headSha}; live HEAD is ${live.headOid}`);
  }
  const graphId = nonEmptyString(value.graphId, `${name} graphId`);
  const comparisonGraphId = nonEmptyString(value.comparisonGraphId, `${name} comparisonGraphId`);
  if (graphId !== `pr-partial-${pairId}-${headSha}`
    || comparisonGraphId !== `pr-partial-base-${pairId}-${mergeBaseSha}`) {
    throw new TypeError(`${name} graph ids do not bind the exact pairId and revisions`);
  }
  return {
    graphId,
    comparisonGraphId,
    headSha,
    baseSha,
    mergeBaseSha,
    pairId,
    completeness: "provisional",
    initialProjectionCache: validateInitialProjectionCache(
      value.initialProjectionCache,
      `${name} initial projection cache`,
    ),
    counts: countPair(value.counts, `${name} graph counts`),
    changedFiles: canonicalChangedManifest(value.changedFiles, `${name} changedFiles`),
    cache: value.cache === "hit" || value.cache === "miss" ? value.cache : "unknown",
  };
}

function validateProvisionalViewUrl(live, pair, input, name) {
  const viewUrl = relativeViewUrl(input);
  const destination = new URL(viewUrl, "http://meridian.local");
  if (destination.searchParams.get("id") !== pair.graphId
    || destination.searchParams.get("prn") !== String(live.number)
    || destination.searchParams.get("rev") !== "1"
    || destination.searchParams.get("progressive") !== "1"
    || destination.searchParams.get("partial") !== "1"
    || destination.searchParams.get("pair") !== pair.pairId) {
    throw new TypeError(`${name} viewUrl does not bind the exact ready pair`);
  }
  return viewUrl;
}

function validateInitialProjectionCache(value, name) {
  const cache = record(value, name);
  const headKey = nonEmptyString(cache.headKey, `${name} headKey`);
  const comparisonKey = nonEmptyString(cache.comparisonKey, `${name} comparisonKey`);
  if (cache.version !== 1
    || cache.depth !== 1
    || cache.prefetchDepth !== 3
    || cache.ready !== true
    || !/^[a-f0-9]{64}$/.test(headKey)
    || !/^[a-f0-9]{64}$/.test(comparisonKey)
    || headKey === comparisonKey) {
    throw new TypeError(`${name} does not prove a ready exact depth-1/prefetch-3 pair`);
  }
  return {
    version: 1,
    depth: 1,
    prefetchDepth: 3,
    headKey,
    comparisonKey,
    ready: true,
  };
}

export function validateSampleRevision(prepared, terminals) {
  if (!Array.isArray(terminals) || terminals.length !== 1) {
    throw new Error(
      `review navigation emitted ${Array.isArray(terminals) ? terminals.length : "no"}`
        + " /api/pr/analyze terminal events; exactly one revalidation is required",
    );
  }
  const terminal = record(terminals[0], "PR analyze terminal event");
  if (terminal.stage !== "done") {
    throw new Error(`review navigation ended with ${String(terminal.stage ?? "no stage")}; exact revision was not revalidated`);
  }
  const actual = {
    graphId: nonEmptyString(terminal.graphId, "analyzed graphId"),
    comparisonGraphId: nonEmptyString(terminal.comparisonGraphId, "analyzed comparisonGraphId"),
    headSha: oid(terminal.headSha, "analyzed head SHA"),
    baseSha: oid(terminal.baseSha, "analyzed base SHA"),
    mergeBaseSha: oid(terminal.mergeBaseSha, "analyzed merge-base SHA"),
  };
  const semanticDrift = ["graphId", "comparisonGraphId", "headSha", "mergeBaseSha"]
    .filter((field) => actual[field] !== prepared[field]);
  if (semanticDrift.length > 0) {
    throw new Error(
      `review navigation changed exact semantic coordinates (${semanticDrift.join(", ")}); sample rejected`,
    );
  }
  const preparedBaseSha = oid(prepared.baseSha, "prepared base SHA");
  return {
    ...actual,
    preparedBaseSha,
    baseTipDrift: actual.baseSha !== preparedBaseSha,
  };
}

export function parseNdjsonText(text) {
  if (typeof text !== "string") throw new TypeError("NDJSON input must be text");
  return text.split("\n").flatMap((line, index) => {
    const trimmed = line.trim();
    if (trimmed === "") return [];
    try {
      return [JSON.parse(trimmed)];
    } catch {
      throw new TypeError(`invalid NDJSON at line ${index + 1}`);
    }
  });
}

export function deriveVariantUrls(baseUrl, relativeUrl) {
  const prepared = new URL(relativeViewUrl(relativeUrl), normalizeBaseUrl(baseUrl));
  const progressive = new URL(prepared);
  progressive.searchParams.set("progressive", "1");
  const full = new URL(prepared);
  full.searchParams.set("progressive", "0");
  return { full: full.href, progressive: progressive.href };
}

export function summarizeVariant(samples) {
  if (!Array.isArray(samples) || samples.length === 0) throw new TypeError("variant needs at least one sample");
  const fields = [
    ["firstActionableMs", (sample) => sample.timings?.firstActionableMs],
    ["settledMs", (sample) => sample.timings?.settledMs],
    ["encodedBytesAtAction", (sample) => sample.networkAtAction?.encodedBytes],
    ["graphBytesAtAction", (sample) => sample.networkAtAction?.graphEncodedBytes],
    ["encodedBytesSettled", (sample) => sample.networkSettled?.encodedBytes],
    ["graphBytesSettled", (sample) => sample.networkSettled?.graphEncodedBytes],
    ["browserJsHeapPeakBytes", (sample) => readMetric(sample, [
      "memoryPeak.browserJsHeapUsedBytes",
      "memoryPeak.jsHeapUsedBytes",
      "memoryPeak.browser.jsHeapUsedBytes",
    ])],
    ["browserRssPeakBytes", (sample) => readMetric(sample, [
      "memoryPeak.browserProcessRssBytes",
      "memoryPeak.processRssBytes",
      "memoryPeak.browserRssBytes",
      "memoryPeak.browser.processRssBytes",
      "memoryPeak.browser.rssBytes",
    ])],
    ["browserJsHeapRetainedBytes", (sample) => readMetric(sample, [
      "memorySettled.browserJsHeapUsedBytes",
      "memorySettled.jsHeapUsedBytes",
      "memorySettled.browser.jsHeapUsedBytes",
    ])],
    ["browserRssRetainedBytes", (sample) => readMetric(sample, [
      "memorySettled.browserProcessRssBytes",
      "memorySettled.processRssBytes",
      "memorySettled.browserRssBytes",
      "memorySettled.browser.processRssBytes",
      "memorySettled.browser.rssBytes",
    ])],
    ["serviceRssPeakBytes", (sample) => readMetric(sample, [
      "memoryPeak.serviceRssBytes",
      "memoryPeak.serviceProcessRssBytes",
      "memoryPeak.service.rssBytes",
      "serviceMemoryPeak.rssBytes",
      "serviceMemory.peakRssBytes",
    ])],
    ["serviceRssRetainedBytes", (sample) => readMetric(sample, [
      "memorySettled.serviceRssBytes",
      "memorySettled.serviceProcessRssBytes",
      "memorySettled.service.rssBytes",
      "serviceMemorySettled.rssBytes",
      "serviceMemory.retainedRssBytes",
    ])],
    ["workerRssPeakBytes", (sample) => readMetric(sample, [
      "memoryPeak.workerRssBytes",
      "memoryPeak.projectionWorkerRssBytes",
      "memoryPeak.worker.rssBytes",
      "workerMemoryPeak.rssBytes",
      "serviceMemory.workerPeakRssBytes",
    ])],
    ["workerRssRetainedBytes", (sample) => readMetric(sample, [
      "memorySettled.workerRssBytes",
      "memorySettled.projectionWorkerRssBytes",
      "memorySettled.worker.rssBytes",
      "workerMemorySettled.rssBytes",
      "serviceMemory.workerRetainedRssBytes",
    ])],
    ["domNodes", (sample) => sample.domSettled?.documentNodes],
    ["canvasNodes", (sample) => sample.domSettled?.canvasNodes],
    ["canvasEdges", (sample) => sample.domSettled?.canvasEdges],
  ];
  const summary = { sampleCount: samples.length };
  for (const [name, read] of fields) summary[name] = median(samples.map(read).filter(finiteNumber));
  summary.firstActionableFirstMs = finiteOrNull(samples[0]?.timings?.firstActionableMs);
  summary.settledFirstMs = finiteOrNull(samples[0]?.timings?.settledMs);
  summary.firstActionableWarmMedianMs = median(
    samples.slice(1).map((sample) => sample.timings?.firstActionableMs).filter(finiteNumber),
  );
  summary.settledWarmMedianMs = median(
    samples.slice(1).map((sample) => sample.timings?.settledMs).filter(finiteNumber),
  );
  // Backward-compatible aliases for existing evidence consumers. The report uses the explicit
  // peak/retained browser labels above so a point-in-time sample cannot be mistaken for a peak.
  summary.jsHeapUsedBytes = summary.browserJsHeapRetainedBytes;
  summary.processRssBytes = summary.browserRssRetainedBytes;
  return summary;
}

export function comparisonFromSummaries(full, progressive) {
  return {
    firstActionableImprovementPct: reductionPercent(full.firstActionableMs, progressive.firstActionableMs),
    firstActionableFirstImprovementPct: reductionPercent(
      full.firstActionableFirstMs,
      progressive.firstActionableFirstMs,
    ),
    firstActionableWarmImprovementPct: reductionPercent(
      full.firstActionableWarmMedianMs,
      progressive.firstActionableWarmMedianMs,
    ),
    settledImprovementPct: reductionPercent(full.settledMs, progressive.settledMs),
    settledFirstImprovementPct: reductionPercent(full.settledFirstMs, progressive.settledFirstMs),
    settledWarmImprovementPct: reductionPercent(full.settledWarmMedianMs, progressive.settledWarmMedianMs),
    graphBytesAtActionReductionPct: reductionPercent(full.graphBytesAtAction, progressive.graphBytesAtAction),
    graphBytesSettledReductionPct: reductionPercent(full.graphBytesSettled, progressive.graphBytesSettled),
    browserJsHeapPeakReductionPct: reductionPercent(full.browserJsHeapPeakBytes, progressive.browserJsHeapPeakBytes),
    browserRssPeakReductionPct: reductionPercent(full.browserRssPeakBytes, progressive.browserRssPeakBytes),
    browserJsHeapRetainedReductionPct: reductionPercent(
      full.browserJsHeapRetainedBytes,
      progressive.browserJsHeapRetainedBytes,
    ),
    browserRssRetainedReductionPct: reductionPercent(
      full.browserRssRetainedBytes,
      progressive.browserRssRetainedBytes,
    ),
    serviceRssPeakReductionPct: reductionPercent(full.serviceRssPeakBytes, progressive.serviceRssPeakBytes),
    serviceRssRetainedReductionPct: reductionPercent(
      full.serviceRssRetainedBytes,
      progressive.serviceRssRetainedBytes,
    ),
    workerRssPeakReductionPct: reductionPercent(full.workerRssPeakBytes, progressive.workerRssPeakBytes),
    workerRssRetainedReductionPct: reductionPercent(
      full.workerRssRetainedBytes,
      progressive.workerRssRetainedBytes,
    ),
    jsHeapReductionPct: reductionPercent(full.browserJsHeapRetainedBytes, progressive.browserJsHeapRetainedBytes),
    processRssReductionPct: reductionPercent(full.browserRssRetainedBytes, progressive.browserRssRetainedBytes),
  };
}

/**
 * Partial-only reports compare prepared browser memory inside each already-running browser lane,
 * but service and worker RSS only across the fresh-service/fresh-cache cold lanes. Prepared
 * service processes are shared across alternating samples and therefore cannot support a causal
 * lane-reduction claim.
 */
export function comparisonFromPartialOnlyEvidence(full, progressive, coldFull, coldProgressive) {
  const comparison = comparisonFromSummaries(full, progressive);
  const fullCold = partialOnlyColdMemory(coldFull);
  const progressiveCold = partialOnlyColdMemory(coldProgressive);
  return {
    ...comparison,
    serviceRssPeakReductionPct: reductionPercent(
      fullCold.serviceRssPeakBytes,
      progressiveCold.serviceRssPeakBytes,
    ),
    serviceRssRetainedReductionPct: reductionPercent(
      fullCold.serviceRssRetainedBytes,
      progressiveCold.serviceRssRetainedBytes,
    ),
    workerRssPeakReductionPct: reductionPercent(
      fullCold.workerRssPeakBytes,
      progressiveCold.workerRssPeakBytes,
    ),
    workerRssRetainedReductionPct: reductionPercent(
      fullCold.workerRssRetainedBytes,
      progressiveCold.workerRssRetainedBytes,
    ),
    memoryScopes: {
      browser: "prepared-lane-local-browser-process",
      serviceAndWorker: "isolated-cold-fresh-service-and-cache-per-variant",
    },
  };
}

function partialOnlyColdMemory(value) {
  return {
    serviceRssPeakBytes: readMetric(value, ["serviceRssPeakBytes", "coldServiceMemory.peakRssBytes"]),
    serviceRssRetainedBytes: readMetric(value, [
      "serviceRssRetainedBytes",
      "coldServiceMemory.retainedRssBytes",
    ]),
    workerRssPeakBytes: readMetric(value, ["workerRssPeakBytes", "coldServiceMemory.workerPeakRssBytes"]),
    workerRssRetainedBytes: readMetric(value, [
      "workerRssRetainedBytes",
      "coldServiceMemory.workerRetainedRssBytes",
    ]),
  };
}

export function aggregatePrResults(prs) {
  const completed = prs.filter((entry) =>
    Array.isArray(entry.variants?.full?.samples)
    && entry.variants.full.samples.length > 0
    && Array.isArray(entry.variants?.progressive?.samples)
    && entry.variants.progressive.samples.length > 0,
  );
  if (completed.length === 0) return null;
  const aggregateVariant = (name) => {
    const aggregate = summarizeVariant(completed.flatMap((entry) => entry.variants[name].samples));
    const perPr = completed.map((entry) => summarizeVariant(entry.variants[name].samples));
    aggregate.firstActionableFirstMs = median(
      perPr.map((summary) => summary.firstActionableFirstMs).filter(finiteNumber),
    );
    aggregate.settledFirstMs = median(
      perPr.map((summary) => summary.settledFirstMs).filter(finiteNumber),
    );
    aggregate.firstActionableWarmMedianMs = median(
      perPr.map((summary) => summary.firstActionableWarmMedianMs).filter(finiteNumber),
    );
    aggregate.settledWarmMedianMs = median(
      perPr.map((summary) => summary.settledWarmMedianMs).filter(finiteNumber),
    );
    return aggregate;
  };
  const full = aggregateVariant("full");
  const progressive = aggregateVariant("progressive");
  return { prCount: completed.length, full, progressive, comparison: comparisonFromSummaries(full, progressive) };
}

/** Aggregate prepared action/loading/browser evidence while sourcing service/worker reductions
 * exclusively from the isolated cold aggregate. */
export function aggregatePartialOnlyResults(prs) {
  const aggregate = aggregatePrResults(prs);
  if (aggregate === null) return null;
  const cold = aggregateColdEndToEnd(prs);
  return {
    ...aggregate,
    comparison: comparisonFromPartialOnlyEvidence(
      aggregate.full,
      aggregate.progressive,
      cold?.full,
      cold?.progressive,
    ),
  };
}

/** Aggregate absolute prepared measurements for the production partial runtime. There is
 * intentionally no comparison member: this evidence mode never runs a full graph lane. */
export function aggregatePartialRuntimeOnlyResults(prs) {
  const completed = prs.filter((entry) =>
    Array.isArray(entry.variants?.progressive?.samples)
    && entry.variants.progressive.samples.length > 0,
  );
  if (completed.length === 0) return null;
  const progressive = summarizeVariant(
    completed.flatMap((entry) => entry.variants.progressive.samples),
  );
  const perPr = completed.map((entry) => summarizeVariant(entry.variants.progressive.samples));
  progressive.firstActionableFirstMs = median(
    perPr.map((summary) => summary.firstActionableFirstMs).filter(finiteNumber),
  );
  progressive.settledFirstMs = median(
    perPr.map((summary) => summary.settledFirstMs).filter(finiteNumber),
  );
  progressive.firstActionableWarmMedianMs = median(
    perPr.map((summary) => summary.firstActionableWarmMedianMs).filter(finiteNumber),
  );
  progressive.settledWarmMedianMs = median(
    perPr.map((summary) => summary.settledWarmMedianMs).filter(finiteNumber),
  );
  const repetitionCounts = new Set(
    completed.map((entry) => entry.variants.progressive.samples.length),
  );
  return {
    prCount: completed.length,
    repetitionsPerPr: repetitionCounts.size === 1 ? [...repetitionCounts][0] : null,
    progressive,
  };
}

export function parseFfprobeJson(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new TypeError("ffprobe returned invalid JSON");
  }
  const value = record(raw, "ffprobe result");
  const streams = Array.isArray(value.streams) ? value.streams : [];
  const stream = streams.find((candidate) => candidate && typeof candidate === "object" && candidate.codec_type === "video")
    ?? streams[0];
  const video = record(stream, "ffprobe video stream");
  const format = record(value.format, "ffprobe format");
  const durationSeconds = firstPositiveNumber([video.duration, format.duration], "video duration");
  const width = positiveInteger(video.width, "video width");
  const height = positiveInteger(video.height, "video height");
  const sizeBytes = positiveInteger(Number(format.size), "video size");
  const frameCount = firstOptionalPositiveNumber([video.nb_read_frames, video.nb_frames]);
  return {
    codec: nonEmptyString(video.codec_name, "video codec"),
    width,
    height,
    durationSeconds,
    sizeBytes,
    frameCount,
    averageFrameRate: typeof video.avg_frame_rate === "string" ? video.avg_frame_rate : null,
  };
}

export function validateVideoProbe(probe, expected = {}) {
  if (probe.durationSeconds < (expected.minimumDurationSeconds ?? 2.5)) {
    throw new Error(`recording is too short (${probe.durationSeconds.toFixed(2)}s)`);
  }
  if (probe.sizeBytes < (expected.minimumBytes ?? 50_000)) {
    throw new Error(`recording is too small (${probe.sizeBytes} bytes)`);
  }
  const width = expected.width ?? DEFAULT_VIEWPORT.width;
  const height = expected.height ?? DEFAULT_VIEWPORT.height;
  if (probe.width !== width || probe.height !== height) {
    throw new Error(`recording resolution is ${probe.width}x${probe.height}, expected ${width}x${height}`);
  }
  if (probe.frameCount !== null && probe.frameCount < 3) throw new Error("recording contains fewer than 3 decoded frames");
  return probe;
}

export function parseFrameMd5(text) {
  if (typeof text !== "string") throw new TypeError("framemd5 input must be text");
  return text.split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((line) => line.split(",").at(-1)?.trim() ?? "")
    .filter((hash) => /^[0-9a-f]{32,}$/i.test(hash));
}

export function parseSignalStats(text) {
  if (typeof text !== "string") throw new TypeError("signalstats input must be text");
  const values = [];
  for (const match of text.matchAll(/lavfi\.signalstats\.YAVG=([0-9.]+)/g)) {
    const value = Number(match[1]);
    if (Number.isFinite(value)) values.push(value);
  }
  return values;
}

export function validateNontrivialFrames(frameHashes, lumaValues) {
  if (!Array.isArray(frameHashes) || frameHashes.length < 2) throw new Error("recording yielded fewer than 2 sampled frames");
  if (new Set(frameHashes).size < 2) throw new Error("recording sampled frames are identical");
  if (!Array.isArray(lumaValues) || lumaValues.length < 2) throw new Error("recording yielded no luminance samples");
  if (Math.max(...lumaValues) < 5) throw new Error("recording appears black");
  return {
    sampledFrames: frameHashes.length,
    distinctFrames: new Set(frameHashes).size,
    minimumLuma: Math.min(...lumaValues),
    maximumLuma: Math.max(...lumaValues),
  };
}

export function safeRelativeMediaPath(reportPath, mediaPath) {
  const reportDir = dirname(resolve(reportPath));
  const absoluteMedia = resolve(mediaPath);
  const value = relative(reportDir, absoluteMedia);
  if (value === "" || value === ".." || value.startsWith(`..${sep}`) || isAbsolute(value)) {
    throw new TypeError("recording must live inside the report output directory");
  }
  return value.split(sep).join("/");
}

/**
 * Place browser-owned landing marks onto the Node cold-run timeline without treating independent
 * wall-clock origins as exact. Nine request-side and nine action-side exchanges each bracket a
 * browser performance.now() sample with Node performance.now(). The earliest minimum-RTT sample in
 * each phase supplies a measured offset interval. The returned point is the midpoint of the strict
 * intersection of those intervals, the real trigger bracket, and the browser-local TTA relation.
 */
export function alignLandingManifestClock(mark, protocol) {
  const diagnosticNumber = (value) => finiteNumber(value) ? value : null;
  const diagnosticSamples = (value) => Array.isArray(value)
    ? value.slice(0, LANDING_CLOCK_CALIBRATION_SAMPLE_COUNT).map((sample) => ({
      nodeBeforeMs: diagnosticNumber(sample?.nodeBeforeMs),
      nodeAfterMs: diagnosticNumber(sample?.nodeAfterMs),
      browserAtMs: diagnosticNumber(sample?.browserAtMs),
    }))
    : [];
  const fail = (code) => {
    const error = new TypeError(`landing manifest cross-process clock proof failed (${code})`);
    error.clockAlignmentDiagnostic = {
      version: 2,
      invariant: code,
      providedBeforeSampleCount: Array.isArray(protocol?.beforeSamples)
        ? protocol.beforeSamples.length
        : null,
      providedAfterSampleCount: Array.isArray(protocol?.afterSamples)
        ? protocol.afterSamples.length
        : null,
      beforeSamples: diagnosticSamples(protocol?.beforeSamples),
      afterSamples: diagnosticSamples(protocol?.afterSamples),
      nodeColdStartedMs: diagnosticNumber(protocol?.nodeColdStartedMs),
      requestBracket: {
        nodeBeforeMs: diagnosticNumber(protocol?.requestBracket?.nodeBeforeMs),
        nodeAfterMs: diagnosticNumber(protocol?.requestBracket?.nodeAfterMs),
        browserRequestStartedAtMs: diagnosticNumber(
          protocol?.requestBracket?.browserRequestStartedAtMs,
        ),
        browserSampleAtMs: diagnosticNumber(protocol?.requestBracket?.browserSampleAtMs),
      },
      browserMark: {
        requestStartedAtMs: diagnosticNumber(mark?.requestStartedAtMs),
        atMs: diagnosticNumber(mark?.atMs),
        ttaMs: diagnosticNumber(mark?.ttaMs),
      },
    };
    throw error;
  };
  const normalizePhase = (rawSamples, phase) => {
    if (!Array.isArray(rawSamples)
      || rawSamples.length !== LANDING_CLOCK_CALIBRATION_SAMPLE_COUNT) {
      fail(`${phase}-sample-count-invalid`);
    }
    const samples = rawSamples.map((sample) => {
      if (!finiteNumber(sample?.nodeBeforeMs)
        || !finiteNumber(sample?.nodeAfterMs)
        || !finiteNumber(sample?.browserAtMs)
        || sample.nodeBeforeMs < 0
        || sample.nodeAfterMs < sample.nodeBeforeMs
        || sample.browserAtMs < 0) {
        fail(`${phase}-sample-invalid`);
      }
      const roundTripMs = sample.nodeAfterMs - sample.nodeBeforeMs;
      return {
        nodeBeforeMs: sample.nodeBeforeMs,
        nodeAfterMs: sample.nodeAfterMs,
        browserAtMs: sample.browserAtMs,
        roundTripMs,
        offsetLowerBoundMs: sample.nodeBeforeMs - sample.browserAtMs,
        offsetUpperBoundMs: sample.nodeAfterMs - sample.browserAtMs,
        offsetEstimateMs: ((sample.nodeBeforeMs + sample.nodeAfterMs) / 2) - sample.browserAtMs,
      };
    });
    for (let index = 1; index < samples.length; index += 1) {
      if (samples[index].nodeBeforeMs < samples[index - 1].nodeAfterMs
        || samples[index].browserAtMs < samples[index - 1].browserAtMs) {
        fail(`${phase}-sample-order-invalid`);
      }
    }
    let selectedSampleIndex = 0;
    for (let index = 1; index < samples.length; index += 1) {
      if (samples[index].roundTripMs < samples[selectedSampleIndex].roundTripMs) {
        selectedSampleIndex = index;
      }
    }
    const selected = samples[selectedSampleIndex];
    if (selected.roundTripMs > LANDING_CLOCK_MAX_SELECTED_RTT_MS) {
      fail(`${phase}-selected-rtt-exceeds-budget`);
    }
    return { samples, selectedSampleIndex, selected };
  };

  const before = normalizePhase(protocol?.beforeSamples, "before");
  const after = normalizePhase(protocol?.afterSamples, "after");
  const nodeColdStartedMs = protocol?.nodeColdStartedMs;
  const requestBracket = protocol?.requestBracket;
  if (!finiteNumber(nodeColdStartedMs) || nodeColdStartedMs < 0) fail("cold-start-invalid");
  if (before.samples.some((sample) => sample.nodeAfterMs > nodeColdStartedMs)) {
    fail("before-calibration-not-before-cold-start");
  }
  if (!finiteNumber(requestBracket?.nodeBeforeMs)
    || !finiteNumber(requestBracket?.nodeAfterMs)
    || !finiteNumber(requestBracket?.browserRequestStartedAtMs)
    || !finiteNumber(requestBracket?.browserSampleAtMs)
    || requestBracket.nodeBeforeMs < nodeColdStartedMs
    || requestBracket.nodeAfterMs < requestBracket.nodeBeforeMs
    || requestBracket.browserRequestStartedAtMs < 0
    || requestBracket.browserSampleAtMs < requestBracket.browserRequestStartedAtMs) {
    fail("request-start-bracket-invalid");
  }
  if (!finiteNumber(mark?.requestStartedAtMs)
    || !finiteNumber(mark?.atMs)
    || !finiteNumber(mark?.ttaMs)
    || mark.requestStartedAtMs < 0
    || mark.atMs < mark.requestStartedAtMs
    || mark.ttaMs < 0
    || mark.requestStartedAtMs !== requestBracket.browserRequestStartedAtMs
    || mark.atMs - mark.requestStartedAtMs !== mark.ttaMs) {
    fail("browser-mark-causality-invalid");
  }
  if (after.samples[0].nodeBeforeMs < requestBracket.nodeAfterMs
    || after.samples.some((sample) => sample.browserAtMs < mark.atMs)) {
    fail("after-calibration-not-after-mark");
  }

  const mapBrowserMark = (browserAtMs, selected) => ({
    lowerBoundMs: browserAtMs + selected.offsetLowerBoundMs - nodeColdStartedMs,
    upperBoundMs: browserAtMs + selected.offsetUpperBoundMs - nodeColdStartedMs,
    estimateMs: browserAtMs + selected.offsetEstimateMs - nodeColdStartedMs,
    uncertaintyMs: selected.roundTripMs / 2,
  });
  const rawRequest = mapBrowserMark(mark.requestStartedAtMs, before.selected);
  const rawAction = mapBrowserMark(mark.atMs, after.selected);
  const triggerBounds = {
    lowerBoundMs: requestBracket.nodeBeforeMs - nodeColdStartedMs,
    upperBoundMs: requestBracket.nodeAfterMs - nodeColdStartedMs,
  };
  const causalRequest = {
    lowerBoundMs: Math.max(
      rawRequest.lowerBoundMs,
      triggerBounds.lowerBoundMs,
      rawAction.lowerBoundMs - mark.ttaMs,
    ),
    upperBoundMs: Math.min(
      rawRequest.upperBoundMs,
      triggerBounds.upperBoundMs,
      rawAction.upperBoundMs - mark.ttaMs,
    ),
  };
  if (causalRequest.lowerBoundMs > causalRequest.upperBoundMs) {
    fail("causal-clock-interval-empty");
  }
  const requestStartedMs = (causalRequest.lowerBoundMs + causalRequest.upperBoundMs) / 2;
  const actionableMs = requestStartedMs + mark.ttaMs;
  const resolvedUncertaintyMs = (causalRequest.upperBoundMs - causalRequest.lowerBoundMs) / 2;
  const causalResolutionShiftMs = requestStartedMs - rawRequest.estimateMs;
  if (requestStartedMs < 0
    || actionableMs < requestStartedMs
    || actionableMs < rawAction.lowerBoundMs
    || actionableMs > rawAction.upperBoundMs
    || Math.abs(causalResolutionShiftMs) > rawRequest.uncertaintyMs) {
    fail("causal-clock-resolution-invalid");
  }

  const phaseEvidence = (phase) => ({
    sampleCount: phase.samples.length,
    samples: phase.samples,
    selectedSampleIndex: phase.selectedSampleIndex,
    selectedRoundTripMs: phase.selected.roundTripMs,
    selectedOffsetLowerBoundMs: phase.selected.offsetLowerBoundMs,
    selectedOffsetUpperBoundMs: phase.selected.offsetUpperBoundMs,
    selectedOffsetEstimateMs: phase.selected.offsetEstimateMs,
    uncertaintyMs: phase.selected.roundTripMs / 2,
  });
  return {
    requestStartedMs,
    actionableMs,
    ttaMs: mark.ttaMs,
    clockAlignment: {
      version: 2,
      method: "two-phase-minimum-rtt-monotonic-interval-intersection",
      sampleCountPerPhase: LANDING_CLOCK_CALIBRATION_SAMPLE_COUNT,
      maximumSelectedRoundTripMs: LANDING_CLOCK_MAX_SELECTED_RTT_MS,
      nodeColdStartedMs,
      before: phaseEvidence(before),
      after: phaseEvidence(after),
      requestBracket: {
        nodeBeforeMs: requestBracket.nodeBeforeMs,
        nodeAfterMs: requestBracket.nodeAfterMs,
        browserRequestStartedAtMs: requestBracket.browserRequestStartedAtMs,
        browserSampleAtMs: requestBracket.browserSampleAtMs,
      },
      browserMark: {
        requestStartedAtMs: mark.requestStartedAtMs,
        atMs: mark.atMs,
        ttaMs: mark.ttaMs,
      },
      rawRequest,
      rawAction,
      triggerBounds,
      causalRequest,
      causalAction: {
        lowerBoundMs: causalRequest.lowerBoundMs + mark.ttaMs,
        upperBoundMs: causalRequest.upperBoundMs + mark.ttaMs,
      },
      resolvedUncertaintyMs,
      causalResolutionShiftMs,
      normalizedWithinMeasuredUncertainty: causalResolutionShiftMs !== 0,
      resolvedRequestStartedMs: requestStartedMs,
      resolvedActionableMs: actionableMs,
    },
  };
}

/** Recompute the publishable next-depth warm chain without trusting stored summary booleans. The
 * renderer-owned 202 response is transport-only: Playwright must not consume its body. A tagged
 * harness replay of the identical bounded request may only observe the existing work as coalesced
 * or already complete, then an explicit status read and critical projection must prove readiness
 * and consumption of the same opaque key. */
export function deriveCausalWarmReadinessEvidence(value, prepared) {
  const fail = (reason) => {
    throw new TypeError(`causal warm evidence is invalid (${reason})`);
  };
  const evidence = value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
  const headGraphId = prepared?.graphId;
  const comparisonGraphId = prepared?.comparisonGraphId;
  if (evidence === null
    || typeof headGraphId !== "string"
    || headGraphId === ""
    || typeof comparisonGraphId !== "string"
    || comparisonGraphId === ""
    || comparisonGraphId === headGraphId) {
    fail("coordinates");
  }
  const expectedGraphIds = new Set([headGraphId, comparisonGraphId]);
  const capture = evidence.rendererCapture;
  if (!finiteNumber(capture?.firstActionableEpochMs)
    || capture.firstActionableEpochMs < 0
    || capture.rendererResponseBodiesRead !== false) {
    fail("renderer-capture-boundary");
  }
  if (!Array.isArray(evidence.initialRequests)
    || !Array.isArray(evidence.warmRequests)
    || !Array.isArray(evidence.probes)
    || evidence.warmRequests.length !== expectedGraphIds.size
    || evidence.probes.length !== expectedGraphIds.size) {
    fail("evidence-cardinality");
  }
  const initialDepths = new Map();
  for (const entry of evidence.initialRequests) {
    if (!expectedGraphIds.has(entry?.graphId)
      || entry.seedGraphId !== headGraphId
      || !Number.isSafeInteger(entry.requestedDepth)
      || entry.requestedDepth < 0
      || entry.status !== 200
      || entry.ready !== true
      || typeof entry.key !== "string"
      || !/^[a-f0-9]{64}$/.test(entry.key)) {
      fail("initial-projection");
    }
    const prior = initialDepths.get(entry.graphId);
    if (prior === undefined || entry.requestedDepth > prior) {
      initialDepths.set(entry.graphId, entry.requestedDepth);
    }
  }
  if (initialDepths.size !== expectedGraphIds.size) fail("initial-projection-coverage");

  const warmByGraph = new Map();
  for (const entry of evidence.warmRequests) {
    if (!expectedGraphIds.has(entry?.graphId)
      || warmByGraph.has(entry.graphId)
      || entry.version !== 1
      || entry.rootsKind !== "changed-files"
      || entry.seedGraphId !== headGraphId
      || entry.method !== "POST"
      || entry.path !== "/api/graph/project/warm"
      || entry.initiatedBy !== "renderer-background"
      || entry.responseBodyRead !== false
      || entry.status !== 202
      || entry.requestedDepth !== 2
      || entry.requestedDepth <= initialDepths.get(entry.graphId)
      || entry.prefetchDepth !== entry.requestedDepth
      || !finiteNumber(entry.requestStartedEpochMs)
      || entry.requestStartedEpochMs < capture.firstActionableEpochMs
      || typeof entry.contentType !== "string"
      || !entry.contentType.toLowerCase().startsWith("application/json")
      || entry.cacheControl !== "no-store") {
      fail("renderer-warm-transport");
    }
    warmByGraph.set(entry.graphId, entry);
  }

  const seenProbes = new Set();
  for (const probe of evidence.probes) {
    const warmRequest = warmByGraph.get(probe?.graphId);
    const warm = probe?.warm;
    const readiness = probe?.readiness;
    const request = probe?.request;
    if (warmRequest === undefined
      || seenProbes.has(probe.graphId)
      || probe.requestedDepth !== warmRequest.requestedDepth
      || probe.prefetchDepth !== warmRequest.prefetchDepth
      || warm?.rendererStatus !== warmRequest.status
      || warm?.rendererResponseBodyRead !== false
      || warm?.confirmationBodyOwner !== "harness-proof-page-fetch"
      || warm?.version !== 1
      || typeof warm?.key !== "string"
      || !/^[a-f0-9]{64}$/.test(warm.key)) {
      fail("warm-replay-provenance");
    }
    const replayCoalesced = warm.confirmationStatus === 202
      && warm.accepted === false
      && warm.completed === false
      && warm.cache === "coalesced";
    const replayHit = warm.confirmationStatus === 200
      && warm.accepted === false
      && warm.completed === true
      && warm.cache === "hit";
    if (!replayCoalesced && !replayHit) fail("warm-replay-started-or-malformed");
    if (readiness?.status !== 200
      || readiness.completed !== true
      || readiness.key !== warm.key
      || request?.status !== 200
      || request.cache !== "hit"
      || request.ready !== true
      || request.key !== warm.key
      || request.graphId !== probe.graphId
      || request.seedGraphId !== headGraphId
      || !Number.isSafeInteger(request.loadedDepth)
      || request.loadedDepth < probe.requestedDepth) {
      fail("same-key-ready-hit");
    }
    seenProbes.add(probe.graphId);
  }
  if (seenProbes.size !== expectedGraphIds.size) fail("probe-coverage");
  return {
    warmObserved: true,
    cacheReady: true,
    speculativeWorkAcceptedOrCoalesced: true,
    nextDepthCacheHit: true,
    causalWarmReadyHit: true,
    authoritative: true,
    rendererTransportBodyless: true,
    keyAcquiredByHarnessReplay: true,
    diagnostic: null,
  };
}

/**
 * Turn the server's streamed, caller-observed cold preparation events into a strict monotonic
 * timeline. The event arrival timestamps are authoritative: server clocks are deliberately not
 * trusted. A publishable cold run must be a real miss and must expose the exact verified manifest
 * before the manifest-owning HEAD extraction lane completes.
 */
export function deriveColdPreparationMilestones(events, prepared) {
  if (!Array.isArray(events) || events.length === 0) {
    throw new TypeError("cold preparation has no streamed events");
  }
  let previousAtMs = -Infinity;
  for (const [index, event] of events.entries()) {
    const atMs = event?.atMs;
    if (!finiteNumber(atMs) || atMs < 0 || atMs < previousAtMs) {
      throw new TypeError(`cold preparation event ${index + 1} has no monotonic arrival timestamp`);
    }
    previousAtMs = atMs;
  }
  const find = (name, predicate) => {
    const event = events.find((candidate) => predicate(candidate?.payload));
    if (event === undefined) throw new TypeError(`cold preparation has no ${name} milestone`);
    return event;
  };
  const clone = find("clone", (payload) => payload?.stage === "clone");
  const checkout = find("checkout", (payload) => payload?.stage === "checkout");
  const analysis = find("analysis start", (payload) => payload?.stage === "extract");
  const manifest = find("manifest-ready", (payload) => payload?.stage === "manifest-ready");
  const ready = find("provisional ready", (payload) => payload?.stage === "ready");
  const headStart = find("HEAD extraction start", (payload) => payload?.stage === "extract-head");
  const headComplete = find(
    "HEAD extraction complete",
    (payload) => payload?.stage === "lane-complete" && payload?.lane === "head",
  );
  const comparisonStart = find(
    "merge-base extraction start",
    (payload) => payload?.stage === "extract-merge-base",
  );
  const comparisonComplete = find(
    "merge-base extraction complete",
    (payload) => payload?.stage === "lane-complete" && payload?.lane === "mergeBase",
  );
  const finalPair = events.at(-1);
  if (finalPair?.payload?.stage !== "done") {
    throw new TypeError("cold preparation did not finish with a final pair");
  }
  if (finalPair.payload.cache !== "miss" || prepared?.cache !== "miss") {
    throw new TypeError("cold preparation was not an isolated cache miss");
  }
  const prNumber = positiveInteger(finalPair.payload?.preparedPair?.prNumber, "cold final pair PR number");
  const handoff = validatePreparationHandoff(
    { number: prNumber, headOid: prepared.headSha },
    ready.payload,
    finalPair.payload,
  );
  for (const field of ["graphId", "comparisonGraphId", "headSha", "baseSha", "mergeBaseSha"]) {
    if (finalPair.payload?.[field] !== prepared?.[field]) {
      throw new TypeError(`cold final pair does not prove exact ${field}`);
    }
  }
  const preparedPair = record(finalPair.payload?.preparedPair, "cold final preparedPair");
  if (preparedPair.version !== 1
    || preparedPair.headGraphId !== prepared.graphId
    || preparedPair.mergeBaseGraphId !== prepared.comparisonGraphId
    || preparedPair.headSha !== prepared.headSha
    || preparedPair.baseSha !== prepared.baseSha
    || preparedPair.mergeBaseSha !== prepared.mergeBaseSha
    || (finalPair.payload.completeness === "provisional" && (
      preparedPair.completeness !== "provisional"
      || preparedPair.pairId !== finalPair.payload.pairId
    ))) {
    throw new TypeError("cold final preparedPair does not correlate with the final pair");
  }
  for (const field of ["headSha", "baseSha", "mergeBaseSha"]) {
    if (manifest.payload?.[field] !== prepared?.[field]) {
      throw new TypeError(`manifest-ready does not prove exact ${field}`);
    }
  }
  const manifestFiles = canonicalChangedManifest(manifest.payload?.changedFiles, "manifest-ready changedFiles");
  const terminalFiles = canonicalChangedManifest(finalPair.payload?.changedFiles, "final-pair changedFiles");
  if (JSON.stringify(manifestFiles) !== JSON.stringify(terminalFiles)) {
    throw new TypeError("manifest-ready changedFiles contradict the final pair");
  }
  const orderedChains = [
    [clone, checkout, analysis, finalPair],
    [analysis, headStart, headComplete, finalPair],
    [analysis, comparisonStart, comparisonComplete, finalPair],
    [analysis, manifest, headComplete, finalPair],
    [analysis, manifest, ready, finalPair],
  ];
  for (const chain of orderedChains) {
    for (let index = 1; index < chain.length; index += 1) {
      if (chain[index].atMs < chain[index - 1].atMs) {
        throw new TypeError("cold preparation milestones are out of order");
      }
    }
  }
  const partialOnly = finalPair.payload.completeness === "provisional";
  const provisionalPair = partialOnly ? handoff.partial : handoff.provisional;
  const canonicalPair = partialOnly ? null : handoff.canonical;
  return {
    cloneStartedMs: clone.atMs,
    checkoutStartedMs: checkout.atMs,
    analysisStartedMs: analysis.atMs,
    manifestReadyMs: manifest.atMs,
    headExtractionStartedMs: headStart.atMs,
    headExtractionCompletedMs: headComplete.atMs,
    comparisonExtractionStartedMs: comparisonStart.atMs,
    comparisonExtractionCompletedMs: comparisonComplete.atMs,
    provisionalReadyMs: ready.atMs,
    finalPairReadyMs: finalPair.atMs,
    initialProjectionPairReadyMs: ready.atMs,
    // Retain the old key for schema-v3 report compatibility. Under the partial-only contract it is
    // merely the adjacent ready-to-EOF acknowledgement, never canonical work.
    canonicalCompletionLagMs: partialOnly ? null : roundEvidenceMs(finalPair.atMs - ready.atMs),
    partialTerminalLagMs: partialOnly ? roundEvidenceMs(finalPair.atMs - ready.atMs) : null,
    provisionalPairId: handoff.pairId,
    provisionalGraphId: provisionalPair.graphId,
    provisionalComparisonGraphId: provisionalPair.comparisonGraphId,
    canonicalGraphId: canonicalPair?.graphId ?? null,
    canonicalComparisonGraphId: canonicalPair?.comparisonGraphId ?? null,
    delivery: partialOnly ? PARTIAL_ONLY_DELIVERY_CONTRACT : "provisional-to-canonical-v1",
    streamEnded: partialOnly,
    canonicalContinuationObserved: !partialOnly,
    exactRevisionBound: handoff.exactRevisionBound,
    manifestFileCount: manifestFiles.length,
    manifestSha256: createHash("sha256").update(JSON.stringify(manifestFiles)).digest("hex"),
    source: "client-observed-ndjson-arrival",
  };
}

export function aggregateColdEndToEnd(prs) {
  const completed = prs.filter((entry) => entry.coldEndToEnd?.variants?.full && entry.coldEndToEnd?.variants?.progressive);
  if (completed.length === 0) return null;
  const summarize = (variant) => {
    const samples = completed.map((entry) => entry.coldEndToEnd.variants[variant]);
    const fields = {
      landingShellActionableMs: (sample) => sample.timings?.landingShellActionableMs,
      landingShellTtaMs: (sample) => sample.timings?.landingShellTtaMs,
      provisionalReadyMs: (sample) => sample.timings?.provisionalReadyMs,
      provisionalReadyTtaMs: (sample) => sample.timings?.provisionalReadyTtaMs,
      finalPairReadyMs: (sample) => sample.preparation?.milestones?.finalPairReadyMs,
      initialProjectionPairReadyMs: (sample) => sample.preparation?.milestones?.initialProjectionPairReadyMs,
      canonicalCompletionLagMs: (sample) => sample.preparation?.milestones?.canonicalCompletionLagMs,
      canonicalReconciledMs: (sample) => sample.timings?.canonicalReconciledMs,
      manifestReadyMs: (sample) => sample.preparation?.milestones?.manifestReadyMs,
      browserFirstActionableMs: (sample) => sample.timings?.browserFirstActionableMs,
      browserSettledMs: (sample) => sample.timings?.browserSettledMs,
      prepareToFirstActionableMs: (sample) => sample.timings?.prepareToFirstActionableMs,
      prepareToSettledMs: (sample) => sample.timings?.prepareToSettledMs,
      endToEndFirstActionableMs: (sample) => sample.timings?.endToEndFirstActionableMs,
      endToEndSettledMs: (sample) => sample.timings?.endToEndSettledMs,
      browserHeapPeakBytes: (sample) => sample.memoryPeak?.browserJsHeapUsedBytes,
      browserHeapRetainedBytes: (sample) => sample.memorySettled?.browserJsHeapUsedBytes,
      browserRssPeakBytes: (sample) => sample.memoryPeak?.browserProcessRssBytes,
      browserRssRetainedBytes: (sample) => sample.memorySettled?.browserProcessRssBytes,
      serviceRssPeakBytes: (sample) => sample.coldServiceMemory?.peakRssBytes,
      serviceRssRetainedBytes: (sample) => sample.coldServiceMemory?.retainedRssBytes,
      workerRssPeakBytes: (sample) => sample.coldServiceMemory?.workerPeakRssBytes,
      workerRssRetainedBytes: (sample) => sample.coldServiceMemory?.workerRetainedRssBytes,
    };
    const summary = { sampleCount: samples.length };
    for (const [name, read] of Object.entries(fields)) {
      summary[name] = median(samples.map(read).filter(finiteNumber));
    }
    return summary;
  };
  const full = summarize("full");
  const progressive = summarize("progressive");
  return {
    prCount: completed.length,
    repetitionsPerVariantAndPr: 1,
    isolation: "fresh-meridian-service-and-cache-per-variant",
    full,
    progressive,
    comparison: {
      endToEndFirstActionableImprovementPct: reductionPercent(
        full.endToEndFirstActionableMs,
        progressive.endToEndFirstActionableMs,
      ),
      prepareToFirstActionableImprovementPct: reductionPercent(
        full.prepareToFirstActionableMs,
        progressive.prepareToFirstActionableMs,
      ),
      prepareToSettledImprovementPct: reductionPercent(full.prepareToSettledMs, progressive.prepareToSettledMs),
      endToEndSettledImprovementPct: reductionPercent(full.endToEndSettledMs, progressive.endToEndSettledMs),
      browserFirstActionableImprovementPct: reductionPercent(
        full.browserFirstActionableMs,
        progressive.browserFirstActionableMs,
      ),
      browserSettledImprovementPct: reductionPercent(full.browserSettledMs, progressive.browserSettledMs),
      serviceRssPeakReductionPct: reductionPercent(full.serviceRssPeakBytes, progressive.serviceRssPeakBytes),
      workerRssPeakReductionPct: reductionPercent(full.workerRssPeakBytes, progressive.workerRssPeakBytes),
    },
  };
}

/** Aggregate absolute cold-start measurements from fresh progressive-only services. */
export function aggregatePartialRuntimeOnlyColdResults(prs) {
  const completed = prs.filter((entry) => entry.coldEndToEnd?.variants?.progressive);
  if (completed.length === 0) return null;
  const samples = completed.map((entry) => entry.coldEndToEnd.variants.progressive);
  const fields = {
    landingShellActionableMs: (sample) => sample.timings?.landingShellActionableMs,
    landingShellTtaMs: (sample) => sample.timings?.landingShellTtaMs,
    provisionalReadyMs: (sample) => sample.timings?.provisionalReadyMs,
    provisionalReadyTtaMs: (sample) => sample.timings?.provisionalReadyTtaMs,
    finalPairReadyMs: (sample) => sample.preparation?.milestones?.finalPairReadyMs,
    initialProjectionPairReadyMs: (sample) => sample.preparation?.milestones?.initialProjectionPairReadyMs,
    partialTerminalLagMs: (sample) => sample.preparation?.milestones?.partialTerminalLagMs,
    manifestReadyMs: (sample) => sample.preparation?.milestones?.manifestReadyMs,
    browserFirstActionableMs: (sample) => sample.timings?.browserFirstActionableMs,
    browserSettledMs: (sample) => sample.timings?.browserSettledMs,
    prepareToFirstActionableMs: (sample) => sample.timings?.prepareToFirstActionableMs,
    prepareToSettledMs: (sample) => sample.timings?.prepareToSettledMs,
    endToEndFirstActionableMs: (sample) => sample.timings?.endToEndFirstActionableMs,
    endToEndSettledMs: (sample) => sample.timings?.endToEndSettledMs,
    browserHeapPeakBytes: (sample) => sample.memoryPeak?.browserJsHeapUsedBytes,
    browserHeapRetainedBytes: (sample) => sample.memorySettled?.browserJsHeapUsedBytes,
    browserRssPeakBytes: (sample) => sample.memoryPeak?.browserProcessRssBytes,
    browserRssRetainedBytes: (sample) => sample.memorySettled?.browserProcessRssBytes,
    serviceRssPeakBytes: (sample) => sample.coldServiceMemory?.peakRssBytes,
    serviceRssRetainedBytes: (sample) => sample.coldServiceMemory?.retainedRssBytes,
    workerRssPeakBytes: (sample) => sample.coldServiceMemory?.workerPeakRssBytes,
    workerRssRetainedBytes: (sample) => sample.coldServiceMemory?.workerRetainedRssBytes,
  };
  const progressive = { sampleCount: samples.length };
  for (const [name, read] of Object.entries(fields)) {
    progressive[name] = median(samples.map(read).filter(finiteNumber));
  }
  return {
    prCount: completed.length,
    repetitionsPerPr: 1,
    isolation: "fresh-production-service-and-cache-per-progressive-lane",
    progressive,
  };
}

function canonicalChangedManifest(value, name) {
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`);
  const statuses = new Set(["added", "modified", "deleted", "renamed"]);
  const rows = value.map((raw, index) => {
    const entry = record(raw, `${name}[${index}]`);
    const path = changedManifestPath(entry.path, `${name}[${index}].path`);
    const status = nonEmptyString(entry.status, `${name}[${index}].status`);
    if (!statuses.has(status)) throw new TypeError(`${name}[${index}].status is invalid`);
    if (entry.nonTextualChanges !== undefined && entry.nonTextualChanges !== true) {
      throw new TypeError(`${name}[${index}].nonTextualChanges is invalid`);
    }
    if (status === "renamed") {
      const previousPath = changedManifestPath(entry.previousPath, `${name}[${index}].previousPath`);
      if (previousPath === path) throw new TypeError(`${name}[${index}] rename paths are identical`);
      return { path, status, previousPath, ...(entry.nonTextualChanges === true ? { nonTextualChanges: true } : {}) };
    }
    if (entry.previousPath !== undefined) throw new TypeError(`${name}[${index}] has an unexpected previousPath`);
    return { path, status, ...(entry.nonTextualChanges === true ? { nonTextualChanges: true } : {}) };
  });
  rows.sort((left, right) => left.path.localeCompare(right.path) || left.status.localeCompare(right.status));
  if (new Set(rows.map((entry) => entry.path)).size !== rows.length) throw new TypeError(`${name} contains duplicate paths`);
  return rows;
}

function changedManifestPath(value, name) {
  const path = nonEmptyString(value, name);
  if (path.startsWith("/") || path.includes("\\") || path.includes("\0")
    || path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new TypeError(`${name} is not a safe root-relative POSIX path`);
  }
  return path;
}

export function validateResultsDocument(value) {
  const document = record(value, "POC results");
  if (document.schemaVersion !== PR_REVIEW_POC_SCHEMA_VERSION) {
    throw new TypeError(`unsupported POC results schema: ${String(document.schemaVersion)}`);
  }
  if (!Array.isArray(document.prs)) throw new TypeError("POC results prs must be an array");
  if (document.config?.deliveryContract === PARTIAL_RUNTIME_ONLY_DELIVERY_CONTRACT) {
    return validatePartialRuntimeOnlyResultsDocument(document);
  }
  if (document.config?.deliveryContract === PARTIAL_ONLY_DELIVERY_CONTRACT) {
    return validatePartialOnlyResultsDocument(document);
  }
  const complete = document.status === "complete";
  const config = document.config === undefined ? null : record(document.config, "POC config");
  if (complete && (config?.mode !== "publishable"
    || !Array.isArray(config?.diagnosticReasons)
    || config.diagnosticReasons.length !== 0
    || document.diagnostic !== null
    || (Object.hasOwn(document, "failure") && document.failure !== null))) {
    throw new TypeError("complete POC results contradict publishable/diagnostic status evidence");
  }
  if (complete && (!Number.isSafeInteger(config?.repetitions) || config.repetitions < 2)) {
    throw new TypeError("publishable POC results require at least 2 repetitions for first/warm measurements");
  }
  if (complete && config?.coldEndToEnd?.enabled !== true) {
    throw new TypeError("publishable POC results require isolated cold end-to-end evidence");
  }
  if (complete && (config.coldEndToEnd.repetitions !== 1
    || config.coldEndToEnd.isolation !== "fresh-meridian-service-and-cache-per-variant")) {
    throw new TypeError("publishable cold evidence requires one fresh service/cache sample per variant and PR");
  }
  const seen = new Set();
  const normalizedPrs = document.prs.map((entry, prIndex) => {
    const pr = record(entry, "POC PR result");
    const number = positiveInteger(pr.number, "POC PR number");
    if (seen.has(number)) throw new TypeError(`POC results contain duplicate PR #${number}`);
    seen.add(number);

    const variants = {};
    for (const variant of ["full", "progressive"]) {
      const rawVariant = pr.variants?.[variant];
      if (rawVariant === undefined || rawVariant === null) {
        if (complete) throw new TypeError(`complete POC result for PR #${number} has no ${variant} variant`);
        continue;
      }
      const variantResult = record(rawVariant, `POC PR #${number} ${variant} variant`);
      if (!Array.isArray(variantResult.samples) || variantResult.samples.length === 0) {
        if (complete) throw new TypeError(`complete POC result for PR #${number} has no ${variant} samples`);
        continue;
      }
      const summary = summarizeVariant(variantResult.samples);
      if (complete) {
        if (variantResult.summary === undefined || variantResult.summary === null) {
          throw new TypeError(`complete POC result for PR #${number} has no ${variant} summary`);
        }
        assertDerivedEvidence(
          summary,
          record(variantResult.summary, `POC PR #${number} ${variant} summary`),
          `POC PR #${number} ${variant} summary`,
        );
      }
      variants[variant] = { ...variantResult, summary };
    }

    const recordings = normalizeRecordings(pr, complete, config);
    const handoffRecordings = normalizeHandoffRecordings(pr, complete, config);
    const coldEndToEnd = normalizeColdEndToEnd(pr, complete, config, prIndex);
    validateOptionalEvidencePaths(pr.evidence, `POC PR #${number} evidence`);
    validateOptionalEvidencePaths(pr.screenshots, `POC PR #${number} screenshots`);
    if (complete) {
      if (pr.status !== "complete") throw new TypeError(`configured PR #${number} is not complete`);
      const repetitions = config?.repetitions;
      if (Number.isSafeInteger(repetitions) && repetitions > 0) {
        for (const variant of ["full", "progressive"]) {
          if (variants[variant].samples.length !== repetitions) {
            throw new TypeError(
              `complete POC result for PR #${number} has ${variants[variant].samples.length} ${variant} samples; expected ${repetitions}`,
            );
          }
        }
      }
      assertPublishableMeasurements(number, variants);
      assertPreparedMeasurementSchedule(number, variants, repetitions, prIndex);
      assertExactSceneParity(number, variants.full.samples, variants.progressive.samples);
      assertStoredSceneParity(number, pr.parity);
      assertPreparedInitialProjectionEvidence(number, pr);
      assertExactProjectionIdentity(
        number,
        pr.revisions?.prepared,
        variants.full.samples,
        variants.progressive.samples,
      );
      assertStoredRevisionProvenance(number, pr.revisions, config?.repository);
      assertCacheReadiness(number, variants.progressive.samples, pr.revisions?.prepared);
    }

    const comparison = variants.full && variants.progressive
      ? comparisonFromSummaries(variants.full.summary, variants.progressive.summary)
      : null;
    if (complete && pr.comparison !== undefined && pr.comparison !== null) {
      assertDerivedEvidence(
        comparison,
        record(pr.comparison, `POC PR #${number} comparison`),
        `POC PR #${number} comparison`,
      );
    }
    return {
      ...pr,
      variants: Object.keys(variants).length === 0 ? pr.variants : { ...pr.variants, ...variants },
      recordings,
      handoffRecordings,
      coldEndToEnd,
      comparison,
    };
  });

  if (complete) {
    const serviceIds = new Set();
    const cacheIds = new Set();
    const firstVariants = new Set();
    for (const pr of normalizedPrs) {
      firstVariants.add(pr.coldEndToEnd.order[0]);
      for (const variant of ["full", "progressive"]) {
        const isolation = pr.coldEndToEnd?.variants?.[variant]?.isolation;
        if (serviceIds.has(isolation?.serviceInstanceId) || cacheIds.has(isolation?.cacheInstanceId)) {
          throw new TypeError("publishable cold evidence reused a service or cache across PR variants");
        }
        serviceIds.add(isolation.serviceInstanceId);
        cacheIds.add(isolation.cacheInstanceId);
      }
    }
    if (normalizedPrs.length >= 2 && firstVariants.size !== 2) {
      throw new TypeError("publishable cold evidence did not counterbalance variant order across PRs");
    }
  }

  if (complete) {
    if (config === null || !Array.isArray(config.prs)) {
      throw new TypeError("complete POC results must declare config.prs");
    }
    if (typeof config.repository !== "string" || config.repository.toLowerCase() !== "uipath/autopilot") {
      throw new TypeError("publishable POC results must use the UiPath/Autopilot PR corpus");
    }
    const configuredPrs = config.prs.map((number) => positiveInteger(number, "configured PR number"));
    if (new Set(configuredPrs).size !== configuredPrs.length) {
      throw new TypeError("complete POC config.prs contains duplicates");
    }
    if (configuredPrs.length < 2) {
      throw new TypeError("publishable POC results require at least 2 configured Autopilot PRs");
    }
    const actualPrs = normalizedPrs.map((entry) => entry.number);
    const missing = configuredPrs.filter((number) => !actualPrs.includes(number));
    const unexpected = actualPrs.filter((number) => !configuredPrs.includes(number));
    if (missing.length > 0 || unexpected.length > 0
      || JSON.stringify(actualPrs) !== JSON.stringify(configuredPrs)) {
      throw new TypeError(
        `configured/result PR corpus mismatch (missing: ${missing.join(", ") || "none"}; unexpected: ${unexpected.join(", ") || "none"})`,
      );
    }
    if (config.recordVideos !== true || config.validateVideos !== true) {
      throw new TypeError("publishable POC results require paired, validated recordings");
    }
  }

  const aggregate = aggregatePrResults(normalizedPrs);
  const coldAggregate = aggregateColdEndToEnd(normalizedPrs);
  if (complete) {
    if (document.aggregate === undefined || document.aggregate === null) {
      throw new TypeError("complete POC results have no aggregate summary");
    }
    assertDerivedEvidence(aggregate, record(document.aggregate, "POC aggregate"), "POC aggregate");
    if (document.coldAggregate === undefined || document.coldAggregate === null) {
      throw new TypeError("complete POC results have no cold end-to-end aggregate");
    }
    assertDerivedEvidence(
      coldAggregate,
      record(document.coldAggregate, "POC cold aggregate"),
      "POC cold aggregate",
    );
  }
  return { ...document, prs: normalizedPrs, aggregate, coldAggregate };
}

/** Strict v21+ validation. Keeping this separate from the historical provisional-to-canonical
 * validator makes old v19/v20 reports renderable without allowing their reconciliation model to
 * satisfy the new no-full-graph claim. */
function validatePartialOnlyResultsDocument(document) {
  const complete = document.status === "complete";
  const config = record(document.config, "partial-only POC config");
  if (complete && (config.mode !== "publishable"
    || !Array.isArray(config.diagnosticReasons)
    || config.diagnosticReasons.length !== 0
    || document.diagnostic !== null
    || config.repository?.toLowerCase() !== "uipath/autopilot"
    || !Number.isSafeInteger(config.repetitions)
    || config.repetitions < 2
    || config.recordVideos !== true
    || config.validateVideos !== true
    || config.coldEndToEnd?.enabled !== true
    || config.coldEndToEnd?.repetitions !== 1
    || config.coldEndToEnd?.isolation !== "fresh-meridian-service-and-cache-per-variant")) {
    throw new TypeError("complete partial-only results contradict publishable corpus/evidence settings");
  }
  const configuredPrs = Array.isArray(config.prs)
    ? config.prs.map((number) => positiveInteger(number, "configured partial-only PR number"))
    : [];
  if (complete && (configuredPrs.length < 2 || new Set(configuredPrs).size !== configuredPrs.length)) {
    throw new TypeError("publishable partial-only results require multiple distinct Autopilot PRs");
  }

  const seen = new Set();
  const normalizedPrs = document.prs.map((rawPr, prIndex) => {
    const pr = record(rawPr, "partial-only POC PR result");
    const number = positiveInteger(pr.number, "partial-only POC PR number");
    if (seen.has(number)) throw new TypeError(`partial-only results contain duplicate PR #${number}`);
    seen.add(number);
    if (!complete) {
      for (const group of [pr.recordings, pr.startupRecordings]) {
        for (const variant of ["full", "progressive"]) {
          if (group?.[variant]?.relativePath !== undefined) {
            validateRelativeEvidencePath(
              group[variant].relativePath,
              `PR #${number} ${variant} diagnostic recording path`,
            );
          }
        }
      }
      return pr;
    }
    if (pr.status !== "complete") throw new TypeError(`configured PR #${number} is not complete`);

    const live = record(pr.revisions?.preparationInput, `PR #${number} preparation input`);
    const stream = validatePartialPreparationStream(
      { number, headOid: oid(live.headOid, `PR #${number} live HEAD`) },
      pr.preparation?.events,
    );
    assertDerivedEvidence(
      stream,
      record(pr.preparation?.terminalProof, `PR #${number} partial terminal proof`),
      `PR #${number} partial terminal proof`,
    );
    const partial = record(pr.revisions?.prepared, `PR #${number} partial prepared revision`);
    for (const field of ["graphId", "comparisonGraphId", "headSha", "baseSha", "mergeBaseSha", "pairId"]) {
      if (partial[field] !== stream.prepared[field]) {
        throw new TypeError(`PR #${number} stored partial revision changed ${field}`);
      }
    }
    const canonical = record(pr.revisions?.canonicalBaseline, `PR #${number} canonical baseline revision`);
    for (const field of ["headSha", "mergeBaseSha"]) {
      if (canonical[field] !== partial[field]) {
        throw new TypeError(`PR #${number} canonical baseline changed exact ${field}`);
      }
    }
    if (canonical.graphId === partial.graphId
      || canonical.comparisonGraphId === partial.comparisonGraphId
      || canonical.completeness !== "complete") {
      throw new TypeError(`PR #${number} canonical measurement baseline is not independent and complete`);
    }

    const variants = {};
    for (const variant of ["full", "progressive"]) {
      const rawVariant = record(pr.variants?.[variant], `PR #${number} ${variant} variant`);
      if (!Array.isArray(rawVariant.samples) || rawVariant.samples.length !== config.repetitions) {
        throw new TypeError(`PR #${number} ${variant} has no complete repetition set`);
      }
      const expected = variant === "progressive" ? partial : canonical;
      for (const [index, sample] of rawVariant.samples.entries()) {
        assertObservedSemanticRevision(
          sample?.exactRevision,
          expected,
          `PR #${number} ${variant} sample ${index + 1} exact revision`,
        );
        assertPartialOnlySampleTransport(sample, number, variant, expected, stream);
      }
      const summary = summarizeVariant(rawVariant.samples);
      assertDerivedEvidence(
        summary,
        record(rawVariant.summary, `PR #${number} ${variant} summary`),
        `PR #${number} ${variant} summary`,
      );
      variants[variant] = { ...rawVariant, summary };
    }
    // The prepared lanes share one long-lived service, so only browser-local heap/RSS is
    // publishable here. Service/worker memory is validated and compared below from isolated cold
    // services and caches.
    assertPublishableMeasurements(number, variants, { requirePreparedServiceMemory: false });
    assertPreparedMeasurementSchedule(number, variants, config.repetitions, prIndex);
    assertPreservedReviewSurface(number, variants.full.samples, variants.progressive.samples);
    assertStoredRevisionProvenance(number, pr.revisions, config.repository);
    assertPreparedInitialProjectionEvidence(number, pr);
    assertPartialOnlyProjectionIdentity(number, variants, partial, canonical);
    assertCacheReadiness(number, variants.progressive.samples, partial);
    validateOptionalEvidencePaths(pr.evidence, `POC PR #${number} evidence`);
    validateOptionalEvidencePaths(pr.screenshots, `POC PR #${number} screenshots`);

    const recordings = validatePartialOnlyFunctionalityRecordings(pr, config, partial, canonical);
    const startupRecordings = validatePartialOnlyStartupRecordings(pr, config, partial, canonical, stream);
    const cold = validatePartialOnlyColdEvidence(pr, partial, canonical, stream, prIndex);
    const comparison = comparisonFromPartialOnlyEvidence(
      variants.full.summary,
      variants.progressive.summary,
      cold.variants.full,
      cold.variants.progressive,
    );
    assertDerivedEvidence(
      comparison,
      record(pr.comparison, `PR #${number} partial-only comparison`),
      `PR #${number} partial-only comparison`,
    );
    return { ...pr, variants, recordings, startupRecordings, coldEndToEnd: cold, comparison };
  });

  if (complete) {
    if (JSON.stringify([...seen]) !== JSON.stringify(configuredPrs)) {
      throw new TypeError("configured/result partial-only PR corpus mismatch");
    }
    const serviceIds = new Set();
    const cacheIds = new Set();
    for (const pr of normalizedPrs) {
      for (const variant of ["full", "progressive"]) {
        const isolation = pr.coldEndToEnd.variants[variant].isolation;
        if (serviceIds.has(isolation.serviceInstanceId) || cacheIds.has(isolation.cacheInstanceId)) {
          throw new TypeError("publishable partial-only cold evidence reused a service or cache instance");
        }
        serviceIds.add(isolation.serviceInstanceId);
        cacheIds.add(isolation.cacheInstanceId);
      }
    }
  }
  const aggregate = aggregatePartialOnlyResults(normalizedPrs);
  const coldAggregate = aggregateColdEndToEnd(normalizedPrs);
  if (complete) {
    assertDerivedEvidence(aggregate, record(document.aggregate, "partial-only aggregate"), "partial-only aggregate");
    assertDerivedEvidence(
      coldAggregate,
      record(document.coldAggregate, "partial-only cold aggregate"),
      "partial-only cold aggregate",
    );
  }
  return { ...document, prs: normalizedPrs, aggregate, coldAggregate };
}

/** Strict absolute-evidence mode for the production partial runtime. The accepted document has no
 * canonical/full lane anywhere: the normal listener, each isolated cold service, and each startup
 * recording service all prove that the benchmark-only full capability was absent. */
function validatePartialRuntimeOnlyResultsDocument(document) {
  const complete = document.status === "complete";
  const config = record(document.config, "partial-runtime-only POC config");
  if (!complete) {
    for (const entry of document.prs) {
      const pr = record(entry, "partial-runtime-only POC PR result");
      positiveInteger(pr.number, "partial-runtime-only POC PR number");
      for (const group of [pr.recordings, pr.startupRecordings]) {
        if (group?.progressive?.relativePath !== undefined) {
          validateRelativeEvidencePath(
            group.progressive.relativePath,
            `PR #${pr.number} progressive diagnostic recording path`,
          );
        }
      }
    }
    return {
      ...document,
      aggregate: aggregatePartialRuntimeOnlyResults(document.prs),
      coldAggregate: aggregatePartialRuntimeOnlyColdResults(document.prs),
    };
  }

  if (config.mode !== "publishable"
    || !Array.isArray(config.diagnosticReasons)
    || config.diagnosticReasons.length !== 0
    || document.diagnostic !== null
    || (Object.hasOwn(document, "failure") && document.failure !== null)
    || config.repository?.toLowerCase() !== "uipath/autopilot"
    || !Number.isSafeInteger(config.repetitions)
    || config.repetitions < 2
    || config.recordVideos !== true
    || config.validateVideos !== true
    || config.coldEndToEnd?.enabled !== true
    || config.coldEndToEnd?.repetitions !== 1
    || config.coldEndToEnd?.isolation
      !== "fresh-production-service-and-cache-per-progressive-lane") {
    throw new TypeError("complete partial-runtime-only results contradict publishable absolute-evidence settings");
  }
  if (!isLoopbackOrigin(normalizeBaseUrl(config.baseUrl))) {
    throw new TypeError("partial-runtime-only results require a loopback production origin");
  }
  if (document.environment?.meridianServiceDiscovery !== "local-listener") {
    throw new TypeError("partial-runtime-only evidence did not discover the normal production listener");
  }
  const listenerPid = positiveInteger(
    document.environment?.meridianServicePid,
    "normal production listener PID",
  );
  validateFullBaselineCapabilityAbsent(
    config.fullBaselineCapability,
    "normal production listener full-baseline capability",
    { expectedSource: "listener-process-command", expectedListenerPid: listenerPid },
  );
  const configuredPrs = Array.isArray(config.prs)
    ? config.prs.map((number) => positiveInteger(number, "configured partial-runtime-only PR number"))
    : [];
  if (configuredPrs.length < 2 || new Set(configuredPrs).size !== configuredPrs.length) {
    throw new TypeError("publishable partial-runtime-only results require multiple distinct Autopilot PRs");
  }

  const seen = new Set();
  const serviceIds = new Set();
  const cacheIds = new Set();
  const normalizedPrs = document.prs.map((rawPr) => {
    const pr = record(rawPr, "partial-runtime-only POC PR result");
    const number = positiveInteger(pr.number, "partial-runtime-only POC PR number");
    if (seen.has(number)) throw new TypeError(`partial-runtime-only results contain duplicate PR #${number}`);
    seen.add(number);
    if (pr.status !== "complete") throw new TypeError(`configured PR #${number} is not complete`);
    assertNoOwnMember(pr.revisions, "canonicalBaseline", `PR #${number} canonical baseline revision`);
    assertOnlyProgressiveMember(
      pr.revisions?.coldInputs,
      `PR #${number} partial-runtime-only cold input revisions`,
    );
    assertNoOwnMember(pr.preparation, "canonicalBaseline", `PR #${number} canonical baseline preparation`);
    assertNoOwnMember(pr, "handoffRecordings", `PR #${number} legacy handoff recordings`);
    assertNoOwnMember(pr, "comparison", `PR #${number} reduction comparison`);
    assertNoOwnMember(pr, "parity", `PR #${number} scene comparison parity`);

    const live = record(pr.revisions?.preparationInput, `PR #${number} preparation input`);
    const stream = validatePartialPreparationStream(
      { number, headOid: oid(live.headOid, `PR #${number} live HEAD`) },
      pr.preparation?.events,
    );
    assertDerivedEvidence(
      stream,
      record(pr.preparation?.terminalProof, `PR #${number} partial terminal proof`),
      `PR #${number} partial terminal proof`,
    );
    const partial = record(pr.revisions?.prepared, `PR #${number} partial prepared revision`);
    for (const field of ["graphId", "comparisonGraphId", "headSha", "baseSha", "mergeBaseSha", "pairId"]) {
      if (partial[field] !== stream.prepared[field]) {
        throw new TypeError(`PR #${number} stored partial revision changed ${field}`);
      }
    }

    const rawVariants = assertOnlyProgressiveMember(
      pr.variants,
      `PR #${number} partial-runtime-only prepared variants`,
    );
    const rawProgressive = record(rawVariants.progressive, `PR #${number} progressive variant`);
    if (!Array.isArray(rawProgressive.samples)
      || rawProgressive.samples.length !== config.repetitions) {
      throw new TypeError(`PR #${number} progressive variant has no complete repetition set`);
    }
    for (const [index, sample] of rawProgressive.samples.entries()) {
      validateNoFullAnalyzeRequests(
        sample?.analyzeRequests,
        `PR #${number} progressive sample ${index + 1} analyze requests`,
      );
      assertNoOwnMember(
        sample,
        "canonicalBaselinePreparation",
        `PR #${number} progressive sample ${index + 1} canonical baseline preparation`,
      );
      assertNoOwnMember(
        sample,
        "reconciliation",
        `PR #${number} progressive sample ${index + 1} canonical reconciliation`,
      );
      assertObservedSemanticRevision(
        sample?.exactRevision,
        partial,
        `PR #${number} progressive sample ${index + 1} exact revision`,
      );
      assertPartialOnlySampleTransport(
        sample,
        number,
        "progressive",
        partial,
        stream,
        PARTIAL_RUNTIME_ONLY_DELIVERY_CONTRACT,
      );
      assertPartialOnlyGraphIdentity(
        sample,
        number,
        "progressive",
        partial,
        `prepared sample ${index + 1}`,
      );
    }
    const progressiveSummary = summarizeVariant(rawProgressive.samples);
    assertDerivedEvidence(
      progressiveSummary,
      record(rawProgressive.summary, `PR #${number} progressive summary`),
      `PR #${number} progressive summary`,
    );
    const variants = {
      progressive: { ...rawProgressive, summary: progressiveSummary },
    };
    assertPublishableMeasurements(number, variants, { variantNames: ["progressive"] });
    assertPartialRuntimeOnlyMeasurementSchedule(number, variants.progressive.samples, config.repetitions);
    assertStoredRevisionProvenance(number, pr.revisions, config.repository, {
      coldVariants: ["progressive"],
    });
    assertPreparedInitialProjectionEvidence(number, pr);
    assertCacheReadiness(number, variants.progressive.samples, partial);
    validateOptionalEvidencePaths(pr.evidence, `POC PR #${number} evidence`);
    validateOptionalEvidencePaths(pr.screenshots, `POC PR #${number} screenshots`);

    const recordings = validatePartialRuntimeOnlyFunctionalityRecording(pr, config, partial);
    const startupRecordings = validatePartialRuntimeOnlyStartupRecording(pr, config, partial);
    if (recordings.progressive.relativePath === startupRecordings.progressive.relativePath) {
      throw new TypeError(`PR #${number} must contain two distinct progressive recordings`);
    }
    const coldEndToEnd = validatePartialRuntimeOnlyColdEvidence(
      pr,
      partial,
      config.repository,
    );
    for (const isolation of [
      coldEndToEnd.variants.progressive.isolation,
      startupRecordings.progressive.isolation,
    ]) {
      if (serviceIds.has(isolation.serviceInstanceId) || cacheIds.has(isolation.cacheInstanceId)) {
        throw new TypeError("publishable partial-runtime-only evidence reused an isolated service or cache");
      }
      serviceIds.add(isolation.serviceInstanceId);
      cacheIds.add(isolation.cacheInstanceId);
    }
    return { ...pr, variants, recordings, startupRecordings, coldEndToEnd };
  });

  if (JSON.stringify([...seen]) !== JSON.stringify(configuredPrs)) {
    throw new TypeError("configured/result partial-runtime-only PR corpus mismatch");
  }
  assertNoOwnMember(document.aggregate, "full", "partial-runtime-only aggregate full lane");
  assertNoOwnMember(document.aggregate, "comparison", "partial-runtime-only aggregate comparison");
  assertNoOwnMember(document.coldAggregate, "full", "partial-runtime-only cold aggregate full lane");
  assertNoOwnMember(document.coldAggregate, "comparison", "partial-runtime-only cold aggregate comparison");
  const aggregate = aggregatePartialRuntimeOnlyResults(normalizedPrs);
  const coldAggregate = aggregatePartialRuntimeOnlyColdResults(normalizedPrs);
  assertDerivedEvidence(
    aggregate,
    record(document.aggregate, "partial-runtime-only aggregate"),
    "partial-runtime-only aggregate",
  );
  assertDerivedEvidence(
    coldAggregate,
    record(document.coldAggregate, "partial-runtime-only cold aggregate"),
    "partial-runtime-only cold aggregate",
  );
  return { ...document, prs: normalizedPrs, aggregate, coldAggregate };
}

function assertPartialOnlySampleTransport(
  sample,
  prNumber,
  variant,
  prepared,
  stream,
  deliveryContract = PARTIAL_ONLY_DELIVERY_CONTRACT,
) {
  const path = variant === "full" ? "/api/graph" : "/api/graph/project";
  assertAuthoritativeGraphNetwork(sample?.networkAtAction, `PR #${prNumber} ${variant} networkAtAction`, path);
  assertAuthoritativeGraphNetwork(sample?.networkSettled, `PR #${prNumber} ${variant} networkSettled`, path);
  const byPath = sample.networkSettled.byPath;
  const fullRequests = byPath["/api/graph"]?.requests ?? 0;
  const projectionRequests = byPath["/api/graph/project"]?.requests ?? 0;
  const marks = Array.isArray(sample.performanceMarks) ? sample.performanceMarks : [];
  if (variant === "full") {
    if (fullRequests < 1 || projectionRequests !== 0) {
      throw new TypeError(`PR #${prNumber} full baseline did not use only the canonical graph route`);
    }
    assertExactFullGraphEvidence(sample.graphs, prepared, `PR #${prNumber} full sample`);
    return;
  }
  if (fullRequests !== 0 || projectionRequests < 2 || (sample.graphs?.length ?? 0) !== 0) {
    throw new TypeError(`PR #${prNumber} progressive sample requested a canonical full artifact`);
  }
  if (marks.some((entry) => entry?.name === "meridian:pr-canonical-graph-reconciled")) {
    throw new TypeError(`PR #${prNumber} progressive sample emitted a retired canonical reconciliation mark`);
  }
  const terminals = Array.isArray(sample.analyzeTerminals) ? sample.analyzeTerminals : [];
  if (terminals.length !== 1) {
    throw new TypeError(`PR #${prNumber} progressive sample has no exact partial revalidation terminal`);
  }
  validatePartialAnalyzeTerminal(
    { number: prNumber, headOid: prepared.headSha },
    prepared,
    terminals[0],
  );
  validatePartialOnlyContinuationProof(
    sample.partialOnlyContinuation,
    `PR #${prNumber} progressive continuation proof`,
    stream.pairId,
    deliveryContract,
  );
}

function validatePartialOnlyContinuationProof(
  raw,
  name,
  expectedPairId,
  expectedDelivery = PARTIAL_ONLY_DELIVERY_CONTRACT,
) {
  const proof = record(raw, name);
  const repositoryWorkers = proof.repositoryAnalysisWorkerPidsAfterTerminal;
  const partialWorkersAtStart = proof.boundedPartialWorkerPidsAtDwellStart;
  const graphWorkersAtStart = proof.graphProjectWorkerPidsAtDwellStart;
  const partialWorkers = proof.boundedPartialWorkerPidsDuringDwell;
  const graphWorkers = proof.graphProjectWorkerPidsDuringDwell;
  const newPartialWorkers = proof.newBoundedPartialWorkerPidsDuringDwell;
  const newGraphWorkers = proof.newGraphProjectWorkerPidsDuringDwell;
  const before = record(proof.preDwellGraphWork, `${name} pre-dwell graph work`);
  const work = record(proof.postReadyGraphWork, `${name} post-ready graph work`);
  const prePartialProjectionRequests = nonNegativeSafeInteger(
    before.partialProjectionRequests,
    `${name} pre-dwell partial projection requests`,
  );
  const prePartialProjectionWarmRequests = nonNegativeSafeInteger(
    before.partialProjectionWarmRequests,
    `${name} pre-dwell partial projection warm requests`,
  );
  const preSourceIndexRequests = nonNegativeSafeInteger(
    before.sourceIndexRequests,
    `${name} pre-dwell source index requests`,
  );
  const preFullGenerationRequests = nonNegativeSafeInteger(
    before.fullGenerationRequests,
    `${name} pre-dwell full generation requests`,
  );
  const partialProjectionRequests = nonNegativeSafeInteger(
    work.partialProjectionRequests,
    `${name} partial projection requests`,
  );
  const partialProjectionWarmRequests = nonNegativeSafeInteger(
    work.partialProjectionWarmRequests,
    `${name} partial projection warm requests`,
  );
  const sourceIndexRequests = nonNegativeSafeInteger(
    work.sourceIndexRequests,
    `${name} source index requests`,
  );
  const fullGenerationRequests = nonNegativeSafeInteger(
    work.fullGenerationRequests,
    `${name} full generation requests`,
  );
  const validPids = (value) => Array.isArray(value)
    && value.every((pid) => Number.isSafeInteger(pid) && pid > 0)
    && new Set(value).size === value.length;
  const startPartialSet = validPids(partialWorkersAtStart) ? new Set(partialWorkersAtStart) : null;
  const startGraphSet = validPids(graphWorkersAtStart) ? new Set(graphWorkersAtStart) : null;
  const observedPartialSet = validPids(partialWorkers) ? new Set(partialWorkers) : null;
  const observedGraphSet = validPids(graphWorkers) ? new Set(graphWorkers) : null;
  const expectedNewPartial = startPartialSet === null || observedPartialSet === null
    ? []
    : [...observedPartialSet].filter((pid) => !startPartialSet.has(pid));
  const expectedNewGraph = startGraphSet === null || observedGraphSet === null
    ? []
    : [...observedGraphSet].filter((pid) => !startGraphSet.has(pid));
  const processObservation = record(proof.processObservation, `${name} process observation`);
  if (proof.version !== 2
    || proof.delivery !== expectedDelivery
    || proof.pairId !== expectedPairId
    || proof.streamEnded !== true
    || proof.readyDoneSamePair !== true
    || proof.canonicalGraphRequests !== 0
    || proof.canonicalGraphResponses !== 0
    || proof.canonicalReconciliationMarks !== 0
    || !validPids(repositoryWorkers)
    || repositoryWorkers.length !== 0
    || startPartialSet === null
    || startGraphSet === null
    || observedPartialSet === null
    || observedGraphSet === null
    || !validPids(newPartialWorkers)
    || !validPids(newGraphWorkers)
    || [...startPartialSet].some((pid) => !observedPartialSet.has(pid))
    || [...startGraphSet].some((pid) => !observedGraphSet.has(pid))
    || JSON.stringify(newPartialWorkers) !== JSON.stringify(expectedNewPartial)
    || JSON.stringify(newGraphWorkers) !== JSON.stringify(expectedNewGraph)
    || preFullGenerationRequests !== 0
    || fullGenerationRequests !== 0
    || startPartialSet.size > prePartialProjectionRequests + prePartialProjectionWarmRequests
    || startGraphSet.size > 2 * (prePartialProjectionRequests + prePartialProjectionWarmRequests)
      + preSourceIndexRequests
    || newPartialWorkers.length > partialProjectionRequests + partialProjectionWarmRequests
    || newGraphWorkers.length > 2 * (partialProjectionRequests + partialProjectionWarmRequests)
      + sourceIndexRequests
    || !Number.isSafeInteger(proof.postTerminalDwellMs)
    || proof.postTerminalDwellMs < 250
    || proof.routeCounterScope !== "same-dwell-request-delta"
    || processObservation.scope !== "same-dwell-start-and-sampled-union"
    || processObservation.sampleIntervalMs !== 50
    || !Number.isSafeInteger(processObservation.sampleCount)
    || processObservation.sampleCount < 2
    || proof.allowedBackgroundWork
      !== "syntax-symbol-topology-index-and-explicit-bounded-partial-expansion-only") {
    throw new TypeError(`${name} does not prove zero canonical continuation and route-authorized partial work`);
  }
  return proof;
}

function validateFullBaselineCapabilityAbsent(
  raw,
  name,
  { expectedSource, expectedListenerPid } = {},
) {
  const proof = record(raw, name);
  if (proof.inspected !== true
    || proof.present !== false
    || proof.argument !== "--benchmark-pr-full-baseline"
    || proof.source !== expectedSource
    || typeof proof.commandSha256 !== "string"
    || !/^[a-f0-9]{64}$/.test(proof.commandSha256)
    || (expectedListenerPid !== undefined && proof.listenerPid !== expectedListenerPid)) {
    throw new TypeError(`${name} does not prove the full-baseline capability was absent`);
  }
  return proof;
}

function assertAbsentFullLane(value, name) {
  if (value !== undefined && value !== null) {
    throw new TypeError(`${name} must be absent in partial-runtime-only evidence`);
  }
}

function assertNoOwnMember(value, member, name) {
  if (value !== null && value !== undefined && Object.hasOwn(value, member)) {
    throw new TypeError(`${name} must be omitted from partial-runtime-only evidence`);
  }
}

function validateNoFullAnalyzeRequests(raw, name) {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new TypeError(`${name} has no analyze-request provenance`);
  }
  for (const [index, request] of raw.entries()) {
    if (request?.method !== "POST"
      || request.progressiveFalse !== false
      || request.fullBaselineCapabilityHeaderPresent !== false) {
      throw new TypeError(
        `${name}[${index}] used progressive:false or the full-baseline capability header`,
      );
    }
  }
  return raw;
}

function assertOnlyProgressiveMember(raw, name) {
  const value = record(raw, name);
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "progressive") {
    throw new TypeError(`${name} must contain only the progressive lane`);
  }
  return value;
}

function assertPartialRuntimeOnlyMeasurementSchedule(prNumber, samples, repetitions) {
  for (let index = 0; index < repetitions; index += 1) {
    const sample = samples[index];
    if (sample?.variant !== "progressive"
      || sample?.iteration !== index + 1
      || sample?.measurementOrder?.sequencePosition !== 1
      || JSON.stringify(sample?.measurementOrder?.variants) !== JSON.stringify(["progressive"])) {
      throw new TypeError(
        `PR #${prNumber} progressive sample ${index + 1} contradicts the partial-runtime-only schedule`,
      );
    }
  }
}

function validateOwnedProcessTreeCleanup(isolation, name) {
  const cleanup = record(isolation.cleanup, `${name} cleanup proof`);
  if (cleanup.strategy !== "tracked-owned-process-tree-and-groups"
    || cleanup.rootPid !== isolation.servicePid
    || cleanup.rootProcessGroupId !== isolation.servicePid
    || cleanup.scanIntervalMs !== 100
    || cleanup.registryProofHealthy !== true
    || !Number.isSafeInteger(cleanup.registeredProcessCount)
    || cleanup.registeredProcessCount < 1
    || !Number.isSafeInteger(cleanup.registeredGroupCount)
    || cleanup.registeredGroupCount < 1
    || !Array.isArray(cleanup.registeredGroupIds)
    || cleanup.registeredGroupIds.length !== cleanup.registeredGroupCount
    || new Set(cleanup.registeredGroupIds).size !== cleanup.registeredGroupIds.length
    || !cleanup.registeredGroupIds.every((pgid) => Number.isSafeInteger(pgid) && pgid > 1)
    || !cleanup.registeredGroupIds.includes(cleanup.rootProcessGroupId)
    || !Number.isSafeInteger(cleanup.detachedGroupCount)
    || cleanup.detachedGroupCount < 1
    || cleanup.detachedGroupCount >= cleanup.registeredGroupCount
    || !["sigstopGroupCount", "sigtermGroupCount", "sigkillGroupCount"]
      .every((field) => Number.isSafeInteger(cleanup[field]) && cleanup[field] >= 0)
    || cleanup.sigstopGroupCount < 1
    || cleanup.sigtermGroupCount < 1
    || cleanup.verifiedRecordedPidsAbsent !== true
    || cleanup.verifiedRecordedGroupsAbsent !== true
    || cleanup.verifiedEmpty !== true
    || cleanup.tempDirectoryRemoved !== true
    || !Array.isArray(cleanup.residualPids)
    || cleanup.residualPids.length !== 0
    || !Array.isArray(cleanup.residualGroupIds)
    || cleanup.residualGroupIds.length !== 0) {
    throw new TypeError(`${name} did not prove tracked process-tree/group cleanup`);
  }
  return cleanup;
}

function validatePartialRuntimeOnlyIsolation(raw, name) {
  const isolation = record(raw, name);
  if (isolation.freshCache !== true
    || isolation.loopbackOnly !== true) {
    throw new TypeError(`${name} did not prove fresh loopback isolation`);
  }
  positiveInteger(isolation.servicePid, `${name} service PID`);
  for (const field of ["serviceInstanceId", "cacheInstanceId"]) {
    if (typeof isolation[field] !== "string" || !/^[a-f0-9]{64}$/.test(isolation[field])) {
      throw new TypeError(`${name} has no opaque ${field}`);
    }
  }
  validateOwnedProcessTreeCleanup(isolation, name);
  validateFullBaselineCapabilityAbsent(
    isolation.fullBaselineCapability,
    `${name} full-baseline capability`,
    { expectedSource: "isolated-service-spawn-arguments" },
  );
  return isolation;
}

function validateProgressiveRecordingInteraction(recording, prNumber, partial) {
  assertObservedSemanticRevision(
    recording.exactRevision,
    partial,
    `PR #${prNumber} progressive functionality exact revision`,
  );
  const interaction = record(recording.interaction, `PR #${prNumber} progressive showcase interaction`);
  if (interaction.variant !== "progressive"
    || interaction.searchHydrated !== true
    || interaction.depthAdjusted !== true
    || interaction.disconnectedBeforeSearch !== true
    || !Number.isSafeInteger(interaction.canvasNodesBeforeSearch)
    || !Number.isSafeInteger(interaction.canvasNodesAfterSearch)
    || interaction.canvasNodesAfterSearch <= interaction.canvasNodesBeforeSearch) {
    throw new TypeError(
      `PR #${prNumber} progressive recording did not prove adjustable depth and disconnected search hydration`,
    );
  }
  const symbol = record(interaction.symbol, `PR #${prNumber} progressive recorded symbol`);
  for (const field of ["id", "fileId", "displayName", "file"]) {
    nonEmptyString(symbol[field], `PR #${prNumber} progressive recorded symbol ${field}`);
  }
  const background = record(
    interaction.backgroundSymbolIndex,
    `PR #${prNumber} progressive background symbol index`,
  );
  if (background.rendererInitiated !== true
    || background.afterFirstActionable !== true
    || background.beforeHarnessInteraction !== true
    || background.complete !== true
    || background.graphId !== partial.graphId
    || !Number.isSafeInteger(background.indexedSymbolCount)
    || background.indexedSymbolCount <= 0
    || !Number.isSafeInteger(background.totalSymbolCount)
    || background.totalSymbolCount < background.indexedSymbolCount) {
    throw new TypeError(`PR #${prNumber} recording did not prove renderer-initiated background symbol indexing`);
  }
  const acceptanceMark = record(
    background.acceptanceMark,
    `PR #${prNumber} progressive symbol acceptance mark`,
  );
  if (acceptanceMark.name !== "meridian:progressive-symbol-index-ready"
    || !finiteNumber(acceptanceMark.startTimeMs)
    || acceptanceMark.startTimeMs < 0
    || acceptanceMark.indexedSymbolCount !== background.indexedSymbolCount) {
    throw new TypeError(`PR #${prNumber} recording did not prove renderer acceptance of its background symbol index`);
  }
  const rendererTransport = record(
    background.rendererTransport,
    `PR #${prNumber} progressive symbol renderer transport`,
  );
  if (rendererTransport.graphId !== partial.graphId
    || rendererTransport.workerBacked !== true
    || rendererTransport.accepted !== true
    || rendererTransport.source !== "renderer-symbol-worker-accepted"
    || !finiteNumber(rendererTransport.requestStartedAtMs)
    || !finiteNumber(rendererTransport.firstActionableAtMs)
    || rendererTransport.requestStartedAtMs + 0.5 < rendererTransport.firstActionableAtMs) {
    throw new TypeError(`PR #${prNumber} recording did not prove a post-action renderer symbol transport`);
  }
  const harnessFetch = record(
    background.harnessFetch,
    `PR #${prNumber} progressive symbol evidence fetch`,
  );
  if (harnessFetch.graphId !== partial.graphId || harnessFetch.status !== 200) {
    throw new TypeError(`PR #${prNumber} recording did not prove an exact-revision harness symbol evidence fetch`);
  }
  return interaction;
}

function validatePartialRuntimeOnlyFunctionalityRecording(pr, config, partial) {
  const raw = assertOnlyProgressiveMember(
    pr.recordings,
    `PR #${pr.number} partial-runtime-only functionality recordings`,
  );
  const recording = record(raw.progressive, `PR #${pr.number} progressive functionality recording`);
  validateRelativeEvidencePath(recording.relativePath, "progressive functionality recording path");
  validateRecordingEvidence(recording, pr.number, "progressive functionality", config);
  validateNoFullAnalyzeRequests(
    recording.analyzeRequests,
    `PR #${pr.number} progressive functionality analyze requests`,
  );
  validatePartialRuntimeOnlyRecordingTransport(
    recording.partialRuntimeTransport,
    `PR #${pr.number} progressive functionality transport`,
  );
  validateProgressiveRecordingInteraction(recording, pr.number, partial);
  return { progressive: recording };
}

function validatePartialRuntimeOnlyRecordingTransport(raw, name) {
  const transport = record(raw, name);
  const counts = {};
  for (const field of [
    "canonicalGraphRequests",
    "canonicalGraphResponses",
    "fullGenerationRequests",
    "canonicalReconciliationMarks",
    "partialProjectionRequests",
    "partialWarmRequests",
    "sourceIndexRequests",
  ]) {
    counts[field] = nonNegativeSafeInteger(transport[field], `${name}.${field}`);
  }
  if (counts.canonicalGraphRequests !== 0
    || counts.canonicalGraphResponses !== 0
    || counts.fullGenerationRequests !== 0
    || counts.canonicalReconciliationMarks !== 0
    || counts.partialProjectionRequests < 2
    || counts.sourceIndexRequests < 1
    || transport.graphAccountingComplete !== true) {
    throw new TypeError(`${name} does not prove complete progressive-only graph transport`);
  }
  return transport;
}

function validatePartialRuntimeOnlyStartupRecording(pr, config, partial) {
  const raw = assertOnlyProgressiveMember(
    pr.startupRecordings,
    `PR #${pr.number} partial-runtime-only startup recordings`,
  );
  const recording = record(raw.progressive, `PR #${pr.number} progressive startup recording`);
  validateRelativeEvidencePath(recording.relativePath, "progressive startup recording path");
  validateRecordingEvidence(recording, pr.number, "progressive startup", config);
  validateNoFullAnalyzeRequests(
    recording.analyzeRequests,
    `PR #${pr.number} progressive startup analyze requests`,
  );
  assertNoOwnMember(
    recording,
    "canonicalBaselinePreparation",
    `PR #${pr.number} startup canonical baseline preparation`,
  );
  const { terminal, prepared: startupPrepared } = validateIsolatedStartupCoordinates(
    recording,
    pr.number,
    partial,
  );
  if (recording.flow !== "partial-ready-navigation-with-independent-terminal-drain"
    || terminal.streamEnded !== true
    || terminal.sameBoundedPair !== true
    || terminal.canonicalContinuationObserved !== false
    || JSON.stringify(terminal.postReadyStages) !== JSON.stringify(["done"])) {
    throw new TypeError(`PR #${pr.number} progressive startup does not prove partial-only navigation`);
  }
  validatePartialOnlyContinuationProof(
    recording.continuationProof,
    `PR #${pr.number} progressive startup continuation proof`,
    startupPrepared.pairId,
    PARTIAL_RUNTIME_ONLY_DELIVERY_CONTRACT,
  );
  validatePartialRuntimeOnlyStartupTiming(recording, pr.number);
  validatePartialRuntimeOnlyIsolation(
    recording.isolation,
    `PR #${pr.number} progressive startup isolation`,
  );
  return { progressive: recording };
}

/** A startup recording owns an isolated service/cache, so its opaque pair id and graph ids are
 * expected to differ from the main prepared lane. Bind every recording-local coordinate to the
 * isolated terminal pair, then compare only the immutable Git revisions with the main lane. */
function validateIsolatedStartupCoordinates(recording, prNumber, rawMainPrepared) {
  const name = `PR #${prNumber} progressive startup`;
  const mainPrepared = record(rawMainPrepared, `${name} main prepared revision`);
  const terminal = record(recording.terminalProof, `${name} terminal proof`);
  const terminalPrepared = record(terminal.prepared, `${name} terminal prepared pair`);
  const prepared = validateProvisionalPair(
    {
      number: prNumber,
      headOid: oid(mainPrepared.headSha, `${name} main prepared HEAD`),
    },
    terminalPrepared,
    `${name} isolated`,
  );
  const preparedViewUrl = validateProvisionalViewUrl(
    { number: prNumber },
    prepared,
    terminalPrepared.viewUrl,
    `${name} isolated`,
  );

  for (const field of ["headSha", "baseSha", "mergeBaseSha"]) {
    const expected = oid(mainPrepared[field], `${name} main prepared ${field}`);
    if (prepared[field] !== expected) {
      throw new TypeError(`${name} changed immutable ${field} from the main prepared pair`);
    }
  }

  const exactRevision = assertObservedSemanticRevision(
    recording.exactRevision,
    prepared,
    `${name} exact revision`,
  );
  for (const field of ["headSha", "baseSha", "mergeBaseSha"]) {
    if (exactRevision[field] !== prepared[field]) {
      throw new TypeError(`${name} exact revision changed isolated ${field}`);
    }
  }

  if (terminal.version !== 1
    || terminal.delivery !== PARTIAL_ONLY_DELIVERY_CONTRACT
    || terminal.pairId !== prepared.pairId
    || terminal.graphId !== prepared.graphId
    || terminal.comparisonGraphId !== prepared.comparisonGraphId
    || !Number.isSafeInteger(terminal.readyIndex)
    || terminal.readyIndex < 0
    || terminal.doneIndex !== terminal.readyIndex + 1
    || terminal.eventCount !== terminal.doneIndex + 1) {
    throw new TypeError(`${name} terminal graph coordinates do not bind its isolated prepared pair`);
  }

  const handoff = record(recording.handoff, `${name} handoff`);
  const handoffPartial = record(handoff.partial, `${name} handoff partial pair`);
  const manifestSha256 = createHash("sha256")
    .update(JSON.stringify(prepared.changedFiles))
    .digest("hex");
  if (handoff.version !== 2
    || handoff.delivery !== PARTIAL_ONLY_DELIVERY_CONTRACT
    || handoff.pairId !== prepared.pairId
    || handoff.exactRevisionBound !== true
    || handoff.sameBoundedPair !== true
    || handoff.canonicalContinuationObserved !== false
    || handoff.manifestSha256 !== manifestSha256) {
    throw new TypeError(`${name} handoff does not bind its isolated prepared pair`);
  }
  for (const field of ["graphId", "comparisonGraphId", "headSha", "baseSha", "mergeBaseSha"]) {
    if (handoffPartial[field] !== prepared[field]) {
      throw new TypeError(`${name} handoff changed isolated ${field}`);
    }
  }

  const navigation = record(recording.navigation, `${name} navigation`);
  if (navigation.source !== "playwright-main-document-request"
    || relativeViewUrl(navigation.viewUrl) !== preparedViewUrl) {
    throw new TypeError(`${name} has no isolated-pair main-document navigation proof`);
  }
  return { terminal, prepared: { ...prepared, viewUrl: preparedViewUrl } };
}

function validatePartialRuntimeOnlyStartupTiming(recording, prNumber) {
  const timings = record(recording.timings, `PR #${prNumber} progressive startup timings`);
  const ready = finiteNonNegative(
    timings.provisionalReadyObservedMs,
    `PR #${prNumber} progressive startup ready time`,
  );
  finiteNonNegative(
    timings.partialTerminalDoneMs,
    `PR #${prNumber} progressive startup partial terminal time`,
  );
  const navigation = finiteNonNegative(
    timings.navigationStartedMs,
    `PR #${prNumber} progressive startup navigation time`,
  );
  finiteNonNegative(
    timings.firstActionableBrowserMs,
    `PR #${prNumber} progressive startup first-actionable time`,
  );
  if (Object.hasOwn(timings, "canonicalBaselineDoneMs")
    || Object.hasOwn(timings, "canonicalReconciledBrowserMs")) {
    throw new TypeError(`PR #${prNumber} progressive startup contains canonical timing fields`);
  }
  if (recording.navigation?.startedMs !== navigation
    || ready > navigation) {
    throw new TypeError(
      `PR #${prNumber} progressive startup timing does not prove ready-first navigation and independent terminal drain`,
    );
  }
  // `partialDone` is intentionally not ordered against ready/navigation. The Node-side terminal
  // subscriber drains the same stream independently and can observe EOF before the renderer's
  // exposed-function round trip completes and Chromium starts the main-document request.
}

function validatePartialRuntimeOnlyColdEvidence(pr, mainPrepared, repository) {
  const cold = record(pr.coldEndToEnd, `PR #${pr.number} partial-runtime-only cold evidence`);
  if (cold.repetitions !== 1
    || cold.isolation !== "fresh-production-service-and-cache-per-progressive-lane"
    || JSON.stringify(cold.order) !== JSON.stringify(["progressive"])) {
    throw new TypeError(`PR #${pr.number} cold evidence is not one fresh progressive-only lane`);
  }
  const variants = assertOnlyProgressiveMember(
    cold.variants,
    `PR #${pr.number} partial-runtime-only cold variants`,
  );
  const sample = record(variants.progressive, `PR #${pr.number} cold progressive sample`);
  validateNoFullAnalyzeRequests(
    sample.analyzeRequests,
    `PR #${pr.number} cold progressive analyze requests`,
  );
  if (sample.variant !== "progressive"
    || sample.repetition !== 1
    || sample.measurementOrder?.sequencePosition !== 1
    || JSON.stringify(sample.measurementOrder?.variants) !== JSON.stringify(["progressive"])) {
    throw new TypeError(`PR #${pr.number} cold progressive sample order is unproven`);
  }
  validatePartialRuntimeOnlyIsolation(
    sample.isolation,
    `PR #${pr.number} cold progressive isolation`,
  );
  assertNoOwnMember(
    sample,
    "canonicalBaselinePreparation",
    `PR #${pr.number} cold canonical baseline preparation`,
  );
  assertNoOwnMember(sample, "reconciliation", `PR #${pr.number} cold canonical reconciliation`);
  if (Object.hasOwn(sample.timings ?? {}, "canonicalReconciledMs")) {
    throw new TypeError(`PR #${pr.number} cold progressive sample recorded canonical reconciliation timing`);
  }

  const coldLive = record(
    pr.revisions?.coldInputs?.progressive,
    `PR #${pr.number} cold progressive input revision`,
  );
  const live = {
    number: pr.number,
    headOid: oid(coldLive.headOid, `PR #${pr.number} cold progressive HEAD`),
  };
  const preparation = record(
    sample.preparation,
    `PR #${pr.number} cold progressive preparation`,
  );
  if (!Array.isArray(preparation.events) || preparation.events.length < 2) {
    throw new TypeError(`PR #${pr.number} cold progressive has no preparation stream`);
  }
  const coldStream = validatePartialPreparationStream(live, preparation.events);
  const coldPrepared = coldStream.prepared;
  // The target branch tip is observation provenance and may advance independently between the
  // main listener and this fresh cold service. HEAD + merge-base are the immutable review identity.
  for (const field of ["headSha", "mergeBaseSha"]) {
    const expected = oid(mainPrepared[field], `PR #${pr.number} main prepared ${field}`);
    if (coldPrepared[field] !== expected) {
      throw new TypeError(`PR #${pr.number} cold progressive changed immutable ${field}`);
    }
  }
  validateStoredColdPreparedPair(
    sample.prepared,
    live,
    coldPrepared,
    `PR #${pr.number} cold progressive prepared pair`,
  );
  validateStoredColdPreparedPair(
    sample.provisionalPrepared,
    live,
    coldPrepared,
    `PR #${pr.number} cold progressive provisional pair`,
  );

  const storedColdTerminal = record(
    preparation.terminalProof,
    `PR #${pr.number} cold partial terminal proof`,
  );
  for (const field of [
    "version",
    "delivery",
    "streamEnded",
    "postReadyStages",
    "sameBoundedPair",
    "canonicalContinuationObserved",
    "pairId",
    "graphId",
    "comparisonGraphId",
  ]) {
    if (JSON.stringify(storedColdTerminal[field]) !== JSON.stringify(coldStream[field])) {
      throw new TypeError(`PR #${pr.number} cold partial terminal proof changed ${field}`);
    }
  }
  // `preparation.events` is the selected evidence subset retained in the report. The stored
  // terminal indexes and count refer to the original complete NDJSON stream, so validate their
  // own terminal arithmetic without pretending they index into the selected subset.
  if (!Number.isSafeInteger(storedColdTerminal.readyIndex)
    || !Number.isSafeInteger(storedColdTerminal.doneIndex)
    || !Number.isSafeInteger(storedColdTerminal.eventCount)
    || storedColdTerminal.readyIndex < 0
    || storedColdTerminal.doneIndex !== storedColdTerminal.readyIndex + 1
    || storedColdTerminal.eventCount !== storedColdTerminal.doneIndex + 1
    || preparation.eventCount !== storedColdTerminal.eventCount
    || storedColdTerminal.eventCount < preparation.events.length) {
    throw new TypeError(`PR #${pr.number} cold partial terminal proof has invalid full-stream coordinates`);
  }
  validateStoredColdPreparedPair(
    storedColdTerminal.prepared,
    live,
    coldPrepared,
    `PR #${pr.number} cold terminal prepared pair`,
  );
  if (!Array.isArray(storedColdTerminal.repositoryAnalysisWorkerPidsAfterTerminal)
    || storedColdTerminal.repositoryAnalysisWorkerPidsAfterTerminal.length !== 0) {
    throw new TypeError(`PR #${pr.number} cold terminal retained a repository-analysis worker`);
  }
  const ready = preparation.events.find((event) => event?.payload?.stage === "ready")?.payload;
  const done = preparation.events.find((event) => event?.payload?.stage === "done")?.payload;
  const handoff = validatePreparationHandoff(live, ready, done);
  assertDerivedEvidence(
    handoff,
    record(preparation.handoff, `PR #${pr.number} cold progressive handoff`),
    `PR #${pr.number} cold progressive handoff`,
  );
  const milestones = deriveColdPreparationMilestones(preparation.events, coldPrepared);
  assertDerivedEvidence(
    milestones,
    record(preparation.milestones, `PR #${pr.number} cold progressive milestones`),
    `PR #${pr.number} cold progressive milestones`,
  );
  if (preparation.httpStatus !== 200
    || preparation.cache !== "miss"
    || !Number.isSafeInteger(preparation.eventCount)
    || preparation.eventCount < preparation.events.length
    || !finiteNumber(preparation.totalMs)
    || preparation.totalMs < milestones.finalPairReadyMs
    || preparation.completionSubscriber !== "complete-ndjson-drain-to-partial-eof") {
    throw new TypeError(`PR #${pr.number} cold progressive preparation provenance is incomplete`);
  }

  const analyzeTerminals = Array.isArray(sample.analyzeTerminals) ? sample.analyzeTerminals : [];
  if (analyzeTerminals.length !== 1) {
    throw new TypeError(`PR #${pr.number} cold progressive has no exact partial revalidation terminal`);
  }
  const analyzedRevision = validatePartialAnalyzeTerminal(live, coldPrepared, analyzeTerminals[0]);
  const exactRevision = assertObservedSemanticRevision(
    sample.exactRevision,
    coldPrepared,
    `PR #${pr.number} cold progressive exact revision`,
  );
  for (const field of [
    "graphId",
    "comparisonGraphId",
    "headSha",
    "baseSha",
    "mergeBaseSha",
    "preparedBaseSha",
    "baseTipDrift",
  ]) {
    if (exactRevision[field] !== analyzedRevision[field]) {
      throw new TypeError(
        `PR #${pr.number} cold progressive exact revision contradicts analyze terminal ${field}`,
      );
    }
  }
  assertAuthoritativeGraphNetwork(
    sample.networkAtAction,
    `PR #${pr.number} cold progressive networkAtAction`,
    "/api/graph/project",
  );
  assertAuthoritativeGraphNetwork(
    sample.networkSettled,
    `PR #${pr.number} cold progressive networkSettled`,
    "/api/graph/project",
  );
  assertPartialOnlyGraphIdentity(
    sample,
    pr.number,
    "progressive",
    coldPrepared,
    "isolated cold sample",
  );
  assertColdMemory(pr.number, "progressive", sample);
  const timings = record(sample.timings, `PR #${pr.number} cold progressive timings`);
  for (const field of [
    "landingShellActionableMs",
    "landingShellTtaMs",
    "provisionalReadyMs",
    "provisionalReadyTtaMs",
    "navigationStartedMs",
    "browserFirstActionableMs",
    "browserSettledMs",
    "prepareToFirstActionableMs",
    "prepareToSettledMs",
    "endToEndFirstActionableMs",
    "endToEndSettledMs",
  ]) {
    finiteNonNegative(timings[field], `PR #${pr.number} cold progressive ${field}`);
  }
  if (timings.browserFirstActionableMs > timings.browserSettledMs
    || timings.prepareToFirstActionableMs > timings.prepareToSettledMs
    || timings.endToEndFirstActionableMs > timings.endToEndSettledMs
    || Math.abs(timings.prepareToFirstActionableMs
      - (timings.navigationStartedMs + timings.browserFirstActionableMs)) > 0.2
    || Math.abs(timings.prepareToSettledMs
      - (timings.navigationStartedMs + timings.browserSettledMs)) > 0.2) {
    throw new TypeError(`PR #${pr.number} cold progressive timing decomposition is invalid`);
  }
  if (timings.provisionalReadyMs !== milestones.provisionalReadyMs
    || timings.navigationStartedMs < milestones.provisionalReadyMs) {
    throw new TypeError(`PR #${pr.number} cold progressive navigation did not follow local readiness`);
  }
  assertColdLandingShell(
    pr.number,
    "progressive",
    sample,
    coldPrepared,
    preparation,
    milestones,
    repository,
  );
  if (sample.firstActionableMark?.name !== "meridian:first-actionable-canvas"
    || sample.firstActionableMark?.source !== "performance-mark"
    || !finiteNumber(sample.firstActionableMark?.startTimeMs)
    || Math.abs(sample.firstActionableMark.startTimeMs - timings.browserFirstActionableMs) > 0.1) {
    throw new TypeError(`PR #${pr.number} cold progressive has no authoritative first-actionable mark`);
  }
  validatePartialOnlyContinuationProof(
    sample.partialOnlyContinuation,
    `PR #${pr.number} cold progressive continuation proof`,
    coldPrepared.pairId,
    PARTIAL_RUNTIME_ONLY_DELIVERY_CONTRACT,
  );
  const actionScene = canonicalScene(sample.sceneAtAction, `PR #${pr.number} cold progressive sceneAtAction`);
  const settledScene = canonicalScene(sample.sceneSettled, `PR #${pr.number} cold progressive sceneSettled`);
  if (actionScene.nodeIds.length === 0 || settledScene.nodeIds.length === 0) {
    throw new TypeError(`PR #${pr.number} cold progressive canvas is not actionable`);
  }
  return { ...cold, variants: { progressive: sample } };
}

function validateStoredColdPreparedPair(raw, live, expected, name) {
  const value = record(raw, name);
  const pair = validateProvisionalPair(live, value, name);
  const viewUrl = validateProvisionalViewUrl(live, pair, value.viewUrl, name);
  const normalized = { ...pair, viewUrl };
  for (const field of [
    "graphId",
    "comparisonGraphId",
    "headSha",
    "baseSha",
    "mergeBaseSha",
    "pairId",
    "completeness",
    "viewUrl",
    "cache",
  ]) {
    if (normalized[field] !== expected[field]) {
      throw new TypeError(`${name} changed local ${field}`);
    }
  }
  for (const field of ["initialProjectionCache", "counts", "changedFiles"]) {
    if (JSON.stringify(normalized[field]) !== JSON.stringify(expected[field])) {
      throw new TypeError(`${name} changed local ${field}`);
    }
  }
  return normalized;
}

function assertPreservedReviewSurface(prNumber, fullSamples, progressiveSamples) {
  for (let index = 0; index < fullSamples.length; index += 1) {
    for (const stage of ["sceneAtAction", "sceneSettled"]) {
      const full = canonicalScene(fullSamples[index]?.[stage], `PR #${prNumber} full ${stage}`);
      const partial = canonicalScene(progressiveSamples[index]?.[stage], `PR #${prNumber} progressive ${stage}`);
      if (JSON.stringify(full.reviewFiles) !== JSON.stringify(partial.reviewFiles)) {
        throw new TypeError(`PR #${prNumber} ${stage} changed-file review surface differs`);
      }
      if (partial.nodeIds.length === 0) {
        throw new TypeError(`PR #${prNumber} ${stage} partial canvas is not actionable`);
      }
    }
  }
}

function validatePartialOnlyFunctionalityRecordings(pr, config, partial, canonical) {
  const raw = record(pr.recordings, `PR #${pr.number} functionality recordings`);
  const normalized = {};
  for (const variant of ["full", "progressive"]) {
    const recording = record(raw[variant], `PR #${pr.number} ${variant} functionality recording`);
    validateRelativeEvidencePath(recording.relativePath, `${variant} functionality recording path`);
    validateRecordingEvidence(recording, pr.number, `${variant} functionality`, config);
    assertObservedSemanticRevision(
      recording.exactRevision,
      variant === "progressive" ? partial : canonical,
      `PR #${pr.number} ${variant} functionality exact revision`,
    );
    const interaction = record(recording.interaction, `PR #${pr.number} ${variant} interaction`);
    if (interaction.searchHydrated !== true
      || !Number.isSafeInteger(interaction.canvasNodesBeforeSearch)
      || !Number.isSafeInteger(interaction.canvasNodesAfterSearch)
      || interaction.canvasNodesAfterSearch <= interaction.canvasNodesBeforeSearch) {
      throw new TypeError(`PR #${pr.number} ${variant} recording did not prove search hydration`);
    }
    if (variant === "progressive" && (interaction.depthAdjusted !== true
      || interaction.disconnectedBeforeSearch !== true)) {
      throw new TypeError(`PR #${pr.number} progressive recording did not prove depth and ghost/search hydration`);
    }
    normalized[variant] = recording;
  }
  validateRecordingInteractions(normalized, pr.number, partial, canonical);
  return normalized;
}

function validatePartialOnlyStartupRecordings(pr, config, partial, canonical, stream) {
  const raw = record(pr.startupRecordings, `PR #${pr.number} startup recordings`);
  const normalized = {};
  for (const variant of ["full", "progressive"]) {
    const recording = record(raw[variant], `PR #${pr.number} ${variant} startup recording`);
    validateRelativeEvidencePath(recording.relativePath, `${variant} startup recording path`);
    validateRecordingEvidence(recording, pr.number, `${variant} startup`, config);
    assertObservedSemanticRevision(
      recording.exactRevision,
      variant === "progressive" ? partial : canonical,
      `PR #${pr.number} ${variant} startup exact revision`,
    );
    if (recording.navigation?.source !== "playwright-main-document-request") {
      throw new TypeError(`PR #${pr.number} ${variant} startup has no real document navigation proof`);
    }
    const expected = variant === "progressive" ? partial : canonical;
    if (relativeViewUrl(recording.navigation?.viewUrl) !== relativeViewUrl(expected.viewUrl)) {
      throw new TypeError(`PR #${pr.number} ${variant} startup navigated to the wrong exact revision`);
    }
    const terminal = record(
      recording.terminalProof,
      `PR #${pr.number} ${variant} startup terminal proof`,
    );
    if (terminal.pairId !== stream.pairId
      || terminal.streamEnded !== true
      || terminal.sameBoundedPair !== true
      || terminal.canonicalContinuationObserved !== false
      || JSON.stringify(terminal.postReadyStages) !== JSON.stringify(["done"])) {
      throw new TypeError(`PR #${pr.number} ${variant} startup has no exact ready/done/EOF terminal proof`);
    }
    if (variant === "progressive") {
      validatePartialOnlyContinuationProof(
        recording.continuationProof,
        `PR #${pr.number} progressive startup continuation proof`,
        stream.pairId,
      );
      if (recording.flow !== "partial-ready-terminal-then-navigation"
        || terminal.pairId !== stream.pairId
        || terminal.streamEnded !== true
        || terminal.sameBoundedPair !== true
        || terminal.canonicalContinuationObserved !== false
        || JSON.stringify(terminal.postReadyStages) !== JSON.stringify(["done"])) {
        throw new TypeError(`PR #${pr.number} progressive startup recording does not prove partial-only navigation`);
      }
    } else if (recording.flow !== "canonical-baseline-done-then-navigation"
      || recording.canonicalBaselinePreparation?.progressive !== false
      || recording.canonicalBaselinePreparation?.httpStatus !== 200
      || recording.canonicalBaselinePreparation?.terminal?.stage !== "done"
      || recording.canonicalBaselinePreparation?.terminal?.completeness !== undefined
      || recording.canonicalBaselinePreparation?.terminal?.graphId !== canonical.graphId
      || recording.canonicalBaselinePreparation?.terminal?.comparisonGraphId !== canonical.comparisonGraphId
      || recording.canonicalBaselinePreparation?.terminal?.headSha !== canonical.headSha
      || recording.canonicalBaselinePreparation?.terminal?.mergeBaseSha !== canonical.mergeBaseSha) {
      throw new TypeError(`PR #${pr.number} full startup recording is not the explicit compatibility baseline`);
    }
    validatePartialOnlyStartupTiming(recording, pr.number, variant);
    normalized[variant] = recording;
  }
  return normalized;
}

function validatePartialOnlyStartupTiming(recording, prNumber, variant) {
  const timings = record(recording.timings, `PR #${prNumber} ${variant} startup timings`);
  const ready = finiteNonNegative(
    timings.provisionalReadyObservedMs,
    `PR #${prNumber} ${variant} startup ready time`,
  );
  const partialDone = finiteNonNegative(
    timings.partialTerminalDoneMs,
    `PR #${prNumber} ${variant} startup partial terminal time`,
  );
  const navigation = finiteNonNegative(
    timings.navigationStartedMs,
    `PR #${prNumber} ${variant} startup navigation time`,
  );
  finiteNonNegative(
    timings.firstActionableBrowserMs,
    `PR #${prNumber} ${variant} startup first-actionable time`,
  );
  if (recording.navigation?.startedMs !== navigation || ready > partialDone || partialDone > navigation) {
    throw new TypeError(`PR #${prNumber} ${variant} startup timing does not prove terminal-before-navigation`);
  }
  if (variant === "progressive") {
    if (timings.canonicalBaselineDoneMs !== null) {
      throw new TypeError(`PR #${prNumber} progressive startup unexpectedly measured canonical completion`);
    }
    return;
  }
  const canonicalDone = finiteNonNegative(
    timings.canonicalBaselineDoneMs,
    `PR #${prNumber} full startup canonical baseline time`,
  );
  if (partialDone > canonicalDone || canonicalDone > navigation) {
    throw new TypeError(`PR #${prNumber} full startup timing does not prove canonical-before-navigation`);
  }
}

function validatePartialOnlyColdEvidence(pr, partial, canonical, stream, prIndex) {
  const cold = record(pr.coldEndToEnd, `PR #${pr.number} cold evidence`);
  if (cold.repetitions !== 1
    || cold.isolation !== "fresh-meridian-service-and-cache-per-variant"
    || !Array.isArray(cold.order)
    || cold.order.length !== 2
    || new Set(cold.order).size !== 2
    || !cold.order.includes("full")
      || !cold.order.includes("progressive")) {
    throw new TypeError(`PR #${pr.number} cold evidence is not a fresh counterbalanced pair`);
  }
  const expectedOrder = prIndex % 2 === 0 ? ["full", "progressive"] : ["progressive", "full"];
  if (JSON.stringify(cold.order) !== JSON.stringify(expectedOrder)) {
    throw new TypeError(`PR #${pr.number} cold order contradicts the harness counterbalancing schedule`);
  }
  const variants = record(cold.variants, `PR #${pr.number} cold variants`);
  for (const variant of ["full", "progressive"]) {
    const sample = record(variants[variant], `PR #${pr.number} cold ${variant}`);
    const position = cold.order.indexOf(variant) + 1;
    if (sample.variant !== variant
      || sample.repetition !== 1
      || sample.measurementOrder?.sequencePosition !== position
      || JSON.stringify(sample.measurementOrder?.variants) !== JSON.stringify(cold.order)
      || sample.isolation?.freshCache !== true
      || sample.isolation?.loopbackOnly !== true
      || sample.isolation?.cleanup?.verifiedEmpty !== true
      || sample.isolation?.cleanup?.tempDirectoryRemoved !== true) {
      throw new TypeError(`PR #${pr.number} cold ${variant} did not prove isolated cleanup`);
    }
    positiveInteger(sample.isolation.servicePid, `PR #${pr.number} cold ${variant} service PID`);
    for (const field of ["serviceInstanceId", "cacheInstanceId"]) {
      if (typeof sample.isolation[field] !== "string" || !/^[a-f0-9]{64}$/.test(sample.isolation[field])) {
        throw new TypeError(`PR #${pr.number} cold ${variant} has no opaque ${field}`);
      }
    }
    assertObservedSemanticRevision(
      sample.exactRevision,
      variant === "progressive" ? partial : canonical,
      `PR #${pr.number} cold ${variant} exact revision`,
    );
    const expected = variant === "progressive" ? partial : canonical;
    const path = variant === "progressive" ? "/api/graph/project" : "/api/graph";
    assertAuthoritativeGraphNetwork(sample.networkAtAction, `PR #${pr.number} cold ${variant} networkAtAction`, path);
    assertAuthoritativeGraphNetwork(sample.networkSettled, `PR #${pr.number} cold ${variant} networkSettled`, path);
    assertPartialOnlyGraphIdentity(sample, pr.number, variant, expected, "isolated cold sample");
    assertColdMemory(pr.number, variant, sample);
    if (variant === "progressive") {
      const storedTerminal = record(
        sample.preparation?.terminalProof,
        `PR #${pr.number} cold partial terminal proof`,
      );
      if (storedTerminal.streamEnded !== true
        || storedTerminal.sameBoundedPair !== true
        || storedTerminal.pairId !== stream.pairId) {
        throw new TypeError(`PR #${pr.number} cold progressive lane has no ready/done/EOF proof`);
      }
      const proof = record(sample.partialOnlyContinuation, `PR #${pr.number} cold continuation proof`);
      validatePartialOnlyContinuationProof(
        proof,
        `PR #${pr.number} cold continuation proof`,
        stream.pairId,
      );
    } else {
      const baseline = record(
        sample.canonicalBaselinePreparation,
        `PR #${pr.number} cold canonical baseline preparation`,
      );
      if (baseline.progressive !== false
        || baseline.httpStatus !== 200
        || baseline.terminal?.stage !== "done"
        || baseline.terminal?.completeness !== undefined
        || baseline.terminal?.graphId !== canonical.graphId
        || baseline.terminal?.comparisonGraphId !== canonical.comparisonGraphId) {
        throw new TypeError(`PR #${pr.number} cold full lane is not an explicit progressive:false baseline`);
      }
    }
  }
  if (variants.full.isolation.serviceInstanceId === variants.progressive.isolation.serviceInstanceId
    || variants.full.isolation.cacheInstanceId === variants.progressive.isolation.cacheInstanceId) {
    throw new TypeError(`PR #${pr.number} cold variants reused a service or cache instance`);
  }
  return cold;
}

function normalizeColdEndToEnd(pr, complete, config, prIndex) {
  const raw = pr.coldEndToEnd;
  if (raw === undefined || raw === null) {
    if (complete) throw new TypeError(`PR #${pr.number} has no requested cold end-to-end evidence`);
    return null;
  }
  const cold = record(raw, `PR #${pr.number} cold end-to-end evidence`);
  if (cold.repetitions !== 1 || cold.isolation !== "fresh-meridian-service-and-cache-per-variant") {
    throw new TypeError(`PR #${pr.number} cold evidence has no fresh per-variant service/cache isolation`);
  }
  if (!Array.isArray(cold.order) || cold.order.length !== 2 || new Set(cold.order).size !== 2
    || !cold.order.includes("full") || !cold.order.includes("progressive")) {
    throw new TypeError(`PR #${pr.number} cold evidence has no counterbalanced full/progressive order`);
  }
  const expectedOrder = prIndex % 2 === 0 ? ["full", "progressive"] : ["progressive", "full"];
  if (complete && JSON.stringify(cold.order) !== JSON.stringify(expectedOrder)) {
    throw new TypeError(`PR #${pr.number} cold order contradicts the harness counterbalancing schedule`);
  }
  const variants = record(cold.variants, `PR #${pr.number} cold variants`);
  // Failed/running/diagnostic artifacts must remain renderable as partial evidence. The strict
  // proof below is a publishability gate and is intentionally enforced only for `status=complete`.
  if (!complete) return cold;
  const normalized = {};
  for (const variant of ["full", "progressive"]) {
    normalized[variant] = validateColdSample(
      pr.number,
      variant,
      variants[variant],
      pr.revisions?.prepared,
      cold.order,
      config?.repository,
    );
  }
  if (normalized.full.isolation.cacheInstanceId === normalized.progressive.isolation.cacheInstanceId
    || normalized.full.isolation.serviceInstanceId === normalized.progressive.isolation.serviceInstanceId) {
    throw new TypeError(`PR #${pr.number} cold variants reused a service or cache instance`);
  }
  let settledFullScene = null;
  let settledProgressiveScene = null;
  for (const stage of ["sceneAtAction", "sceneSettled"]) {
    const full = canonicalScene(normalized.full[stage], `PR #${pr.number} cold full ${stage}`);
    const progressive = canonicalScene(normalized.progressive[stage], `PR #${pr.number} cold progressive ${stage}`);
    for (const field of ["nodeIds", "edgeIds", "reviewFiles"]) {
      if (JSON.stringify(full[field]) !== JSON.stringify(progressive[field])) {
        throw new TypeError(`PR #${pr.number} cold ${stage} ${field} parity failed`);
      }
    }
    if (stage === "sceneSettled") {
      settledFullScene = full;
      settledProgressiveScene = progressive;
    }
  }
  const parity = record(cold.parity, `PR #${pr.number} cold parity`);
  if (parity.exact !== true || parity.fields?.nodeIds !== true
    || parity.fields?.edgeIds !== true || parity.fields?.reviewFiles !== true) {
    throw new TypeError(`PR #${pr.number} cold evidence has no exact scene ID-set parity proof`);
  }
  const fullSceneHash = createHash("sha256").update(JSON.stringify(settledFullScene)).digest("hex");
  const progressiveSceneHash = createHash("sha256").update(JSON.stringify(settledProgressiveScene)).digest("hex");
  if (parity.fullSceneHash !== fullSceneHash || parity.progressiveSceneHash !== progressiveSceneHash
    || fullSceneHash !== progressiveSceneHash) {
    throw new TypeError(`PR #${pr.number} cold stored scene hashes contradict measured parity`);
  }
  return { ...cold, variants: normalized };
}

function validateColdSample(prNumber, variant, rawSample, rawWarmPrepared, order, repository) {
  const sample = record(rawSample, `PR #${prNumber} cold ${variant} sample`);
  if (sample.variant !== variant || sample.repetition !== 1) {
    throw new TypeError(`PR #${prNumber} cold ${variant} sample identity is invalid`);
  }
  const position = order.indexOf(variant) + 1;
  if (sample.measurementOrder?.sequencePosition !== position
    || JSON.stringify(sample.measurementOrder?.variants) !== JSON.stringify(order)) {
    throw new TypeError(`PR #${prNumber} cold ${variant} sample order is unproven`);
  }
  const isolation = record(sample.isolation, `PR #${prNumber} cold ${variant} isolation`);
  if (isolation.freshCache !== true || isolation.loopbackOnly !== true) {
    throw new TypeError(`PR #${prNumber} cold ${variant} did not prove fresh loopback isolation`);
  }
  positiveInteger(isolation.servicePid, `PR #${prNumber} cold ${variant} service PID`);
  for (const field of ["serviceInstanceId", "cacheInstanceId"]) {
    if (typeof isolation[field] !== "string" || !/^[a-f0-9]{64}$/.test(isolation[field])) {
      throw new TypeError(`PR #${prNumber} cold ${variant} has no opaque ${field}`);
    }
  }
  validateOwnedProcessTreeCleanup(isolation, `PR #${prNumber} cold ${variant}`);
  const prepared = record(sample.prepared, `PR #${prNumber} cold ${variant} prepared revision`);
  const provisionalPrepared = record(
    sample.provisionalPrepared,
    `PR #${prNumber} cold ${variant} provisional prepared revision`,
  );
  const warmPrepared = record(rawWarmPrepared, `PR #${prNumber} prepared revision`);
  for (const field of ["headSha", "mergeBaseSha"]) {
    const exact = oid(prepared[field], `PR #${prNumber} cold ${variant} ${field}`);
    if (exact !== warmPrepared[field]) {
      throw new TypeError(`PR #${prNumber} cold ${variant} does not match the exact ${field}`);
    }
  }
  oid(prepared.baseSha, `PR #${prNumber} cold ${variant} observed base tip`);
  oid(warmPrepared.baseSha, `PR #${prNumber} prepared observed base tip`);
  for (const field of ["graphId", "comparisonGraphId"]) {
    nonEmptyString(prepared[field], `PR #${prNumber} cold ${variant} ${field}`);
  }
  const preparedInitialCache = validateInitialProjectionCache(
    prepared.initialProjectionCache,
    `PR #${prNumber} cold ${variant} prepared initial projection cache`,
  );
  const preparedViewUrl = new URL(relativeViewUrl(prepared.viewUrl), "http://meridian.local");
  if (preparedViewUrl.searchParams.get("progressive") !== "1"
    || preparedViewUrl.searchParams.get("id") !== prepared.graphId) {
    throw new TypeError(`PR #${prNumber} cold ${variant} prepared URL does not preserve progressive readiness`);
  }
  if (prepared.cache !== "miss") throw new TypeError(`PR #${prNumber} cold ${variant} was not a cache miss`);

  const preparation = record(sample.preparation, `PR #${prNumber} cold ${variant} preparation`);
  if (!Array.isArray(preparation.events)) throw new TypeError(`PR #${prNumber} cold ${variant} has no preparation events`);
  if (!Number.isSafeInteger(preparation.eventCount)
    || preparation.eventCount < preparation.events.length
    || preparation.events.length !== 10) {
    throw new TypeError(`PR #${prNumber} cold ${variant} has no bounded preparation event provenance`);
  }
  if (preparation.httpStatus !== 200 || preparation.cache !== "miss") {
    throw new TypeError(`PR #${prNumber} cold ${variant} preparation is not a successful cache miss`);
  }
  const milestones = deriveColdPreparationMilestones(preparation.events, prepared);
  const preparationTerminal = preparation.events.at(-1)?.payload;
  if (preparationTerminal?.preparedPair?.prNumber !== prNumber) {
    throw new TypeError(`PR #${prNumber} cold ${variant} final pair has the wrong PR number`);
  }
  const terminalInitialCache = validateInitialProjectionCache(
    preparationTerminal?.initialProjectionCache,
    `PR #${prNumber} cold ${variant} terminal initial projection cache`,
  );
  if (JSON.stringify(terminalInitialCache) !== JSON.stringify(preparedInitialCache)
    || relativeViewUrl(preparationTerminal?.viewUrl) !== relativeViewUrl(prepared.viewUrl)) {
    throw new TypeError(`PR #${prNumber} cold ${variant} terminal initial projection readiness is inconsistent`);
  }
  const readyEvent = preparation.events.find((event) => event?.payload?.stage === "ready")?.payload;
  const provisional = validateProvisionalReady(
    { number: prNumber, headOid: prepared.headSha },
    readyEvent,
  );
  const handoff = validatePreparationHandoff(
    { number: prNumber, headOid: prepared.headSha },
    readyEvent,
    preparationTerminal,
  );
  assertDerivedEvidence(
    handoff,
    record(preparation.handoff, `PR #${prNumber} cold ${variant} handoff`),
    `PR #${prNumber} cold ${variant} handoff`,
  );
  if (preparation.completionSubscriber !== "independent-ndjson-drain") {
    throw new TypeError(`PR #${prNumber} cold ${variant} has no independent canonical completion subscriber`);
  }
  for (const field of [
    "graphId",
    "comparisonGraphId",
    "headSha",
    "baseSha",
    "mergeBaseSha",
    "pairId",
    "completeness",
    "viewUrl",
    "cache",
  ]) {
    if (provisionalPrepared[field] !== provisional[field]) {
      throw new TypeError(`PR #${prNumber} cold ${variant} stored provisional ${field} is inconsistent`);
    }
  }
  if (JSON.stringify(validateInitialProjectionCache(
    provisionalPrepared.initialProjectionCache,
    `PR #${prNumber} cold ${variant} provisional initial projection cache`,
  )) !== JSON.stringify(provisional.initialProjectionCache)) {
    throw new TypeError(`PR #${prNumber} cold ${variant} stored provisional cache is inconsistent`);
  }
  assertDerivedEvidence(
    milestones,
    record(preparation.milestones, `PR #${prNumber} cold ${variant} milestones`),
    `PR #${prNumber} cold ${variant} milestones`,
  );
  if (!finiteNumber(preparation.totalMs) || preparation.totalMs < milestones.finalPairReadyMs) {
    throw new TypeError(`PR #${prNumber} cold ${variant} preparation duration is invalid`);
  }

  const timings = record(sample.timings, `PR #${prNumber} cold ${variant} timings`);
  for (const field of [
    "landingShellActionableMs",
    "landingShellTtaMs",
    "provisionalReadyMs",
    "provisionalReadyTtaMs",
    "navigationStartedMs",
    "browserFirstActionableMs",
    "browserSettledMs",
    "prepareToFirstActionableMs",
    "prepareToSettledMs",
    "endToEndFirstActionableMs",
    "endToEndSettledMs",
  ]) {
    if (!finiteNumber(timings[field]) || timings[field] < 0) {
      throw new TypeError(`PR #${prNumber} cold ${variant} has no finite ${field}`);
    }
  }
  if ((variant === "full" && timings.navigationStartedMs < milestones.finalPairReadyMs)
    || (variant === "progressive" && (
      timings.navigationStartedMs < milestones.provisionalReadyMs
      || timings.navigationStartedMs >= milestones.finalPairReadyMs
    ))
    || timings.provisionalReadyMs !== milestones.provisionalReadyMs
    || Math.abs(timings.provisionalReadyTtaMs - sample.landingShell?.readyTtaMs) > 0.1
    || timings.landingShellActionableMs > timings.navigationStartedMs
    || timings.browserFirstActionableMs > timings.browserSettledMs
    || timings.prepareToFirstActionableMs > timings.prepareToSettledMs
    || timings.endToEndFirstActionableMs > timings.endToEndSettledMs
    || Math.abs(timings.prepareToFirstActionableMs
      - (timings.navigationStartedMs + timings.browserFirstActionableMs)) > 0.2
    || Math.abs(timings.prepareToSettledMs
      - (timings.navigationStartedMs + timings.browserSettledMs)) > 0.2
    || Math.abs(timings.prepareToFirstActionableMs - timings.endToEndFirstActionableMs) > 0.1
    || Math.abs(timings.prepareToSettledMs - timings.endToEndSettledMs) > 0.1
    || Math.abs(timings.endToEndFirstActionableMs
      - (timings.navigationStartedMs + timings.browserFirstActionableMs)) > 0.2
    || Math.abs(timings.endToEndSettledMs - (timings.navigationStartedMs + timings.browserSettledMs)) > 0.2) {
    throw new TypeError(`PR #${prNumber} cold ${variant} end-to-end timing decomposition is invalid`);
  }
  assertColdLandingShell(prNumber, variant, sample, prepared, preparation, milestones, repository);
  if (sample.firstActionableMark?.name !== "meridian:first-actionable-canvas"
    || sample.firstActionableMark?.source !== "performance-mark"
    || !finiteNumber(sample.firstActionableMark?.startTimeMs)
    || Math.abs(sample.firstActionableMark.startTimeMs - timings.browserFirstActionableMs) > 0.1) {
    throw new TypeError(`PR #${prNumber} cold ${variant} has no authoritative first-actionable mark`);
  }

  assertColdMemory(prNumber, variant, sample);
  assertObservedSemanticRevision(
    sample.exactRevision,
    prepared,
    `PR #${prNumber} cold ${variant} exact revision`,
  );
  if (variant === "progressive") {
    const reconciliation = record(
      sample.reconciliation,
      `PR #${prNumber} cold progressive reconciliation`,
    );
    const recomputed = validateCanonicalReconciliation(
      provisional,
      prepared,
      [preparationTerminal],
      [reconciliation.mark],
    );
    assertDerivedEvidence(
      recomputed,
      reconciliation,
      `PR #${prNumber} cold progressive reconciliation`,
    );
    if (!finiteNumber(timings.canonicalReconciledMs)
      || timings.canonicalReconciledMs !== reconciliation.mark.startTimeMs
      || timings.canonicalReconciledMs < timings.browserFirstActionableMs) {
      throw new TypeError(`PR #${prNumber} cold progressive reconciliation timing is invalid`);
    }
  } else if (sample.reconciliation !== null || timings.canonicalReconciledMs !== null) {
    throw new TypeError(`PR #${prNumber} cold full baseline unexpectedly claims progressive reconciliation`);
  }
  const byPath = record(sample.networkSettled?.byPath, `PR #${prNumber} cold ${variant} network paths`);
  const expectedGraphPath = variant === "full" ? "/api/graph" : "/api/graph/project";
  assertAuthoritativeGraphNetwork(
    sample.networkAtAction,
    `PR #${prNumber} cold ${variant} networkAtAction`,
    expectedGraphPath,
  );
  assertAuthoritativeGraphNetwork(
    sample.networkSettled,
    `PR #${prNumber} cold ${variant} networkSettled`,
    expectedGraphPath,
  );
  if (!finiteNumber(sample.networkAtAction?.graphEncodedBytes)
    || sample.networkAtAction.graphEncodedBytes <= 0
    || !finiteNumber(sample.networkSettled?.graphEncodedBytes)
    || sample.networkSettled.graphEncodedBytes <= 0) {
    throw new TypeError(`PR #${prNumber} cold ${variant} has no positive graph transfer evidence`);
  }
  const fullRequests = byPath["/api/graph"]?.requests ?? 0;
  const projectionRequests = byPath["/api/graph/project"]?.requests ?? 0;
  if (variant === "full") {
    if (fullRequests < 1 || projectionRequests !== 0 || (sample.projections?.length ?? 0) !== 0) {
      throw new TypeError(`PR #${prNumber} cold full sample did not use only the canonical graph route`);
    }
    assertExactFullGraphEvidence(sample.graphs, prepared, `PR #${prNumber} cold full sample`);
    if (!Array.isArray(sample.initialProjectionCacheHits) || sample.initialProjectionCacheHits.length !== 0) {
      throw new TypeError(`PR #${prNumber} cold full sample consumed progressive initial projections`);
    }
  } else {
    const projections = Array.isArray(sample.projections) ? sample.projections : [];
    const ids = new Set(projections.map((projection) => projection?.graphId));
    if (fullRequests !== 0 || projectionRequests < 2
      || !ids.has(prepared.graphId) || !ids.has(prepared.comparisonGraphId)) {
      throw new TypeError(`PR #${prNumber} cold progressive sample did not load both exact projections`);
    }
    if (!Array.isArray(sample.graphs) || sample.graphs.length !== 0) {
      throw new TypeError(`PR #${prNumber} cold progressive sample loaded a canonical full graph`);
    }
    const initialHits = Array.isArray(sample.initialProjectionCacheHits)
      ? sample.initialProjectionCacheHits
      : [];
    for (const pair of [provisional, prepared]) {
      const pairIds = new Set([pair.graphId, pair.comparisonGraphId]);
      assertInitialProjectionCacheHitEvidence(
        initialHits.filter((hit) => pairIds.has(hit?.graphId)),
        pair,
        `PR #${prNumber} cold progressive ${pair === provisional ? "provisional" : "canonical"} sample`,
      );
    }
  }
  canonicalScene(sample.sceneAtAction, `PR #${prNumber} cold ${variant} sceneAtAction`);
  canonicalScene(sample.sceneSettled, `PR #${prNumber} cold ${variant} sceneSettled`);
  return sample;
}

function assertColdLandingShell(prNumber, variant, sample, prepared, preparation, milestones, repository) {
  const shell = record(sample.landingShell, `PR #${prNumber} cold ${variant} landing shell`);
  const provisional = record(
    sample.provisionalPrepared,
    `PR #${prNumber} cold ${variant} landing provisional pair`,
  );
  const timings = sample.timings;
  const clockAlignment = record(
    shell.clockAlignment,
    `PR #${prNumber} cold ${variant} landing clock alignment`,
  );
  const before = record(
    clockAlignment.before,
    `PR #${prNumber} cold ${variant} landing before-clock phase`,
  );
  const after = record(
    clockAlignment.after,
    `PR #${prNumber} cold ${variant} landing after-clock phase`,
  );
  const recomputedAlignment = alignLandingManifestClock(
    record(clockAlignment.browserMark, `PR #${prNumber} cold ${variant} landing browser mark`),
    {
      beforeSamples: before.samples,
      afterSamples: after.samples,
      nodeColdStartedMs: clockAlignment.nodeColdStartedMs,
      requestBracket: clockAlignment.requestBracket,
    },
  );
  assertDerivedEvidence(
    recomputedAlignment.clockAlignment,
    clockAlignment,
    `PR #${prNumber} cold ${variant} landing clock alignment`,
  );
  const performanceEntry = record(
    shell.performanceEntry,
    `PR #${prNumber} cold ${variant} landing performance entry`,
  );
  const performanceDetail = record(
    performanceEntry.detail,
    `PR #${prNumber} cold ${variant} landing performance detail`,
  );
  if (shell.source !== "application-performance-mark-and-visible-dom"
    || shell.markName !== "meridian:pr-manifest-shell-actionable"
    || performanceEntry.name !== shell.markName
    || performanceEntry.startTimeMs !== clockAlignment.browserMark.atMs
    || performanceDetail.atMs !== clockAlignment.browserMark.atMs
    || performanceDetail.requestStartedAtMs !== clockAlignment.browserMark.requestStartedAtMs
    || performanceDetail.ttaMs !== clockAlignment.browserMark.ttaMs
    || performanceDetail.changedFileCount !== shell.changedFileCount
    || performanceDetail.headSha !== shell.headSha
    || performanceDetail.baseSha !== shell.baseSha
    || performanceDetail.mergeBaseSha !== shell.mergeBaseSha
    || shell.visible !== true
    || !finiteNumber(shell.requestStartedMs)
    || shell.requestStartedMs < 0
    || !finiteNumber(shell.actionableMs)
    || !finiteNumber(shell.ttaMs)
    || !finiteNumber(shell.readyAtBrowserMs)
    || !finiteNumber(shell.readyTtaMs)
    || shell.readyAtBrowserMs < clockAlignment.browserMark.requestStartedAtMs
    || Math.abs(shell.readyTtaMs
      - (shell.readyAtBrowserMs - clockAlignment.browserMark.requestStartedAtMs)) > 0.1
    || !Object.is(shell.requestStartedMs, roundEvidenceMs(recomputedAlignment.requestStartedMs))
    || !Object.is(shell.actionableMs, roundEvidenceMs(recomputedAlignment.actionableMs))
    || !Object.is(shell.ttaMs, roundEvidenceMs(recomputedAlignment.ttaMs))
    || clockAlignment.causalAction.upperBoundMs > timings.navigationStartedMs
    || Math.abs(shell.actionableMs - timings.landingShellActionableMs) > 0.1
    || Math.abs(shell.ttaMs - timings.landingShellTtaMs) > 0.1
    || Math.abs(shell.ttaMs - (shell.actionableMs - shell.requestStartedMs)) > 0.2) {
    throw new TypeError(`PR #${prNumber} cold ${variant} has no authoritative landing-shell timing proof`);
  }
  for (const field of ["headSha", "baseSha", "mergeBaseSha"]) {
    if (shell[field] !== prepared[field] || shell.terminal?.[field] !== provisional[field]) {
      throw new TypeError(`PR #${prNumber} cold ${variant} landing shell contradicts exact ${field}`);
    }
  }
  for (const field of ["graphId", "comparisonGraphId", "pairId", "completeness"]) {
    if (shell.terminal?.[field] !== provisional[field]) {
      throw new TypeError(`PR #${prNumber} cold ${variant} landing provisional terminal contradicts exact ${field}`);
    }
  }
  if (shell.terminal?.cache !== "miss" || shell.terminal?.viewUrl !== provisional.viewUrl) {
    throw new TypeError(`PR #${prNumber} cold ${variant} landing terminal is not the exact provisional cache-miss pair`);
  }
  const landingInitialCache = validateInitialProjectionCache(
    shell.terminal?.initialProjectionCache,
    `PR #${prNumber} cold ${variant} landing initial projection cache`,
  );
  if (JSON.stringify(landingInitialCache) !== JSON.stringify(provisional.initialProjectionCache)) {
    throw new TypeError(`PR #${prNumber} cold ${variant} landing terminal contradicts provisional projection readiness`);
  }
  const manifest = preparation.events.find((event) => event?.payload?.stage === "manifest-ready")?.payload;
  const changedFiles = Array.isArray(manifest?.changedFiles) ? manifest.changedFiles : null;
  if (changedFiles === null
    || shell.changedFileCount !== milestones.manifestFileCount
    || shell.visibleChangedFileRows !== milestones.manifestFileCount
    || shell.renderedManifestSha256 !== milestones.manifestSha256
    || !Array.isArray(shell.rows)
    || shell.rows.length !== changedFiles.length) {
    throw new TypeError(`PR #${prNumber} cold ${variant} landing shell does not bind the exact manifest`);
  }
  const repo = nonEmptyString(repository, "publishable repository");
  for (let index = 0; index < changedFiles.length; index += 1) {
    const file = changedFiles[index];
    const row = shell.rows[index];
    const expectedLabel = file.status === "renamed" ? `${file.previousPath} → ${file.path}` : file.path;
    const sourceSha = file.status === "deleted" ? prepared.mergeBaseSha : prepared.headSha;
    const sourceHref = `https://github.com/${repo}/blob/${sourceSha}/${file.path
      .split("/").map(encodeURIComponent).join("/")}`;
    if (row?.status !== file.status || row?.label !== expectedLabel || row?.sourceHref !== sourceHref) {
      throw new TypeError(`PR #${prNumber} cold ${variant} landing row ${index + 1} contradicts the streamed manifest`);
    }
  }
}

function assertColdMemory(prNumber, variant, sample) {
  const values = {
    browserHeapPeak: sample.memoryPeak?.browserJsHeapUsedBytes,
    browserHeapRetained: sample.memorySettled?.browserJsHeapUsedBytes,
    browserRssPeak: sample.memoryPeak?.browserProcessRssBytes,
    browserRssRetained: sample.memorySettled?.browserProcessRssBytes,
    serviceRssPeak: sample.coldServiceMemory?.peakRssBytes,
    serviceRssRetained: sample.coldServiceMemory?.retainedRssBytes,
    workerRssPeak: sample.coldServiceMemory?.workerPeakRssBytes,
    workerRssRetained: sample.coldServiceMemory?.workerRetainedRssBytes,
  };
  for (const [name, value] of Object.entries(values)) {
    if (!finiteNumber(value) || value < 0) throw new TypeError(`PR #${prNumber} cold ${variant} has no finite ${name}`);
  }
  for (const [peak, retained] of [
    [values.browserHeapPeak, values.browserHeapRetained],
    [values.browserRssPeak, values.browserRssRetained],
    [values.serviceRssPeak, values.serviceRssRetained],
    [values.workerRssPeak, values.workerRssRetained],
  ]) {
    if (peak < retained) throw new TypeError(`PR #${prNumber} cold ${variant} retained memory exceeds peak`);
  }
  if (sample.coldServiceMemory?.diagnostic === true
    || !Number.isSafeInteger(sample.coldServiceMemory?.sampleCount)
    || sample.coldServiceMemory.sampleCount <= 0
    || sample.coldServiceMemory.intervalMs !== 500
    || sample.coldServiceMemory.browserPhaseIntervalMs !== 100
    || !Number.isSafeInteger(sample.coldServiceMemory.preparationAndEndToEndSampleCount)
    || sample.coldServiceMemory.preparationAndEndToEndSampleCount <= 0
    || !Number.isSafeInteger(sample.coldServiceMemory.browserPhaseSampleCount)
    || sample.coldServiceMemory.browserPhaseSampleCount <= 0
    || sample.coldServiceMemory.sampleCount
      !== sample.coldServiceMemory.preparationAndEndToEndSampleCount
        + sample.coldServiceMemory.browserPhaseSampleCount
    || sample.coldServiceMemory.workerScope !== "all-owned-analysis-and-projection-descendants"
    || sample.coldServiceMemory.browserPhaseWorkerScope !== "owned-projection-workers"
    || sample.coldServiceMemory.peakAggregation
      !== "max-of-500ms-lifecycle-and-100ms-review-browser-phase"
    || sample.coldServiceMemory.retainedSource
      !== "500ms-lifecycle-final-snapshot-after-review-settled") {
    throw new TypeError(`PR #${prNumber} cold ${variant} has no sampled service/worker memory provenance`);
  }
  for (const field of [
    "lifecyclePeakRssBytes",
    "lifecycleWorkerPeakRssBytes",
    "browserPhasePeakRssBytes",
    "browserPhaseWorkerPeakRssBytes",
  ]) {
    if (!finiteNumber(sample.coldServiceMemory[field]) || sample.coldServiceMemory[field] < 0) {
      throw new TypeError(`PR #${prNumber} cold ${variant} has no finite ${field}`);
    }
  }
  if (sample.coldServiceMemory.peakRssBytes !== Math.max(
    sample.coldServiceMemory.lifecyclePeakRssBytes,
    sample.coldServiceMemory.browserPhasePeakRssBytes,
  ) || sample.coldServiceMemory.workerPeakRssBytes !== Math.max(
    sample.coldServiceMemory.lifecycleWorkerPeakRssBytes,
    sample.coldServiceMemory.browserPhaseWorkerPeakRssBytes,
  )) {
    throw new TypeError(`PR #${prNumber} cold ${variant} merged peak memory contradicts sampler provenance`);
  }
}

function normalizeRecordings(pr, complete, config) {
  const rawRecordings = pr.recordings === undefined || pr.recordings === null
    ? (pr.recording === undefined || pr.recording === null ? {} : { progressive: pr.recording })
    : record(pr.recordings, `POC PR #${pr.number} recordings`);
  const normalized = {};
  for (const variant of ["full", "progressive"]) {
    const raw = rawRecordings[variant];
    if (raw === undefined || raw === null) {
      if (complete) throw new TypeError(`complete POC result for PR #${pr.number} has no ${variant} recording`);
      continue;
    }
    const recording = record(raw, `POC PR #${pr.number} ${variant} recording`);
    validateRelativeEvidencePath(recording.relativePath, `${variant} recording relativePath`);
    if (complete) validateRecordingEvidence(recording, pr.number, variant, config);
    normalized[variant] = recording;
  }
  if (complete) validateRecordingInteractions(normalized, pr.number, pr.revisions?.prepared);
  return normalized;
}

function normalizeHandoffRecordings(pr, complete, config) {
  const raw = pr.handoffRecordings === undefined || pr.handoffRecordings === null
    ? {}
    : record(pr.handoffRecordings, `POC PR #${pr.number} cold handoff recordings`);
  const normalized = {};
  for (const variant of ["full", "progressive"]) {
    const value = raw[variant];
    if (value === undefined || value === null) {
      if (complete) {
        throw new TypeError(`complete POC result for PR #${pr.number} has no ${variant} cold handoff recording`);
      }
      continue;
    }
    const recording = record(value, `POC PR #${pr.number} ${variant} cold handoff recording`);
    validateRelativeEvidencePath(recording.relativePath, `${variant} cold handoff recording relativePath`);
    if (complete) validateHandoffRecordingEvidence(recording, pr.number, variant, config, pr.revisions?.prepared);
    normalized[variant] = recording;
  }
  return normalized;
}

function validateHandoffRecordingEvidence(recording, prNumber, variant, config, rawPrepared) {
  validateRecordingEvidence(recording, prNumber, `${variant} cold handoff`, config);
  const prepared = record(rawPrepared, `PR #${prNumber} prepared cold handoff revision`);
  const exactRevision = record(
    recording.exactRevision,
    `PR #${prNumber} ${variant} cold handoff recording exact revision`,
  );
  for (const field of ["headSha", "mergeBaseSha"]) {
    if (oid(exactRevision[field], `PR #${prNumber} ${variant} recorded ${field}`) !== prepared[field]) {
      throw new TypeError(`PR #${prNumber} ${variant} cold handoff recording changed exact ${field}`);
    }
  }
  const recordedBase = oid(exactRevision.baseSha, `PR #${prNumber} ${variant} recorded base tip`);
  const preparedBase = oid(prepared.baseSha, `PR #${prNumber} prepared base tip`);
  if (exactRevision.preparedBaseSha !== preparedBase
    || exactRevision.baseTipDrift !== (recordedBase !== preparedBase)) {
    throw new TypeError(`PR #${prNumber} ${variant} cold handoff recording has invalid base-tip provenance`);
  }
  const handoff = record(recording.handoff, `PR #${prNumber} ${variant} cold handoff binding`);
  const provisional = record(handoff.provisional, `PR #${prNumber} ${variant} recorded provisional pair`);
  const canonical = record(handoff.canonical, `PR #${prNumber} ${variant} recorded canonical pair`);
  if (handoff.version !== 1
    || handoff.exactRevisionBound !== true
    || typeof handoff.pairId !== "string"
    || !/^[a-f0-9]{20}$/.test(handoff.pairId)
    || canonical.graphId !== exactRevision.graphId
    || canonical.comparisonGraphId !== exactRevision.comparisonGraphId
    || provisional.graphId === canonical.graphId
    || provisional.comparisonGraphId === canonical.comparisonGraphId) {
    throw new TypeError(`PR #${prNumber} ${variant} cold handoff recording has no exact pair binding`);
  }
  for (const field of ["headSha", "baseSha", "mergeBaseSha"]) {
    if (provisional[field] !== canonical[field] || canonical[field] !== exactRevision[field]) {
      throw new TypeError(`PR #${prNumber} ${variant} cold handoff recording changed exact ${field}`);
    }
  }
  const timings = record(recording.timings, `PR #${prNumber} ${variant} cold handoff timings`);
  const navigation = record(recording.navigation, `PR #${prNumber} ${variant} cold handoff navigation`);
  for (const field of [
    "provisionalReadyObservedMs",
    "canonicalDoneMs",
    "navigationStartedMs",
    "firstActionableBrowserMs",
  ]) {
    if (!finiteNumber(timings[field]) || timings[field] < 0) {
      throw new TypeError(`PR #${prNumber} ${variant} cold handoff recording has no finite ${field}`);
    }
  }
  const navigationUrl = new URL(relativeViewUrl(navigation.viewUrl), "http://meridian.local");
  const queryIs = (name, expected) => {
    const values = navigationUrl.searchParams.getAll(name);
    return values.length === 1 && values[0] === expected;
  };
  const expectedGraphId = variant === "progressive" ? provisional.graphId : canonical.graphId;
  if (navigation.source !== "playwright-main-document-request"
    || navigation.startedMs !== timings.navigationStartedMs
    || !queryIs("id", expectedGraphId)
    || !queryIs("prn", String(prNumber))
    || !queryIs("rev", "1")
    || (variant === "progressive" && (
      !queryIs("progressive", "1")
      || !queryIs("partial", "1")
      || !queryIs("pair", handoff.pairId)
    ))
    || (variant === "full" && (
      navigationUrl.searchParams.has("progressive")
      || navigationUrl.searchParams.has("partial")
      || navigationUrl.searchParams.has("pair")
    ))) {
    throw new TypeError(`PR #${prNumber} ${variant} cold handoff has no actual main-document navigation proof`);
  }
  if (variant === "progressive") {
    const reconciliation = record(
      recording.reconciliation,
      `PR #${prNumber} progressive cold handoff reconciliation`,
    );
    if (recording.flow !== "provisional-ready-then-background-canonical-reconciliation"
      || timings.navigationStartedMs < timings.provisionalReadyObservedMs
      || timings.navigationStartedMs >= timings.canonicalDoneMs
      || !finiteNumber(timings.canonicalReconciledBrowserMs)
      || reconciliation.required !== true
      || reconciliation.exactRevisionBound !== true
      || reconciliation.pairId !== handoff.pairId
      || reconciliation.canonicalGraphId !== canonical.graphId
      || reconciliation.mark?.name !== "meridian:pr-canonical-graph-reconciled"
      || reconciliation.mark?.detail?.graphId !== canonical.graphId
      || reconciliation.mark?.startTimeMs !== timings.canonicalReconciledBrowserMs
      || timings.canonicalReconciledBrowserMs < timings.firstActionableBrowserMs) {
      throw new TypeError(`PR #${prNumber} progressive cold handoff recording does not prove ready/action/reconcile order`);
    }
  } else if (recording.flow !== "canonical-done-then-navigation"
    || timings.navigationStartedMs < timings.canonicalDoneMs
    || timings.canonicalReconciledBrowserMs !== null
    || recording.reconciliation !== null) {
    throw new TypeError(`PR #${prNumber} full cold handoff recording is not a canonical baseline`);
  }
}

function validateRecordingEvidence(recording, prNumber, variant, config) {
  if (recording.validation === null || recording.validation === undefined) {
    throw new TypeError(`complete POC ${variant} recording for PR #${prNumber} is not validated`);
  }
  const validation = record(recording.validation, `POC PR #${prNumber} ${variant} recording validation`);
  if (typeof validation.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(validation.sha256)) {
    throw new TypeError(`complete POC ${variant} recording for PR #${prNumber} has no SHA-256 evidence`);
  }
  finitePositive(validation.durationSeconds, `${variant} recording duration`);
  nonEmptyString(validation.codec, `${variant} recording codec`);
  positiveInteger(validation.width, `${variant} recording width`);
  positiveInteger(validation.height, `${variant} recording height`);
  positiveInteger(validation.sizeBytes, `${variant} recording size`);
  positiveInteger(validation.sampledFrames, `${variant} recording sampled frame count`);
  positiveInteger(validation.distinctFrames, `${variant} recording distinct frame count`);
  if (!finiteNumber(validation.minimumLuma) || !finiteNumber(validation.maximumLuma) || validation.maximumLuma < 5) {
    throw new TypeError(`complete POC ${variant} recording for PR #${prNumber} has no non-black luminance evidence`);
  }
  isoTimestamp(validation.validatedAt, `${variant} recording validation timestamp`);
  if (validation.distinctFrames < 2 || validation.distinctFrames > validation.sampledFrames) {
    throw new TypeError(`complete POC ${variant} recording for PR #${prNumber} has invalid frame evidence`);
  }
  validateVideoProbe(validation, record(config?.viewport, "publishable recording viewport"));
}

function validateRecordingInteractions(
  recordings,
  prNumber,
  rawProgressivePrepared,
  rawFullPrepared = rawProgressivePrepared,
) {
  const preparedByVariant = {
    full: record(rawFullPrepared, `PR #${prNumber} full prepared recording revision`),
    progressive: record(rawProgressivePrepared, `PR #${prNumber} progressive prepared recording revision`),
  };
  const interactions = {};
  for (const variant of ["full", "progressive"]) {
    assertObservedSemanticRevision(
      recordings[variant]?.exactRevision,
      preparedByVariant[variant],
      `PR #${prNumber} ${variant} recording exact revision`,
    );
    const interaction = record(
      recordings[variant]?.interaction,
      `PR #${prNumber} ${variant} showcase interaction`,
    );
    if (interaction.variant !== variant
      || interaction.searchHydrated !== true
      || !Number.isSafeInteger(interaction.canvasNodesBeforeSearch)
      || !Number.isSafeInteger(interaction.canvasNodesAfterSearch)
      || interaction.canvasNodesAfterSearch <= interaction.canvasNodesBeforeSearch) {
      throw new TypeError(`PR #${prNumber} ${variant} recording did not prove command-palette hydration`);
    }
    if (variant === "progressive" && (interaction.depthAdjusted !== true
      || interaction.disconnectedBeforeSearch !== true)) {
      throw new TypeError(`PR #${prNumber} progressive recording did not prove adjustable depth and disconnected search`);
    }
    if (variant === "full" && typeof interaction.depthAdjusted !== "boolean") {
      throw new TypeError(`PR #${prNumber} full recording has no depth-control provenance`);
    }
    const symbol = record(interaction.symbol, `PR #${prNumber} ${variant} recorded symbol`);
    for (const field of ["id", "fileId", "displayName", "file"]) {
      nonEmptyString(symbol[field], `PR #${prNumber} ${variant} recorded symbol ${field}`);
    }
    interactions[variant] = interaction;
  }
  if (JSON.stringify(interactions.full.symbol) !== JSON.stringify(interactions.progressive.symbol)) {
    throw new TypeError(`PR #${prNumber} recordings did not use the same exact symbol`);
  }
  const background = record(
    interactions.progressive.backgroundSymbolIndex,
    `PR #${prNumber} progressive background symbol index`,
  );
  if (background.rendererInitiated !== true
    || background.afterFirstActionable !== true
    || background.beforeHarnessInteraction !== true
    || background.complete !== true
    || background.graphId !== preparedByVariant.progressive.graphId
    || !Number.isSafeInteger(background.indexedSymbolCount)
    || background.indexedSymbolCount <= 0
    || !Number.isSafeInteger(background.totalSymbolCount)
    || background.totalSymbolCount < background.indexedSymbolCount) {
    throw new TypeError(`PR #${prNumber} recording did not prove renderer-initiated background symbol indexing`);
  }
  const acceptanceMark = record(
    background.acceptanceMark,
    `PR #${prNumber} progressive symbol acceptance mark`,
  );
  if (acceptanceMark.name !== "meridian:progressive-symbol-index-ready"
    || !finiteNumber(acceptanceMark.startTimeMs)
    || acceptanceMark.startTimeMs < 0
    || acceptanceMark.indexedSymbolCount !== background.indexedSymbolCount) {
    throw new TypeError(`PR #${prNumber} recording did not prove renderer acceptance of its background symbol index`);
  }
  const rendererTransport = record(
    background.rendererTransport,
    `PR #${prNumber} progressive symbol renderer transport`,
  );
  if (rendererTransport.graphId !== preparedByVariant.progressive.graphId
    || rendererTransport.workerBacked !== true
    || rendererTransport.accepted !== true
    || rendererTransport.source !== "renderer-symbol-worker-accepted"
    || !finiteNumber(rendererTransport.requestStartedAtMs)
    || !finiteNumber(rendererTransport.firstActionableAtMs)
    || rendererTransport.requestStartedAtMs + 0.5 < rendererTransport.firstActionableAtMs) {
    throw new TypeError(`PR #${prNumber} recording did not prove a post-action renderer symbol transport`);
  }
  const harnessFetch = record(
    background.harnessFetch,
    `PR #${prNumber} progressive symbol evidence fetch`,
  );
  if (harnessFetch.graphId !== preparedByVariant.progressive.graphId || harnessFetch.status !== 200) {
    throw new TypeError(`PR #${prNumber} recording did not prove an exact-revision harness symbol evidence fetch`);
  }
}

function validateRelativeEvidencePath(value, name) {
  const path = nonEmptyString(value, name);
  const segments = path.split("/");
  if (
    path.startsWith("/")
    || path.includes("\\")
    || path.includes(":")
    || path.includes("?")
    || path.includes("#")
    || segments.some((segment) => segment === "" || segment === "." || segment === "..")
    || segments.some((segment) => !/^[A-Za-z0-9._-]+$/.test(segment))
  ) throw new TypeError(`${name} is unsafe`);
  return path;
}

function validateOptionalEvidencePaths(value, name, seen = new Set()) {
  if (value === null || value === undefined || typeof value !== "object") return;
  if (seen.has(value)) throw new TypeError(`${name} contains a cycle`);
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => validateOptionalEvidencePaths(item, `${name}[${index}]`, seen));
  } else {
    for (const [key, item] of Object.entries(value)) {
      if (key === "relativePath" && typeof item === "string") validateRelativeEvidencePath(item, `${name} relativePath`);
      else validateOptionalEvidencePaths(item, `${name}.${key}`, seen);
    }
  }
  seen.delete(value);
}

function assertExactSceneParity(prNumber, fullSamples, progressiveSamples) {
  if (fullSamples.length !== progressiveSamples.length) {
    throw new TypeError(`PR #${prNumber} full/progressive sample counts differ; exact scene ID-set parity is unproven`);
  }
  for (let index = 0; index < fullSamples.length; index += 1) {
    for (const stage of ["sceneAtAction", "sceneSettled"]) {
      const full = canonicalScene(
        fullSamples[index]?.[stage],
        `PR #${prNumber} full sample ${index + 1} ${stage}`,
      );
      const progressive = canonicalScene(
        progressiveSamples[index]?.[stage],
        `PR #${prNumber} progressive sample ${index + 1} ${stage}`,
      );
      for (const field of ["nodeIds", "edgeIds", "reviewFiles"]) {
        if (JSON.stringify(full[field]) !== JSON.stringify(progressive[field])) {
          throw new TypeError(
            `PR #${prNumber} sample ${index + 1} ${stage} ${field} differ; exact scene ID-set parity is unproven`,
          );
        }
      }
    }
  }
}

function assertPublishableMeasurements(
  prNumber,
  variants,
  {
    requirePreparedServiceMemory = true,
    variantNames = ["full", "progressive"],
  } = {},
) {
  for (const variant of variantNames) {
    const expectedGraphPath = variant === "full" ? "/api/graph" : "/api/graph/project";
    for (let index = 0; index < variants[variant].samples.length; index += 1) {
      const sample = variants[variant].samples[index];
      assertAuthoritativeGraphNetwork(
        sample?.networkAtAction,
        `PR #${prNumber} ${variant} sample ${index + 1} networkAtAction`,
        expectedGraphPath,
      );
      assertAuthoritativeGraphNetwork(
        sample?.networkSettled,
        `PR #${prNumber} ${variant} sample ${index + 1} networkSettled`,
        expectedGraphPath,
      );
      const values = {
        firstActionableMs: sample?.timings?.firstActionableMs,
        settledMs: sample?.timings?.settledMs,
        graphBytesAtAction: sample?.networkAtAction?.graphEncodedBytes,
        graphBytesSettled: sample?.networkSettled?.graphEncodedBytes,
        browserHeapPeak: readMetric(sample, ["memoryPeak.browserJsHeapUsedBytes"]),
        browserHeapRetained: readMetric(sample, ["memorySettled.browserJsHeapUsedBytes"]),
        browserRssPeak: readMetric(sample, ["memoryPeak.browserProcessRssBytes"]),
        browserRssRetained: readMetric(sample, ["memorySettled.browserProcessRssBytes"]),
        ...(requirePreparedServiceMemory ? {
          serviceRssPeak: readMetric(sample, ["serviceMemory.peakRssBytes", "memoryPeak.serviceRssBytes"]),
          serviceRssRetained: readMetric(sample, [
            "serviceMemory.retainedRssBytes",
            "memorySettled.serviceRssBytes",
          ]),
          workerRssPeak: readMetric(sample, ["serviceMemory.workerPeakRssBytes", "memoryPeak.workerRssBytes"]),
          workerRssRetained: readMetric(sample, [
            "serviceMemory.workerRetainedRssBytes",
            "memorySettled.workerRssBytes",
          ]),
        } : {}),
      };
      for (const [name, measured] of Object.entries(values)) {
        if (!finiteNumber(measured) || measured < 0) {
          throw new TypeError(`PR #${prNumber} ${variant} sample ${index + 1} has no finite ${name}`);
        }
      }
      if (values.firstActionableMs > values.settledMs) {
        throw new TypeError(`PR #${prNumber} ${variant} sample ${index + 1} settles before first action`);
      }
      if (values.graphBytesAtAction <= 0 || values.graphBytesSettled <= 0) {
        throw new TypeError(`PR #${prNumber} ${variant} sample ${index + 1} has no positive graph transfer evidence`);
      }
      if (values.graphBytesAtAction > values.graphBytesSettled) {
        throw new TypeError(`PR #${prNumber} ${variant} sample ${index + 1} graph transfer decreases after action`);
      }
      const memoryPairs = [
        [values.browserHeapPeak, values.browserHeapRetained],
        [values.browserRssPeak, values.browserRssRetained],
        ...(requirePreparedServiceMemory ? [
          [values.serviceRssPeak, values.serviceRssRetained],
          [values.workerRssPeak, values.workerRssRetained],
        ] : []),
      ];
      for (const [peak, retained] of memoryPairs) {
        if (peak < retained) {
          throw new TypeError(`PR #${prNumber} ${variant} sample ${index + 1} retained memory exceeds its peak`);
        }
      }
      if (requirePreparedServiceMemory) {
        if (sample.serviceMemory?.diagnostic === true) {
          throw new TypeError(`PR #${prNumber} ${variant} sample ${index + 1} has diagnostic-only service memory`);
        }
        if (!Number.isSafeInteger(sample.serviceMemory?.sampleCount) || sample.serviceMemory.sampleCount <= 0) {
          throw new TypeError(`PR #${prNumber} ${variant} sample ${index + 1} has no service memory sample provenance`);
        }
      }
    }
  }
}

function assertAuthoritativeGraphNetwork(raw, name, expectedPath) {
  const network = record(raw, name);
  if (network.graphBytesAuthoritative !== true || network.graphAccountingComplete !== true) {
    throw new TypeError(`${name} has no authoritative complete graph transfer accounting`);
  }
  const graphEncodedBytes = nonNegativeSafeInteger(network.graphEncodedBytes, `${name}.graphEncodedBytes`);
  const graphObservedEncodedBytes = nonNegativeSafeInteger(
    network.graphObservedEncodedBytes,
    `${name}.graphObservedEncodedBytes`,
  );
  const inFlightGraphRequestCount = nonNegativeSafeInteger(
    network.inFlightGraphRequestCount,
    `${name}.inFlightGraphRequestCount`,
  );
  if (graphObservedEncodedBytes < graphEncodedBytes) {
    throw new TypeError(`${name} observed graph bytes are smaller than authoritative graph bytes`);
  }
  if (inFlightGraphRequestCount !== 0) {
    throw new TypeError(`${name} has in-flight initial graph requests`);
  }

  const anomalyCount = nonNegativeSafeInteger(network.accountingAnomalyCount, `${name}.accountingAnomalyCount`);
  if (!Array.isArray(network.accountingAnomalies) || network.accountingAnomalies.length !== anomalyCount) {
    throw new TypeError(`${name} has inconsistent accounting anomaly evidence`);
  }
  if (network.accountingAnomalies.some((entry) => GRAPH_TRANSFER_PATHS.includes(entry?.path))) {
    throw new TypeError(`${name} has an initial graph accounting anomaly`);
  }

  const byPath = record(network.byPath, `${name}.byPath`);
  const rows = [];
  for (const path of GRAPH_TRANSFER_PATHS) {
    if (byPath[path] === undefined) continue;
    const row = record(byPath[path], `${name}.byPath[${path}]`);
    const counts = Object.fromEntries([
      "requests",
      "encodedBytes",
      "observedEncodedBytes",
      "finishedRequests",
      "inFlightRequests",
      "failedRequests",
      "canceledRequests",
      "blockedRequests",
      "cachedRequests",
      "redirects",
      "requestIdReuses",
      "accountingAnomalies",
    ].map((field) => [field, nonNegativeSafeInteger(row[field], `${name}.byPath[${path}].${field}`)]));
    if (counts.requests === 0
      || counts.finishedRequests + counts.inFlightRequests !== counts.requests
      || counts.finishedRequests !== counts.requests
      || counts.inFlightRequests !== 0
      || counts.failedRequests !== counts.canceledRequests
      || counts.failedRequests > counts.requests
      || counts.blockedRequests !== 0
      || counts.cachedRequests !== 0
      || counts.redirects > counts.requests
      || counts.requestIdReuses !== 0
      || counts.accountingAnomalies !== 0
      || counts.observedEncodedBytes < counts.encodedBytes
      || row.bytesAuthoritative !== true
      || row.accountingComplete !== true) {
      throw new TypeError(`${name} has a contaminated or incomplete ${path} ledger row`);
    }
    rows.push({ path, ...counts });
  }
  if (rows.length !== 1 || rows[0].path !== expectedPath || rows[0].requests < 2) {
    throw new TypeError(`${name} does not contain only the expected ${expectedPath} initial graph route`);
  }
  const encodedSum = rows.reduce((sum, row) => sum + row.encodedBytes, 0);
  const observedSum = rows.reduce((sum, row) => sum + row.observedEncodedBytes, 0);
  const inFlightSum = rows.reduce((sum, row) => sum + row.inFlightRequests, 0);
  if (!Number.isSafeInteger(encodedSum)
    || !Number.isSafeInteger(observedSum)
    || encodedSum !== graphEncodedBytes
    || observedSum !== graphObservedEncodedBytes
    || inFlightSum !== inFlightGraphRequestCount) {
    throw new TypeError(`${name} graph byte totals contradict its initial graph route ledger`);
  }
}

function canonicalScene(value, name) {
  const scene = record(value, name);
  const result = {};
  for (const field of ["nodeIds", "edgeIds", "reviewFiles"]) {
    if (!Array.isArray(scene[field])) throw new TypeError(`${name}.${field} must be an array`);
    const values = scene[field].map((item) => nonEmptyString(item, `${name}.${field} item`));
    if (new Set(values).size !== values.length) {
      throw new TypeError(`${name}.${field} contains duplicates`);
    }
    result[field] = [...values].sort((left, right) => left.localeCompare(right));
  }
  return result;
}

function assertStoredSceneParity(prNumber, value) {
  const parity = record(value, `PR #${prNumber} parity proof`);
  const fields = record(parity.fields, `PR #${prNumber} parity fields`);
  if (
    parity.exact !== true
    || fields.nodeIds !== true
    || fields.edgeIds !== true
    || fields.reviewFiles !== true
  ) {
    throw new TypeError(`PR #${prNumber} does not declare exact node, edge, and review-file parity`);
  }
  const fullHash = nonEmptyString(parity.fullSceneHash, `PR #${prNumber} full scene hash`);
  const progressiveHash = nonEmptyString(parity.progressiveSceneHash, `PR #${prNumber} progressive scene hash`);
  if (fullHash !== progressiveHash) throw new TypeError(`PR #${prNumber} stored scene hashes contradict exact parity`);
}

function assertPreparedMeasurementSchedule(prNumber, variants, repetitions, prIndex) {
  if (!Number.isSafeInteger(repetitions) || repetitions <= 0) {
    throw new TypeError(`PR #${prNumber} prepared measurement schedule has no repetition count`);
  }
  for (let index = 0; index < repetitions; index += 1) {
    const expectedOrder = (index + prIndex) % 2 === 0
      ? ["full", "progressive"]
      : ["progressive", "full"];
    for (const variant of ["full", "progressive"]) {
      const sample = variants[variant].samples[index];
      const expectedPosition = expectedOrder.indexOf(variant) + 1;
      if (sample?.variant !== variant
        || sample?.iteration !== index + 1
        || sample?.measurementOrder?.sequencePosition !== expectedPosition
        || JSON.stringify(sample?.measurementOrder?.variants) !== JSON.stringify(expectedOrder)) {
        throw new TypeError(
          `PR #${prNumber} ${variant} sample ${index + 1} contradicts the prepared counterbalancing schedule`,
        );
      }
    }
  }
}

function assertExactProjectionIdentity(prNumber, rawPrepared, fullSamples, progressiveSamples) {
  const prepared = record(rawPrepared, `PR #${prNumber} prepared revision`);
  const expected = {
    graphId: nonEmptyString(prepared.graphId, `PR #${prNumber} prepared graphId`),
    comparisonGraphId: nonEmptyString(prepared.comparisonGraphId, `PR #${prNumber} prepared comparisonGraphId`),
    headSha: oid(prepared.headSha, `PR #${prNumber} prepared head SHA`),
    baseSha: oid(prepared.baseSha, `PR #${prNumber} prepared base SHA`),
    mergeBaseSha: oid(prepared.mergeBaseSha, `PR #${prNumber} prepared merge-base SHA`),
  };
  for (const [variant, samples] of [["full", fullSamples], ["progressive", progressiveSamples]]) {
    for (let index = 0; index < samples.length; index += 1) {
      const actual = record(samples[index]?.exactRevision, `PR #${prNumber} ${variant} sample ${index + 1} exactRevision`);
      for (const field of ["graphId", "comparisonGraphId", "headSha", "mergeBaseSha"]) {
        const expectedValue = expected[field];
        if (actual[field] !== expectedValue) {
          throw new TypeError(
            `PR #${prNumber} ${variant} sample ${index + 1} does not prove exact ${field} identity`,
          );
        }
      }
      assertObservedSemanticRevision(
        actual,
        expected,
        `PR #${prNumber} ${variant} sample ${index + 1} exactRevision`,
      );
    }
  }
  for (let index = 0; index < progressiveSamples.length; index += 1) {
    const projections = progressiveSamples[index]?.projections;
    if (!Array.isArray(projections)) {
      throw new TypeError(`PR #${prNumber} progressive sample ${index + 1} has no projection identity evidence`);
    }
    const graphIds = new Set(projections.map((projection) => projection?.graphId).filter((id) => typeof id === "string"));
    if (!graphIds.has(expected.graphId) || !graphIds.has(expected.comparisonGraphId)) {
      throw new TypeError(
        `PR #${prNumber} progressive sample ${index + 1} did not load both exact graph projections`,
      );
    }
    if (!Array.isArray(progressiveSamples[index]?.graphs) || progressiveSamples[index].graphs.length !== 0) {
      throw new TypeError(`PR #${prNumber} progressive sample ${index + 1} loaded a canonical full graph`);
    }
    assertInitialProjectionCacheHitEvidence(
      progressiveSamples[index]?.initialProjectionCacheHits,
      prepared,
      `PR #${prNumber} progressive sample ${index + 1}`,
    );
  }
  for (let index = 0; index < fullSamples.length; index += 1) {
    assertExactFullGraphEvidence(
      fullSamples[index]?.graphs,
      expected,
      `PR #${prNumber} full sample ${index + 1}`,
    );
    if (!Array.isArray(fullSamples[index]?.initialProjectionCacheHits)
      || fullSamples[index].initialProjectionCacheHits.length !== 0) {
      throw new TypeError(`PR #${prNumber} full sample ${index + 1} consumed progressive initial projections`);
    }
  }
}

function assertPartialOnlyProjectionIdentity(prNumber, variants, partial, canonical) {
  for (const variant of ["full", "progressive"]) {
    const expected = variant === "progressive" ? partial : canonical;
    for (let index = 0; index < variants[variant].samples.length; index += 1) {
      assertPartialOnlyGraphIdentity(
        variants[variant].samples[index],
        prNumber,
        variant,
        expected,
        `prepared sample ${index + 1}`,
      );
    }
  }
}

function assertPartialOnlyGraphIdentity(sample, prNumber, variant, expected, label) {
  const name = `PR #${prNumber} ${variant} ${label}`;
  if (variant === "full") {
    assertExactFullGraphEvidence(sample?.graphs, expected, name);
    if (!Array.isArray(sample?.projections) || sample.projections.length !== 0
      || !Array.isArray(sample?.initialProjectionCacheHits)
      || sample.initialProjectionCacheHits.length !== 0) {
      throw new TypeError(`${name} mixed the canonical baseline with partial projection evidence`);
    }
    return;
  }
  if (!Array.isArray(sample?.graphs) || sample.graphs.length !== 0) {
    throw new TypeError(`${name} loaded a canonical full graph`);
  }
  if (!Array.isArray(sample?.projections) || sample.projections.length < 2) {
    throw new TypeError(`${name} has no exact partial projection identity evidence`);
  }
  const expectedGraphIds = new Set([expected.graphId, expected.comparisonGraphId]);
  const observed = new Set();
  for (const projection of sample.projections) {
    if (!expectedGraphIds.has(projection?.graphId)) {
      throw new TypeError(`${name} loaded an unexpected partial projection`);
    }
    if (!["changed-files", "files", "file-paths"].includes(projection.rootsKind)) {
      throw new TypeError(`${name} projection has no bounded root provenance`);
    }
    const expectedSeed = projection.rootsKind === "changed-files"
      ? expected.graphId
      : projection.graphId;
    if (projection.seedGraphId !== expectedSeed) {
      throw new TypeError(`${name} projection is not rooted in the exact partial HEAD graph`);
    }
    observed.add(projection.graphId);
  }
  if (observed.size !== expectedGraphIds.size) {
    throw new TypeError(`${name} did not load exact HEAD and comparison projections`);
  }
  assertInitialProjectionCacheHitEvidence(sample.initialProjectionCacheHits, expected, name);
}

function assertPreparedInitialProjectionEvidence(prNumber, pr) {
  const prepared = record(pr.revisions?.prepared, `PR #${prNumber} prepared revision`);
  const preparedCache = validateInitialProjectionCache(
    prepared.initialProjectionCache,
    `PR #${prNumber} prepared initial projection cache`,
  );
  const preparedUrl = new URL(relativeViewUrl(prepared.viewUrl), "http://meridian.local");
  if (preparedUrl.searchParams.get("id") !== prepared.graphId
    || preparedUrl.searchParams.get("prn") !== String(prNumber)
    || preparedUrl.searchParams.get("rev") !== "1"
    || preparedUrl.searchParams.get("progressive") !== "1") {
    throw new TypeError(`PR #${prNumber} prepared URL has no exact progressive readiness contract`);
  }
  const preparation = record(pr.preparation, `PR #${prNumber} preparation evidence`);
  if (preparation.httpStatus !== 200
    || !finiteNumber(preparation.totalMs)
    || preparation.totalMs < 0
    || !Array.isArray(preparation.events)
    || preparation.events.length === 0) {
    throw new TypeError(`PR #${prNumber} preparation evidence is incomplete`);
  }
  const terminal = record(preparation.events.at(-1)?.payload, `PR #${prNumber} preparation terminal`);
  const terminalCache = validateInitialProjectionCache(
    terminal.initialProjectionCache,
    `PR #${prNumber} preparation terminal initial projection cache`,
  );
  for (const field of ["graphId", "comparisonGraphId", "headSha", "baseSha", "mergeBaseSha"]) {
    if (terminal[field] !== prepared[field]) {
      throw new TypeError(`PR #${prNumber} preparation terminal contradicts exact ${field}`);
    }
  }
  if (relativeViewUrl(terminal.viewUrl) !== relativeViewUrl(prepared.viewUrl)
    || JSON.stringify(terminalCache) !== JSON.stringify(preparedCache)) {
    throw new TypeError(`PR #${prNumber} preparation terminal readiness contradicts the prepared revision`);
  }
}

function assertInitialProjectionCacheHitEvidence(rawHits, prepared, name) {
  if (!Array.isArray(rawHits) || rawHits.length !== 2) {
    throw new TypeError(`${name} has no exact initial projection cache-hit pair`);
  }
  const cache = validateInitialProjectionCache(prepared.initialProjectionCache, `${name} initial projection cache`);
  const expected = new Map([
    [prepared.graphId, cache.headKey],
    [prepared.comparisonGraphId, cache.comparisonKey],
  ]);
  const seen = new Set();
  for (const hit of rawHits) {
    const graphId = hit?.graphId;
    if (!expected.has(graphId)
      || seen.has(graphId)
      || hit.seedGraphId !== prepared.graphId
      || hit.requestedDepth !== 1
      || hit.prefetchDepth !== 3
      || hit.method !== "POST"
      || hit.path !== "/api/graph/project"
      || hit.status !== 200
      || hit.cache !== "hit"
      || hit.key !== expected.get(graphId)
      || hit.ready !== true
      || hit.responseBodyRead !== false
      || hit.source !== "request-and-response-headers") {
      throw new TypeError(`${name} has an invalid prepared initial projection cache hit`);
    }
    seen.add(graphId);
  }
  if (seen.size !== expected.size) throw new TypeError(`${name} did not hit both prepared initial projection keys`);
}

function assertExactFullGraphEvidence(rawGraphs, prepared, name) {
  if (!Array.isArray(rawGraphs) || rawGraphs.length < 2) {
    throw new TypeError(`${name} has no canonical graph response identity evidence`);
  }
  const expected = new Set([prepared.graphId, prepared.comparisonGraphId]);
  const observed = new Set();
  for (const graph of rawGraphs) {
    if (graph?.method !== "GET" || graph?.status !== 200 || !expected.has(graph?.graphId)) {
      throw new TypeError(`${name} loaded an unexpected canonical graph response`);
    }
    observed.add(graph.graphId);
  }
  if (observed.size !== 2) throw new TypeError(`${name} did not load exact HEAD and comparison graphs`);
}

function assertStoredRevisionProvenance(
  prNumber,
  rawRevisions,
  repository,
  { coldVariants = ["full", "progressive"] } = {},
) {
  const revisions = record(rawRevisions, `PR #${prNumber} revisions`);
  const prepared = record(revisions.prepared, `PR #${prNumber} prepared revision`);
  const expectedRepository = nonEmptyString(repository, `PR #${prNumber} configured repository`).toLowerCase();
  const envelopeFields = [
    "repository",
    "number",
    "headRef",
    "headOid",
    "headRepository",
    "baseRef",
    "baseRepository",
  ];
  const snapshots = [];
  for (const phase of ["initial", "final"]) {
    const live = record(revisions[phase], `PR #${prNumber} ${phase} GitHub revision`);
    if (
      live.number !== prNumber
      || typeof live.repository !== "string"
      || live.repository.toLowerCase() !== expectedRepository
      || live.headOid !== prepared.headSha
    ) {
      throw new TypeError(`PR #${prNumber} ${phase} GitHub revision contradicts the prepared graph pair`);
    }
    gitRef(live.headRef, `PR #${prNumber} ${phase} head ref`);
    gitRef(live.baseRef, `PR #${prNumber} ${phase} base ref`);
    storedRepositoryName(live.baseRepository, `PR #${prNumber} ${phase} base repository`);
    if (live.baseRepository.toLowerCase() !== expectedRepository) {
      throw new TypeError(`PR #${prNumber} ${phase} base repository contradicts the configured repository`);
    }
    if (live.headRepository !== null) {
      storedRepositoryName(live.headRepository, `PR #${prNumber} ${phase} head repository`);
    }
    oid(live.headOid, `PR #${prNumber} ${phase} HEAD`);
    oid(live.baseOid, `PR #${prNumber} ${phase} observed base tip`);
    oid(live.pullBaseOid, `PR #${prNumber} ${phase} pull-metadata base observation`);
    isoTimestamp(live.updatedAt, `PR #${prNumber} ${phase} updatedAt`);
    isoTimestamp(live.resolvedAt, `PR #${prNumber} ${phase} resolvedAt`);
    snapshots.push(live);
  }
  const [initial, final] = snapshots;
  for (const field of envelopeFields) {
    if (initial[field] !== final[field]) {
      throw new TypeError(`PR #${prNumber} ${field} moved while collecting publishable evidence`);
    }
  }
  const coldInputs = record(revisions.coldInputs, `PR #${prNumber} cold input revisions`);
  for (const variant of coldVariants) {
    const input = record(coldInputs[variant], `PR #${prNumber} cold ${variant} input revision`);
    for (const field of envelopeFields) {
      if (input[field] !== initial[field]) {
        throw new TypeError(`PR #${prNumber} cold ${variant} input changed PR envelope field ${field}`);
      }
    }
    oid(input.baseOid, `PR #${prNumber} cold ${variant} input observed base tip`);
    oid(input.pullBaseOid, `PR #${prNumber} cold ${variant} input pull-metadata base observation`);
    isoTimestamp(input.updatedAt, `PR #${prNumber} cold ${variant} input updatedAt`);
    isoTimestamp(input.resolvedAt, `PR #${prNumber} cold ${variant} input resolvedAt`);
  }
  const input = record(revisions.preparationInput, `PR #${prNumber} preparation input revision`);
  for (const field of envelopeFields) {
    if (input[field] !== initial[field]) {
      throw new TypeError(`PR #${prNumber} preparation input changed PR envelope field ${field}`);
    }
  }
  oid(input.baseOid, `PR #${prNumber} preparation-input observed base tip`);
  oid(input.pullBaseOid, `PR #${prNumber} preparation-input pull-metadata base observation`);
  isoTimestamp(input.updatedAt, `PR #${prNumber} preparation-input updatedAt`);
  isoTimestamp(input.resolvedAt, `PR #${prNumber} preparation-input resolvedAt`);
}

function assertObservedSemanticRevision(rawRevision, rawPrepared, name) {
  const actual = record(rawRevision, name);
  const prepared = record(rawPrepared, `${name} prepared coordinates`);
  for (const field of ["graphId", "comparisonGraphId", "headSha", "mergeBaseSha"]) {
    if (actual[field] !== prepared[field]) {
      throw new TypeError(`${name} changed exact ${field}`);
    }
  }
  const observedBaseSha = oid(actual.baseSha, `${name} observed base tip`);
  const preparedBaseSha = oid(prepared.baseSha, `${name} prepared base tip`);
  if (actual.preparedBaseSha !== preparedBaseSha
    || typeof actual.baseTipDrift !== "boolean"
    || actual.baseTipDrift !== (observedBaseSha !== preparedBaseSha)) {
    throw new TypeError(`${name} has inconsistent base-tip drift provenance`);
  }
  return actual;
}

function assertCacheReadiness(prNumber, progressiveSamples, rawPrepared) {
  const prepared = record(rawPrepared, `PR #${prNumber} prepared revision for warm proof`);
  let authoritative = false;
  for (let index = 0; index < progressiveSamples.length; index += 1) {
    const sample = progressiveSamples[index];
    const summary = sample?.cacheReadiness;
    if (summary?.causalWarmReadyHit !== true && summary?.authoritative !== true) continue;
    const cacheEvidence = record(
      sample.cacheEvidence,
      `PR #${prNumber} progressive sample ${index + 1} cache evidence`,
    );
    const derived = deriveCausalWarmReadinessEvidence(cacheEvidence, prepared);
    assertDerivedEvidence(
      derived,
      record(
        cacheEvidence.cacheReadiness,
        `PR #${prNumber} progressive sample ${index + 1} nested cache readiness`,
      ),
      `PR #${prNumber} progressive sample ${index + 1} nested cache readiness`,
    );
    assertDerivedEvidence(
      derived,
      record(summary, `PR #${prNumber} progressive sample ${index + 1} cache readiness`),
      `PR #${prNumber} progressive sample ${index + 1} cache readiness`,
    );
    authoritative = true;
  }
  if (!authoritative) {
    throw new TypeError(
      `PR #${prNumber} has no causal proof that next-depth ghost-node precomputation was initiated or coalesced, ready, and cache-hit`,
    );
  }
}

function assertDerivedEvidence(expected, stored, name, path = "") {
  if (expected === null || typeof expected !== "object") {
    if (!Object.is(expected, stored)) throw new TypeError(`${name}${path} contradicts recomputed sample evidence`);
    return;
  }
  for (const [key, expectedValue] of Object.entries(expected)) {
    const nextPath = `${path}.${key}`;
    if (!(key in stored)) throw new TypeError(`${name}${nextPath} is missing from stored evidence`);
    const storedValue = stored[key];
    if (expectedValue !== null && typeof expectedValue === "object") {
      if (storedValue === null || typeof storedValue !== "object") {
        throw new TypeError(`${name}${nextPath} contradicts recomputed sample evidence`);
      }
      assertDerivedEvidence(expectedValue, storedValue, name, nextPath);
    } else if (!Object.is(expectedValue, storedValue)) {
      throw new TypeError(`${name}${nextPath} contradicts recomputed sample evidence`);
    }
  }
}

function renderPartialRuntimeOnlyHtmlReport(document) {
  const complete = document.status === "complete";
  const configured = Array.isArray(document.config?.prs) ? document.config.prs.length : 0;
  const completed = document.prs.filter((entry) => entry.status === "complete");
  const preparedRows = completed.flatMap((entry) => {
    const summary = entry.variants?.progressive?.summary ?? {};
    return [
      ["First-run time to action", summary.firstActionableFirstMs, "ms"],
      ["Warm time to action", summary.firstActionableWarmMedianMs, "ms"],
      ["Warm settled loading", summary.settledWarmMedianMs, "ms"],
      ["Graph transfer at action", summary.graphBytesAtAction, "bytes"],
      ["Graph transfer settled", summary.graphBytesSettled, "bytes"],
      ["Browser heap peak", summary.browserJsHeapPeakBytes, "bytes"],
      ["Browser heap retained", summary.browserJsHeapRetainedBytes, "bytes"],
      ["Browser RSS peak", summary.browserRssPeakBytes, "bytes"],
      ["Browser RSS retained", summary.browserRssRetainedBytes, "bytes"],
      ["Service RSS peak", summary.serviceRssPeakBytes, "bytes"],
      ["Service RSS retained", summary.serviceRssRetainedBytes, "bytes"],
      ["Projection worker RSS peak", summary.workerRssPeakBytes, "bytes"],
      ["Projection worker RSS retained", summary.workerRssRetainedBytes, "bytes"],
    ].map(([label, value, unit], index) => `<tr><td>${index === 0 ? `Autopilot #${entry.number}` : ""}</td><td>${escapeHtml(label)}</td><td>${formatMetric(value, unit)}</td></tr>`);
  }).join("\n");
  const coldRows = completed.flatMap((entry) => {
    const sample = entry.coldEndToEnd?.variants?.progressive ?? {};
    return [
      ["Prepare request to canvas action", sample.timings?.endToEndFirstActionableMs, "ms"],
      ["Prepare request to settled canvas", sample.timings?.endToEndSettledMs, "ms"],
      ["Bounded pair terminal", sample.preparation?.milestones?.finalPairReadyMs, "ms"],
      ["Browser heap peak", sample.memoryPeak?.browserJsHeapUsedBytes, "bytes"],
      ["Browser RSS peak", sample.memoryPeak?.browserProcessRssBytes, "bytes"],
      ["Service RSS peak", sample.coldServiceMemory?.peakRssBytes, "bytes"],
      ["Service RSS retained", sample.coldServiceMemory?.retainedRssBytes, "bytes"],
      ["Projection worker RSS peak", sample.coldServiceMemory?.workerPeakRssBytes, "bytes"],
      ["Projection worker RSS retained", sample.coldServiceMemory?.workerRetainedRssBytes, "bytes"],
    ].map(([label, value, unit], index) => `<tr><td>${index === 0 ? `Autopilot #${entry.number}` : ""}</td><td>${escapeHtml(label)}</td><td>${formatMetric(value, unit)}</td></tr>`);
  }).join("\n");
  const proof = completed.reduce((totals, entry) => {
    const continuationProofs = [
      ...(entry.variants?.progressive?.samples ?? []).map((sample) => sample.partialOnlyContinuation),
      entry.coldEndToEnd?.variants?.progressive?.partialOnlyContinuation,
      entry.startupRecordings?.progressive?.continuationProof,
    ].filter(Boolean);
    const analyzeRequests = [
      ...(entry.variants?.progressive?.samples ?? []).flatMap((sample) => sample.analyzeRequests ?? []),
      ...(entry.coldEndToEnd?.variants?.progressive?.analyzeRequests ?? []),
      ...(entry.recordings?.progressive?.analyzeRequests ?? []),
      ...(entry.startupRecordings?.progressive?.analyzeRequests ?? []),
    ];
    const functionalityTransport = entry.recordings?.progressive?.partialRuntimeTransport ?? {};
    totals.canonicalRequests += continuationProofs.reduce(
      (sum, value) => sum + (value.canonicalGraphRequests ?? 0),
      0,
    ) + (functionalityTransport.canonicalGraphRequests ?? 0);
    totals.canonicalResponses += continuationProofs.reduce(
      (sum, value) => sum + (value.canonicalGraphResponses ?? 0),
      0,
    ) + (functionalityTransport.canonicalGraphResponses ?? 0);
    totals.fullGenerationRequests += continuationProofs.reduce((sum, value) =>
      sum
      + (value.preDwellGraphWork?.fullGenerationRequests ?? 0)
      + (value.postReadyGraphWork?.fullGenerationRequests ?? 0), 0)
      + (functionalityTransport.fullGenerationRequests ?? 0);
    totals.canonicalReconciliationMarks += continuationProofs.reduce(
      (sum, value) => sum + (value.canonicalReconciliationMarks ?? 0),
      0,
    ) + (functionalityTransport.canonicalReconciliationMarks ?? 0);
    totals.forbiddenAnalyzeRequests += analyzeRequests.filter((request) =>
      request.progressiveFalse === true || request.fullBaselineCapabilityHeaderPresent === true).length;
    totals.continuationProofs += continuationProofs.length;
    return totals;
  }, {
    canonicalRequests: 0,
    canonicalResponses: 0,
    fullGenerationRequests: 0,
    canonicalReconciliationMarks: 0,
    forbiddenAnalyzeRequests: 0,
    continuationProofs: 0,
  });
  const recordingCards = document.prs.flatMap((entry) => [
    ...renderPartialOnlyRecordingGroup(entry, "startupRecordings", "Startup"),
    ...renderPartialOnlyRecordingGroup(entry, "recordings", "Depth + search"),
  ]).join("\n");
  const revisionCards = completed.map((entry) => {
    const partial = entry.revisions?.prepared ?? {};
    const terminal = entry.preparation?.terminalProof ?? {};
    return `<article class="card"><h3>Autopilot PR #${entry.number}</h3><dl><dt>HEAD</dt><dd>${escapeHtml(partial.headSha ?? "unavailable")}</dd><dt>Merge base</dt><dd>${escapeHtml(partial.mergeBaseSha ?? "unavailable")}</dd><dt>Partial HEAD graph</dt><dd>${escapeHtml(partial.graphId ?? "unavailable")}</dd><dt>Partial comparison graph</dt><dd>${escapeHtml(partial.comparisonGraphId ?? "unavailable")}</dd><dt>Pair ID</dt><dd>${escapeHtml(partial.pairId ?? "unavailable")}</dd><dt>Bounded terminal</dt><dd>${terminal.streamEnded === true && terminal.sameBoundedPair === true ? "ready → same-pair done → EOF" : "unverified"}</dd></dl></article>`;
  }).join("\n");
  const embedded = JSON.stringify(document).replace(/</g, "\\u003c");
  const notice = complete
    ? `<aside class="notice ok"><strong>Publishable absolute partial-runtime evidence.</strong> ${completed.length}/${configured} configured Autopilot PRs completed; every PR has one validated startup recording and one validated depth/search recording.</aside>`
    : `<aside class="notice"><strong>Not publishable yet.</strong> ${completed.length}/${configured} configured PRs complete. ${escapeHtml(document.failure?.message ?? document.diagnostic?.reason ?? "Collection is still running.")}</aside>`;
  const proofValue = (value) => complete ? escapeHtml(value) : "Unverified";
  const capabilityValue = complete ? "Absent" : "Unverified";
  const headline = complete
    ? "Absolute production evidence. No full graph lane was enabled or run."
    : "Evidence collection is incomplete. The zero-full claim is not yet verified.";
  const proofNarrative = complete
    ? "This run used the normal production listener and progressive-only isolated services. Every captured analyze request remained partial, every browser graph transfer used <code>/api/graph/project</code>, and every bounded preparation ended at ready → same-pair done → EOF with zero canonical continuation."
    : "This running or failed artifact is retained for diagnosis only. Its proof counters and capability state remain unverified until the complete document passes strict validation; no zero-full claim is made from this report.";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Meridian partial-runtime-only PR review evidence</title>
<style>
:root{color-scheme:dark;--bg:#091018;--panel:#101b27;--line:#26394b;--text:#edf6ff;--muted:#9db0c3;--blue:#65b5ff;--green:#55d99b;--amber:#f2bd66}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 18% -5%,#16334d,transparent 38%),var(--bg);color:var(--text);font:15px/1.55 ui-sans-serif,system-ui,sans-serif}main{width:min(1180px,calc(100% - 32px));margin:auto;padding:44px 0 72px}h1{font-size:clamp(32px,5vw,56px);line-height:1.04;letter-spacing:-.04em;margin:6px 0 14px}h2{margin:42px 0 12px}h3{margin:0 0 8px}p{color:var(--muted);max-width:90ch}.eyebrow{color:var(--blue);font-weight:800;letter-spacing:.12em;font-size:12px}.notice{padding:15px 17px;border:1px solid var(--line);border-left:3px solid var(--amber);border-radius:12px;background:#0f1924}.notice.ok{border-left-color:var(--green)}.proofs{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:12px}.proof,.card{border:1px solid var(--line);border-radius:14px;padding:17px;background:linear-gradient(145deg,#142231,#0c151e)}.proof strong{display:block;color:var(--green);font-size:24px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:14px}.table{overflow:auto;border:1px solid var(--line);border-radius:14px}table{width:100%;min-width:620px;border-collapse:collapse}th,td{padding:11px 13px;text-align:left;border-bottom:1px solid var(--line)}th{color:var(--muted);font-size:12px;text-transform:uppercase}video{width:100%;aspect-ratio:16/10;background:#000;border:1px solid var(--line);border-radius:10px;margin-top:10px}dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 10px;font-size:13px}dt{color:var(--muted)}dd{margin:0;overflow-wrap:anywhere;font-family:ui-monospace,monospace}code{color:#cce7ff}
</style></head><body><main>
<div class="eyebrow">MERIDIAN / PR REVIEW / PARTIAL RUNTIME ONLY</div><h1>${headline}</h1>
<p>Status: <strong>${escapeHtml(document.status ?? "unknown")}</strong> · generated ${escapeHtml(document.generatedAt ?? "unavailable")}</p>${notice}
<h2>Zero-full proof</h2><div class="proofs">
<article class="proof"><strong>${capabilityValue}</strong><span>Full-baseline capability on the normal listener and every isolated service</span></article>
<article class="proof"><strong>${proofValue(proof.canonicalRequests)}</strong><span>Canonical graph requests across measured journeys and ${proofValue(proof.continuationProofs)} terminal/dwell proofs</span></article>
<article class="proof"><strong>${proofValue(proof.canonicalResponses)}</strong><span>Canonical graph responses</span></article>
<article class="proof"><strong>${proofValue(proof.fullGenerationRequests)}</strong><span>Full graph generation requests before or after navigation</span></article>
<article class="proof"><strong>${proofValue(proof.canonicalReconciliationMarks)}</strong><span>Canonical reconciliation marks</span></article>
<article class="proof"><strong>${proofValue(proof.forbiddenAnalyzeRequests)}</strong><span>Analyze requests using a full body or capability header</span></article>
</div>
<p>${proofNarrative}</p>
<h2>Prepared production runtime · absolute measurements</h2><div class="table"><table><thead><tr><th>PR</th><th>Metric</th><th>Observed</th></tr></thead><tbody>${preparedRows}</tbody></table></div>
<h2>Fresh-service cold start · absolute measurements</h2><div class="table"><table><thead><tr><th>PR</th><th>Metric</th><th>Observed</th></tr></thead><tbody>${coldRows}</tbody></table></div>
<h2>Recordings</h2><p>Recordings, plural: each configured Autopilot PR contributes exactly two validated progressive videos—a cold startup journey and a separate adjustable-depth plus Cmd/Ctrl+P disconnected-search journey.</p><div class="grid">${recordingCards}</div>
<h2>Exact revisions and bounded terminal proof</h2><div class="grid">${revisionCards}</div>
<h2>Method and boundary</h2><article class="card"><p>These are current absolute observations only. Time to action comes from <code>meridian:first-actionable-canvas</code>; loading uses authoritative completed request-hop accounting; browser, service, and projection-worker memory retain their measured scope. No comparative lane was executed, so this report makes no comparative performance claim. Exact HEAD, merge base, graph IDs, request provenance, capability inspection, and recording hashes remain embedded below.</p></article>
<script id="meridian-poc-evidence" type="application/json">${embedded}</script>
</main></body></html>`;
}

function renderPartialOnlyHtmlReport(document) {
  const complete = document.status === "complete";
  const configured = Array.isArray(document.config?.prs) ? document.config.prs.length : 0;
  const completed = document.prs.filter((entry) => entry.status === "complete");
  const metricRows = completed.flatMap((entry) => {
    const full = entry.variants?.full?.summary ?? {};
    const progressive = entry.variants?.progressive?.summary ?? {};
    return [
      ["First-run time to action", full.firstActionableFirstMs, progressive.firstActionableFirstMs, "ms"],
      ["Warm time to action", full.firstActionableWarmMedianMs, progressive.firstActionableWarmMedianMs, "ms"],
      ["Settled loading", full.settledWarmMedianMs, progressive.settledWarmMedianMs, "ms"],
      ["Graph bytes at action", full.graphBytesAtAction, progressive.graphBytesAtAction, "bytes"],
      ["Prepared browser heap peak (lane-local)", full.browserJsHeapPeakBytes, progressive.browserJsHeapPeakBytes, "bytes"],
      ["Prepared browser RSS peak (lane-local)", full.browserRssPeakBytes, progressive.browserRssPeakBytes, "bytes"],
    ].map(([label, before, after, unit], index) => {
      const reduction = reductionPercent(before, after);
      return `<tr><td>${index === 0 ? `Autopilot #${entry.number}` : ""}</td><td>${escapeHtml(label)}</td><td>${formatMetric(before, unit)}</td><td>${formatMetric(after, unit)}</td><td class="${metricClass(reduction)}">${formatPercent(reduction)}</td></tr>`;
    });
  }).join("\n");
  const coldRows = completed.flatMap((entry) => {
    const full = entry.coldEndToEnd?.variants?.full;
    const progressive = entry.coldEndToEnd?.variants?.progressive;
    return [
      ["Prepare click to canvas action", full?.timings?.endToEndFirstActionableMs, progressive?.timings?.endToEndFirstActionableMs, "ms"],
      ["Partial pair terminal", null, progressive?.preparation?.milestones?.finalPairReadyMs, "ms"],
      ["Isolated cold service RSS peak", full?.coldServiceMemory?.peakRssBytes, progressive?.coldServiceMemory?.peakRssBytes, "bytes"],
      ["Isolated cold worker RSS peak", full?.coldServiceMemory?.workerPeakRssBytes, progressive?.coldServiceMemory?.workerPeakRssBytes, "bytes"],
    ].map(([label, before, after, unit], index) => `<tr><td>${index === 0 ? `Autopilot #${entry.number}` : ""}</td><td>${escapeHtml(label)}</td><td>${formatMetric(before, unit)}</td><td>${formatMetric(after, unit)}</td><td>${before === null ? "partial-only terminal" : formatPercent(reductionPercent(before, after))}</td></tr>`);
  }).join("\n");
  const recordingCards = document.prs.flatMap((entry) => [
    ...renderPartialOnlyRecordingGroup(entry, "startupRecordings", "Startup"),
    ...renderPartialOnlyRecordingGroup(entry, "recordings", "Depth + search"),
  ]).join("\n");
  const revisionCards = completed.map((entry) => {
    const partial = entry.revisions?.prepared ?? {};
    const canonical = entry.revisions?.canonicalBaseline ?? {};
    const proof = entry.preparation?.terminalProof ?? {};
    return `<article class="card"><h3>Autopilot PR #${entry.number}</h3><dl><dt>HEAD</dt><dd>${escapeHtml(partial.headSha ?? "unavailable")}</dd><dt>Merge base</dt><dd>${escapeHtml(partial.mergeBaseSha ?? "unavailable")}</dd><dt>Partial HEAD graph</dt><dd>${escapeHtml(partial.graphId ?? "unavailable")}</dd><dt>Partial comparison</dt><dd>${escapeHtml(partial.comparisonGraphId ?? "unavailable")}</dd><dt>Pair ID</dt><dd>${escapeHtml(partial.pairId ?? "unavailable")}</dd><dt>Stream terminal</dt><dd>${proof.streamEnded === true && proof.sameBoundedPair === true ? "ready → same-pair done → EOF" : "unverified"}</dd><dt>Post-navigation full graph</dt><dd>${proof.canonicalContinuationObserved === false ? "none" : "unverified"}</dd><dt>Full baseline graph</dt><dd>${escapeHtml(canonical.graphId ?? "unavailable")}</dd></dl></article>`;
  }).join("\n");
  const embedded = JSON.stringify(document).replace(/</g, "\\u003c");
  const notice = complete
    ? `<aside class="notice ok"><strong>Publishable partial-only evidence.</strong> ${completed.length}/${configured} configured Autopilot PRs completed with multiple validated recordings per PR.</aside>`
    : `<aside class="notice"><strong>Not publishable yet.</strong> ${completed.length}/${configured} configured PRs complete. ${escapeHtml(document.failure?.message ?? document.diagnostic?.reason ?? "Collection is still running.")}</aside>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Meridian partial-only PR review POC</title>
<style>
:root{color-scheme:dark;--bg:#091018;--panel:#101b27;--line:#26394b;--text:#edf6ff;--muted:#9db0c3;--blue:#65b5ff;--green:#55d99b;--amber:#f2bd66;--red:#ff8178}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 18% -5%,#16334d,transparent 38%),var(--bg);color:var(--text);font:15px/1.55 ui-sans-serif,system-ui,sans-serif}main{width:min(1180px,calc(100% - 32px));margin:auto;padding:44px 0 72px}h1{font-size:clamp(32px,5vw,56px);line-height:1.04;letter-spacing:-.04em;margin:6px 0 14px}h2{margin:42px 0 12px}h3{margin:0 0 8px}p{color:var(--muted);max-width:90ch}.eyebrow{color:var(--blue);font-weight:800;letter-spacing:.12em;font-size:12px}.notice{padding:15px 17px;border:1px solid var(--line);border-left:3px solid var(--amber);border-radius:12px;background:#0f1924}.notice.ok{border-left-color:var(--green)}.flow{display:grid;grid-template-columns:repeat(5,1fr);gap:10px}.step,.card{border:1px solid var(--line);border-radius:14px;padding:17px;background:linear-gradient(145deg,#142231,#0c151e)}.step b{display:block;margin-bottom:7px}.step span{color:var(--blue);font:700 11px ui-monospace}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:14px}.table{overflow:auto;border:1px solid var(--line);border-radius:14px}table{width:100%;min-width:780px;border-collapse:collapse}th,td{padding:11px 13px;text-align:left;border-bottom:1px solid var(--line)}th{color:var(--muted);font-size:12px;text-transform:uppercase}.positive{color:var(--green)}.negative{color:var(--red)}.neutral{color:var(--amber)}video{width:100%;aspect-ratio:16/10;background:#000;border:1px solid var(--line);border-radius:10px;margin-top:10px}dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 10px;font-size:13px}dt{color:var(--muted)}dd{margin:0;overflow-wrap:anywhere;font-family:ui-monospace,monospace}code{color:#cce7ff}@media(max-width:850px){.flow{grid-template-columns:1fr}}
</style></head><body><main>
<div class="eyebrow">MERIDIAN / PR REVIEW / PARTIAL ONLY</div><h1>Action first. The production review path never builds a full graph.</h1>
<p>Status: <strong>${escapeHtml(document.status ?? "unknown")}</strong> · generated ${escapeHtml(document.generatedAt ?? "unavailable")}</p>${notice}
<h2>Production path under test</h2><div class="flow">
<article class="step"><span>01</span><b>Resolve exact revision</b><p>Pin PR HEAD, merge base, and the complete changed-file manifest.</p></article>
<article class="step"><span>02</span><b>Extract + project depth 1</b><p>The affected files and their first import, dynamic-import, and exact IPC neighbours form the actionable graph; its outer ring is the initial ghost frontier.</p></article>
<article class="step"><span>03</span><b>Navigate on ready</b><p><code>ready</code> is followed by the same bounded <code>done</code> and NDJSON EOF.</p></article>
<article class="step"><span>04</span><b>Expand incrementally</b><p>The exact depth-2 slice is the only automatic warm. Deeper depth choices, ghosts, and disconnected search picks request new cumulative partial slices only after a reader action.</p></article>
<article class="step"><span>05</span><b>Index without a graph</b><p>A disposable syntax-only scan emits compact symbols and source topology; it never constructs the full semantic artifact.</p></article>
</div>
<p>The <code>progressive:false</code> complete artifact exists here only as a controlled measurement baseline. It is never started after a partial review navigates. Post-terminal proof combines stream EOF, zero canonical graph transport or generation, absence of the retired reconciliation mark, zero repository-analysis workers at EOF, and route authorization for any bounded partial/source-index worker observed later in the dwell.</p>
<h2>Prepared delivery</h2><div class="table"><table><thead><tr><th>PR</th><th>Metric</th><th>Full baseline</th><th>Partial-only</th><th>Reduction</th></tr></thead><tbody>${metricRows}</tbody></table></div>
<h2>Cold start</h2><div class="table"><table><thead><tr><th>PR</th><th>Metric</th><th>Full baseline</th><th>Partial-only</th><th>Reduction</th></tr></thead><tbody>${coldRows}</tbody></table></div>
<h2>Recordings</h2><p>These are recordings, plural: every configured Autopilot PR contributes a startup pair and a separate depth/search pair. Video codec, dimensions, sampled-frame motion, luminance, size, and SHA-256 are validated before publication.</p><div class="grid">${recordingCards}</div>
<h2>Exact revisions and terminal proof</h2><div class="grid">${revisionCards}</div>
	<h2>Method and boundaries</h2><article class="card"><p>Time to action is the renderer-owned <code>meridian:first-actionable-canvas</code> mark. Loading bytes use the CDP request-hop ledger and require authoritative terminal totals. Prepared browser heap and browser-process RSS are lane-local measurements. The prepared full/partial samples alternate against one long-lived service, so their service and worker RSS are deliberately excluded from reduction claims; service and disposable-worker comparisons come only from isolated cold lanes with a fresh service and cache per variant. Progressive samples must use only <code>/api/graph/project</code>; full baselines must use only <code>/api/graph</code>. Adjustable-depth and Cmd/Ctrl+P recordings must show a nonresident symbol hydrating to ready and increasing the canvas. Exact HEAD, merge base, graph IDs, and changed-file rows are retained in the embedded evidence below.</p></article>
<script id="meridian-poc-evidence" type="application/json">${embedded}</script>
</main></body></html>`;
}

function renderPartialOnlyRecordingGroup(entry, field, label) {
  return ["full", "progressive"].flatMap((variant) => {
    const recording = entry[field]?.[variant];
    if (recording === undefined || recording === null) return [];
    const validation = recording.validation ?? {};
    const evidence = field === "recordings"
      ? renderPartialOnlyFunctionalityEvidence(recording, variant)
      : renderPartialOnlyStartupEvidence(recording, variant);
    return [`<article class="card"><h3>PR #${entry.number} · ${escapeHtml(label)} · ${variant === "full" ? "full baseline" : "partial-only"}</h3><video controls preload="metadata" src="${escapeAttribute(recording.relativePath)}"></video><dl>${evidence}<dt>Codec</dt><dd>${escapeHtml(validation.codec ?? "unavailable")}</dd><dt>Duration</dt><dd>${formatFixed(validation.durationSeconds, 2)}s</dd><dt>Resolution</dt><dd>${escapeHtml(validation.width ?? "?")}×${escapeHtml(validation.height ?? "?")}</dd><dt>Frames</dt><dd>${escapeHtml(validation.distinctFrames ?? "?")} distinct / ${escapeHtml(validation.sampledFrames ?? "?")} sampled</dd><dt>SHA-256</dt><dd>${escapeHtml(validation.sha256 ?? "unavailable")}</dd></dl></article>`];
  });
}

function renderPartialOnlyFunctionalityEvidence(recording, variant) {
  const interaction = recording.interaction ?? {};
  const symbol = interaction.symbol ?? {};
  const background = interaction.backgroundSymbolIndex ?? {};
  const acceptance = background.acceptanceMark ?? {};
  const accepted = variant === "progressive"
    ? background.rendererInitiated === true
      && background.complete === true
      && acceptance.name === "meridian:progressive-symbol-index-ready"
    : null;
  return `<dt>Depth adjustment</dt><dd>${variant === "progressive" ? formatProof(interaction.depthAdjusted) : "full baseline control"}</dd><dt>Selected symbol</dt><dd>${escapeHtml(symbol.displayName ?? "unavailable")} · ${escapeHtml(symbol.id ?? "unavailable")}</dd><dt>Disconnected before search</dt><dd>${variant === "progressive" ? formatProof(interaction.disconnectedBeforeSearch) : "paired-symbol baseline"}</dd><dt>Search hydration</dt><dd>${formatProof(interaction.searchHydrated)}</dd><dt>Background index accepted</dt><dd>${variant === "progressive" ? `${formatProof(accepted)} · ${escapeHtml(background.indexedSymbolCount ?? "?")} symbols` : "not applicable"}</dd><dt>Canvas growth</dt><dd>${escapeHtml(interaction.canvasNodesBeforeSearch ?? "?")} → ${escapeHtml(interaction.canvasNodesAfterSearch ?? "?")}</dd>`;
}

function renderPartialOnlyStartupEvidence(recording, variant) {
  const timings = recording.timings ?? {};
  const terminal = recording.terminalProof ?? {};
  const continuation = recording.continuationProof ?? {};
  const graphWork = continuation.postReadyGraphWork ?? {};
  const terminalProof = terminal.streamEnded === true
    && terminal.sameBoundedPair === true
    && terminal.canonicalContinuationObserved === false;
  const continuationProof = variant === "progressive"
    ? continuation.canonicalGraphRequests === 0
      && continuation.canonicalGraphResponses === 0
      && graphWork.fullGenerationRequests === 0
    : null;
  return `<dt>Flow</dt><dd>${escapeHtml(recording.flow ?? "unavailable")}</dd><dt>Partial ready</dt><dd>${formatMetric(timings.provisionalReadyObservedMs, "ms")}</dd><dt>Partial terminal</dt><dd>${formatMetric(timings.partialTerminalDoneMs, "ms")}</dd><dt>Canonical baseline done</dt><dd>${variant === "full" ? formatMetric(timings.canonicalBaselineDoneMs, "ms") : "not started"}</dd><dt>Navigation request</dt><dd>${formatMetric(timings.navigationStartedMs, "ms")} · ${recording.navigation?.source === "playwright-main-document-request" ? "actual main document" : "unverified"}</dd><dt>First actionable after navigation</dt><dd>${formatMetric(timings.firstActionableBrowserMs, "ms")}</dd><dt>Ready → same-pair done → EOF</dt><dd>${formatProof(terminalProof)}</dd><dt>Zero full continuation</dt><dd>${variant === "progressive" ? formatProof(continuationProof) : "explicit full baseline"}</dd><dt>Post-terminal dwell</dt><dd>${variant === "progressive" ? formatMetric(continuation.postTerminalDwellMs, "ms") : "not applicable"}</dd><dt>Bounded work delta</dt><dd>${variant === "progressive" ? `${escapeHtml(graphWork.partialProjectionRequests ?? "?")} project · ${escapeHtml(graphWork.partialProjectionWarmRequests ?? "?")} warm · ${escapeHtml(graphWork.sourceIndexRequests ?? "?")} index` : "not applicable"}</dd>`;
}

export function renderHtmlReport(input) {
  const document = validateResultsDocument(input);
  if (document.config?.deliveryContract === PARTIAL_RUNTIME_ONLY_DELIVERY_CONTRACT) {
    return renderPartialRuntimeOnlyHtmlReport(document);
  }
  if (document.config?.deliveryContract === PARTIAL_ONLY_DELIVERY_CONTRACT) {
    return renderPartialOnlyHtmlReport(document);
  }
  const aggregate = document.aggregate;
  const coldAggregate = document.coldAggregate;
  const completed = document.prs.filter((entry) => entry.variants?.full?.summary && entry.variants?.progressive?.summary);
  const coldCompleted = document.prs.filter((entry) =>
    entry.coldEndToEnd?.variants?.full && entry.coldEndToEnd?.variants?.progressive,
  );
  const generated = escapeHtml(document.generatedAt ?? new Date().toISOString());
  const status = escapeHtml(document.status ?? "unknown");
  const rows = completed.map(renderPrMetricRows).join("\n");
  const coldRows = coldCompleted.map(renderColdPrMetricRows).join("\n");
  const recordings = document.prs.map(renderRecording).join("\n");
  const handoffRecordings = document.prs.map(renderHandoffRecording).join("\n");
  const screenshots = document.prs.map(renderScreenshots).filter((value) => value !== "").join("\n");
  const revisions = document.status === "complete"
    ? document.prs.map(renderRevision).join("\n")
    : "<p>Semantic revision and base-tip observations are partial and not verified for publication.</p>";
  const aggregateCards = aggregate === null ? "<p>No complete comparison is available.</p>" : renderAggregateCards(aggregate);
  const coldAggregateCards = coldAggregate === null
    ? "<p>No isolated cold end-to-end comparison is available.</p>"
    : renderColdAggregateCards(coldAggregate);
  const publicationNotice = renderPublicationNotice(document);
  const runFacts = renderRunFacts(document);
  const json = JSON.stringify(document).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Meridian progressive PR graph POC</title>
  <style>
    :root { color-scheme: dark; --bg:#0b0f14; --panel:#111821; --line:#273445; --muted:#9aa8b7; --text:#edf4fb; --blue:#5ca9ff; --green:#4dd68c; --amber:#f0b95b; --red:#ff7b72; }
    * { box-sizing: border-box; }
    body { margin:0; background:radial-gradient(circle at 15% -10%,#152b43 0,transparent 38%),var(--bg); color:var(--text); font:15px/1.5 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    main { width:min(1180px,calc(100% - 40px)); margin:0 auto; padding:48px 0 80px; }
    h1 { font-size:clamp(30px,5vw,54px); line-height:1.05; letter-spacing:-.035em; margin:8px 0 14px; }
    h2 { margin:44px 0 14px; font-size:24px; }
    h3 { margin:0 0 8px; font-size:18px; }
    p { color:var(--muted); max-width:82ch; }
    code { color:#c9e2ff; }
    .eyebrow { color:var(--blue); font-weight:750; letter-spacing:.12em; font-size:12px; }
    .status { display:inline-flex; padding:4px 9px; border:1px solid var(--line); border-radius:999px; color:var(--muted); font-size:12px; }
    .notice { margin:18px 0 0; padding:14px 16px; border:1px solid var(--line); border-left:3px solid var(--amber); border-radius:10px; background:rgba(17,24,33,.86); }
    .notice.publishable { border-left-color:var(--green); }
    .notice strong { color:var(--text); }
    .pipeline { display:grid; grid-template-columns:repeat(5,minmax(0,1fr)); gap:10px; margin:20px 0 8px; }
    .pipeline-step { position:relative; min-height:138px; padding:16px; border:1px solid var(--line); border-radius:14px; background:linear-gradient(145deg,rgba(22,31,42,.96),rgba(13,19,27,.96)); }
    .pipeline-step:not(:last-child)::after { content:"→"; position:absolute; z-index:1; top:50%; right:-17px; width:24px; color:var(--blue); font-size:20px; font-weight:800; text-align:center; transform:translateY(-50%); }
    .pipeline-step strong { display:block; margin:4px 0 7px; }
    .pipeline-step p { margin:0; font-size:12px; line-height:1.45; }
    .pipeline-index { color:var(--blue); font:700 11px/1 ui-monospace,SFMono-Regular,Menlo,monospace; letter-spacing:.08em; }
    .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(210px,1fr)); gap:12px; margin:24px 0; }
    .card,.recording,.revision,.method { background:linear-gradient(145deg,rgba(22,31,42,.96),rgba(13,19,27,.96)); border:1px solid var(--line); border-radius:14px; padding:18px; box-shadow:0 12px 35px rgba(0,0,0,.16); }
    .metric { font-size:31px; font-weight:760; letter-spacing:-.035em; }
    .positive { color:var(--green); } .negative { color:var(--red); } .neutral { color:var(--amber); }
    .label { color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.07em; }
    .table-wrap { overflow:auto; border:1px solid var(--line); border-radius:14px; background:rgba(13,19,27,.9); }
    table { width:100%; border-collapse:collapse; min-width:850px; }
    th,td { text-align:left; padding:12px 14px; border-bottom:1px solid var(--line); vertical-align:middle; }
    th { color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.06em; }
    tr:last-child td { border-bottom:0; }
    .bar { width:150px; height:8px; background:#1b2734; border-radius:99px; overflow:hidden; display:inline-block; margin-right:8px; vertical-align:middle; }
    .bar > i { display:block; height:100%; background:linear-gradient(90deg,var(--blue),var(--green)); border-radius:inherit; }
    .recordings,.revisions,.screenshots { display:grid; grid-template-columns:repeat(auto-fit,minmax(320px,1fr)); gap:16px; }
    video,img.evidence { display:block; width:100%; aspect-ratio:16/10; margin-top:12px; border-radius:10px; background:#000; border:1px solid #29384a; object-fit:contain; }
    dl { display:grid; grid-template-columns:max-content 1fr; gap:4px 12px; margin:10px 0 0; font-size:13px; }
    dt { color:var(--muted); } dd { margin:0; overflow-wrap:anywhere; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
    .method { border-left:3px solid var(--blue); }
    .foot { margin-top:40px; padding-top:18px; border-top:1px solid var(--line); font-size:13px; }
    @media (max-width:900px) { .pipeline { grid-template-columns:1fr; } .pipeline-step { min-height:0; } .pipeline-step:not(:last-child)::after { content:"↓"; top:auto; right:50%; bottom:-20px; transform:translateX(50%); } }
    @media (max-width:600px) { main { width:min(100% - 24px,1180px); padding-top:28px; } .recordings,.revisions { grid-template-columns:1fr; } }
  </style>
</head>
<body>
<main>
  <div class="eyebrow">MERIDIAN / PR REVIEW</div>
  <h1>Progressive graph: action, loading &amp; memory</h1>
  <span class="status">${status} · generated ${generated}</span>
  <p>Cold progressive delivery navigates from a revision-bound depth-1 pair and terminates preparation there. The production review path keeps only bounded projections; the explicit benchmark-only compatibility lane measures the historical full artifact outside that path. Live target-branch tips are observed separately and may advance while each lane's semantic identity remains exact. Lower time, transfer, and memory values are better.</p>
  ${publicationNotice}

  <h2>What changed</h2>
  <div class="pipeline" aria-label="Progressive PR graph delivery pipeline">
    <article class="pipeline-step"><span class="pipeline-index">01</span><strong>Resolve exact PR files</strong><p>Bind HEAD and merge base, observe the live base tip, and capture the complete changed-file manifest before graph admission.</p></article>
    <article class="pipeline-step"><span class="pipeline-index">02</span><strong>Project depth 1</strong><p>Run deterministic weak BFS from every affected file over resolved imports, literal dynamic imports, and exact IPC joins.</p></article>
    <article class="pipeline-step"><span class="pipeline-index">03</span><strong>Navigate on ready</strong><p>Publish the exact provisional pair only after both depth-1 projections are reserved and ready. The landing reader cancels and navigates immediately.</p></article>
    <article class="pipeline-step"><span class="pipeline-index">04</span><strong>Expand only on demand</strong><p>Prepare exact depth 2 after first action, then request deeper or disconnected slices only when the reviewer asks for them.</p></article>
    <article class="pipeline-step"><span class="pipeline-index">05</span><strong>Index and hydrate search</strong><p>Build compact symbols in a disposable server worker, retain and query them in a browser worker, then load a disconnected Cmd/Ctrl+P pick's depth-1 neighbourhood before adding it.</p></article>
  </div>
  <p>There is no production full-graph fallback. Unmarked copied review URLs, projection failures, stale generations, and protocol mismatches fail closed; bounded slices never mutate their revision source.</p>

  <h2>Cold end-to-end: fresh clone to early shell and canvas</h2>
  <p>Each variant and PR runs in its own fresh Meridian process and <code>MERIDIAN_CACHE_DIR</code>. The clock starts before <code>/api/pr/prepare</code>. Progressive production preparation terminates at the exact bounded-pair <code>ready</code> event; the benchmark-only full lane is isolated behind an explicit capability.</p>
  ${coldAggregateCards}
  <div class="table-wrap"><table>
    <thead><tr><th>PR</th><th>Cold metric</th><th>Full graph</th><th>Progressive</th><th>Reduction</th><th>Relative</th></tr></thead>
    <tbody>${coldRows}</tbody>
  </table></div>

  <h2>Prepared delivery outcome</h2>
  ${aggregateCards}

  <h2>Prepared delivery per-PR measurements</h2>
  <div class="table-wrap"><table>
    <thead><tr><th>PR</th><th>Metric</th><th>Full graph</th><th>Progressive</th><th>Reduction</th><th>Relative</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>

  <h2>Cold handoff recordings</h2>
  <p>These matched recordings visibly show the production difference: the benchmark-only full baseline remains on preparation for the complete artifact, while progressive production leaves at bounded-pair <code>ready</code> and becomes actionable without starting a full continuation. Every configured Autopilot PR contributes both recordings.</p>
  <div class="recordings">${handoffRecordings}</div>

  <h2>Functionality recordings</h2>
  <p>Each PR also has a matched prepared-delivery recording validating adjustable depth, background symbol indexing, Cmd/Ctrl+P hydration, and canvas growth on the same canonical revision.</p>
  <div class="recordings">${recordings}</div>

  ${screenshots === "" ? "" : `<h2>Scene evidence</h2><div class="screenshots">${screenshots}</div>`}

  <h2>Semantic graph identity &amp; live base-tip provenance</h2>
  <div class="revisions">${revisions}</div>

  <h2>Method</h2>
  <div class="method">
    <p><strong>Provisional-ready TTA</strong> is measured in the landing browser from the actual prepare-request start to resolution of the production <code>preparePrReview</code> promise with a validated <code>stage: ready</code> pair. The independent Node subscriber timestamps the same ready line and continues to canonical <code>done</code>. <strong>Canvas time to action</strong> uses <code>meridian:first-actionable-canvas</code>. Progressive <strong>settled loading</strong> additionally requires exactly one <code>meridian:pr-canonical-graph-reconciled</code> mark bound to the canonical HEAD graph, then fonts and two animation frames.</p>
    <p><strong>Cold end-to-end</strong> and <strong>prepared delivery</strong> are separate evidence lanes. Cold uses one fresh, isolated service/cache per variant and PR, counterbalances variant order across PRs, and starts its client clock before preparation. Its cumulative prepare→canvas fields include the server's depth-1/prefetch-3 projection warming. Prepared delivery uses the already-published immutable semantic pair and keeps first-run values separate from warm medians. Semantic identity is the exact HEAD, merge base, HEAD graph ID, and comparison graph ID. The live base tip is separately observed before each long lane, at preparation/navigation terminals, and after collection; base-only movement is recorded, while semantic, ref, or repository movement fails publication. The full compatibility baseline explicitly removes the progressive URL opt-in and must use only canonical graph responses. Progressive publication requires both initial requests to be ready cache hits on the exact terminal HEAD/comparison keys. Playwright records renderer-owned initial projection and next-depth warm responses as transport-only and never duplicate-reads their bodies; renderer acceptance/action marks prove the bodies became the active review. Tagged replays acquire both opaque next-depth keys before readiness is polled; both keys must be ready before either critical same-key hit is requested.</p>
    <p>Graph transfer is collected by a CDP hop ledger. <code>Network.loadingFinished</code> totals are authoritative; in-flight or failed chunks remain lower-bound diagnostics. A renderer-consumed <code>ERR_ABORTED</code> stream is reconstructable only when its exact immutable <code>Content-Length</code> was fully observed. Redirects, request-ID reuse, browser caches, blocked requests, and accounting anomalies are retained explicitly, and incomplete graph accounting cannot be published. Background symbol indexing remains in total/by-path diagnostics but is outside the initial graph-transfer boundary. Browser heap and browser process-tree RSS are labeled separately as observed peak and settled retained values. Cold service/worker peaks are the maximum of a 500 ms lifecycle sampler and a 100 ms review-browser-phase sampler; retained values come from the lifecycle sampler's final post-settled snapshot.</p>
    <p>Cold milestones are client-observed NDJSON arrivals. Publishable evidence requires <code>manifest-ready → ready → done</code> ordering, exact provisional pair IDs derived from the pair ID and revisions, identical provisional/canonical manifests and SHAs, distinct bounded/canonical graph IDs, an independent completion subscriber, ready-before-navigation for progressive, done-before-navigation for full, and the canonical renderer mark after first action. It also requires validated cold-handoff recordings plus the existing paired interaction recordings for every PR.</p>
    <p><strong>Total measured RSS scope-sum</strong> adds the separately observed browser, Meridian service, and analysis/projection-worker scopes so background-worker cost is visible beside browser savings. The peak scope-sum is conservative: its component maxima are not claimed to be simultaneous. Retained scope values are sampled at the post-settled boundary.</p>
    ${runFacts}
  </div>

  <p class="foot">The complete machine-readable evidence is embedded below and also saved beside this report as <code>results.json</code>.</p>
  <script id="pr-review-poc-results" type="application/json">${json}</script>
</main>
</body>
</html>`;
}

export function redactSecrets(value) {
  let result = String(value ?? "");
  for (const pattern of SECRET_PATTERNS) result = result.replace(pattern, "[REDACTED]");
  return result;
}

function renderAggregateCards(aggregate) {
  const metrics = [
    ["First-run time to action", aggregate.full.firstActionableFirstMs, aggregate.progressive.firstActionableFirstMs, "ms"],
    ["Warm time to action", aggregate.full.firstActionableWarmMedianMs, aggregate.progressive.firstActionableWarmMedianMs, "ms"],
    ["First-run settled loading", aggregate.full.settledFirstMs, aggregate.progressive.settledFirstMs, "ms"],
    ["Warm settled loading", aggregate.full.settledWarmMedianMs, aggregate.progressive.settledWarmMedianMs, "ms"],
    ["Graph transfer at action", aggregate.full.graphBytesAtAction, aggregate.progressive.graphBytesAtAction, "bytes"],
    ["Graph transfer settled", aggregate.full.graphBytesSettled, aggregate.progressive.graphBytesSettled, "bytes"],
    ["Browser heap peak", aggregate.full.browserJsHeapPeakBytes, aggregate.progressive.browserJsHeapPeakBytes, "bytes"],
    ["Browser heap retained", aggregate.full.browserJsHeapRetainedBytes, aggregate.progressive.browserJsHeapRetainedBytes, "bytes"],
    ["Browser RSS peak", aggregate.full.browserRssPeakBytes, aggregate.progressive.browserRssPeakBytes, "bytes"],
    ["Browser RSS retained", aggregate.full.browserRssRetainedBytes, aggregate.progressive.browserRssRetainedBytes, "bytes"],
    ["Service RSS peak", aggregate.full.serviceRssPeakBytes, aggregate.progressive.serviceRssPeakBytes, "bytes"],
    ["Service RSS retained", aggregate.full.serviceRssRetainedBytes, aggregate.progressive.serviceRssRetainedBytes, "bytes"],
    ["Worker RSS peak", aggregate.full.workerRssPeakBytes, aggregate.progressive.workerRssPeakBytes, "bytes"],
    ["Worker RSS retained", aggregate.full.workerRssRetainedBytes, aggregate.progressive.workerRssRetainedBytes, "bytes"],
    ["Total measured RSS scope-sum peak", sumMetricValues(
      aggregate.full.browserRssPeakBytes,
      aggregate.full.serviceRssPeakBytes,
      aggregate.full.workerRssPeakBytes,
    ), sumMetricValues(
      aggregate.progressive.browserRssPeakBytes,
      aggregate.progressive.serviceRssPeakBytes,
      aggregate.progressive.workerRssPeakBytes,
    ), "bytes"],
    ["Total measured RSS scope-sum retained", sumMetricValues(
      aggregate.full.browserRssRetainedBytes,
      aggregate.full.serviceRssRetainedBytes,
      aggregate.full.workerRssRetainedBytes,
    ), sumMetricValues(
      aggregate.progressive.browserRssRetainedBytes,
      aggregate.progressive.serviceRssRetainedBytes,
      aggregate.progressive.workerRssRetainedBytes,
    ), "bytes"],
  ];
  return `<div class="cards">${metrics.map(([label, before, after, unit]) => {
    const improvement = reductionPercent(before, after);
    return `<article class="card"><div class="label">${escapeHtml(label)}</div><div class="metric ${metricClass(improvement)}">${formatPercent(improvement)}</div><div>${formatMetric(before, unit)} → ${formatMetric(after, unit)}</div></article>`;
  }).join("")}</div>`;
}

function renderColdAggregateCards(aggregate) {
  const metrics = [
    ["Early shell vs legacy full canvas", aggregate.full.endToEndFirstActionableMs, aggregate.full.landingShellActionableMs, "ms", true],
    ["Navigation gate: canonical done → provisional ready", aggregate.full.finalPairReadyMs, aggregate.progressive.provisionalReadyMs, "ms", true],
    ["Post-navigation browser action", aggregate.full.browserFirstActionableMs, aggregate.progressive.browserFirstActionableMs, "ms", true],
    ["Post-navigation browser settled", aggregate.full.browserSettledMs, aggregate.progressive.browserSettledMs, "ms", true],
    ["Landing shell action (run variance)", aggregate.full.landingShellActionableMs, aggregate.progressive.landingShellActionableMs, "ms", false],
    ["Cumulative prepare request → canvas", aggregate.full.prepareToFirstActionableMs, aggregate.progressive.prepareToFirstActionableMs, "ms", true],
    ["Cumulative prepare request → canonical-settled", aggregate.full.prepareToSettledMs, aggregate.progressive.prepareToSettledMs, "ms", true],
    ["Cold end-to-end canvas", aggregate.full.endToEndFirstActionableMs, aggregate.progressive.endToEndFirstActionableMs, "ms", true],
    ["Provisional-ready browser TTA (run variance)", aggregate.full.provisionalReadyTtaMs, aggregate.progressive.provisionalReadyTtaMs, "ms", false],
    ["Cold final pair ready (run variance)", aggregate.full.finalPairReadyMs, aggregate.progressive.finalPairReadyMs, "ms", false],
    ["Cold provisional projection pair ready", aggregate.full.initialProjectionPairReadyMs, aggregate.progressive.initialProjectionPairReadyMs, "ms", false],
    ["Canonical completion lag after ready", aggregate.full.canonicalCompletionLagMs, aggregate.progressive.canonicalCompletionLagMs, "ms", false],
    ["Cold manifest ready (run variance)", aggregate.full.manifestReadyMs, aggregate.progressive.manifestReadyMs, "ms", false],
    ["Cold service RSS peak (run variance)", aggregate.full.serviceRssPeakBytes, aggregate.progressive.serviceRssPeakBytes, "bytes", false],
    ["Cold worker RSS peak (run variance)", aggregate.full.workerRssPeakBytes, aggregate.progressive.workerRssPeakBytes, "bytes", false],
    ["Cold total RSS scope-sum peak (run variance)", sumMetricValues(
      aggregate.full.browserRssPeakBytes,
      aggregate.full.serviceRssPeakBytes,
      aggregate.full.workerRssPeakBytes,
    ), sumMetricValues(
      aggregate.progressive.browserRssPeakBytes,
      aggregate.progressive.serviceRssPeakBytes,
      aggregate.progressive.workerRssPeakBytes,
    ), "bytes", false],
    ["Cold total RSS scope-sum retained (run variance)", sumMetricValues(
      aggregate.full.browserRssRetainedBytes,
      aggregate.full.serviceRssRetainedBytes,
      aggregate.full.workerRssRetainedBytes,
    ), sumMetricValues(
      aggregate.progressive.browserRssRetainedBytes,
      aggregate.progressive.serviceRssRetainedBytes,
      aggregate.progressive.workerRssRetainedBytes,
    ), "bytes", false],
  ];
  return `<div class="cards">${metrics.map(([label, before, after, unit, causal]) => {
    const improvement = reductionPercent(before, after);
    const headline = causal ? formatPercent(improvement) : "non-causal";
    return `<article class="card"><div class="label">${escapeHtml(label)}</div><div class="metric ${causal ? metricClass(improvement) : "neutral"}">${headline}</div><div>${formatMetric(before, unit)} → ${formatMetric(after, unit)}</div></article>`;
  }).join("")}</div>`;
}

function renderColdPrMetricRows(entry) {
  const full = entry.coldEndToEnd.variants.full;
  const progressive = entry.coldEndToEnd.variants.progressive;
  const metrics = [
    ["Landing exact-file shell actionable", full.timings?.landingShellActionableMs, progressive.timings?.landingShellActionableMs, "ms", false],
    ["Provisional-ready browser TTA", full.timings?.provisionalReadyTtaMs, progressive.timings?.provisionalReadyTtaMs, "ms", false],
    ["Provisional pair ready", full.preparation?.milestones?.provisionalReadyMs, progressive.preparation?.milestones?.provisionalReadyMs, "ms", false],
    ["Navigation started", full.timings?.navigationStartedMs, progressive.timings?.navigationStartedMs, "ms", true],
    ["Cumulative prepare request → canvas", full.timings?.prepareToFirstActionableMs, progressive.timings?.prepareToFirstActionableMs, "ms", true],
    ["Cumulative prepare request → canonical-settled", full.timings?.prepareToSettledMs, progressive.timings?.prepareToSettledMs, "ms", true],
    ["End-to-end canvas action", full.timings?.endToEndFirstActionableMs, progressive.timings?.endToEndFirstActionableMs, "ms", true],
    ["End-to-end canonical-settled load", full.timings?.endToEndSettledMs, progressive.timings?.endToEndSettledMs, "ms", true],
    ["Clone started", full.preparation?.milestones?.cloneStartedMs, progressive.preparation?.milestones?.cloneStartedMs, "ms", false],
    ["Checkout started", full.preparation?.milestones?.checkoutStartedMs, progressive.preparation?.milestones?.checkoutStartedMs, "ms", false],
    ["Analysis started", full.preparation?.milestones?.analysisStartedMs, progressive.preparation?.milestones?.analysisStartedMs, "ms", false],
    ["HEAD extraction complete", full.preparation?.milestones?.headExtractionCompletedMs, progressive.preparation?.milestones?.headExtractionCompletedMs, "ms", false],
    ["Merge-base extraction complete", full.preparation?.milestones?.comparisonExtractionCompletedMs, progressive.preparation?.milestones?.comparisonExtractionCompletedMs, "ms", false],
    ["Canonical graph pair ready", full.preparation?.milestones?.finalPairReadyMs, progressive.preparation?.milestones?.finalPairReadyMs, "ms", false],
    ["Ready → canonical completion lag", full.preparation?.milestones?.canonicalCompletionLagMs, progressive.preparation?.milestones?.canonicalCompletionLagMs, "ms", false],
    ["Manifest ready", full.preparation?.milestones?.manifestReadyMs, progressive.preparation?.milestones?.manifestReadyMs, "ms", false],
    ["Post-navigation browser time to action", full.timings?.browserFirstActionableMs, progressive.timings?.browserFirstActionableMs, "ms", true],
    ["Post-navigation browser settled load", full.timings?.browserSettledMs, progressive.timings?.browserSettledMs, "ms", true],
    ["Renderer canonical reconciliation", full.timings?.canonicalReconciledMs, progressive.timings?.canonicalReconciledMs, "ms", false],
    ["Browser heap peak", full.memoryPeak?.browserJsHeapUsedBytes, progressive.memoryPeak?.browserJsHeapUsedBytes, "bytes", true],
    ["Browser heap retained", full.memorySettled?.browserJsHeapUsedBytes, progressive.memorySettled?.browserJsHeapUsedBytes, "bytes", true],
    ["Browser RSS peak", full.memoryPeak?.browserProcessRssBytes, progressive.memoryPeak?.browserProcessRssBytes, "bytes", true],
    ["Browser RSS retained", full.memorySettled?.browserProcessRssBytes, progressive.memorySettled?.browserProcessRssBytes, "bytes", true],
    ["Service RSS peak", full.coldServiceMemory?.peakRssBytes, progressive.coldServiceMemory?.peakRssBytes, "bytes", false],
    ["Service RSS retained", full.coldServiceMemory?.retainedRssBytes, progressive.coldServiceMemory?.retainedRssBytes, "bytes", false],
    ["Analysis/projection workers peak", full.coldServiceMemory?.workerPeakRssBytes, progressive.coldServiceMemory?.workerPeakRssBytes, "bytes", false],
    ["Analysis/projection workers retained", full.coldServiceMemory?.workerRetainedRssBytes, progressive.coldServiceMemory?.workerRetainedRssBytes, "bytes", false],
    ["Total measured RSS scope-sum peak", sumMetricValues(
      full.memoryPeak?.browserProcessRssBytes,
      full.coldServiceMemory?.peakRssBytes,
      full.coldServiceMemory?.workerPeakRssBytes,
    ), sumMetricValues(
      progressive.memoryPeak?.browserProcessRssBytes,
      progressive.coldServiceMemory?.peakRssBytes,
      progressive.coldServiceMemory?.workerPeakRssBytes,
    ), "bytes", false],
    ["Total measured RSS scope-sum retained", sumMetricValues(
      full.memorySettled?.browserProcessRssBytes,
      full.coldServiceMemory?.retainedRssBytes,
      full.coldServiceMemory?.workerRetainedRssBytes,
    ), sumMetricValues(
      progressive.memorySettled?.browserProcessRssBytes,
      progressive.coldServiceMemory?.retainedRssBytes,
      progressive.coldServiceMemory?.workerRetainedRssBytes,
    ), "bytes", false],
  ];
  return metrics.map(([label, before, after, unit, causal], index) => {
    const improvement = reductionPercent(before, after);
    const relativePercent = finiteNumber(before) && before > 0 && finiteNumber(after) ? (after / before) * 100 : null;
    const relativeWidth = relativePercent === null ? 0 : Math.max(2, Math.min(100, relativePercent));
    const prCell = index === 0
      ? `<td rowspan="${metrics.length}"><strong>#${entry.number}</strong><br><span class="label">fresh isolated caches</span></td>`
      : "";
    const beforeDisplay = index === 0
      ? formatClockEstimate(before, full.landingShell?.clockAlignment?.resolvedUncertaintyMs)
      : formatMetric(before, unit);
    const afterDisplay = index === 0
      ? formatClockEstimate(after, progressive.landingShell?.clockAlignment?.resolvedUncertaintyMs)
      : formatMetric(after, unit);
    return `<tr>${prCell}<td>${escapeHtml(label)}</td><td>${beforeDisplay}</td><td>${afterDisplay}</td><td class="${causal ? metricClass(improvement) : "neutral"}">${causal ? formatPercent(improvement) : "environmental variance"}</td><td><span class="bar"><i style="width:${relativeWidth.toFixed(1)}%"></i></span>${relativePercent === null ? "n/a" : `${relativePercent.toFixed(0)}%`}</td></tr>`;
  }).join("\n");
}

function renderPrMetricRows(entry) {
  const full = entry.variants.full.summary;
  const progressive = entry.variants.progressive.summary;
  const metrics = [
    ["First-run time to action", full.firstActionableFirstMs, progressive.firstActionableFirstMs, "ms"],
    ["Warm time to action", full.firstActionableWarmMedianMs, progressive.firstActionableWarmMedianMs, "ms"],
    ["All-sample time to action", full.firstActionableMs, progressive.firstActionableMs, "ms"],
    ["First-run settled load", full.settledFirstMs, progressive.settledFirstMs, "ms"],
    ["Warm settled load", full.settledWarmMedianMs, progressive.settledWarmMedianMs, "ms"],
    ["All-sample settled load", full.settledMs, progressive.settledMs, "ms"],
    ["Graph bytes at action", full.graphBytesAtAction, progressive.graphBytesAtAction, "bytes"],
    ["Graph bytes settled", full.graphBytesSettled, progressive.graphBytesSettled, "bytes"],
    ["Browser heap peak", full.browserJsHeapPeakBytes, progressive.browserJsHeapPeakBytes, "bytes"],
    ["Browser heap retained", full.browserJsHeapRetainedBytes, progressive.browserJsHeapRetainedBytes, "bytes"],
    ["Browser RSS peak", full.browserRssPeakBytes, progressive.browserRssPeakBytes, "bytes"],
    ["Browser RSS retained", full.browserRssRetainedBytes, progressive.browserRssRetainedBytes, "bytes"],
    ["Service RSS peak", full.serviceRssPeakBytes, progressive.serviceRssPeakBytes, "bytes"],
    ["Service RSS retained", full.serviceRssRetainedBytes, progressive.serviceRssRetainedBytes, "bytes"],
    ["Worker RSS peak", full.workerRssPeakBytes, progressive.workerRssPeakBytes, "bytes"],
    ["Worker RSS retained", full.workerRssRetainedBytes, progressive.workerRssRetainedBytes, "bytes"],
    ["Total measured RSS scope-sum peak", sumMetricValues(
      full.browserRssPeakBytes,
      full.serviceRssPeakBytes,
      full.workerRssPeakBytes,
    ), sumMetricValues(
      progressive.browserRssPeakBytes,
      progressive.serviceRssPeakBytes,
      progressive.workerRssPeakBytes,
    ), "bytes"],
    ["Total measured RSS scope-sum retained", sumMetricValues(
      full.browserRssRetainedBytes,
      full.serviceRssRetainedBytes,
      full.workerRssRetainedBytes,
    ), sumMetricValues(
      progressive.browserRssRetainedBytes,
      progressive.serviceRssRetainedBytes,
      progressive.workerRssRetainedBytes,
    ), "bytes"],
  ];
  return metrics.map(([label, before, after, unit], index) => {
    const improvement = reductionPercent(before, after);
    const relativePercent = finiteNumber(before) && before > 0 && finiteNumber(after)
      ? (after / before) * 100
      : null;
    const relativeWidth = relativePercent === null ? 0 : Math.max(2, Math.min(100, relativePercent));
    const prCell = index === 0
      ? `<td rowspan="${metrics.length}"><strong>#${entry.number}</strong><br><span class="label">${escapeHtml(entry.title ?? "")}</span></td>`
      : "";
    return `<tr>${prCell}<td>${escapeHtml(label)}</td><td>${formatMetric(before, unit)}</td><td>${formatMetric(after, unit)}</td><td class="${metricClass(improvement)}">${formatPercent(improvement)}</td><td><span class="bar"><i style="width:${relativeWidth.toFixed(1)}%"></i></span>${relativePercent === null ? "n/a" : `${relativePercent.toFixed(0)}%`}</td></tr>`;
  }).join("\n");
}

function renderRecording(entry) {
  const recordings = entry.recordings ?? {};
  return ["full", "progressive"].map((variant) => {
    const recording = recordings[variant];
    const label = variant === "full" ? "Full baseline" : "Progressive";
    if (!recording) {
      return `<article class="recording"><h3>PR #${entry.number} · ${label}</h3><p>No verified recording was produced.</p></article>`;
    }
    const validation = recording.validation ?? {};
    return `<article class="recording"><h3>PR #${entry.number} · ${label}</h3><p>${escapeHtml(recording.interaction?.summary ?? `${label} review boot`)}</p><video controls preload="metadata" src="${escapeAttribute(recording.relativePath)}"></video><dl><dt>Duration</dt><dd>${formatFixed(validation.durationSeconds, 2)}s</dd><dt>Resolution</dt><dd>${escapeHtml(validation.width ?? "?")}x${escapeHtml(validation.height ?? "?")}</dd><dt>Frames checked</dt><dd>${escapeHtml(validation.sampledFrames ?? "?")} (${escapeHtml(validation.distinctFrames ?? "?")} distinct)</dd><dt>Depth adjusted</dt><dd>${variant === "progressive" ? formatProof(recording.interaction?.depthAdjusted) : "not applicable"}</dd><dt>Search hydration</dt><dd>${formatProof(recording.interaction?.searchHydrated)}</dd><dt>Nonresident before search</dt><dd>${variant === "progressive" ? formatProof(recording.interaction?.disconnectedBeforeSearch) : "paired symbol"}</dd><dt>Background index</dt><dd>${variant === "progressive" ? formatProof(recording.interaction?.backgroundSymbolIndex?.rendererInitiated) : "not applicable"}</dd><dt>Selected symbol</dt><dd>${escapeHtml(recording.interaction?.symbol?.displayName ?? "unavailable")}</dd><dt>Canvas growth</dt><dd>${escapeHtml(recording.interaction?.canvasNodesBeforeSearch ?? "?")} → ${escapeHtml(recording.interaction?.canvasNodesAfterSearch ?? "?")}</dd><dt>SHA-256</dt><dd>${escapeHtml(validation.sha256 ?? "unavailable")}</dd></dl></article>`;
  }).join("\n");
}

function renderHandoffRecording(entry) {
  const recordings = entry.handoffRecordings ?? {};
  return ["full", "progressive"].map((variant) => {
    const recording = recordings[variant];
    const label = variant === "full" ? "Full · canonical gate" : "Progressive · ready gate";
    if (!recording) {
      return `<article class="recording"><h3>PR #${entry.number} · ${label}</h3><p>No verified cold handoff recording was produced.</p></article>`;
    }
    const validation = recording.validation ?? {};
    const timings = recording.timings ?? {};
    return `<article class="recording"><h3>PR #${entry.number} · ${label}</h3><p>${variant === "progressive" ? "Navigates on the bounded ready pair, paints, then reconciles the canonical graph in the background." : "Waits for canonical extraction to finish before opening the review."}</p><video controls preload="metadata" src="${escapeAttribute(recording.relativePath)}"></video><dl><dt>Flow</dt><dd>${escapeHtml(recording.flow ?? "unavailable")}</dd><dt>Provisional ready</dt><dd>${formatMetric(timings.provisionalReadyObservedMs, "ms")}</dd><dt>Canonical done</dt><dd>${formatMetric(timings.canonicalDoneMs, "ms")}</dd><dt>Navigation started</dt><dd>${formatMetric(timings.navigationStartedMs, "ms")}</dd><dt>Navigation proof</dt><dd>${recording.navigation?.source === "playwright-main-document-request" ? "actual main-document request" : "unavailable"}</dd><dt>First actionable</dt><dd>${formatMetric(timings.firstActionableBrowserMs, "ms")} after navigation</dd><dt>Canonical reconciled</dt><dd>${variant === "progressive" ? formatMetric(timings.canonicalReconciledBrowserMs, "ms") + " after navigation" : "before navigation"}</dd><dt>Exact revision binding</dt><dd>${formatProof(recording.handoff?.exactRevisionBound)}</dd><dt>Pair ID</dt><dd>${escapeHtml(recording.handoff?.pairId ?? "unavailable")}</dd><dt>Duration</dt><dd>${formatFixed(validation.durationSeconds, 2)}s</dd><dt>SHA-256</dt><dd>${escapeHtml(validation.sha256 ?? "unavailable")}</dd></dl></article>`;
  }).join("\n");
}

function renderScreenshots(entry) {
  const screenshots = entry.screenshots ?? entry.evidence?.screenshots;
  if (!screenshots || typeof screenshots !== "object") return "";
  const items = Array.isArray(screenshots)
    ? screenshots.map((value, index) => [value?.variant ?? `view ${index + 1}`, value])
    : Object.entries(screenshots);
  return items.flatMap(([label, screenshot]) => {
    if (!screenshot || typeof screenshot.relativePath !== "string") return [];
    return [`<article class="revision"><h3>PR #${entry.number} · ${escapeHtml(label)}</h3><img class="evidence" loading="lazy" alt="PR #${entry.number} ${escapeAttribute(label)} scene" src="${escapeAttribute(screenshot.relativePath)}"></article>`];
  }).join("\n");
}

function renderRevision(entry) {
  const revision = entry.revisions?.prepared ?? {};
  const initialBaseTip = entry.revisions?.initial?.baseOid;
  const finalBaseTip = entry.revisions?.final?.baseOid;
  const coldInputBaseTips = uniqueStrings([
    entry.revisions?.coldInputs?.full?.baseOid,
    entry.revisions?.coldInputs?.progressive?.baseOid,
  ]);
  const coldPreparedBaseTips = uniqueStrings([
    entry.coldEndToEnd?.variants?.full?.prepared?.baseSha,
    entry.coldEndToEnd?.variants?.progressive?.prepared?.baseSha,
  ]);
  const preparationInputBaseTip = entry.revisions?.preparationInput?.baseOid;
  const navigationBaseTips = uniqueStrings([
    entry.coldEndToEnd?.variants?.full?.exactRevision?.baseSha,
    entry.coldEndToEnd?.variants?.progressive?.exactRevision?.baseSha,
    ...(entry.variants?.full?.samples ?? []).map((sample) => sample?.exactRevision?.baseSha),
    ...(entry.variants?.progressive?.samples ?? []).map((sample) => sample?.exactRevision?.baseSha),
    entry.recordings?.full?.exactRevision?.baseSha,
    entry.recordings?.progressive?.exactRevision?.baseSha,
  ]);
  const allBaseTips = uniqueStrings([
    initialBaseTip,
    ...coldInputBaseTips,
    ...coldPreparedBaseTips,
    preparationInputBaseTip,
    revision.baseSha,
    ...navigationBaseTips,
    finalBaseTip,
  ]);
  const baseTipMovement = allBaseTips.length > 1
    ? `observed (${allBaseTips.length} tips); allowed because all lane semantic identities stayed exact`
    : "none observed; all lane semantic identities stayed exact";
  const headProjection = entry.variants?.progressive?.samples?.[0]?.projections
    ?.find((projection) => projection.graphId === revision.graphId);
  const slice = headProjection?.counts?.slice;
  const full = headProjection?.counts?.full ?? revision.counts;
  const readiness = entry.variants?.progressive?.samples
    ?.map((sample) => sample.cacheReadiness)
    .find((candidate) => candidate?.causalWarmReadyHit === true)
    ?? entry.evidence?.cacheReadiness
    ?? null;
  const coldFull = entry.coldEndToEnd?.variants?.full;
  const coldProgressive = entry.coldEndToEnd?.variants?.progressive;
  const graphNetwork = entry.variants?.progressive?.samples?.[0]?.networkSettled;
  return `<article class="revision"><h3>Autopilot PR #${entry.number}</h3><dl><dt>Semantic identity</dt><dd>verified: HEAD + merge base + graph IDs</dd><dt>HEAD</dt><dd>${escapeHtml(revision.headSha ?? "unavailable")}</dd><dt>Merge base</dt><dd>${escapeHtml(revision.mergeBaseSha ?? "unavailable")}</dd><dt>Head graph</dt><dd>${escapeHtml(revision.graphId ?? "unavailable")}</dd><dt>Comparison graph</dt><dd>${escapeHtml(revision.comparisonGraphId ?? "unavailable")}</dd><dt>Initial base tip</dt><dd>${escapeHtml(initialBaseTip ?? "unavailable")}</dd><dt>Cold input base tips</dt><dd>${escapeHtml(formatBaseTips(coldInputBaseTips))}</dd><dt>Cold prepared base tips</dt><dd>${escapeHtml(formatBaseTips(coldPreparedBaseTips))}</dd><dt>Preparation input base tip</dt><dd>${escapeHtml(preparationInputBaseTip ?? "unavailable")}</dd><dt>Prepared terminal base tip</dt><dd>${escapeHtml(revision.baseSha ?? "unavailable")}</dd><dt>Navigation base tips</dt><dd>${escapeHtml(formatBaseTips(navigationBaseTips))}</dd><dt>Final base tip</dt><dd>${escapeHtml(finalBaseTip ?? "unavailable")}</dd><dt>Base-tip movement</dt><dd>${escapeHtml(baseTipMovement)}</dd><dt>Prepared pair</dt><dd>${formatMetric(entry.preparation?.totalMs, "ms")} (${escapeHtml(entry.preparation?.cache ?? revision.cache ?? "unknown")})</dd><dt>Cold full pair ready</dt><dd>${formatMetric(coldFull?.preparation?.milestones?.finalPairReadyMs, "ms")} (${escapeHtml(coldFull?.preparation?.cache ?? "unavailable")})</dd><dt>Cold progressive pair ready</dt><dd>${formatMetric(coldProgressive?.preparation?.milestones?.finalPairReadyMs, "ms")} (${escapeHtml(coldProgressive?.preparation?.cache ?? "unavailable")})</dd><dt>Cold manifests</dt><dd>${formatProof(coldFull?.preparation?.milestones?.source === "client-observed-ndjson-arrival" && coldProgressive?.preparation?.milestones?.source === "client-observed-ndjson-arrival")}</dd><dt>Cold isolation</dt><dd>${entry.coldEndToEnd?.isolation === "fresh-meridian-service-and-cache-per-variant" ? "fresh service + cache per variant" : "unverified"}</dd><dt>Full HEAD graph</dt><dd>${formatCounts(full)}</dd><dt>Initial HEAD slice</dt><dd>${formatCounts(slice)}</dd><dt>Graph byte accounting</dt><dd>${graphNetwork?.graphBytesAuthoritative === true && graphNetwork?.graphAccountingComplete === true ? "authoritative + complete" : "unverified"}</dd><dt>Renderer warm observed</dt><dd>${formatProof(readiness?.warmObserved)}</dd><dt>Renderer warm body</dt><dd>${readiness?.rendererTransportBodyless === true ? "transport-only; not duplicate-read" : "unverified"}</dd><dt>Cache ready</dt><dd>${formatProof(readiness?.cacheReady)}</dd><dt>Renderer HTTP 202</dt><dd>${formatProof(readiness?.speculativeWorkAcceptedOrCoalesced)}</dd><dt>Key acquisition</dt><dd>${readiness?.keyAcquiredByHarnessReplay === true ? "tagged exact replay" : "unverified"}</dd><dt>Same-key cache hit</dt><dd>${formatProof(readiness?.nextDepthCacheHit)}</dd><dt>Causal warm proof</dt><dd>${formatProof(readiness?.causalWarmReadyHit)}</dd><dt>Cache provenance</dt><dd>${readiness?.authoritative === true ? "authoritative" : typeof readiness?.diagnostic === "string" ? "diagnostic only" : "unavailable"}</dd><dt>Cold scene ID-set parity</dt><dd>${entry.coldEndToEnd?.parity?.exact === true ? "verified" : "unverified"}</dd><dt>Prepared scene ID-set parity</dt><dd>${entry.parity?.exact === true ? "verified" : "unverified"}</dd></dl></article>`;
}

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value !== ""))];
}

function formatBaseTips(values) {
  return values.length === 0 ? "unavailable" : values.join(" | ");
}

function renderPublicationNotice(document) {
  const configured = Array.isArray(document.config?.prs) ? document.config.prs.length : document.prs.length;
  const completed = document.prs.filter((entry) => entry.status === "complete").length;
  const denominator = `${completed}/${configured} configured PRs complete`;
  if (document.status === "complete") {
    return `<aside class="notice publishable"><strong>Publishable evidence · ${denominator}.</strong> Exact provisional→canonical revision binding, independent completion drains, ready-before-navigation progressive flow, canonical-before-navigation full baseline, renderer reconciliation marks, isolated cold cache misses, exact projection reservations, authoritative graph accounting, scene parity, recomputed measurements, and paired cold-handoff plus functionality recordings passed validation.</aside>`;
  }
  const reason = document.failure?.message
    ?? document.diagnostic?.reason
    ?? (Array.isArray(document.diagnostic?.reasons) ? document.diagnostic.reasons.join("; ") : null)
    ?? (Array.isArray(document.diagnostics) ? document.diagnostics.join("; ") : null)
    ?? (Array.isArray(document.config?.diagnosticReasons) ? document.config.diagnosticReasons.join("; ") : null)
    ?? (document.status === "running"
      ? "The benchmark is still running; measurements and evidence may be partial."
      : "This run did not satisfy the publishable evidence gate.");
  return `<aside class="notice"><strong>Not publishable · ${denominator}.</strong> ${escapeHtml(redactSecrets(reason))}</aside>`;
}

function renderRunFacts(document) {
  const firstSample = document.prs
    .flatMap((entry) => entry.variants?.full?.samples ?? [])
    .find((sample) => typeof sample.chromiumVersion === "string");
  const config = document.config && typeof document.config === "object" ? document.config : {};
  const environment = document.environment && typeof document.environment === "object" ? document.environment : {};
  return `<dl><dt>Repository</dt><dd>${escapeHtml(config.repository ?? "unavailable")}</dd><dt>Prepared repetitions</dt><dd>${escapeHtml(config.repetitions ?? "unavailable")} per variant and PR</dd><dt>Cold repetitions</dt><dd>${escapeHtml(config.coldEndToEnd?.repetitions ?? "unavailable")} per variant and PR</dd><dt>Cold isolation</dt><dd>${escapeHtml(config.coldEndToEnd?.isolation ?? "unavailable")}</dd><dt>Meridian commit</dt><dd>${escapeHtml(environment.meridianCommit ?? "unavailable")}</dd><dt>Worktree state</dt><dd>${environment.worktreeDirty === true ? "dirty (measured source includes local POC changes)" : environment.worktreeDirty === false ? "clean" : "unavailable"}</dd><dt>Node.js</dt><dd>${escapeHtml(environment.node ?? "unavailable")}</dd><dt>Chromium</dt><dd>${escapeHtml(firstSample?.chromiumVersion ?? "unavailable")}</dd></dl>`;
}

function normalizeBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("--url must be a valid absolute URL");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.hash) {
    throw new TypeError("--url must be an http(s) origin without credentials or a fragment");
  }
  if (url.pathname !== "/" || url.search) throw new TypeError("--url must name an origin without a path or query");
  return url.origin;
}

function isLoopbackOrigin(value) {
  const hostname = new URL(value).hostname.toLowerCase();
  return hostname === "localhost"
    || hostname.endsWith(".localhost")
    || /^127(?:\.\d{1,3}){3}$/.test(hostname)
    || hostname === "::1"
    || hostname === "[::1]";
}

function required(values, name) {
  const value = values.get(name);
  if (value === undefined || value.trim() === "") throw new TypeError(`--${name} is required`);
  return value;
}

function optionalNonEmpty(value) {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === "") throw new TypeError("option value must not be empty");
  return trimmed;
}

function executableOption(values, name, fallback) {
  const value = optionalNonEmpty(values.get(name));
  return value ?? fallback;
}

function boundedInteger(value, name, minimum, maximum) {
  if (!/^[1-9]\d*$/.test(value)) throw new TypeError(`${name} must be an integer`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new TypeError(`${name} must be between ${minimum} and ${maximum}`);
  }
  return number;
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer`);
  return value;
}

function nonNegativeSafeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function finitePositive(value, name) {
  if (!Number.isFinite(value) || value <= 0) throw new TypeError(`${name} must be positive`);
  return value;
}

function finiteNonNegative(value, name) {
  if (!Number.isFinite(value) || value < 0) throw new TypeError(`${name} must be finite and non-negative`);
  return value;
}

function optionalPositiveNumber(value) {
  if (value === undefined || value === null || value === "N/A") return null;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function firstPositiveNumber(values, name) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return number;
  }
  throw new TypeError(`${name} must be positive`);
}

function firstOptionalPositiveNumber(values) {
  for (const value of values) {
    const number = optionalPositiveNumber(value);
    if (number !== null) return number;
  }
  return null;
}

function nonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
  return value.trim();
}

function string(value, name) {
  if (typeof value !== "string") throw new TypeError(`${name} must be a string`);
  return value;
}

function oid(value, name) {
  const result = nonEmptyString(value, name).toLowerCase();
  if (!OID_PATTERN.test(result)) throw new TypeError(`${name} must be a 40- or 64-character object ID`);
  return result;
}

function gitRef(value, name) {
  const ref = nonEmptyString(value, name);
  if (
    ref.startsWith("-")
    || ref.startsWith("/")
    || ref.endsWith("/")
    || ref.endsWith(".")
    || ref.endsWith(".lock")
    || /[\x00-\x20~^:?*\\[]/.test(ref)
    || ref.includes("..")
    || ref.includes("//")
    || ref.includes("@{")
    || ref.includes("/.")
  ) {
    throw new TypeError(`${name} contains unsafe characters`);
  }
  return ref;
}

function safeWebUrl(value, name) {
  const text = nonEmptyString(value, name);
  const url = new URL(text);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new TypeError(`${name} must use http(s)`);
  return url.href;
}

function isoTimestamp(value, name) {
  const text = nonEmptyString(value, name);
  if (!Number.isFinite(Date.parse(text))) throw new TypeError(`${name} must be an ISO timestamp`);
  return new Date(text).toISOString();
}

function nullableRepositoryName(value) {
  if (value === null || value === undefined) return null;
  const repo = record(value, "GitHub repository");
  const name = nonEmptyString(repo.full_name, "GitHub repository full_name");
  if (!REPOSITORY_PATTERN.test(name)) throw new TypeError("GitHub repository full_name is invalid");
  return name;
}

function storedRepositoryName(value, name) {
  const repository = nonEmptyString(value, name);
  const pieces = repository.split("/");
  if (pieces.length !== 2 || pieces.some((piece) => piece === "" || piece === "." || piece === "..")) {
    throw new TypeError(`${name} must be an owner/repository coordinate`);
  }
  return repository;
}

function relativeViewUrl(value) {
  const text = nonEmptyString(value, "prepared viewUrl");
  let url;
  try {
    url = new URL(text, "http://meridian.local");
  } catch {
    throw new TypeError("prepared viewUrl is invalid");
  }
  if (url.origin !== "http://meridian.local" || url.pathname !== "/view" || url.hash) {
    throw new TypeError("prepared viewUrl must be a same-origin /view URL");
  }
  return `${url.pathname}${url.search}`;
}

function countPair(value, name) {
  const counts = record(value, name);
  const nodes = Number(counts.nodes);
  const edges = Number(counts.edges);
  if (!Number.isSafeInteger(nodes) || nodes < 0 || !Number.isSafeInteger(edges) || edges < 0) {
    throw new TypeError(`${name} must contain non-negative node/edge counts`);
  }
  return { nodes, edges };
}

function record(value, name) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  return value;
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function sumMetricValues(...values) {
  return values.every(finiteNumber) ? values.reduce((total, value) => total + value, 0) : null;
}

function roundEvidenceMs(value) {
  const rounded = Math.round(value * 10) / 10;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function readMetric(value, paths) {
  for (const path of paths) {
    let current = value;
    for (const segment of path.split(".")) current = current?.[segment];
    if (finiteNumber(current)) return current;
  }
  return null;
}

function finiteOrNull(value) {
  return finiteNumber(value) ? value : null;
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function reductionPercent(before, after) {
  if (!finiteNumber(before) || !finiteNumber(after) || before <= 0) return null;
  return ((before - after) / before) * 100;
}

function formatMetric(value, unit) {
  if (!finiteNumber(value)) return "n/a";
  if (unit === "ms") return value >= 1000 ? `${(value / 1000).toFixed(2)}s` : `${value.toFixed(0)}ms`;
  if (unit === "bytes") return formatBytes(value);
  return String(value);
}

function formatClockEstimate(value, uncertaintyMs) {
  if (!finiteNumber(value) || !finiteNumber(uncertaintyMs) || uncertaintyMs < 0) return "n/a";
  const precision = uncertaintyMs < 1 ? 2 : 1;
  return `${formatMetric(value, "ms")} ± ${uncertaintyMs.toFixed(precision)}ms`;
}

function formatBytes(value) {
  const units = ["B", "KiB", "MiB", "GiB"];
  let amount = value;
  let index = 0;
  while (amount >= 1024 && index < units.length - 1) {
    amount /= 1024;
    index += 1;
  }
  return `${amount.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function formatCounts(value) {
  if (!value || !finiteNumber(value.nodes) || !finiteNumber(value.edges)) return "unavailable";
  const files = finiteNumber(value.files) ? ` · ${value.files.toLocaleString("en-US")} files` : "";
  return `${value.nodes.toLocaleString("en-US")} nodes · ${value.edges.toLocaleString("en-US")} edges${files}`;
}

function formatPercent(value) {
  if (!finiteNumber(value)) return "n/a";
  if (Object.is(value, 0) || Object.is(value, -0)) return "0.0%";
  return `${value > 0 ? "−" : "+"}${Math.abs(value).toFixed(1)}%`;
}

function metricClass(value) {
  if (!finiteNumber(value)) return "neutral";
  return value > 0 ? "positive" : value < 0 ? "negative" : "neutral";
}

function formatFixed(value, digits) {
  return finiteNumber(value) ? value.toFixed(digits) : "?";
}

function formatProof(value) {
  return value === true ? "verified" : value === false ? "failed" : "unavailable";
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[character]);
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/`/g, "&#96;");
}
