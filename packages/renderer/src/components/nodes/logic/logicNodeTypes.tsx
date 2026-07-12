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

import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { useBlueprint, useBlueprintActions } from "../../../state/StoreContext";
import type { DefGroupData, LogicRfNode } from "../../../layout/logicElk";
import { branchCondition, inputPinText, type LogicNodeData, type TerminalData } from "../../../derive/logicGraph";
import { PIN_COLORS, PIN_ROW_H, type PinCategory, type PinModel } from "../../../derive/signaturePins";
import { FLOW_COLORS } from "../../../derive/flowViewModel";
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

// The white execution pins (left in / right out). `top` pins them to a fixed height instead of the
// node's vertical centre — a call block sets it to the title bar, so the exec thread enters and
// leaves along the "exec row" (Blueprints-style) and never crosses the data-pin rows below.
function ExecPins({ top }: { top?: number } = {}) {
  const style = top === undefined ? PIN : { ...PIN, top, transform: "none" as const };
  return (
    <>
      <Handle type="target" position={Position.Left} style={style} isConnectable={false} />
      <Handle type="source" position={Position.Right} style={style} isConnectable={false} />
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
  const canCode = Boolean(codeNode?.location) && Boolean(sourceUrl);
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
        <ExecPins top={EXEC_PIN_TOP} />
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
        {/* The typed data ports — WHAT the block consumes and produces. Input pins on the left edge,
            an output pin on the right, colour-coded by type. Definition grid cells stay compact
            (they carry no pins); a call with no knowable I/O renders none. */}
        {d.pins ? <DataPinRows pins={d.pins} /> : null}
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
  // The classic decision DIAMOND: a sky-accent rhombus with the actual condition centred over it
  // (clipped to the diamond's central band, the full `if <cond>` on hover). Its then/else/case pins
  // leave as labeled exec edges; the exec pins sit at the wrapper's left/right centre — the diamond's
  // side vertices — so the thread runs through the decision point.
  return (
    <div style={selectStyle(BRANCH_WRAP, select)} title={d.label}>
      <Handle type="target" position={Position.Left} style={PIN} isConnectable={false} />
      <Handle type="source" position={Position.Right} style={PIN} isConnectable={false} />
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={BRANCH_SVG} aria-hidden="true">
        <polygon points="50,2 98,50 50,98 2,50" fill={BRANCH_FILL} stroke={BRANCH_ACCENT} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
      </svg>
      <span style={BRANCH_COND}>{branchCondition(d.label)}</span>
    </div>
  );
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
 * The typed data ports of a call block — the Blueprints data pins. Each callee PARAMETER is an input
 * row (a coloured port on the left edge + `name: type`); the RETURN is one output row (the type + a
 * port on the right edge). A capped overflow of params collapses into a muted "+N more" so the
 * truncation is stated, not hidden. Colours are the shared PIN_COLORS families.
 */
function DataPinRows({ pins }: { pins: PinModel }) {
  return (
    <div style={PIN_SECTION}>
      {pins.inputs.map((pin, i) => (
        <div key={`in:${i}`} style={PIN_ROW} title={inputPinText(pin)}>
          <DataDot category={pin.category} />
          <span style={PIN_NAME}>{pin.rest ? "..." : ""}{pin.name}{pin.optional ? "?" : ""}</span>
          {pin.type ? <span style={PIN_TYPE}>: {pin.type}</span> : null}
        </div>
      ))}
      {pins.hiddenInputs > 0 ? (
        <div style={PIN_ROW}><span style={PIN_MORE}>+{pins.hiddenInputs} more</span></div>
      ) : null}
      {pins.output ? (
        <div style={PIN_ROW_OUT} title={`returns ${pins.output.type}`}>
          <span style={PIN_TYPE_OUT}>{pins.output.type}</span>
          <DataDot category={pins.output.category} />
        </div>
      ) : null}
    </div>
  );
}

/** One data port dot, coloured by its type family. A `void` port is a hollow ring (the block
 * produces nothing there); an `array` port squares into a "list" nub; every other type is a filled
 * dot in its family colour. */
function DataDot({ category }: { category: PinCategory }) {
  const color = PIN_COLORS[category];
  if (category === "void") {
    return <span style={{ ...DOT_BASE, background: "transparent", border: `1.5px solid ${color}`, boxShadow: "none" }} />;
  }
  return <span style={{ ...(category === "array" ? DOT_LIST : DOT_BASE), background: color }} />;
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
      {/* DEFAULT handles (id-less) keep the vertical chain — target on top (a deeper caller lands
          here), source on the bottom (drops to the node one hop closer). The extra id'd side handles
          let the ENTRY cluster wire HORIZONTALLY instead: a caller's RIGHT edge into the entry's LEFT
          (see buildChainEdges), so the arrow runs level rather than up from a bottom corner. */}
      <Handle type="target" position={Position.Top} style={PIN} isConnectable={false} />
      <Handle type="source" position={Position.Bottom} style={PIN} isConnectable={false} />
      <Handle id="l" type="target" position={Position.Left} style={PIN} isConnectable={false} />
      <Handle id="r" type="source" position={Position.Right} style={PIN} isConnectable={false} />
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

/** The hover text for a return/throw cap: the full `return <expr>` / `throw <expr>` so the exact
 * value is one hover away, or a plain "(no value)" note for a bare return that carries no expression
 * (its `label` is just the bare keyword). */
function returnHoverText(d: TerminalData): string {
  return d.label && d.label !== d.terminal ? d.label : `${d.terminal} (no value)`;
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
  // A mid-flow `return`/`throw` cap: the red dead-end a terminated path stops at, shaped like the
  // EXIT pill. Left target pin only — nothing ever leaves a return. It shows only the WORD; the
  // returned/thrown expression is one hover away, so the cap stays compact and the flow uncluttered.
  if (d.terminal === "return" || d.terminal === "throw") {
    return (
      <div style={RETURN_BODY} title={returnHoverText(d)}>
        <Handle type="target" position={Position.Left} style={PIN} isConnectable={false} />
        <span style={TERMINAL_GLYPH}>{d.terminal === "throw" ? "⚡" : "⏎"}</span>
        <span style={NAME}>{d.terminal}</span>
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

// A branch renders as an outline DIAMOND (the classic decision shape) so it never reads as a
// rectangular building block. The wrapper hosts the exec pins and any selection dim, and centres the
// condition over the SVG.
const BRANCH_WRAP: React.CSSProperties = { position: "relative", width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: MONO };
// clip-path can't paint a border, so the diamond outline is an SVG polygon; non-scaling-stroke keeps
// the stroke a constant width while the polygon stretches (preserveAspectRatio="none") to the box.
const BRANCH_SVG: React.CSSProperties = { position: "absolute", inset: 0, width: "100%", height: "100%", overflow: "visible" };
// Near-canvas dark fill so the diamond reads outline-first, never a flood of colour.
const BRANCH_FILL = "rgba(11,14,19,0.72)";
// The condition sits over the diamond's widest (central) band, clipped there with ellipsis. The box
// is sized (logicGraph) so the text clears the slanted edges; the full `if <cond>` rides the hover.
const BRANCH_COND: React.CSSProperties = { position: "relative", maxWidth: "62%", textAlign: "center", color: "#D7E3EF", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };

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
// A return/throw cap mirrors the EXIT pill's shape (a rounded, centred capsule) but in warm red so a
// dead-ending path is unmissable. It shows only the word `return`/`throw`; the returned/thrown
// expression rides the hover, so the cap stays compact like EXIT rather than sprawling to the value.
const RETURN_BODY: React.CSSProperties = {
  ...TERMINAL_BASE,
  justifyContent: "center",
  fontSize: 11,
  border: `1px solid ${RETURN_ACCENT}`,
  background: "rgba(224,108,108,0.12)",
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
// ---- data pins (typed I/O ports) ----------------------------------------------------------------
// Where the white exec pins sit on a call block: pinned to the title bar's height so the exec thread
// runs along the top "exec row" (Blueprints-style), clear of the data rows below.
const EXEC_PIN_TOP = 15;

// The pin section sits below the provenance line, divided by a hairline. Each row is exactly
// PIN_ROW_H tall (the value shared with the layout sizing) so the drawn ports fill the box the
// layout reserved — the node's measured height and its rendered rows can't drift apart.
const PIN_SECTION: React.CSSProperties = { display: "flex", flexDirection: "column", borderTop: "1px solid #1E242D", paddingTop: 2 };
const PIN_ROW: React.CSSProperties = { display: "flex", alignItems: "center", gap: 6, height: PIN_ROW_H, padding: "0 8px 0 6px", minWidth: 0 };
// The output row mirrors an input reversed: the produced type, then a right-edge port.
const PIN_ROW_OUT: React.CSSProperties = { ...PIN_ROW, justifyContent: "flex-end", padding: "0 6px 0 8px" };
// The param name reads in ink (priority); its `: type` trails dimmer and truncates first.
const PIN_NAME: React.CSSProperties = { fontSize: 11, color: "#C8D3E0", flexShrink: 0, whiteSpace: "nowrap" };
const PIN_TYPE: React.CSSProperties = { fontSize: 11, color: "#7B8695", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 };
// The output type reads a touch brighter than an input's — it's the value the step hands onward.
const PIN_TYPE_OUT: React.CSSProperties = { fontSize: 11, color: "#AEB9C7", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 };
// The honest "+N more" when the param cap hid some inputs — muted, but never silent.
const PIN_MORE: React.CSSProperties = { fontSize: 10, color: "#6C7683", fontStyle: "italic" };
// A data port: a filled dot coloured by type family. flex-none so a port never shrinks under a long
// type; the dark ring keeps a light port legible on the block's dark body.
const DOT_BASE: React.CSSProperties = { width: 9, height: 9, borderRadius: "50%", flexShrink: 0, boxShadow: "0 0 0 1px rgba(0,0,0,0.35)" };
// `array` squares off into a "list" nub, distinguishing a collection from a scalar port at a glance.
const DOT_LIST: React.CSSProperties = { ...DOT_BASE, borderRadius: 2 };
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
