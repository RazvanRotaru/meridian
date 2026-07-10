/**
 * RibbonEdge — the striped CABLE for a multi-kind pair (see layout/parallelWires.ts). One
 * geometry, the colours inside it: each folded strand draws as a tight parallel sub-stroke in its
 * kind's colour, keeping its OWN emphasis opacity (a selection lighting only `calls` brightens
 * just that stripe), packed edge-to-edge so the stack reads as one striped band — never as
 * separate overlapping wires. Stripes offset PERPENDICULAR to the cable so the band keeps its
 * width on diagonal runs. The heaviest strand rides mid-cable and carries the single arrowhead; a
 * transparent spine centred on the cable carries the hit area and the direction pulse.
 *
 * Cross-package cables keep the dash vocabulary, but per-stripe dashes can NEVER share a phase
 * (parallel curves differ in length — the dashes weave into a checker). So the stripes draw SOLID
 * and one background-coloured NOTCH path over the whole band cuts the gaps through every stripe
 * at once: the cable dashes as a unit, aligned by construction.
 */

import { BaseEdge, getBezierPath, type EdgeProps } from "@xyflow/react";
import type { RibbonEdgeData } from "../../layout/parallelWires";
import { WirePulse } from "./WireEdge";

/** Stripe geometry: width ≥ pitch so neighbouring stripes touch — one band, not parallel lines. */
const STRIPE_PITCH = 2.2;
const STRIPE_WIDTH = 2.4;
/** The canvas surface colour (ModuleMapView's SURFACE_STYLE): the notch cuts must read as gaps. */
const CANVAS_BG = "#0E1116";
/** Notch rhythm: short background cuts, long visible cable segments. */
const NOTCH_DASH = "4 12";

export function RibbonEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, data, interactionWidth }: EdgeProps) {
  const ribbon = data as RibbonEdgeData;
  const members = ribbon.members ?? [];
  const center = (members.length - 1) / 2;
  const markerIndex = Math.round(center); // members are lightest-first, so mid-cable ≈ heaviest
  const [spine] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  const anyLit = ribbon.boosted === true || members.some((member) => (member.style as { opacity?: number } | undefined)?.opacity === 1);
  const dominantStroke = (members[members.length - 1]?.style as { stroke?: string } | undefined)?.stroke ?? "#8B95A3";
  const crossFrame = members.some((member) => (member.data as { crossFrame?: boolean } | undefined)?.crossFrame === true);
  const dx = targetX - sourceX;
  const dy = targetY - sourceY;
  const straightSpan = Math.hypot(dx, dy) || 1;
  const normalX = -dy / straightSpan;
  const normalY = dx / straightSpan;
  return (
    <>
      {members.map((member, index) => {
        const offset = (index - center) * STRIPE_PITCH;
        const [path] = getBezierPath({
          sourceX: sourceX + normalX * offset,
          sourceY: sourceY + normalY * offset,
          targetX: targetX + normalX * offset,
          targetY: targetY + normalY * offset,
          sourcePosition,
          targetPosition,
        });
        // Stripes always draw SOLID — the boundary dash is the notch overlay's job (below).
        const { strokeDasharray: _dash, ...style } = (member.style ?? {}) as React.CSSProperties;
        return (
          <BaseEdge
            key={member.id}
            id={`${id}:${index}`}
            path={path}
            style={{ ...style, strokeWidth: STRIPE_WIDTH, opacity: ribbon.boosted ? 1 : style.opacity }}
            markerEnd={index === markerIndex ? markerEnd : undefined}
            interactionWidth={0}
          />
        );
      })}
      {crossFrame ? (
        // The NOTCH overlay: one canvas-coloured dashed path as wide as the whole band, cutting
        // aligned gaps through every stripe — the cable's "crosses a package boundary" dash.
        <BaseEdge
          id={`${id}:notch`}
          path={spine}
          style={{ stroke: CANVAS_BG, strokeWidth: members.length * STRIPE_PITCH + 1.2, strokeDasharray: NOTCH_DASH, opacity: 1 }}
          interactionWidth={0}
        />
      ) : null}
      {/* The invisible spine: one hit area for the whole cable, and the direction pulse's track. */}
      <BaseEdge id={id} path={spine} style={SPINE} interactionWidth={interactionWidth ?? 16} />
      <WirePulse path={spine} style={{ opacity: anyLit ? 1 : 0, stroke: dominantStroke }} data={{ pulse: ribbon.pulse }} />
    </>
  );
}

const SPINE: React.CSSProperties = { stroke: "transparent", strokeWidth: 1 };
