/**
 * Logic-graph node components, styled after Unreal Blueprints: dark bodies with a coloured title
 * bar and left/right exec pins (the white sequence wires connect through them). A "building block"
 * is a function-call node — provenance (package › module) rides under the title so a block is never
 * a bare name; expandable ones carry a disclosure and expand INTO a container frame; greyed leaves
 * shrink to small chips (name stays priority, provenance compacts to just the module). `for`/`while`
 * /`try` render as framed containers; `if`/`switch` render as a blue outline diamond DECISION node —
 * the classic flowchart shape that reads as control-flow at a glance. The diamond always shows a bare
 * "X"; double-clicking it (or its ▸ button) reveals the full condition in an inline panel. Its
 * then/else/case wires leave labeled.
 */

import { useState } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { useBlueprint, useBlueprintActions } from "../../../state/StoreContext";
import type { DefGroupData, LogicRfNode } from "../../../layout/logicElk";
import type { LogicNodeData, TerminalData } from "../../../derive/logicGraph";
import { FLOW_COLORS } from "../../../derive/flowViewModel";
import { isSourceBackedNode } from "../../../derive/sourceBackedNode";
import { coverageAccent, coverageVerdict, COVERAGE_COLORS, type CoverageVerdict } from "../../../theme/coverageColors";
import { CodeInlinePanel } from "../../CodeInlinePanel";
import { CHANGED_ACCENT, changedColor } from "../../ChangedBadge";

const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

/** The "Δ" tag was removed — the status ring (via withChanged) carries the "touched" signal on its
 * own. No-op stub so the call sites (which pass a colour) need no edit and it's easy to reinstate. */
function ChangedTag(_props: { color: string }): null {
  return null;
}

// Layer a status-coloured diff ring over a node's base style, unless selection already owns the ring.
function withChanged(base: React.CSSProperties, ring: string | null, select: SelectState): React.CSSProperties {
  if (!ring || select === "selected") {
    return base;
  }
  return { ...base, borderColor: ring, boxShadow: `0 0 0 1px ${ring}66` };
}

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
  const coverage = useBlueprint((s) => (s.coverageMode ? s.coverage : null));
  const d = data as LogicNodeData;
  const select = selectStateFor(d.targetId, logicSelected);
  const changedStatus = d.targetId ? index.changedStatus.get(d.targetId) : undefined;
  const changed = changedStatus !== undefined;
  const changedRing = changedColor(changedStatus);
  // A method call (one made through a receiver / a class method) reads apart from a free function at a
  // glance: a distinct glyph, and a small indigo shift off the blue call accent. A "defined here" node
  // keeps its teal DECLARATION accent regardless (its declaration-ness dominates), gaining only the
  // glyph — so defs stay visually consistent with their existing treatment.
  const glyph = d.callKind === "method" ? METHOD_GLYPH : "ƒ";
  // In coverage mode the title bar recolors by the CALLEE's coverage verdict (green/amber/red), so the
  // exec flow doubles as a coverage map; otherwise it keeps the call/method/def accent.
  const covAccent = coverage && d.targetId ? coverageAccent(d.targetId, coverage) : null;
  const accent = covAccent ?? (d.definition ? DEF_ACCENT : d.callKind === "method" ? METHOD_ACCENT : BLOCK_ACCENT);
  // The explicit per-node coverage signal: a dark-tracked "battery" that reads on ANY title colour
  // (a coverage-tinted title would swallow a coverage-tinted badge). Only for measured callees.
  const covVerdict = coverage && d.targetId ? coverageVerdict(d.targetId, coverage) : null;
  const battery = covVerdict === "covered" || covVerdict === "indirect" || covVerdict === "uncovered"
    ? <CoverageBattery verdict={covVerdict} />
    : null;
  if (d.isContainer) {
    return <ContainerFrame accent={accent} label={d.label} glyph={glyph} onToggle={() => toggleLogicExpand(id)} provenance={d.provenance} select={select} badge={battery} changedRing={changed ? changedRing : null} />;
  }
  const codeNode = d.targetId ? index.nodesById.get(d.targetId) : undefined;
  const canCode = isSourceBackedNode(codeNode) && Boolean(sourceUrl);
  // The inline box shows only for THIS block's own target, and only while the store keeps it in
  // the compact "inline" mode (the modal takes over once expandCode flips mode → "modal").
  const showingInline = codeNode != null && codeView != null && codeView.node.id === codeNode.id && codeView.mode === "inline";
  const stop = (e: React.MouseEvent) => e.stopPropagation();
  // </> now TOGGLES the compact inline view instead of jumping straight to the modal: a second
  // click on the block that's already showing closes it; the modal is reached from the box's ⤢.
  // Open the source straight in the big centered modal (the readable diff surface, scrolled to the
  // first change) instead of a cramped inline box that clips wide lines and buries the diff.
  const toggleCode = () => {
    void showCode(codeNode!);
    expandCode();
  };
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
        <div style={withChanged(selectStyle(GREY_BODY, select), changed ? changedRing : null, select)}>
          <ExecPins />
          <div style={GREY_TITLE}>
            <span style={GREY_GLYPH}>{glyph}</span>
            <span style={NAME} title={d.label}>{d.label}</span>
            <AsyncBadge d={d} />
            {battery}
            {changed ? <ChangedTag color={changedRing} /> : null}
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
      <div style={withChanged(selectStyle(BODY, select), changed ? changedRing : null, select)}>
        <ExecPins />
        <div style={titleStyle(accent)}>
          <span style={GLYPH}>{glyph}</span>
          <span style={NAME} title={d.label}>{d.label}</span>
          <span style={TITLE_TAIL}>
            <AsyncBadge d={d} />
            {battery}
            {changed ? <ChangedTag color={changedRing} /> : null}
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
        {/* A FRAMED block sits inside its service frame, whose title already names the owner — so it
            drops the provenance line and shows just name + signature. A standalone/external call (or a
            definition grid cell) keeps its `pkg › module` provenance. */}
        {!d.framed && d.provenance ? <div style={PROV} title={`${d.provenance.pkg} › ${d.provenance.module}`}>{d.provenance.pkg} › {d.provenance.module}</div> : null}
        {/* The signature — WHAT the block calls. Definition grid cells are a fixed compact size, so
            they opt out; only in-flow call blocks carry it. */}
        {!d.definition && d.signature ? <div style={SIGNATURE} title={d.signature}>{d.signature}</div> : null}
      </div>
      {inline}
    </div>
  );
}

