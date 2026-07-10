/**
 * The collapsible "PR review" section of the control panel: a bar showing the open-PR count that
 * expands into a single review card paged through the open queue. It lazily loads the open list on
 * mount (so the count shows while collapsed) and keeps a PR selected while expanded so its changed
 * files — and the +/- counts — are available to the card.
 */

import { useEffect } from "react";
import { PRS_UNAVAILABLE_ERROR, type PrSummary } from "../../state/prTypes";
import { useBlueprint, useBlueprintActions } from "../../state/StoreContext";
import { CountBadge, hexAlpha, TOKENS } from "./panelKit";
import { PullRequestIcon } from "./icons";
import { PrReviewCard } from "./PrReviewCard";

const ACTIVE_HUE = "#388BFD";

export function PrReviewSection() {
  const open = useBlueprint((state) => state.prsList.open);
  const hasMore = useBlueprint((state) => state.prsHasMore.open);
  const loading = useBlueprint((state) => state.prsLoading);
  const error = useBlueprint((state) => state.prsError);
  const selected = useBlueprint((state) => state.prSelected);
  const prReviewed = useBlueprint((state) => state.prReviewed);
  const reviewOpen = useBlueprint((state) => state.minimalSeedIds.length > 0);
  const viewMode = useBlueprint((state) => state.viewMode);
  const onPrsPage = viewMode === "prs";
  const { loadPrs, selectPr, reviewPrInGraph, togglePrsView } = useBlueprintActions();

  // Expanded only while a PR review is the active on-screen surface: a PR is under review
  // (prReviewed), its minimal-graph overlay is open (minimalSeedIds), and we're not on the full
  // Pull-requests page. Otherwise — the Map after closing the overlay, or the PRs page itself — it
  // stays collapsed so a stale reviewed PR never lingers in the card.
  const expanded = prReviewed !== null && reviewOpen && viewMode !== "prs";

  const unavailable = error === PRS_UNAVAILABLE_ERROR && open === null;

  // Lazily fetch the open queue once so the collapsed bar can show a live count.
  useEffect(() => {
    if (open === null && !loading && error === null) {
      void loadPrs(1);
    }
  }, [open, loading, error, loadPrs]);

  // While expanded, always keep one PR selected so its files load for the card.
  useEffect(() => {
    if (!expanded || !open || open.length === 0) {
      return;
    }
    if (selected === null || !open.some((pr) => pr.number === selected)) {
      void selectPr(open[0].number);
    }
  }, [expanded, open, selected, selectPr]);

  const count = open?.length ?? 0;
  const current = open?.find((pr) => pr.number === selected) ?? open?.[0] ?? null;

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={barStyle(expanded)}>
        <button
          type="button"
          style={TOGGLE_STYLE}
          title={onPrsPage ? "Back to the graph" : "Open the full Pull requests page"}
          aria-pressed={onPrsPage}
          onClick={togglePrsView}
        >
          <span style={{ display: "inline-flex", color: onPrsPage || expanded ? ACTIVE_HUE : TOKENS.textMuted }}>
            <PullRequestIcon size={15} />
          </span>
          <span style={LABEL_STYLE}>PR review</span>
          <span style={{ flex: 1 }} />
          {!unavailable && open !== null ? (
            <CountBadge style={badgeToneStyle(expanded)}>{hasMore ? `${count}+` : count} open</CountBadge>
          ) : null}
        </button>
      </div>

      {expanded ? <ExpandedBody unavailable={unavailable} open={open} current={current} onReview={reviewPrInGraph} /> : null}
    </section>
  );
}

function ExpandedBody(props: {
  unavailable: boolean;
  open: PrSummary[] | null;
  current: PrSummary | null;
  onReview: () => void;
}) {
  if (props.unavailable) {
    return <div style={HINT_STYLE}>Pull requests need a GitHub-sourced session — run <code>meridian web &lt;owner/repo&gt;</code>.</div>;
  }
  if (props.open === null) {
    return <div style={HINT_STYLE}>Loading pull requests…</div>;
  }
  if (props.open.length === 0 || props.current === null) {
    return <div style={HINT_STYLE}>No open pull requests.</div>;
  }
  return <PrReviewCard pr={props.current} onReview={props.onReview} />;
}

const LABEL_STYLE: React.CSSProperties = { fontSize: 13.5, fontWeight: 500, color: TOKENS.text };
const HINT_STYLE: React.CSSProperties = {
  fontSize: 12,
  lineHeight: "17px",
  color: TOKENS.textMuted,
  padding: 12,
  borderRadius: 10,
  border: `1px dashed ${TOKENS.surfaceBorder}`,
  background: "#0D1117",
};

const TOGGLE_STYLE: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 9,
  flex: 1,
  minWidth: 0,
  border: "none",
  background: "transparent",
  padding: 0,
  cursor: "pointer",
  font: "inherit",
  textAlign: "left",
  color: TOKENS.text,
};

function barStyle(expanded: boolean): React.CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: 6,
    boxSizing: "border-box",
    padding: "9px 8px 9px 12px",
    borderRadius: 10,
    border: `1px solid ${expanded ? hexAlpha(ACTIVE_HUE, 0.55) : TOKENS.surfaceBorder}`,
    background: expanded ? hexAlpha(ACTIVE_HUE, 0.08) : TOKENS.surface,
  };
}

function badgeToneStyle(expanded: boolean): React.CSSProperties {
  return expanded ? { color: "#CDE3FF", borderColor: hexAlpha(ACTIVE_HUE, 0.5), background: hexAlpha(ACTIVE_HUE, 0.12) } : {};
}
