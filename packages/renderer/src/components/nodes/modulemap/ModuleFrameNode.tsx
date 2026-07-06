/**
 * A directory FRAME for the Module-map lens: the titled translucent panel that groups the file cards
 * of one package/folder on a given import ring, so the map reads as "what's in each package, how many
 * hops out". Adapted from the composition ClusterFrameNode — a quiet slate box with a header carrying
 * the folder label, an "N files" count, and a ring badge. Purely passive: the file cards parent to it
 * render OVER its transparent body; the frame itself has no click behaviour of its own.
 */

import { memo } from "react";
import type { Node, NodeProps } from "@xyflow/react";
import type { ModuleFrameData } from "../../../derive/moduleMap";

const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

type ModuleFrameRfNode = Node<ModuleFrameData, "frame">;

function ModuleFrameNodeImpl({ data }: NodeProps<ModuleFrameRfNode>) {
  return (
    <div style={FRAME}>
      <div style={TITLE}>
        <span style={PKG_GLYPH}>◗</span>
        <span style={LABEL} title={data.label}>{data.label}</span>
        <span style={COUNT}>{`${data.fileCount} ${data.fileCount === 1 ? "file" : "files"}`}</span>
        <span style={RING_BADGE} title={`${data.ring} import hop(s) from the root`}>{`ring ${data.ring}`}</span>
      </div>
    </div>
  );
}

export const ModuleFrameNode = memo(ModuleFrameNodeImpl);

// A neutral slate frame, deliberately quieter than the file-card accents so the cards inside stay the
// focus. Fills its exact laid-out box (border-box); the body is transparent for the child cards.
const FRAME: React.CSSProperties = {
  width: "100%",
  height: "100%",
  boxSizing: "border-box",
  border: "1px solid #2A313D",
  borderRadius: 12,
  background: "rgba(20,25,33,0.45)",
  fontFamily: MONO,
};
// A 34px title matches the layout's TITLE_BAR so the child cards clear it.
const TITLE: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  height: 34,
  boxSizing: "border-box",
  padding: "0 12px",
  borderBottom: "1px solid #232935",
  color: "#B7C0CC",
  fontSize: 12,
  fontWeight: 700,
};
const PKG_GLYPH: React.CSSProperties = { fontSize: 12, flexShrink: 0, color: "#A77BF3" };
const LABEL: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
const COUNT: React.CSSProperties = { flexShrink: 0, fontSize: 10, fontWeight: 600, color: "#6C7683" };
const RING_BADGE: React.CSSProperties = {
  flexShrink: 0,
  fontSize: 9.5,
  fontWeight: 700,
  letterSpacing: "0.04em",
  color: "#8FB6E3",
  border: "1px solid #2F4A66",
  background: "rgba(59,122,192,0.16)",
  borderRadius: 3,
  padding: "1px 5px",
};