/**
 * A SERVICE FRAME: the logic-flow analog of a composition scorecard. Consecutive calls into the same
 * owning unit nest inside it, so the flat exec chain reads UML-like (containers, like the composition
 * view). Its title shows the unit — a health dot + kind glyph + name (+ smell marker) + a count of the
 * calls it frames — health-tinted so the frame's health reads at a glance; DOUBLE-clicking the frame
 * opens that unit in the Service-composition view (handled by the view, so single click never
 * navigates). It carries NO exec pins: the white wires thread between the child blocks across frames,
 * never through the frame itself. The body stays transparent for ELK-placed children.
 */
function ServiceGroupNode({ data }: NodeProps<LogicRfNode>) {
  const d = data as LogicNodeData;
  const owner = d.owner;
  if (!owner) {
    return null; // a service frame is only ever emitted WITH an owner; defensive against a bad spec.
  }
  return (
    <div style={serviceFrameStyle(owner.health)}>
      <div style={{ ...SERVICE_RAIL, background: owner.health }} />
      <div style={SERVICE_TITLE} title="Double-click to open in Service composition">
        <span style={{ ...SERVICE_DOT, background: owner.health }} />
        <span style={NAME} title={owner.label}>{owner.label}</span>
        {/* The textual kind label is the one kind marker — the ◆/◇/❑ glyph vocabulary is retired. */}
        <span style={SERVICE_KIND}>{owner.kind.toUpperCase()}</span>
        {owner.smelly ? <span style={SERVICE_SMELL} title="carries a design smell">⚠</span> : null}
        <span style={SERVICE_COUNT}>{d.childCount}</span>
      </div>
    </div>
  );
}

