/**
 * WIRE INTERACTION for the shared canvas — hover naming, the pinned Wire INSPECTOR, and the
 * z-order/visibility dressing every drawn wire wears:
 *
 *   - HOVER: pointing at one strand names it (kind × weight, source → target) and lights it alone —
 *     the disambiguator for strands sharing a bus/trunk. A cheap overlay pass: hover never
 *     recomputes bundling/routing geometry, it only boosts one edge's paint. Bundle highways keep
 *     their own breakdown tooltip, so they opt out; a fused CYCLE names both directions at once and
 *     a RIBBON names its whole cable (the per-kind breakdown IS the tooltip text).
 *   - INSPECTOR: clicking a strand PINS its evidence panel (`WireInspector` — the aggregate's real
 *     links + call sites). The pinned wire stays force-lit like a hover; explicit close / focused
 *     Esc unpin, as does any change that removes the wire. The input `edges` are re-derived
 *     by pure passes over every such change. Preserve an inspected strand by stable id while it is
 *     still drawn; clear only when that subject truly disappears so ordinary graph interaction can
 *     coexist with the sticky floating inspector without leaving stale attribution behind.
 *   - WIRES GO BEHIND CARDS AT REST (every surface): React Flow's default z-mode elevates any edge touching
 *     a NESTED node above every top-level card (basic mode ADDS the child node's z to the edge's
 *     own) — a lit fan into a frame member covered unrelated cards' text. The canvas runs
 *     zIndexMode="manual" (GraphSurface) and this hook sets the resting rule the eye expects: a wire
 *     CROSSING the canvas travels under everything (z 0); a wire living INSIDE one frame sits at
 *     its nesting depth — above its frame's translucent background, below that frame's own cards.
 *     A selected node's represented semantic wires then move to the foreground rail, making that
 *     explicit inspection choice readable through the dense graph until selection changes. Their
 *     oversized transparent hover corridor is removed while raised so crossings do not steal card
 *     interactions; the visible stroke itself remains inspectable.
 *   - HIDDEN wires (an unlit commons strand, opacity 0) render NOTHING — no path, no marker, no hit
 *     area (opacity 0 alone still hit-tests the stroke, so hovering the exact line would flash it
 *     back). They return only when the emphasis pass lights them.
 *
 * A surface may still pass `enabled: false` to receive only z-order dressing, without hover,
 * inspection, evidence, labels, or retyping.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Edge, Node } from "@xyflow/react";
import { BUNDLE_EDGE_TYPE, selectionTouches } from "../../layout/edgeBundling";
import { pairOf, RIBBON_EDGE_TYPE, type RibbonEdgeData } from "../../layout/parallelWires";
import { CYCLE_EDGE_TYPE, type CycleEdgeData } from "../../layout/cycleFusion";
import { WIRE_EDGE_TYPE } from "../edges/WireEdge";
import type { WireHover } from "../WireTooltip";
import { isGhostHierarchyEdge, isInteractiveSemanticEdge } from "./presentationEdges";
import { relationKindOf } from "../../graph/relationEdge";
import { wireReferencesAnyArtifactEdge } from "../../graph/edgeEvidence";
import { primaryModifierPressed } from "./usePrimaryModifierKey";

const EMPTY_SPOTLIGHT_EDGE_IDS: ReadonlySet<string> = new Set<string>();
const EMPTY_SELECTED_NODE_IDS: ReadonlySet<string> = new Set<string>();
/** Selection-only z above React Flow's card layer, so the chosen node's wires remain traceable. */
export const SELECTED_NODE_EDGE_Z = 1_000;
/** Interaction-only z above React Flow's card layer; released as soon as the socket lens closes. */
export const INCOMING_CALL_SPOTLIGHT_Z = 1_000;
export const MODIFIER_GATED_EDGE_CLASS = "modifier-gated-edge";
export const MODIFIER_GATED_EDGE_CSS = `.${MODIFIER_GATED_EDGE_CLASS} { pointer-events: none; }`;

export interface WireModifierClickGate {
  /** Require Control/Command for graph-originated edge inspection. Inspector drill actions bypass it. */
  required: boolean;
  /** Live key state also removes the edge's hit target so ordinary review clicks pass through. */
  pressed: boolean;
}

