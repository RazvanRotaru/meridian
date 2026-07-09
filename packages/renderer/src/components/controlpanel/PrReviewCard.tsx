/**
 * One pull request rendered as a review card: number + state, prev/next paging through the open
 * queue, an open-on-GitHub link, the title, the head → base branch line, the author, the summed
 * +/- line counts, and a "N files changed" footer. Clicking the body reviews the PR in the graph.
 */

import { useMemo } from "react";
import type { PrChangedFile, PrSummary } from "../../state/prTypes";
import { useBlueprint } from "../../state/StoreContext";
import { Divider, hexAlpha, TOKENS } from "./panelKit";
import { ChevronLeftIcon, ChevronRightIcon, ExternalLinkIcon } from "./icons";

const NUMBER_HUE = "#7DD3FC";
const OPEN_HUE = "#56C271";
const ADD_HUE = "#3FB950";
const DEL_HUE = "#F85149";

export function PrReviewCard(props: {
  pr: PrSummary;
  index: number;
  total: number;
  onStep: (delta: number) => void;
  onReview: () => void;
}) {
  const files = useBlueprint((state) => state.prFiles);
  const truncated = useBlueprint((state) => state.prFilesTruncated);
  const loading = useBlueprint((state) => state.prsLoading);
  const reviewed = useBlueprint((state) => state.prReviewed === props.pr.number);
  const stats = useMemo(() => sumStats(files), [files]);
  const canStep = props.total > 1;

  return (
    <div style={CARD_STYLE}>
      <div style={TOP_ROW_STYLE}>
        <span style={numberStyle()}>#{props.pr.number}</span>
        <span style={stateStyle(props.pr.state)}>
          <span style={stateDotStyle(props.pr.state)} />
          {props.pr.draft ? "draft" : props.pr.state}
        </span>
        <span style={{ flex: 1 }} />
        {canStep ? (
          <div style={PAGER_STYLE}>
            <button type="button" style={STEP_STYLE} title="Previous pull request" onClick={() => props.onStep(-1)}>
              <ChevronLeftIcon size={15} />
            </button>
            <span style={PAGER_TEXT_STYLE}>{props.index + 1}/{props.total}</span>
            <button type="button" style={STEP_STYLE} title="Next pull request" onClick={() => props.onStep(1)}>
              <ChevronRightIcon size={15} />
            </button>
          </div>
        ) : null}
        {props.pr.url ? (
          <a style={LINK_STYLE} href={props.pr.url} target="_blank" rel="noreferrer" title="Open on GitHub">
            <ExternalLinkIcon size={14} />
          </a>
        ) : null}
      </div>

      <button type="button" style={BODY_STYLE} title="Review this PR's changes in the graph" onClick={props.onReview}>
        <div style={TITLE_STYLE}>{props.pr.title}</div>
        <div style={BRANCH_STYLE}>
          {props.pr.headRef}
          {props.pr.baseRef ? <span style={{ color: TOKENS.textDim }}> → {props.pr.baseRef}</span> : null}
        </div>
        <div style={AUTHOR_ROW_STYLE}>
          <span style={avatarStyle(props.pr.author)}>{monogram(props.pr.author)}</span>
          <span style={AUTHOR_NAME_STYLE}>{props.pr.author}</span>
          <span style={{ flex: 1 }} />
          {stats ? (
            <span style={STATS_STYLE}>
              <span style={{ color: ADD_HUE }}>+{stats.additions}</span>
              <span style={{ color: DEL_HUE }}>-{stats.deletions}</span>
            </span>
          ) : null}
        </div>
      </button>

      <Divider />
      <div style={FOOTER_STYLE}>{footerText(files, truncated, loading, reviewed)}</div>
    </div>
  );
}

function sumStats(files: readonly PrChangedFile[] | null): { additions: number; deletions: number } | null {
  if (!files) {
    return null;
  }
  let additions = 0;
  let deletions = 0;
  for (const file of files) {
    additions += file.additions;
    deletions += file.deletions;
  }
  return { additions, deletions };
}

