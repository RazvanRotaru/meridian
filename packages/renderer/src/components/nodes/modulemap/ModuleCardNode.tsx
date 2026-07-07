/**
 * A file card for the Module-map lens: one source file (meridian `module`) as a compact card showing
 * its name, a category chip (UI / Utilities / Config / App), and its afferent/efferent import counts.
 * The blast-radius root wears an "ENTRY" badge. Adapted from the composition scorecard's dark styling
 * but stripped to the essentials a file needs. A green ring marks the selected card — read from the
 * store, mirroring how the composition and logic nodes show their selection.
 */

import { memo } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { useBlueprint } from "../../../state/StoreContext";
import type { ModuleCardData } from "../../../derive/moduleLevel";
import type { ModuleCategory } from "../../../derive/moduleCategory";
import { PackageOverviewNode } from "./PackageOverviewNode";

const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";
// The green shared with the emphasized import wires, so a card's ring and its lit edges read as one
// highlight (mirrors the composition tab's COMP_SELECT_ACCENT).
const SELECT_ACCENT = "#6BE38A";

type ModuleCardRfNode = Node<ModuleCardData, "file">;

function ModuleCardNodeImpl({ id, data }: NodeProps<ModuleCardRfNode>) {
  const selected = useBlueprint((state) => state.moduleSelectedId) === id;
  const accent = CATEGORY_COLOR[data.category];
  return (
    <div style={selected ? CARD_SELECTED : CARD}>
      <Handle type="target" position={Position.Left} style={PIN} isConnectable={false} />
      <Handle type="source" position={Position.Right} style={PIN} isConnectable={false} />
      <div style={{ ...ACCENT_BAR, background: accent }} />
      <div style={INNER}>
        <div style={HEADER}>
          <span style={LABEL} title={data.fullPath}>{data.label}</span>
          {data.isEntry ? <span style={ENTRY_BADGE} title="Blast-radius root">ENTRY</span> : null}
        </div>
        <div style={META}>
          <span style={{ ...CHIP, color: accent, borderColor: accent }}>{data.category.toUpperCase()}</span>
          <span style={COUNTS} title={`${data.inCount} importer(s) · ${data.outCount} import(s)`}>
            <span style={COUNT_MUTED}>in</span>
            <span style={COUNT_VALUE}>{data.inCount}</span>
            <span style={COUNT_MUTED}>out</span>
            <span style={COUNT_VALUE}>{data.outCount}</span>
          </span>
        </div>
      </div>
    </div>
  );
}

export const ModuleCardNode = memo(ModuleCardNodeImpl);

/** The node-type registry the Module-map surface hands React Flow (a stable module-level reference).
 * `package` is a group card (a package at the repo overview, a directory one level deeper); `file`
 * is a source file. */
export const moduleNodeTypes = { file: ModuleCardNode, package: PackageOverviewNode };

// Category → accent hue, echoing the palette used across the dark surfaces: entry green (the "you are
// here" signal), ui blue, util amber, config violet, app a neutral slate. Exported so the Module-map
// MiniMap tints its file dots with the same palette as the cards.
export const CATEGORY_COLOR: Record<ModuleCategory, string> = {
  entry: "#56C271",
  ui: "#5B9BE3",
  util: "#C9A24B",
  config: "#A78BFA",
  app: "#8A94A3",
};

const PIN: React.CSSProperties = { width: 6, height: 6, background: "#C8D3E0", border: "none", minWidth: 0, minHeight: 0 };

const CARD: React.CSSProperties = {
  position: "relative",
  width: "100%",
  height: "100%",
  boxSizing: "border-box",
  border: "1px solid #232935",
  borderRadius: 8,
  background: "#12171E",
  overflow: "hidden",
  fontFamily: MONO,
};
// The selection ring is an outset box-shadow, so overflow:hidden on the card never clips it.
const CARD_SELECTED: React.CSSProperties = {
  ...CARD,
  borderColor: SELECT_ACCENT,
  boxShadow: `0 0 0 2px ${SELECT_ACCENT}`,
};
const ACCENT_BAR: React.CSSProperties = { position: "absolute", left: 0, top: 0, bottom: 0, width: 4 };
const INNER: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  justifyContent: "center",
  gap: 6,
  height: "100%",
  padding: "0 10px 0 12px",
};
const HEADER: React.CSSProperties = { display: "flex", alignItems: "center", gap: 6 };
const LABEL: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontSize: 12.5,
  fontWeight: 700,
  color: "#E6EDF3",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
const ENTRY_BADGE: React.CSSProperties = {
  flexShrink: 0,
  fontSize: 8,
  fontWeight: 700,
  letterSpacing: "0.06em",
  color: "#56C271",
  border: "1px solid #2F5C3B",
  background: "rgba(86,194,113,0.16)",
  borderRadius: 3,
  padding: "1px 4px",
};
const META: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8 };
const CHIP: React.CSSProperties = {
  flexShrink: 0,
  fontSize: 8,
  fontWeight: 700,
  letterSpacing: "0.06em",
  border: "1px solid",
  borderRadius: 3,
  padding: "1px 4px",
};
const COUNTS: React.CSSProperties = { display: "inline-flex", alignItems: "baseline", gap: 4, fontSize: 10.5 };
const COUNT_MUTED: React.CSSProperties = { color: "#6C7683" };
const COUNT_VALUE: React.CSSProperties = { color: "#C8D3E0", fontWeight: 600 };
