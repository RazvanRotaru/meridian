/**
 * Semantic zoom for the module surfaces. Below ORIENTATION_MAX, the default strategy keeps the
 * existing map-like place labels: one inverse-scaled name per card. The Map lens can instead pass a
 * `parentLabel`; in that POC mode every node name disappears and a translucent parent node fades in
 * around the structural graph. Its titled frame makes the remaining unlabeled shapes and wires read
 * as the contents of ONE place, rather than as a field of equally loud peers.
 *
 * Zero per-card React subscriptions, by design: this controller alone reads zoom, mirrors it into a
 * CSS variable + data attributes on `.react-flow`, and lets one stylesheet switch the node chrome.
 * The parent frame rides in a ViewportPortal so it pans with the graph while its border/header chrome
 * inverse-scales to a stable screen size.
 */

import { useEffect, useMemo, useRef } from "react";
import { useStore, ViewportPortal, type Node } from "@xyflow/react";
import { enclosingParentFrame, PARENT_FRAME_HEADER_PX, structuralGraphBounds, type GraphRect } from "./mapLodGeometry";

/** Below this zoom the reader is ORIENTING (shapes + names), not reading card details. */
const ORIENTATION_MAX = 0.45;

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
/* The Map-only parent-node experiment. Broad node descendants are intentional: unit/block/step
   nodes predate the lod-* tags, and letting their text leak would break the ONE-label contract. The
   boxes, borders, rails, handles and wires remain, preserving the graph's overall topology. */
.react-flow[data-map-tier="orientation"][data-map-label-mode="parent"] .react-flow__node span,
.react-flow[data-map-tier="orientation"][data-map-label-mode="parent"] .react-flow__node button {
  visibility: hidden !important;
}
/* Keep the synthetic parent mounted at both tiers so crossing the semantic boundary can genuinely
   cross-fade it, rather than popping a newly-mounted element into existence. */
.map-parent-node {
  opacity: 0;
  transition: opacity 180ms ease-out;
  will-change: opacity;
}
.react-flow[data-map-tier="orientation"][data-map-label-mode="parent"] .map-parent-node {
  opacity: 1;
}
@media (prefers-reduced-motion: reduce) {
  .map-parent-node {
    transition: none;
  }
}
`;

interface MapLodProps {
  /** Laid-out nodes used only to size the synthetic parent around the structural graph. */
  nodes: readonly Node[];
  /** Present only for surfaces that opt into ONE enclosing parent node at orientation zoom. */
  parentLabel?: string;
}

export function MapLod({ nodes, parentLabel }: MapLodProps) {
  const zoom = useStore((state) => state.transform[2]);
  const probeRef = useRef<HTMLSpanElement | null>(null);
  const bounds = useMemo(() => structuralGraphBounds(nodes), [nodes]);
  const parentNodeMode = parentLabel !== undefined;
  useEffect(() => {
    const canvas = probeRef.current?.closest<HTMLElement>(".react-flow");
    if (!canvas) {
      return;
    }
    canvas.style.setProperty("--map-zoom", String(zoom));
    canvas.dataset.mapLabelMode = parentNodeMode ? "parent" : "places";
    const tier = zoom < ORIENTATION_MAX ? "orientation" : "reading";
    if (canvas.dataset.mapTier !== tier) {
      canvas.dataset.mapTier = tier;
    }
  }, [parentNodeMode, zoom]);
  return (
    <>
      <style>{LOD_CSS}</style>
      <span ref={probeRef} style={{ display: "none" }} />
      {parentNodeMode && parentLabel && bounds ? (
        <ViewportPortal>
          <div className="map-parent-node" data-map-parent-node style={parentNodeStyle(enclosingParentFrame(bounds, zoom), zoom)} aria-hidden>
            <div style={parentNodeHeaderStyle(zoom)}>
              <span style={parentNodeMarkerStyle(zoom)} />
              <span data-map-parent-label style={PARENT_LABEL_STYLE}>
                {parentLabel}
              </span>
            </div>
          </div>
        </ViewportPortal>
      ) : null}
    </>
  );
}

/** The portal supplies pan/zoom. Geometry stays in flow space; dividing chrome dimensions by zoom
 * keeps the enclosing node's border, radius and title bar at a stable on-screen weight. */
function parentNodeStyle(frame: GraphRect, zoom: number): React.CSSProperties {
  return {
    position: "absolute",
    left: 0,
    top: 0,
    width: frame.width,
    height: frame.height,
    transform: `translate(${frame.x}px, ${frame.y}px)`,
    transformOrigin: "0 0",
    zIndex: -1,
    boxSizing: "border-box",
    border: `${1.25 / zoom}px solid rgba(91, 155, 227, 0.56)`,
    borderRadius: 11 / zoom,
    background: "rgba(91, 155, 227, 0.045)",
    boxShadow: `0 0 0 ${1 / zoom}px rgba(91, 155, 227, 0.08) inset, 0 ${5 / zoom}px ${18 / zoom}px rgba(0, 0, 0, 0.2)`,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    pointerEvents: "none",
    overflow: "hidden",
  };
}

function parentNodeHeaderStyle(zoom: number): React.CSSProperties {
  return {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    height: PARENT_FRAME_HEADER_PX / zoom,
    display: "flex",
    alignItems: "center",
    gap: 8 / zoom,
    boxSizing: "border-box",
    padding: `0 ${12 / zoom}px`,
    borderBottom: `${1 / zoom}px solid rgba(91, 155, 227, 0.28)`,
    background: "rgba(18, 23, 30, 0.72)",
    color: "#E6EDF3",
    fontSize: 15 / zoom,
    fontWeight: 750,
    lineHeight: 1.2,
  };
}

function parentNodeMarkerStyle(zoom: number): React.CSSProperties {
  return {
    width: 6 / zoom,
    height: 6 / zoom,
    flexShrink: 0,
    borderRadius: 2 / zoom,
    background: "#5B9BE3",
    boxShadow: `0 0 ${5 / zoom}px rgba(91, 155, 227, 0.55)`,
  };
}

const PARENT_LABEL_STYLE: React.CSSProperties = {
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