export interface WireInteractionApi {
  /** The input edges, z-ordered always; hover/inspector-boosted (and hit-widened) when enabled. */
  edges: Edge[];
  hover: WireHover | null;
  /** The pinned wire's WHOLE ordered pair (a ribbon's members, or a strand + its same-pair
   * siblings) for the inspector — no strand can hide another. Null == no panel pinned. */
  inspectedPair: Edge[] | null;
  /** The drawn label for an on-canvas node id (tooltip + inspector name cards as the reader sees them). */
  labelOf: (id: string) => string | undefined;
  /** Pin a wire's evidence panel (the edge-click gesture; the inspector's drill rows reuse it). */
  inspect: (edge: Edge) => void;
  /** Unpin the inspector (pane clicks compose this with the surface's own pane handler). */
  clearInspected: () => void;
  onEdgeMouseEnter?: (event: React.MouseEvent, edge: Edge) => void;
  onEdgeMouseLeave?: () => void;
  onEdgeClick?: (event: React.MouseEvent, edge: Edge) => void;
}

export function useWireHover(
  edges: Edge[],
  nodes: Node[],
  enabled: boolean,
  /** The caller owns transition admission. Calling `commit` pins the pair; retaining it lets a
   * dirty-composer guard replay the exact same local + source transition after Discard. */
  onInspectPair?: (pair: Edge[], subject: Edge, commit: (resolvedSubject?: Edge) => void) => void,
  /** The caller owns the complete local + source dismissal transition. It must invoke the supplied
   * local clear only when dismissal is admitted (immediately or after a dirty-draft Discard). */
  onInspectionEnd?: (clearLocalInspection: () => void) => void,
  /** Literal selected node ids whose represented semantic wires should paint above the cards. */
  selectedNodeIds: ReadonlySet<string> = EMPTY_SELECTED_NODE_IDS,
  /** Exact artifact call edges temporarily raised by a directional node-socket lens. */
  spotlightEdgeIds: ReadonlySet<string> = EMPTY_SPOTLIGHT_EDGE_IDS,
  modifierClick?: WireModifierClickGate,
): WireInteractionApi {
  const [hover, setHover] = useState<WireHover | null>(null);
  const [inspected, setInspected] = useState<Edge | null>(null);
  const inspectedRef = useRef<Edge | null>(null);
  const mountedRef = useRef(true);
  const onInspectionEndRef = useRef(onInspectionEnd);
  onInspectionEndRef.current = onInspectionEnd;
  const clearInspected = useCallback(() => {
    if (inspectedRef.current === null) return;
    const clearLocalInspection = () => {
      inspectedRef.current = null;
      if (mountedRef.current) setInspected(null);
    };
    // The source lifecycle owns dismissal permission and the replay callback. Giving it the local
    // clear keeps automatic edge disappearance atomic with global evidence dismissal after Discard.
    const endInspection = onInspectionEndRef.current;
    if (endInspection) {
      endInspection(clearLocalInspection);
    } else {
      clearLocalInspection();
    }
  }, []);
  // Painted edges are routinely recreated by selection and layout passes. Retain the current
  // subject by stable id and refresh its object; close only if the strand actually disappeared.
  useEffect(() => {
    const current = inspectedRef.current;
    if (current === null) return;
    const next = retainedInspectedEdge(current, edges);
    if (next === null) {
      clearInspected();
    } else if (next !== current) {
      inspectedRef.current = next;
      setInspected(next);
    }
  }, [edges, clearInspected]);
  // A retained graph can stay mounted behind another surface. Disabling inspection must release
  // both its local pin and the edge-only source state it owns.
  useEffect(() => {
    if (!enabled) clearInspected();
  }, [enabled, clearInspected]);
  useEffect(() => {
    if (modifierClick?.required === true && !modifierClick.pressed) setHover(null);
  }, [modifierClick?.pressed, modifierClick?.required]);
  // Unmount cannot set hook state, but it still owes the shared edge-evidence lifecycle its end.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (inspectedRef.current !== null) {
        const clearLocalInspection = () => {
          inspectedRef.current = null;
        };
        const endInspection = onInspectionEndRef.current;
        if (endInspection) {
          endInspection(clearLocalInspection);
        } else {
          clearLocalInspection();
        }
      }
    };
  }, []);

  // Endpoint labels come from the painted nodes so panels name cards as the reader sees them.
  const labelById = useMemo(() => {
    const labels = new Map<string, string>();
    for (const node of nodes) {
      labels.set(node.id, ((node.data as { label?: string }).label ?? node.id.split("/").pop()) as string);
    }
    return labels;
  }, [nodes]);

  const inspectedPair = useMemo(
    () => (inspected === null || isGhostHierarchyEdge(inspected) ? null : pairOf(inspected, edges.filter(isInteractiveSemanticEdge))),
    [inspected, edges],
  );
  const interactiveEdges = useMemo(() => edges.filter(isInteractiveSemanticEdge), [edges]);
  const inspect = useCallback((edge: Edge) => {
    if (!isInteractiveSemanticEdge(edge)) return;
    const commit = (resolvedSubject = edge) => {
      inspectedRef.current = resolvedSubject;
      setInspected(resolvedSubject);
    };
    if (onInspectPair) {
      onInspectPair(pairOf(edge, interactiveEdges), edge, commit);
    } else {
      commit();
    }
  }, [interactiveEdges, onInspectPair]);
  const inspectedIds = useMemo(
    () => new Set(inspectedPair === null || inspected === null ? [] : [inspected.id, ...inspectedPair.map((edge) => edge.id)]),
    [inspected, inspectedPair],
  );

  // Each node's top-level ancestor + nesting depth, for the manual wire z-order (see the header).
  const nestingById = useMemo(() => nestingOf(nodes), [nodes]);

  const baseDressedEdges = useMemo(() => {
    return edges.map((edge) => {
      // GraphSurface normally partitions these before the hook. Keep this guard so another caller
      // cannot accidentally add semantic chrome or interaction state to a disclosure spoke.
      if (isGhostHierarchyEdge(edge)) {
        return edge;
      }
      const zIndex = wireZ(edge, nestingById);
      if (!enabled) {
        return { ...edge, zIndex };
      }
      if (edge.type === BUNDLE_EDGE_TYPE) {
        // A drilled constituent lives INSIDE the highway — boost the owning bundle so the panel's
        // subject still has a visual anchor on canvas.
        const holdsInspected =
          inspectedIds.size > 0 && (edge.data as { constituents?: Edge[] }).constituents?.some((member) => inspectedIds.has(member.id)) === true;
        return holdsInspected
          ? {
              ...edge,
              zIndex,
              style: { ...edge.style, opacity: 1 },
            }
          : { ...edge, zIndex };
      }
      const boosted = edge.id === hover?.id || inspectedIds.has(edge.id);
      if (edge.type === RIBBON_EDGE_TYPE) {
        // The cable boosts as a WHOLE (every stripe lights); its stripes carry their own paint.
        // A fully invisible cable (all stripes opacity 0 — a commons pair at rest) renders NOTHING
        // (data.hidden → RibbonEdge returns null): an opacity-0 SVG path still hit-tests, so a
        // pixel-precise hover would resurrect a wire only a SELECTION may light.
        const anyVisible =
          boosted || ((edge.data as RibbonEdgeData).members ?? []).some((member) => (member.style as { opacity?: number } | undefined)?.opacity !== 0);
        return {
          ...edge,
          zIndex,
          interactionWidth: anyVisible ? 16 : 0,
          data: { ...edge.data, pulse: true, boosted, hidden: !anyVisible },
        };
      }
      // An INVISIBLE wire (an unlit commons strand, opacity 0) renders NOTHING (see the header).
      const invisible = (edge.style as { opacity?: number } | undefined)?.opacity === 0 && !boosted;
      return {
        ...edge,
        zIndex,
        // Untyped edges retype to the canvas's own plain curve AFTER the highway passes have
        // claimed theirs — same geometry as the default edge, plus the lit wire's static label.
        // `pulse` remains the surface opt-in for that label; the name is retained to keep the
        // shared edge-data contract stable.
        type: edge.type ?? WIRE_EDGE_TYPE,
        interactionWidth: invisible ? 0 : 14,
        data: { ...edge.data, pulse: true, hidden: invisible },
        style: boosted
          ? {
              ...edge.style,
              opacity: 1,
              strokeWidth: ((edge.style?.strokeWidth as number) ?? 1.5) + 1.2,
            }
          : edge.style,
      };
    });
  }, [edges, hover?.id, inspectedIds, nestingById, enabled]);
  const clickGatedEdges = useMemo(
    () => gateWireClickInteraction(
      baseDressedEdges,
      modifierClick?.required === true && !modifierClick.pressed,
    ),
    [baseDressedEdges, modifierClick?.pressed, modifierClick?.required],
  );
  const selectedNodeEdges = useMemo(
    () => raiseSelectedNodeEdges(clickGatedEdges, selectedNodeIds),
    [clickGatedEdges, selectedNodeIds],
  );
  const dressedEdges = useMemo(
    () => applyIncomingCallSpotlight(selectedNodeEdges, spotlightEdgeIds),
    [selectedNodeEdges, spotlightEdgeIds],
  );

  const labelOf = (id: string) => labelById.get(id);
  if (!enabled) {
    // A disabled surface normally has no inspector. If dismissal was vetoed by a dirty composer,
    // keep returning its pair so the dock and inline confirmation remain reachable until resolved.
    return { edges: dressedEdges, hover: null, inspectedPair, labelOf, inspect: () => {}, clearInspected };
  }

  const onEdgeMouseEnter = (event: React.MouseEvent, edge: Edge) => {
    if (!isInteractiveSemanticEdge(edge) || edge.type === BUNDLE_EDGE_TYPE) {
      setHover(null);
      return;
    }
    setHover({
      id: edge.id,
      x: event.clientX,
      y: event.clientY,
      ...hoverText(edge),
      source: labelById.get(edge.source) ?? edge.source,
      target: labelById.get(edge.target) ?? edge.target,
    });
  };
  return {
    edges: dressedEdges,
    hover,
    inspectedPair,
    labelOf,
    inspect,
    clearInspected,
    onEdgeMouseEnter,
    onEdgeMouseLeave: () => setHover(null),
    onEdgeClick: (event, edge) => {
      if (modifierClick?.required === true && !primaryModifierPressed(event)) return;
      inspect(edge);
    },
  };
}

