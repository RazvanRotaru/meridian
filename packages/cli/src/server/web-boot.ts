/**
 * Boot-script injection for the web flow.
 *
 * `/view?id=<id>` serves the unchanged renderer bundle with a `window.__MERIDIAN__` that
 * points at this graph's per-id endpoints and states the never-default contract explicitly.
 * Web mode has no configured/observed overlay, but it does advertise the safe synthetic demo
 * source; it remains unselected, so `envRequired`/`hasOverlay` are false and `defaultEnv` is null.
 * The landing page gets a separate one-line prefill so a CLI positional can pre-fill the form.
 */

import type { SyntheticScenarioDescriptor } from "@meridian/core";
import { telemetrySourceDescriptors } from "./overlay-source";
import { canonicalExtractionSubdir, type ArtifactSource } from "./web-source";

const HEAD_CLOSE = "</head>";
const WEB_TELEMETRY_SOURCES = telemetrySourceDescriptors({ kind: "none" });

export type SyntheticExecutionTrust =
  | { mode: "local" }
  | { mode: "sandboxed-pr"; provenance: { repository: string; headSha: string } };

export interface SyntheticExecutionBootCapability {
  syntheticExecutionUrl: string | null;
  syntheticScenarios: SyntheticScenarioDescriptor[];
  syntheticExecutionTrust: SyntheticExecutionTrust | null;
}

/** One exact, per-id capability projection shared by initial boot and subsequent graph/meta swaps. */
export function syntheticExecutionBootCapability(
  id: string,
  source: ArtifactSource | undefined,
  syntheticScenarios: SyntheticScenarioDescriptor[] | null = null,
  syntheticExecutionTrust: SyntheticExecutionTrust | null = null,
): SyntheticExecutionBootCapability {
  const trustMatches = (source?.kind === "path" && syntheticExecutionTrust?.mode === "local")
    || (
      source?.kind === "github"
      && syntheticExecutionTrust?.mode === "sandboxed-pr"
      && syntheticExecutionTrust.provenance.repository === `${source.owner}/${source.repo}`
      && syntheticExecutionTrust.provenance.headSha.length > 0
    );
  if (!trustMatches || syntheticScenarios === null || syntheticScenarios.length === 0) {
    return { syntheticExecutionUrl: null, syntheticScenarios: [], syntheticExecutionTrust: null };
  }
  return {
    syntheticExecutionUrl: `/api/synthetic-executions?id=${id}`,
    syntheticScenarios: syntheticScenarios ?? [],
    syntheticExecutionTrust,
  };
}

export function injectViewBoot(
  html: string,
  id: string,
  source: ArtifactSource | undefined,
  syntheticScenarios: SyntheticScenarioDescriptor[] | null = null,
  syntheticExecutionTrust: SyntheticExecutionTrust | null = null,
  preparedReviewUrl: string | null = null,
): string {
  // A catalog is a capability, not just display data. Local paths are admitted as before. GitHub
  // sources require an explicit, per-id sandbox trust record created only after the CLI flag and
  // OCI runtime checks pass; a stale/mismatched record can never advertise an endpoint.
  const syntheticCapability = syntheticExecutionBootCapability(
    id,
    source,
    syntheticScenarios,
    syntheticExecutionTrust,
  );
  const boot = {
    projectionManifestUrl: `/api/graph/manifest?id=${id}`,
    projectionUrl: `/api/graph/projection?id=${id}`,
    metaUrl: `/api/meta?id=${id}`,
    overlayUrl: `/api/overlay?id=${id}`,
    traceUrl: `/api/traces?id=${id}`,
    sourceUrl: `/api/source?id=${id}`,
    // The potentially large two-sided manifest remains behind a validated immutable file URL.
    // Ordinary graph views carry an explicit null and never infer a review from query parameters.
    preparedReviewUrl,
    ...syntheticCapability,
    hasOverlay: false,
    overlayKind: null,
    telemetrySources: WEB_TELEMETRY_SOURCES,
    preselectedTelemetrySourceId: null,
    envRequired: false,
    preselectedEnv: null,
    defaultEnv: null,
    githubSource: githubBootSource(source),
  };
  return injectScript(html, `window.__MERIDIAN__=${escapeForScript(JSON.stringify(boot))}`);
}

function githubBootSource(source: ArtifactSource | undefined): { repository: string; subdir: string } | null {
  return source?.kind === "github"
    ? { repository: `${source.owner}/${source.repo}`, subdir: canonicalExtractionSubdir(source.subdir) }
    : null;
}

export function injectPrefill(html: string, source: string | undefined): string {
  if (!source) {
    return html;
  }
  return injectScript(html, `window.__MERIDIAN_PREFILL__=${escapeForScript(JSON.stringify(source))}`);
}

function injectScript(html: string, body: string): string {
  const script = `<script>${body}</script>`;
  if (html.includes(HEAD_CLOSE)) {
    return html.replace(HEAD_CLOSE, `${script}${HEAD_CLOSE}`);
  }
  return `${script}${html}`;
}

// Escape `<`/`>` so an injected value can never terminate the inline <script> tag. The escapes
// parse back to the same characters, so the boot object is unchanged.
function escapeForScript(json: string): string {
  return json.replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
}
