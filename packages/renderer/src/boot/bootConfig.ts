/**
 * Read the boot contract the CLI injects as `window.__MERIDIAN__` at view time.
 *
 * The single non-negotiable invariant: `defaultEnv` is ALWAYS null — environment must never
 * be defaulted (especially not to prod). We assert it rather than trust it. With no injected
 * config (plain `vite dev`, no server) we synthesize a dev fallback that loads a bundled
 * sample, so the production path is never coupled to the dev convenience path.
 */

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
  defaultEnv: null;
}

export interface PrApiUrls {
  prsUrl: string;
  prFilesUrl: string;
  /** GET base for one changed file's text at the PR head ref (the review code panel). */
  prFileUrl: string;
  /** POST target for submitting a review with comments; 404s outside a `web` GitHub session. */
  prReviewUrl: string;
}

interface InjectedConfig extends Omit<BootConfig, "defaultEnv"> {
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
  // Dev sample ships with no telemetry, so the env gate is off by default — a real `meridian view`
  // / `web` overlay still sets hasOverlay via the injected config, so the production gate is intact.
  hasOverlay: false,
  overlayKind: "mock",
  envRequired: true,
  preselectedEnv: null,
  sourceUrl: null,
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
    prFilesUrl: apiUrl("/api/prs/files", id),
    prFileUrl: apiUrl("/api/prs/file", id),
    prReviewUrl: apiUrl("/api/prs/review", id),
  };
}

function assertNeverDefaulted(injected: InjectedConfig): BootConfig {
  if (injected.defaultEnv !== null) {
    throw new Error("boot contract violation: defaultEnv must never be defaulted (always null)");
  }
  return { ...injected, defaultEnv: null };
}

function apiUrl(path: string, id: string | null): string {
  const params = new URLSearchParams();
  if (id) {
    params.set("id", id);
  }
  const search = params.toString();
  return search ? `${path}?${search}` : path;
}
