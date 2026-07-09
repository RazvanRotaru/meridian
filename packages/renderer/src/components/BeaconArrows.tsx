/**
 * Screen-edge GUIDE ARROWS for beacon targets — the video-game waypoint read: when a selected call
 * step's definition sits outside the current viewport, an arrow pinned to the nearest screen edge
 * points toward it (the wire itself is deliberately withheld — the ring + this arrow ARE the link).
 * Clicking an arrow pans the canvas to the definition. Renders nothing for targets already in view.
 * Must mount INSIDE <ReactFlow> (it reads the viewport/node internals from React Flow's store).
 */

import { useReactFlow, useStore, useViewport } from "@xyflow/react";

const MARGIN = 26;
const SELECT_ACCENT = "#6BE38A";

export function BeaconArrows(props: { targets: ReadonlySet<string> }) {
  const rf = useReactFlow();
  useViewport(); // subscribe: arrows track every pan/zoom
  const width = useStore((state) => state.width);
  const height = useStore((state) => state.height);
  if (props.targets.size === 0 || width === 0) {
    return null;
  }
  const arrows = [...props.targets].map((id) => arrowFor(id, rf, width, height)).filter((a) => a !== null);
  if (arrows.length === 0) {
    return null;
  }
  return (
    <div style={LAYER}>
      {arrows.map((arrow) => (
        <button
          key={arrow.id}
          type="button"
          style={{ ...ARROW, left: arrow.x, top: arrow.y, transform: `translate(-50%, -50%) rotate(${arrow.angle}deg)` }}
          title={`${arrow.label} — click to bring it into view`}
          onClick={() => rf.setCenter(arrow.centerX, arrow.centerY, { duration: 500, zoom: rf.getViewport().zoom })}
        >
          ➤
        </button>
      ))}
    </div>
  );
}

interface Arrow {
  id: string;
  x: number;
  y: number;
  angle: number;
  label: string;
  centerX: number;
  centerY: number;
}

/** Where (and whether) `id` needs a guide: null when it is drawn inside the viewport already. */
function arrowFor(id: string, rf: ReturnType<typeof useReactFlow>, width: number, height: number): Arrow | null {
  const internal = rf.getInternalNode(id);
  if (!internal) {
    return null;
  }
  const abs = internal.internals.positionAbsolute;
  const centerX = abs.x + (internal.measured.width ?? 0) / 2;
  const centerY = abs.y + (internal.measured.height ?? 0) / 2;
  const { x, y, zoom } = rf.getViewport();
  // The node's centre in PANE coordinates (the flow position run through the current transform).
  const px = centerX * zoom + x;
  const py = centerY * zoom + y;
  if (px >= 0 && px <= width && py >= 0 && py <= height) {
    return null; // already on screen — the ring is enough.
  }
  const clampedX = Math.min(Math.max(px, MARGIN), width - MARGIN);
  const clampedY = Math.min(Math.max(py, MARGIN), height - MARGIN);
  const angle = (Math.atan2(py - clampedY, px - clampedX) * 180) / Math.PI;
  const label = (rf.getNode(id)?.data as { label?: string } | undefined)?.label ?? id;
  return { id, x: clampedX, y: clampedY, angle, label, centerX, centerY };
}

const LAYER: React.CSSProperties = { position: "absolute", inset: 0, pointerEvents: "none", zIndex: 6 };
const ARROW: React.CSSProperties = {
  position: "absolute",
  pointerEvents: "auto",
  width: 30,
  height: 30,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  border: `1px solid ${SELECT_ACCENT}`,
  borderRadius: "50%",
  background: "rgba(14,17,22,0.9)",
  color: SELECT_ACCENT,
  fontSize: 14,
  lineHeight: 1,
  cursor: "pointer",
  boxShadow: "0 2px 10px rgba(0,0,0,0.45)",
};
