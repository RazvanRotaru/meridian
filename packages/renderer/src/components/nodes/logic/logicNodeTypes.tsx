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
import type { CodeView } from "../../../state/store";
import { CodeBlock } from "../../CodeBlock";

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
  const { toggleLogicExpand, showCode, expandCode, closeCode } = useBlueprintActions();
  const index = useBlueprint((s) => s.index);
  const sourceUrl = useBlueprint((s) => s.sourceUrl);
  const logicSelected = useBlueprint((s) => s.logicSelected);
  const codeView = useBlueprint((s) => s.codeView);
  const d = data as LogicNodeData;
  const select = selectStateFor(d.targetId, logicSelected);
  if (d.isContainer) {
    return <ContainerFrame accent={BLOCK_ACCENT} label={d.label} glyph="ƒ" onToggle={() => toggleLogicExpand(id)} provenance={d.provenance} select={select} />;
  }
  const codeNode = d.targetId ? index.nodesById.get(d.targetId) : undefined;
  const canCode = Boolean(codeNode?.location) && Boolean(sourceUrl);
  // The inline box shows only for THIS block's own target, and only while the store keeps it in
  // the compact "inline" mode (the modal takes over once expandCode flips mode → "modal").
  const showingInline = codeNode != null && codeView != null && codeView.node.id === codeNode.id && codeView.mode === "inline";
  const stop = (e: React.MouseEvent) => e.stopPropagation();
  // </> now TOGGLES the compact inline view instead of jumping straight to the modal: a second
  // click on the block that's already showing closes it; the modal is reached from the box's ⤢.
  const toggleCode = () => (showingInline ? closeCode() : void showCode(codeNode!));
  const codeButton = canCode && codeNode ? (
    <button type="button" style={CODE_BTN} title="view source" onClick={(e) => { stop(e); toggleCode(); }}>{"</>"}</button>
  ) : null;
  const inline = showingInline && codeView ? <InlineCode codeView={codeView} onExpand={expandCode} onClose={closeCode} /> : null;
  // A greyed leaf is a small chip beside the larger call nodes: the name stays priority (never
  // clipped) while provenance shrinks to just the module on one tight line, full `pkg › module`
  // in its title. Greyed leaves are never expandable, so there is no disclosure chevron here.
  if (d.greyed) {
    return (
      <div style={WRAP}>
        <div style={selectStyle(GREY_BODY, select)}>
          <ExecPins />
          <div style={GREY_TITLE}>
            <span style={GREY_GLYPH}>ƒ</span>
            <span style={NAME} title={d.label}>{d.label}</span>
            {codeButton}
          </div>
          {d.provenance ? <div style={GREY_PROV} title={`${d.provenance.pkg} › ${d.provenance.module}`}>{d.provenance.module}</div> : null}
        </div>
        {inline}
      </div>
    );
  }
  // A normal block is an expandable call (non-greyed blocks are always expandable). Expand-in-place
  // is now an explicit title-tail button beside </> (collapsed here, so ▸), not a header click —
  // a single body click selects and a double-click dives, so the old click-to-expand was ambiguous.
  // The relative WRAP (not clipped) hosts the clipped body PLUS the inline box hanging below it.
  return (
    <div style={WRAP}>
      <div style={selectStyle(BODY, select)}>
        <ExecPins />
        <div style={titleStyle(BLOCK_ACCENT)}>
          <span style={GLYPH}>ƒ</span>
          <span style={NAME} title={d.label}>{d.label}</span>
          <span style={TITLE_TAIL}>
            <ExpandButton expanded={false} onToggle={() => toggleLogicExpand(id)} />
            {codeButton}
          </span>
        </div>
        {d.provenance ? <div style={PROV} title={`${d.provenance.pkg} › ${d.provenance.module}`}>{d.provenance.pkg} › {d.provenance.module}</div> : null}
      </div>
      {inline}
    </div>
  );
}

