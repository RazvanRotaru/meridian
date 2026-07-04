/**
 * Logic-graph node components, styled after Unreal Blueprints: dark bodies with a coloured title
 * bar and left/right exec pins (the white sequence wires connect through them). A "building block"
 * is a function-call node — provenance (package › module) rides under the title so a block is never
 * a bare name; expandable ones carry a disclosure and expand INTO a container frame; greyed leaves
 * are smaller/desaturated. `for`/`while`/`try` render as framed containers; `if`/`switch` as a
 * compact Branch node whose then/else/case wires leave labeled.
 */

import { Handle, Position, type NodeProps } from "@xyflow/react";
import { useBlueprint, useBlueprintActions } from "../../../state/StoreContext";
import type { LogicRfNode } from "../../../layout/logicElk";
import type { LogicNodeData } from "../../../derive/logicGraph";

const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

function ExecPins() {
  return (
    <>
      <Handle type="target" position={Position.Left} style={PIN} isConnectable={false} />
      <Handle type="source" position={Position.Right} style={PIN} isConnectable={false} />
    </>
  );
}

function BlockNode({ id, data }: NodeProps<LogicRfNode>) {
  const { toggleLogicExpand, showCode, expandCode } = useBlueprintActions();
  const index = useBlueprint((s) => s.index);
  const sourceUrl = useBlueprint((s) => s.sourceUrl);
  const d = data as LogicNodeData;
  if (d.isContainer) {
    return <ContainerFrame accent={BLOCK_ACCENT} label={d.label} glyph="ƒ" onToggle={() => toggleLogicExpand(id)} provenance={d.provenance} />;
  }
  const codeNode = d.targetId ? index.nodesById.get(d.targetId) : undefined;
  const canCode = Boolean(codeNode?.location) && Boolean(sourceUrl);
  const stop = (e: React.MouseEvent) => e.stopPropagation();
  return (
    <div style={d.greyed ? GREY_BODY : BODY}>
      <ExecPins />
      <div style={titleStyle(d.greyed ? GREY_ACCENT : BLOCK_ACCENT)}>
        {d.expandable ? (
          <span style={CHEV} onClick={(e) => { stop(e); toggleLogicExpand(id); }} title="expand its flow">▸</span>
        ) : (
          <span style={GLYPH}>ƒ</span>
        )}
        <span style={NAME} title={d.label}>{d.label}</span>
        {canCode && codeNode ? (
          <button type="button" style={CODE_BTN} title="view source" onClick={(e) => { stop(e); void showCode(codeNode); expandCode(); }}>{"</>"}</button>
        ) : null}
      </div>
      {d.provenance ? <div style={PROV} title={`${d.provenance.pkg} › ${d.provenance.module}`}>{d.provenance.pkg} › {d.provenance.module}</div> : null}
    </div>
  );
}

function ControlNode({ id, data }: NodeProps<LogicRfNode>) {
  const { toggleLogicExpand } = useBlueprintActions();
  const d = data as LogicNodeData;
  const isTry = d.logicKind === "try";
  const accent = isTry ? TRY_ACCENT : LOOP_ACCENT;
  const glyph = isTry ? "⚠" : "↻";
  if (d.isContainer) {
    return <ContainerFrame accent={accent} label={d.label} glyph={glyph} onToggle={() => toggleLogicExpand(id)} provenance={null} />;
  }
  return (
    <div style={BODY} onClick={() => toggleLogicExpand(id)}>
      <ExecPins />
      <div style={titleStyle(accent)}>
        <span style={GLYPH}>{glyph}</span>
        <span style={NAME} title={d.label}>{d.label}</span>
        <span style={COUNT}>{d.childCount} ▸</span>
      </div>
    </div>
  );
}

