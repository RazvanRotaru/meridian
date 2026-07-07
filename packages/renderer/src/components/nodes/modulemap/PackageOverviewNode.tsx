/**
 * A package card for the Module-map's whole-repository overview: one npm package as a single node
 * showing its name, file count, and cross-package fan-in/out (Ca/Ce). Double-clicking it drills into
 * that package's file view (handled by the surface). A green ring marks the selection, read from the
 * store — same idiom as the file card and composition/logic nodes.
 */

import { memo } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { useBlueprint } from "../../../state/StoreContext";
import type { ModulePackageData } from "../../../derive/packageOverview";

const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";
const SELECT_ACCENT = "#6BE38A";
// A neutral package hue — the cross-package coupling gold lives on the wires, not the boxes.
const PACKAGE_ACCENT = "#5B9BE3";

type PackageRfNode = Node<ModulePackageData, "package">;

function PackageOverviewNodeImpl({ id, data }: NodeProps<PackageRfNode>) {
  const selected = useBlueprint((state) => state.moduleSelectedId) === id;
  return (
    <div style={selected ? CARD_SELECTED : CARD}>
      <Handle type="target" position={Position.Left} style={PIN} isConnectable={false} />
      <Handle type="source" position={Position.Right} style={PIN} isConnectable={false} />
      <div style={{ ...ACCENT_BAR, background: PACKAGE_ACCENT }} />
      <div style={INNER}>
        <span style={LABEL} title={id}>{data.label}</span>
        <div style={META}>
          <span style={FILES} title={`${data.fileCount} source file(s)`}>{data.fileCount} files</span>
          <span style={COUNTS} title={`imports ${data.ce} package(s) · imported by ${data.ca}`}>
            <span style={COUNT_MUTED}>uses</span>
            <span style={COUNT_VALUE}>{data.ce}</span>
            <span style={COUNT_MUTED}>used by</span>
            <span style={COUNT_VALUE}>{data.ca}</span>
          </span>
        </div>
      </div>
    </div>
  );
}

export const PackageOverviewNode = memo(PackageOverviewNodeImpl);

const PIN: React.CSSProperties = { width: 6, height: 6, background: "#C8D3E0", border: "none", minWidth: 0, minHeight: 0 };
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
const CARD_SELECTED: React.CSSProperties = { ...CARD, borderColor: SELECT_ACCENT, boxShadow: `0 0 0 2px ${SELECT_ACCENT}` };
const ACCENT_BAR: React.CSSProperties = { position: "absolute", left: 0, top: 0, bottom: 0, width: 4 };
const INNER: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  justifyContent: "center",
  gap: 8,
  height: "100%",
  padding: "0 12px 0 14px",
};
const LABEL: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 700,
  color: "#E6EDF3",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
const META: React.CSSProperties = { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 };
const FILES: React.CSSProperties = { fontSize: 11, color: "#9AA4B2" };
const COUNTS: React.CSSProperties = { display: "inline-flex", alignItems: "baseline", gap: 4, fontSize: 10.5 };
const COUNT_MUTED: React.CSSProperties = { color: "#6C7683" };
const COUNT_VALUE: React.CSSProperties = { color: "#C8D3E0", fontWeight: 600 };
