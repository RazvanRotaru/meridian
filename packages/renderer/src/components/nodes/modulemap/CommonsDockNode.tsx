/**
 * The COMMONS DOCK tray: the labelled shelf the demoted utility hubs live on (see
 * layout/commonsDockPlacement). It wears the ghost dialect — dashed border, whisper fill — because
 * like the ghosts it is DETACHED CONTEXT, not a peer of the graph's cards; its one job is to say
 * "these cards are the level's shared utilities" once, so the cards inside stay clean. Entirely
 * non-interactive (pointer events pass through to the pane); the cards inside are ordinary nodes.
 */

import { memo } from "react";
import type { Node, NodeProps } from "@xyflow/react";
import { MONO } from "./frameChrome";

type DockRfNode = Node<{ count: number }, "commonsDock">;

function CommonsDockNodeImpl({ data }: NodeProps<DockRfNode>) {
  return (
    <div style={TRAY} title="Commons: utilities this whole level depends on — their wires hide until you select one">
      <div style={TITLE_ROW}>
        <span className="lod-label" style={TITLE}>COMMONS</span>
        <span style={COUNT}>{data.count}</span>
      </div>
    </div>
  );
}

export const CommonsDockNode = memo(CommonsDockNodeImpl);

const TRAY: React.CSSProperties = {
  width: "100%",
  height: "100%",
  boxSizing: "border-box",
  border: "1px dashed #5C4A2F",
  borderRadius: 10,
  background: "rgba(176,143,78,0.05)",
  fontFamily: MONO,
  // The tray is a LABELLED BACKDROP, never a click target — clicks fall through to the pane.
  pointerEvents: "none",
};
const TITLE_ROW: React.CSSProperties = { display: "flex", alignItems: "center", gap: 6, padding: "7px 12px 0" };
const TITLE: React.CSSProperties = {
  fontSize: 9,
  fontWeight: 700,
  letterSpacing: "0.09em",
  color: "#B08F4E",
};
const COUNT: React.CSSProperties = { fontSize: 9, color: "#7A6630" };
