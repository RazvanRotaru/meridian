/**
 * Versioned, browser-safe progress semantics for preparing one exact pull-request review.
 *
 * The model is data, not React or server code, so the renderer can import it while the CLI injects
 * the exact same JSON into the hand-written landing page. The reducer deliberately supports
 * independent/non-linear work: a whole-subtree deletion may prepare the merge base before HEAD,
 * and a verified pair hit skips the workspace while reusing both revision graphs.
 */

export const PR_REVIEW_PROGRESS_MODEL_VERSION = 1 as const;
const MAX_PR_REVIEW_PROGRESS_BYTES = 16 * 1024;
const MAX_PR_REVIEW_MESSAGE_BYTES = 4 * 1024;

export const PR_REVIEW_PROGRESS_STEP_IDS = [
  "resolve",
  "workspace",
  "graphs",
  "artifacts",
  "projection",
] as const;

export type PrReviewProgressStepId = typeof PR_REVIEW_PROGRESS_STEP_IDS[number];

export type PrReviewProgressRevisionId = "head" | "mergeBase";

export const PR_REVIEW_PROGRESS_STAGE_IDS = [
  "details",
  "resolve",
  "clone",
  "checkout",
  "extract",
  "extract-head",
  "reuse-head",
  "extract-merge-base",
  "reuse-merge-base",
  "handoff",
  "load-artifacts",
  "projection",
] as const;

export type PrReviewProgressStage = typeof PR_REVIEW_PROGRESS_STAGE_IDS[number];

export type PrReviewProgressStepState =
  | "pending"
  | "active"
  | "done"
  | "reused"
  | "skipped"
  | "error"
  | "canceled";

export type PrReviewProgressStatus =
  | "idle"
  | "running"
  | "success"
  | "error"
  | "canceled";

export interface PrReviewProgressStep {
  id: PrReviewProgressStepId;
  label: string;
}

export interface PrReviewProgressStageDefinition {
  step: PrReviewProgressStepId;
  label: string;
}

/**
 * Everything a browser needs to render canonical PR progress. Keep this JSON-serializable: the CLI
 * injects it verbatim as `window.__MERIDIAN_PR_REVIEW_PROGRESS_MODEL__`.
 */
export const PR_REVIEW_PROGRESS_MODEL = Object.freeze({
  version: PR_REVIEW_PROGRESS_MODEL_VERSION,
  title: "Preparing PR review",
  handoffStorageKeyPrefix: "meridian.pr-review-progress.v1:",
  handoffTtlMs: 60_000,
  steps: [
    { id: "resolve", label: "Resolve exact revisions and verified cache" },
    { id: "workspace", label: "Prepare repository workspace" },
    { id: "graphs", label: "Prepare exact revision graphs" },
    { id: "artifacts", label: "Load and index review graphs" },
    { id: "projection", label: "Build the review blueprint" },
  ],
  revisions: [
    { id: "head", label: "PR HEAD graph" },
    { id: "mergeBase", label: "Merge-base graph" },
  ],
  stages: {
    details: {
      step: "resolve",
      label: "Loading pull request details…",
    },
    resolve: {
      step: "resolve",
      label: "Resolving exact PR revisions and verified cache…",
    },
    clone: {
      step: "workspace",
      label: "Cloning repository…",
    },
    checkout: {
      step: "workspace",
      label: "Fetching PR HEAD and merge base…",
    },
    extract: {
      step: "graphs",
      // The umbrella event precedes analysis admission and can remain visible while another worker
      // owns the memory slot. It is not evidence that either revision extractor has started.
      label: "Waiting for extraction capacity…",
    },
    "extract-head": {
      step: "graphs",
      label: "Extracting PR HEAD graph…",
    },
    "reuse-head": {
      step: "graphs",
      label: "Reusing verified PR HEAD graph…",
    },
    "extract-merge-base": {
      step: "graphs",
      label: "Extracting merge-base graph…",
    },
    "reuse-merge-base": {
      step: "graphs",
      label: "Reusing verified merge-base graph…",
    },
    handoff: {
      step: "artifacts",
      label: "Opening exact review graphs…",
    },
    "load-artifacts": {
      step: "artifacts",
      label: "Loading and indexing review graphs…",
    },
    projection: {
      step: "projection",
      label: "Building the review blueprint…",
    },
  },
  terminal: {
    success: "Opening PR review…",
    error: "PR review preparation failed.",
    canceled: "PR review preparation canceled.",
  },
  telemetry: {
    commitLength: 7,
    revisionLabels: {
      head: "PR HEAD",
      "merge-base": "merge base",
    },
    languageLabels: {
      typescript: "TypeScript",
      python: "Python",
    },
    phaseLabels: {
      "project-load": "project load",
      structure: "structure",
      relationships: "relationships",
      stitch: "stitch",
      finalize: "finalize",
    },
    activityLabels: {
      "calls-and-types": "calls & types",
      imports: "imports",
      "value-references": "value references",
      "promise-discovery": "promise discovery",
      "promise-links": "promise links",
      "logic-flows": "logic flows",
      ports: "ports",
      exports: "exports",
    },
    executionLabel: "review graph",
    unitLabel: "unit",
    sourceFileLabel: "file",
  },
} as const satisfies {
  version: 1;
  title: string;
  handoffStorageKeyPrefix: string;
  handoffTtlMs: number;
  steps: readonly PrReviewProgressStep[];
  revisions: readonly { id: PrReviewProgressRevisionId; label: string }[];
  stages: Record<PrReviewProgressStage, PrReviewProgressStageDefinition>;
  terminal: Record<Exclude<PrReviewProgressStatus, "idle" | "running">, string>;
  telemetry: {
    commitLength: number;
    revisionLabels: Record<"head" | "merge-base", string>;
    languageLabels: Record<"typescript" | "python", string>;
    phaseLabels: Record<string, string>;
    activityLabels: Record<string, string>;
    executionLabel: string;
    unitLabel: string;
    sourceFileLabel: string;
  };
});

