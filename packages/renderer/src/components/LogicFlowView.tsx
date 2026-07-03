/**
 * The Logic-flow view: one callable's intra-procedural control-flow, read LEFT → RIGHT in
 * execution order. It renders the per-callable `FlowStep[]` shipped in `artifact.extensions
 * .logicFlow` as plain nested divs (no React Flow / ELK) — green call chips, amber dashed loop
 * containers, and cyan branch containers whose paths stack as rows. Double-clicking a resolved
 * call chip drills into that callable's own flow; a breadcrumb walks back out.
 *
 * The "Inline" dial pre-expands resolved calls IN PLACE: each callee's own flow nests inside the
 * caller's, up to `logicInlineDepth` (0..2) levels, so several methods' logic reads together. A
 * cycle guard (the ancestor path) and a shared step budget keep a deep expansion from hanging.
 */

import { Fragment, useMemo, useState } from "react";
import type { FlowStep, GraphArtifact, GraphNode, LogicFlows, NodeId } from "@meridian/core";
import { useBlueprint, useBlueprintActions } from "../state/StoreContext";

/** A generous ceiling so a cyclic or pathologically nested flow can never hang the render. */
const MAX_DEPTH = 200;
/** Total rendered steps past which inlining stops (remaining calls fall back to leaf chips), so a
 * deep pre-expansion on a huge method can never explode the DOM and hang the browser. */
const INLINE_BUDGET = 800;
/** The inline-depth dial's stops; 0 keeps calls as leaf chips (the original behavior). */
const INLINE_DEPTHS: ReadonlyArray<number> = [0, 1, 2];

type CallStep = Extract<FlowStep, { kind: "call" }>;
type LoopStep = Extract<FlowStep, { kind: "loop" }>;
type BranchStep = Extract<FlowStep, { kind: "branch" }>;

/** Shared state for one flow render pass: the callee-flow lookup + a mutable step budget. The
 * per-node `remainingDepth`/`ancestorPath` vary as inlining descends, so they travel as own props. */
interface FlowContext {
  logicFlowFor: (nodeId: string) => FlowStep[] | undefined;
  budget: { n: number };
}