/**
 * The compact inline source box for a logic building block: an absolutely-positioned panel hanging
 * just below the node (top:100%), a SIBLING of the clipped body so the body's overflow:hidden can't
 * cut it off. It is capped in width and the code scrolls inside CodeBlock, so it overlays neighbours
 * without changing the node's laid-out box (no relayout). Its ⤢ blows the same code up into the
 * centered modal (CodePanel); × closes it. Pointer events are swallowed so interacting with the box
 * never pans the canvas, drags the node, or triggers select/dive.
 */
function InlineCode(props: { codeView: CodeView; onExpand: () => void; onClose: () => void }) {
  const { node, code, loading, error, truncated } = props.codeView;
  const { file, startLine, endLine } = node.location;
  const range = endLine && endLine !== startLine ? `${startLine}-${endLine}` : String(startLine);
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  return (
    <div style={INLINE_BOX} onClick={stop} onDoubleClick={stop} onMouseDown={stop}>
      <div style={INLINE_HEAD}>
        <span style={INLINE_LOC} title={file}>{`${file}:${range}`}</span>
        <button type="button" style={INLINE_ICON} aria-label="Open in modal" title="Open in modal" onClick={(e) => { stop(e); props.onExpand(); }}>⤢</button>
        <button type="button" style={INLINE_ICON} aria-label="Close source" title="Close" onClick={(e) => { stop(e); props.onClose(); }}>×</button>
      </div>
      <div style={INLINE_BODY}>
        {loading ? <div style={INLINE_STATUS}>Loading…</div> : null}
        {error ? <div style={INLINE_ERROR}>{error}</div> : null}
        {code !== null ? <CodeBlock code={code} maxHeight={200} /> : null}
        {truncated ? <div style={INLINE_TRUNC}>…truncated</div> : null}
      </div>
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
  // No whole-node onClick: a single click on a container would fight both node selection and the
  // double-click-to-dive gesture. Collapse/expand is the explicit title button only (collapsed → ▸).
  return (
    <div style={selectStyle(BODY, select)}>
      <ExecPins />
      <div style={titleStyle(accent)}>
        <span style={GLYPH}>{glyph}</span>
        <span style={NAME} title={d.label}>{d.label}</span>
        <span style={COUNT}>{d.childCount}</span>
        <ExpandButton expanded={false} onToggle={() => toggleLogicExpand(id)} />
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
 * child nodes render in the space below. Collapse is the explicit ▾ button in the title tail — the
 * whole-title click was removed so it no longer fights node selection / double-click-to-dive. */
function ContainerFrame(props: { accent: string; label: string; glyph: string; onToggle: () => void; provenance: LogicNodeData["provenance"]; select: SelectState }) {
  return (
    <div style={selectStyle(frameStyle(props.accent), props.select)}>
      <Handle type="target" position={Position.Left} style={PIN} isConnectable={false} />
      <Handle type="source" position={Position.Right} style={PIN} isConnectable={false} />
      <div style={frameTitleStyle(props.accent)}>
        <span style={GLYPH}>{props.glyph}</span>
        <span style={NAME}>{props.label}</span>
        {props.provenance ? <span style={FRAME_PROV}>{props.provenance.pkg} › {props.provenance.module}</span> : null}
        <span style={TITLE_TAIL}>
          <ExpandButton expanded onToggle={props.onToggle} />
        </span>
      </div>
    </div>
  );
}

/**
 * The explicit expand/collapse toggle every EXPANDABLE node carries in its title tail, styled to sit
 * beside the </> code button. Expansion happens ONLY here now — a single body click selects and a
 * double-click dives — so it stops propagation so the node never also selects/drills/dives on it.
 * ▾ when expanded, ▸ when collapsed.
 */
function ExpandButton(props: { expanded: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      style={EXPAND_BTN}
      title={props.expanded ? "collapse" : "expand in place"}
      aria-expanded={props.expanded}
      onClick={(e) => {
        e.stopPropagation();
        props.onToggle();
      }}
    >
      {props.expanded ? "▾" : "▸"}
    </button>
  );
}

/**
 * A "jump-to-flow" satellite: a small dashed, muted ghost node the VIEW appends in a row ABOVE the
 * selected building block for every OTHER logic flow that also CALLS its target. It is the SOURCE of
 * the jump wire (a source Handle on the BOTTOM, no target pin): the wire runs from here DOWN INTO the
 * selected block below — those flows contain this block, so the arrow points at it. Clicking it
 * switches the canvas to that flow. Its data is minimal — a flow-root id, a display label, a faint file path.
 */
export type JumpFlowNodeData = { rootId: string; label: string; file?: string };
type JumpFlowRfNode = Node<JumpFlowNodeData>;

function JumpFlowNode({ data }: NodeProps<JumpFlowRfNode>) {
  const { openLogicFlow } = useBlueprintActions();
  const d = data as JumpFlowNodeData;
  return (
    <div style={JUMP_BODY} onClick={() => openLogicFlow(d.rootId)} title={`Open flow: ${d.label}`}>
      <Handle type="source" position={Position.Bottom} style={PIN} isConnectable={false} />
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

// The block's outer shell: fills the node box and is NOT clipped, so the inline code box (an
// absolute child at top:100%) can hang below the body's overflow:hidden without being cut off.
const WRAP: React.CSSProperties = { position: "relative", width: "100%", height: "100%", fontFamily: MONO };

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
  return { display: "flex", alignItems: "center", gap: 6, padding: "5px 10px", borderBottom: `1px solid ${accent}`, color: accent, fontSize: 11, fontWeight: 700 };
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
// Right-aligned title tail holding the expand toggle (and, on a call block, the </> button). A
// content-sized flex box pushed right by its own auto margin, so its buttons sit snug together.
const TITLE_TAIL: React.CSSProperties = { marginLeft: "auto", display: "flex", alignItems: "center", gap: 6 };
// The expand/collapse toggle, matched to CODE_BTN so the two title buttons read as a pair.
// `color: inherit` keeps it dark on a solid accent title (like </>) and accent-coloured on a
// container frame's dark title, where the </> button never appears.
const EXPAND_BTN: React.CSSProperties = { border: "none", background: "rgba(0,0,0,0.18)", color: "inherit", borderRadius: 4, padding: "1px 6px", fontSize: 10, lineHeight: 1, fontFamily: MONO, cursor: "pointer" };
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

// The inline source box: hangs below the node (top:100%), high z-index so it overlays neighbours,
// left-aligned to the node. overflow:hidden keeps the rounded corners; the code scrolls in CodeBlock.
const INLINE_BOX: React.CSSProperties = {
  position: "absolute",
  top: "100%",
  left: 0,
  marginTop: 6,
  width: 460,
  maxWidth: "60vw",
  zIndex: 20,
  background: "#0E1116",
  border: "1px solid #2A2F37",
  borderRadius: 8,
  boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
  overflow: "hidden",
  cursor: "default",
};
const INLINE_HEAD: React.CSSProperties = { display: "flex", alignItems: "center", gap: 6, padding: "5px 8px", background: "#161B22", borderBottom: "1px solid #2A2F37" };
const INLINE_LOC: React.CSSProperties = { flex: 1, minWidth: 0, fontSize: 10, color: "#7B8695", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
const INLINE_ICON: React.CSSProperties = { flexShrink: 0, background: "#1A1F27", color: "#9AA4B2", border: "1px solid #2A2F37", borderRadius: 5, width: 20, height: 20, fontSize: 12, lineHeight: 1, cursor: "pointer" };
const INLINE_BODY: React.CSSProperties = { padding: 8 };
const INLINE_STATUS: React.CSSProperties = { fontSize: 11, color: "#7B8695" };
const INLINE_ERROR: React.CSSProperties = { fontSize: 11, color: "#f2777a" };
const INLINE_TRUNC: React.CSSProperties = { marginTop: 6, fontSize: 10, color: "#7B8695" };
