const MIB = 1024 ** 2;
const GIB = 1024 ** 3;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

const DEFAULT_MAX_ENTRIES = 32;
const DEFAULT_MAX_ARTIFACT_BYTES = GIB;
const DEFAULT_MAX_SOURCE_LEASES = 12;
const DEFAULT_MAX_IDLE_MS = 2 * HOUR_MS;
const DEFAULT_PUBLICATION_HANDOFF_TTL_MS = 5 * MINUTE_MS;
const DEFAULT_SWEEP_INTERVAL_MS = MINUTE_MS;
const DEFAULT_VIEW_LEASE_TTL_MS = 5 * MINUTE_MS;
const DEFAULT_MAX_VIEW_LEASES = 64;
const DEFAULT_MAX_IDS_PER_VIEW = 5;

const MAX_MIB_ENV = "MERIDIAN_GRAPH_REGISTRY_MAX_MIB";
const MAX_ENTRIES_ENV = "MERIDIAN_GRAPH_REGISTRY_MAX_ENTRIES";
const MAX_SOURCE_LEASES_ENV = "MERIDIAN_GRAPH_REGISTRY_MAX_SOURCE_LEASES";
const MAX_IDLE_MINUTES_ENV = "MERIDIAN_GRAPH_REGISTRY_MAX_IDLE_MINUTES";

/** Fully resolved limits for the process-private web graph registry. */
export interface GraphRetentionOptions {
  readonly maxEntries: number;
  readonly lowWaterEntries: number;
  readonly maxArtifactBytes: number;
  readonly lowWaterArtifactBytes: number;
  readonly maxSourceLeases: number;
  readonly lowWaterSourceLeases: number;
  readonly maxIdleMs: number;
  /** Bounded reservation bridging publication to the first renderer/view claim. */
  readonly publicationHandoffTtlMs: number;
  readonly sweepIntervalMs: number;
  readonly viewLeaseTtlMs: number;
  readonly maxViewLeases: number;
  readonly maxIdsPerView: number;
  /** Test seam for deterministic age and protection decisions. */
  readonly now?: () => number;
}

/** Compact registry metadata; graph nodes and artifact bytes never enter the retention policy. */
export interface GraphRetentionCandidate {
  readonly id: string;
  readonly artifactBytes: number;
  readonly sourceLeases: 0 | 1;
  readonly publishedAtMs: number;
  readonly lastAccessAtMs: number;
  readonly pinned: boolean;
  /** Explicit short-lived publication reservation protected across temporary retention pressure. */
  readonly handoffUntilMs: number;
}

export type GraphRetentionReason = "max-idle" | "capacity";

export interface GraphRetentionDecision<
  Candidate extends GraphRetentionCandidate = GraphRetentionCandidate,
> {
  readonly candidate: Candidate;
  readonly reason: GraphRetentionReason;
}

export interface GraphRetentionUsage {
  readonly entries: number;
  readonly artifactBytes: number;
  readonly sourceLeases: number;
}

export interface GraphRetentionPressure {
  readonly entries: boolean;
  readonly artifactBytes: boolean;
  readonly sourceLeases: boolean;
}

export interface GraphRetentionSelection<
  Candidate extends GraphRetentionCandidate = GraphRetentionCandidate,
> {
  readonly selected: readonly GraphRetentionDecision<Candidate>[];
  readonly total: GraphRetentionUsage;
  readonly projected: GraphRetentionUsage;
  /** Dimensions that crossed their high watermark after idle expiry. */
  readonly pressure: GraphRetentionPressure;
}

