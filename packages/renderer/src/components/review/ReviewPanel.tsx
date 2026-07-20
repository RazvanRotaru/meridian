/**
 * The PR-review side panel. Files first: every changed file with its touched code units and a
 * per-file "viewed" check (ReviewFilesSection — the panel's primary content). Change groups and
 * affected logic flows stay pinned above that file scroller, and a footer submits review decisions
 * together with any draft comments. The header tracks viewed-files progress, states the review's provenance (which graph,
 * which code), offers the fallback review's opt-in "Extract head graph", and Reset (ticks only —
 * never drafts) and Hide; a hidden panel folds into a narrow reopen rail. Self-hides when there
 * is no review.
 */

import { memo, useEffect, useRef, useState } from "react";
import { useBlueprint, useBlueprintActions } from "../../state/StoreContext";
import { countViewedFiles, isReviewTestPath } from "../../derive/reviewFiles";
import type { ReviewData } from "../../derive/reviewData";
import type { PrSummary } from "../../state/prTypes";
import { PrPrepareInline } from "../prs/PrPrepareProgress";
import { ResizableSplitView } from "../flowexplorer/FlowSplitView";
import { ChangeGroupStrip } from "./ChangeGroupStrip";
import { ReviewFilesSection } from "./ReviewFilesSection";
import { ReviewFlowsSection, visibleAffectedFlows } from "./ReviewFlowsSection";
import { ReviewSubmissionFooter } from "./ReviewSubmissionFooter";
import { NO_FOCUS_RING, REVIEW_VIEWED_ACCENT } from "./reviewPanelKit";
import { ReviewPreferencesPane } from "./ReviewPreferencesPane";
import { selectedPrSummary } from "../../state/store";
import { isReviewPathInScope } from "../../derive/reviewPathScope";

