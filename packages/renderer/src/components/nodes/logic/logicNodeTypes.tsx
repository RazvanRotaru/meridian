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
import type { DefGroupData, LogicRfNode } from "../../../layout/logicElk";
import type { LogicNodeData, TerminalData } from "../../../derive/logicGraph";
import { CodeInlinePanel } from "../../CodeInlinePanel";

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
  // A method call (one made through a receiver / a class method) reads apart from a free function at a
  // glance: a distinct glyph, and a small indigo shift off the blue call accent. A "defined here" node
  // keeps its teal DECLARATION accent regardless (its declaration-ness dominates), gaining only the
  // glyph — so defs stay visually consistent with their existing treatment.
  const glyph = d.callKind === "method" ? METHOD_GLYPH : "ƒ";
  const accent = d.definition ? DEF_ACCENT : d.callKind === "method" ? METHOD_ACCENT : BLOCK_ACCENT;
  if (d.isContainer) {
    return <ContainerFrame accent={accent} label={d.label} glyph={glyph} onToggle={() => toggleLogicExpand(id)} provenance={d.provenance} select={select} />;
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
  const inline = showingInline && codeView ? <CodeInlinePanel codeView={codeView} onExpand={expandCode} onClose={closeCode} /> : null;
  // A greyed leaf is a small chip beside the larger call nodes: the name stays priority (never
  // clipped) while provenance shrinks to just the module on one tight line, full `pkg › module`
  // in its title. Greyed leaves are never expandable, so there is no disclosure chevron here.
  if (d.greyed) {
    return (
      <div style={WRAP}>
        <div style={selectStyle(GREY_BODY, select)}>
          <ExecPins />
          <div style={GREY_TITLE}>
            <span style={GREY_GLYPH}>{glyph}</span>
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
        <div style={titleStyle(accent)}>
          <span style={GLYPH}>{glyph}</span>
          <span style={NAME} title={d.label}>{d.label}</span>
          <span style={TITLE_TAIL}>
            {d.definition ? <span style={DEF_TAG}>def</span> : null}
            {/* Gate on `expandable`: a call block is always expandable here, but a defined callable
                with no flow of its own is not — so it drops the disclosure rather than dangling a
                dead ▸. (Existing non-definition blocks are unaffected: non-greyed ⇒ expandable.)
                Definition nodes also omit it: they're a grid appended after layout, so expand-in-place
                never re-nests them — double-click to drill is their gesture instead. */}
            {d.expandable && !d.definition ? <ExpandButton expanded={false} onToggle={() => toggleLogicExpand(id)} /> : null}
            {codeButton}
          </span>
        </div>
        {d.provenance ? <div style={PROV} title={`${d.provenance.pkg} › ${d.provenance.module}`}>{d.provenance.pkg} › {d.provenance.module}</div> : null}
      </div>
      {inline}
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
      {/* Compact by design: a hard-clipped condition caption keeps the decision node small; the FULL
          condition rides in the hover title so nothing is lost. */}
      <div style={BRANCH_SHAPE} title={d.label}>
        <span style={BRANCH_GLYPH}>{glyph}</span>
        <span style={NAME}>{compactCondition(d.label)}</span>
      </div>
    </div>
  );
}

/**
 * A compact decision caption for the Branch node. The glyph already signals if vs switch, so DROP the
 * leading keyword and clip the condition HARD — this node must stay small and glanceable, never a wide
 * box; the full text lives in the node's hover title. ~14 chars fits the near-fixed footprint.
 */
function compactCondition(label: string): string {
  const condition = label.replace(/^(if|switch)\b\s*/, "").trim();
  const text = condition || label;
  return text.length > 14 ? `${text.slice(0, 14).trimEnd()}…` : text;
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
 * selected building block for every flow that (transitively) reaches its target. It sits in the
 * caller CHAIN, so it is BOTH ends of a jump wire: a source Handle on the BOTTOM (the wire runs DOWN
 * into the node one hop closer to the selection — a deeper ghost, or the selected block itself) AND
 * a target Handle on the TOP (a deeper caller's wire lands here), so the chain reads top→down.
 * Clicking it switches the canvas to that flow. Its data is minimal — a flow-root id, a display
 * label, a faint file path, and how many hops away it is (`depth`): 1 == direct, higher == indirect.
 */
export type JumpFlowNodeData = { rootId: string; label: string; file?: string; depth: number };
type JumpFlowRfNode = Node<JumpFlowNodeData>;

function JumpFlowNode({ data }: NodeProps<JumpFlowRfNode>) {
  const { openLogicFlow } = useBlueprintActions();
  const d = data as JumpFlowNodeData;
  return (
    <div style={JUMP_BODY} onClick={() => openLogicFlow(d.rootId)} title={`Open flow: ${d.label}`}>
      {/* Target pin on top (a deeper caller's wire lands here) + source pin on the bottom (this
          node's wire drops to the node one hop closer to the selection): the chain wires top→down. */}
      <Handle type="target" position={Position.Top} style={PIN} isConnectable={false} />
      <Handle type="source" position={Position.Bottom} style={PIN} isConnectable={false} />
      <div style={JUMP_HEAD}>
        <span style={JUMP_GLYPH}>↗</span>
        <span style={NAME} title={d.label}>{d.label}</span>
        {/* An indirect caller (2+ hops back over the reverse call graph) wears a hop badge so it
            reads apart from a direct caller; a direct caller (depth 1) needs none. */}
        {d.depth > 1 ? <span style={JUMP_DEPTH_BADGE} title={`${d.depth} hops away`}>{`↑${d.depth}`}</span> : null}
      </div>
      {d.file ? <div style={JUMP_FILE} title={d.file}>{d.file}</div> : null}
    </div>
  );
}

/**
 * A flow END-CAP: the ENTRY the observed callable starts at, or the synthetic EXIT every trailing
 * path converges onto. Both are compact pills, not call blocks (no provenance/disclosure/code). The
 * ENTRY wears the callable's name and a top TARGET pin so the view's caller-ghosts wire DOWN into it
 * (mirroring how a selected block collects its jump-to-flow ghosts), plus a right SOURCE pin the exec
 * thread leaves through into the first step. The EXIT is a dead end: a left TARGET pin, no source.
 * Neither is a call site (`targetId: null`), so clicking one is a harmless no-op.
 */
function TerminalNode({ data }: NodeProps<LogicRfNode>) {
  const d = data as TerminalData;
  if (d.terminal === "entry") {
    return (
      <div style={ENTRY_BODY} title={`Flow entry: ${d.label}`}>
        <Handle type="target" position={Position.Top} style={PIN} isConnectable={false} />
        <Handle type="source" position={Position.Right} style={PIN} isConnectable={false} />
        <span style={TERMINAL_GLYPH}>▶</span>
        <span style={NAME} title={d.label}>{d.label}</span>
        <span style={ENTRY_TAG}>ENTRY</span>
      </div>
    );
  }
  return (
    <div style={EXIT_BODY} title="Flow exit">
      <Handle type="target" position={Position.Left} style={PIN} isConnectable={false} />
      <span style={TERMINAL_GLYPH}>■</span>
      <span style={NAME}>EXIT</span>
    </div>
  );
}

/**
 * A def-group FRAME: the structural container the module view groups a callable owner's methods
 * into — an object literal, a class, or the top-level `functions` bucket. It fills its laid-out box
 * with a titled, teal-tinted border; its body stays transparent so the def nodes React Flow parents
 * to it render OVER it. It is NOT an exec node — no exec pins, no target — so clicking it is a
 * harmless no-op (no selection/drill); only the def blocks inside it are interactive.
 */
function DefGroupNode({ data }: NodeProps<LogicRfNode>) {
  const d = data as DefGroupData;
  // The top-level functions group records kind "module": tag it FUNCTIONS. Every other group is an
  // owner (object/class), so its kind uppercases straight to the tag (OBJECT / CLASS / …).
  const tag = d.kind === "module" ? "FUNCTIONS" : d.kind.toUpperCase();
  return (
    <div style={DEFGROUP_FRAME}>
      <div style={DEFGROUP_TITLE}>
        <span style={DEFGROUP_NAME} title={d.label}>{d.label}</span>
        <span style={DEFGROUP_TAG}>{tag}</span>
        <span style={DEFGROUP_COUNT}>{d.childCount}</span>
      </div>
    </div>
  );
}

export const logicNodeTypes = { block: BlockNode, control: ControlNode, branch: BranchNode, jumpflow: JumpFlowNode, defgroup: DefGroupNode, terminal: TerminalNode };

// Selection is BY TARGET (a target can be called many times): a matched call site rings green so
// every call of the same target lights up together; while some target is selected, unrelated nodes
// dim so the matches pop. Structural nodes (loops/branches) carry no target, so they only ever dim.
type SelectState = "selected" | "dimmed" | "none";
// The accent green shared with the emphasized logic edges (imported by LogicFlowView) so the node
// ring and the edge glow can't drift.
export const SELECT_ACCENT = "#6BE38A";

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
// A small INDIGO shift off the blue call accent — same family, not a jarring new colour — so a method
// call (through a receiver / a class method) is distinguishable at a glance from a free function.
const METHOD_ACCENT = "#5E74C6";
// Evokes the `::` scope-resolution of a member call, versus the `ƒ` of a free function.
const METHOD_GLYPH = "∷";
// Teal, deliberately unlike the blue call accent: a definition node is a declaration ("defined
// here"), a different kind of thing from a call site in the flow.
const DEF_ACCENT = "#3FB8AF";
const GREY_ACCENT = "#3A414C";
const LOOP_ACCENT = "#E6B84D";
const TRY_ACCENT = "#D98A5B";
// Violet, deliberately unlike the blue building-block accent: a branch reads as control-flow.
const BRANCH_ACCENT = "#A78BFA";
// A calm green marks the flow's START (evokes a "play"/entry point); a muted slate marks the neutral
// synthetic EXIT end-cap — deliberately quiet so it reads as a terminus, not another step.
const ENTRY_ACCENT = "#4FB477";
const EXIT_ACCENT = "#8A93A0";

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
  gap: 4,
  padding: "0 16px", // clear the slanted points so the compact centred caption isn't clipped
  fontSize: 11,
  fontWeight: 700,
};
const BRANCH_GLYPH: React.CSSProperties = { fontSize: 12, flexShrink: 0 };

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
// The hop badge on an INDIRECT caller ghost: a quiet blue pill pinned at the row's right end, so a
// 2+-hops-away caller is distinguishable at a glance from a direct one (which carries no badge).
const JUMP_DEPTH_BADGE: React.CSSProperties = {
  marginLeft: "auto",
  flexShrink: 0,
  fontSize: 9,
  fontWeight: 700,
  color: "#8FB6E3",
  border: "1px solid #2A3B4D",
  borderRadius: 3,
  padding: "0 4px",
  background: "rgba(59,122,192,0.15)",
};
const JUMP_FILE: React.CSSProperties = { fontSize: 9, color: "#6C7683", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };

// The entry/exit end-caps: a compact rounded pill (never a rectangular building block), tinted by its
// accent. Shared base; the entry keeps its ENTRY tag pinned right, the exit centres its bare caption.
const TERMINAL_BASE: React.CSSProperties = {
  width: "100%",
  height: "100%",
  boxSizing: "border-box",
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "0 14px",
  borderRadius: 999,
  fontFamily: MONO,
  fontSize: 12,
  fontWeight: 700,
  overflow: "hidden",
};
const ENTRY_BODY: React.CSSProperties = { ...TERMINAL_BASE, border: `1px solid ${ENTRY_ACCENT}`, background: "rgba(79,180,119,0.12)", color: "#CDEAD9" };
const EXIT_BODY: React.CSSProperties = { ...TERMINAL_BASE, justifyContent: "center", border: `1px solid ${EXIT_ACCENT}`, background: "rgba(138,147,160,0.10)", color: "#B7C0CC" };
const TERMINAL_GLYPH: React.CSSProperties = { fontSize: 10, flexShrink: 0, opacity: 0.85 };
const ENTRY_TAG: React.CSSProperties = { marginLeft: "auto", flexShrink: 0, fontSize: 8, fontWeight: 700, letterSpacing: "0.08em", border: `1px solid ${ENTRY_ACCENT}`, borderRadius: 3, padding: "1px 4px", color: ENTRY_ACCENT };

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
// The little "def" pill on a definition node's title: dark on the teal accent, so it reads as a
// quiet kind-tag ("defined here") without competing with the callable name beside it.
const DEF_TAG: React.CSSProperties = { flexShrink: 0, fontSize: 8, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", border: "1px solid rgba(0,0,0,0.35)", borderRadius: 3, padding: "0 3px", opacity: 0.75 };
const CODE_BTN: React.CSSProperties = { marginLeft: "auto", border: "none", background: "rgba(0,0,0,0.18)", color: "#0B0E13", borderRadius: 4, padding: "1px 5px", fontSize: 10, fontFamily: MONO, cursor: "pointer" };

// The def-group frame reuses the def teal (#3FB8AF) but SUBTLER — a faint tinted border/fill that
// reads as a structural group, not a call block. It fills its exact laid-out box (border-box); the
// title bar height matches the layout's TITLE_H, and the body is left transparent for the child def
// nodes to render over. A 32px title matches deriveLogicLayout's TITLE_H so children clear it.
const DEFGROUP_FRAME: React.CSSProperties = {
  width: "100%",
  height: "100%",
  boxSizing: "border-box",
  border: "1px solid rgba(63,184,175,0.4)",
  borderRadius: 10,
  background: "rgba(63,184,175,0.05)",
  fontFamily: MONO,
};
const DEFGROUP_TITLE: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  height: 32,
  boxSizing: "border-box",
  padding: "0 12px",
  borderBottom: "1px solid rgba(63,184,175,0.25)",
  color: "#7FD6CF",
  fontSize: 12,
  fontWeight: 700,
};
// The owner name takes the row and truncates; the kind tag and count stay pinned at the right.
const DEFGROUP_NAME: React.CSSProperties = { ...NAME, flex: 1, minWidth: 0 };
const DEFGROUP_TAG: React.CSSProperties = { flexShrink: 0, fontSize: 8, fontWeight: 700, letterSpacing: "0.06em", border: "1px solid rgba(63,184,175,0.4)", borderRadius: 3, padding: "1px 4px", color: "#3FB8AF" };
const DEFGROUP_COUNT: React.CSSProperties = { flexShrink: 0, fontSize: 10, fontWeight: 600, color: "#6C7683" };
