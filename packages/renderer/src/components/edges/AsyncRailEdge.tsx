/**
 * A promise lifetime is not an execution edge. It leaves a launch socket, runs in a quiet lane
 * below the ordinary ivory thread, and is consumed by a later await/barrier socket. Drawing it as a
 * separate rail keeps "work is alive" distinct from "the current frame executes next".
 */

import { BaseEdge, type EdgeProps } from "@xyflow/react";
import { FLOW_COLORS } from "../../derive/flowViewModel";
import { LOGIC_ASYNC_EDGE_TYPE, type LogicRfEdgeData } from "../../layout/logicElk";

export const ASYNC_RAIL_EDGE_TYPE = LOGIC_ASYNC_EDGE_TYPE;

export function AsyncRailEdge({ id, sourceX, sourceY, targetX, targetY, style, interactionWidth, data }: EdgeProps) {
  const orientation = (data as LogicRfEdgeData | undefined)?.orientation ?? "horizontal";
  const path = orientation === "horizontal"
    ? horizontalRailPath(id, sourceX, sourceY, targetX, targetY)
    : verticalRailPath(id, sourceX, sourceY, targetX, targetY);
  const stroke = (style?.stroke as string | undefined) ?? FLOW_COLORS.awaited;
  // Selection paint arrives through the edge style just like it does for ordinary exec wires.
  // Preserve its width/opacity instead of pinning every async rail to the default costume.
  const strokeWidth = style?.strokeWidth ?? 2.25;
  const opacity = style?.opacity ?? 0.92;
  const washOpacity = typeof opacity === "number" ? opacity * 0.1 : 0.09;
  return (
    <>
      <BaseEdge
        id={`${id}:wash`}
        path={path}
        interactionWidth={0}
        style={{ stroke, strokeWidth: 8, opacity: washOpacity, filter: `drop-shadow(0 0 4px ${stroke})` }}
      />
      <BaseEdge
        id={id}
        path={path}
        interactionWidth={interactionWidth ?? 16}
        style={{ ...style, stroke, strokeWidth, opacity }}
      />
      <circle cx={sourceX} cy={sourceY} r={4.25} fill={stroke} opacity={opacity} pointerEvents="none" />
      <circle cx={targetX} cy={targetY} r={4.25} fill="#0B0E13" stroke={stroke} strokeWidth={2} opacity={opacity} pointerEvents="none" />
    </>
  );
}

function horizontalRailPath(id: string, sourceX: number, sourceY: number, targetX: number, targetY: number): string {
  const direction = targetX >= sourceX ? 1 : -1;
  const run = Math.abs(targetX - sourceX);
  const shoulder = Math.min(18, Math.max(8, run * 0.08));
  const laneY = Math.max(sourceY, targetY) + 34 + railLane(id) * 14;
  return [
    `M ${sourceX} ${sourceY}`,
    `L ${sourceX} ${laneY - shoulder}`,
    `Q ${sourceX} ${laneY} ${sourceX + direction * shoulder} ${laneY}`,
    `L ${targetX - direction * shoulder} ${laneY}`,
    `Q ${targetX} ${laneY} ${targetX} ${laneY - shoulder}`,
    `L ${targetX} ${targetY}`,
  ].join(" ");
}

function verticalRailPath(id: string, sourceX: number, sourceY: number, targetX: number, targetY: number): string {
  const direction = targetY >= sourceY ? 1 : -1;
  const run = Math.abs(targetY - sourceY);
  const shoulder = Math.min(18, Math.max(8, run * 0.08));
  const laneX = Math.max(sourceX, targetX) + 34 + railLane(id) * 14;
  return [
    `M ${sourceX} ${sourceY}`,
    `L ${laneX - shoulder} ${sourceY}`,
    `Q ${laneX} ${sourceY} ${laneX} ${sourceY + direction * shoulder}`,
    `L ${laneX} ${targetY - direction * shoulder}`,
    `Q ${laneX} ${targetY} ${laneX - shoulder} ${targetY}`,
    `L ${targetX} ${targetY}`,
  ].join(" ");
}

function railLane(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  return Math.abs(hash) % 3;
}

export const logicEdgeTypes = { [ASYNC_RAIL_EDGE_TYPE]: AsyncRailEdge };
