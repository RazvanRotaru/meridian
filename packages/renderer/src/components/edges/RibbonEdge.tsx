/**
 * RibbonEdge — the striped CABLE for a multi-kind pair (see layout/parallelWires.ts). One
 * geometry, the colours inside it: each folded strand draws as a tight parallel sub-stroke in its
 * kind's colour, keeping its OWN emphasis opacity (a selection lighting only `calls` brightens
 * just that stripe), packed edge-to-edge so the stack reads as one striped band — never as
 * separate overlapping wires. Stripes offset PERPENDICULAR to the cable so the band keeps its
 * width on diagonal runs. The heaviest strand rides mid-cable (parallelWires seats it there) and
 * carries the single arrowhead; a transparent spine centred on the cable carries the hit area and
 * the direction pulse. Stripe width is uniform — inside a cable, weight speaks through the
 * tooltip's/inspector's ×N, not width (varying widths would break the band's packing).
 *
 * Cross-package cables keep the dash vocabulary, but per-stripe dashes can NEVER share a phase
 * (parallel curves differ in length — the dashes weave into a checker). Instead the stripes draw
 * solid inside an SVG MASK that cuts aligned gaps across the whole band at once: the cable dashes
 * as a unit, and the gaps are TRANSPARENT — wires crossing underneath show through, nothing on
 * the canvas is painted over.
 */

import { BaseEdge, getBezierPath, type EdgeProps } from "@xyflow/react";
import { weightOf, type RibbonEdgeData } from "../../layout/parallelWires";
import { WirePulse } from "./WireEdge";

/** Stripe geometry: width ≥ pitch so neighbouring stripes touch — one band, not parallel lines. */
const STRIPE_PITCH = 2.2;
const STRIPE_WIDTH = 2.4;
/** Notch rhythm: short transparent cuts, long visible cable segments. */
const NOTCH_DASH = "4 12";

export function RibbonEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, data, interactionWidth }: EdgeProps) {
  const ribbon = data as RibbonEdgeData;
  const members = ribbon.members ?? [];
  const center = (members.length - 1) / 2;
  const markerIndex = members.reduce((heaviest, member, index) => (weightOf(member) > weightOf(members[heaviest]) ? index : heaviest), 0);
  const [spine] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  const anyLit = ribbon.boosted === true || members.some((member) => (member.style as { opacity?: number } | undefined)?.opacity === 1);
  const crossFrame = members.some((member) => (member.data as { crossFrame?: boolean } | undefined)?.crossFrame === true);
  const bandWidth = members.length * STRIPE_PITCH + 1.2;
  const maskId = `ribbon-notch-${id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  const dx = targetX - sourceX;
  const dy = targetY - sourceY;
  const straightSpan = Math.hypot(dx, dy) || 1;
  const normalX = -dy / straightSpan;
  const normalY = dx / straightSpan;
  const stripes = members.map((member, index) => {
    const offset = (index - center) * STRIPE_PITCH;
    const [path] = getBezierPath({
      sourceX: sourceX + normalX * offset,
      sourceY: sourceY + normalY * offset,
      targetX: targetX + normalX * offset,
      targetY: targetY + normalY * offset,
      sourcePosition,
      targetPosition,
    });
    // Stripes always draw SOLID — the boundary dash is the notch mask's job.
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
  });
  return (
    <>
      {crossFrame ? (
        <>
          {/* The NOTCH mask: a white band along the spine keeps the cable, a black dashed stroke
              cuts aligned TRANSPARENT gaps through every stripe at once — the cable's "crosses a
              package boundary" dash, without painting over anything beneath it. */}
          <mask id={maskId} maskUnits="userSpaceOnUse" x={Math.min(sourceX, targetX) - 80} y={Math.min(sourceY, targetY) - 80} width={Math.abs(dx) + 160} height={Math.abs(dy) + 160}>
            <path d={spine} fill="none" stroke="#fff" strokeWidth={bandWidth + 2} />
            <path d={spine} fill="none" stroke="#000" strokeWidth={bandWidth + 2} strokeDasharray={NOTCH_DASH} />
            {/* The arrowhead zone stays whole — a notch landing on the tip would clip the marker. */}
            <circle cx={targetX} cy={targetY} r={18} fill="#fff" />
          </mask>
          <g mask={`url(#${maskId})`}>{stripes}</g>
        </>
      ) : (
        stripes
      )}
      {/* The invisible spine: one hit area for the whole cable, and the direction pulse's track. */}
      <BaseEdge id={id} path={spine} style={SPINE} interactionWidth={interactionWidth ?? 16} />
      <WirePulse path={spine} style={{ opacity: anyLit ? 1 : 0, strokeWidth: bandWidth }} data={{ pulse: ribbon.pulse }} />
    </>
  );
}

const SPINE: React.CSSProperties = { stroke: "transparent", strokeWidth: 1 };