function ReviewPanelImpl() {
  const review = useBlueprint((state) => state.review);
  const hidden = useBlueprint((state) => state.reviewPanelHidden);
  const showTests = useBlueprint((state) => state.showTests);
  const reviewDiffOnly = useBlueprint((state) => state.reviewDiffOnly);
  const reviewFiles = useBlueprint((state) => state.reviewFiles);
  const reviewGroups = useBlueprint((state) => state.reviewGroups);
  const activeGroupId = useBlueprint((state) => state.reviewActiveGroupId);
  const pathScope = useBlueprint((state) => state.reviewPathScope);
  const focusedSubgraphPaths = useBlueprint((state) => state.reviewFocusedSubgraph?.filePaths ?? null);
  const prSelected = useBlueprint((state) => state.prSelected);
  const preparedHeadCurrent = useBlueprint((state) => state.prPreparedArtifactCurrent);
  const footerVisible = useBlueprint((state) => state.prReviewed !== null || (state.showTests
    ? state.reviewComments.length > 0
    : state.reviewComments.some((comment) => !isReviewTestPath(
      comment.path,
      state.index,
      state.prReviewBaseline?.index ?? null,
    ))));
  usePrReviewFreshnessWatcher();
  const flowView = useBlueprint((state) => state.reviewFlowSplitView);
  const openFlowSplitOnSelect = useBlueprint((state) => state.reviewOpenFlowSplitOnSelect);
  const codePreviewTrigger = useBlueprint((state) => state.reviewCodePreviewTrigger);
  const hideAddedSourceCommentDiffs = useBlueprint((state) => state.reviewHideAddedSourceCommentDiffs);
  const {
    setReviewFlowSplitView,
    setReviewOpenFlowSplitOnSelect,
    setReviewCodePreviewTrigger,
    setReviewHideAddedSourceCommentDiffs,
    toggleReviewDiffOnly,
    toggleShowTests,
  } = useBlueprintActions();
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const [filesExpanded, setFilesExpanded] = useState(false);
  const preferencesButtonRef = useRef<HTMLButtonElement | null>(null);
  const closePreferences = () => {
    setPreferencesOpen(false);
    preferencesButtonRef.current?.focus();
  };
  if (!review) {
    return null;
  }
  if (hidden) {
    return <CollapsedRail />;
  }
  const activeGroup = activeGroupId === null
    ? null
    : reviewGroups?.groups.find((group) => group.id === activeGroupId) ?? null;
  const activeGroupFiles = activeGroup === null ? null : new Set(activeGroup.files);
  const scopePresent = reviewFiles.some((file) => file.moduleId !== null
    && (activeGroupFiles === null || activeGroupFiles.has(file.path)));
  const filesPresent = reviewFiles.some((file) => (activeGroupFiles === null || activeGroupFiles.has(file.path))
    && (pathScope === null || isReviewPathInScope(file.path, pathScope))
    && (focusedSubgraphPaths === null || focusedSubgraphPaths.includes(file.path)));
  const flowsPresent = visibleAffectedFlows(
    review.rows,
    prSelected === null || preparedHeadCurrent,
  ).length > 0;
  const testsHiddenNoticeVisible = !showTests && reviewFiles.length === 0;
  const scopeVisible = !filesExpanded && (scopePresent || testsHiddenNoticeVisible);
  const affectedFlowsVisible = !filesExpanded && flowsPresent;
  return (
    <div style={PANEL}>
      <ReviewPanelResizableLayout
        header={(
          <Header
            review={review}
            preferencesOpen={preferencesOpen}
            preferencesButtonRef={preferencesButtonRef}
            onTogglePreferences={() => preferencesOpen ? closePreferences() : setPreferencesOpen(true)}
          />
        )}
        scope={(
          <div style={REVIEW_SECTION_SURFACE}>
            {testsHiddenNoticeVisible ? (
              <div style={TESTS_HIDDEN_NOTICE} role="status">
                Test changes are excluded. Open <strong>Review preferences</strong> and turn off <strong>Exclude test changes</strong> to include them.
              </div>
            ) : null}
            <ChangeGroupStrip />
          </div>
        )}
        flows={<ReviewFlowsSection />}
        files={(
          <div
            data-review-files-scroll="true"
            data-review-files-expanded={filesExpanded ? "true" : "false"}
            style={SCROLL}
          >
            <ReviewFilesSection
              expanded={filesExpanded}
              onExpandedChange={setFilesExpanded}
            />
          </div>
        )}
        footer={<ReviewSubmissionFooter />}
        scopeVisible={scopeVisible}
        flowsVisible={affectedFlowsVisible}
        filesVisible={filesPresent}
        footerVisible={footerVisible}
        bodyCovered={preferencesOpen}
        overlay={preferencesOpen ? (
          <div style={PREFERENCES_LAYER}>
            <ReviewPreferencesPane
              excludeTestChanges={!showTests}
              hideNodesNotInDiff={reviewDiffOnly}
              flowView={flowView}
              openFlowSplitOnSelect={openFlowSplitOnSelect}
              codePreviewTrigger={codePreviewTrigger}
              hideAddedSourceCommentDiffs={hideAddedSourceCommentDiffs}
              onExcludeTestChangesChange={(exclude) => {
                if (exclude === showTests) {
                  toggleShowTests();
                }
              }}
              onHideNodesNotInDiffChange={(hide) => {
                if (hide !== reviewDiffOnly) {
                  toggleReviewDiffOnly();
                }
              }}
              onFlowViewChange={setReviewFlowSplitView}
              onOpenFlowSplitOnSelectChange={setReviewOpenFlowSplitOnSelect}
              onCodePreviewTriggerChange={setReviewCodePreviewTrigger}
              onHideAddedSourceCommentDiffsChange={setReviewHideAddedSourceCommentDiffs}
              onClose={closePreferences}
            />
          </div>
        ) : null}
      />
    </div>
  );
}

export interface ReviewPanelResizableLayoutProps {
  header: React.ReactNode;
  scope: React.ReactNode;
  flows: React.ReactNode;
  files: React.ReactNode;
  footer: React.ReactNode;
  scopeVisible: boolean;
  flowsVisible: boolean;
  filesVisible: boolean;
  footerVisible: boolean;
  bodyCovered?: boolean;
  overlay?: React.ReactNode;
}

const REVIEW_SPLIT_DEFAULTS = {
  header: 0.23,
  scope: 0.22,
  flows: 0.26,
  files: 0.72,
} as const;

/** Four nested instances of the application splitter make every review boundary adjustable. The
 * visibility flags remove empty/focus-mode panes and their separator without unmounting children. */
