/**
 * Read the boot contract the CLI injects as `window.__MERIDIAN__` at view time.
 *
 * The single non-negotiable invariant: `defaultEnv` is ALWAYS null — environment must never
 * be defaulted (especially not to prod). We assert it rather than trust it. With no injected
 * config (plain `vite dev`, no server) we synthesize a dev fallback that loads a bundled
 * sample, so the production path is never coupled to the dev convenience path.
 */

import { syntheticScenarioDescriptorSchema, telemetrySourceDescriptorSchema } from "@meridian/core";
import type { SyntheticScenarioDescriptor, TelemetrySourceDescriptor } from "@meridian/core";
import type { PrSessionSource } from "../state/prTypes";
import type { SyntheticExecutionTrust } from "../state/syntheticExecutionTrust";

export type GraphBootSource =
  | { kind: "dev-sample"; artifactUrl: string }
  | { kind: "projections"; manifestUrl: string; projectionUrl: string };

export interface BootConfig {
  /** The production source is always projection transport; the complete artifact is Vite-only. */
  graphSource: GraphBootSource;
  metaUrl: string;
  overlayUrl: string;
  /** Request-trace endpoint, separate from the aggregate metrics overlay. */
  traceUrl: string;
  /** True only when injected HTML explicitly advertised the trace endpoint. */
  traceAvailable: boolean;
  hasOverlay: boolean;
  overlayKind: "mock" | "file" | "tempo" | null;
  envRequired: boolean;
  preselectedEnv: string | null;
  /** Sources the server makes available in-app. Nothing is active unless the companion id is set. */
  telemetrySources: TelemetrySourceDescriptor[];
  preselectedTelemetrySourceId: string | null;
  /** Base URL the renderer GETs to fetch a node's source; null when source isn't available. */
  sourceUrl: string | null;
  /** Explicit opt-in local execution capability. Null means this server cannot run code. */
  syntheticExecutionUrl: string | null;
  /** Server-attested boundary in which synthetic code executes. Null means no runnable boundary. */
  syntheticExecutionTrust: SyntheticExecutionTrust | null;
  /** Bounded server-authored scenarios; arbitrary graph nodes never become executable by inference. */
  syntheticScenarios: SyntheticScenarioDescriptor[];
  /** Exact GitHub session source; null for local/plain-view artifacts. */
  githubSource: PrSessionSource | null;
  /** Immutable v1 review handoff for a server-validated shared review URL; null otherwise. */
  preparedReviewUrl: string | null;
  defaultEnv: null;
}

export interface PrApiUrls {
  prsUrl: string;
  prOneUrl: string;
  prFilesUrl: string;
  /** POST target for finding open PRs that touch a bounded set of source paths. */
  prRelatedUrl: string;
  /** GET target for existing inline comments and the latest review state per author. */
  prCommentsUrl: string;
  /** GET target for the selected PR head commit's check-run rollup. */
  prChecksUrl: string;
  /** GET base for one changed file's text at the selected PR head ref. */
  prFileUrl: string;
  /** POST target for submitting a review with comments; 404s outside a `web` GitHub session. */
  prReviewUrl: string;
  /** Direct POST target streaming immutable head + merge-base graph preparation. */
  prepareUrl: string;
}

interface InjectedConfig extends Omit<BootConfig, "graphSource" | "defaultEnv" | "githubSource" | "preparedReviewUrl" | "traceUrl" | "traceAvailable" | "telemetrySources" | "preselectedTelemetrySourceId" | "syntheticExecutionUrl" | "syntheticExecutionTrust" | "syntheticScenarios"> {
  /** Every server-rendered session uses the current, strict transport contract. */
  traceUrl: unknown;
  telemetrySources: unknown;
  preselectedTelemetrySourceId: unknown;
  /** Required for every injected/server session; typed unknown so violations fail explicitly. */
  projectionManifestUrl: unknown;
  projectionUrl: unknown;
  syntheticExecutionUrl: unknown;
  syntheticExecutionTrust: unknown;
  syntheticScenarios: unknown;
  githubSource: unknown;
  preparedReviewUrl: unknown;
  defaultEnv: unknown;
}

declare global {
  interface Window {
    __MERIDIAN__?: InjectedConfig;
  }
}

const DEV_FALLBACK: BootConfig = {
  graphSource: { kind: "dev-sample", artifactUrl: "/sample-graph.json" },
  metaUrl: "/api/meta",
  overlayUrl: "/api/overlay",
  traceUrl: "/api/traces",
  traceAvailable: false,
  // Dev sample ships with no telemetry, so the env gate is off by default — a real `meridian web`
  // / `web` overlay still sets hasOverlay via the injected config, so the production gate is intact.
  hasOverlay: false,
  overlayKind: "mock",
  envRequired: true,
  preselectedEnv: null,
  telemetrySources: [{
    id: "demo",
    kind: "mock",
    label: "Synthetic demo",
    provenance: "synthetic",
    environments: ["demo"],
    environmentMode: "enumerated",
    supportsMetrics: true,
    supportsTraces: true,
  }],
  preselectedTelemetrySourceId: null,
  sourceUrl: null,
  syntheticExecutionUrl: null,
  syntheticExecutionTrust: null,
  syntheticScenarios: [],
  githubSource: null,
  preparedReviewUrl: null,
  defaultEnv: null,
};

