/**
 * BundledEdge — a custom React Flow edge type for "highway" bundles.
 *
 * Renders a thick smooth bezier curve whose width encodes the number of constituent relationships.
 * On hover, a tooltip shows the breakdown (e.g. "5 calls · 2 extends"). The edge uses the dominant
 * relationship colour and dashes when crossing a package boundary.
 */

import { type EdgeProps, getBezierPath } from "@xyflow/react";
import { useState } from "react";
import { bundleLabel, bundleWidth, type BundleEdgeData } from "../../layout/edgeBundling";

export function BundledEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style = {},
  data,
}: EdgeProps) {
  const [hovered, setHovered] = useState(false);
  const bundle = data as BundleEdgeData;

  const [edgePath] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });

  const strokeWidth = (style.strokeWidth as number) ?? bundleWidth(bundle.count);
  const stroke = (style.stroke as string) ?? "#8B95A3";
  const opacity = hovered ? Math.min((style.opacity as number ?? 0.4) + 0.3, 1) : (style.opacity as number ?? 0.4);
  const dash = style.strokeDasharray as string | undefined;

  const label = bundleLabel(bundle.breakdown);

  return (
    <g
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Invisible wider hit area for easier hover */}
      <path
        d={edgePath}
        fill="none"
        stroke="transparent"
        strokeWidth={strokeWidth + 12}
        style={{ cursor: "pointer" }}
      />
      {/* The visible highway curve */}
      <path
        id={id}
        d={edgePath}
        fill="none"
        stroke={stroke}
        strokeWidth={strokeWidth}
        strokeOpacity={opacity}
        strokeDasharray={dash}
        strokeLinecap="round"
        style={{ transition: "stroke-opacity 0.15s ease, stroke-width 0.15s ease" }}
      />
      {/* Count badge at the midpoint */}
      <text
        x={(sourceX + targetX) / 2}
        y={(sourceY + targetY) / 2 - strokeWidth / 2 - 6}
        textAnchor="middle"
        style={{
          fontSize: 9,
          fontFamily: "var(--font-mono, monospace)",
          fill: stroke,
          opacity: hovered ? 1 : 0.6,
          transition: "opacity 0.15s ease",
          pointerEvents: "none",
          userSelect: "none",
        }}
      >
        {bundle.count}
      </text>
      {/* Hover tooltip with breakdown */}
      {hovered && (
        <foreignObject
          x={(sourceX + targetX) / 2 - 80}
          y={(sourceY + targetY) / 2 - strokeWidth / 2 - 34}
          width={160}
          height={24}
          style={{ overflow: "visible", pointerEvents: "none" }}
        >
          <div
            style={{
              background: "rgba(22, 27, 34, 0.95)",
              border: "1px solid #30363d",
              borderRadius: 6,
              padding: "3px 8px",
              fontSize: 10,
              fontFamily: "var(--font-mono, monospace)",
              color: "#e6edf3",
              whiteSpace: "nowrap",
              textAlign: "center",
              width: "fit-content",
              margin: "0 auto",
            }}
          >
            {label}
          </div>
        </foreignObject>
      )}
    </g>
  );
}
