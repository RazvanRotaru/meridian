/**
 * A unit for the Map lens: one class/interface/object — the service definition. It is an
 * expandable card that can become a titled FRAME whose method nodes nest inside (methods are
 * first-class nodes, so wires attach to the specific code that uses a dependency, and logic flows
 * can later chart in place); memberless it opens the shared honest empty state. Deliberately
 * light-weight: dependencies are the violet wires' story, not the card's. A green ring marks selection.
 */

import { memo } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { useSurfaceNodeSelected } from "../../canvas/SurfaceInteractionContext";
import { accentForKind } from "../../../theme/kindColors";
import type { UnitCardData } from "../../../derive/moduleLevel";
import { BaseNode, type BaseNodeModel } from "../BaseNode";
import { EmptyNodeExpansion } from "../EmptyNodeExpansion";
import { cardSelectedStyle, CodeButton, frameSelectedStyle, frameStyle, frameTitleBarStyle, MONO, PIN } from "./frameChrome";
import { borderFor, useNodeDiff } from "./changed";
import { ReviewNodeViewedChrome } from "../../review/ReviewFileNodeViewedControls";

type UnitRfNode = Node<UnitCardData, "unit">;

function UnitCardNodeImpl({ id, data }: NodeProps<UnitRfNode>) {
  const selected = useSurfaceNodeSelected(id);
  const diff = useNodeDiff(id);
  const accent = accentForKind(data.unitKind);
  const model: BaseNodeModel = {
    instanceId: id,
    targetId: id,
    nodeType: "unit",
    kind: data.unitKind,
    semantics: data.semantics,
    label: data.label,
    childCount: data.memberCount,
    canExpand: data.isContainer,
    expanded: data.isExpanded,
    canNavigate: true,
    data,
  };
  const handles = (
    <>
      <Handle type="target" position={Position.Left} style={PIN} isConnectable={false} />
      <Handle type="source" position={Position.Right} style={PIN} isConnectable={false} />
    </>
  );
  if (data.isFrame) {
    return (
      <ReviewNodeViewedChrome nodeId={id} scope="unit" borderRadius={8}>
        <BaseNode
          model={model}
          style={borderFor(frameStyle(accent), frameSelectedStyle(accent), selected, diff)}
          headerStyle={frameTitleBarStyle(diff.status)}
          labelStyle={LABEL}
          labelTitle={id}
          actions={<CodeButton id={id} />}
          ports={handles}
        >
          {data.memberCount === 0 ? <EmptyNodeExpansion message="No charted members" /> : null}
        </BaseNode>
      </ReviewNodeViewedChrome>
    );
  }

  if (data.isContainer) {
    return (
      <ReviewNodeViewedChrome nodeId={id} scope="unit" borderRadius={8}>
        <BaseNode
          model={model}
          style={borderFor(CARD, cardSelectedStyle(CARD, accent), selected, diff)}
          headerStyle={HEADER}
          labelStyle={LABEL}
          labelTitle={id}
          actions={<CodeButton id={id} />}
          ports={(
            <>
              {handles}
              <div style={{ ...ACCENT_BAR, background: accent }} />
            </>
          )}
          contentStyle={INNER_STACK}
        >
          <div style={META}>
            <span style={MEMBERS} title={`${data.memberCount} member declaration(s)`}>{data.memberCount} members</span>
          </div>
        </BaseNode>
      </ReviewNodeViewedChrome>
    );
  }

  return (
    <ReviewNodeViewedChrome nodeId={id} scope="unit" borderRadius={8}>
      <BaseNode
        model={model}
        style={borderFor(CARD, cardSelectedStyle(CARD, accent), selected, diff)}
        headerStyle={INNER}
        labelStyle={LABEL}
        labelTitle={id}
        actions={<CodeButton id={id} />}
        ports={(
          <>
            {handles}
            <div style={{ ...ACCENT_BAR, background: accent }} />
          </>
        )}
      />
    </ReviewNodeViewedChrome>
  );
}

export const UnitCardNode = memo(UnitCardNodeImpl);

const CARD: React.CSSProperties = {
  position: "relative",
  width: "100%",
  height: "100%",
  boxSizing: "border-box",
  border: "1px solid #2A3140",
  borderRadius: 8,
  background: "#171D26",
  overflow: "hidden",
  fontFamily: MONO,
};
const ACCENT_BAR: React.CSSProperties = { position: "absolute", left: 0, top: 0, bottom: 0, width: 4 };
const INNER: React.CSSProperties = { display: "flex", alignItems: "center", gap: 7, height: "100%", padding: "0 10px 0 12px" };
const INNER_STACK: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  justifyContent: "center",
  gap: 6,
  height: "100%",
  padding: "0 10px 0 12px",
};
const HEADER: React.CSSProperties = { display: "flex", alignItems: "center", gap: 6, minWidth: 0 };
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
const META: React.CSSProperties = { display: "flex", alignItems: "baseline", gap: 8, flexShrink: 0 };
const MEMBERS: React.CSSProperties = { fontSize: 10.5, color: "#9AA4B2" };