export function readBootConfig(): BootConfig {
  const injected = typeof window === "undefined" ? undefined : window.__MERIDIAN__;
  if (!injected) {
    return DEV_FALLBACK;
  }
  return assertNeverDefaulted(injected);
}

export function prApiUrlsFromProjectionManifest(manifestUrl: string | null): PrApiUrls {
  const id = manifestUrl === null
    ? null
    : new URL(manifestUrl, "http://meridian.local").searchParams.get("id");
  return {
    prsUrl: apiUrl("/api/prs", id),
    prOneUrl: apiUrl("/api/prs/one", id),
    prFilesUrl: apiUrl("/api/prs/files", id),
    prRelatedUrl: apiUrl("/api/prs/related", id),
    prCommentsUrl: apiUrl("/api/prs/comments", id),
    prChecksUrl: apiUrl("/api/prs/checks", id),
    prFileUrl: apiUrl("/api/prs/file", id),
    prReviewUrl: apiUrl("/api/prs/review", id),
    prepareUrl: "/api/pr/prepare",
  };
}

function assertNeverDefaulted(injected: InjectedConfig): BootConfig {
  requireCurrentInjectedFields(injected);
  if (injected.defaultEnv !== null) {
    throw new Error("boot contract violation: defaultEnv must never be defaulted (always null)");
  }
  const githubSource = parseGithubSource(injected.githubSource);
  const preparedReviewUrl = parsePreparedReviewUrl(injected.preparedReviewUrl);
  if (preparedReviewUrl !== null && githubSource === null) {
    throw new Error("boot contract violation: preparedReviewUrl requires githubSource");
  }
  const traceUrl = requiredNonEmptyString(injected.traceUrl, "traceUrl");
  const telemetrySources = normalizeTelemetrySources(injected.telemetrySources);
  const syntheticExecutionUrl = nonEmptyString(injected.syntheticExecutionUrl);
  const parsedSyntheticScenarios = normalizeSyntheticScenarios(injected.syntheticScenarios);
  const parsedSyntheticExecutionTrust = normalizeSyntheticExecutionTrust(
    injected.syntheticExecutionTrust,
    syntheticExecutionUrl,
  );
  const projectionManifestUrl = nonEmptyString(injected.projectionManifestUrl);
  const projectionUrl = nonEmptyString(injected.projectionUrl);
  if (projectionManifestUrl === null || projectionUrl === null) {
    throw new Error(
      "boot contract violation: injected sessions require projectionManifestUrl and projectionUrl",
    );
  }
  const preselectedTelemetrySourceId = parseTelemetrySelection(
    injected.preselectedTelemetrySourceId,
    telemetrySources,
  );
  // Synthetic metadata is one authority-bearing unit. A malformed/duplicate catalog or invalid
  // trust claim disables the entire capability rather than preserving a misleading subset.
  const syntheticCapabilityValid = parsedSyntheticScenarios !== null
    && (syntheticExecutionUrl === null
      ? parsedSyntheticExecutionTrust === null && parsedSyntheticScenarios.length === 0
      : parsedSyntheticExecutionTrust !== null && parsedSyntheticScenarios.length > 0);
  const effectiveSyntheticExecutionUrl = syntheticCapabilityValid ? syntheticExecutionUrl : null;
  const syntheticExecutionTrust = syntheticCapabilityValid ? parsedSyntheticExecutionTrust : null;
  const syntheticScenarios = syntheticCapabilityValid ? parsedSyntheticScenarios! : [];
  return {
    graphSource: { kind: "projections", manifestUrl: projectionManifestUrl, projectionUrl },
    metaUrl: injected.metaUrl,
    overlayUrl: injected.overlayUrl,
    traceUrl,
    traceAvailable: true,
    hasOverlay: injected.hasOverlay,
    overlayKind: injected.overlayKind,
    envRequired: injected.envRequired,
    preselectedEnv: injected.preselectedEnv,
    telemetrySources,
    preselectedTelemetrySourceId,
    sourceUrl: injected.sourceUrl,
    syntheticExecutionUrl: effectiveSyntheticExecutionUrl,
    syntheticExecutionTrust,
    syntheticScenarios,
    githubSource,
    preparedReviewUrl,
    defaultEnv: null,
  };
}

function requireCurrentInjectedFields(injected: InjectedConfig): void {
  for (const field of [
    "projectionManifestUrl",
    "projectionUrl",
    "traceUrl",
    "telemetrySources",
    "preselectedTelemetrySourceId",
    "syntheticExecutionUrl",
    "syntheticExecutionTrust",
    "syntheticScenarios",
    "githubSource",
    "preparedReviewUrl",
  ] as const) {
    if (!Object.prototype.hasOwnProperty.call(injected, field)) {
      throw new Error(`boot contract violation: missing current field ${field}`);
    }
  }
}

