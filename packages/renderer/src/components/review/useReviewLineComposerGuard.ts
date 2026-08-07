import { useCallback, useEffect, useRef } from "react";
import { useBlueprint, useBlueprintActions } from "../../state/StoreContext";
import { prReviewRevisionKey } from "../../state/prReviewFreshness";

/**
 * Guard one source-host transition through the store's single replay queue. A dirty line composer
 * stays mounted on its inline Keep/Discard prompt; later host/navigation requests replace earlier
 * pending intent so Discard can never replay two contradictory transitions.
 */
export function useReviewLineComposerGuard(
  transition: () => void,
  sourcePath: string | null,
): () => boolean {
  const composer = useBlueprint((state) => state.reviewLineComposer);
  const reviewKey = useBlueprint((state) => state.review?.context.reviewKey ?? null);
  const lineRevision = useBlueprint((state) => prReviewRevisionKey(state.prReviewRevision));
  const { requestReviewLineComposerTransition } = useBlueprintActions();
  const transitionRef = useRef(transition);
  const mountedRef = useRef(true);
  transitionRef.current = transition;

  const ownsComposer = composer != null
    && sourcePath !== null
    && composer.reviewKey === reviewKey
    && composer.lineRevision === lineRevision
    && composer.path === sourcePath;

  const requestTransition = useCallback(() => {
    const run = () => {
      if (mountedRef.current) transitionRef.current();
    };
    if (!ownsComposer) {
      run();
      return true;
    }
    if (requestReviewLineComposerTransition(run)) {
      run();
      return true;
    }
    return false;
  }, [ownsComposer, requestReviewLineComposerTransition]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  return requestTransition;
}