/** Remove every edge hit target until the review's primary modifier is held. */
export function gateWireClickInteraction(edges: Edge[], blocked: boolean): Edge[] {
  if (!blocked) return edges;
  return edges.map((edge) => {
    const classNames = new Set((edge.className ?? "").split(/\s+/).filter(Boolean));
    classNames.add(MODIFIER_GATED_EDGE_CLASS);
    return {
      ...edge,
      className: [...classNames].join(" "),
      interactionWidth: 0,
    };
  });
}

/** Resolve a freshly-painted object for the same pinned strand, or null once it is truly gone. */
export function retainedInspectedEdge(current: Edge | null, edges: readonly Edge[]): Edge | null {
  if (current === null) return null;
  for (const edge of edges) {
    if (edge.id === current.id) return edge;
    if (edge.type !== BUNDLE_EDGE_TYPE) continue;
    const member = (edge.data as { constituents?: Edge[] } | undefined)?.constituents
      ?.find((candidate) => candidate.id === current.id);
    if (member) return member;
  }
  return null;
}

/** Admit local unpin and global evidence dismissal as one replayable transition. */
export function requestWireInspectionEnd(
  requestTransition: (transition: () => void) => boolean,
  clearLocalInspection: () => void,
  closeGlobalEvidence: () => void,
): void {
  const transition = () => {
    clearLocalInspection();
    closeGlobalEvidence();
  };
  if (requestTransition(transition)) transition();
}