/** Apply conservative defaults, derive hysteresis, and validate every numeric boundary. */
export function resolveGraphRetentionOptions(
  options: Partial<GraphRetentionOptions> = {},
): GraphRetentionOptions {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxArtifactBytes = options.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;
  const maxSourceLeases = options.maxSourceLeases ?? DEFAULT_MAX_SOURCE_LEASES;
  requirePositiveSafeInteger(maxEntries, "maxEntries");
  requirePositiveSafeInteger(maxArtifactBytes, "maxArtifactBytes");
  requirePositiveSafeInteger(maxSourceLeases, "maxSourceLeases");
  const lowWaterEntries = options.lowWaterEntries ?? ratioBelow(maxEntries, 3, 4);
  const lowWaterArtifactBytes = options.lowWaterArtifactBytes
    ?? ratioBelow(maxArtifactBytes, 3, 4);
  const lowWaterSourceLeases = options.lowWaterSourceLeases
    ?? ratioBelow(maxSourceLeases, 2, 3);
  const maxIdleMs = options.maxIdleMs ?? DEFAULT_MAX_IDLE_MS;
  const publicationHandoffTtlMs = options.publicationHandoffTtlMs
    ?? DEFAULT_PUBLICATION_HANDOFF_TTL_MS;
  const sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
  const viewLeaseTtlMs = options.viewLeaseTtlMs ?? DEFAULT_VIEW_LEASE_TTL_MS;
  const maxViewLeases = options.maxViewLeases ?? DEFAULT_MAX_VIEW_LEASES;
  const maxIdsPerView = options.maxIdsPerView ?? DEFAULT_MAX_IDS_PER_VIEW;

  requireLowWater(lowWaterEntries, maxEntries, "lowWaterEntries", "maxEntries");
  requireLowWater(
    lowWaterArtifactBytes,
    maxArtifactBytes,
    "lowWaterArtifactBytes",
    "maxArtifactBytes",
  );
  requireLowWater(
    lowWaterSourceLeases,
    maxSourceLeases,
    "lowWaterSourceLeases",
    "maxSourceLeases",
  );
  requirePositiveSafeInteger(maxIdleMs, "maxIdleMs");
  requireNonNegativeSafeInteger(publicationHandoffTtlMs, "publicationHandoffTtlMs");
  requirePositiveSafeInteger(sweepIntervalMs, "sweepIntervalMs");
  requirePositiveSafeInteger(viewLeaseTtlMs, "viewLeaseTtlMs");
  requirePositiveSafeInteger(maxViewLeases, "maxViewLeases");
  requirePositiveSafeInteger(maxIdsPerView, "maxIdsPerView");
  if (options.now !== undefined && typeof options.now !== "function") {
    throw new TypeError("now must be a function");
  }

  return {
    maxEntries,
    lowWaterEntries,
    maxArtifactBytes,
    lowWaterArtifactBytes,
    maxSourceLeases,
    lowWaterSourceLeases,
    maxIdleMs,
    publicationHandoffTtlMs,
    sweepIntervalMs,
    viewLeaseTtlMs,
    maxViewLeases,
    maxIdsPerView,
    ...(options.now === undefined ? {} : { now: options.now }),
  };
}

/** Parse only explicit environment overrides; the resolver remains the owner of defaults. */
export function graphRetentionOptionsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Partial<GraphRetentionOptions> {
  const maxMiB = optionalPositiveDecimal(env[MAX_MIB_ENV], MAX_MIB_ENV);
  const maxEntries = optionalPositiveInteger(env[MAX_ENTRIES_ENV], MAX_ENTRIES_ENV);
  const maxSourceLeases = optionalPositiveInteger(
    env[MAX_SOURCE_LEASES_ENV],
    MAX_SOURCE_LEASES_ENV,
  );
  const maxIdleMinutes = optionalPositiveDecimal(
    env[MAX_IDLE_MINUTES_ENV],
    MAX_IDLE_MINUTES_ENV,
  );
  const maxArtifactBytes = maxMiB === undefined
    ? undefined
    : decimalUnit(maxMiB, MIB, MAX_MIB_ENV);
  const maxIdleMs = maxIdleMinutes === undefined
    ? undefined
    : decimalUnit(maxIdleMinutes, MINUTE_MS, MAX_IDLE_MINUTES_ENV);

  return {
    ...(maxArtifactBytes === undefined
      ? {}
      : {
        maxArtifactBytes,
        lowWaterArtifactBytes: ratioBelow(maxArtifactBytes, 3, 4),
      }),
    ...(maxEntries === undefined
      ? {}
      : { maxEntries, lowWaterEntries: ratioBelow(maxEntries, 3, 4) }),
    ...(maxSourceLeases === undefined
      ? {}
      : {
        maxSourceLeases,
        lowWaterSourceLeases: ratioBelow(maxSourceLeases, 2, 3),
      }),
    ...(maxIdleMs === undefined ? {} : { maxIdleMs }),
  };
}

