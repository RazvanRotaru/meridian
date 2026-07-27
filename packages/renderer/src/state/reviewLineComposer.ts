/**
 * Session-only state for the one line-comment composer shared by every review code surface. The
 * target includes the review revision because a source line is only meaningful in the coordinate
 * space where it was chosen.
 *
 * Draft text lives in its own tiny observable channel. Typing can then update only the textarea
 * instead of notifying the blueprint store (and every graph, URL, and review selector) per key.
 * The blueprint state retains only lifecycle metadata needed by navigation and dismissal guards.
 */

import type { PrReviewCommentSide } from "./prTypes";

export interface ReviewLineComposerTarget {
  readonly reviewKey: string;
  readonly lineRevision: string | null;
  readonly path: string;
  readonly line: number;
  readonly side: PrReviewCommentSide;
}

export interface ReviewLineComposerDraft {
  getSnapshot(): string;
  subscribe(listener: () => void): () => void;
}

export interface ReviewLineComposerState extends ReviewLineComposerTarget {
  readonly draft: ReviewLineComposerDraft;
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
  writeDraft(current.draft, body);
  if (!current.confirmDiscard && current.error === null) {
    return current;
  }
  return { ...current, confirmDiscard: false, error: null };
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
export function discardReviewLineComposer(current: ReviewLineComposerState | null = null): null {
  if (current !== null) {
    writeDraft(current.draft, "");
  }
  return null;
}

/** Exact identity includes the immutable source revision and diff side. */
export function matchesReviewLineComposerTarget(
  left: ReviewLineComposerTarget | null,
  right: ReviewLineComposerTarget,
): boolean {
  return left !== null
    && left.reviewKey === right.reviewKey
    && left.lineRevision === right.lineRevision
    && left.path === right.path
    && left.line === right.line
    && left.side === right.side;
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
  return {
    ...target,
    draft: createReviewLineComposerDraft(),
    confirmDiscard: false,
    error: null,
  };
}

export function createReviewLineComposerDraft(initialBody = ""): ReviewLineComposerDraft {
  let body = initialBody;
  const listeners = new Set<() => void>();
  const draft: MutableReviewLineComposerDraft = {
    getSnapshot: () => body,
    setBody(nextBody) {
      if (body === nextBody) {
        return;
      }
      body = nextBody;
      listeners.forEach((listener) => listener());
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return draft;
}

interface MutableReviewLineComposerDraft extends ReviewLineComposerDraft {
  setBody(body: string): void;
}

function hasDraft(composer: ReviewLineComposerState): boolean {
  return composer.draft.getSnapshot().trim().length > 0;
}

function writeDraft(draft: ReviewLineComposerDraft, body: string): void {
  // Draft instances are created in this module; exposing only the read side keeps renderers from
  // bypassing the Blueprint action and its confirmation/error lifecycle.
  (draft as MutableReviewLineComposerDraft).setBody(body);
}