export function ReviewPanelResizableLayout(props: ReviewPanelResizableLayoutProps) {
  const [headerRatio, setHeaderRatio] = useState<number>(REVIEW_SPLIT_DEFAULTS.header);
  const [scopeRatio, setScopeRatio] = useState<number>(REVIEW_SPLIT_DEFAULTS.scope);
  const [flowsRatio, setFlowsRatio] = useState<number>(REVIEW_SPLIT_DEFAULTS.flows);
  const [filesRatio, setFilesRatio] = useState<number>(REVIEW_SPLIT_DEFAULTS.files);
  const filesAndFooterVisible = props.filesVisible || props.footerVisible;
  const afterScopeVisible = props.flowsVisible || filesAndFooterVisible;
  const bodyVisible = props.scopeVisible || afterScopeVisible || props.overlay !== undefined;

  const filesAndFooter = (
    <ResizableSplitView
      open
      orientation="horizontal"
      primary={props.files}
      secondary={props.footer}
      primaryRatio={filesRatio}
      defaultPrimaryRatio={REVIEW_SPLIT_DEFAULTS.files}
      onPrimaryRatioChange={setFilesRatio}
      primaryPaneId="review-files-pane"
      secondaryPaneId="review-submit-pane"
      primaryLabel="Changed files"
      secondaryLabel="submit review"
      separatorLabel="Resize changed files and submit review"
      minimumPrimarySize={80}
      minimumSecondarySize={96}
      handleSize={6}
      primaryVisible={props.filesVisible}
      secondaryVisible={props.footerVisible}
    />
  );

  const flowsAndRemaining = (
    <ResizableSplitView
      open
      orientation="horizontal"
      primary={props.flows}
      secondary={filesAndFooter}
      primaryRatio={flowsRatio}
      defaultPrimaryRatio={REVIEW_SPLIT_DEFAULTS.flows}
      onPrimaryRatioChange={setFlowsRatio}
      primaryPaneId="review-flows-pane"
      secondaryPaneId="review-after-flows-pane"
      primaryLabel="Affected logic flows"
      secondaryLabel="files and submission"
      separatorLabel="Resize affected logic flows and remaining review sections"
      minimumPrimarySize={48}
      minimumSecondarySize={170}
      handleSize={6}
      primaryVisible={props.flowsVisible}
      secondaryVisible={filesAndFooterVisible}
    />
  );

  const reviewSections = (
    <ResizableSplitView
      open
      orientation="horizontal"
      primary={props.scope}
      secondary={flowsAndRemaining}
      primaryRatio={scopeRatio}
      defaultPrimaryRatio={REVIEW_SPLIT_DEFAULTS.scope}
      onPrimaryRatioChange={setScopeRatio}
      primaryPaneId="review-scope-pane"
      secondaryPaneId="review-after-scope-pane"
      primaryLabel="Review scope"
      secondaryLabel="remaining review sections"
      separatorLabel="Resize review scope and remaining review sections"
      minimumPrimarySize={72}
      minimumSecondarySize={210}
      handleSize={6}
      primaryVisible={props.scopeVisible}
      secondaryVisible={afterScopeVisible}
    />
  );

  return (
    <ResizableSplitView
      open
      orientation="horizontal"
      primary={props.header}
      secondary={(
        <div style={BODY_STACK}>
          {/* Keep the whole review workspace mounted while preferences cover it: splitter ratios,
              folds, path drafts, and comment composers all survive the overlay and focus mode. */}
          <div
            style={{ ...REVIEW_BODY, visibility: props.bodyCovered ? "hidden" : "visible" }}
            inert={props.bodyCovered}
            aria-hidden={props.bodyCovered || undefined}
          >
            {reviewSections}
          </div>
          {props.overlay}
        </div>
      )}
      primaryRatio={headerRatio}
      defaultPrimaryRatio={REVIEW_SPLIT_DEFAULTS.header}
      onPrimaryRatioChange={setHeaderRatio}
      primaryPaneId="review-header-pane"
      secondaryPaneId="review-workspace-pane"
      primaryLabel="Pull request context"
      secondaryLabel="review workspace"
      separatorLabel="Resize pull request context and review workspace"
      minimumPrimarySize={96}
      minimumSecondarySize={260}
      handleSize={6}
      secondaryVisible={bodyVisible}
    />
  );
}

/** Keep an open PR review pinned to an honestly-current head. The check is deliberately quiet:
 * only a changed revision surfaces UI, while transient background failures leave the review alone. */
