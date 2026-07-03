/**
 * A blueprint wire rendered along its ELK-computed orthogonal route (rounded corners), so
 * wires flow AROUND boxes instead of slicing through them; edges without a route (never the
 * case after layout, but safe) fall back to a bezier.
 *
 * Two visual regimes:
 *
 * At REST every wire is quiet — thin, low-opacity, coloured and dashed by its kind (calls
 * solid steel, instantiates amber dots, extends/implements purple dashes, renders cyan) —
 * so a dense graph reads as texture, not noise. Weight still thickens a hot aggregate, an
 * unresolved wire stays extra dim, and telemetry reddens by the target's error rate.
 *
 * When a path trace is ACTIVE (a node or wire is selected), wires on the path light up in
 * direction colours (teal = downstream of the selection, violet = upstream) with a marching-
 * ants flow animation, and every other wire drops to a whisper. The dash pattern still tells
 * the kind while the colour tells the direction.
 */

import { BaseEdge, getBezierPath, type EdgeProps } from "@xyflow/react";
import { reddenByErrorRate } from "../../theme/telemetryColor";
import { PATH_DOWNSTREAM, PATH_UPSTREAM, wireStyleForKind } from "../../theme/edgeColors";
import { UI_EDGE_KIND } from "../../derive/edgeSelection";
import { useBlueprint } from "../../state/StoreContext";
import type { BlueprintEdge as BlueprintEdgeType, EdgeHighlight } from "../../layout/rfTypes";

const CORNER_RADIUS = 7;

export function BlueprintEdge(props: EdgeProps<BlueprintEdgeType>) {
  const [path, labelX, labelY] = routedPath(props);
  const targetMetrics = useBlueprint((state) => state.telemetry[props.target]);
  const resolved = props.data?.resolved ?? true;
  const highlight: EdgeHighlight = props.data?.highlight ?? "rest";
  const kindStyle = wireStyleForKind(props.data?.kind ?? "");
  const restColor = targetMetrics ? reddenByErrorRate(kindStyle.color, targetMetrics.errorRate) : kindStyle.color;
  const color = highlight === "down" ? PATH_DOWNSTREAM : highlight === "up" ? PATH_UPSTREAM : restColor;
  const showLabel = props.data?.kind === UI_EDGE_KIND && highlight !== "off";
  return (
    <BaseEdge
      id={props.id}
      path={path}
      markerEnd={props.markerEnd}
      style={wireStyle(color, kindStyle.dash, props.data?.weight ?? 1, resolved, highlight)}
      label={showLabel ? "renders" : undefined}
      labelX={labelX}
      labelY={labelY}
      labelStyle={showLabel ? rendersLabelStyle(color) : undefined}
    />
  );
}

/** The ELK orthogonal route with rounded corners; [path, labelX, labelY]. */
function routedPath(props: EdgeProps<BlueprintEdgeType>): [string, number, number] {
  const points = props.data?.points;
  if (!points || points.length < 2) {
    return getBezierPath(props);
  }
  const mid = midpointOf(points);
  return [roundedPolylinePath(points, CORNER_RADIUS), mid.x, mid.y];
}

/** Move-to start, then line into a small quadratic arc at every interior bend. */
function roundedPolylinePath(points: Array<{ x: number; y: number }>, radius: number): string {
  const commands: string[] = [`M ${points[0].x},${points[0].y}`];
  for (let i = 1; i < points.length - 1; i += 1) {
    const previous = points[i - 1];
    const corner = points[i];
    const next = points[i + 1];
    const inbound = clampedApproach(corner, previous, radius);
    const outbound = clampedApproach(corner, next, radius);
    commands.push(`L ${inbound.x},${inbound.y}`);
    commands.push(`Q ${corner.x},${corner.y} ${outbound.x},${outbound.y}`);
  }
  const last = points[points.length - 1];
  commands.push(`L ${last.x},${last.y}`);
  return commands.join(" ");
}

/** The point `radius` away from `corner` toward `toward` (clamped to half the segment). */
function clampedApproach(
  corner: { x: number; y: number },
  toward: { x: number; y: number },
  radius: number,
): { x: number; y: number } {
  const dx = toward.x - corner.x;
  const dy = toward.y - corner.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) {
    return corner;
  }
  const distance = Math.min(radius, length / 2);
  return { x: corner.x + (dx / length) * distance, y: corner.y + (dy / length) * distance };
}

/** The point halfway along the polyline by arc length (label anchor). */
function midpointOf(points: Array<{ x: number; y: number }>): { x: number; y: number } {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  let remaining = total / 2;
  for (let i = 1; i < points.length; i += 1) {
    const segment = Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    if (segment >= remaining && segment > 0) {
      const t = remaining / segment;
      return {
        x: points[i - 1].x + (points[i].x - points[i - 1].x) * t,
        y: points[i - 1].y + (points[i].y - points[i - 1].y) * t,
      };
    }
    remaining -= segment;
  }
  return points[Math.floor(points.length / 2)];
}

function wireStyle(
  color: string,
  kindDash: string | undefined,
  weight: number,
  resolved: boolean,
  highlight: EdgeHighlight,
): React.CSSProperties {
  const onPath = highlight === "down" || highlight === "up";
  const width = strokeWidthForWeight(weight) + (onPath ? 0.9 : 0);
  // An unresolved aggregate always reads dashed (honesty) even when its kind is solid.
  const dash = kindDash ?? (resolved ? undefined : "5 4");
  return {
    stroke: color,
    strokeWidth: width,
    strokeDasharray: onPath ? (dash ?? "9 5") : dash,
    opacity: opacityFor(highlight, resolved),
    // Marching ants along the flow direction, only for wires on the active path.
    animation: onPath ? "meridian-flow 0.9s linear infinite" : undefined,
    transition: "stroke 140ms, opacity 140ms",
  };
}

function opacityFor(highlight: EdgeHighlight, resolved: boolean): number {
  if (highlight === "off") {
    return 0.05;
  }
  if (highlight === "rest") {
    return resolved ? 0.32 : 0.16;
  }
  return 1;
}

function rendersLabelStyle(color: string): React.CSSProperties {
  return { fill: color, fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.4 };
}

function strokeWidthForWeight(weight: number): number {
  const scaled = 1.05 + Math.log2(weight + 1) * 0.45;
  return Math.min(3, Math.max(1.05, scaled));
}