function parsePreparedReviewUrl(value: unknown): string | null {
  if (value === null) return null;
  const raw = requiredNonEmptyString(value, "preparedReviewUrl");
  if (!raw.startsWith("/")) {
    throw new Error("boot contract violation: preparedReviewUrl must be same-origin");
  }
  const parsed = new URL(raw, "http://meridian.local");
  const keys = [...parsed.searchParams.keys()];
  if (
    parsed.origin !== "http://meridian.local"
    || parsed.pathname !== "/api/pr/prepared"
    || parsed.hash.length > 0
    || keys.length !== 1
    || keys[0] !== "id"
    || (parsed.searchParams.get("id")?.length ?? 0) === 0
  ) {
    throw new Error("boot contract violation: preparedReviewUrl is malformed");
  }
  return `${parsed.pathname}${parsed.search}`;
}

function nonEmptyString(value: unknown): string | null {
  if (value === null) return null;
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function requiredNonEmptyString(value: unknown, field: string): string {
  const parsed = nonEmptyString(value);
  if (parsed === null) throw new Error(`boot contract violation: ${field} must be a non-empty string`);
  return parsed;
}

function parseGithubSource(value: unknown): PrSessionSource | null {
  if (value === null) return null;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("boot contract violation: githubSource must be an object or null");
  }
  const candidate = value as Record<string, unknown>;
  const repository = requiredNonEmptyString(candidate.repository, "githubSource.repository");
  const subdir = typeof candidate.subdir === "string" ? candidate.subdir : null;
  if (!/^[^/\s]+\/[^/\s]+$/.test(repository) || subdir === null) {
    throw new Error("boot contract violation: githubSource is malformed");
  }
  return { repository, subdir };
}
function normalizeSyntheticExecutionTrust(
  value: unknown,
  executionUrl: string | null,
): SyntheticExecutionTrust | null {
  if (executionUrl === null) return null;
  // Trust is server-authored and explicit. Never infer local execution from a URL or session kind.
  if (value === undefined) return null;
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as { mode?: unknown; provenance?: unknown };
  if (candidate.mode !== "local" && candidate.mode !== "sandboxed-pr") return null;
  const provenance = normalizeSyntheticExecutionProvenance(candidate.provenance);
  if (candidate.mode === "sandboxed-pr") {
    if (provenance?.repository === undefined || provenance.headSha === undefined) return null;
    return { mode: "sandboxed-pr", provenance: { repository: provenance.repository, headSha: provenance.headSha } };
  }
  return provenance === undefined ? { mode: "local" } : { mode: "local", provenance };
}

function normalizeSyntheticExecutionProvenance(value: unknown): SyntheticExecutionTrust["provenance"] {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as { repository?: unknown; headSha?: unknown };
  const repository = normalizedBoundedString(candidate.repository, 512);
  const headSha = normalizedBoundedString(candidate.headSha, 128);
  return repository === undefined && headSha === undefined ? undefined : { repository, headSha };
}

function normalizedBoundedString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length === 0 || normalized.length > maxLength ? undefined : normalized;
}

function normalizeSyntheticScenarios(value: unknown): SyntheticScenarioDescriptor[] | null {
  if (!Array.isArray(value)) return null;
  const scenarios: SyntheticScenarioDescriptor[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    const parsed = syntheticScenarioDescriptorSchema.safeParse(candidate);
    if (!parsed.success || seen.has(parsed.data.id)) return null;
    seen.add(parsed.data.id);
    scenarios.push(parsed.data);
  }
  return scenarios;
}

function normalizeTelemetrySources(value: unknown): TelemetrySourceDescriptor[] {
  if (!Array.isArray(value)) {
    throw new Error("boot contract violation: telemetrySources must be an array");
  }
  const sources: TelemetrySourceDescriptor[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    const parsed = telemetrySourceDescriptorSchema.safeParse(candidate);
    if (!parsed.success || seen.has(parsed.data.id)) {
      throw new Error("boot contract violation: telemetrySources contains an invalid or duplicate descriptor");
    }
    seen.add(parsed.data.id);
    sources.push({ ...parsed.data, environments: [...parsed.data.environments] });
  }
  return sources;
}

function parseTelemetrySelection(
  value: unknown,
  sources: readonly TelemetrySourceDescriptor[],
): string | null {
  if (value === null) return null;
  const id = requiredNonEmptyString(value, "preselectedTelemetrySourceId");
  if (!sources.some((source) => source.id === id)) {
    throw new Error("boot contract violation: preselectedTelemetrySourceId is not in telemetrySources");
  }
  return id;
}

function apiUrl(path: string, id: string | null): string {
  const params = new URLSearchParams();
  if (id) {
    params.set("id", id);
  }
  const search = params.toString();
  return search ? `${path}?${search}` : path;
}