function usePrReviewFreshnessWatcher() {
  const prReviewed = useBlueprint((state) => state.prReviewed);
  const revision = useBlueprint((state) => state.prReviewRevision);
  const { checkPrReviewFreshness } = useBlueprintActions();
  useEffect(() => {
    if (prReviewed === null || revision === null || typeof window === "undefined" || typeof document === "undefined") {
      return;
    }
    let checking = false;
    const checkWhileVisible = () => {
      if (document.visibilityState === "hidden" || checking) {
        return;
      }
      checking = true;
      void checkPrReviewFreshness()
        .catch(() => {})
        .finally(() => {
          checking = false;
        });
    };
    checkWhileVisible();
    const interval = window.setInterval(checkWhileVisible, 60_000);
    window.addEventListener("focus", checkWhileVisible);
    document.addEventListener("visibilitychange", checkWhileVisible);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", checkWhileVisible);
      document.removeEventListener("visibilitychange", checkWhileVisible);
    };
  }, [checkPrReviewFreshness, prReviewed, revision]);
}

/** The hidden panel folds to a slim rail in place — the reopen affordance stays exactly where the
 * panel was instead of popping up somewhere else. The whole rail is the button. */
function CollapsedRail() {
  const files = useBlueprint((state) => state.reviewFiles);
  const unitTicks = useBlueprint((state) => state.reviewUnitTicks);
  const fileTicks = useBlueprint((state) => state.reviewFileTicks);
  const stale = useBlueprint((state) => state.prReviewStale || state.prReviewRefreshing);
  const { toggleReviewPanel } = useBlueprintActions();
  const viewed = countViewedFiles(files, unitTicks, fileTicks);
  return (
    <button
      type="button"
      style={stale ? { ...RAIL, ...RAIL_STALE } : RAIL}
      onClick={toggleReviewPanel}
      aria-label={stale ? "PR review — new changes available" : "Show the review panel"}
      title={stale ? "New pull request changes available — show the review panel to refresh" : "Show the review panel"}
    >
      <span style={RAIL_GLYPH}>«</span>
      <span style={RAIL_LABEL}>PR review</span>
      {stale && <span style={RAIL_STALE_DOT} aria-hidden="true" />}
      {files.length > 0 && <span style={RAIL_COUNT}>{viewed}/{files.length}</span>}
    </button>
  );
}