export interface PrReviewProgressSnapshot {
  version: 1;
  /** Exact PR whose preparation history this snapshot describes; null before a PR is selected. */
  prNumber: number | null;
  status: PrReviewProgressStatus;
  activeStage: PrReviewProgressStage | null;
  steps: Record<PrReviewProgressStepId, PrReviewProgressStepState>;
  revisions: {
    head: PrReviewProgressStepState;
    mergeBase: PrReviewProgressStepState;
  };
  /** Optional non-semantic extractor telemetry. Unknown/new fields are retained but never trusted. */
  progress: unknown;
  message: string | null;
}

export type PrReviewProgressEvent =
  | { type: "stage"; stage: PrReviewProgressStage; progress?: unknown }
  | { type: "analysis-done"; cache: "hit" | "miss" | null }
  | { type: "success" }
  | { type: "error"; message?: string | null }
  | { type: "canceled" }
  | { type: "reset" };

export function createPrReviewProgressSnapshot(
  prNumber: number | null = null,
): PrReviewProgressSnapshot {
  return {
    version: PR_REVIEW_PROGRESS_MODEL_VERSION,
    prNumber: validPrNumber(prNumber) ? prNumber : null,
    status: "idle",
    activeStage: null,
    steps: pendingSteps(),
    revisions: { head: "pending", mergeBase: "pending" },
    progress: null,
    message: null,
  };
}

/** Fail-closed validation for the short-lived landing → renderer handoff snapshot. */
export function parsePrReviewProgressSnapshot(value: unknown): PrReviewProgressSnapshot | null {
  if (!record(value)) return null;
  const steps = value.steps;
  const revisions = value.revisions;
  const activeStage = typeof value.activeStage === "string"
    && (PR_REVIEW_PROGRESS_STAGE_IDS as readonly string[]).includes(value.activeStage)
    ? value.activeStage as PrReviewProgressStage
    : null;
  if (
    value.version !== PR_REVIEW_PROGRESS_MODEL_VERSION
    || (value.prNumber !== null && !validPrNumber(value.prNumber))
    || !isProgressStatus(value.status)
    || (value.activeStage !== null && activeStage === null)
    || !record(steps)
    || !record(revisions)
    || !hasExactKeys(steps, PR_REVIEW_PROGRESS_STEP_IDS)
    || !hasExactKeys(revisions, ["head", "mergeBase"])
    || !PR_REVIEW_PROGRESS_STEP_IDS.every((step) => isStepState(steps[step]))
    || !isStepState(revisions.head)
    || !isStepState(revisions.mergeBase)
    || (value.message !== null && typeof value.message !== "string")
    || (typeof value.message === "string" && utf8ByteLength(value.message) > MAX_PR_REVIEW_MESSAGE_BYTES)
  ) {
    return null;
  }
  const parsed: PrReviewProgressSnapshot = {
    version: PR_REVIEW_PROGRESS_MODEL_VERSION,
    prNumber: value.prNumber as number | null,
    status: value.status,
    activeStage,
    steps: {
      resolve: steps.resolve as PrReviewProgressStepState,
      workspace: steps.workspace as PrReviewProgressStepState,
      graphs: steps.graphs as PrReviewProgressStepState,
      artifacts: steps.artifacts as PrReviewProgressStepState,
      projection: steps.projection as PrReviewProgressStepState,
    },
    revisions: {
      head: revisions.head as PrReviewProgressStepState,
      mergeBase: revisions.mergeBase as PrReviewProgressStepState,
    },
    progress: activeStage === null
      ? null
      : sanitizePrReviewExtractionProgress(activeStage, value.progress),
    message: value.message as string | null,
  };
  return coherentSnapshot(parsed, value.progress) ? parsed : null;
}

