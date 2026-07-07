/**
 * An amber notice above the review list when GitHub capped the PR's changed-file list at
 * PR_FILES_CAP (3000). Without it a truncated checklist reads as a complete one — so we say
 * plainly that the file set is partial. Renders nothing for every non-truncated view.
 */

import { useBlueprint } from "../state/StoreContext";

export function ReviewTruncatedNotice() {
  const truncated = useBlueprint((state) => state.reviewTruncated);
  if (!truncated) {
    return null;
  }
  return <div style={NOTICE_STYLE}>Showing the first 3000 changed files — this PR was truncated by GitHub.</div>;
}

const NOTICE_STYLE: React.CSSProperties = {
  border: "1px solid rgba(227,179,65,0.35)",
  borderRadius: 8,
  background: "rgba(227,179,65,0.08)",
  color: "#E3B341",
  fontSize: 12,
  fontWeight: 600,
  padding: "8px 10px",
  margin: 10,
};