/**
 * Deterministic pure policy: expire eligible idle registrations, then drain only dimensions that
 * crossed a high watermark down to their corresponding low watermark. Pins and publication
 * handoffs are absolute protections inside this selector. A store may temporarily remain above a
 * target while those owners are active, then run the policy again after release or expiry.
 */
export function selectGraphRetentionCandidates<
  Candidate extends GraphRetentionCandidate,
>(
  input: readonly Candidate[],
  policy: GraphRetentionOptions,
  fixedUsage: GraphRetentionUsage = { entries: 0, artifactBytes: 0, sourceLeases: 0 },
): GraphRetentionSelection<Candidate> {
  const resolved = resolveGraphRetentionOptions(policy);
  const now = resolved.now?.() ?? Date.now();
  requireNonNegativeSafeInteger(now, "now");
  const fixed = validatedUsage(fixedUsage, "fixed graph retention usage");
  const candidates = validatedCandidates(input);
  const total = usageOf(candidates, fixed);
  let projected = total;
  const selected: GraphRetentionDecision<Candidate>[] = [];
  const selectedIds = new Set<string>();

  for (const candidate of candidates) {
    if (!eligible(candidate, now)) continue;
    if (now - candidate.lastAccessAtMs < resolved.maxIdleMs) continue;
    selected.push({ candidate, reason: "max-idle" });
    selectedIds.add(candidate.id);
    projected = removeFromUsage(projected, candidate);
  }

  const pressure: GraphRetentionPressure = {
    entries: projected.entries > resolved.maxEntries,
    artifactBytes: projected.artifactBytes > resolved.maxArtifactBytes,
    sourceLeases: projected.sourceLeases > resolved.maxSourceLeases,
  };

  for (const candidate of candidates) {
    if (targetsReached(projected, pressure, resolved)) break;
    if (selectedIds.has(candidate.id) || !eligible(candidate, now)) continue;
    if (!reducesOutstandingPressure(candidate, projected, pressure, resolved)) continue;
    selected.push({ candidate, reason: "capacity" });
    projected = removeFromUsage(projected, candidate);
  }

  return { selected, total, projected, pressure };
}

function validatedCandidates<Candidate extends GraphRetentionCandidate>(
  input: readonly Candidate[],
): Candidate[] {
  const candidates = [...input];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (typeof candidate.id !== "string" || candidate.id.length === 0) {
      throw new TypeError("graph retention candidate id must not be empty");
    }
    if (seen.has(candidate.id)) {
      throw new TypeError(`duplicate graph retention candidate id: ${candidate.id}`);
    }
    seen.add(candidate.id);
    requireNonNegativeSafeInteger(
      candidate.artifactBytes,
      `candidate ${candidate.id} artifactBytes`,
    );
    if (candidate.sourceLeases !== 0 && candidate.sourceLeases !== 1) {
      throw new RangeError(`candidate ${candidate.id} sourceLeases must be 0 or 1`);
    }
    requireNonNegativeSafeInteger(
      candidate.publishedAtMs,
      `candidate ${candidate.id} publishedAtMs`,
    );
    requireNonNegativeSafeInteger(
      candidate.lastAccessAtMs,
      `candidate ${candidate.id} lastAccessAtMs`,
    );
    if (typeof candidate.pinned !== "boolean") {
      throw new TypeError(`candidate ${candidate.id} pinned must be a boolean`);
    }
    requireNonNegativeSafeInteger(candidate.handoffUntilMs, `candidate ${candidate.id} handoffUntilMs`);
  }
  candidates.sort(compareCandidates);
  return candidates;
}

function compareCandidates(left: GraphRetentionCandidate, right: GraphRetentionCandidate): number {
  if (left.lastAccessAtMs !== right.lastAccessAtMs) {
    return left.lastAccessAtMs - right.lastAccessAtMs;
  }
  if (left.publishedAtMs !== right.publishedAtMs) {
    return left.publishedAtMs - right.publishedAtMs;
  }
  if (left.id === right.id) return 0;
  return left.id < right.id ? -1 : 1;
}

