/**
 * The `window.__MERIDIAN__` contract injected into the served `index.html`.
 *
 * `defaultEnv` is always null and `envRequired` mirrors `hasOverlay`: the renderer asserts
 * the never-default-prod invariant from this very object, so the server states it explicitly
 * rather than letting the SPA infer an environment.
 */

import type { SyntheticScenarioDescriptor } from "@meridian/core";
import {
  hasOverlay,
  overlayKind,
  preselectedTelemetrySourceId,
  telemetrySourceDescriptors,
} from "./overlay-source";
import type { OverlaySource } from "./overlay-source";

const HEAD_CLOSE = "</head>";

export function injectBootScript(
  html: string,
  projectionGraphId: string,
  overlay: OverlaySource,
  preselectedEnv: string | null,
  sourceRoot: string | null,
  syntheticScenarios: SyntheticScenarioDescriptor[] | null = null,
): string {
  const script = `<script>window.__MERIDIAN__=${escapeForScript(bootJson(
    projectionGraphId,
    overlay,
    preselectedEnv,
    sourceRoot,
    syntheticScenarios,
  ))}</script>`;
  if (html.includes(HEAD_CLOSE)) {
    return html.replace(HEAD_CLOSE, `${script}${HEAD_CLOSE}`);
  }
  return `${script}${html}`;
}

// Escape `<`/`>` so a hostile --env value cannot terminate the inline <script> tag. The
// `<`/`>` escapes parse back to the same characters, so the boot object is unchanged.
function escapeForScript(json: string): string {
  return json.replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
}

function bootJson(
  projectionGraphId: string,
  overlay: OverlaySource,
  preselectedEnv: string | null,
  sourceRoot: string | null,
  syntheticScenarios: SyntheticScenarioDescriptor[] | null,
): string {
  const syntheticEnabled = syntheticScenarios !== null;
  return JSON.stringify({
    projectionGraphId,
    projectionManifestUrl: "/api/graph/manifest",
    projectionUrl: "/api/graph/projection",
    graphSearchUrl: "/api/graph/search",
    metaUrl: "/api/meta",
    overlayUrl: "/api/overlay",
    traceUrl: "/api/traces",
    sourceUrl: sourceRoot ? "/api/source" : null,
    syntheticExecutionUrl: syntheticEnabled ? "/api/synthetic-executions" : null,
    syntheticExecutionTrust: syntheticEnabled ? { mode: "local" } : null,
    syntheticScenarios: syntheticScenarios ?? [],
    hasOverlay: hasOverlay(overlay),
    overlayKind: overlayKind(overlay),
    telemetrySources: telemetrySourceDescriptors(overlay, preselectedEnv),
    preselectedTelemetrySourceId: preselectedTelemetrySourceId(overlay),
    envRequired: hasOverlay(overlay),
    preselectedEnv,
    defaultEnv: null,
    githubSource: null,
    preparedReviewUrl: null,
  });
}
