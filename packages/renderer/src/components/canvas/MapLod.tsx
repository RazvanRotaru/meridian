/**
 * Semantic zoom for the Map — the ORIENTATION tier. Below ORIENTATION_MAX zoom, a level's cards are
 * sub-pixel text on full card chrome: everything is drawn, nothing is legible (measured: a 12.5px
 * label renders at ~3.8px at the 38-card fit zoom). This controller flips the canvas into map-label
 * mode: card chrome (chips, badges, counts) hides, each card becomes an accent-tinted block, and
 * ONE name per card inverse-scales toward a legible on-screen size — like place labels on a map.
 *
 * Zero per-card React work, by design: this single component subscribes to the zoom, mirrors it
 * into a `--map-zoom` CSS variable (every tick) and a `data-map-tier` attribute (only at the tier
 * boundary) on the `.react-flow` container; the tier's entire effect is the stylesheet below acting
 * on `lod-label` / `lod-hide` / `lod-tint` class tags the card components carry. Cards never
 * subscribe, never re-render — CSS does the level-of-detail.
 */

import { useEffect, useRef } from "react";
import { useStore } from "@xyflow/react";

/** Below this zoom the reader is ORIENTING (shapes + names), not reading card details. */
const ORIENTATION_MAX = 0.45;

const LOD_CSS = `
.react-flow[data-map-tier="orientation"] .lod-hide {
  visibility: hidden;
}
.react-flow[data-map-tier="orientation"] .lod-label {
  /* !important throughout: labels carry inline ellipsis styles that must lose in this mode. */
  transform: scale(clamp(1, calc(0.92 / var(--map-zoom, 1)), 4));
  transform-origin: left center;
  overflow: visible !important;
  text-overflow: clip !important;
  max-width: none !important;
  white-space: nowrap !important;
  z-index: 1;
}
.react-flow[data-map-tier="orientation"] .lod-tint,
.react-flow[data-map-tier="orientation"] .lod-tint > div {
  overflow: visible !important;
}
.react-flow[data-map-tier="orientation"] .lod-tint {
  /* !important: card backgrounds are INLINE styles; the orientation tier is a mode that must win. */
  background: color-mix(in srgb, var(--lod-accent, #7A8290) 26%, #10151C) !important;
  border-color: color-mix(in srgb, var(--lod-accent, #7A8290) 60%, #10151C) !important;
}
`;

export function MapLod() {
  const zoom = useStore((state) => state.transform[2]);
  const probeRef = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    const canvas = probeRef.current?.closest<HTMLElement>(".react-flow");
    if (!canvas) {
      return;
    }
    canvas.style.setProperty("--map-zoom", String(zoom));
    const tier = zoom < ORIENTATION_MAX ? "orientation" : "reading";
    if (canvas.dataset.mapTier !== tier) {
      canvas.dataset.mapTier = tier;
    }
  }, [zoom]);
  return (
    <>
      <style>{LOD_CSS}</style>
      <span ref={probeRef} style={{ display: "none" }} />
    </>
  );
}
