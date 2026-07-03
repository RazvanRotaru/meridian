/**
 * Boot-script injection for the web flow.
 *
 * `/view?id=<id>` serves the unchanged renderer bundle with a `window.__MERIDIAN__` that
 * points at this graph's per-id endpoints and states the never-default contract explicitly
 * (no overlay in web mode, so `envRequired` and `hasOverlay` are false and `defaultEnv` null).
 * The landing page gets a separate one-line prefill so a CLI positional can pre-fill the form.
 */

const HEAD_CLOSE = "</head>";

export function injectViewBoot(html: string, id: string): string {
  const boot = {
    graphUrl: `/api/graph?id=${id}`,
    metaUrl: `/api/meta?id=${id}`,
    overlayUrl: "/api/overlay",
    hasOverlay: false,
    overlayKind: null,
    envRequired: false,
    preselectedEnv: null,
    defaultEnv: null,
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
