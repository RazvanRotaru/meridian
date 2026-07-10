/**
 * A group card for the Map lens: one npm package (at the overview) or directory (deeper) showing
 * its name, file count, and import fan-in/out (Ca/Ce). A container card carries a chevron that
 * EXPANDS it in place — collapsed it is a solid box; expanded it becomes a transparent titled frame
 * whose body lets React Flow draw the nested children inside it, exactly like the call graph's
 * ContainerNode. Double-clicking the card still re-roots into it (handled by the surface); the
 * chevron is the coexisting inline gesture. A green ring marks the selection, read from the store.
 */

import { memo } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { useBlueprint } from "../../../state/StoreContext";
import type { ModuleGroupData } from "../../../derive/moduleTree";
import { cardSelectedStyle, ExpandChevron, FrameTitleBar, frameSelectedStyle, frameStyle, MONO, PIN } from "./frameChrome";
import { borderFor, DeltaChip, useNodeDiff } from "./changed";

// A neutral package hue — the cross-package coupling gold lives on the wires, not the boxes.
const PACKAGE_ACCENT = "#5B9BE3";

type PackageRfNode = Node<ModuleGroupData, "package">;

type PackageMetaData = Pick<ModuleGroupData, "fileCount" | "ca" | "ce">;

function PackageOverviewNodeImpl({ id, data }: NodeProps<PackageRfNode>) {
  const selected = useBlueprint((state) => state.moduleSelected.has(id));
  const diff = useNodeDiff(id);
  const chevron = data.isContainer ? <ExpandChevron id={id} isExpanded={data.isExpanded} /> : null;

  if (data.isExpanded) {
    return (
      <div style={borderFor(frameStyle(PACKAGE_ACCENT), frameSelectedStyle(PACKAGE_ACCENT), selected, diff)}>
        <Handle type="target" position={Position.Left} style={PIN} isConnectable={false} />
        <Handle type="source" position={Position.Right} style={PIN} isConnectable={false} />
        <FrameTitleBar chevron={chevron}>
          <span className="lod-label" style={TITLE_LABEL} title={id}>{data.label}</span>
          <span className="lod-hide" style={CONTENTS}>
            <DeltaChip diff={diff} />
            <Meta data={data} hideCoupling={data.readOnly} />
          </span>
        </FrameTitleBar>
      </div>
    );
  }

  return (
    <div className="lod-tint" style={{ ...borderFor(CARD, cardSelectedStyle(CARD, PACKAGE_ACCENT), selected, diff), "--lod-accent": PACKAGE_ACCENT } as React.CSSProperties}>
      <Handle type="target" position={Position.Left} style={PIN} isConnectable={false} />
      <Handle type="source" position={Position.Right} style={PIN} isConnectable={false} />
      <div className="lod-rail" style={{ ...ACCENT_BAR, background: PACKAGE_ACCENT }} />
      <span className="lod-place">{data.label}</span>
      <div className="lod-card-body" style={INNER}>
        <div style={HEADER}>
          {chevron}
          <span style={LABEL} title={id}>{data.label}</span>
          <DeltaChip diff={diff} />
        </div>
        <Meta data={data} />
      </div>
    </div>
  );
}

/** File count + cross-package fan-in/out — shown compact in a title bar, block in a collapsed card.
 * `hideCoupling` drops the uses/used-by pair when the counts aren't meaningful (a filtered subgraph). */
function Meta({ data, hideCoupling }: { data: PackageMetaData; hideCoupling?: boolean }) {
  return (
    <div style={META}>
      <span style={FILES} title={`${data.fileCount} source file(s)`}>{data.fileCount} files</span>
      {hideCoupling ? null : (
        <span style={COUNTS} title={`imports ${data.ce} · imported by ${data.ca}`}>
          <span style={COUNT_MUTED}>uses</span>
          <span style={COUNT_VALUE}>{data.ce}</span>
          <span style={COUNT_MUTED}>used by</span>
          <span style={COUNT_VALUE}>{data.ca}</span>
        </span>
      )}
    </div>
  );
}

/** Visibility-flip wrapper that stays out of flex layout (visibility inherits through it). */
const CONTENTS: React.CSSProperties = { display: "contents" };

export const PackageOverviewNode = memo(PackageOverviewNodeImpl);

const CARD: React.CSSProperties = {
  position: "relative",
  width: "100%",
  height: "100%",
  boxSizing: "border-box",
  border: "1px solid #232935",
  borderRadius: 8,
  background: "#141A22",
  overflow: "hidden",
  fontFamily: MONO,
};
const TITLE_LABEL: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontSize: 12.5,
  fontWeight: 700,
  color: "#E6EDF3",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
const ACCENT_BAR: React.CSSProperties = { position: "absolute", left: 0, top: 0, bottom: 0, width: 4 };
const INNER: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  justifyContent: "center",
  gap: 8,
  height: "100%",
  padding: "0 12px 0 14px",
};
const HEADER: React.CSSProperties = { display: "flex", alignItems: "center", gap: 6, minWidth: 0 };
const LABEL: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontSize: 13,
  fontWeight: 700,
  color: "#E6EDF3",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
const META: React.CSSProperties = { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8, flexShrink: 0 };
const FILES: React.CSSProperties = { fontSize: 11, color: "#9AA4B2" };
const COUNTS: React.CSSProperties = { display: "inline-flex", alignItems: "baseline", gap: 4, fontSize: 10.5 };
const COUNT_MUTED: React.CSSProperties = { color: "#6C7683" };
const COUNT_VALUE: React.CSSProperties = { color: "#C8D3E0", fontWeight: 600 };
