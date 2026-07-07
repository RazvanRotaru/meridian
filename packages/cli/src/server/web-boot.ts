/**
 * Boot-script injection for the web flow.
 *
 * `/view?id=<id>` serves the unchanged renderer bundle with a `window.__MERIDIAN__` that
 * points at this graph's per-id endpoints and states the never-default contract explicitly
 * (no overlay in web mode, so `envRequired` and `hasOverlay` are false and `defaultEnv` null).
 * The landing page gets a separate one-line prefill so a CLI positional can pre-fill the form.
 */

const HEAD_CLOSE = "</head>";

/**
 * The PR-review seed for a graph generated from a pull-request URL: the changed files (already
 * stripped to the extraction root) plus the scope ref (`pr<n>`) the renderer keys review state on.
 */
export interface ReviewBoot {
  affectedFiles: string[];
  reviewScopeRef: string;
  /** True when GitHub capped the PR's changed-file list (PR_FILES_CAP hit); surfaced as a notice. */
  truncated?: boolean;
}

export function injectViewBoot(html: string, id: string, review?: ReviewBoot): string {
  const boot = {
    graphUrl: `/api/graph?id=${id}`,
    metaUrl: `/api/meta?id=${id}`,
    overlayUrl: "/api/overlay",
    sourceUrl: `/api/source?id=${id}`,
    hasOverlay: false,
    overlayKind: null,
    envRequired: false,
    preselectedEnv: null,
    defaultEnv: null,
    // Present for every view (empty when not a PR) so the renderer reads one stable shape.
    affectedFiles: review?.affectedFiles ?? [],
    reviewScopeRef: review?.reviewScopeRef ?? null,
    // True only when GitHub truncated the PR's changed-file list; false for every non-PR view.
    reviewTruncated: review?.truncated ?? false,
  };
  return injectScript(html, `window.__MERIDIAN__=${escapeForScript(JSON.stringify(boot))}`);
}

export function injectPrefill(html: string, source: string | undefined): string {
  if (!source) {
    return html;
  }
  return injectScript(html, `window.__MERIDIAN_PREFILL__=${escapeForScript(JSON.stringify(source))}`);
}

// Tells the landing page whether "Sign in with GitHub" is available. Only the boolean is exposed —
// the browser never needs the client id, since every GitHub call is made server-side.
export function injectAuthConfig(html: string, configured: boolean): string {
  return injectScript(html, `window.__MERIDIAN_AUTH__=${escapeForScript(JSON.stringify({ configured }))}`);
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
