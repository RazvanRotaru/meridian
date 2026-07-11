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
import { isHiddenWire, WirePulse } from "./WireEdge";
import { WireLabel } from "./WireLabel";

/** Stripe geometry: width ≥ pitch so neighbouring stripes touch — one band, not parallel lines. */
const STRIPE_PITCH = 2.2;
const STRIPE_WIDTH = 2.4;
/** Notch rhythm: short transparent cuts, long visible cable segments. */
const NOTCH_DASH = "4 12";

export function RibbonEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, data, interactionWidth }: EdgeProps) {
  if (isHiddenWire(data)) {
    return null;
  }
  const ribbon = data as RibbonEdgeData;
  const members = ribbon.members ?? [];
  const center = (members.length - 1) / 2;
  const markerIndex = members.reduce((heaviest, member, index) => (weightOf(member) > weightOf(members[heaviest]) ? index : heaviest), 0);
  // A ROUTED cable (gutter-bus geometry from edgeRouting) can't offset stripes side-by-side — a
  // multi-segment rail path has no single perpendicular. It stripes CONCENTRICALLY instead: the
  // same path drawn widest-first in each kind's colour, heaviest as the core. One line, colours
  // inside it, any geometry.
  const routedPath = (data as { routedPath?: string }).routedPath;
  const [spine, labelX, labelY] = routedPath
    ? [routedPath, 0, 0]
    : getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  const anyLit = ribbon.boosted === true || members.some((member) => (member.style as { opacity?: number } | undefined)?.opacity === 1);
  const crossFrame = members.some((member) => (member.data as { crossFrame?: boolean } | undefined)?.crossFrame === true);
  const bandWidth = members.length * STRIPE_PITCH + 1.2;
  const maskId = `ribbon-notch-${id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  const dx = targetX - sourceX;
  const dy = targetY - sourceY;
  const straightSpan = Math.hypot(dx, dy) || 1;
  const normalX = -dy / straightSpan;
  const normalY = dx / straightSpan;
  const stripes = routedPath
    ? // CONCENTRIC stripes: heaviest-first order, widest drawn first — each lighter kind shows as
      // a ring around the core. Follows the rail's every corner because it IS the same path.
      [...members]
        .sort((a, b) => weightOf(b) - weightOf(a))
        .map((member, rank) => {
          const { strokeDasharray: _dash, ...style } = (member.style ?? {}) as React.CSSProperties;
          // rank 0 = heaviest = the NARROW core (drawn last); each lighter kind is a wider ring under it.
          const width = STRIPE_WIDTH + rank * STRIPE_PITCH * 2;
          return (
            <BaseEdge
              key={member.id}
              id={`${id}:${rank}`}
              path={routedPath}
              style={{ ...style, strokeWidth: width, opacity: ribbon.boosted ? 1 : style.opacity }}
              markerEnd={rank === 0 ? markerEnd : undefined}
              interactionWidth={0}
            />
          );
        })
        .reverse()
    : members.map((member, index) => {
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
          <mask id={maskId} maskUnits="userSpaceOnUse" x={Math.min(sourceX, targetX) - 200} y={Math.min(sourceY, targetY) - 200} width={Math.abs(dx) + 400} height={Math.abs(dy) + 400}>
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
      {routedPath ? null : (
        <WireLabel x={labelX} y={labelY} text={ribbonLabelText(members, markerIndex)} style={{ opacity: anyLit ? 1 : 0 }} data={{ pulse: ribbon.pulse }} color={dominantStrokeOf(members, markerIndex)} />
      )}
    </>
  );
}

/** The cable's chip leads with its dominant strand and counts the rest: `references ×7 +2`. */
function ribbonLabelText(members: RibbonEdgeData["members"], markerIndex: number): string {
  const dominant = members[markerIndex];
  const data = dominant?.data as { depKind?: string; category?: string; weight?: number } | undefined;
  const kind = data?.depKind ?? data?.category ?? "wire";
  const weight = data?.weight ?? 1;
  const rest = members.length - 1;
  return `${kind}${weight > 1 ? ` ×${weight}` : ""}${rest > 0 ? ` +${rest}` : ""}`;
}

function dominantStrokeOf(members: RibbonEdgeData["members"], markerIndex: number): string | undefined {
  return (members[markerIndex]?.style as { stroke?: string } | undefined)?.stroke;
}

const SPINE: React.CSSProperties = { stroke: "transparent", strokeWidth: 1 };
