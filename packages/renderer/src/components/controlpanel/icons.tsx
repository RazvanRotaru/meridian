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

export function ChevronLeftIcon({ size = 16 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <path d="m15 18-6-6 6-6" />
    </svg>
  );
}

export function ChevronRightIcon({ size = 16 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}

/** GitHub-style pull-request glyph: two rails, a branch dot, and a merge curve. */
export function PullRequestIcon({ size = 16 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <circle cx="6" cy="6" r="2.4" />
      <circle cx="6" cy="18" r="2.4" />
      <circle cx="18" cy="18" r="2.4" />
      <path d="M6 8.4v7.2M18 15.6V11a3 3 0 0 0-3-3h-3" />
      <path d="m13.5 5.5 -1.5 2.5 3 0" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function ExternalLinkIcon({ size = 15 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <path d="M14 4h6v6M20 4l-8 8M18 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h6" />
    </svg>
  );
}