export function reducePrReviewProgress(
  current: PrReviewProgressSnapshot,
  event: PrReviewProgressEvent,
): PrReviewProgressSnapshot {
  if (event.type === "reset") return createPrReviewProgressSnapshot(current.prNumber);
  // A drained/canceled request can still deliver buffered lines. Terminal UI state is authoritative
  // until the caller explicitly starts a new operation with reset.
  if (current.status === "success" || current.status === "error" || current.status === "canceled") {
    return current;
  }
  if (event.type === "stage") return applyStage(current, event.stage, event.progress ?? null);
  if (event.type === "analysis-done") return finishAnalysis(current, event.cache);
  if (event.type === "success") {
    // Review preparation is complete only after the renderer's canonical projection step.
    return current.steps.projection === "active" || current.steps.projection === "done"
      ? finishSuccess(current)
      : current;
  }
  return finishTerminal(current, event.type, event.type === "error" ? event.message : null);
}

/** Canonical visible status copy, including bounded optional extractor telemetry when it validates. */
export function prReviewProgressStatusText(snapshot: PrReviewProgressSnapshot): string {
  if (snapshot.status === "success") return PR_REVIEW_PROGRESS_MODEL.terminal.success;
  if (snapshot.status === "error") {
    return snapshot.message?.trim() || PR_REVIEW_PROGRESS_MODEL.terminal.error;
  }
  if (snapshot.status === "canceled") return PR_REVIEW_PROGRESS_MODEL.terminal.canceled;
  if (snapshot.activeStage === null) return PR_REVIEW_PROGRESS_MODEL.stages.resolve.label;
  const base = PR_REVIEW_PROGRESS_MODEL.stages[snapshot.activeStage].label;
  const observation = extractionObservation(snapshot.progress, snapshot.activeStage);
  if (observation === null) return base;
  const telemetry = PR_REVIEW_PROGRESS_MODEL.telemetry;
  const details = [
    `${telemetry.revisionLabels[observation.revision.kind]} ${observation.revision.commit.slice(0, telemetry.commitLength)}`,
    telemetry.languageLabels[observation.language],
    `${telemetry.executionLabel} ${observation.revision.execution.current}/${observation.revision.execution.total}`,
    telemetry.phaseLabels[observation.phase],
  ];
  if (observation.activity !== null) {
    details.push(telemetry.activityLabels[observation.activity]);
  }
  if (observation.unit !== null) {
    details.push(`${telemetry.unitLabel} ${observation.unit.current}/${observation.unit.total}`);
  }
  if (observation.sourceFile !== null) {
    details.push(
      `${telemetry.sourceFileLabel} ${observation.sourceFile.current}/${observation.sourceFile.total}`,
      // The transport owns path bounding and marks a retained suffix (for example
      // `…/src/index.ts`) as truncated. Render that bounded string verbatim.
      observation.sourceFile.path,
    );
  }
  return `${base} ${details.join(" · ")}`;
}

