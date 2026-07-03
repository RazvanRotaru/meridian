/**
 * The Logic-flow view: one callable's intra-procedural control-flow, read LEFT → RIGHT in
 * execution order. It renders the per-callable `FlowStep[]` shipped in `artifact.extensions
 * .logicFlow` as plain nested divs (no React Flow / ELK) — green call chips, amber dashed loop
 * containers, and cyan branch containers whose paths stack as rows. Double-clicking a resolved
 * call chip drills into that callable's own flow; a breadcrumb walks back out.
 */

import { Fragment } from "react";
import type { FlowStep, GraphNode, NodeId } from "@meridian/core";
import { useBlueprint, useBlueprintActions } from "../state/StoreContext";

/** A generous ceiling so a cyclic or pathologically nested flow can never hang the render. */
const MAX_DEPTH = 200;

type CallStep = Extract<FlowStep, { kind: "call" }>;
type LoopStep = Extract<FlowStep, { kind: "loop" }>;
type BranchStep = Extract<FlowStep, { kind: "branch" }>;

export function LogicFlowView() {
  const logicRoot = useBlueprint((state) => state.logicRoot);
  const logicStack = useBlueprint((state) => state.logicStack);
  const index = useBlueprint((state) => state.index);
  const sourceUrl = useBlueprint((state) => state.sourceUrl);
  const { logicFlowFor, logicFlowTo, showCode, expandCode } = useBlueprintActions();

  if (logicRoot === null) {
    return (
      <div style={CENTER_STYLE}>
        <div style={HINT_STYLE}>
          Double-click a method — or search one in the sidebar — to see its logic flow.
        </div>
      </div>
    );
  }

  const rootNode = index.nodesById.get(logicRoot);
  const rootName = rootNode?.displayName ?? logicRoot;
  const steps = logicFlowFor(logicRoot);
  const canShowCode = Boolean(rootNode?.location) && Boolean(sourceUrl);

  return (
    <div style={CONTAINER_STYLE}>
      <div style={CONTENT_STYLE}>
        <LogicBreadcrumb stack={logicStack} nodesById={index.nodesById} onJump={logicFlowTo} />
        {steps && steps.length > 0 ? (
          <div style={FLOW_WRAP_STYLE}>
            <FlowTrack steps={steps} depth={0} />
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

/** A horizontal execution track: steps left → right with → connectors between them. */
function FlowTrack(props: { steps: FlowStep[]; depth: number }) {
  if (props.depth > MAX_DEPTH) {
    return <span style={NONE_STYLE}>…</span>;
  }
  return (
    <div style={TRACK_STYLE}>
      {props.steps.map((step, position) => (
        <Fragment key={position}>
          {position > 0 ? <Arrow /> : null}
          <FlowStepView step={step} depth={props.depth} />
        </Fragment>
      ))}
    </div>
  );
}

function FlowStepView(props: { step: FlowStep; depth: number }) {
  if (props.step.kind === "call") {
    return <CallChip step={props.step} />;
  }
  if (props.step.kind === "loop") {
    return <LoopBox step={props.step} depth={props.depth} />;
  }
  return <BranchBox step={props.step} depth={props.depth} />;
}

// A resolved call is drillable (double-click → its own flow); external/unresolved stay dimmed.
function CallChip(props: { step: CallStep }) {
  const { step } = props;
  const { drillLogicFlow } = useBlueprintActions();
  const target = step.resolution === "resolved" ? step.target : null;
  return (
    <div
      style={target !== null ? CALL_CHIP_STYLE : CALL_CHIP_MUTED_STYLE}
      onDoubleClick={target !== null ? () => drillLogicFlow(target) : undefined}
      title={target !== null ? "double-click to open its flow" : `${step.resolution} call`}
    >
      <b style={target !== null ? CALL_NAME_STYLE : CALL_NAME_MUTED_STYLE}>{step.label}</b>
    </div>
  );
}

function LoopBox(props: { step: LoopStep; depth: number }) {
  const { step } = props;
  return (
    <div style={LOOP_STYLE}>
      <div style={LOOP_HEADER_STYLE}>
        <span>loop</span>
        {step.label && step.label !== "loop" ? <span style={LOOP_LABEL_STYLE}>{step.label}</span> : null}
        <span style={LOOP_REPEAT_STYLE}>↻</span>
      </div>
      <FlowTrack steps={step.body} depth={props.depth + 1} />
    </div>
  );
}

function BranchBox(props: { step: BranchStep; depth: number }) {
  const { step } = props;
  return (
    <div style={BRANCH_STYLE}>
      <div style={BRANCH_COND_STYLE}>{step.label}</div>
      <div style={BRANCH_ROWS_STYLE}>
        {step.paths.map((path, position) => (
          <div key={position} style={BRANCH_ROW_STYLE}>
            <span style={ROW_LABEL_STYLE}>{path.label}</span>
            {path.body.length > 0 ? (
              <FlowTrack steps={path.body} depth={props.depth + 1} />
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
const CENTER_STYLE: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  background: "#0E1116",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 24,
};
const HINT_STYLE: React.CSSProperties = { maxWidth: 420, textAlign: "center", fontSize: 14, color: "#7B8695", lineHeight: 1.6 };

const BREADCRUMB_STYLE: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  flexWrap: "wrap",
  gap: 4,
  marginBottom: 16,
};
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
