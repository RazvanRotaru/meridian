import {
  DEFAULT_SOURCE_DOCK_RATIO,
  MAX_SOURCE_DOCK_RATIO,
  MIN_SOURCE_DOCK_RATIO,
} from "../../state/sourceDockPreference";

export const MIN_SOURCE_DOCK_WIDTH = 520;
export const MIN_SOURCE_CONTEXT_WIDTH = 260;

export interface SourceDockRatioBounds {
  minRatio: number;
  maxRatio: number;
}

export interface SourceDockMetrics extends SourceDockRatioBounds {
  /** Rounded once and shared by CSS width plus every ARIA value. */
  minPercent: number;
  maxPercent: number;
  valuePercent: number;
  effectiveRatio: number;
  renderedWidth: number | null;
}

/**
 * Resolve the usable dock interval for the live shell width. When both pixel minimums fit, retain
 * them together with the product's proportional bounds. When they cannot fit, shrink dock and
 * context by the same factor instead of arbitrarily sacrificing either surface.
 */
export function sourceDockRatioBounds(containerWidth: number): SourceDockRatioBounds {
  if (!validContainerWidth(containerWidth)) {
    return { minRatio: MIN_SOURCE_DOCK_RATIO, maxRatio: MAX_SOURCE_DOCK_RATIO };
  }

  const requiredWidth = MIN_SOURCE_DOCK_WIDTH + MIN_SOURCE_CONTEXT_WIDTH;
  if (containerWidth < requiredWidth) {
    const proportionalRatio = MIN_SOURCE_DOCK_WIDTH / requiredWidth;
    return { minRatio: proportionalRatio, maxRatio: proportionalRatio };
  }

  const minRatio = Math.max(MIN_SOURCE_DOCK_RATIO, MIN_SOURCE_DOCK_WIDTH / containerWidth);
  const maxRatio = Math.min(MAX_SOURCE_DOCK_RATIO, 1 - (MIN_SOURCE_CONTEXT_WIDTH / containerWidth));
  return minRatio <= maxRatio
    ? { minRatio, maxRatio }
    : { minRatio, maxRatio: minRatio };
}

export function sourceDockRatioForWidth(dockWidth: number, containerWidth: number): number {
  const bounds = sourceDockRatioBounds(containerWidth);
  if (!Number.isFinite(dockWidth) || !validContainerWidth(containerWidth)) {
    return constrainSourceDockRatio(DEFAULT_SOURCE_DOCK_RATIO, bounds);
  }
  return constrainSourceDockRatio(dockWidth / containerWidth, bounds);
}

export function sourceDockRatioFromPointer(args: {
  clientPosition: number;
  grabOffset: number;
  /** Distance from the handle's leading hit-box edge to the rendered dock boundary. */
  handleBoundaryOffset?: number;
  containerLeft: number;
  containerWidth: number;
}): number {
  const dockLeft = args.clientPosition - args.grabOffset + (args.handleBoundaryOffset ?? 0);
  const containerRight = args.containerLeft + args.containerWidth;
  return sourceDockRatioForWidth(containerRight - dockLeft, args.containerWidth);
}

export function sourceDockRatioForKey(
  current: number,
  key: string,
  shiftKey: boolean,
  containerWidth: number,
): number | null {
  const bounds = sourceDockRatioBounds(containerWidth);
  // Reset the preference itself. A narrow viewport may render a constrained value temporarily,
  // but widening it later must recover the product default instead of persisting that constraint.
  if (key === "Enter") return DEFAULT_SOURCE_DOCK_RATIO;
  // A collapsed responsive interval has no resize range. Preserve the wider-screen preference
  // rather than replacing it with the temporary proportional fallback.
  if (bounds.minRatio === bounds.maxRatio) return null;
  if (key === "Home") return bounds.maxRatio;
  if (key === "End") return bounds.minRatio;
  if (key !== "ArrowLeft" && key !== "ArrowRight") return null;

  if (!validContainerWidth(containerWidth)) {
    return constrainSourceDockRatio(current, bounds);
  }
  const step = shiftKey ? 64 : 24;
  const direction = key === "ArrowLeft" ? 1 : -1;
  return sourceDockRatioForWidth((current * containerWidth) + direction * step, containerWidth);
}

/** One metrics object is the single source of truth for rendered width and separator semantics. */
export function sourceDockMetrics(preferredRatio: number, containerWidth: number): SourceDockMetrics {
  const bounds = sourceDockRatioBounds(containerWidth);
  const constrained = constrainSourceDockRatio(preferredRatio, bounds);
  const minPercent = sourceDockPercent(bounds.minRatio);
  const maxPercent = sourceDockPercent(bounds.maxRatio);
  const valuePercent = Math.max(minPercent, Math.min(maxPercent, sourceDockPercent(constrained)));
  const effectiveRatio = valuePercent / 100;
  return {
    ...bounds,
    minPercent,
    maxPercent,
    valuePercent,
    effectiveRatio,
    renderedWidth: validContainerWidth(containerWidth) ? effectiveRatio * containerWidth : null,
  };
}

export function sourceDockValueText(metrics: SourceDockMetrics): string {
  const pixelText = metrics.renderedWidth === null ? "" : ` (${Math.round(metrics.renderedWidth)} px)`;
  return `Source dock ${formatPercent(metrics.valuePercent)}% of workspace width${pixelText}`;
}

function constrainSourceDockRatio(ratio: number, bounds: SourceDockRatioBounds): number {
  const finiteRatio = Number.isFinite(ratio) ? ratio : DEFAULT_SOURCE_DOCK_RATIO;
  return Math.max(bounds.minRatio, Math.min(bounds.maxRatio, finiteRatio));
}

function sourceDockPercent(ratio: number): number {
  return Math.round(ratio * 1_000_000) / 10_000;
}

function formatPercent(percent: number): string {
  return Number.isInteger(percent) ? String(percent) : percent.toFixed(4).replace(/0+$/u, "");
}

function validContainerWidth(width: number): boolean {
  return Number.isFinite(width) && width > 0;
}