function applyStage(
  current: PrReviewProgressSnapshot,
  stage: PrReviewProgressStage,
  progress: unknown,
): PrReviewProgressSnapshot {
  const next = cloneSnapshot(current);
  const nextStep = PR_REVIEW_PROGRESS_MODEL.stages[stage].step;
  const nextIndex = PR_REVIEW_PROGRESS_MODEL.steps.findIndex((step) => step.id === nextStep);
  for (const [index, step] of PR_REVIEW_PROGRESS_MODEL.steps.entries()) {
    if (next.steps[step.id] !== "active" || step.id === nextStep) continue;
    // A later step proves earlier synchronous work returned. A lower-numbered stage can run in a
    // separate lane: during review restore, live PR details/ref validation overlaps the still-active
    // comparison-artifact load begun by the landing/boot handoff.
    if (index < nextIndex) next.steps[step.id] = "done";
  }
  next.status = "running";
  next.activeStage = stage;
  next.steps[nextStep] = "active";
  next.progress = sanitizePrReviewExtractionProgress(stage, progress);
  next.message = null;
  if (stage === "extract-head") {
    finishOtherActiveRevision(next.revisions, "head");
    next.revisions.head = "active";
  } else if (stage === "reuse-head") {
    finishOtherActiveRevision(next.revisions, "head");
    next.revisions.head = "reused";
  } else if (stage === "extract-merge-base") {
    finishOtherActiveRevision(next.revisions, "mergeBase");
    next.revisions.mergeBase = "active";
  } else if (stage === "reuse-merge-base") {
    finishOtherActiveRevision(next.revisions, "mergeBase");
    next.revisions.mergeBase = "reused";
  }
  return next;
}

function finishAnalysis(
  current: PrReviewProgressSnapshot,
  cache: "hit" | "miss" | null,
): PrReviewProgressSnapshot {
  const next = cloneSnapshot(current);
  next.status = "running";
  next.activeStage = null;
  next.progress = null;
  next.message = null;
  next.steps.resolve = "done";
  if (cache === "hit") {
    // A landing cold build is immediately a pair hit after navigation. Preserve the work already
    // observed in that destination-scoped handoff instead of rewriting its history as warm reuse.
    next.steps.workspace = cacheHitWorkState(next.steps.workspace, "skipped");
    next.steps.graphs = cacheHitWorkState(next.steps.graphs, "reused");
    next.revisions.head = cacheHitWorkState(next.revisions.head, "reused");
    next.revisions.mergeBase = cacheHitWorkState(next.revisions.mergeBase, "reused");
  } else {
    next.steps.workspace = finalWorkState(next.steps.workspace);
    next.steps.graphs = "done";
    next.revisions.head = finalRevisionState(next.revisions.head);
    next.revisions.mergeBase = finalRevisionState(next.revisions.mergeBase);
  }
  return next;
}

function finishSuccess(current: PrReviewProgressSnapshot): PrReviewProgressSnapshot {
  const next = cloneSnapshot(current);
  for (const step of PR_REVIEW_PROGRESS_MODEL.steps) {
    if (next.steps[step.id] === "active") next.steps[step.id] = "done";
    else if (next.steps[step.id] === "pending") next.steps[step.id] = "skipped";
  }
  next.revisions.head = terminalRevisionState(next.revisions.head, "skipped");
  next.revisions.mergeBase = terminalRevisionState(next.revisions.mergeBase, "skipped");
  next.status = "success";
  next.activeStage = null;
  next.progress = null;
  next.message = PR_REVIEW_PROGRESS_MODEL.terminal.success;
  return next;
}

function finishTerminal(
  current: PrReviewProgressSnapshot,
  status: "error" | "canceled",
  message: string | null | undefined,
): PrReviewProgressSnapshot {
  const next = cloneSnapshot(current);
  const terminalState = status;
  for (const step of PR_REVIEW_PROGRESS_MODEL.steps) {
    if (next.steps[step.id] === "active") next.steps[step.id] = terminalState;
  }
  if (next.revisions.head === "active") next.revisions.head = terminalState;
  if (next.revisions.mergeBase === "active") next.revisions.mergeBase = terminalState;
  next.status = status;
  next.progress = null;
  next.message = status === "error"
    ? boundedMessage(message, PR_REVIEW_PROGRESS_MODEL.terminal.error)
    : PR_REVIEW_PROGRESS_MODEL.terminal.canceled;
  return next;
}

