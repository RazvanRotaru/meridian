import type {
  ExtractOptions,
  ExtractionProgress,
  ExtractionProgressActivity,
  ExtractionProgressPosition,
} from "@meridian/core";

/** A pass-local observation of the source file whose relationship work is starting. */
export type RelationshipFileProgress = (
  path: string,
  current: number,
  total: number,
) => void;

/** A captured observer lets extraction skip constructing progress values when none was requested. */
export type ExtractionProgressReporter = (progress: ExtractionProgress) => void;

export function createExtractionProgressReporter(
  options: Pick<ExtractOptions, "onProgress">,
): ExtractionProgressReporter | undefined {
  const observer = options.onProgress;
  if (typeof observer !== "function") return undefined;
  return (progress) => reportExtractionProgress(observer, progress);
}

export function createRelationshipFileProgress(
  reporter: ExtractionProgressReporter | undefined,
  unit: ExtractionProgressPosition | undefined,
  activity: ExtractionProgressActivity,
): RelationshipFileProgress | undefined {
  if (reporter === undefined || unit === undefined) return undefined;
  return (path, current, total) => reporter({
    language: "typescript",
    phase: "relationships",
    activity,
    unit,
    sourceFile: { current, total, path },
  });
}

/** Progress is observational: a presentation consumer cannot fail or alter extraction. */
function reportExtractionProgress(
  observer: NonNullable<ExtractOptions["onProgress"]>,
  progress: ExtractionProgress,
): void {
  try {
    const result = observer(progress);
    sinkPromiseLike(result);
  } catch {
    // Deliberately isolated from graph production.
  }
}

/** Pass callbacks are observational too, including when a pass is exercised directly in tests. */
export function reportRelationshipFileProgress(
  observer: RelationshipFileProgress | undefined,
  path: string,
  current: number,
  total: number,
): void {
  try {
    observer?.(path, current, total);
  } catch {
    // Deliberately isolated from graph production.
  }
}

function sinkPromiseLike(value: unknown): void {
  if (
    (typeof value !== "object" || value === null)
    && typeof value !== "function"
  ) {
    return;
  }
  try {
    if (typeof (value as { then?: unknown }).then === "function") {
      void Promise.resolve(value).catch(() => {});
    }
  } catch {
    // Reading or adopting an adversarial thenable is also observational.
  }
}
