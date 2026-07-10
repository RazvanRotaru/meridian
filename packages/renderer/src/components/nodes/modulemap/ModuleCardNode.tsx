/**
 * A file card for the Map lens: one source file (meridian `module`) as a compact card showing
 * its name, a category chip (UI / Utilities / Config / App), and its afferent/efferent import counts.
 * The blast-radius root wears an "ENTRY" badge. A file that declares units (classes/interfaces/
 * objects) carries the same chevron as a group card: expanding turns the card into a transparent
 * frame whose unit cards nest inside — the merged Service-composition level. A green ring marks the
 * selected card — read from the store, mirroring how the composition and logic nodes show theirs.
 */

import { memo } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { useBlueprint } from "../../../state/StoreContext";
import type { ModuleCardData } from "../../../derive/moduleLevel";
import { PackageOverviewNode } from "./PackageOverviewNode";
import { UnitCardNode } from "./UnitCardNode";
import { BlockNode } from "./BlockNode";
import { StepNode } from "./StepNode";
import { GhostNode } from "./GhostNode";
import { cardSelectedStyle, CodeButton, ExpandChevron, FrameTitleBar, frameSelectedStyle, frameStyle, MONO, PIN } from "./frameChrome";
import { borderFor, useNodeDiff } from "./changed";
import { CHANGED_COLORS } from "../../../theme/changedColors";

// The file family's frame accent (the module cyan), used when an expanded card turns into a frame.
const FILE_FRAME_ACCENT = "#3FB7C4";

type ModuleCardRfNode = Node<ModuleCardData, "file">;

function ModuleCardNodeImpl({ id, data }: NodeProps<ModuleCardRfNode>) {
  const selected = useBlueprint((state) => state.moduleSelected.has(id));
  const diff = useNodeDiff(id);
  // A file is NOT coloured (only its touched blocks are); instead it shows GitHub's +N/-M churn before
  // its name, so a reviewer sees which files the PR touched and how heavily.
  const filePath = useBlueprint((state) => state.index.nodesById.get(id)?.location?.file);
  const delta = useBlueprint((state) => (filePath ? state.reviewFileDelta[filePath] : undefined));
  // Every file wears the neutral file-family accent; its CATEGORY is carried by the text chip alone,
  // so category never competes for a hue with the relationship (caller/callee) or kind palettes.
  const accent = FILE_FRAME_ACCENT;
  const chevron = data.isContainer ? (
    <ExpandChevron id={id} isExpanded={data.isExpanded} collapsedTitle={`Expand — ${data.unitCount} declaration(s) in this file`} />
  ) : null;
  const entryBadge = data.isEntry ? <span style={ENTRY_BADGE} title="Blast-radius root">ENTRY</span> : null;

  if (data.isExpanded) {
    return (
      <div style={borderFor(frameStyle(FILE_FRAME_ACCENT), frameSelectedStyle(FILE_FRAME_ACCENT), selected, diff)}>
        <Handle type="target" position={Position.Left} style={PIN} isConnectable={false} />
        <Handle type="source" position={Position.Right} style={PIN} isConnectable={false} />
        <FrameTitleBar chevron={chevron}>
          <DiffStat delta={delta} />
          <span className="lod-label" style={LABEL} title={data.fullPath}>{data.label}</span>
          <span className="lod-hide" style={CONTENTS}>
            {entryBadge}
            <CodeButton id={id} />
            <span style={{ ...CHIP, color: accent, borderColor: accent }}>{data.category.toUpperCase()}</span>
          </span>
        </FrameTitleBar>
      </div>
    );
  }

  return (
    <div className="lod-tint" style={{ ...borderFor(CARD, cardSelectedStyle(CARD, accent), selected, diff), "--lod-accent": accent } as React.CSSProperties}>
      <Handle type="target" position={Position.Left} style={PIN} isConnectable={false} />
      <Handle type="source" position={Position.Right} style={PIN} isConnectable={false} />
      <div className="lod-rail" style={{ ...ACCENT_BAR, background: accent }} />
      <span className="lod-place">{data.label}</span>
      <div className="lod-card-body" style={INNER}>
        <div style={HEADER}>
          {chevron}
          <DiffStat delta={delta} />
          <span style={LABEL} title={data.fullPath}>{data.label}</span>
          <span className="lod-hide" style={CONTENTS}>
            {entryBadge}
            <CodeButton id={id} />
          </span>
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

/** Groups siblings for one visibility flip without disturbing the flex row (children keep laying
 * out as if the wrapper weren't there; `visibility` inherits through it). */
const CONTENTS: React.CSSProperties = { display: "contents" };

/** The "+N -M" churn a changed FILE card shows before its name (the marker that replaces colouring
 * the whole file). Green additions, red deletions; hidden when the file has no counted changes. */
function DiffStat({ delta }: { delta?: { added: number; deleted: number } }) {
  if (!delta || (delta.added === 0 && delta.deleted === 0)) {
    return null;
  }
  return (
    <span style={DIFF_STAT} title={`+${delta.added} added · −${delta.deleted} deleted`}>
      <span style={{ color: CHANGED_COLORS.added }}>+{delta.added}</span>
      <span style={{ color: CHANGED_COLORS.deleted }}>−{delta.deleted}</span>
    </span>
  );
}

export const ModuleCardNode = memo(ModuleCardNodeImpl);

/** The node-type registry the Map surface hands React Flow (a stable module-level reference).
 * `package` is a group card (a package at the repo overview, a directory one level deeper); `file`
 * is a source file; `unit` is a class/interface/object frame nested inside an expanded file frame;
 * `block` is a leaf code block (a method, function, or type definition). A card the reader expands
 * becomes a frame whose children NEST inside it (parentId), so a level can hold nested frames —
 * mirroring the call graph's ContainerNode. */
export const moduleNodeTypes = { file: ModuleCardNode, package: PackageOverviewNode, unit: UnitCardNode, block: BlockNode, step: StepNode, ghost: GhostNode };

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
const DIFF_STAT: React.CSSProperties = {
  flexShrink: 0,
  display: "inline-flex",
  gap: 4,
  fontSize: 10,
  fontWeight: 700,
  fontFamily: MONO,
};
const COUNTS: React.CSSProperties = { display: "inline-flex", alignItems: "baseline", gap: 4, fontSize: 10.5 };
const COUNT_MUTED: React.CSSProperties = { color: "#6C7683" };
const COUNT_VALUE: React.CSSProperties = { color: "#C8D3E0", fontWeight: 600 };
