/**
 * Pure adapter between the curated Minimal Graph overlay and GraphSurface's semantic-zoom contract.
 *
 * A minimal graph is not the canonical contents of one real node: it may contain any number of
 * selected members plus satellites. Its one meaningful parent is therefore the source graph it
 * temporarily covers. We model that return as a metadata-only depth-1 layer with an opaque synthetic
 * anchor. Crossing its outward threshold lets the shared controller fade and close the overlay;
 * no depth-1 node is retained here because the source surface is already mounted underneath.
 */

import type { Edge, Node } from "@xyflow/react";
import type { ViewMode } from "../../derive/edgeSelection";
import type { ServiceGroupingLabelMode, ServiceGroupingMode } from "../../derive/serviceClusteringModes";
import {
  SEMANTIC_CONTEXT_CLASS,
  SEMANTIC_CONTEXT_EDGE_CLASS,
  SEMANTIC_DETAIL_CLASS,
  SEMANTIC_DETAIL_EDGE_CLASS,
  SEMANTIC_LAYER_CLASS,
  SEMANTIC_PARENT_CLASS,
  semanticLayerClass,
} from "../../derive/moduleSemanticComposite";
import type { GraphIndex } from "../../graph/graphIndex";
import type { ServiceScope } from "../../state/serviceScope";
import { moduleSurfaceSpec } from "./surfaceSpec";
import type { SemanticLodLayer } from "./mapLodGeometry";

/** A PR review is the navigation root of its overlay. Removing the metadata-only source parent
 * disables both its preview band and its outward commit without changing ordinary extractions. */
export function minimalSemanticLayersAtReviewBoundary<T extends readonly SemanticLodLayer[]>(
  layers: T,
  reviewActive: boolean,
): T | readonly [] {
  return reviewActive ? [] : layers;
}

export const MINIMAL_SOURCE_GRAPH_ANCHOR_ID = "semantic:minimal:source-graph";

export interface MinimalSourceGraphState {
  index: GraphIndex;
  viewMode: ViewMode;
  /** Raw source-graph focus. This is descriptive metadata; committing the layer closes the overlay. */
  moduleFocus: string | null;
  /** The actually laid source focus, used for the same breadcrumb label the covered surface showed. */
  moduleEffectiveFocus: string | null;
  serviceScope: ServiceScope | null;
  serviceGroupingMode?: ServiceGroupingMode;
  serviceGroupingTargetSize?: number;
  serviceGroupingLabelMode?: ServiceGroupingLabelMode;
}

export interface FlatMinimalGraph {
  nodes: readonly Node[];
  edges: readonly Edge[];
}

/** Scene data MinimalGraphView passes directly to the shared controller and GraphSurface. */
export interface MinimalSemanticSourceAdapter {
  nodes: Node[];
  edges: Edge[];
  semanticLayers: readonly [SemanticLodLayer];
  semanticDepths: readonly [0, 1];
}

/**
 * Stamp the whole minimal graph as semantic depth zero. Existing semantic markers are replaced, not
 * accumulated, so adapting an already-stamped graph cannot leave one node visible in two CSS layers.
 * All unrelated data/classes and graph identities remain intact.
 */
export function stampMinimalGraphAsSemanticDetail(graph: FlatMinimalGraph): { nodes: Node[]; edges: Edge[] } {
  return {
    nodes: graph.nodes.map((node) => ({
      ...node,
      className: semanticDetailClasses(node.className, false),
      data: {
        ...node.data,
        semanticDepth: 0,
        semanticRole: "detail",
        semanticAnchorId: null,
      },
    })),
    edges: graph.edges.map((edge) => ({
      ...edge,
      className: semanticDetailClasses(edge.className, true),
      data: {
        ...(edge.data ?? {}),
        semanticDepth: 0,
        semanticRole: "detail",
        semanticAnchorId: null,
      },
    })),
  };
}

/**
 * Name the graph the overlay will return to. The laid breadcrumb is authoritative; an unzoomed
 * scoped Service graph uses its scope trail; otherwise use the surface's own root name. Unsupported
 * modes cannot normally own the overlay, but "Graph" is a stable defensive fallback for restored or
 * partially migrated state.
 */
export function minimalSourceGraphLabel(source: MinimalSourceGraphState): string {
  const spec = moduleSurfaceSpec(source.viewMode);
  if (spec !== null) {
    const crumbs = spec.navigation.crumbs(
      source.moduleEffectiveFocus,
      source.index,
      source.serviceGroupingMode,
      source.serviceGroupingTargetSize,
      source.serviceGroupingLabelMode,
    );
    for (let index = crumbs.length - 1; index >= 0; index -= 1) {
      const label = nonBlank(crumbs[index]?.label);
      if (label !== null) {
        return label;
      }
    }
  }
  // Scope is meaningful only on the Service surface. Ignoring a stale scope in a defensively
  // restored Map/UI state keeps those surfaces labelled by their own roots.
  const scopeLabel = source.viewMode === "call" ? nonBlank(source.serviceScope?.label) : null;
  if (scopeLabel !== null) {
    return scopeLabel;
  }
  return nonBlank(spec?.navigation.rootLabel) ?? "Graph";
}

/** A metadata-only, one-step parent. Its opaque anchor deliberately need not exist in either graph. */
export function minimalSourceSemanticLayer(source: MinimalSourceGraphState): SemanticLodLayer {
  return {
    depth: 1,
    focus: source.moduleFocus,
    anchorId: MINIMAL_SOURCE_GRAPH_ANCHOR_ID,
    label: minimalSourceGraphLabel(source),
  };
}

/** Adapt any flat, including multi-origin, minimal graph to the shared preview/commit contract. */
export function adaptMinimalGraphToSemanticSource(
  graph: FlatMinimalGraph,
  source: MinimalSourceGraphState,
): MinimalSemanticSourceAdapter {
  const detail = stampMinimalGraphAsSemanticDetail(graph);
  return {
    ...detail,
    semanticLayers: [minimalSourceSemanticLayer(source)],
    semanticDepths: [0, 1],
  };
}

const SEMANTIC_ROLE_CLASSES = new Set([
  SEMANTIC_LAYER_CLASS,
  SEMANTIC_PARENT_CLASS,
  SEMANTIC_DETAIL_CLASS,
  SEMANTIC_CONTEXT_CLASS,
  SEMANTIC_DETAIL_EDGE_CLASS,
  SEMANTIC_CONTEXT_EDGE_CLASS,
]);

function semanticDetailClasses(className: string | undefined, edge: boolean): string {
  const kept = (className ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .filter((token) => !SEMANTIC_ROLE_CLASSES.has(token) && !/^semantic-layer-\d+$/.test(token));
  kept.push(SEMANTIC_LAYER_CLASS, semanticLayerClass(0), edge ? SEMANTIC_DETAIL_EDGE_CLASS : SEMANTIC_DETAIL_CLASS);
  return kept.join(" ");
}

function nonBlank(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}
