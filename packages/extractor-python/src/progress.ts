import type { ExtractOptions, ExtractionProgress } from "@meridian/core";

/** Progress is observational: a presentation consumer cannot fail or alter extraction. */
export function reportExtractionProgress(
  options: ExtractOptions,
  progress: ExtractionProgress,
): void {
  try {
    const observer = options.onProgress as ((value: ExtractionProgress) => unknown) | undefined;
    // A callback typed as returning void may still be async. Attach a rejection sink without
    // awaiting it so presentation work cannot delay extraction or surface an unhandled rejection.
    const result = observer?.(progress);
    if (isPromiseLike(result)) {
      void Promise.resolve(result).catch(() => undefined);
    }
  } catch {
    // Deliberately isolated from graph production.
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null
    && (typeof value === "object" || typeof value === "function")
    && typeof (value as { then?: unknown }).then === "function"
  );
}