export function LogicFlowView() {
  const logicRoot = useBlueprint((state) => state.logicRoot);
  const logicStack = useBlueprint((state) => state.logicStack);
  const logicInlineDepth = useBlueprint((state) => state.logicInlineDepth);
  const index = useBlueprint((state) => state.index);
  const sourceUrl = useBlueprint((state) => state.sourceUrl);
  const { logicFlowFor, logicFlowTo, setLogicInlineDepth, showCode, expandCode } = useBlueprintActions();

  if (logicRoot === null) {
    return <LogicFlowPicker />;
  }

  const rootNode = index.nodesById.get(logicRoot);
  const rootName = rootNode?.displayName ?? logicRoot;
  const steps = logicFlowFor(logicRoot);
  const canShowCode = Boolean(rootNode?.location) && Boolean(sourceUrl);

  return (
    <div style={CONTAINER_STYLE}>
      <div style={CONTENT_STYLE}>
        <div style={HEADER_ROW_STYLE}>
          <LogicBreadcrumb stack={logicStack} nodesById={index.nodesById} onJump={logicFlowTo} />
          <InlineDepthControl value={logicInlineDepth} onChange={setLogicInlineDepth} />
        </div>
        {steps && steps.length > 0 ? (
          <div style={FLOW_WRAP_STYLE}>
            <FlowTrack
              steps={steps}
              depth={0}
              remainingDepth={logicInlineDepth}
              ancestorPath={new Set<NodeId>([logicRoot])}
              ctx={{ logicFlowFor, budget: { n: 0 } }}
            />
          </div>
        ) : (
          <div style={EMPTY_STYLE}>
            <span style={EMPTY_MARK_STYLE}>∅</span>
            <span>No calls or control flow in {rootName}.</span>
            {canShowCode && rootNode ? (
              <button
                type="button"
                style={SHOW_CODE_STYLE}
                onClick={() => {
                  // showCode opens inline; expandCode pops the always-mounted modal CodePanel,
                  // which is the only code surface the logic view has (no on-canvas nodes here).
                  void showCode(rootNode);
                  expandCode();
                }}
              >
                Show code
              </button>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The empty-state entry picker (shown only while nothing is opened): search any callable/module
 * that ships a logic flow, or pick from the ranked entry points — with the app entry (`main.ts`)
 * floated to the top — to open its flow directly, without hunting for a node in the Call-flow graph.
 */
function LogicFlowPicker() {
  const artifact = useBlueprint((state) => state.artifact);
  const index = useBlueprint((state) => state.index);
  const { openLogicFlow } = useBlueprintActions();
  const [query, setQuery] = useState("");

  // Thousands of flow keys are possible, so rank once per artifact — not on every keystroke/render.
  const entries = useMemo(() => rankedFlowEntries(artifact, index.nodesById), [artifact, index.nodesById]);
  const needle = query.trim().toLowerCase();
  const rows = needle ? searchFlows(entries, needle) : entries.slice(0, 20);

  return (
    <div style={PICKER_CONTAINER_STYLE}>
      <div style={PICKER_PANEL_STYLE}>
        <div style={PICKER_HINT_STYLE}>
          Pick an entry point, search a method, or double-click one in Call flow.
        </div>
        <input
          style={PICKER_SEARCH_STYLE}
          placeholder="Search a method or module…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <div style={PICKER_LIST_STYLE}>
          {rows.length > 0 ? (
            rows.map((pick) => <PickRow key={pick.id} pick={pick} onOpen={openLogicFlow} />)
          ) : (
            <div style={PICKER_EMPTY_STYLE}>
              {needle ? `No method or module matches “${query.trim()}”.` : "No logic flows in this artifact."}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** One clickable entry row: name over a faint file path, with a kind tag (module is accented). */
function PickRow(props: { pick: FlowPick; onOpen: (id: NodeId) => void }) {
  const { pick } = props;
  return (
    <button type="button" style={ROW_STYLE} title={pick.id} onClick={() => props.onOpen(pick.id)}>
      <span style={ROW_MAIN_STYLE}>
        <span style={ROW_NAME_STYLE}>{pick.displayName}</span>
        {pick.file ? <span style={ROW_FILE_STYLE}>{pick.file}</span> : null}
      </span>
      <span style={kindTagStyle(pick.kind)}>{pick.kind}</span>
    </button>
  );
}

interface FlowPick {
  id: NodeId;
  displayName: string;
  qualifiedName: string;
  file: string;
  kind: string;
}

// A name that *starts with* an entry/boot word — matched against the basename `displayName`
// (`main.ts`, `app.tsx`), NOT the full id: the app lives under `src/aria/app/…`, so a path match
// would boost every file and let test names sort to the top. Anchored, so `AboutSection…` misses.
const ENTRY_NAME = /^(main|index|bootstrap|app|entry|boot|server|root)\b/i;
const ENTRY_NAME_BOOST = 1000;
// A module's top-level flow is the file's own init/boot sequence, so it outranks a plain callable.
const MODULE_BOOST = 100;
// Test/story fixtures are never an app entry, so they're dropped from the default list entirely.
const TEST_FILE = /(__tests?__|\.test\.|\.spec\.|\.stories\.)/i;

/**
 * Every node that ships a logic flow, ranked for "entry-ness": an entry-ish name (main/boot/…)
 * outweighs everything, and a module (a file's top-level init flow) outranks a callable — so an
 * entry module like `main.ts` floats to the very top. Test/story files are excluded outright.
 * One pass + sort; the caller slices.
 */
function rankedFlowEntries(artifact: GraphArtifact, nodesById: ReadonlyMap<string, GraphNode>): FlowPick[] {
  const flows = artifact.extensions?.logicFlow as unknown as LogicFlows | undefined;
  if (!flows) {
    return [];
  }
  const ranked: Array<{ pick: FlowPick; score: number }> = [];
  for (const id of Object.keys(flows)) {
    const node = nodesById.get(id);
    if (!node || TEST_FILE.test(id)) {
      continue;
    }
    const nameBoost = ENTRY_NAME.test(node.displayName) ? ENTRY_NAME_BOOST : 0;
    const score = nameBoost + (node.kind === "module" ? MODULE_BOOST : 0);
    ranked.push({ score, pick: pickFor(id, node) });
  }
  ranked.sort((a, b) => b.score - a.score || a.pick.displayName.localeCompare(b.pick.displayName));
  return ranked.map((entry) => entry.pick);
}

function pickFor(id: NodeId, node: GraphNode): FlowPick {
  return {
    id,
    displayName: node.displayName,
    qualifiedName: node.qualifiedName,
    file: node.location?.file ?? "",
    kind: node.kind,
  };
}

/** First ~15 ranked entries whose display or qualified name contains the (lowercased) needle. */
function searchFlows(entries: FlowPick[], needle: string): FlowPick[] {
  const found: FlowPick[] = [];
  for (const entry of entries) {
    if (entry.displayName.toLowerCase().includes(needle) || entry.qualifiedName.toLowerCase().includes(needle)) {
      found.push(entry);
      if (found.length >= 15) {
        break;
      }
    }
  }
  return found;
}

/** The drill trail root..current; each segment jumps back to that callable's flow. */
function LogicBreadcrumb(props: {
  stack: NodeId[];
  nodesById: ReadonlyMap<string, GraphNode>;
  onJump: (id: NodeId) => void;
}) {
  return (
    <nav style={BREADCRUMB_STYLE} aria-label="Logic flow trail">
      {props.stack.map((id, position) => {
        const current = position === props.stack.length - 1;
        return (
          <Fragment key={`${id}:${position}`}>
            {position > 0 ? <span style={CRUMB_SEP_STYLE} aria-hidden>›</span> : null}
            <button
              type="button"
              style={current ? CRUMB_CURRENT_STYLE : CRUMB_STYLE}
              onClick={() => props.onJump(id)}
              aria-current={current ? "page" : undefined}
              title={id}
            >
              {props.nodesById.get(id)?.displayName ?? id}
            </button>
          </Fragment>
        );
      })}
    </nav>
  );
}

/** The inline-depth dial: pick how many levels of resolved calls expand in place (0 = leaf chips). */
function InlineDepthControl(props: { value: number; onChange: (depth: number) => void }) {
  return (
    <div style={INLINE_CONTROL_STYLE}>
      <span style={INLINE_LABEL_STYLE}>Inline</span>
      <div style={INLINE_GROUP_STYLE} role="group" aria-label="Inline depth">
        {INLINE_DEPTHS.map((depth) => (
          <button
            key={depth}
            type="button"
            style={inlinePillStyle(depth === props.value)}
            aria-pressed={depth === props.value}
            onClick={() => props.onChange(depth)}
          >
            {depth}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * A horizontal execution track: steps left → right with → connectors between them. `remainingDepth`
 * is how many more levels of resolved calls may expand in place; `ancestorPath` is the inlined
 * caller chain (the cycle guard). Both pass THROUGH loop/branch nesting unchanged — only inlining
 * a call spends a level.
 */
function FlowTrack(props: {
  steps: FlowStep[];
  depth: number;
  remainingDepth: number;
  ancestorPath: ReadonlySet<string>;
  ctx: FlowContext;
}) {
  if (props.depth > MAX_DEPTH) {
    return <span style={NONE_STYLE}>…</span>;
  }
  return (
    <div style={TRACK_STYLE}>
      {props.steps.map((step, position) => (
        <Fragment key={position}>
          {position > 0 ? <Arrow /> : null}
          <FlowStepView
            step={step}
            depth={props.depth}
            remainingDepth={props.remainingDepth}
            ancestorPath={props.ancestorPath}
            ctx={props.ctx}
          />
        </Fragment>
      ))}
    </div>
  );
}

function FlowStepView(props: {
  step: FlowStep;
  depth: number;
  remainingDepth: number;
  ancestorPath: ReadonlySet<string>;
  ctx: FlowContext;
}) {
  // Count every rendered step against the shared budget; the cap is read back in CallStepView.
  props.ctx.budget.n += 1;
  if (props.step.kind === "call") {
    return (
      <CallStepView
        step={props.step}
        depth={props.depth}
        remainingDepth={props.remainingDepth}
        ancestorPath={props.ancestorPath}
        ctx={props.ctx}
      />
    );
  }
  if (props.step.kind === "loop") {
    return (
      <LoopBox
        step={props.step}
        depth={props.depth}
        remainingDepth={props.remainingDepth}
        ancestorPath={props.ancestorPath}
        ctx={props.ctx}
      />
    );
  }
  return (
    <BranchBox
      step={props.step}
      depth={props.depth}
      remainingDepth={props.remainingDepth}
      ancestorPath={props.ancestorPath}
      ctx={props.ctx}
    />
  );
}

/**
 * A call step: inline the callee's flow in place when there's depth left, the target resolves, it
 * has a flow, the budget holds, and the target isn't already an inlined ancestor (the cycle guard).
 * Otherwise fall back to a leaf chip — flagged with a ↩ marker when only the cycle guard stopped it.
 */
function CallStepView(props: {
  step: CallStep;
  depth: number;
  remainingDepth: number;
  ancestorPath: ReadonlySet<string>;
  ctx: FlowContext;
}) {
  const { step, ctx } = props;
  const target = step.resolution === "resolved" ? step.target : null;
  const calleeFlow = target !== null ? ctx.logicFlowFor(target) : undefined;
  const inlinable =
    props.remainingDepth > 0 && target !== null && (calleeFlow?.length ?? 0) > 0 && ctx.budget.n <= INLINE_BUDGET;
  const blockedByCycle = inlinable && target !== null && props.ancestorPath.has(target);

  if (inlinable && !blockedByCycle && target !== null && calleeFlow) {
    return (
      <InlineCall
        step={step}
        target={target}
        calleeFlow={calleeFlow}
        depth={props.depth}
        remainingDepth={props.remainingDepth}
        ancestorPath={props.ancestorPath}
        ctx={ctx}
      />
    );
  }
  return <CallChip step={step} recursion={blockedByCycle} />;
}

// A resolved call is drillable (double-click → its own flow); external/unresolved stay dimmed. A
// call skipped only because its target is already inlined above shows a faint recursion marker.
function CallChip(props: { step: CallStep; recursion?: boolean }) {
  const { step } = props;
  const { drillLogicFlow } = useBlueprintActions();
  const target = step.resolution === "resolved" ? step.target : null;
  const title = props.recursion
    ? "recursion — already inlined above"
    : target !== null
      ? "double-click to open its flow"
      : `${step.resolution} call`;
  return (
    <div
      style={target !== null ? CALL_CHIP_STYLE : CALL_CHIP_MUTED_STYLE}
      onDoubleClick={target !== null ? () => drillLogicFlow(target) : undefined}
      title={title}
    >
      <b style={target !== null ? CALL_NAME_STYLE : CALL_NAME_MUTED_STYLE}>{step.label}</b>
      {props.recursion ? <span style={RECURSION_MARK_STYLE} aria-hidden>↩</span> : null}
    </div>
  );
}

/**
 * A resolved call expanded in place: the call chip is the container header (still double-click →
 * drill), and the callee's own flow renders nested below as its own track, one inline level deeper
 * with the target added to the ancestor path so a later self-call can't re-inline forever.
 */
function InlineCall(props: {
  step: CallStep;
  target: NodeId;
  calleeFlow: FlowStep[];
  depth: number;
  remainingDepth: number;
  ancestorPath: ReadonlySet<string>;
  ctx: FlowContext;
}) {
  const childPath = new Set(props.ancestorPath);
  childPath.add(props.target);
  return (
    <div style={INLINE_CALL_STYLE}>
      <div style={INLINE_CALL_HEADER_STYLE}>
        <CallChip step={props.step} />
      </div>
      <div style={INLINE_CALL_BODY_STYLE}>
        <FlowTrack
          steps={props.calleeFlow}
          depth={props.depth + 1}
          remainingDepth={props.remainingDepth - 1}
          ancestorPath={childPath}
          ctx={props.ctx}
        />
      </div>
    </div>
  );
}

function LoopBox(props: {
  step: LoopStep;
  depth: number;
  remainingDepth: number;
  ancestorPath: ReadonlySet<string>;
  ctx: FlowContext;
}) {
  const { step } = props;
  return (
    <div style={LOOP_STYLE}>
      <div style={LOOP_HEADER_STYLE}>
        <span>loop</span>
        {step.label && step.label !== "loop" ? <span style={LOOP_LABEL_STYLE}>{step.label}</span> : null}
        <span style={LOOP_REPEAT_STYLE}>↻</span>
      </div>
      <FlowTrack
        steps={step.body}
        depth={props.depth + 1}
        remainingDepth={props.remainingDepth}
        ancestorPath={props.ancestorPath}
        ctx={props.ctx}
      />
    </div>
  );
}

function BranchBox(props: {
  step: BranchStep;
  depth: number;
  remainingDepth: number;
  ancestorPath: ReadonlySet<string>;
  ctx: FlowContext;
}) {
  const { step } = props;
  return (
    <div style={BRANCH_STYLE}>
      <div style={BRANCH_COND_STYLE}>{step.label}</div>
      <div style={BRANCH_ROWS_STYLE}>
        {step.paths.map((path, position) => (
          <div key={position} style={BRANCH_ROW_STYLE}>
            <span style={ROW_LABEL_STYLE}>{path.label}</span>
            {path.body.length > 0 ? (
              <FlowTrack
                steps={path.body}
                depth={props.depth + 1}
                remainingDepth={props.remainingDepth}
                ancestorPath={props.ancestorPath}
                ctx={props.ctx}
              />
            ) : (
              <span style={NONE_STYLE}>—</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function Arrow() {
  return (
    <span style={ARROW_STYLE} aria-hidden>
      <span style={ARROW_LINE_STYLE} />
      <span style={ARROW_HEAD_STYLE} />
    </span>
  );
}

// The toolbar floats over the top-left, so the flow content clears it with a left inset.
const CONTAINER_STYLE: React.CSSProperties = { position: "absolute", inset: 0, background: "#0E1116", overflow: "auto" };
const CONTENT_STYLE: React.CSSProperties = { boxSizing: "border-box", minHeight: "100%", padding: "20px 28px 28px 336px" };

// The empty-state picker shares the content inset so it clears the floating top-left toolbar.
const PICKER_CONTAINER_STYLE: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  boxSizing: "border-box",
  background: "#0E1116",
  overflow: "auto",
  padding: "20px 28px 28px 336px",
};
const PICKER_PANEL_STYLE: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 10,
  maxWidth: 520,
  border: "1px solid #2A2F37",
  borderRadius: 12,
  background: "#12171E",
  padding: 16,
};
const PICKER_HINT_STYLE: React.CSSProperties = { fontSize: 13, color: "#7B8695", lineHeight: 1.5 };
const PICKER_SEARCH_STYLE: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  fontSize: 13,
  padding: "6px 10px",
  background: "#0E1116",
  border: "1px solid #2A2F37",
  borderRadius: 6,
  color: "#E6EDF3",
};
const PICKER_LIST_STYLE: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 4, maxHeight: 420, overflowY: "auto" };
const PICKER_EMPTY_STYLE: React.CSSProperties = { fontSize: 12, color: "#6C7683", padding: "6px 2px" };

const ROW_STYLE: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  textAlign: "left",
  borderRadius: 6,
  border: "1px solid #2A2F37",
  background: "#12171E",
  color: "#9AA4B2",
  padding: "6px 10px",
  cursor: "pointer",
  font: "inherit",
};
const ROW_MAIN_STYLE: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 1, flex: 1, minWidth: 0 };
const ROW_NAME_STYLE: React.CSSProperties = {
  fontSize: 13,
  color: "#E6EDF3",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
const ROW_FILE_STYLE: React.CSSProperties = {
  fontSize: 10,
  color: "#6C7683",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
const KIND_TAG_STYLE: React.CSSProperties = {
  flex: "0 0 auto",
  fontSize: 9,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  border: "1px solid #2A2F37",
  borderRadius: 4,
  padding: "1px 6px",
  color: "#7B8695",
};

// Accent the module tag green — a module's top-level flow is the app/boot init, the place to start.
function kindTagStyle(kind: string): React.CSSProperties {
  if (kind !== "module") {
    return KIND_TAG_STYLE;
  }
  return { ...KIND_TAG_STYLE, color: "#56C271", borderColor: "#2C4133" };
}

// Breadcrumb on the left, inline dial on the right; the row owns the gap below (breadcrumb no longer does).
const HEADER_ROW_STYLE: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  flexWrap: "wrap",
  gap: 12,
  marginBottom: 16,
};
const BREADCRUMB_STYLE: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  flexWrap: "wrap",
  gap: 4,
};

// The inline-depth dial mirrors the Code-flows depth dial: muted pills in a boxed group, active one lit.
const INLINE_CONTROL_STYLE: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, flex: "0 0 auto" };
const INLINE_LABEL_STYLE: React.CSSProperties = {
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  color: "#7B8695",
};
const INLINE_GROUP_STYLE: React.CSSProperties = {
  display: "flex",
  padding: 2,
  gap: 2,
  borderRadius: 8,
  border: "1px solid #2A2F37",
  background: "#0E1116",
};

function inlinePillStyle(active: boolean): React.CSSProperties {
  return {
    border: "none",
    borderRadius: 6,
    padding: "3px 9px",
    fontSize: 11,
    cursor: "pointer",
    font: "inherit",
    fontWeight: active ? 600 : 400,
    background: active ? "#1F2530" : "transparent",
    color: active ? "#E6EDF3" : "#9AA4B2",
  };
}
const CRUMB_STYLE: React.CSSProperties = {
  background: "transparent",
  border: "none",
  padding: "2px 4px",
  borderRadius: 4,
  cursor: "pointer",
  font: "inherit",
  fontSize: 13,
  color: "#9AA4B2",
};
const CRUMB_CURRENT_STYLE: React.CSSProperties = { ...CRUMB_STYLE, color: "#E6EDF3", fontWeight: 600, cursor: "default" };
const CRUMB_SEP_STYLE: React.CSSProperties = { color: "#4B535F", fontSize: 13 };

const FLOW_WRAP_STYLE: React.CSSProperties = {
  overflowX: "auto",
  border: "1px solid #2A2F37",
  borderRadius: 12,
  background: "#12171E",
  padding: 16,
};
const TRACK_STYLE: React.CSSProperties = { display: "flex", alignItems: "center", gap: 0, width: "max-content" };

const ARROW_STYLE: React.CSSProperties = { display: "flex", alignItems: "center", flex: "0 0 auto", margin: "0 6px" };
const ARROW_LINE_STYLE: React.CSSProperties = { width: 16, height: 2, background: "#2A2F37" };
const ARROW_HEAD_STYLE: React.CSSProperties = {
  width: 0,
  height: 0,
  borderTop: "4px solid transparent",
  borderBottom: "4px solid transparent",
  borderLeft: "5px solid #2A2F37",
};

const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";
const CALL_CHIP_STYLE: React.CSSProperties = {
  flex: "0 0 auto",
  border: "1px solid #2A2F37",
  borderLeft: "3px solid #56C271",
  borderRadius: 8,
  background: "#10151C",
  padding: "8px 12px",
  fontFamily: MONO,
  fontSize: 13,
  color: "#E6EDF3",
  whiteSpace: "nowrap",
  cursor: "pointer",
};
const CALL_CHIP_MUTED_STYLE: React.CSSProperties = {
  ...CALL_CHIP_STYLE,
  borderLeft: "3px dashed #3A414C",
  opacity: 0.55,
  cursor: "default",
};
const CALL_NAME_STYLE: React.CSSProperties = { color: "#56C271", fontWeight: 600 };
const CALL_NAME_MUTED_STYLE: React.CSSProperties = { color: "#9AA4B2", fontWeight: 600 };
const RECURSION_MARK_STYLE: React.CSSProperties = { marginLeft: 6, color: "#7B8695", opacity: 0.7 };

// An inlined call reads as a faint green-tinted box — distinct from loop(amber)/branch(cyan) — with
// the call chip as its header and the callee's own flow nested below.
const INLINE_CALL_STYLE: React.CSSProperties = {
  flex: "0 0 auto",
  border: "1px solid rgba(86,194,113,0.35)",
  borderRadius: 10,
  background: "rgba(86,194,113,0.04)",
  padding: "8px 10px 10px",
};
const INLINE_CALL_HEADER_STYLE: React.CSSProperties = { display: "flex", marginBottom: 9 };
const INLINE_CALL_BODY_STYLE: React.CSSProperties = { paddingLeft: 2 };

const LOOP_STYLE: React.CSSProperties = {
  flex: "0 0 auto",
  border: "1px dashed #E6B84D",
  borderRadius: 10,
  background: "rgba(230,184,77,0.05)",
  padding: "8px 10px 10px",
};
const LOOP_HEADER_STYLE: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  marginBottom: 9,
  fontSize: 10,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  color: "#E6B84D",
};
const LOOP_LABEL_STYLE: React.CSSProperties = { fontFamily: MONO, fontSize: 11, textTransform: "none", letterSpacing: 0 };
const LOOP_REPEAT_STYLE: React.CSSProperties = { marginLeft: "auto", fontSize: 12, opacity: 0.85 };

const BRANCH_STYLE: React.CSSProperties = {
  flex: "0 0 auto",
  border: "1px solid #61DAFB",
  borderRadius: 10,
  background: "rgba(97,218,251,0.05)",
  padding: "8px 10px 6px",
};
const BRANCH_COND_STYLE: React.CSSProperties = { fontFamily: MONO, fontSize: 12, color: "#61DAFB", marginBottom: 8 };
const BRANCH_ROWS_STYLE: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 7 };
const BRANCH_ROW_STYLE: React.CSSProperties = { display: "flex", alignItems: "center", gap: 10 };
const ROW_LABEL_STYLE: React.CSSProperties = {
  flex: "0 0 auto",
  minWidth: 74,
  fontSize: 10,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  color: "#7B8695",
  textAlign: "right",
};
const NONE_STYLE: React.CSSProperties = { fontFamily: MONO, fontSize: 12, color: "#6C7683" };

const EMPTY_STYLE: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  maxWidth: 560,
  border: "1px dashed #2A2F37",
  borderRadius: 10,
  padding: "16px 18px",
  fontSize: 13,
  color: "#7B8695",
};
const EMPTY_MARK_STYLE: React.CSSProperties = { fontSize: 22, opacity: 0.5 };
const SHOW_CODE_STYLE: React.CSSProperties = {
  marginLeft: "auto",
  background: "#1A1F27",
  color: "#9AA4B2",
  border: "1px solid #2A2F37",
  borderRadius: 6,
  padding: "5px 10px",
  fontSize: 12,
  cursor: "pointer",
};
