/**
 * Logic-graph node components, styled after Unreal Blueprints: dark bodies with a coloured title
 * bar and left/right exec pins (the white sequence wires connect through them). A "building block"
 * is a function-call node — provenance (package › module) rides under the title so a block is never
 * a bare name; expandable ones carry a disclosure and expand INTO a container frame; greyed leaves
 * shrink to small chips (name stays priority, provenance compacts to just the module). `for`/`while`
 * /`try` render as framed containers; `if`/`switch` render as a violet hexagon DECISION node —
 * a shape that reads as control-flow at a glance — whose then/else/case wires leave labeled.
 */

import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
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
  const logicSelected = useBlueprint((s) => s.logicSelected);
  const d = data as LogicNodeData;
  const select = selectStateFor(d.targetId, logicSelected);
  if (d.isContainer) {
    return <ContainerFrame accent={BLOCK_ACCENT} label={d.label} glyph="ƒ" onToggle={() => toggleLogicExpand(id)} provenance={d.provenance} select={select} />;
  }
  const codeNode = d.targetId ? index.nodesById.get(d.targetId) : undefined;
  const canCode = Boolean(codeNode?.location) && Boolean(sourceUrl);
  const stop = (e: React.MouseEvent) => e.stopPropagation();
  const codeButton = canCode && codeNode ? (
    <button type="button" style={CODE_BTN} title="view source" onClick={(e) => { stop(e); void showCode(codeNode); expandCode(); }}>{"</>"}</button>
  ) : null;
  // A greyed leaf is a small chip beside the larger call nodes: the name stays priority (never
  // clipped) while provenance shrinks to just the module on one tight line, full `pkg › module`
  // in its title. Greyed leaves are never expandable, so there is no disclosure chevron here.
  if (d.greyed) {
    return (
      <div style={selectStyle(GREY_BODY, select)}>
        <ExecPins />
        <div style={GREY_TITLE}>
          <span style={GREY_GLYPH}>ƒ</span>
          <span style={NAME} title={d.label}>{d.label}</span>
          {codeButton}
        </div>
        {d.provenance ? <div style={GREY_PROV} title={`${d.provenance.pkg} › ${d.provenance.module}`}>{d.provenance.module}</div> : null}
      </div>
    );
  }
  // A normal block is an expandable call (non-greyed blocks are always expandable): the chevron
  // opens its flow, and the full provenance line stays visible under the title.
  return (
    <div style={selectStyle(BODY, select)}>
      <ExecPins />
      <div style={titleStyle(BLOCK_ACCENT)}>
        <span style={CHEV} onClick={(e) => { stop(e); toggleLogicExpand(id); }} title="expand its flow">▸</span>
        <span style={NAME} title={d.label}>{d.label}</span>
        {codeButton}
      </div>
      {d.provenance ? <div style={PROV} title={`${d.provenance.pkg} › ${d.provenance.module}`}>{d.provenance.pkg} › {d.provenance.module}</div> : null}
    </div>
  );
}

