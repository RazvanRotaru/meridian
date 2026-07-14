import type { BranchTakenEvent, JsonValue, LoopSummaryEvent } from "@meridian/core";

export type RequestControlEvent = BranchTakenEvent | LoopSummaryEvent;

/** One compact value renderer shared by request graph cards and the observed-route summary. */
export function compactTraceValue(value: JsonValue | boolean | number | string): string {
  let rendered: string;
  try {
    rendered = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    rendered = String(value);
  }
  if (rendered.length <= 42) return rendered;
  return `${rendered.slice(0, 39)}…`;
}

/** The exact captured value which explains why a branch path was selected. */
export function observedBranchValue(event: BranchTakenEvent): string {
  return event.valueName && event.value !== undefined
    ? `${event.valueName} = ${compactTraceValue(event.value)}`
    : `outcome = ${compactTraceValue(event.outcome)}`;
}

/** Keep the same branch/loop wording on occurrence cards and in request-route chrome. */
export function requestControlEventBadge(event: RequestControlEvent): string {
  if (event.type === "loop.summary") {
    return `${event.iterations} iteration${event.iterations === 1 ? "" : "s"} · ${event.label}`;
  }
  return `${event.pathId} · ${observedBranchValue(event)}`;
}
