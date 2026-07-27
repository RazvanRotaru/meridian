import { useSyncExternalStore } from "react";
import type { ReviewLineComposerDraft } from "../../state/reviewLineComposer";
import { CommentComposer, type CommentComposerProps } from "./ReviewComments";

type ReviewLineCommentComposerProps = Omit<CommentComposerProps, "initialBody" | "value"> & {
  draft: ReviewLineComposerDraft;
  onValueChange: NonNullable<CommentComposerProps["onValueChange"]>;
};

/** Subscribe only this React leaf to per-key draft changes; its source table and graph stay untouched. */
export function ReviewLineCommentComposer({ draft, ...props }: ReviewLineCommentComposerProps) {
  const body = useSyncExternalStore(draft.subscribe, draft.getSnapshot, draft.getSnapshot);
  return <CommentComposer {...props} value={body} />;
}
