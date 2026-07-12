/**
 * Reversible semantic zoom across any number of independently laid graph levels. Every node and
 * edge carries `data.semanticDepth` plus `semantic-layer-${depth}`. This controller reads the
 * camera once, publishes the current depth/stage on `.react-flow`, and lets CSS switch whole graph
 * populations. A preview remains reversible; its owner can atomically discard the inner
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
  type MapSemanticStage,
  type SemanticLodLayer,
} from "./mapLodGeometry";

/** Preview-frame and exit-surface fade. Retained parents switch atomically and reset concurrently. */
export const SEMANTIC_LAYER_FADE_MS = 180;

export const MAP_LOD_CSS = `
/* The old orientation-only name is retired. Keeping its markup hidden avoids a coordinated churn
   through every node renderer while ensuring cards retain their complete reading UI at all zooms. */
.lod-place {
  display: none !important;
}

/* Every semantic population starts hidden. Per-depth rules generated from the layer metadata reveal
   exactly one complete graph, so adding another level needs no new component or CSS role. Switching
   visibility atomically avoids allocating a filter/compositor layer for every node and edge while
   preserving each element's inline selection opacity. */
.react-flow.semantic-composite .semantic-layer {
  visibility: hidden !important;
  pointer-events: none !important;
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
  .map-parent-node {
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
  visibility: visible !important;
  pointer-events: auto !important;
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
  const depth = band?.depth;
  const stage = band?.stage;
  const previewDepth = band?.previewDepth;
  const currentNodes = useMemo(
    () => (depth === undefined ? [] : nodes.filter((node) => semanticDepthOf(node) === depth)),
    [depth, nodes],
  );
  const bounds = useMemo(
    () => (depth === undefined ? null : structuralGraphBounds(nodes, currentNodes)),
    [currentNodes, depth, nodes],
  );
  const { nextAnchor, nextLayer } = useMemo(() => {
    if (depth === undefined) {
      return { nextAnchor: undefined, nextLayer: undefined };
    }
    const resolvedNextDepth = previewDepth ?? depths[depths.indexOf(depth) + 1];
    const resolvedNextLayer = layers.find((layer) => layer.depth === resolvedNextDepth);
    const resolvedNextAnchor = resolvedNextLayer === undefined
      ? undefined
      : nodes.find(
        (node) => node.id === resolvedNextLayer.anchorId && semanticDepthOf(node) === resolvedNextLayer.depth,
      );
    return { nextAnchor: resolvedNextAnchor, nextLayer: resolvedNextLayer };
  }, [depth, depths, layers, nodes, previewDepth]);
  const parentLabel = nextLayer?.label ?? nodeLabelOf(nextAnchor) ?? nextLayer?.anchorId;
  const layerCss = useMemo(() => semanticLayerVisibilityCss(depths), [depths]);

  useLayoutEffect(() => {
    const canvas = probeRef.current?.closest<HTMLElement>(".react-flow");
    if (!canvas) {
      return;
    }
    syncMapLodDataset(canvas.dataset, depth, stage, previewDepth);
  }, [depth, previewDepth, stage]);
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

/** Publish semantic state without needlessly invalidating styles on every viewport sample. */
export function syncMapLodDataset(
  dataset: DOMStringMap,
  depth: number | undefined,
  stage: MapSemanticStage | undefined,
  previewDepth: number | undefined,
): void {
  syncDatasetValue(dataset, "mapSemanticDepth", depth === undefined ? undefined : String(depth));
  syncDatasetValue(dataset, "mapSemanticStage", stage);
  syncDatasetValue(dataset, "mapPreviewDepth", previewDepth === undefined ? undefined : String(previewDepth));
  // These attributes belonged to the retired name-only orientation tier. Removing them here also
  // cleans canvases preserved across a hot reload of this controller.
  syncDatasetValue(dataset, "mapTier", undefined);
  syncDatasetValue(dataset, "mapLabelMode", undefined);
}

function syncDatasetValue(dataset: DOMStringMap, key: string, value: string | undefined): void {
  if (value === undefined) {
    if (dataset[key] !== undefined) {
      delete dataset[key];
    }
  } else if (dataset[key] !== value) {
    dataset[key] = value;
  }
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