/**
 * Put every semantic wire represented by the literal selection on the foreground edge rail.
 * Presentation aggregates retain their selected child identity through `selectionTouches`; ghost
 * hierarchy spokes stay on their structural rail. Preserve any deliberately higher local layer,
 * but remove the wide transparent interaction stroke while foregrounded so crossings do not cover
 * unrelated cards.
 */
export function raiseSelectedNodeEdges(
  edges: Edge[],
  selectedNodeIds: ReadonlySet<string>,
): Edge[] {
  if (selectedNodeIds.size === 0) return edges;
  let changed = false;
  const raised = edges.map((edge) => {
    if (isGhostHierarchyEdge(edge) || !selectionTouches(edge, selectedNodeIds)) {
      return edge;
    }
    const zIndex = Math.max(edge.zIndex ?? 0, SELECTED_NODE_EDGE_Z);
    if (zIndex === edge.zIndex && edge.interactionWidth === 0) return edge;
    changed = true;
    return { ...edge, zIndex, interactionWidth: 0 };
  });
  return changed ? raised : edges;
}

/**
 * Raise only presentation wires that retain one of the lens's exact artifact call edges. When the
 * lens is closed (or no wire matches), return the input array and objects verbatim so unrelated
 * interaction state does not churn.
 */
export function applyIncomingCallSpotlight(
  edges: Edge[],
  spotlightEdgeIds: ReadonlySet<string>,
): Edge[] {
  if (spotlightEdgeIds.size === 0) return edges;
  let changed = false;
  const spotlighted = edges.map((edge) => {
    if (isGhostHierarchyEdge(edge) || !wireReferencesAnyArtifactEdge(edge, spotlightEdgeIds)) {
      return edge;
    }
    changed = true;
    if (edge.type === RIBBON_EDGE_TYPE) {
      return {
        ...edge,
        zIndex: INCOMING_CALL_SPOTLIGHT_Z,
        interactionWidth: 0,
        style: incomingCallSpotlightStyle(edge.style),
        data: {
          ...edge.data,
          pulse: true,
          boosted: true,
          hidden: false,
          callLensSpotlight: true,
        },
      };
    }
    return {
      ...edge,
      zIndex: INCOMING_CALL_SPOTLIGHT_Z,
      interactionWidth: 0,
      style: incomingCallSpotlightStyle(edge.style),
      data: { ...edge.data, hidden: false, callLensSpotlight: true },
    };
  });
  return changed ? spotlighted : edges;
}