function Header(props: {
  review: ReviewData;
  preferencesOpen: boolean;
  preferencesButtonRef: React.RefObject<HTMLButtonElement | null>;
  onTogglePreferences: () => void;
}) {
  const { review, preferencesOpen, preferencesButtonRef, onTogglePreferences } = props;
  const [preferencesFocusVisible, setPreferencesFocusVisible] = useState(false);
  const files = useBlueprint((state) => state.reviewFiles);
  const unitTicks = useBlueprint((state) => state.reviewUnitTicks);
  const fileTicks = useBlueprint((state) => state.reviewFileTicks);
  const existingCommentCount = useBlueprint((state) => {
    return state.showTests
      ? state.prDiscussion?.comments.length ?? 0
      : state.prDiscussion?.comments.filter((comment) => !isReviewTestPath(comment.path, state.index, state.prReviewBaseline?.index ?? null)).length ?? 0;
  });
  const commentsVisible = useBlueprint((state) => state.reviewCommentsVisible);
  const prReviewed = useBlueprint((state) => state.prReviewed);
  const currentPr = useBlueprint((state) => selectedPrSummary(state, state.prReviewed));
  const preparedArtifactCurrent = useBlueprint((state) => state.prPreparedArtifactCurrent);
  const preparing = useBlueprint((state) => state.prReviewStatus === "preparing");
  const stale = useBlueprint((state) => state.prReviewStale);
  const refreshing = useBlueprint((state) => state.prReviewRefreshing);
  const canExtract = useBlueprint((state) => state.prReviewed !== null
    && !state.prPreparedArtifactCurrent
    && state.prPreparedGraphId === null
    && state.analyzeUrl !== null);
  const { resetReviewTicks, toggleReviewPanel, toggleReviewCommentsVisible, prepareHeadGraph, refreshPrReview } = useBlueprintActions();
  const viewed = countViewedFiles(files, unitTicks, fileTicks);
  const total = files.length;
  const addedUnmatched = files.filter((file) => file.status === "added" && file.moduleId === null).length;
  const ctx = review.context;
  return (
    <div style={HEADER}>
      <div style={HEADER_TOP}>
        <span style={HEADER_TITLE}>PR review</span>
        {currentPr ? <span style={PR_NUMBER}>#{currentPr.number}</span> : null}
        <span style={{ flex: 1 }} />
        {(stale || refreshing) && (
          <button
            type="button"
            style={{ ...STALE_BTN, ...(refreshing || preparing ? STALE_BTN_DISABLED : {}) }}
            disabled={refreshing || preparing}
            aria-busy={refreshing || preparing}
            title={refreshing
              ? "Refreshing pull request changes"
              : preparing
                ? "Finish preparing the current head before refreshing"
                : "Refresh this review at the latest pull request head"}
            onClick={() => void refreshPrReview()}
          >
            {refreshing ? "Refreshing…" : "New changes · Refresh"}
          </button>
        )}
        {!refreshing && (preparing ? <PrPrepareInline /> : canExtract && (
          <button
            type="button"
            style={EXTRACT_BTN}
            title="Clone the PR head and rebuild the graph from it — added files join the graph, deleted files leave it"
            onClick={() => void prepareHeadGraph()}
          >
            Extract head graph
          </button>
        ))}
        {total > 0 && (
          <button type="button" style={RESET_BTN} title="Clear every reviewed tick (drafts are kept)" onClick={resetReviewTicks}>
            Reset
          </button>
        )}
        <button
          ref={preferencesButtonRef}
          type="button"
          style={{
            ...(preferencesOpen ? SETTINGS_BTN_ACTIVE : SETTINGS_BTN),
            ...(preferencesFocusVisible ? SETTINGS_BTN_FOCUS : {}),
          }}
          aria-label="Review preferences"
          aria-expanded={preferencesOpen}
          aria-controls="review-preferences-pane"
          title="Review preferences"
          onClick={onTogglePreferences}
          onFocus={(event) => setPreferencesFocusVisible(event.currentTarget.matches(":focus-visible"))}
          onBlur={() => setPreferencesFocusVisible(false)}
        >
          ⚙
        </button>
        <button type="button" style={HIDE_BTN} title="Hide the review panel" onClick={toggleReviewPanel}>
          »
        </button>
      </div>
      {currentPr ? <PullRequestContext key={`${currentPr.number}:${currentPr.updatedAt}`} pr={currentPr} /> : null}
      <div style={PROVENANCE_ROW}>
      {prReviewed !== null ? <PrProvenance ctx={ctx} /> : (
        <div style={HEADER_REF}>
          <span style={REF_BRANCH}>{ctx.headRef ?? "working tree"}</span>
          <span style={REF_ARROW}>vs</span>
          <span style={REF_BASE}>{ctx.baseRef ?? "explicit files"}</span>
        </div>
      )}
      <span style={{ flex: 1 }} />
      {currentPr?.url ? (
        <a href={currentPr.url} target="_blank" rel="noreferrer" style={GITHUB_PR_LINK} title="Open this pull request on GitHub">
          Open PR on GitHub ↗
        </a>
      ) : null}
      </div>
      {existingCommentCount > 0 ? (
        <div style={COMMENT_CONTROLS}>
          <span style={COMMENT_COUNT_LABEL}>
            {existingCommentCount} existing {existingCommentCount === 1 ? "comment" : "comments"}
          </span>
          <button
            type="button"
            style={commentsVisible ? COMMENTS_BTN_ACTIVE : COMMENTS_BTN}
            aria-pressed={commentsVisible}
            title={`${commentsVisible ? "Hide" : "View"} existing comments in canvas code previews`}
            onClick={toggleReviewCommentsVisible}
          >
            {commentsVisible ? "Hide comments" : "View comments"}
          </button>
        </div>
      ) : null}
      {prReviewed !== null && !preparedArtifactCurrent && addedUnmatched > 0 && (
        <div style={ADDED_FILES_NOTE}>
          {addedUnmatched === 1
            ? "1 added file isn't in the base graph — Extract head graph to review it"
            : `${addedUnmatched} added files aren't in the base graph — Extract head graph to review them`}
        </div>
      )}
      {prReviewed !== null && <ExtractFailedWarning />}
      {total > 0 && (
        <div style={PROGRESS_ROW}>
          <div style={PROGRESS_TRACK}>
            <div style={{ ...PROGRESS_FILL, width: `${(viewed / total) * 100}%` }} />
          </div>
          <span style={PROGRESS_LABEL}>{viewed}/{total} files viewed</span>
        </div>
      )}
      {ctx.warnings.map((warning, index) => (
        <div key={index} style={WARNING}>{warning}</div>
      ))}
    </div>
  );
}

/** The review's identity belongs beside the checklist it scopes. Keep the title prominent and
 * available in full, then clamp the potentially 10k-character body so context never crowds work. */
function PullRequestContext({ pr }: { pr: PrSummary }) {
  const [expanded, setExpanded] = useState(false);
  const description = pr.body?.trim() ?? "";
  const preview = prDescriptionPreview(description);
  const descriptionId = `review-pr-${pr.number}-description`;

  return (
    <section style={PR_CONTEXT} aria-label={`Pull request #${pr.number}`}>
      <h2 style={PR_TITLE} title={pr.title}>{pr.title}</h2>
      {description === "" ? (
        <div style={PR_DESCRIPTION_EMPTY}>No description provided.</div>
      ) : (
        <>
          <div
            id={descriptionId}
            className={expanded ? "mrd-scroll" : undefined}
            role={expanded ? "region" : undefined}
            aria-label={expanded ? `Pull request #${pr.number} description` : undefined}
            tabIndex={expanded ? 0 : undefined}
            style={expanded
              ? { ...PR_DESCRIPTION, ...PR_DESCRIPTION_EXPANDED }
              : { ...PR_DESCRIPTION, ...PR_DESCRIPTION_CLAMP }}
          >
            {expanded ? description : preview.text}
          </div>
          {preview.truncated ? (
            <button
              type="button"
              style={PR_DESCRIPTION_TOGGLE}
              aria-expanded={expanded}
              aria-controls={descriptionId}
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? "Show less" : "Show more"}
            </button>
          ) : null}
        </>
      )}
    </section>
  );
}

