/**
 * A promise lifetime is not an execution edge. It leaves a launch socket, runs in a quiet lane
 * below the ordinary ivory thread, and is consumed by a later await/barrier socket. Drawing it as a
 * separate rail keeps "work is alive" distinct from "the current frame executes next".
 */

import { useState } from "react";
import { BaseEdge, type EdgeProps } from "@xyflow/react";
import { FLOW_COLORS } from "../../derive/flowViewModel";
import { LOGIC_ASYNC_EDGE_TYPE, type LogicRfEdgeData } from "../../layout/logicElk";
import { COLLAPSIBLE_LOGIC_EDGE_TYPE, CollapsibleLogicEdge, EdgeCollapseControl } from "./CollapsibleLogicEdge";

export const ASYNC_RAIL_EDGE_TYPE = LOGIC_ASYNC_EDGE_TYPE;

export function AsyncRailEdge({ id, sourceX, sourceY, targetX, targetY, style, interactionWidth, data }: EdgeProps) {
  const [edgeHovered, setEdgeHovered] = useState(false);
  const [controlActive, setControlActive] = useState(false);
  const active = edgeHovered || controlActive;
  const orientation = (data as LogicRfEdgeData | undefined)?.orientation ?? "horizontal";
  const geometry = orientation === "horizontal"
    ? horizontalRailGeometry(id, sourceX, sourceY, targetX, targetY)
    : verticalRailGeometry(id, sourceX, sourceY, targetX, targetY);
  const { path } = geometry;
  const stroke = (style?.stroke as string | undefined) ?? FLOW_COLORS.awaited;
  // Selection paint arrives through the edge style just like it does for ordinary exec wires.
  // Preserve its width/opacity instead of pinning every async rail to the default costume.
  const strokeWidth = style?.strokeWidth ?? 2.25;
  const numericStrokeWidth = typeof strokeWidth === "number" ? strokeWidth : 2.25;
  const opacity = style?.opacity ?? 0.92;
  const washOpacity = typeof opacity === "number" ? opacity * 0.1 : 0.09;
  return (
    <>
      <g onPointerEnter={() => setEdgeHovered(true)} onPointerLeave={() => setEdgeHovered(false)}>
        <BaseEdge
          id={`${id}:wash`}
          path={path}
          interactionWidth={0}
          style={{ stroke, strokeWidth: active ? 10 : 8, opacity: active ? 0.18 : washOpacity, filter: `drop-shadow(0 0 4px ${stroke})` }}
        />
        <BaseEdge
          id={id}
          path={path}
          interactionWidth={interactionWidth ?? 18}
          style={{ ...style, stroke, strokeWidth: active ? numericStrokeWidth + 0.8 : strokeWidth, opacity }}
        />
      </g>
      <circle cx={sourceX} cy={sourceY} r={4.25} fill={stroke} opacity={opacity} pointerEvents="none" />
      <circle cx={targetX} cy={targetY} r={4.25} fill="#0B0E13" stroke={stroke} strokeWidth={2} opacity={opacity} pointerEvents="none" />
      <EdgeCollapseControl
        edgeId={id}
        x={geometry.labelX}
        y={geometry.labelY}
        data={data as LogicRfEdgeData | undefined}
        edgeHovered={active}
        accent={stroke}
        onActiveChange={setControlActive}
      />
    </>
  );
}

function horizontalRailGeometry(id: string, sourceX: number, sourceY: number, targetX: number, targetY: number): { path: string; labelX: number; labelY: number } {
  const direction = targetX >= sourceX ? 1 : -1;
  const run = Math.abs(targetX - sourceX);
  const shoulder = Math.min(18, Math.max(8, run * 0.08));
  const laneY = Math.max(sourceY, targetY) + 34 + railLane(id) * 14;
  const path = [
    `M ${sourceX} ${sourceY}`,
    `L ${sourceX} ${laneY - shoulder}`,
    `Q ${sourceX} ${laneY} ${sourceX + direction * shoulder} ${laneY}`,
    `L ${targetX - direction * shoulder} ${laneY}`,
    `Q ${targetX} ${laneY} ${targetX} ${laneY - shoulder}`,
    `L ${targetX} ${targetY}`,
  ].join(" ");
  return { path, labelX: (sourceX + targetX) / 2, labelY: laneY };
}

function verticalRailGeometry(id: string, sourceX: number, sourceY: number, targetX: number, targetY: number): { path: string; labelX: number; labelY: number } {
  const direction = targetY >= sourceY ? 1 : -1;
  const run = Math.abs(targetY - sourceY);
  const shoulder = Math.min(18, Math.max(8, run * 0.08));
  const laneX = Math.max(sourceX, targetX) + 34 + railLane(id) * 14;
  const path = [
    `M ${sourceX} ${sourceY}`,
    `L ${laneX - shoulder} ${sourceY}`,
    `Q ${laneX} ${sourceY} ${laneX} ${sourceY + direction * shoulder}`,
    `L ${laneX} ${targetY - direction * shoulder}`,
    `Q ${laneX} ${targetY} ${laneX - shoulder} ${targetY}`,
    `L ${targetX} ${targetY}`,
  ].join(" ");
  return { path, labelX: laneX, labelY: (sourceY + targetY) / 2 };
}

function railLane(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  return Math.abs(hash) % 3;
}

export const logicEdgeTypes = {
  [ASYNC_RAIL_EDGE_TYPE]: AsyncRailEdge,
  [COLLAPSIBLE_LOGIC_EDGE_TYPE]: CollapsibleLogicEdge,
};
