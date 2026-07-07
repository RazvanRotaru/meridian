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
  /** PR-review seed: the changed files the server injected; empty when not a PR-sourced view. */
  affectedFiles: string[];
  /** The review scope id ("pr"+number) when PR-sourced; null keys the ticks by the file-set hash. */
  reviewScopeRef: string | null;
  /** True when GitHub capped the PR's changed-file list; the review list surfaces it as a notice. */
  reviewTruncated: boolean;
  defaultEnv: null;
}

interface InjectedConfig extends Omit<BootConfig, "defaultEnv" | "affectedFiles" | "reviewScopeRef" | "reviewTruncated"> {
  defaultEnv: unknown;
  /** Optional — pre-PR servers omit these entirely, so they normalize to []/null/false on read. */
  affectedFiles?: string[];
  reviewScopeRef?: string | null;
  reviewTruncated?: boolean;
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
  hasOverlay: true,
  overlayKind: "mock",
  envRequired: true,
  preselectedEnv: null,
  sourceUrl: null,
  affectedFiles: [],
  reviewScopeRef: null,
  reviewTruncated: false,
  defaultEnv: null,
};

export function readBootConfig(): BootConfig {
  const injected = typeof window === "undefined" ? undefined : window.__MERIDIAN__;
  if (!injected) {
    return DEV_FALLBACK;
  }
  return assertNeverDefaulted(injected);
}

function assertNeverDefaulted(injected: InjectedConfig): BootConfig {
  if (injected.defaultEnv !== null) {
    throw new Error("boot contract violation: defaultEnv must never be defaulted (always null)");
  }
  return {
    ...injected,
    defaultEnv: null,
    affectedFiles: injected.affectedFiles ?? [],
    reviewScopeRef: injected.reviewScopeRef ?? null,
    reviewTruncated: injected.reviewTruncated ?? false,
  };
}
