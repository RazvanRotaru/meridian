import { useCallback, useEffect, useRef } from "react";
import { useBlueprint, useBlueprintActions } from "../../state/StoreContext";
import { prReviewRevisionKey } from "../../state/prReviewFreshness";

/**
 * Guard one source-host transition without putting callbacks in Zustand. A dirty line composer
 * stays mounted on its inline Keep/Discard prompt; only the host which requested the transition
 * observes the later discard and completes its own close/navigation callback.
 */
export function useReviewLineComposerGuard(
  transition: () => void,
  sourcePath: string | null,
): () => boolean {
  const composer = useBlueprint((state) => state.reviewLineComposer);
  const reviewKey = useBlueprint((state) => state.review?.context.reviewKey ?? null);
  const lineRevision = useBlueprint((state) => prReviewRevisionKey(state.prReviewRevision));
  const { requestReviewLineComposerDismiss } = useBlueprintActions();
  const transitionRef = useRef(transition);
  const pendingRef = useRef(false);
  transitionRef.current = transition;

  const ownsComposer = composer != null
    && sourcePath !== null
    && composer.reviewKey === reviewKey
    && composer.lineRevision === lineRevision
    && composer.path === sourcePath;

  const requestTransition = useCallback(() => {
    if (!ownsComposer) {
      pendingRef.current = false;
      transitionRef.current();
      return true;
    }
    if (requestReviewLineComposerDismiss()) {
      pendingRef.current = false;
      transitionRef.current();
      return true;
    }
    pendingRef.current = true;
    return false;
  }, [ownsComposer, requestReviewLineComposerDismiss]);

  useEffect(() => {
    if (!pendingRef.current) return;
    if (composer === null) {
      pendingRef.current = false;
      transitionRef.current();
      return;
    }
    // Keep editing cancels this host's pending transition. A later discard must not resurrect it.
    if (!composer.confirmDiscard) {
      pendingRef.current = false;
    }
  }, [composer]);

  useEffect(() => () => {
    pendingRef.current = false;
  }, []);

  return requestTransition;
}
