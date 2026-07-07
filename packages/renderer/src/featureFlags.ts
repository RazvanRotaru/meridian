/**
 * Build-time feature flags for the renderer. Each flag is inlined by Vite from a `VITE_*` env var,
 * so toggling one is a rebuild — not a runtime setting. Keep the surface tiny: a flag lives here only
 * while a feature is being withheld from the default build.
 */

/**
 * The Service-composition lens ("call" viewMode) is hidden by default: the app opens on the Module
 * map and the Service-composition segment is dropped from the view toggle. Re-enable an individual
 * build with `VITE_SHOW_SERVICE_COMPOSITION=true`.
 */
export const SHOW_SERVICE_COMPOSITION = import.meta.env.VITE_SHOW_SERVICE_COMPOSITION === "true";