function pendingSteps(): Record<PrReviewProgressStepId, PrReviewProgressStepState> {
  return {
    resolve: "pending",
    workspace: "pending",
    graphs: "pending",
    artifacts: "pending",
    projection: "pending",
  };
}

function cloneSnapshot(snapshot: PrReviewProgressSnapshot): PrReviewProgressSnapshot {
  return {
    ...snapshot,
    steps: { ...snapshot.steps },
    revisions: { ...snapshot.revisions },
  };
}

function finishOtherActiveRevision(
  revisions: PrReviewProgressSnapshot["revisions"],
  next: keyof PrReviewProgressSnapshot["revisions"],
): void {
  const other = next === "head" ? "mergeBase" : "head";
  if (revisions[other] === "active") revisions[other] = "done";
}

function finalWorkState(state: PrReviewProgressStepState): PrReviewProgressStepState {
  return state === "pending" ? "skipped" : state === "active" ? "done" : state;
}

function cacheHitWorkState(
  state: PrReviewProgressStepState,
  fallback: "reused" | "skipped",
): PrReviewProgressStepState {
  if (state === "done" || state === "reused" || state === "skipped") return state;
  return state === "active" ? "done" : fallback;
}

function finalRevisionState(state: PrReviewProgressStepState): PrReviewProgressStepState {
  return state === "reused" ? "reused" : "done";
}

function terminalRevisionState(
  state: PrReviewProgressStepState,
  pending: "skipped",
): PrReviewProgressStepState {
  if (state === "active") return "done";
  return state === "pending" ? pending : state;
}

interface ValidExtractionObservation {
  revision: {
    kind: "head" | "merge-base";
    commit: string;
    execution: { current: number; total: number };
  };
  language: "typescript" | "python";
  phase: keyof typeof PR_REVIEW_PROGRESS_MODEL.telemetry.phaseLabels;
  activity: keyof typeof PR_REVIEW_PROGRESS_MODEL.telemetry.activityLabels | null;
  unit: ValidProgressPosition | null;
  sourceFile: ValidProgressPosition | null;
}

interface ValidProgressPosition {
  current: number;
  total: number;
  path: string;
  pathTruncated: boolean;
}

/**
 * Retain a validated v1 observation (including bounded future fields) for presentation. Invalid,
 * contradictory, cyclic, or oversized data becomes null before it can enter canonical UI state.
 */
export function sanitizePrReviewExtractionProgress(
  stage: PrReviewProgressStage,
  value: unknown,
): unknown | null {
  return extractionObservation(value, stage) !== null
    && boundedJson(value, MAX_PR_REVIEW_PROGRESS_BYTES)
    ? value
    : null;
}

function extractionObservation(
  value: unknown,
  stage: PrReviewProgressStage,
): ValidExtractionObservation | null {
  if (!record(value) || value.version !== 1 || !record(value.revision)) return null;
  const revision = value.revision;
  if (
    (stage !== "extract-head" && stage !== "extract-merge-base")
    || (stage === "extract-head" && revision.kind !== "head")
    || (stage === "extract-merge-base" && revision.kind !== "merge-base")
    || (revision.kind !== "head" && revision.kind !== "merge-base")
    || typeof revision.commit !== "string"
    || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(revision.commit)
    || !record(revision.execution)
    || !positionCounts(revision.execution, 8)
    || (value.language !== "typescript" && value.language !== "python")
    || typeof value.phase !== "string"
    || !Object.hasOwn(PR_REVIEW_PROGRESS_MODEL.telemetry.phaseLabels, value.phase)
  ) {
    return null;
  }
  const unit = progressPosition(value.unit, true);
  const sourceFile = progressPosition(value.sourceFile, false);
  const activity = typeof value.activity === "string"
    && Object.hasOwn(PR_REVIEW_PROGRESS_MODEL.telemetry.activityLabels, value.activity)
    ? value.activity as ValidExtractionObservation["activity"]
    : null;
  if (
    (value.unit !== null && unit === null)
    || (value.sourceFile !== null && sourceFile === null)
    || (sourceFile !== null && unit === null)
    || (value.activity !== undefined && activity === null)
    || (activity !== null && value.phase !== "relationships")
  ) {
    return null;
  }
  return {
    revision: {
      kind: revision.kind,
      commit: revision.commit,
      execution: {
        current: revision.execution.current,
        total: revision.execution.total,
      },
    },
    language: value.language,
    phase: value.phase as ValidExtractionObservation["phase"],
    activity,
    unit,
    sourceFile,
  };
}

