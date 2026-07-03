/**
 * Dark-safe teal->amber->red ramps for telemetry badges and edge reddening.
 *
 * Absent metrics must render NOTHING (never a zero), so these helpers are only ever called
 * once a node actually has metrics — they map a present value to a colour, nothing more.
 */

const TEAL = "#2FB7A4";
const AMBER = "#E0A33E";
const RED = "#E5534B";

export function latencyColor(p95Ms: number): string {
  if (p95Ms >= 500) {
    return RED;
  }
  if (p95Ms >= 150) {
    return AMBER;
  }
  return TEAL;
}

export function errorColor(errorRate: number): string {
  if (errorRate >= 0.05) {
    return RED;
  }
  if (errorRate >= 0.01) {
    return AMBER;
  }
  return TEAL;
}

/** Blend a base wire colour toward red as the error rate climbs, for at-a-glance honesty. */
export function reddenByErrorRate(baseColor: string, errorRate: number): string {
  if (errorRate >= 0.05) {
    return RED;
  }
  if (errorRate >= 0.01) {
    return AMBER;
  }
  return baseColor;
}
