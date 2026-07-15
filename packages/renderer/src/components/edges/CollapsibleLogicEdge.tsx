import { useEffect, useState } from "react";
import { MinusCircledIcon, MinusIcon } from "@radix-ui/react-icons";
import {
  BaseEdge,
  EdgeLabelRenderer,
  EdgeToolbar,
  getSmoothStepPath,
  type EdgeProps,
} from "@xyflow/react";
import type { LogicRfEdgeData } from "../../layout/logicElk";
import {
  handoffLogicEdgeDisclosureFocus,
  useLogicEdgeCollapseAction,
} from "./LogicEdgeActionScope";

export const COLLAPSIBLE_LOGIC_EDGE_TYPE = "logicCollapsible";

export function CollapsibleLogicEdge(props: EdgeProps) {
  const {
    id,
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    style,
    markerEnd,
    interactionWidth,
    label,
    labelStyle,
    data,
  } = props;
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });
  const [edgeHovered, setEdgeHovered] = useState(false);
  const [controlActive, setControlActive] = useState(false);
  const active = edgeHovered || controlActive;
  const accent = typeof style?.stroke === "string" ? style.stroke : "#C8D3E0";
  const baseStrokeWidth = typeof style?.strokeWidth === "number" ? style.strokeWidth : 2;
  const labelText = typeof label === "string" || typeof label === "number" ? String(label) : null;
  return (
    <>
      <g onPointerEnter={() => setEdgeHovered(true)} onPointerLeave={() => setEdgeHovered(false)}>
        <BaseEdge
          id={id}
          path={path}
          style={active
            ? {
                ...style,
                strokeWidth: baseStrokeWidth + 0.8,
                filter: `drop-shadow(0 0 4px ${accent})`,
              }
            : style}
          markerEnd={markerEnd}
          interactionWidth={interactionWidth ?? 22}
        />
      </g>
      <EdgeCollapseControl
        edgeId={id}
        x={labelX}
        y={labelY}
        data={data as LogicRfEdgeData | undefined}
        label={labelText}
        labelStyle={labelStyle}
        edgeHovered={active}
        accent={accent}
        onActiveChange={setControlActive}
      />
    </>
  );
}

/** Shared midpoint disclosure for ordinary exec/branch edges and async correlation rails. */
export function EdgeCollapseControl({
  edgeId,
  x,
  y,
  data,
  label,
  labelStyle,
  edgeHovered = false,
  accent = "#C8D3E0",
  onActiveChange,
}: {
  edgeId: string;
  x: number;
  y: number;
  data?: LogicRfEdgeData;
  label?: string | null;
  labelStyle?: React.CSSProperties;
  edgeHovered?: boolean;
  accent?: string;
  onActiveChange?: (active: boolean) => void;
}) {
  const toggleCollapse = useLogicEdgeCollapseAction();
  const collapseKey = data?.collapseKey;
  const collapsible = data?.collapsible === true && collapseKey !== undefined && toggleCollapse !== null;
  const [controlHovered, setControlHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    onActiveChange?.(controlHovered || focused);
  }, [controlHovered, focused, onActiveChange]);
  if (!label && !collapsible) {
    return null;
  }
  const role = data?.branchRole;
  const pathLabel = label ? `${label} path` : data?.kind === "async" ? "async rail" : "flow path";
  const persistentBranchCue = collapsible && data?.kind === "branch" && label !== null && label !== undefined;
  const title = persistentBranchCue ? `Collapse only the ${pathLabel}` : `Collapse ${pathLabel}`;
  const emphasized = edgeHovered || controlHovered || focused;
  const visible = persistentBranchCue || emphasized;
  return (
    <>
      {label && !persistentBranchCue ? (
        <EdgeLabelRenderer>
          <span
            style={{
              position: "absolute",
              transform: `translate(-50%, -50%) translate(${x}px, ${y}px)`,
              padding: "2px 5px",
              borderRadius: 5,
              background: "rgba(18,23,30,0.92)",
              pointerEvents: "none",
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              fontSize: 10,
              fontWeight: 650,
              opacity: emphasized ? 0 : 1,
              transition: "opacity 120ms ease",
              ...labelStyle,
            }}
          >
            {label}
          </span>
        </EdgeLabelRenderer>
      ) : null}
      {collapsible ? (
        <EdgeToolbar
          edgeId={edgeId}
          x={x}
          y={y}
          isVisible
          style={{ pointerEvents: visible ? "all" : "none" }}
        >
          <div
            className="nodrag nopan"
            style={{
              pointerEvents: visible ? "all" : "none",
            }}
          >
            <button
              type="button"
              aria-label={title}
              aria-expanded="true"
              title={title}
              data-logic-edge-disclosure="true"
              data-edge-disclosure-state="expanded"
              data-edge-role={role}
              data-edge-collapse-key={collapseKey}
              data-edge-fold-cue={persistentBranchCue ? "persistent-branch" : "hover"}
              onPointerEnter={() => setControlHovered(true)}
              onPointerLeave={() => setControlHovered(false)}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              onClick={(event) => {
                event.stopPropagation();
                toggleCollapse(collapseKey);
                if (event.detail === 0) {
                  handoffLogicEdgeDisclosureFocus(collapseKey, "collapsed");
                }
              }}
              onDoubleClick={(event) => event.stopPropagation()}
              style={{
                minWidth: 26,
                height: 26,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 5,
                padding: label ? "0 7px 0 8px" : 0,
                border: `1px solid ${emphasized ? accent : persistentBranchCue ? `${accent}70` : "transparent"}`,
                borderRadius: 7,
                background: emphasized
                  ? "rgba(11, 14, 19, 0.96)"
                  : persistentBranchCue
                    ? "rgba(18, 23, 30, 0.92)"
                    : "transparent",
                color: emphasized ? accent : persistentBranchCue ? `${accent}D6` : "transparent",
                boxShadow: focused
                  ? "0 0 0 2px #0B0E13, 0 0 0 4px #7DD3FC"
                  : emphasized
                    ? `0 3px 12px rgba(0,0,0,0.48), 0 0 8px ${accent}30`
                    : persistentBranchCue
                      ? "0 1px 4px rgba(0,0,0,0.32)"
                      : "none",
                opacity: visible ? 1 : 0,
                pointerEvents: visible ? "auto" : "none",
                transform: visible ? "scale(1)" : "scale(0.82)",
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                fontSize: 10,
                fontWeight: 700,
                lineHeight: 1,
                cursor: "pointer",
                outline: "none",
                transition: "opacity 120ms ease, transform 120ms ease, border-color 120ms ease, background 120ms ease",
              }}
            >
              {label ? <span>{label}</span> : null}
              {persistentBranchCue ? (
                <>
                  <span
                    aria-hidden="true"
                    style={{
                      width: 1,
                      height: 12,
                      background: emphasized ? `${accent}80` : `${accent}45`,
                    }}
                  />
                  <MinusCircledIcon width={13} height={13} aria-hidden="true" />
                </>
              ) : (
                <MinusIcon width={14} height={14} aria-hidden="true" />
              )}
            </button>
          </div>
        </EdgeToolbar>
      ) : null}
    </>
  );
}
