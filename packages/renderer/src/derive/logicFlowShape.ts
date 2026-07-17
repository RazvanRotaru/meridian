import { tryArms, type FlowStep } from "@meridian/core";

/** A shared FINALLY phase is exact while TRY/CATCH complete normally. An explicit return/throw in
 * either protected arm carries a pending completion that must resume only after cleanup; because
 * FlowStep does not yet encode that pending value, renderer and occurrence-address consumers must
 * keep those shapes on the same honest fallback. */
export function canChartFinallyAsSharedPhase(
  step: Extract<FlowStep, { kind: "branch" }>,
): boolean {
  const { tryPath, catchPath, finallyPath } = tryArms(step);
  return Boolean(
    tryPath
    && catchPath
    && finallyPath
    && !containsExit(tryPath.body)
    && !containsExit(catchPath.body)
    && !containsExit(finallyPath.body),
  );
}

/** Conservative recursive scan. False positives merely retain the fallback; false negatives could
 * place a terminal before mandatory cleanup, so every nested synchronous body is included. */
function containsExit(steps: FlowStep[]): boolean {
  return steps.some((step) => {
    if (step.kind === "exit") return true;
    if (step.kind === "branch") return step.paths.some((path) => containsExit(path.body));
    if (step.kind === "loop" || step.kind === "callback") return containsExit(step.body);
    return false;
  });
}
