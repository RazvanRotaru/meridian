/**
 * Reversible semantic zoom across any number of independently laid graph levels. Every node and
 * edge carries `data.semanticDepth` plus `semantic-layer-${depth}`. This controller reads the
 * camera once, publishes the current depth/stage on `.react-flow`, and lets CSS cross-fade whole
 * graph populations. A preview remains reversible; its owner can atomically discard the inner
 * layers when user-driven outward movement commits the parent boundary.
 *
 * Each pair of levels gets two zoom intervals: a normal reading interval, then a preview where the
 * current graph loses its labels and a synthetic frame names the node it will become. Crossing the
 * second threshold reveals the canonical next graph in place. The same bands repeat for every
 * available ancestor. Until its boundary is committed, each preview reverses immediately when the
 * user zooms back in.
 */

import { useLayoutEffect, useMemo, useRef } from "react";
import { useStore, ViewportPortal, type Node } from "@xyflow/react";
import {
  enclosingParentFrame,
  normalizedSemanticDepths,
  PARENT_FRAME_HEADER_PX,
  semanticZoomBandForZoom,
  structuralGraphBounds,
  type GraphRect,
  type SemanticLodLayer,
} from "./mapLodGeometry";

/** Parent population/frame fade. ModuleMapView starts its readable camera reset after this settles. */
export const SEMANTIC_LAYER_FADE_MS = 180;

export const MAP_LOD_CSS = `
/* The old orientation-only name is retired. Keeping its markup hidden avoids a coordinated churn
   through every node renderer while ensuring cards retain their complete reading UI at all zooms. */
.lod-place {
  display: none !important;
}

/* Every semantic population starts hidden. Per-depth rules generated from the layer metadata reveal
   exactly one complete graph, so adding another level needs no new component or CSS role. */
.react-flow.semantic-composite .semantic-layer {
  opacity: 0 !important;
  visibility: hidden !important;
  pointer-events: none !important;
  transition: opacity ${SEMANTIC_LAYER_FADE_MS}ms ease-out, visibility 0s linear ${SEMANTIC_LAYER_FADE_MS}ms;
  will-change: opacity;
}

/* Preview preserves the active graph's topology and full cards, changing only its text visibility.
   The duplicate lod-place is already permanently hidden above. */
.react-flow.semantic-composite[data-map-semantic-stage="preview"] .semantic-layer span,
.react-flow.semantic-composite[data-map-semantic-stage="preview"] .semantic-layer button {
  visibility: hidden !important;
}

.map-parent-node {
  opacity: 0;
  visibility: hidden;
  transition: opacity ${SEMANTIC_LAYER_FADE_MS}ms ease-out;
  will-change: opacity;
}
.react-flow.semantic-composite[data-map-semantic-stage="preview"] .map-parent-node {
  opacity: 1;
  visibility: visible;
}
@media (prefers-reduced-motion: reduce) {
  .map-parent-node,
  .react-flow.semantic-composite .semantic-layer {
    transition: none !important;
  }
}
`;

/** Dataset equality cannot compare a numeric custom property, so emit one tiny visibility rule per
 * mounted depth. The metadata is bounded by the graph's ancestor chain and changes only on layout. */
export function semanticLayerVisibilityCss(layerDepths: readonly number[]): string {
  return normalizedSemanticDepths(layerDepths)
    .map(
      (depth) => `
.react-flow.semantic-composite[data-map-semantic-depth="${depth}"] .semantic-layer-${depth} {
  opacity: 1 !important;
  visibility: visible !important;
  pointer-events: auto !important;
  transition: opacity ${SEMANTIC_LAYER_FADE_MS}ms ease-out, visibility 0s linear 0s;
}`,
    )
    .join("");
}

interface MapLodProps {
  /** All independently laid layers, used to size the preview frame for the currently visible one. */
  nodes: readonly Node[];
  /** Ordered ancestor metadata. Nodes and edges use the corresponding `data.semanticDepth`. */
  semanticLayers?: readonly SemanticLodLayer[];
  /** Absolute markers from the unfiltered canonical scene, when the mount applies visibility filters. */
  semanticDepths?: readonly number[];
  /** Previous root depth retained while a committed parent resets the camera to reading zoom. */
  semanticBandOriginDepth?: number;
  /** Explicit first preview threshold shared with GraphSurface's commit detection. */
  semanticFirstPreviewMax: number;
  /** False while an exit surface establishes its initial fitted reading viewport. */
  semanticLodEnabled: boolean;
}

