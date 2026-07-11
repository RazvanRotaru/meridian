/**
 * The ghost "+" affordance, shared by EVERY surface (unified-canvas phase D): each ghost card wears
 * a subtle round "+" straddling its top-right corner — one gesture, one meaning: "make this ghost
 * permanent on this canvas". The minimal overlay promotes the satellite into its member ring;
 * Map/Service/UI pin the ghost's home file into `mapExtra` (the ⌘P palette's add-to-view mechanism)
 * — the mount decides via `onPromote`, and its `title` names the surface's verb. Drawn in CANVAS
 * coordinates (ViewportPortal, so it must render INSIDE the flow), scaling with zoom exactly like
 * the card it sits on. Reads the PAINTED nodes: the paint re-bands lit ghosts selection-relative
 * (and the Map drops unlit ghosts entirely), so the "+" straddles the corner the card actually
 * renders at, and only on ghosts actually on screen. The click reports the ghost's on-screen
 * top-left so a promotion can seat the permanent card where the reader's eye already is.
 */

import { useMemo } from "react";
import { ViewportPortal, type Node } from "@xyflow/react";

/** A ghost card's on-screen top-left in flow coordinates, handed to the promotion. */
export interface GhostSpot {
  x: number;
  y: number;
}

export function GhostPromoteRing(props: { nodes: Node[]; title: string; onPromote: (id: string, at: GhostSpot) => void }) {
  const ghosts = useMemo(() => props.nodes.filter(isGhost).map(ghostCorner), [props.nodes]);
  return (
    <ViewportPortal>
      {ghosts.map((ghost) => (
        <div key={ghost.id} style={ghostAddWrap(ghost)}>
          <button
            type="button"
            style={ADD_GHOST_STYLE}
            onClick={() => props.onPromote(ghost.id, { x: ghost.x, y: ghost.y })}
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

const isGhost = (node: Node): boolean => node.type === "ghost";

// The "+" add button's size in FLOW units — so ViewportPortal scales it with the node at every zoom.
const ADD_SIZE = 20;
type GhostCorner = { id: string; x: number; y: number; right: number };

// A ghost's top-left + top-RIGHT corner in absolute flow coords (painted ghosts are root-level, so
// position IS absolute — layout bands them at root, and the paint's reposition drops any parentId).
function ghostCorner(node: Node): GhostCorner {
  const width = ((node.style ?? {}) as { width?: number }).width ?? 0;
  return { id: node.id, x: node.position.x, y: node.position.y, right: node.position.x + width };
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
