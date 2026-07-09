/**
 * Tiny inline stroke icons for the control panel. Each inherits `currentColor` so the button that
 * hosts it decides the hue. Kept as bare SVGs (no icon dependency) to stay in the browser bundle.
 */

type IconProps = { size?: number };

function svgProps(size: number) {
  return {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none" as const,
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
}

/** Four corners pushing OUT — "expand all". */
export function ExpandIcon({ size = 15 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5" />
    </svg>
  );
}

/** Four corners pulling IN — "collapse all". */
export function CollapseIcon({ size = 15 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <path d="M3 8h5V3M21 8h-5V3M3 16h5v5M21 16h-5v5" />
    </svg>
  );
}

export function ChevronDownIcon({ size = 14 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}