function incomingCallSpotlightStyle(style: Edge["style"]): Edge["style"] {
  return {
    ...style,
    opacity: 1,
    strokeWidth: ((style?.strokeWidth as number) ?? 1.5) + 1.2,
    filter: "drop-shadow(0 0 3px rgba(140, 157, 255, 0.72))",
    pointerEvents: "none",
  };
}

/** The tooltip's kind line: a fused cycle names both directions at once; a ribbon breaks its whole
 * cable down per kind; a plain strand is its kind × weight. */
function hoverText(edge: Edge): { kind: string; weight: number } {
  if (edge.type === CYCLE_EDGE_TYPE) {
    const cycle = edge.data as CycleEdgeData;
    return { kind: `⇄ ${cycle.relationKind ?? cycle.depKind ?? "wire"} ×${cycle.forwardWeight}/×${cycle.backwardWeight}`, weight: 1 };
  }
  if (edge.type === RIBBON_EDGE_TYPE) {
    const members = (edge.data as RibbonEdgeData).members ?? [];
    const breakdown = [...members]
      .sort((a, b) => ((b.data as { weight?: number })?.weight ?? 1) - ((a.data as { weight?: number })?.weight ?? 1))
      .map((member) => {
        const data = member.data as { weight?: number } | undefined;
        const weight = data?.weight ?? 1;
        return `${relationKindOf(member.data) ?? "wire"}${weight > 1 ? ` ×${weight}` : ""}`;
      })
      .join(" · ");
    return { kind: breakdown, weight: 1 };
  }
  const data = edge.data as { weight?: number } | undefined;
  return { kind: relationKindOf(edge.data) ?? "wire", weight: data?.weight ?? 1 };
}

/** Each node's top-level ancestor + nesting depth (cycle-guarded — the lenient viewer tolerates
 * parentId cycles, so the climb must not spin). */
function nestingOf(nodes: Node[]): Map<string, { top: string; depth: number }> {
  const parentOf = new Map(nodes.map((node) => [node.id, node.parentId]));
  const info = new Map<string, { top: string; depth: number }>();
  for (const node of nodes) {
    let current = node.id;
    let depth = 0;
    const seen = new Set<string>();
    while (!seen.has(current)) {
      seen.add(current);
      const parent = parentOf.get(current);
      if (parent === null || parent === undefined || !parentOf.has(parent)) {
        break;
      }
      current = parent;
      depth += 1;
    }
    info.set(node.id, { top: current, depth });
  }
  return info;
}

/** Manual z for one wire: cross-canvas travels under everything; intra-frame sits at its depth. */
function wireZ(edge: Edge, nestingById: Map<string, { top: string; depth: number }>): number {
  const source = nestingById.get(edge.source);
  const target = nestingById.get(edge.target);
  if (!source || !target || source.top !== target.top) {
    return 0; // cross-canvas: under everything
  }
  return Math.max(source.depth, target.depth); // intra-frame: above the frame, below its cards
}