function BranchNode({ data }: NodeProps<LogicRfNode>) {
  const d = data as LogicNodeData;
  return (
    <div style={BRANCH_BODY}>
      <Handle type="target" position={Position.Left} style={PIN} isConnectable={false} />
      <Handle type="source" position={Position.Right} style={PIN} isConnectable={false} />
      <div style={titleStyle(BRANCH_ACCENT)}>
        <span style={GLYPH}>◈</span>
        <span style={NAME} title={d.label}>{d.label}</span>
      </div>
    </div>
  );
}

/** A framed container (expanded call / loop / try): a title bar sits over ELK's reserved top pad;
 * child nodes render in the space below. Clicking the title collapses it. */
function ContainerFrame(props: { accent: string; label: string; glyph: string; onToggle: () => void; provenance: LogicNodeData["provenance"] }) {
  return (
    <div style={frameStyle(props.accent)}>
      <Handle type="target" position={Position.Left} style={PIN} isConnectable={false} />
      <Handle type="source" position={Position.Right} style={PIN} isConnectable={false} />
      <div style={frameTitleStyle(props.accent)} onClick={props.onToggle} title="collapse">
        <span style={GLYPH}>{props.glyph}</span>
        <span style={NAME}>{props.label}</span>
        {props.provenance ? <span style={FRAME_PROV}>{props.provenance.pkg} › {props.provenance.module}</span> : null}
        <span style={CHEV_OPEN}>▾</span>
      </div>
    </div>
  );
}

export const logicNodeTypes = { block: BlockNode, control: ControlNode, branch: BranchNode };

const BLOCK_ACCENT = "#3B7AC0";
const GREY_ACCENT = "#3A414C";
const LOOP_ACCENT = "#E6B84D";
const TRY_ACCENT = "#D98A5B";
const BRANCH_ACCENT = "#61DAFB";

const PIN: React.CSSProperties = { width: 7, height: 7, background: "#C8D3E0", border: "none", minWidth: 0, minHeight: 0 };

const BODY: React.CSSProperties = {
  width: "100%",
  height: "100%",
  boxSizing: "border-box",
  border: "1px solid #2A2F37",
  borderRadius: 8,
  background: "#10151C",
  overflow: "hidden",
  fontFamily: MONO,
};
const GREY_BODY: React.CSSProperties = { ...BODY, opacity: 0.6, background: "#0E1116" };
const BRANCH_BODY: React.CSSProperties = { ...BODY, borderColor: BRANCH_ACCENT };

function titleStyle(accent: string): React.CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "5px 8px",
    background: accent,
    color: "#0B0E13",
    fontSize: 12,
    fontWeight: 700,
  };
}

function frameStyle(accent: string): React.CSSProperties {
  return { width: "100%", height: "100%", boxSizing: "border-box", border: `1px solid ${accent}`, borderRadius: 10, background: "rgba(16,21,28,0.55)", fontFamily: MONO };
}
function frameTitleStyle(accent: string): React.CSSProperties {
  return { display: "flex", alignItems: "center", gap: 6, padding: "5px 10px", borderBottom: `1px solid ${accent}`, color: accent, fontSize: 11, fontWeight: 700, cursor: "pointer" };
}

const GLYPH: React.CSSProperties = { fontSize: 11, opacity: 0.85 };
const CHEV: React.CSSProperties = { cursor: "pointer", fontSize: 11, padding: "0 2px" };
const CHEV_OPEN: React.CSSProperties = { marginLeft: "auto", fontSize: 10 };
const NAME: React.CSSProperties = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
const PROV: React.CSSProperties = { padding: "4px 8px", fontSize: 10, color: "#7B8695", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
const FRAME_PROV: React.CSSProperties = { fontSize: 9, fontWeight: 400, color: "#7B8695", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
const COUNT: React.CSSProperties = { marginLeft: "auto", fontSize: 10, fontWeight: 600, opacity: 0.75 };
const CODE_BTN: React.CSSProperties = { marginLeft: "auto", border: "none", background: "rgba(0,0,0,0.18)", color: "#0B0E13", borderRadius: 4, padding: "1px 5px", fontSize: 10, fontFamily: MONO, cursor: "pointer" };