function ControlNode({ id, data }: NodeProps<LogicRfNode>) {
  const { toggleLogicExpand } = useBlueprintActions();
  const logicSelected = useBlueprint((s) => s.logicSelected);
  const d = data as LogicNodeData;
  const select = selectStateFor(d.targetId, logicSelected);
  const accent = CONTROL_ACCENT[d.logicKind] ?? LOOP_ACCENT;
  const glyph = CONTROL_GLYPH[d.logicKind] ?? "↻";
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
  // The diamond is a fixed marker: its content is always a single "X", so the flow stays glanceable
  // and every decision reads the same until asked. The condition is revealed on demand.
  const [open, setOpen] = useState(false);
  const toggle = () => setOpen((v) => !v);
  return (
    <div style={selectStyle(BRANCH_WRAP, select)}>
      {/* Handles live OUTSIDE the diamond so the exec pins aren't clipped; they anchor at the
          wrapper's left/right centre — the diamond's exec points. */}
      <Handle type="target" position={Position.Left} style={PIN} isConnectable={false} />
      <Handle type="source" position={Position.Right} style={PIN} isConnectable={false} />
      {/* Double-click the shape (or the ▸ button below) drops the full condition into an inline panel
          — no relayout, the diamond stays small. The condition also rides in the hover title. */}
      <div style={BRANCH_SHAPE} title={d.label} onDoubleClick={(e) => { e.stopPropagation(); toggle(); }}>
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={BRANCH_SVG} aria-hidden="true">
          <polygon points="50,1 99,50 50,99 1,50" fill={BRANCH_FILL} stroke={BRANCH_ACCENT} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
        </svg>
        <span style={BRANCH_LABEL}>X</span>
      </div>
      <div style={BRANCH_DROPDOWN}>
        <ExpandButton expanded={open} onToggle={toggle} />
        {open ? <div style={BRANCH_CONDITION}>{conditionText(d.label)}</div> : null}
      </div>
    </div>
  );
}

/**
 * The full decision condition for the Branch node's inline panel: the leading `if`/`switch` keyword is
 * dropped (the diamond shape already says "decision"), leaving just the condition expression. NOT
 * truncated — the panel exists precisely to show the whole thing.
 */
function conditionText(label: string): string {
  return label.replace(/^(if|switch)\b\s*/, "").trim() || label;
}

/** A framed container (expanded call / loop / try): a title bar sits over ELK's reserved top pad;
 * child nodes render in the space below. Collapse is the explicit ▾ button in the title tail — the
 * whole-title click was removed so it no longer fights node selection / double-click-to-dive. */