/** A real collapsed value keeps the disclosure honest for assistive technology too: hidden body
 * text is not mounted until the reader asks for it. Three source lines or ~180 characters fit the
 * panel's compact context slot; word-boundary clipping avoids a ragged partial word. */
function prDescriptionPreview(description: string): { text: string; truncated: boolean } {
  const firstThreeLines = description.split("\n").slice(0, 3).join("\n");
  let text = firstThreeLines;
  if (text.length > 180) {
    const clipped = text.slice(0, 180);
    const wordBoundary = clipped.lastIndexOf(" ");
    text = clipped.slice(0, wordBoundary >= 120 ? wordBoundary : clipped.length);
  }
  text = text.trimEnd();
  const truncated = text !== description;
  return { text: truncated ? `${text}…` : text, truncated };
}

/** The GitHub-PR provenance line: which graph the review computes on, and which code it shows —
 * sync mode reviews the boot (base-branch) graph with head-fetched code; after head extraction
 * the graph itself IS the PR head, pinned to the analyzed commit. */
function PrProvenance({ ctx }: { ctx: ReviewData["context"] }) {
  const headSha = useBlueprint((state) => state.prPreparedHeadSha);
  const swapped = useBlueprint((state) => state.prPreparedArtifactCurrent);
  // Real spaces live in the text nodes (not flex gaps) so the line's DOM text reads exactly
  // "<head> → <base> · <mode>" — greppable, copyable, e2e-assertable.
  return (
    <div style={PROVENANCE}>
      <span style={REF_BRANCH}>{ctx.headRef ?? "head"}</span>
      <span style={REF_ARROW}>{" → "}</span>
      <span style={REF_BASE}>{ctx.baseRef ?? "base"}</span>
      <span style={REF_BASE}>{swapped ? ` · head graph @${(headSha ?? "").slice(0, 7)}` : " · base graph + head code"}</span>
    </div>
  );
}

/** A failed head extraction leaves the sync review untouched; this amber line says so, carries the
 * server's short reason, and dismisses via the prepare-error lane. */
function ExtractFailedWarning() {
  const error = useBlueprint((state) => state.prPrepareError);
  const preparedArtifactCurrent = useBlueprint((state) => state.prPreparedArtifactCurrent);
  const stale = useBlueprint((state) => state.prReviewStale);
  const { dismissPrepareError } = useBlueprintActions();
  if (error === null) {
    return null;
  }
  return (
    <div style={EXTRACT_WARNING}>
      <span style={{ flex: 1 }}>
        {preparedArtifactCurrent || stale
          ? "Head refresh failed — prior review contents remain in view. "
          : "Head extraction failed — still reviewing on the base graph. "}
        <span style={EXTRACT_WARNING_DETAIL}>{error}</span>
      </span>
      <button type="button" style={WARNING_DISMISS} title="Dismiss" onClick={dismissPrepareError}>
        ×
      </button>
    </div>
  );
}

