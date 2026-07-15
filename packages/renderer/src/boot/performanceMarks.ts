/** Stable browser performance entry names used by graph hydration diagnostics. */
export const PERFORMANCE = {
  bootStart: "meridian:boot-start",
  shellMounted: "meridian:renderer-shell-mounted",
  projectionTransfer: "meridian:projection-transfer",
  projectionParse: "meridian:projection-parse",
  projectionIndex: "meridian:projection-index",
  initialLayout: "meridian:initial-layout",
  firstUsablePaint: "meridian:first-usable-paint",
  bootToFirstUsablePaint: "meridian:boot-to-first-usable-paint",
} as const;

let nextSpanId = 0;

/** Mark one lifecycle point, retaining only its newest entry. */
export function markPerformance(name: string): void {
  const timeline = performanceTimeline();
  if (timeline === null) return;
  timeline.clearMarks(name);
  timeline.mark(name);
}

/** Start a named duration. Unique boundary marks make concurrent projection requests safe. */
export function startPerformanceSpan(name: string): () => void {
  const timeline = performanceTimeline();
  if (timeline === null) return () => {};
  const id = ++nextSpanId;
  const start = `${name}:start:${id}`;
  const end = `${name}:end:${id}`;
  timeline.mark(start);
  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    timeline.mark(end);
    // Retain only the latest duration per category so long navigation sessions do not turn the
    // performance timeline into another unbounded cache.
    timeline.clearMeasures(name);
    timeline.measure(name, start, end);
    timeline.clearMarks(start);
    timeline.clearMarks(end);
  };
}

/** Measure between stable lifecycle marks when both are present. */
export function measurePerformance(name: string, start: string, end: string): void {
  const timeline = performanceTimeline();
  if (timeline === null || timeline.getEntriesByName(start, "mark").length === 0
    || timeline.getEntriesByName(end, "mark").length === 0) return;
  timeline.clearMeasures(name);
  timeline.measure(name, start, end);
}

function performanceTimeline(): Performance | null {
  if (typeof performance === "undefined"
    || typeof performance.mark !== "function"
    || typeof performance.measure !== "function") return null;
  return performance;
}
