/**
 * The host for the ALTERNATE Logic-flow projections (metro / blocks / timeline). One shared base,
 * different views: it reads the SAME flow tree and navigation state the exec graph uses — the
 * charted root, the drill trail, the by-target selection — assembles the shared `FlowViewProps`,
 * and mounts the picked projection in a scrollable dark surface with the breadcrumb floating above.
 * Switching sub-views never re-derives or resets anything; it is a pure presentation switch.
 */

import { Fragment, useMemo } from "react";
import type { FlowPath, FlowStep, LogicFlows, NodeId } from "@meridian/core";
import { useBlueprint, useBlueprintActions } from "../../state/StoreContext";
import type { FlowViewProps, LogicViewMode } from "../../derive/flowViewModel";
import { FLOW_COLORS } from "../../derive/flowViewModel";
import { MetroView } from "./MetroView";
import { BlocksView } from "./BlocksView";
import { TimelineView } from "./TimelineView";

const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

export function AltLogicSurface(props: { rootId: NodeId; mode: Exclude<LogicViewMode, "graph"> }) {
  const artifact = useBlueprint((state) => state.artifact);
  const index = useBlueprint((state) => state.index);
  const logicStack = useBlueprint((state) => state.logicStack);
  const logicFocus = useBlueprint((state) => state.logicFocus);
  const logicSelected = useBlueprint((state) => state.logicSelected);
  const { drillLogicFlow, logicFlowTo, logicFocusTo, selectLogicTarget } = useBlueprintActions();

  const flows = (artifact.extensions?.logicFlow ?? {}) as unknown as LogicFlows;
  const steps = useMemo(
    () => focusedSteps(flows[props.rootId] ?? [], logicFocus),
    [flows, props.rootId, logicFocus],
  );
  const viewProps: FlowViewProps = {
    rootId: props.rootId,
    steps,
    flows,
    index,
    selected: logicSelected,
    onSelect: (target) => selectLogicTarget(target === logicSelected ? null : target),
    onDrill: (target) => drillLogicFlow(target),
  };

  return (
    <div style={SURFACE}>
      <div style={SCROLL} onClick={() => selectLogicTarget(null)}>
        {steps.length === 0 ? (
          <div style={EMPTY}>this callable has no calls or control flow of its own</div>
        ) : (
          // The floating Toolbar panel owns the top-left corner; the canvas-like projections start
          // drawing at x≈0, so they get left headroom or their entry/first lane hides beneath it.
          // Blocks centers its own column and needs none.
          <div style={props.mode === "blocks" ? undefined : CANVAS_HEADROOM}>
            <View mode={props.mode} viewProps={viewProps} />
          </div>
        )}
      </div>
      <Breadcrumb stack={logicStack} focus={logicFocus} index={index} onJump={logicFlowTo} onFocusJump={logicFocusTo} />
    </div>
  );
}

/**
 * The exec graph's container DIVE, honoured here too — the sub-views share ALL navigation state.
 * A dived single-body container (loop/callback) charts its body directly; a multi-arm container
 * (try) recharts as one synthetic branch step, so each projection renders the arms with its own
 * normal branch treatment instead of pretending they run in sequence.
 */
function focusedSteps(rootSteps: FlowStep[], focus: Array<{ label: string; bodies: FlowPath[] }>): FlowStep[] {
  const dive = focus[focus.length - 1];
  if (!dive) {
    return rootSteps;
  }
  if (dive.bodies.length === 1) {
    return dive.bodies[0].body;
  }
  return [{ kind: "branch", label: dive.label, paths: dive.bodies }];
}

function View({ mode, viewProps }: { mode: Exclude<LogicViewMode, "graph">; viewProps: FlowViewProps }) {
  if (mode === "metro") {
    return <MetroView {...viewProps} />;
  }
  if (mode === "blocks") {
    return <BlocksView {...viewProps} />;
  }
  return <TimelineView {...viewProps} />;
}

/** The same trail the exec graph shows — the callable drill stack PLUS any container dives — with
 * every non-final entry clickable-back. */
function Breadcrumb(props: {
  stack: NodeId[];
  focus: Array<{ id: string; label: string }>;
  index: FlowViewProps["index"];
  onJump: (id: NodeId) => void;
  onFocusJump: (index: number) => void;
}) {
  const crumbs = [
    ...props.stack.map((id, i) => ({
      key: id,
      label: props.index.nodesById.get(id)?.displayName ?? id,
      // The last callable is only "current" when no dive sits on top of it; jumping to it clears the dive.
      onClick: () => props.onJump(id),
      last: props.focus.length === 0 && i === props.stack.length - 1,
    })),
    ...props.focus.map((entry, i) => ({
      key: `f:${entry.id}`,
      label: entry.label,
      onClick: () => props.onFocusJump(i),
      last: i === props.focus.length - 1,
    })),
  ];
  return (
    <div style={CRUMB_BAR}>
      {crumbs.map((crumb, i) => (
        <Fragment key={crumb.key}>
          {i > 0 ? <span style={CRUMB_SEP}>›</span> : null}
          {crumb.last ? (
            <span style={CRUMB_CURRENT}>{crumb.label}</span>
          ) : (
            <button type="button" style={CRUMB_LINK} onClick={crumb.onClick}>
              {crumb.label}
            </button>
          )}
        </Fragment>
      ))}
    </div>
  );
}

const SURFACE: React.CSSProperties = { position: "relative", width: "100%", height: "100%", overflow: "hidden" };
const SCROLL: React.CSSProperties = {
  width: "100%",
  height: "100%",
  overflow: "auto",
  backgroundColor: FLOW_COLORS.canvas,
  backgroundImage: "radial-gradient(#1B2230 1px, transparent 1px)",
  backgroundSize: "22px 22px",
};
const EMPTY: React.CSSProperties = {
  margin: "120px auto",
  width: "fit-content",
  padding: "14px 22px",
  border: `1px solid ${FLOW_COLORS.faint}`,
  borderRadius: 8,
  color: FLOW_COLORS.dim,
  fontFamily: MONO,
  fontSize: 12,
  background: FLOW_COLORS.card,
};
const CANVAS_HEADROOM: React.CSSProperties = { paddingLeft: 352, width: "fit-content" };
// Bottom-left: the top-left corner belongs to the floating Toolbar panel in every view.
const CRUMB_BAR: React.CSSProperties = {
  position: "absolute",
  bottom: 12,
  left: 12,
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "6px 10px",
  borderRadius: 8,
  border: "1px solid #2A2F37",
  background: "rgba(14,17,22,0.92)",
  fontFamily: MONO,
  fontSize: 12,
  zIndex: 10,
};
const CRUMB_SEP: React.CSSProperties = { color: FLOW_COLORS.dim };
const CRUMB_CURRENT: React.CSSProperties = { color: "#E6EDF3", fontWeight: 600 };
const CRUMB_LINK: React.CSSProperties = {
  border: "none",
  background: "transparent",
  padding: 0,
  font: "inherit",
  color: "#8FB6E3",
  cursor: "pointer",
};