export function MapLod({
  nodes,
  semanticLayers = [],
  semanticDepths = [],
  semanticBandOriginDepth,
  semanticFirstPreviewMax,
  semanticLodEnabled,
}: MapLodProps) {
  const zoom = useStore((state) => state.transform[2]);
  const probeRef = useRef<HTMLSpanElement | null>(null);
  const layers = useMemo(() => normalizedSemanticLayers(semanticLayers), [semanticLayers]);
  // Store metadata describes outward transitions (depths 1..N); the initially focused depth zero
  // is intentionally anchorless. Take the union with markers so both shapes remain self-describing.
  const depths = useMemo(
    () => normalizedSemanticDepths([
      ...semanticDepths,
      ...layers.map((layer) => layer.depth),
      ...nodes.map((node) => semanticDepthOf(node)).filter((depth): depth is number => depth !== undefined),
    ]),
    [layers, nodes, semanticDepths],
  );
  const band = semanticLodEnabled
    ? semanticZoomBandForZoom(zoom, depths, semanticBandOriginDepth, semanticFirstPreviewMax)
    : depths[0] === undefined
      ? null
      : { depth: depths[0], stage: "reading" as const };
  const currentNodes = useMemo(
    () => (band === null ? [] : nodes.filter((node) => semanticDepthOf(node) === band.depth)),
    [band?.depth, nodes],
  );
  const bounds = useMemo(
    () => (band === null ? null : structuralGraphBounds(nodes, currentNodes)),
    [band, currentNodes, nodes],
  );
  const nextDepth = band?.previewDepth ?? depths[depths.findIndex((depth) => depth === band?.depth) + 1];
  const nextLayer = layers.find((layer) => layer.depth === nextDepth);
  const nextAnchor = nextLayer === undefined
    ? undefined
    : nodes.find((node) => node.id === nextLayer.anchorId && semanticDepthOf(node) === nextLayer.depth);
  const parentLabel = nextLayer?.label ?? nodeLabelOf(nextAnchor) ?? nextLayer?.anchorId;
  const layerCss = useMemo(() => semanticLayerVisibilityCss(depths), [depths]);

  useLayoutEffect(() => {
    const canvas = probeRef.current?.closest<HTMLElement>(".react-flow");
    if (!canvas) {
      return;
    }
    if (band === null) {
      delete canvas.dataset.mapSemanticDepth;
      delete canvas.dataset.mapSemanticStage;
      delete canvas.dataset.mapPreviewDepth;
    } else {
      canvas.dataset.mapSemanticDepth = String(band.depth);
      canvas.dataset.mapSemanticStage = band.stage;
      if (band.previewDepth === undefined) {
        delete canvas.dataset.mapPreviewDepth;
      } else {
        canvas.dataset.mapPreviewDepth = String(band.previewDepth);
      }
    }
    // These attributes belonged to the retired name-only orientation tier. Removing them here also
    // cleans canvases preserved across a hot reload of this controller.
    delete canvas.dataset.mapTier;
    delete canvas.dataset.mapLabelMode;
  }, [band]);
  return (
    <>
      <style>{MAP_LOD_CSS}{layerCss}</style>
      <span ref={probeRef} style={{ display: "none" }} />
      {nextLayer && parentLabel && bounds ? (
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

function normalizedSemanticLayers(layers: readonly SemanticLodLayer[]): SemanticLodLayer[] {
  const byDepth = new Map<number, SemanticLodLayer>();
  for (const layer of layers) {
    if (Number.isInteger(layer.depth) && layer.depth >= 0 && !byDepth.has(layer.depth)) {
      byDepth.set(layer.depth, layer);
    }
  }
  return [...byDepth.values()].sort((a, b) => a.depth - b.depth);
}

function semanticDepthOf(node: Node): number | undefined {
  const depth = (node.data as { semanticDepth?: unknown }).semanticDepth;
  return typeof depth === "number" && Number.isInteger(depth) && depth >= 0 ? depth : undefined;
}

function nodeLabelOf(node: Node | undefined): string | undefined {
  const label = (node?.data as { label?: unknown } | undefined)?.label;
  return typeof label === "string" && label.length > 0 ? label : undefined;
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
    fontSize: 15,
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
