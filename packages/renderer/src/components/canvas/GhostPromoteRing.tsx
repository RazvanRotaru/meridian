/**
 * The ghost "+" affordance, shared by EVERY surface (unified-canvas phase D): each canonical
 * real-id ghost card—and each temporarily materialized ghost-inspection preview—wears a subtle
 * round "+" straddling its top-right corner. One gesture has one meaning: "make this temporary
 * node permanent on this canvas". Persistent parent groups use their real artifact id, so they
 * remain promotable while their exact children expand around them. The
 * minimal overlay promotes an exact satellite into its member ring; Map/Service/UI pin its home
 * file into `mapExtra` (the ⌘P
 * palette's add-to-view mechanism)
 * — the store's shared `promoteGhost` action chooses the active destination, while `title` names
 * the surface's verb. Drawn in CANVAS
 * coordinates (ViewportPortal, so it must render INSIDE the flow), scaling with zoom exactly like
 * the card it sits on. Reads the PAINTED nodes: the paint re-bands lit ghosts selection-relative
 * (and the Map drops unlit ghosts entirely), so the "+" straddles the corner the exact card
 * actually renders at, and only on promotable temporary nodes actually on screen. The click reports
 * the node's on-screen top-left so a promotion can seat the permanent card where the reader's eye
 * already is.
 */

import { useMemo } from "react";
import { ViewportPortal, useStore, useViewport, type Node, type Viewport } from "@xyflow/react";
import { absoluteRectOf } from "../../layout/ghostBandPlacement";

/** A ghost card's on-screen top-left in flow coordinates, handed to the promotion. */
export interface GhostSpot {
  x: number;
  y: number;
}

export function GhostPromoteRing(props: { nodes: Node[]; title: string; onPromote: (id: string, at: GhostSpot) => void }) {
  const viewport = useViewport();
  const width = useStore((state) => state.width);
  const height = useStore((state) => state.height);
  const ghosts = useMemo(
    () => {
      const byId = new Map(props.nodes.map((node) => [node.id, node]));
      return visiblePromotableGhostNodes(props.nodes, viewport, width, height)
        .map((node) => ghostCorner(node, byId));
    },
    [props.nodes, viewport, width, height],
  );
  return (
    <ViewportPortal>
      {ghosts.map((ghost) => (
        <div key={ghost.id} style={ghostAddWrap(ghost)}>
          <button
            type="button"
            data-ghost-id={ghost.id}
            style={ADD_GHOST_STYLE}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              props.onPromote(ghost.promoteId, { x: ghost.x, y: ghost.y });
            }}
            title={props.title}
            aria-label={props.title}
          >
            +
          </button>
        </div>
      ))}
    </ViewportPortal>
  );
}

// Exact ghosts and persistent REAL parent anchors promote through main's canonical path. A
// temporary inspection preview is already rendered with its real node kind/id, but remains just as
// ephemeral as a ghost until the reader explicitly promotes it. A legacy synthetic/fallback group
// has no graph identity and must disclose a real child first.
export function promotableGhostNodes(nodes: readonly Node[]): Node[] {
  return nodes.filter((node) => ghostPromotionTarget(node) !== null);
}

export function ghostPromotionTarget(node: Node): string | null {
  const data = node.data as {
    ghostGroupId?: unknown;
    ghostInspectionPreview?: unknown;
    ghostRole?: unknown;
    ghostPromotable?: unknown;
    ghostSynthetic?: unknown;
  };
  if (node.type !== "ghost") {
    return data.ghostInspectionPreview === true ? node.id : null;
  }
  if (data.ghostRole === "parent-anchor") {
    return data.ghostPromotable === true && data.ghostSynthetic !== true ? node.id : null;
  }
  // Defensive compatibility for an old direction-scoped synthetic card.
  if (typeof data.ghostGroupId === "string") return null;
  return node.id;
}

/** Match React Flow's visible-element optimization for the separate ViewportPortal controls. The
 * cards themselves are virtualized by the canvas; without this pass, a high-degree level would
 * still mount one off-screen button wrapper per promotable temporary node. */
export function visiblePromotableGhostNodes(
  nodes: readonly Node[],
  viewport: Viewport,
  canvasWidth: number,
  canvasHeight: number,
): Node[] {
  if (canvasWidth <= 0 || canvasHeight <= 0 || viewport.zoom <= 0) return [];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  return promotableGhostNodes(nodes)
    .filter((node) => intersectsViewport(node, byId, viewport, canvasWidth, canvasHeight));
}

const VIEWPORT_OVERSCAN = 24;

function intersectsViewport(
  node: Node,
  byId: ReadonlyMap<string, Node>,
  viewport: Viewport,
  canvasWidth: number,
  canvasHeight: number,
): boolean {
  const rect = absoluteRectOf(node, byId);
  const style = (node.style ?? {}) as { width?: number; height?: number };
  const width = style.width ?? node.width ?? 0;
  const height = style.height ?? node.height ?? 0;
  const left = rect.x * viewport.zoom + viewport.x;
  const top = rect.y * viewport.zoom + viewport.y;
  const right = left + width * viewport.zoom;
  const bottom = top + height * viewport.zoom;
  return right >= -VIEWPORT_OVERSCAN
    && bottom >= -VIEWPORT_OVERSCAN
    && left <= canvasWidth + VIEWPORT_OVERSCAN
    && top <= canvasHeight + VIEWPORT_OVERSCAN;
}

// The "+" add button's size in FLOW units — so ViewportPortal scales it with the node at every zoom.
const ADD_SIZE = 20;
type GhostCorner = { id: string; promoteId: string; x: number; y: number; right: number };

// The target's top-left + top-right corner in absolute flow coordinates. Ordinary painted ghosts
// are root-level; an inspection preview can be nested in its temporary file/unit frames, so climb
// its React Flow parent chain before positioning the shared ViewportPortal control.
function ghostCorner(node: Node, byId: ReadonlyMap<string, Node>): GhostCorner {
  const rect = absoluteRectOf(node, byId);
  const width = ((node.style ?? {}) as { width?: number }).width ?? 0;
  return {
    id: node.id,
    promoteId: ghostPromotionTarget(node)!,
    x: rect.x,
    y: rect.y,
    right: rect.x + width,
  };
}

// Centre the "+" on that corner (half in / half out). left/top:0 + translate is the ViewportPortal idiom;
// it applies the canvas zoom/pan transform, so a flow-unit-sized child scales with the graph.
function ghostAddWrap(corner: GhostCorner): React.CSSProperties {
  return { position: "absolute", left: 0, top: 0, transform: `translate(${corner.right - ADD_SIZE / 2}px, ${corner.y - ADD_SIZE / 2}px)`, pointerEvents: "all" };
}

// The subtle "add this ghost" affordance: a small round + straddling the ghost card's top-right corner
// (half in, half out), not a loud button. Neutral until hovered so it stays quiet among many ghosts.
const ADD_GHOST_STYLE: React.CSSProperties = {
  width: ADD_SIZE,
  height: ADD_SIZE,
  borderRadius: "50%",
  display: "grid",
  placeItems: "center",
  border: "1px solid #3A4452",
  background: "#1B222C",
  color: "#AEB8C4",
  fontSize: 15,
  fontWeight: 700,
  lineHeight: 1,
  cursor: "pointer",
  boxShadow: "0 1px 3px rgba(0,0,0,0.45)",
};
