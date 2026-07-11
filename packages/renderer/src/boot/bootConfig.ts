/**
 * Read the boot contract the CLI injects as `window.__MERIDIAN__` at view time.
 *
 * The single non-negotiable invariant: `defaultEnv` is ALWAYS null — environment must never
 * be defaulted (especially not to prod). We assert it rather than trust it. With no injected
 * config (plain `vite dev`, no server) we synthesize a dev fallback that loads a bundled
 * sample, so the production path is never coupled to the dev convenience path.
 */

import type { PrSessionSource } from "../state/prTypes";

export interface BootConfig {
  graphUrl: string;
  metaUrl: string;
  overlayUrl: string;
  hasOverlay: boolean;
  overlayKind: "mock" | "file" | "tempo" | null;
  envRequired: boolean;
  preselectedEnv: string | null;
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

interface InjectedConfig extends Omit<BootConfig, "defaultEnv" | "githubSource"> {
  defaultEnv: unknown;
  githubSource?: PrSessionSource | null;
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
  // Dev sample ships with no telemetry, so the env gate is off by default — a real `meridian view`
  // / `web` overlay still sets hasOverlay via the injected config, so the production gate is intact.
  hasOverlay: false,
  overlayKind: "mock",
  envRequired: true,
  preselectedEnv: null,
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
  return { ...injected, githubSource: injected.githubSource ?? null, defaultEnv: null };
}

function apiUrl(path: string, id: string | null): string {
  const params = new URLSearchParams();
  if (id) {
    params.set("id", id);
  }
  const search = params.toString();
  return search ? `${path}?${search}` : path;
}
