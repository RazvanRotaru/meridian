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

export interface BootConfig {
  graphUrl: string;
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
  /** GET base for one changed file's text at the PR head ref (the review code panel). */
  prFileUrl: string;
  /** POST target for submitting a review with comments; 404s outside a `web` GitHub session. */
  prReviewUrl: string;
  /** POST target streaming the PR-head prepare pipeline (the analyze stages). */
  analyzeUrl: string;
  /** The server-session artifact id the analyze POST body names; null in a plain `view` session
   * (which is also what gates reviewPrInGraph to its synchronous fallback). */
  graphId: string | null;
}

interface InjectedConfig extends Omit<BootConfig, "defaultEnv" | "githubSource" | "traceUrl" | "traceAvailable" | "telemetrySources" | "preselectedTelemetrySourceId" | "syntheticExecutionUrl" | "syntheticExecutionTrust" | "syntheticScenarios"> {
  /** Optional so a renderer cached before the trace endpoint shipped still boots safely. */
  traceUrl?: unknown;
  /** Optional for HTML produced before in-app source selection shipped. */
  telemetrySources?: unknown;
  preselectedTelemetrySourceId?: unknown;
  /** Optional for compatibility with renderer HTML cached from before this capability existed. */
  githubSource?: unknown;
  /** Optional for compatibility with servers predating opt-in local execution. */
  syntheticExecutionUrl?: unknown;
  syntheticExecutionTrust?: unknown;
  syntheticScenarios?: unknown;
  defaultEnv: unknown;
}

declare global {
  interface Window {
    __MERIDIAN__?: InjectedConfig;
  }
}

const DEV_FALLBACK: BootConfig = {
  graphUrl: "/sample-graph.json",
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
  defaultEnv: null,
};

export function readBootConfig(): BootConfig {
  const injected = typeof window === "undefined" ? undefined : window.__MERIDIAN__;
  if (!injected) {
    return DEV_FALLBACK;
  }
  return assertNeverDefaulted(injected);
}

export function prApiUrlsFromGraphUrl(graphUrl: string): PrApiUrls {
  const graph = new URL(graphUrl, "http://meridian.local");
  const id = graph.searchParams.get("id");
  return {
    prsUrl: apiUrl("/api/prs", id),
    prOneUrl: apiUrl("/api/prs/one", id),
    prFilesUrl: apiUrl("/api/prs/files", id),
    prRelatedUrl: apiUrl("/api/prs/related", id),
    prCommentsUrl: apiUrl("/api/prs/comments", id),
    prChecksUrl: apiUrl("/api/prs/checks", id),
    prFileUrl: apiUrl("/api/prs/file", id),
    prReviewUrl: apiUrl("/api/prs/review", id),
    analyzeUrl: "/api/pr/analyze",
    graphId: id,
  };
}

function assertNeverDefaulted(injected: InjectedConfig): BootConfig {
  if (injected.defaultEnv !== null) {
    throw new Error("boot contract violation: defaultEnv must never be defaulted (always null)");
  }
  // Cached pre-capability HTML may inject nothing or a legacy boolean — only the session-source
  // OBJECT counts; anything else normalizes to null (no PR surfaces).
  const source = injected.githubSource;
  const githubSource = typeof source === "object" && source !== null ? (source as PrSessionSource) : null;
  const traceAvailable = typeof injected.traceUrl === "string" && injected.traceUrl.length > 0;
  const traceUrl = traceAvailable
    ? injected.traceUrl as string
    : "/api/traces";
  const telemetrySources = normalizeTelemetrySources(injected.telemetrySources);
  const syntheticExecutionUrl = typeof injected.syntheticExecutionUrl === "string"
    && injected.syntheticExecutionUrl.trim().length > 0
    ? injected.syntheticExecutionUrl
    : null;
  const syntheticScenarios = normalizeSyntheticScenarios(injected.syntheticScenarios);
  const syntheticExecutionTrust = normalizeSyntheticExecutionTrust(
    injected.syntheticExecutionTrust,
    syntheticExecutionUrl,
  );
  const explicitTelemetrySourceId = typeof injected.preselectedTelemetrySourceId === "string"
    && injected.preselectedTelemetrySourceId.trim().length > 0
    ? injected.preselectedTelemetrySourceId
    : null;
  // An old server has no catalog field at all and its single overlay is already an explicit boot
  // capability. Keep that session selected. A present catalog (including `[]`) uses the new rule:
  // nothing is active unless preselectedTelemetrySourceId names it.
  const legacyTelemetrySourceId = injected.telemetrySources === undefined && injected.hasOverlay
    ? injected.overlayKind
    : null;
  const preselectedTelemetrySourceId = explicitTelemetrySourceId ?? legacyTelemetrySourceId;
  return {
    ...injected,
    traceUrl,
    traceAvailable,
    telemetrySources,
    preselectedTelemetrySourceId,
    syntheticExecutionUrl,
    syntheticExecutionTrust,
    syntheticScenarios,
    githubSource,
    defaultEnv: null,
  };
}

function normalizeSyntheticExecutionTrust(
  value: unknown,
  executionUrl: string | null,
): SyntheticExecutionTrust | null {
  if (executionUrl === null) return null;
  // Compatibility for trusted-local servers shipped before the trust descriptor. A server that
  // does inject the field must provide a valid object; malformed explicit claims fail closed.
  if (value === undefined) return { mode: "local" };
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

function normalizeSyntheticScenarios(value: unknown): SyntheticScenarioDescriptor[] {
  if (!Array.isArray(value)) return [];
  const scenarios: SyntheticScenarioDescriptor[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    const parsed = syntheticScenarioDescriptorSchema.safeParse(candidate);
    if (!parsed.success || seen.has(parsed.data.id)) continue;
    seen.add(parsed.data.id);
    scenarios.push(parsed.data);
  }
  return scenarios;
}

function normalizeTelemetrySources(value: unknown): TelemetrySourceDescriptor[] {
  if (!Array.isArray(value)) return [];
  const sources: TelemetrySourceDescriptor[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    const parsed = telemetrySourceDescriptorSchema.safeParse(candidate);
    if (!parsed.success || seen.has(parsed.data.id)) continue;
    seen.add(parsed.data.id);
    sources.push({ ...parsed.data, environments: [...parsed.data.environments] });
  }
  return sources;
}

function apiUrl(path: string, id: string | null): string {
  const params = new URLSearchParams();
  if (id) {
    params.set("id", id);
  }
  const search = params.toString();
  return search ? `${path}?${search}` : path;
}
