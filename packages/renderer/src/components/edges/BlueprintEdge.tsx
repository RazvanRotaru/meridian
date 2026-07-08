/**
 * A blueprint-style bezier wire. Data flows source->target (arrowhead at the target). The
 * stroke thickens with log(weight) so a hot path reads heavier; an unresolved aggregate
 * renders dashed and dim (resolution honesty); and the wire reddens by the target's live
 * error rate when telemetry is present. A React "renders" wire wears a distinct cyan accent
 * plus a "renders" label so UI-composition mode is legible next to call wires.
 */

import { BaseEdge, getBezierPath, type EdgeProps } from "@xyflow/react";
import { reddenByErrorRate } from "../../theme/telemetryColor";
import { wireColorForKind } from "../../theme/edgeColors";
import { UI_EDGE_KIND } from "../../derive/edgeSelection";
import { useBlueprint } from "../../state/StoreContext";
import type { BlueprintEdge as BlueprintEdgeType } from "../../layout/rfTypes";

const SELECTED_WIRE = "#E6B84D";

export function BlueprintEdge(props: EdgeProps<BlueprintEdgeType>) {
  const [path, labelX, labelY] = getBezierPath(props);
  const targetMetrics = useBlueprint((state) => state.telemetry[props.target]);
  const selectedId = useBlueprint((state) => state.selectedId);
  const resolved = props.data?.resolved ?? true;
  const isRenders = props.data?.kind === UI_EDGE_KIND;
  const baseColor = wireColorForKind(props.data?.kind ?? "");
  const color = targetMetrics ? reddenByErrorRate(baseColor, targetMetrics.errorRate) : baseColor;
  const incident = selectedId != null && (props.source === selectedId || props.target === selectedId);
  const dimmed = selectedId != null && !incident;
  return (
    <BaseEdge
      id={props.id}
      path={path}
      markerEnd={props.markerEnd}
      style={wireStyle(color, props.data?.weight ?? 1, resolved, incident, dimmed, props.style)}
      label={isRenders ? "renders" : undefined}
      labelX={labelX}
      labelY={labelY}
      labelStyle={isRenders ? rendersLabelStyle(color) : undefined}
    />
  );
}

function wireStyle(
  color: string,
  weight: number,
  resolved: boolean,
  incident: boolean,
  dimmed: boolean,
  override: React.CSSProperties | undefined,
): React.CSSProperties {
  if (incident) {
    return {
      stroke: SELECTED_WIRE,
      strokeWidth: Math.max(2.5, strokeWidthForWeight(weight)),
      strokeDasharray: resolved ? undefined : "5 4",
      opacity: 1,
      ...override,
    };
  }
  return {
    stroke: color,
    strokeWidth: strokeWidthForWeight(weight),
    strokeDasharray: resolved ? undefined : "5 4",
    opacity: dimmed ? 0.12 : resolved ? 0.95 : 0.5,
    ...override,
  };
}

function rendersLabelStyle(color: string): React.CSSProperties {
  return { fill: color, fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.4 };
}

function strokeWidthForWeight(weight: number): number {
  const scaled = 1.1 + Math.log2(weight + 1);
  return Math.min(5, Math.max(1.1, scaled));
}