export const ReviewPanel = memo(ReviewPanelImpl);

const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";
export const REVIEW_PANEL_DEFAULT_WIDTH = 380;
export const REVIEW_PANEL_RAIL_WIDTH = 30;

const PANEL: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  width: "100%",
  minWidth: 0,
  height: "100%",
  boxSizing: "border-box",
  background: "#0B0E13",
  borderLeft: "1px solid #20262F",
};
const TESTS_HIDDEN_NOTICE: React.CSSProperties = {
  margin: "10px 12px 4px",
  padding: "9px 10px",
  border: "1px solid #3B4656",
  borderRadius: 7,
  background: "rgba(88,196,220,0.07)",
  color: "#9AA4B2",
  fontSize: 11,
  lineHeight: 1.45,
};
const HEADER: React.CSSProperties = { height: "100%", minHeight: 0, overflowY: "auto", boxSizing: "border-box", padding: "14px 16px 12px", display: "flex", flexDirection: "column", gap: 8 };
const HEADER_TOP: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8 };
const HEADER_TITLE: React.CSSProperties = { fontSize: 10.5, fontWeight: 750, letterSpacing: 0.5, textTransform: "uppercase", color: "#9AA4B2" };
const PR_NUMBER: React.CSSProperties = { color: "#7DD3FC", fontSize: 10.5, fontWeight: 700, lineHeight: "18px" };
const PR_CONTEXT: React.CSSProperties = { display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 4, minWidth: 0, padding: "2px 0 1px" };
const PR_TITLE: React.CSSProperties = { display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: 2, maxHeight: 38, overflow: "hidden", margin: 0, color: "#F0F6FC", fontSize: 14, fontWeight: 700, lineHeight: "19px", overflowWrap: "anywhere" };
const PR_DESCRIPTION: React.CSSProperties = { width: "100%", color: "#AAB3C0", fontSize: 11.5, lineHeight: "16px", whiteSpace: "pre-wrap", overflowWrap: "anywhere", boxSizing: "border-box" };
const PR_DESCRIPTION_CLAMP: React.CSSProperties = { maxHeight: 48, overflow: "hidden" };
const PR_DESCRIPTION_EXPANDED: React.CSSProperties = { maxHeight: 144, overflowY: "auto", paddingRight: 6 };
const PR_DESCRIPTION_EMPTY: React.CSSProperties = { color: "#8B96A5", fontSize: 11.5, lineHeight: "16px", fontStyle: "italic" };
const PR_DESCRIPTION_TOGGLE: React.CSSProperties = { border: "none", background: "transparent", color: "#7DD3FC", cursor: "pointer", font: "inherit", fontSize: 10.5, fontWeight: 600, lineHeight: "14px", padding: "1px 0" };
// One shared chip metric for BOTH header buttons — mismatched size/weight reads as a glitch.
const HEADER_BTN: React.CSSProperties = { font: "inherit", border: "1px solid #2A2F37", background: "transparent", color: "#9AA4B2", borderRadius: 6, padding: "3px 9px", fontSize: 11.5, fontWeight: 600, lineHeight: "15px", cursor: "pointer", ...NO_FOCUS_RING };
const RESET_BTN: React.CSSProperties = { ...HEADER_BTN };
const HIDE_BTN: React.CSSProperties = { ...HEADER_BTN };
const EXTRACT_BTN: React.CSSProperties = { ...HEADER_BTN };
const GITHUB_PR_LINK: React.CSSProperties = { color: "#7DD3FC", fontSize: 10.5, textDecoration: "none", whiteSpace: "nowrap" };
const STALE_BTN: React.CSSProperties = { ...HEADER_BTN, borderColor: "#9A7B2D", background: "rgba(210,153,34,0.12)", color: "#D29922" };
const STALE_BTN_DISABLED: React.CSSProperties = { cursor: "wait", opacity: 0.75 };
const COMMENT_CONTROLS: React.CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 };
const COMMENT_COUNT_LABEL: React.CSSProperties = { color: "#7B8695", fontSize: 10.5 };
const COMMENTS_BTN: React.CSSProperties = { ...HEADER_BTN };
const COMMENTS_BTN_ACTIVE: React.CSSProperties = { ...HEADER_BTN, borderColor: "rgba(125,211,252,0.45)", background: "rgba(56,139,253,0.10)", color: "#7DD3FC" };
const SETTINGS_BTN: React.CSSProperties = { ...HEADER_BTN, width: 25, padding: "3px 0", fontSize: 12 };
const SETTINGS_BTN_ACTIVE: React.CSSProperties = {
  ...SETTINGS_BTN,
  border: "1px solid #39754A",
  background: "rgba(86,194,113,0.12)",
  color: "#72D38A",
};
const SETTINGS_BTN_FOCUS: React.CSSProperties = { outline: "2px solid #58A6FF", outlineOffset: 2 };
const RAIL: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 10,
  width: REVIEW_PANEL_RAIL_WIDTH,
  height: "100%",
  padding: "12px 0",
  boxSizing: "border-box",
  border: "none",
  borderLeft: "1px solid #20262F",
  background: "#0B0E13",
  cursor: "pointer",
  font: "inherit",
  ...NO_FOCUS_RING,
};
const RAIL_GLYPH: React.CSSProperties = { fontSize: 13, fontWeight: 700, color: "#9AA4B2", lineHeight: 1 };
const RAIL_LABEL: React.CSSProperties = { writingMode: "vertical-rl", fontSize: 11, fontWeight: 700, letterSpacing: 0.5, color: "#9AA4B2", textTransform: "uppercase" };
const RAIL_COUNT: React.CSSProperties = { fontSize: 9, fontWeight: 600, color: "#9AA4B2", background: "#1B212A", borderRadius: 8, padding: "3px 2px", writingMode: "vertical-rl" };
const RAIL_STALE: React.CSSProperties = { borderLeftColor: "#9A7B2D" };
const RAIL_STALE_DOT: React.CSSProperties = { width: 7, height: 7, borderRadius: 999, background: "#D29922", boxShadow: "0 0 0 3px rgba(210,153,34,0.12)" };
const HEADER_REF: React.CSSProperties = { display: "flex", alignItems: "center", gap: 6, fontFamily: MONO, fontSize: 11 };
const PROVENANCE_ROW: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, minWidth: 0 };
// The PR provenance line flows inline (its spaces are text, not gaps) — see PrProvenance.
const PROVENANCE: React.CSSProperties = { minWidth: 0, fontFamily: MONO, fontSize: 11, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" };
const REF_BRANCH: React.CSSProperties = { color: "#6BE38A" };
const REF_ARROW: React.CSSProperties = { color: "#5A6472" };
const REF_BASE: React.CSSProperties = { color: "#9AA4B2" };
const ADDED_FILES_NOTE: React.CSSProperties = { fontSize: 11, color: "#7D8695" };
const PROGRESS_ROW: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8 };
const PROGRESS_TRACK: React.CSSProperties = { flex: 1, height: 5, background: "#1B212A", borderRadius: 3, overflow: "hidden" };
const PROGRESS_FILL: React.CSSProperties = { height: "100%", background: REVIEW_VIEWED_ACCENT, transition: "width 160ms ease" };
const PROGRESS_LABEL: React.CSSProperties = { fontSize: 11, color: "#9AA4B2", whiteSpace: "nowrap" };
const WARNING: React.CSSProperties = { fontSize: 11, color: "#D29922", background: "rgba(210,153,34,0.1)", borderRadius: 5, padding: "4px 8px" };
const EXTRACT_WARNING: React.CSSProperties = { ...WARNING, display: "flex", alignItems: "flex-start", gap: 6 };
const EXTRACT_WARNING_DETAIL: React.CSSProperties = { color: "#9A7B2D" };
const WARNING_DISMISS: React.CSSProperties = { font: "inherit", border: "none", background: "transparent", color: "#D29922", cursor: "pointer", padding: 0, lineHeight: "14px", fontSize: 13, ...NO_FOCUS_RING };
const BODY_STACK: React.CSSProperties = { position: "relative", width: "100%", height: "100%", minHeight: 0 };
const REVIEW_BODY: React.CSSProperties = { display: "flex", flexDirection: "column", width: "100%", height: "100%", minHeight: 0 };
const REVIEW_SECTION_SURFACE: React.CSSProperties = { display: "flex", flexDirection: "column", width: "100%", height: "100%", minHeight: 0, overflow: "hidden" };
const PREFERENCES_LAYER: React.CSSProperties = { position: "absolute", inset: 0, display: "flex" };
const SCROLL: React.CSSProperties = { width: "100%", height: "100%", minHeight: 0, boxSizing: "border-box", overflowY: "auto", padding: "8px 10px 24px" };