function footerText(files: readonly PrChangedFile[] | null, truncated: boolean, loading: boolean, reviewed: boolean): string {
  if (files === null) {
    return loading ? "Loading changed files…" : "Select to load changed files";
  }
  const count = `${files.length}${truncated ? "+" : ""} ${files.length === 1 ? "file" : "files"} changed`;
  return reviewed ? `${count} · highlighted in view` : count;
}

function monogram(author: string): string {
  return author.slice(0, 2).toUpperCase();
}

/** A stable per-author hue so the same person keeps the same avatar colour across PRs. */
function avatarStyle(author: string): React.CSSProperties {
  let hash = 0;
  for (let i = 0; i < author.length; i++) {
    hash = (hash * 31 + author.charCodeAt(i)) % 360;
  }
  return {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: 20,
    height: 20,
    borderRadius: 999,
    background: `hsl(${hash}, 42%, 42%)`,
    color: "#F0F6FC",
    fontSize: 9,
    fontWeight: 700,
    flexShrink: 0,
    letterSpacing: "0.02em",
  };
}

const CARD_STYLE: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 10,
  padding: 12,
  borderRadius: 10,
  border: `1px solid ${TOKENS.surfaceBorder}`,
  background: "#0D1117",
};
const TOP_ROW_STYLE: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8 };
const PAGER_STYLE: React.CSSProperties = { display: "flex", alignItems: "center", gap: 2 };
const PAGER_TEXT_STYLE: React.CSSProperties = { fontSize: 11, color: TOKENS.textMuted, minWidth: 28, textAlign: "center" };
const STEP_STYLE: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 20,
  height: 20,
  padding: 0,
  border: "none",
  background: "transparent",
  color: TOKENS.textMuted,
  cursor: "pointer",
};
const LINK_STYLE: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 22,
  height: 22,
  color: TOKENS.textMuted,
};
const BODY_STYLE: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
  padding: 0,
  border: "none",
  background: "transparent",
  textAlign: "left",
  cursor: "pointer",
  font: "inherit",
};
const TITLE_STYLE: React.CSSProperties = {
  color: TOKENS.text,
  fontSize: 13.5,
  fontWeight: 600,
  lineHeight: "18px",
  display: "-webkit-box",
  WebkitLineClamp: 3,
  WebkitBoxOrient: "vertical",
  overflow: "hidden",
};
const BRANCH_STYLE: React.CSSProperties = {
  color: TOKENS.textMuted,
  fontSize: 11.5,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
const AUTHOR_ROW_STYLE: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, marginTop: 2 };
const AUTHOR_NAME_STYLE: React.CSSProperties = {
  color: TOKENS.textMuted,
  fontSize: 12,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
const STATS_STYLE: React.CSSProperties = { display: "flex", gap: 8, fontSize: 12, fontWeight: 600, fontVariantNumeric: "tabular-nums" };
const FOOTER_STYLE: React.CSSProperties = { fontSize: 11, color: TOKENS.textDim };

function numberStyle(): React.CSSProperties {
  return {
    color: NUMBER_HUE,
    fontSize: 11.5,
    fontWeight: 700,
    padding: "2px 7px",
    borderRadius: 6,
    border: `1px solid ${hexAlpha(NUMBER_HUE, 0.35)}`,
    background: hexAlpha(NUMBER_HUE, 0.1),
  };
}

function stateStyle(state: PrSummary["state"]): React.CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    fontSize: 11.5,
    textTransform: "capitalize",
    color: state === "open" ? OPEN_HUE : TOKENS.textMuted,
  };
}

function stateDotStyle(state: PrSummary["state"]): React.CSSProperties {
  return { width: 7, height: 7, borderRadius: 999, background: state === "open" ? OPEN_HUE : TOKENS.textMuted };
}
