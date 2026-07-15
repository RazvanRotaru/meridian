/**
 * Session-only state for the one line-comment composer shared by every review code surface. The
 * target includes the review revision because a source line is only meaningful in the coordinate
 * space where it was chosen. These helpers are deliberately pure so hosts can all apply the same
 * dirty-draft guard without owning competing copies of the text.
 */

export interface ReviewLineComposerTarget {
  readonly reviewKey: string;
  readonly lineRevision: string | null;
  readonly path: string;
  readonly line: number;
}

export interface ReviewLineComposerState extends ReviewLineComposerTarget {
  readonly body: string;
  readonly confirmDiscard: boolean;
  readonly error: string | null;
}

/** Open a target, or guard a move away from a different target that still has meaningful text. */
export function openReviewLineComposer(
  current: ReviewLineComposerState | null,
  target: ReviewLineComposerTarget,
): ReviewLineComposerState {
  if (current === null) {
    return freshComposer(target);
  }
  if (matchesReviewLineComposerTarget(current, target)) {
    return current.confirmDiscard ? { ...current, confirmDiscard: false } : current;
  }
  if (hasDraft(current)) {
    return current.confirmDiscard ? current : { ...current, confirmDiscard: true };
  }
  return freshComposer(target);
}

/** Changing the draft resumes editing and clears an error that applied to the previous body. */
export function setReviewLineComposerBody(
  current: ReviewLineComposerState,
  body: string,
): ReviewLineComposerState {
  if (current.body === body && !current.confirmDiscard && current.error === null) {
    return current;
  }
  return { ...current, body, confirmDiscard: false, error: null };
}

/** Clean composers dismiss immediately; dirty composers remain mounted with explicit choices. */
export function requestReviewLineComposerDismiss(
  current: ReviewLineComposerState | null,
): { composer: ReviewLineComposerState | null; allowed: boolean } {
  if (current === null || !hasDraft(current)) {
    return { composer: null, allowed: true };
  }
  return {
    composer: current.confirmDiscard ? current : { ...current, confirmDiscard: true },
    allowed: false,
  };
}

/** Leave the confirmation state without changing the draft or its source target. */
export function keepEditingReviewLineComposer(current: ReviewLineComposerState): ReviewLineComposerState {
  return current.confirmDiscard ? { ...current, confirmDiscard: false } : current;
}

/** Confirm the destructive choice. Kept as a helper so every host clears state identically. */
export function discardReviewLineComposer(): null {
  return null;
}

/** Exact identity includes the immutable source revision; matching path and line alone is unsafe. */
export function matchesReviewLineComposerTarget(
  left: ReviewLineComposerTarget | null,
  right: ReviewLineComposerTarget,
): boolean {
  return left !== null
    && left.reviewKey === right.reviewKey
    && left.lineRevision === right.lineRevision
    && left.path === right.path
    && left.line === right.line;
}

/** State-suffixed aliases keep call sites explicit when the helpers are imported beside actions. */
export {
  discardReviewLineComposer as discardReviewLineComposerState,
  keepEditingReviewLineComposer as keepReviewLineComposerState,
  openReviewLineComposer as openReviewLineComposerState,
  requestReviewLineComposerDismiss as requestReviewLineComposerDismissState,
  setReviewLineComposerBody as setReviewLineComposerBodyState,
};

function freshComposer(target: ReviewLineComposerTarget): ReviewLineComposerState {
  return { ...target, body: "", confirmDiscard: false, error: null };
}

function hasDraft(composer: ReviewLineComposerState): boolean {
  return composer.body.trim().length > 0;
}
