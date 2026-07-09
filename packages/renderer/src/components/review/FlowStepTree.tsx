/**
 * One logic flow rendered as a hierarchical step tree — the shape the PR-review side panel shows
 * under each affected flow. A flow's `FlowStep[]` is already a control-flow tree (call / loop /
 * branch / callback), so this is a straight recursive render with indentation: control structures
 * nest their bodies, branches nest one sub-list per path. A `call` whose target is an affected code
 * block is emphasised (amber rail) and wired to the graph — hovering lights that node, clicking
 * selects it — so the reader can trace a changed call straight onto the minimal graph.
 */

import type { FlowStep } from "@meridian/core";

export interface FlowStepTreeProps {
  steps: readonly FlowStep[];
  affectedIds: ReadonlySet<string>;
  resolveName: (id: string) => string;
  onHoverNode: (id: string | null) => void;
  onSelectNode: (id: string) => void;
  depth?: number;
}

export function FlowStepTree(props: FlowStepTreeProps) {
  const { steps } = props;
  if (steps.length === 0) {
    return <div style={EMPTY}>no calls or control flow</div>;
  }
  return (
    <ul style={LIST}>
      {steps.map((step, index) => (
        <StepRow key={index} step={step} {...props} />
      ))}
    </ul>
  );
}

function StepRow(props: { step: FlowStep } & FlowStepTreeProps) {
  const { step } = props;
  if (step.kind === "call") {
    return <CallRow {...props} step={step} />;
  }
  if (step.kind === "branch") {
    return <BranchRow {...props} step={step} />;
  }
  if (step.kind === "exit") {
    // A return/throw/break terminal — no body; render as a muted cap.
    return (
      <li style={ITEM}>
        <div style={CONTROL_LABEL}>
          <span style={GLYPH}>◼</span>
          <span style={EXIT_TEXT}>{step.label ?? step.variant}</span>
        </div>
      </li>
    );
  }
  // loop | callback: a labelled control node with a nested body.
  return (
    <li style={ITEM}>
      <div style={CONTROL_LABEL}>
        <span style={GLYPH}>{step.kind === "loop" ? "↻" : "⇢"}</span>
        <span style={CONTROL_TEXT}>{step.label}</span>
      </div>
      <NestedBody {...props} body={step.body} />
    </li>
  );
}

function CallRow(props: { step: Extract<FlowStep, { kind: "call" }> } & FlowStepTreeProps) {
  const { step, affectedIds, resolveName, onHoverNode, onSelectNode } = props;
  const target = step.target;
  const isChanged = target !== null && affectedIds.has(target);
  const clickable = target !== null && step.resolution === "resolved";
  const name = target !== null && step.resolution === "resolved" ? resolveName(target) : step.label;
  return (
    <li style={ITEM}>
      <div
        style={{ ...CALL_ROW, ...(isChanged ? CALL_CHANGED : null), cursor: clickable ? "pointer" : "default" }}
        onMouseEnter={() => isChanged && onHoverNode(target)}
        onMouseLeave={() => isChanged && onHoverNode(null)}
        onClick={() => clickable && isChanged && onSelectNode(target)}
        title={name}
      >
        <span style={GLYPH}>▸</span>
        <span style={{ ...CALL_TEXT, ...(isChanged ? { color: "#E6C07A", fontWeight: 600 } : null) }}>{name}</span>
        {step.resolution !== "resolved" && <span style={RES_CHIP}>{step.resolution}</span>}
        {isChanged && <span style={CHANGED_CHIP}>changed</span>}
      </div>
    </li>
  );
}

function BranchRow(props: { step: Extract<FlowStep, { kind: "branch" }> } & FlowStepTreeProps) {
  const { step } = props;
  return (
    <li style={ITEM}>
      <div style={CONTROL_LABEL}>
        <span style={GLYPH}>◆</span>
        <span style={CONTROL_TEXT}>{step.label}</span>
      </div>
      <ul style={LIST}>
        {step.paths.map((path, index) => (
          <li key={index} style={ITEM}>
            <div style={PATH_LABEL}>{path.label}</div>
            <NestedBody {...props} body={path.body} />
          </li>
        ))}
      </ul>
    </li>
  );
}

function NestedBody(props: FlowStepTreeProps & { body: readonly FlowStep[] }) {
  const { body, ...rest } = props;
  if (body.length === 0) {
    return null;
  }
  return <FlowStepTree {...rest} steps={body} depth={(props.depth ?? 0) + 1} />;
}

const LIST: React.CSSProperties = {
  listStyle: "none",
  margin: 0,
  paddingLeft: 14,
  borderLeft: "1px solid #232935",
  display: "flex",
  flexDirection: "column",
  gap: 3,
};
const ITEM: React.CSSProperties = { margin: 0 };
const CALL_ROW: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "2px 6px",
  borderRadius: 5,
  borderLeft: "2px solid transparent",
};
const CALL_CHANGED: React.CSSProperties = { borderLeft: "2px solid #D29922", background: "rgba(210,153,34,0.08)" };
const CONTROL_LABEL: React.CSSProperties = { display: "flex", alignItems: "center", gap: 6, padding: "2px 4px" };
const PATH_LABEL: React.CSSProperties = { fontSize: 11, color: "#7D8695", padding: "2px 4px", fontStyle: "italic" };
const GLYPH: React.CSSProperties = { fontSize: 10, color: "#5A6472", width: 12, textAlign: "center", flexShrink: 0 };
const CALL_TEXT: React.CSSProperties = {
  fontSize: 12,
  color: "#C9D3DF",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};
const CONTROL_TEXT: React.CSSProperties = { fontSize: 12, color: "#9AA4B2", fontWeight: 500 };
const EXIT_TEXT: React.CSSProperties = { fontSize: 11, color: "#7D8695", fontStyle: "italic" };
const RES_CHIP: React.CSSProperties = {
  fontSize: 9,
  color: "#7D8695",
  border: "1px solid #2A2F37",
  borderRadius: 4,
  padding: "0 4px",
  textTransform: "uppercase",
  letterSpacing: 0.3,
};
const CHANGED_CHIP: React.CSSProperties = {
  fontSize: 9,
  fontWeight: 700,
  color: "#E6C07A",
  border: "1px solid #5A4A22",
  borderRadius: 4,
  padding: "0 4px",
  textTransform: "uppercase",
  letterSpacing: 0.3,
};
const EMPTY: React.CSSProperties = { fontSize: 11, color: "#5A6472", fontStyle: "italic", padding: "2px 0" };