function eligible(
  candidate: GraphRetentionCandidate,
  now: number,
): boolean {
  return !candidate.pinned
    && now >= candidate.handoffUntilMs;
}

function usageOf(
  candidates: readonly GraphRetentionCandidate[],
  fixed: GraphRetentionUsage,
): GraphRetentionUsage {
  let artifactBytes = fixed.artifactBytes;
  let sourceLeases = fixed.sourceLeases;
  for (const candidate of candidates) {
    artifactBytes = addSafe(artifactBytes, candidate.artifactBytes, "artifact byte total");
    sourceLeases = addSafe(sourceLeases, candidate.sourceLeases, "source lease total");
  }
  return {
    entries: addSafe(fixed.entries, candidates.length, "registration total"),
    artifactBytes,
    sourceLeases,
  };
}

function validatedUsage(usage: GraphRetentionUsage, label: string): GraphRetentionUsage {
  requireNonNegativeSafeInteger(usage.entries, `${label} entries`);
  requireNonNegativeSafeInteger(usage.artifactBytes, `${label} artifactBytes`);
  requireNonNegativeSafeInteger(usage.sourceLeases, `${label} sourceLeases`);
  return { ...usage };
}

function removeFromUsage(
  usage: GraphRetentionUsage,
  candidate: GraphRetentionCandidate,
): GraphRetentionUsage {
  return {
    entries: Math.max(0, usage.entries - 1),
    artifactBytes: Math.max(0, usage.artifactBytes - candidate.artifactBytes),
    sourceLeases: Math.max(0, usage.sourceLeases - candidate.sourceLeases),
  };
}

function targetsReached(
  usage: GraphRetentionUsage,
  pressure: GraphRetentionPressure,
  policy: GraphRetentionOptions,
): boolean {
  return (!pressure.entries || usage.entries <= policy.lowWaterEntries)
    && (!pressure.artifactBytes || usage.artifactBytes <= policy.lowWaterArtifactBytes)
    && (!pressure.sourceLeases || usage.sourceLeases <= policy.lowWaterSourceLeases);
}

function reducesOutstandingPressure(
  candidate: GraphRetentionCandidate,
  usage: GraphRetentionUsage,
  pressure: GraphRetentionPressure,
  policy: GraphRetentionOptions,
): boolean {
  return (pressure.entries && usage.entries > policy.lowWaterEntries)
    || (pressure.artifactBytes
      && usage.artifactBytes > policy.lowWaterArtifactBytes
      && candidate.artifactBytes > 0)
    || (pressure.sourceLeases
      && usage.sourceLeases > policy.lowWaterSourceLeases
      && candidate.sourceLeases > 0);
}

function ratioBelow(high: number, numerator: number, denominator: number): number {
  requirePositiveSafeInteger(high, "high watermark");
  const derived = Number((BigInt(high) * BigInt(numerator)) / BigInt(denominator));
  return Math.min(high - 1, derived);
}

function requireLowWater(value: number, high: number, name: string, highName: string): void {
  requireNonNegativeSafeInteger(value, name);
  if (value >= high) throw new RangeError(`${name} must be less than ${highName}`);
}

function optionalPositiveInteger(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) throw new TypeError(`${name} must be a positive integer`);
  const parsed = Number(normalized);
  requirePositiveSafeInteger(parsed, name);
  return parsed;
}

function optionalPositiveDecimal(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(normalized)) {
    throw new TypeError(`${name} must be a positive decimal number`);
  }
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new RangeError(`${name} must be greater than zero`);
  }
  return parsed;
}

function decimalUnit(value: number, unit: number, name: string): number {
  const result = Math.floor(value * unit);
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new RangeError(`${name} is outside the supported range`);
  }
  return result;
}

function requirePositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}

function requireNonNegativeSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
}

function addSafe(left: number, right: number, name: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) throw new RangeError(`${name} exceeds the supported range`);
  return result;
}