function ContainerFrame(props: { accent: string; label: string; glyph: string; onToggle: () => void; provenance: LogicNodeData["provenance"]; select: SelectState; badge?: React.ReactNode; changedRing?: string | null }) {
  return (
    <div style={withChanged(selectStyle(frameStyle(props.accent), props.select), props.changedRing ?? null, props.select)}>
      <Handle type="target" position={Position.Left} style={PIN} isConnectable={false} />
      <Handle type="source" position={Position.Right} style={PIN} isConnectable={false} />
      <div style={frameTitleStyle(props.accent)}>
        <span style={GLYPH}>{props.glyph}</span>
        <span style={NAME}>{props.label}</span>
        {props.provenance ? <span style={FRAME_PROV}>{props.provenance.pkg} › {props.provenance.module}</span> : null}
        <span style={TITLE_TAIL}>
          {props.badge}
          {props.changedRing ? <ChangedTag color={props.changedRing} /> : null}
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
/**
 * The per-node coverage "battery": a dark-tracked mini progress bar (with a battery nub) whose fill
 * and colour show how well the callee is covered — full green when a test hits it directly, ~60%
 * amber when tests only reach it through other code, near-empty red when nothing tests it. The dark
 * track keeps it legible on ANY title colour (a coverage-tinted badge on a coverage-tinted bar
 * vanished); the verdict rides the hover title and aria-label so it's not colour-only.
 */
const BATTERY_FILL_FRACTION: Record<CoverageVerdict, number> = { covered: 1, indirect: 0.6, uncovered: 0.12, test: 0, none: 0 };
const BATTERY_TITLE: Record<CoverageVerdict, string> = {
  covered: "Tested directly",
  indirect: "Reached by tests (via other code)",
  uncovered: "Untested",
  test: "Test code",
  none: "Not measured",
};
function CoverageBattery({ verdict }: { verdict: CoverageVerdict }) {
  const color = COVERAGE_COLORS[verdict];
  return (
    <span style={BATTERY_WRAP} title={BATTERY_TITLE[verdict]} aria-label={`Coverage: ${BATTERY_TITLE[verdict]}`}>
      <span style={BATTERY_TRACK}>
        <span style={{ ...BATTERY_FILL, width: `${BATTERY_FILL_FRACTION[verdict] * 100}%`, background: color }} />
      </span>
      <span style={{ ...BATTERY_NUB, background: color }} />
    </span>
  );
}

/**
 * The async-semantics badge a call block wears: ⏱ for an awaited call (Unreal's "latent node" clock
 * — execution holds here), ⤳ for a detached fire-and-forget call (result dropped; the work may
 * outlive this flow). Absent on plain synchronous calls, so the common case stays quiet.
 */
function AsyncBadge({ d }: { d: LogicNodeData }) {
  if (d.awaited) {
    return <span style={AWAIT_BADGE} title="awaited — execution holds for this call">⏱ await</span>;
  }
  if (d.detached) {
    return <span style={DETACH_BADGE} title="fire-and-forget — result dropped; may outlive this flow">⤳</span>;
  }
  return null;
}

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
export type JumpFlowNodeData = { rootId: string; label: string; file?: string; depth: number; test?: boolean };
type JumpFlowRfNode = Node<JumpFlowNodeData>;

function JumpFlowNode({ data }: NodeProps<JumpFlowRfNode>) {
  const { openLogicFlow } = useBlueprintActions();
  const d = data as JumpFlowNodeData;
  const changedStatus = useBlueprint((s) => s.index.changedStatus.get(d.rootId));
  const changed = changedStatus !== undefined;
  const changedRing = changedColor(changedStatus);
  // A test ghost (Show tests) reads apart from an ordinary caller ghost: violet dashed border + a
  // "TEST" tag, mirroring the coverage palette's test-code colour, so it's clearly "a test exercising
  // this method" rather than just another caller. Clicking still opens that node's own flow.
  const isTest = d.test === true;
  // A caller ghost is a shortcut into that flow (click to open); a test ghost is read-only context —
  // it just shows WHICH tests exercise this method, so it takes no click and shows no pointer cursor.
  return (
    <div style={withChanged(isTest ? JUMP_TEST_BODY : JUMP_BODY, changed ? changedRing : null, "none")} onClick={isTest ? undefined : () => openLogicFlow(d.rootId)} title={isTest ? `Test: ${d.label}` : `Open flow: ${d.label}`}>
      {/* Target pin on top (a deeper caller's wire lands here) + source pin on the bottom (this
          node's wire drops to the node one hop closer to the selection): the chain wires top→down. */}
      <Handle type="target" position={Position.Top} style={PIN} isConnectable={false} />
      <Handle type="source" position={Position.Bottom} style={PIN} isConnectable={false} />
      <div style={JUMP_HEAD}>
        <span style={{ ...JUMP_GLYPH, ...(isTest ? { color: COVERAGE_COLORS.test } : {}) }}>{isTest ? "🧪" : "↗"}</span>
        <span style={NAME} title={d.label}>{d.label}</span>
        {isTest ? (
          <span style={JUMP_TEST_TAG}>TEST</span>
        ) : d.depth > 1 ? (
          // An indirect caller (2+ hops back over the reverse call graph) wears a hop badge so it
          // reads apart from a direct caller; a direct caller (depth 1) needs none.
          <span style={JUMP_DEPTH_BADGE} title={`${d.depth} hops away`}>{`↑${d.depth}`}</span>
        ) : null}
        {changed ? <ChangedTag color={changedRing} /> : null}
      </div>
      {d.file ? <div style={JUMP_FILE} title={d.file}>{d.file}</div> : null}
    </div>
  );
}

/**
 * A flow END-CAP: the ENTRY the observed callable starts at, or the synthetic EXIT every trailing
 * path converges onto. Both are compact pills, not call blocks (no provenance/disclosure/code). The
 * ENTRY wears the callable's name and a left TARGET pin so the view's caller-ghosts — stacked in a
 * column to its left — wire INTO it, plus a right SOURCE pin the exec thread leaves through into the
 * first step. The EXIT is a dead end: a left TARGET pin, no source. Neither is a call site
 * (`targetId: null`), so clicking one is a harmless no-op.
 */
function TerminalNode({ data }: NodeProps<LogicRfNode>) {
  const d = data as TerminalData;
  if (d.terminal === "entry") {
    return (
      <div style={withChanged(ENTRY_BODY, d.changed === true ? CHANGED_ACCENT : null, "none")} title={`Flow entry: ${d.label}`}>
        <Handle type="target" position={Position.Left} style={PIN} isConnectable={false} />
        <Handle type="source" position={Position.Right} style={PIN} isConnectable={false} />
        <span style={TERMINAL_GLYPH}>▶</span>
        <span style={NAME} title={d.label}>{d.label}</span>
        {d.changed === true ? <ChangedTag color={CHANGED_ACCENT} /> : null}
        <span style={ENTRY_TAG}>ENTRY</span>
      </div>
    );
  }
  // A mid-flow `return`/`throw` cap: the red dead-end a terminated path stops at. Left target pin
  // only — nothing ever leaves a return, which is exactly the point.
  if (d.terminal === "return" || d.terminal === "throw") {
    return (
      <div style={RETURN_BODY} title={`Path ${d.terminal === "throw" ? "throws" : "returns"} here: ${d.label}`}>
        <Handle type="target" position={Position.Left} style={PIN} isConnectable={false} />
        <span style={TERMINAL_GLYPH}>{d.terminal === "throw" ? "⚡" : "⏎"}</span>
        <span style={NAME} title={d.label}>{d.label}</span>
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

export const logicNodeTypes = { block: BlockNode, control: ControlNode, branch: BranchNode, jumpflow: JumpFlowNode, defgroup: DefGroupNode, servicegroup: ServiceGroupNode, terminal: TerminalNode };

// Selection is BY TARGET (a target can be called many times): a matched call site rings green so
// every call of the same target lights up together; while some target is selected, unrelated nodes
// dim so the matches pop. Structural nodes (loops/branches) carry no target, so they only ever dim.
type SelectState = "selected" | "dimmed" | "none";
// The accent green shared with the emphasized logic edges (imported by LogicFlowView) so the node
// ring and the edge glow can't drift. Sourced from the flow palette — the alternate projections
// (metro/blocks/timeline) highlight with the very same token.
export const SELECT_ACCENT = FLOW_COLORS.select;

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

// The flow palette (flowViewModel.FLOW_COLORS) is the single source for every semantic accent, so
// the exec graph and the alternate projections can never drift apart on what a colour means. The
// local names stay so the node styling below keeps reading in this file's own vocabulary.
const BLOCK_ACCENT = FLOW_COLORS.call;
// A small INDIGO shift off the blue call accent — same family, not a jarring new colour — so a method
// call (through a receiver / a class method) is distinguishable at a glance from a free function.
const METHOD_ACCENT = FLOW_COLORS.method;
// Evokes the `::` scope-resolution of a member call, versus the `ƒ` of a free function.
const METHOD_GLYPH = "∷";
// Teal, deliberately unlike the blue call accent: a definition node is a declaration ("defined
// here"), a different kind of thing from a call site in the flow.
const DEF_ACCENT = "#3FB8AF";
const GREY_ACCENT = "#3A414C";
const LOOP_ACCENT = FLOW_COLORS.loop;
const TRY_ACCENT = FLOW_COLORS.try;
// A deferred/handed-over callback (a hook body, `.then`, `setTimeout`, a JSX handler): a muted
// slate-cyan, deliberately cooler than the loop/try accents — it reads as "logic passed elsewhere",
// not control-flow that runs here and now.
const CALLBACK_ACCENT = FLOW_COLORS.callback;
// A dotted-arrow glyph for "handed to": the callback is given away, not run in place.
const CALLBACK_GLYPH = "⤳";
const CONTROL_ACCENT: Record<string, string> = { loop: LOOP_ACCENT, try: TRY_ACCENT, callback: CALLBACK_ACCENT };
const CONTROL_GLYPH: Record<string, string> = { loop: "↻", try: "⚠", callback: CALLBACK_GLYPH };
// Sky-blue outline: a branch reads as control-flow via its diamond SHAPE, so it can share the cool
// blue family without being mistaken for a call block — the brighter, cyan-leaning tone stays clear
// of the deeper azure call accent and the indigo method accent.
const BRANCH_ACCENT = FLOW_COLORS.branch;
// Near-canvas dark so the diamond is outline-first, never a flood of colour.
const BRANCH_FILL = "rgba(11,14,19,0.72)";
// A calm green marks the flow's START (evokes a "play"/entry point); a muted slate marks the neutral
// synthetic EXIT end-cap — deliberately quiet so it reads as a terminus, not another step.
const ENTRY_ACCENT = FLOW_COLORS.entry;
const EXIT_ACCENT = FLOW_COLORS.exit;
// A warm red for the return/throw caps a terminated path dead-ends at: unlike the quiet EXIT, an
// early return is a fact worth noticing, so it reads hot.
const RETURN_ACCENT = FLOW_COLORS.exitCap;
// Async semantics on a call block: cyan for an awaited (latent) call the thread holds for, violet
// for a detached fire-and-forget call whose result is dropped and may outlive the flow.
const AWAIT_ACCENT = FLOW_COLORS.awaited;
const DETACH_ACCENT = FLOW_COLORS.detached;

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

// A branch renders as an outline diamond (the classic decision shape) so it never reads as a
// rectangular building block. The wrapper hosts the exec pins and any selection dim.
const BRANCH_WRAP: React.CSSProperties = { position: "relative", width: "100%", height: "100%", fontFamily: MONO };
// The shape is a centring frame for the SVG diamond and its overlaid caption.
const BRANCH_SHAPE: React.CSSProperties = {
  position: "relative",
  width: "100%",
  height: "100%",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};
// clip-path can't paint a border, so the diamond outline is an SVG polygon; non-scaling-stroke keeps
// the stroke a constant width while the polygon stretches (preserveAspectRatio="none") to the box.
const BRANCH_SVG: React.CSSProperties = { position: "absolute", inset: 0, width: "100%", height: "100%", overflow: "visible" };
// The single "X" marker sits ABOVE the diamond, centred on its middle.
const BRANCH_LABEL: React.CSSProperties = {
  position: "relative",
  color: BRANCH_ACCENT,
  fontSize: 14,
  fontWeight: 700,
  lineHeight: 1,
};
// The reveal affordance hangs just below the diamond (wrapper overflow is visible), holding the
// expand toggle and, once open, the condition panel. A high z-index keeps it above neighbouring rows.
const BRANCH_DROPDOWN: React.CSSProperties = {
  position: "absolute",
  top: "100%",
  left: "50%",
  transform: "translateX(-50%)",
  marginTop: 3,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 4,
  zIndex: 10,
  // Size to content (not the ~72px diamond it hangs off), so the condition panel fills its own width
  // instead of collapsing to a one-char-per-line column against the narrow absolute containing block.
  width: "max-content",
  maxWidth: 320,
};
const BRANCH_CONDITION: React.CSSProperties = {
  fontFamily: MONO,
  fontSize: 11,
  color: "#D7E3EF",
  background: "#10151C",
  border: `1px solid ${BRANCH_ACCENT}`,
  borderRadius: 6,
  padding: "5px 9px",
  maxWidth: 320,
  whiteSpace: "normal",
  wordBreak: "break-word",
  lineHeight: 1.4,
  boxShadow: "0 4px 14px rgba(0,0,0,0.4)",
};

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
// A test ghost: the same detached-shortcut shape as a caller ghost, re-tinted violet so it reads as
// test code (matching the coverage palette) rather than another caller in the flow.
const JUMP_TEST_BODY: React.CSSProperties = {
  width: "100%",
  height: "100%",
  boxSizing: "border-box",
  border: `1px dashed ${COVERAGE_COLORS.test}`,
  borderRadius: 8,
  background: "rgba(28,20,45,0.72)",
  padding: "5px 9px",
  fontFamily: MONO,
  color: "#C6BCE0",
  cursor: "default",
  display: "flex",
  flexDirection: "column",
  gap: 2,
  overflow: "hidden",
};
const JUMP_TEST_TAG: React.CSSProperties = {
  marginLeft: "auto",
  flexShrink: 0,
  fontSize: 8.5,
  fontWeight: 700,
  letterSpacing: "0.06em",
  color: COVERAGE_COLORS.test,
  border: `1px solid ${COVERAGE_COLORS.test}66`,
  borderRadius: 3,
  padding: "0 4px",
  background: "rgba(163,113,247,0.14)",
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

// The coverage battery: a dark track + colour fill + a small nub, so it reads as a fuel gauge on any
// title colour. flex-none so it never squeezes the name; the nub is the battery's positive terminal.
const BATTERY_WRAP: React.CSSProperties = { display: "inline-flex", alignItems: "center", gap: 1, flexShrink: 0 };
const BATTERY_TRACK: React.CSSProperties = {
  width: 30,
  height: 9,
  boxSizing: "border-box",
  borderRadius: 2,
  background: "#0B0E13",
  border: "1px solid rgba(0,0,0,0.45)",
  padding: 1,
  overflow: "hidden",
  display: "flex",
  alignItems: "center",
};
const BATTERY_FILL: React.CSSProperties = { height: "100%", borderRadius: 1, minWidth: 2 };
const BATTERY_NUB: React.CSSProperties = { width: 2, height: 5, borderRadius: 1, opacity: 0.55 };

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
// A return/throw cap: warm red so a dead-ending path is unmissable; squared on the entry side and
// rounded on the far side, a one-way cap rather than a two-ended pill.
const RETURN_BODY: React.CSSProperties = {
  ...TERMINAL_BASE,
  fontSize: 11,
  border: `1px solid ${RETURN_ACCENT}`,
  borderRadius: "6px 999px 999px 6px",
  background: "rgba(224,108,108,0.10)",
  color: "#F0C9C9",
};
const TERMINAL_GLYPH: React.CSSProperties = { fontSize: 10, flexShrink: 0, opacity: 0.85 };
const ENTRY_TAG: React.CSSProperties = { marginLeft: "auto", flexShrink: 0, fontSize: 8, fontWeight: 700, letterSpacing: "0.08em", border: `1px solid ${ENTRY_ACCENT}`, borderRadius: 3, padding: "1px 4px", color: ENTRY_ACCENT };

// The async badges: compact dark chips so they stay legible over a solid accent title bar AND over
// a greyed chip's muted body. flex-none so they never squeeze the call name.
const ASYNC_BADGE_BASE: React.CSSProperties = {
  flexShrink: 0,
  fontSize: 8.5,
  fontWeight: 700,
  letterSpacing: "0.05em",
  borderRadius: 3,
  padding: "1px 4px",
  background: "rgba(11,14,19,0.55)",
  whiteSpace: "nowrap",
};
const AWAIT_BADGE: React.CSSProperties = { ...ASYNC_BADGE_BASE, color: AWAIT_ACCENT, border: `1px solid ${AWAIT_ACCENT}88` };
const DETACH_BADGE: React.CSSProperties = { ...ASYNC_BADGE_BASE, fontSize: 10, color: DETACH_ACCENT, border: `1px solid ${DETACH_ACCENT}88` };

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
// The signature line: dimmer than provenance (secondary detail), mono, one clipped line — the full
// text rides the hover title so a long signature never widens the block.
const SIGNATURE: React.CSSProperties = { padding: "0 8px 3px", fontSize: 9.5, color: "#5F6874", fontStyle: "italic", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
// The service frame: a neutral-bordered container (like the composition card) with a health-tinted
// left rail, hosting the run's call blocks. Body transparent so ELK-placed children render over it.
function serviceFrameStyle(health: string): React.CSSProperties {
  return {
    width: "100%",
    height: "100%",
    position: "relative",
    boxSizing: "border-box",
    border: "1px solid #2A2F37",
    borderLeft: `1px solid ${health}`,
    borderRadius: 10,
    background: "rgba(18,23,30,0.45)",
    fontFamily: MONO,
    overflow: "hidden",
  };
}
// The 3px health rail down the frame's left edge — the composition card's fastest health signal.
const SERVICE_RAIL: React.CSSProperties = { position: "absolute", left: 0, top: 0, bottom: 0, width: 3 };
// The title bar is a click-through to the unit in the Service-composition view. Its height (~34px)
// sits under ELK's 42px container top padding so the child blocks clear it.
const SERVICE_TITLE: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  width: "100%",
  height: 34,
  boxSizing: "border-box",
  padding: "0 10px 0 12px",
  border: "none",
  borderBottom: "1px solid #232935",
  background: "rgba(255,255,255,0.02)",
  color: "#C8D3E0",
  fontFamily: MONO,
  fontSize: 12,
  fontWeight: 700,
};
const SERVICE_DOT: React.CSSProperties = { width: 8, height: 8, borderRadius: "50%", flexShrink: 0 };
const SERVICE_KIND: React.CSSProperties = { flexShrink: 0, fontSize: 7.5, fontWeight: 700, letterSpacing: "0.06em", opacity: 0.75, border: "1px solid currentColor", borderRadius: 3, padding: "0 3px" };
const SERVICE_SMELL: React.CSSProperties = { flexShrink: 0, fontSize: 10, color: "#E6B84D" };
// The count of calls the frame wraps, pinned right (auto margin) so it never crowds the name.
const SERVICE_COUNT: React.CSSProperties = { marginLeft: "auto", flexShrink: 0, fontSize: 10, fontWeight: 600, color: "#6C7683" };
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
