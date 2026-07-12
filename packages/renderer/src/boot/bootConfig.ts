/**
 * Read the boot contract the CLI injects as `window.__MERIDIAN__` at view time.
 *
 * The single non-negotiable invariant: `defaultEnv` is ALWAYS null — environment must never
 * be defaulted (especially not to prod). We assert it rather than trust it. With no injected
 * config (plain `vite dev`, no server) we synthesize a dev fallback that loads a bundled
 * sample, so the production path is never coupled to the dev convenience path.
 */

import { telemetrySourceDescriptorSchema } from "@meridian/core";
import type { TelemetrySourceDescriptor } from "@meridian/core";
import type { PrSessionSource } from "../state/prTypes";

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

interface InjectedConfig extends Omit<BootConfig, "defaultEnv" | "githubSource" | "traceUrl" | "traceAvailable" | "telemetrySources" | "preselectedTelemetrySourceId"> {
  /** Optional so a renderer cached before the trace endpoint shipped still boots safely. */
  traceUrl?: unknown;
  /** Optional for HTML produced before in-app source selection shipped. */
  telemetrySources?: unknown;
  preselectedTelemetrySourceId?: unknown;
  /** Optional for compatibility with renderer HTML cached from before this capability existed. */
  githubSource?: unknown;
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
  // Dev sample ships with no telemetry, so the env gate is off by default — a real `meridian view`
  // / `web` overlay still sets hasOverlay via the injected config, so the production gate is intact.
  hasOverlay: false,
  overlayKind: "mock",
  envRequired: true,
  preselectedEnv: null,
  telemetrySources: [],
  preselectedTelemetrySourceId: null,
  sourceUrl: null,
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
    githubSource,
    defaultEnv: null,
  };
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