function progressPosition(value: unknown, allowProjectRoot: boolean): ValidProgressPosition | null {
  if (value === null) return null;
  if (
    !record(value)
    || !positionCounts(value, 100_000)
    || typeof value.path !== "string"
    || typeof value.pathTruncated !== "boolean"
    || !validProgressPath(value.path, allowProjectRoot, value.pathTruncated)
  ) {
    return null;
  }
  return {
    current: value.current,
    total: value.total,
    path: value.path,
    pathTruncated: value.pathTruncated,
  };
}

function positionCounts(
  value: Record<string, unknown>,
  maximum: number,
): value is Record<string, unknown> & {
  current: number;
  total: number;
} {
  return Number.isSafeInteger(value.current)
    && Number.isSafeInteger(value.total)
    && (value.current as number) > 0
    && (value.total as number) >= (value.current as number)
    && (value.total as number) <= maximum;
}

function validProgressPath(
  value: string,
  allowProjectRoot: boolean,
  truncated: boolean,
): boolean {
  if (allowProjectRoot && value === ".") return !truncated;
  if (
    value.length === 0
    || value.startsWith("/")
    || value.includes("\\")
    || value.includes("\0")
    || utf8ByteLength(value) > 512
    || (truncated && !value.startsWith("…/"))
  ) {
    return false;
  }
  const segments = value.split("/");
  return segments.every((segment) => (
    segment.length > 0
    && segment !== "."
    && segment !== ".."
  ));
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
  }
  return bytes;
}

function boundedJson(value: unknown, maximumBytes: number): boolean {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string" && utf8ByteLength(serialized) <= maximumBytes;
  } catch {
    return false;
  }
}

function boundedMessage(value: string | null | undefined, fallback: string): string {
  const message = value?.trim();
  return message && utf8ByteLength(message) <= MAX_PR_REVIEW_MESSAGE_BYTES
    ? message
    : fallback;
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function coherentSnapshot(snapshot: PrReviewProgressSnapshot, rawProgress: unknown): boolean {
  const states = [
    ...Object.values(snapshot.steps),
    snapshot.revisions.head,
    snapshot.revisions.mergeBase,
  ];
  if (snapshot.status === "idle") {
    return snapshot.activeStage === null
      && states.every((state) => state === "pending")
      && rawProgress == null
      && snapshot.message === null;
  }
  if (snapshot.status === "running") {
    if (
      snapshot.activeStage === null
      || snapshot.steps[PR_REVIEW_PROGRESS_MODEL.stages[snapshot.activeStage].step] !== "active"
      || states.some((state) => state === "error" || state === "canceled")
      || snapshot.message !== null
      || (rawProgress != null && snapshot.progress === null)
    ) {
      return false;
    }
    if (snapshot.activeStage === "handoff") {
      return snapshot.prNumber !== null
        && snapshot.steps.resolve === "done"
        && (snapshot.steps.workspace === "done" || snapshot.steps.workspace === "skipped")
        && (snapshot.steps.graphs === "done" || snapshot.steps.graphs === "reused")
        && snapshot.steps.artifacts === "active"
        && snapshot.steps.projection === "pending"
        && (snapshot.revisions.head === "done" || snapshot.revisions.head === "reused")
        && (snapshot.revisions.mergeBase === "done" || snapshot.revisions.mergeBase === "reused")
        && rawProgress == null;
    }
    return true;
  }
  if (snapshot.status === "success") {
    return snapshot.activeStage === null
      && rawProgress == null
      && states.every((state) => state === "done" || state === "reused" || state === "skipped");
  }
  const opposite = snapshot.status === "error" ? "canceled" : "error";
  return rawProgress == null
    && !states.includes("active")
    && !states.includes(opposite)
    && snapshot.message !== null;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStepState(value: unknown): value is PrReviewProgressStepState {
  return value === "pending"
    || value === "active"
    || value === "done"
    || value === "reused"
    || value === "skipped"
    || value === "error"
    || value === "canceled";
}

function isProgressStatus(value: unknown): value is PrReviewProgressStatus {
  return value === "idle"
    || value === "running"
    || value === "success"
    || value === "error"
    || value === "canceled";
}

function validPrNumber(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}
