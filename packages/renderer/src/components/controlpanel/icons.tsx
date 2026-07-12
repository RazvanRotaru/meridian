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

/** List rows with chevrons pushing outward — expand graph hierarchy, not fullscreen. */
export function ExpandIcon({ size = 15 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <path d="M3 5h8M3 12h8M3 19h8" />
      <path d="m15 8 3-3 3 3M15 16l3 3 3-3" />
    </svg>
  );
}

/** List rows with chevrons pulling inward — collapse the active hierarchy scope. */
export function CollapseIcon({ size = 15 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <path d="M3 5h8M3 12h8M3 19h8" />
      <path d="m15 5 3 3 3-3M15 19l3-3 3 3" />
    </svg>
  );
}

/** A scan frame — fit the current selection, or the whole graph when nothing is selected. */
export function RecenterIcon({ size = 15 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2" />
    </svg>
  );
}

/** Two linked cards — pull the selected nodes into their own focused subgraph. */
export function ExtractSelectionIcon({ size = 15 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <rect x="3" y="3" width="8" height="8" rx="2" />
      <path d="M7 11v4a2 2 0 0 0 2 2h4" />
      <rect x="13" y="13" width="8" height="8" rx="2" />
    </svg>
  );
}

/** Repository frame with lit cards — place the extracted code back in whole-codebase context. */
export function CodebaseHighlightIcon({ size = 15 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 9h18M8 4v5" />
      <rect x="7" y="12" width="4" height="4" rx="1" />
      <rect x="14" y="12" width="3" height="3" rx=".8" />
    </svg>
  );
}

/** Return from the frozen codebase overview to the curated extracted graph. */
export function BackToGraphIcon({ size = 15 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <path d="m9 7-5 5 5 5" />
      <path d="M4 12h10a6 6 0 0 1 6 6" />
    </svg>
  );
}

/** Four cards snapping into a grid — compact the extracted graph without changing its members. */
export function RearrangeIcon({ size = 15 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <rect x="3" y="3" width="6" height="6" rx="1.5" />
      <rect x="15" y="3" width="6" height="6" rx="1.5" />
      <rect x="3" y="15" width="6" height="6" rx="1.5" />
      <rect x="15" y="15" width="6" height="6" rx="1.5" />
      <path d="M9 6h6M6 9v6M18 9v6M9 18h6" />
    </svg>
  );
}

/** Counter-clockwise restore arrow — return the extracted graph to its seed members and positions. */
export function ResetIcon({ size = 15 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <path d="M4 8V4m0 0h4M4 4l3.2 3.2a8 8 0 1 1-2 8" />
    </svg>
  );
}

/** Close the temporary extracted graph and reveal the previous lens. */
export function CloseIcon({ size = 15 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <path d="M6 6l12 12M18 6 6 18" />
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

/** Circled information mark used for contextual, non-blocking explanations. */
export function InfoIcon({ size = 15 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5" />
      <path d="M12 8h.01" />
    </svg>
  );
}

/** Maximise — open the full-page view. Two opposing diagonal arrows to the corners. */
export function MaximizeIcon({ size = 15 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <path d="M14 4h6v6M20 4l-7 7M10 20H4v-6M4 20l7-7" />
    </svg>
  );
}
