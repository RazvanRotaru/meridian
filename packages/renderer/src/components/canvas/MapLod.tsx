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

export type MapLodTier = "orientation" | "reading";

/** The minimal review overlay keeps its card bodies readable/actionable even when fit-to-view lands
 * below the Map's orientation threshold. The Map lenses retain their default semantic zoom. */
export function mapLodTier(zoom: number, enabled = true): MapLodTier {
  return enabled && zoom < ORIENTATION_MAX ? "orientation" : "reading";
}

const LOD_CSS = `
.react-flow[data-map-tier="orientation"] .lod-hide {
  visibility: hidden;
}
.react-flow[data-map-tier="orientation"] .lod-label {
  /* FRAME titles only (collapsed cards use the place label below): inverse-scale in the title
     bar, where there is horizontal room. !important: labels carry inline ellipsis styles. */
  transform: scale(clamp(1, calc(0.92 / var(--map-zoom, 1)), 3));
  transform-origin: left center;
  overflow: visible !important;
  text-overflow: clip !important;
  max-width: none !important;
  white-space: nowrap !important;
  z-index: 1;
}
/* The PLACE LABEL: a collapsed card's one name at orientation zoom — centered over the card,
   symmetric overflow, PLAIN text in the app's own voice (mono, the card ink, no pill chrome: the
   card fill and the canvas are near-identical darks, so a backdrop box just read as a badge inside
   a button). A text shadow keeps it legible where it crosses a wire. Display-none while reading. */
.lod-place {
  display: none;
}
.react-flow[data-map-tier="orientation"] .lod-place {
  display: block;
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%) scale(clamp(1, calc(0.92 / var(--map-zoom, 1)), 3));
  font-size: 12px;
  font-weight: 700;
  color: #E6EDF3;
  text-shadow: 0 1px 8px rgba(5, 8, 12, 0.95), 0 0 3px rgba(5, 8, 12, 0.9);
  white-space: nowrap;
  pointer-events: none;
  z-index: 2;
}
/* At orientation a collapsed card's IN-CARD content hides entirely; the place label replaces it. */
.react-flow[data-map-tier="orientation"] .lod-card-body {
  visibility: hidden;
}
.react-flow[data-map-tier="orientation"] .lod-tint,
.react-flow[data-map-tier="orientation"] .lod-tint > div {
  overflow: visible !important;
}
/* Stay in the page's design family: the card keeps its dark fill, with only a WHISPER of the
   accent (the reading tier's card, decluttered — not a differently-styled block). The kind hue
   survives distance through the RAIL, which thickens instead. !important: inline styles. */
.react-flow[data-map-tier="orientation"] .lod-tint {
  background: color-mix(in srgb, var(--lod-accent, #7A8290) 9%, #12171E) !important;
  border-color: color-mix(in srgb, var(--lod-accent, #7A8290) 40%, #232935) !important;
}
.react-flow[data-map-tier="orientation"] .lod-rail {
  width: 10px !important;
}
`;

export function MapLod({ enabled = true }: { enabled?: boolean }) {
  const zoom = useStore((state) => state.transform[2]);
  const probeRef = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    const canvas = probeRef.current?.closest<HTMLElement>(".react-flow");
    if (!canvas) {
      return;
    }
    canvas.style.setProperty("--map-zoom", String(zoom));
    const tier = mapLodTier(zoom, enabled);
    if (canvas.dataset.mapTier !== tier) {
      canvas.dataset.mapTier = tier;
    }
  }, [zoom, enabled]);
  return (
    <>
      <style>{LOD_CSS}</style>
      <span ref={probeRef} style={{ display: "none" }} />
    </>
  );
}