function ControlNode({ id, data }: NodeProps<LogicRfNode>) {
  const { toggleLogicExpand } = useBlueprintActions();
  const logicSelected = useBlueprint((s) => s.logicSelected);
  const d = data as LogicNodeData;
  const select = selectStateFor(d.targetId, logicSelected);
  const isTry = d.logicKind === "try";
  const accent = isTry ? TRY_ACCENT : LOOP_ACCENT;
  const glyph = isTry ? "⚠" : "↻";
  if (d.isContainer) {
    return <ContainerFrame accent={accent} label={d.label} glyph={glyph} onToggle={() => toggleLogicExpand(id)} provenance={null} select={select} />;
  }
  return (
    <div style={selectStyle(BODY, select)} onClick={() => toggleLogicExpand(id)}>
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
  const logicSelected = useBlueprint((s) => s.logicSelected);
  const d = data as LogicNodeData;
  const select = selectStateFor(d.targetId, logicSelected);
  // switch fans out to many cases; if is binary — different glyphs signal which decision at a glance.
  const glyph = d.logicKind === "switch" ? "⋔" : "◆";
  return (
    <div style={selectStyle(BRANCH_WRAP, select)}>
      {/* Handles live OUTSIDE the clipped shape so the exec pins aren't clipped away; they still
          anchor at the wrapper's left/right centre — the hexagon's exec points. */}
      <Handle type="target" position={Position.Left} style={PIN} isConnectable={false} />
      <Handle type="source" position={Position.Right} style={PIN} isConnectable={false} />
      <div style={BRANCH_SHAPE}>
        <span style={BRANCH_GLYPH}>{glyph}</span>
        <span style={NAME} title={d.label}>{d.label}</span>
      </div>
    </div>
  );
}

/** A framed container (expanded call / loop / try): a title bar sits over ELK's reserved top pad;
 * child nodes render in the space below. Clicking the title collapses it. */
function ContainerFrame(props: { accent: string; label: string; glyph: string; onToggle: () => void; provenance: LogicNodeData["provenance"]; select: SelectState }) {
  return (
    <div style={selectStyle(frameStyle(props.accent), props.select)}>
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

/**
 * A "jump-to-flow" satellite: a small dashed, muted ghost node the VIEW appends beside the selected
 * building block for every OTHER logic flow that also calls its target. It only receives an exec
 * wire (a target Handle on the LEFT, no source pin) and, when clicked, switches the canvas to that
 * flow. Its data is minimal by design — a flow-root id, a display label, and a faint file path.
 */
export type JumpFlowNodeData = { rootId: string; label: string; file?: string };
type JumpFlowRfNode = Node<JumpFlowNodeData>;

function JumpFlowNode({ data }: NodeProps<JumpFlowRfNode>) {
  const { openLogicFlow } = useBlueprintActions();
  const d = data as JumpFlowNodeData;
  return (
    <div style={JUMP_BODY} onClick={() => openLogicFlow(d.rootId)} title={`Open flow: ${d.label}`}>
      <Handle type="target" position={Position.Left} style={PIN} isConnectable={false} />
      <div style={JUMP_HEAD}>
        <span style={JUMP_GLYPH}>↗</span>
        <span style={NAME} title={d.label}>{d.label}</span>
      </div>
      {d.file ? <div style={JUMP_FILE} title={d.file}>{d.file}</div> : null}
    </div>
  );
}

export const logicNodeTypes = { block: BlockNode, control: ControlNode, branch: BranchNode, jumpflow: JumpFlowNode };

// Selection is BY TARGET (a target can be called many times): a matched call site rings green so
// every call of the same target lights up together; while some target is selected, unrelated nodes
// dim so the matches pop. Structural nodes (loops/branches) carry no target, so they only ever dim.
type SelectState = "selected" | "dimmed" | "none";
const SELECT_ACCENT = "#6BE38A";

function selectStateFor(targetId: string | null, logicSelected: string | null): SelectState {
  if (logicSelected === null) {
    return "none";
  }
  return targetId !== null && targetId === logicSelected ? "selected" : "dimmed";
}

// Layer the selection state over a node's base style: a bright ring at full opacity when matched
// (so it pops even over a greyed leaf's fade), a dim veil when some other target holds the selection.
function selectStyle(base: React.CSSProperties, select: SelectState): React.CSSProperties {
  if (select === "selected") {
    return { ...base, opacity: 1, borderColor: SELECT_ACCENT, boxShadow: `0 0 0 2px ${SELECT_ACCENT}` };
  }
  if (select === "dimmed") {
    return { ...base, opacity: 0.5 };
  }
  return base;
}

const BLOCK_ACCENT = "#3B7AC0";
const GREY_ACCENT = "#3A414C";
const LOOP_ACCENT = "#E6B84D";
const TRY_ACCENT = "#D98A5B";
// Violet, deliberately unlike the blue building-block accent: a branch reads as control-flow.
const BRANCH_ACCENT = "#A78BFA";

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

// A branch renders as a violet hexagon (points on the exec axis) so it never reads as a rectangular
// building block. The wrapper hosts the exec pins and any selection dim; the shape does the clipping.
const BRANCH_WRAP: React.CSSProperties = { position: "relative", width: "100%", height: "100%", fontFamily: MONO };
// clip-path can't paint a border or box-shadow, but branch nodes never enter the "selected" state
// (their targetId is null), so only the opacity dim applies — and opacity survives the clip.
const BRANCH_SHAPE: React.CSSProperties = {
  width: "100%",
  height: "100%",
  boxSizing: "border-box",
  clipPath: "polygon(14% 0, 86% 0, 100% 50%, 86% 100%, 14% 100%, 0 50%)",
  background: BRANCH_ACCENT,
  color: "#0B0E13",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 6,
  padding: "0 26px", // clear the slanted points so the centred label isn't clipped
  fontSize: 12,
  fontWeight: 700,
};
const BRANCH_GLYPH: React.CSSProperties = { fontSize: 13, flexShrink: 0 };

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

// The satellite "ghost" look: dashed border, muted fill/text — it reads as a detached shortcut, not
// a step in this flow. Full opacity (it's never dimmed by the selection) so it stays clickable.
const JUMP_BODY: React.CSSProperties = {
  width: "100%",
  height: "100%",
  boxSizing: "border-box",
  border: "1px dashed #4B535F",
  borderRadius: 8,
  background: "rgba(16,21,28,0.6)",
  padding: "5px 9px",
  fontFamily: MONO,
  color: "#9AA4B2",
  cursor: "pointer",
  display: "flex",
  flexDirection: "column",
  gap: 2,
  overflow: "hidden",
};
const JUMP_HEAD: React.CSSProperties = { display: "flex", alignItems: "center", gap: 5, fontSize: 11, fontWeight: 600 };
const JUMP_GLYPH: React.CSSProperties = { fontSize: 10, opacity: 0.8, color: "#7B8695" };
const JUMP_FILE: React.CSSProperties = { fontSize: 9, color: "#6C7683", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };

const GLYPH: React.CSSProperties = { fontSize: 11, opacity: 0.85 };
const CHEV: React.CSSProperties = { cursor: "pointer", fontSize: 11, padding: "0 2px" };
const CHEV_OPEN: React.CSSProperties = { marginLeft: "auto", fontSize: 10 };
const NAME: React.CSSProperties = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
const PROV: React.CSSProperties = { padding: "4px 8px", fontSize: 10, color: "#7B8695", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
// The greyed chip is tight: a compact title (light text on the muted slate so the priority name
// stays legible) over one small provenance line. Padding/fonts shrink to fit the ~30px chip.
const GREY_TITLE: React.CSSProperties = { display: "flex", alignItems: "center", gap: 4, padding: "2px 6px", background: GREY_ACCENT, color: "#C8D3E0", fontSize: 10, fontWeight: 700, lineHeight: 1.2 };
const GREY_GLYPH: React.CSSProperties = { fontSize: 9, opacity: 0.7, flexShrink: 0 };
const GREY_PROV: React.CSSProperties = { padding: "0 6px 2px", fontSize: 9, lineHeight: 1, color: "#7B8695", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
const FRAME_PROV: React.CSSProperties = { fontSize: 9, fontWeight: 400, color: "#7B8695", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
const COUNT: React.CSSProperties = { marginLeft: "auto", fontSize: 10, fontWeight: 600, opacity: 0.75 };
const CODE_BTN: React.CSSProperties = { marginLeft: "auto", border: "none", background: "rgba(0,0,0,0.18)", color: "#0B0E13", borderRadius: 4, padding: "1px 5px", fontSize: 10, fontFamily: MONO, cursor: "pointer" };
