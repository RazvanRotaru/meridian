/**
 * The `window.__MERIDIAN__` contract injected into the served `index.html`.
 *
 * `defaultEnv` is always null and `envRequired` mirrors `hasOverlay`: the renderer asserts
 * the never-default-prod invariant from this very object, so the server states it explicitly
 * rather than letting the SPA infer an environment.
 */

import { hasOverlay, overlayKind } from "./overlay-source";
import type { OverlaySource } from "./overlay-source";

const HEAD_CLOSE = "</head>";

export function injectBootScript(
  html: string,
  overlay: OverlaySource,
  preselectedEnv: string | null,
  sourceRoot: string | null,
): string {
  const script = `<script>window.__MERIDIAN__=${escapeForScript(bootJson(overlay, preselectedEnv, sourceRoot))}</script>`;
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

function bootJson(overlay: OverlaySource, preselectedEnv: string | null, sourceRoot: string | null): string {
  return JSON.stringify({
    graphUrl: "/api/graph",
    metaUrl: "/api/meta",
    overlayUrl: "/api/overlay",
    sourceUrl: sourceRoot ? "/api/source" : null,
    hasOverlay: hasOverlay(overlay),
    overlayKind: overlayKind(overlay),
    envRequired: hasOverlay(overlay),
    preselectedEnv,
    defaultEnv: null,
  });
}
