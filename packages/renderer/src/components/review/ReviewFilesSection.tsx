/**
 * The files-first checklist — the review panel's PRIMARY section. Every changed file is one row
 * (GitHub's "Files changed" mental model): status letter, path, a per-file "viewed" check on the
 * right, and inside it the touched code units (functions/classes/interfaces — exactly the amber
 * blocks on the graph), each with its own tick. The file check cascades over its units; a file
 * with every unit ticked reads viewed and auto-folds (like GitHub's viewed fold — the manual
 * chevron override resets whenever the viewed state itself changes, so the fold gesture always
 * wins on completion). Hovering a row lights its blocks on the graph; clicking a unit selects it
 * there. Comment buttons open one shared composer; drafts render under their row (ReviewComments).
 */

import { memo, useEffect, useMemo, useState } from "react";
import { useBlueprint, useBlueprintActions } from "../../state/StoreContext";
import { checkStateOf, type ReviewFileRow } from "../../derive/reviewFiles";
import {
  countViewedReviewFiles,
  reviewFileProgressState,
} from "../../state/reviewFileProgress";
import type { PrGitHubComment } from "../../state/prTypes";
import type { ReviewComment, ReviewTick } from "../../state/reviewTicksPref";
import { useActiveChangeGroup } from "./ChangeGroupStrip";
import { ExistingCommentLinks, ExistingCommentList } from "./ExistingReviewComments";
import { CommentButton, CommentComposer, CommentList } from "./ReviewComments";
import { UnitRow } from "./ReviewUnitRow";
import { isHeadSideReviewComment } from "./useCodeReviewComments";
import { isReviewPathInScope } from "../../derive/reviewPathScope";
import { preparedReviewFileForCursor } from "../../state/prPreparation";
import { basename, CARET, MONO, NO_FOCUS_RING, SECTION_COUNT, SECTION_HEAD, SECTION_TITLE, TICK_BTN, TICK_COLOR, TICK_GLYPH, type CommentTarget } from "./reviewPanelKit";

const STATUS_COLOR: Record<string, string> = { added: "#3FB950", modified: "#D29922", deleted: "#F85149", renamed: "#7DD3FC" };
// Large PRs keep every file row visible, but mounting every unit/comment body at once multiplies the
// initial DOM and global hover/repaint work. Scoped and focused reviews normally fall below this
// threshold and retain the convenient expanded-by-default checklist.
const AUTO_EXPAND_FILE_LIMIT = 40;

/** Drafts grouped by row in one pass (vs a per-row scan on every render). */
type DraftsByRow = ReadonlyMap<string, ReviewComment[]>;
interface DraftCounts {
  file: number;
  unit: number;
  line: number;
}
type DraftCountsByFile = ReadonlyMap<string, DraftCounts>;
type GitHubCommentsByFile = ReadonlyMap<string, PrGitHubComment[]>;

const NO_GITHUB_COMMENTS: readonly PrGitHubComment[] = [];

const rowKey = (path: string, nodeId: string | null): string => nodeId ?? `file:${path}`;

export interface ReviewFilesSectionProps {
  /** Focus the changed-file checklist by letting it use the review body's full working area. */
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
}

export type ReviewFileProjectionState =
  | "artifact-matched"
  | "artifact-unmatched"
  | "unloaded"
  | "loading"
  | "error"
  | "committed-matched"
  | "committed-unmatched";

/** Interpret moduleId only for the coordinate which produced it. In a lazy prepared review, a null
 * module on every other manifest row means “not loaded”, never “the extractor found nothing”. */
export function reviewFileProjectionState(input: {
  prepared: boolean;
  path: string;
  moduleId: string | null;
  committedPath: string | null;
  pendingPath: string | null;
  errorPath: string | null;
}): ReviewFileProjectionState {
  if (!input.prepared) return input.moduleId === null ? "artifact-unmatched" : "artifact-matched";
  if (input.pendingPath === input.path) return "loading";
  if (input.errorPath === input.path) return "error";
  if (input.committedPath !== input.path) return "unloaded";
  return input.moduleId === null ? "committed-unmatched" : "committed-matched";
}

function ReviewFilesSectionImpl({ expanded = false, onExpandedChange }: ReviewFilesSectionProps) {
  const allFiles = useBlueprint((state) => state.reviewFiles);
  const sort = useBlueprint((state) => state.reviewFilesSort);
  const unitTicks = useBlueprint((state) => state.reviewUnitTicks);
  const fileTicks = useBlueprint((state) => state.reviewFileTicks);
  const progressCatalog = useBlueprint((state) => state.reviewProgressCatalog);
  const showTests = useBlueprint((state) => state.showTests);
  const comments = useBlueprint((state) => state.reviewComments);
  const discussion = useBlueprint((state) => state.prDiscussion);
  const commentsVisible = useBlueprint((state) => state.reviewCommentsVisible);
  const pathScope = useBlueprint((state) => state.reviewPathScope);
  const focusedSubgraphPaths = useBlueprint((state) => state.reviewFocusedSubgraph?.filePaths ?? null);
  const prepared = useBlueprint((state) => state.prReviewed !== null
    && state.prPreparedHead !== null
    && state.prPreparedMergeBase !== null);
  const committedPath = useBlueprint((state) =>
    preparedReviewFileForCursor(state.prPreparedChangedFiles, state.prPreparedReviewCursor)?.path ?? null);
  const pending = useBlueprint((state) => state.prPreparedProjectionPending);
  const projectionError = useBlueprint((state) => state.prPreparedProjectionError);
  const pendingPath = pending?.kind === "file" ? pending.path : null;
  const errorPath = projectionError?.kind === "file" ? projectionError.path : null;
  const overviewPending = pending?.kind === "overview";
  const overviewError = projectionError?.kind === "overview" ? projectionError.message : null;
  const { focusReviewOverview, setReviewFilesSort } = useBlueprintActions();
  const activeGroup = useActiveChangeGroup();
  const [open, setOpen] = useState(true);
  const [composer, setComposer] = useState<CommentTarget | null>(null);
  // An isolated change group scopes the checklist to its own files — the same lens the graph shows.
  const files = useMemo(() => {
    let scoped = allFiles;
    if (activeGroup !== null) {
      const member = new Set(activeGroup.files);
      scoped = allFiles.filter((file) => member.has(file.path));
    }
    if (pathScope !== null) {
      scoped = scoped.filter((file) => isReviewPathInScope(file.path, pathScope));
    }
    if (focusedSubgraphPaths !== null) {
      const member = new Set(focusedSubgraphPaths);
      scoped = scoped.filter((file) => member.has(file.path));
    }
    return [...scoped].sort(sort === "risk" ? byRisk : byGraphThenPath);
  }, [allFiles, activeGroup, focusedSubgraphPaths, pathScope, sort]);
  const draftIndex = useMemo(() => {
    const byRow = new Map<string, ReviewComment[]>();
    const countsByFile = new Map<string, DraftCounts>();
    for (const comment of comments) {
      const counts = countsByFile.get(comment.path) ?? { file: 0, unit: 0, line: 0 };
      const key = comment.line !== null ? rowKey(comment.path, null) : rowKey(comment.path, comment.nodeId);
      if (comment.line !== null) {
        counts.line += 1;
      } else if (comment.nodeId === null) {
        counts.file += 1;
      } else {
        counts.unit += 1;
      }
      countsByFile.set(comment.path, counts);
      const bucket = byRow.get(key);
      bucket ? bucket.push(comment) : byRow.set(key, [comment]);
    }
    return { byRow, countsByFile };
  }, [comments]);
  const githubCommentsByFile = useMemo(() => {
    const byFile = new Map<string, PrGitHubComment[]>();
    for (const comment of discussion?.comments ?? NO_GITHUB_COMMENTS) {
      const bucket = byFile.get(comment.path);
      bucket ? bucket.push(comment) : byFile.set(comment.path, [comment]);
    }
    return byFile;
  }, [discussion]);
  if (files.length === 0) {
    return null;
  }
  const viewed = countViewedReviewFiles(progressCatalog, unitTicks, fileTicks, showTests);
  const total = progressCatalog?.order.length ?? 0;
  const scopeSuffix = files.length === total ? "" : ` · ${files.length} in view`;
  const rowStates = files.map((file) => reviewFileProjectionState({
    prepared,
    path: file.path,
    moduleId: file.moduleId,
    committedPath,
    pendingPath,
    errorPath,
  }));
  const unmatchedCount = rowStates.filter((state) =>
    state === "artifact-unmatched" || state === "committed-unmatched").length;
  const preparedSummary = overviewPending
    ? "restoring overview…"
    : pendingPath !== null
    ? "loading file graph…"
    : committedPath === null
      ? `${viewed}/${total} viewed · overview${scopeSuffix}`
      : unmatchedCount > 0
        ? "current file not extracted"
        : `${viewed}/${total} viewed${scopeSuffix}`;
  const listOpen = expanded || open;
  const toggleList = () => {
    if (expanded) {
      // Collapsing a focused list restores the surrounding review context at the same time.
      setOpen(false);
      onExpandedChange?.(false);
      return;
    }
    setOpen((value) => !value);
  };
  const toggleExpanded = () => {
    const next = !expanded;
    if (next) setOpen(true);
    onExpandedChange?.(next);
  };
  return (
    <section>
      <div style={{ ...SECTION_HEAD, boxSizing: "border-box", cursor: "default" }}>
        <button type="button" style={SECTION_TOGGLE} aria-expanded={listOpen} onClick={toggleList}>
          <span style={CARET}>{listOpen ? "▾" : "▸"}</span>
          <span style={SECTION_TITLE}>Files changed</span>
          <span style={SECTION_COUNT} title={unmatchedCount > 0 ? "The extractor produced no graph node for the loaded file; its changed source remains available." : undefined}>
            {prepared ? `${total} files · ${preparedSummary}` : unmatchedCount > 0 ? `${total} files · ${unmatchedCount} not extracted` : `${viewed}/${total} viewed${scopeSuffix}`}
          </span>
        </button>
        <div style={SORT_TOGGLE} role="group" aria-label="Sort changed files">
          <button type="button" style={sortButtonStyle(sort === "path")} aria-pressed={sort === "path"} onClick={() => setReviewFilesSort("path")}>
            A-Z
          </button>
          <span style={SORT_DIVIDER}>|</span>
          <button type="button" style={sortButtonStyle(sort === "risk")} aria-pressed={sort === "risk"} onClick={() => setReviewFilesSort("risk")}>
            Risk
          </button>
        </div>
        {prepared && (committedPath !== null || overviewPending || overviewError !== null) ? (
          <button
            type="button"
            style={EXPAND_TOGGLE}
            aria-label="Restore review graph overview"
            aria-busy={overviewPending || undefined}
            disabled={overviewPending}
            title={overviewError === null
              ? "Restore the bounded changed-file graph"
              : `Overview load failed: ${overviewError}. Click to retry.`}
            onClick={() => { void focusReviewOverview(); }}
          >
            <span aria-hidden="true">↩</span>
          </button>
        ) : null}
        {onExpandedChange ? (
          <button
            type="button"
            style={EXPAND_TOGGLE}
            aria-label={expanded ? "Restore review sections" : "Expand files list"}
            aria-pressed={expanded}
            title={expanded
              ? "Restore review scope and affected flows"
              : "Expand the files list to fill the review workspace"}
            onClick={toggleExpanded}
          >
            <span aria-hidden="true">{expanded ? "⤡" : "⤢"}</span>
          </button>
        ) : null}
      </div>
      {listOpen &&
        files.map((file) => (
          <FileRow
            key={file.path}
            file={file}
            unitTicks={unitTicks}
            fileTicks={fileTicks}
            drafts={draftIndex.byRow}
            draftCounts={draftIndex.countsByFile}
            githubComments={githubCommentsByFile}
            commentsVisible={commentsVisible}
            composer={composer}
            onComposer={setComposer}
            defaultExpanded={files.length <= AUTO_EXPAND_FILE_LIMIT}
          />
        ))}
    </section>
  );
}

function FileRow(props: {
  file: ReviewFileRow;
  unitTicks: Record<string, ReviewTick>;
  fileTicks: Record<string, ReviewTick>;
  drafts: DraftsByRow;
  draftCounts: DraftCountsByFile;
  githubComments: GitHubCommentsByFile;
  commentsVisible: boolean;
  composer: CommentTarget | null;
  onComposer: (target: CommentTarget | null) => void;
  defaultExpanded: boolean;
}) {
  const { file, unitTicks, fileTicks, drafts, draftCounts, githubComments, commentsVisible, composer, onComposer, defaultExpanded } = props;
  const currentNodes = useBlueprint((state) => state.index.nodesById);
  const projectionState = useBlueprint((state) => reviewFileProjectionState({
    prepared: state.prReviewed !== null
      && state.prPreparedHead !== null
      && state.prPreparedMergeBase !== null,
    path: file.path,
    moduleId: file.moduleId,
    committedPath: preparedReviewFileForCursor(
      state.prPreparedChangedFiles,
      state.prPreparedReviewCursor,
    )?.path ?? null,
    pendingPath: state.prPreparedProjectionPending?.kind === "file"
      ? state.prPreparedProjectionPending.path
      : null,
    errorPath: state.prPreparedProjectionError?.kind === "file"
      ? state.prPreparedProjectionError.path
      : null,
  }));
  const projectionError = useBlueprint((state) =>
    state.prPreparedProjectionError?.kind === "file"
      && state.prPreparedProjectionError.path === file.path
      ? state.prPreparedProjectionError.message
      : null);
  const progressFile = useBlueprint((state) => state.reviewProgressCatalog?.byPath.get(file.path) ?? null);
  const showTests = useBlueprint((state) => state.showTests);
  const { toggleReviewFileViewed, addReviewComment, setReviewLit, focusReviewFile, selectReviewNode } = useBlueprintActions();
  const [openOverride, setOpenOverride] = useState<boolean | null>(null);
  const [hovered, setHovered] = useState(false);
  const view = progressFile === null ? "todo" : reviewFileProgressState(progressFile, unitTicks, fileTicks, showTests);
  // A viewed file folds shut (GitHub's gesture). A manual chevron override holds only until the
  // viewed state next CHANGES — then the derived fold wins again, so completing the last unit
  // always folds the file even after a manual expand.
  useEffect(() => {
    setOpenOverride(null);
  }, [view]);
  const expanded = openOverride ?? (defaultExpanded && view !== "done");
  const fileDrafts = drafts.get(rowKey(file.path, null)) ?? [];
  const counts = draftCounts.get(file.path) ?? { file: 0, unit: 0, line: 0 };
  const aggregateDraftCount = counts.file + counts.unit + counts.line;
  const existingComments = githubComments.get(file.path) ?? NO_GITHUB_COMMENTS;
  // Current HEAD-line bodies move to canvas code. Keep their GitHub links in the rail because the
  // source service may truncate a very large file before that line; comments with no safe canvas
  // placement (old side, no line, deleted/unmatched file, or no link) retain their full fallback.
  const canvasComments = existingComments.filter(
    (comment) => file.moduleId !== null && file.status !== "deleted" && comment.url.length > 0 && isHeadSideReviewComment(comment),
  );
  const fallbackComments = existingComments.filter(
    (comment) => !canvasComments.includes(comment),
  );
  const composerHere = composer !== null && composer.path === file.path && composer.nodeId === null;
  const doneUnits = file.units.filter((unit) => checkStateOf(unit.fingerprint, unitTicks[unit.nodeId]) === "done").length;
  const hasBody = file.units.length > 0 || fileDrafts.length > 0 || (commentsVisible && existingComments.length > 0) || file.deletedImpact !== null;
  return (
    <div style={FILE_BLOCK}>
      <div
        style={FILE_HEAD}
        onMouseEnter={() => {
          setHovered(true);
          setReviewLit(file.units.length > 0 ? new Set(file.units.map((unit) => unit.nodeId)) : null);
        }}
        onMouseLeave={() => {
          setHovered(false);
          setReviewLit(null);
        }}
      >
        <button type="button" style={CARET_BTN} title={expanded ? "Collapse" : "Expand"} onClick={() => setOpenOverride(!expanded)}>
          <span style={{ ...CARET, visibility: hasBody ? "visible" : "hidden" }}>{expanded ? "▾" : "▸"}</span>
        </button>
        <button
          type="button"
          style={FILE_MAIN}
          title={projectionState === "unloaded"
            ? `${file.path} — click to load its graph`
            : projectionState === "loading"
              ? `${file.path} — loading graph`
              : projectionState === "error"
                ? `${file.path} — graph load failed${projectionError === null ? "" : `: ${projectionError}`}. Click to retry.`
                : projectionState === "committed-unmatched" || projectionState === "artifact-unmatched"
                  ? `${file.path} — click to view the changed source`
                  : `${file.path} — click to reveal on the graph`}
          aria-busy={projectionState === "loading" || undefined}
          disabled={projectionState === "loading"}
          onClick={() => {
            void focusReviewFile(file.path);
            if (projectionState === "artifact-matched" || projectionState === "committed-matched") {
              setOpenOverride(true);
            }
          }}
        >
          <span style={{ ...STATUS_LETTER, color: STATUS_COLOR[file.status] ?? "#9AA4B2" }} title={file.status}>
            {file.status[0].toUpperCase()}
          </span>
          <FilePath path={file.path} />
          {file.units.length > 0 && <span style={SECTION_COUNT}>{doneUnits}/{file.units.length}</span>}
          {file.blastRadius > 0 && (
            <span style={BLAST_BADGE} title={`blast radius: ${file.blastRadius} files outside this PR call into the changed code`}>
              ◎ {file.blastRadius}
            </span>
          )}
          {file.deletedImpact !== null && file.deletedImpact.callers.length > 0 && (
            <span style={CALLERS_BADGE} title={`${file.deletedImpact.callers.length} files still call into this deleted code — check every caller was updated`}>
              ⚠ {file.deletedImpact.callers.length} callers
            </span>
          )}
          {(projectionState === "unloaded"
            || projectionState === "loading"
            || projectionState === "error"
            || ((projectionState === "committed-unmatched" || projectionState === "artifact-unmatched")
              && file.deletedImpact === null)) && (
            <span
              style={NOT_IN_GRAPH}
              title={projectionState === "unloaded"
                ? "Load this file's graph on demand."
                : projectionState === "loading"
                  ? "Loading this file's graph."
                  : projectionState === "error"
                    ? projectionError ?? "The file graph could not be loaded."
                    : "The extractor produced no graph node for this file. Click to view its source."}
            >
              {projectionState === "unloaded"
                ? "load graph"
                : projectionState === "loading"
                  ? "loading graph…"
                  : projectionState === "error"
                    ? "graph load failed · retry"
                    : "not extracted · view source"}
            </span>
          )}
        </button>
        <CommentButton
          count={aggregateDraftCount}
          active={composerHere}
          visible={hovered}
          title={`${counts.file} file · ${counts.unit} unit · ${counts.line} line drafts`}
          onClick={() => {
            // The composer renders in the file body — opening it on a folded (viewed) file unfolds it.
            if (!composerHere) {
              setOpenOverride(true);
            }
            onComposer(composerHere ? null : { path: file.path, nodeId: null });
          }}
        />
        {commentsVisible ? <GitHubCommentLink comments={existingComments} /> : null}
        <button
          type="button"
          style={{ ...TICK_BTN, color: TICK_COLOR[view] }}
          title={view === "done" ? "Viewed — click to unmark" : view === "stale" ? "Changed since viewed — click to re-mark" : "Mark file as viewed"}
          onClick={() => toggleReviewFileViewed(file.path)}
        >
          {TICK_GLYPH[view]}
        </button>
      </div>
      {expanded && (
        <>
          {file.deletedImpact !== null && (
            <DeletedImpact impact={file.deletedImpact} currentNodes={currentNodes} onSelect={selectReviewNode} />
          )}
          {commentsVisible && canvasComments.length > 0 ? (
            <div style={COMMENT_FALLBACK}>
              <div style={COMMENT_FALLBACK_LABEL}>Canvas comments · open on GitHub</div>
              <ExistingCommentLinks comments={canvasComments} />
            </div>
          ) : null}
          {commentsVisible && fallbackComments.length > 0 ? (
            <div style={COMMENT_FALLBACK}>
              <div style={COMMENT_FALLBACK_LABEL}>Comments kept in the panel</div>
              <ExistingCommentList comments={fallbackComments} showLocation />
            </div>
          ) : null}
          {file.units.map((unit) => (
            <UnitRow key={unit.nodeId} unit={unit} path={file.path} tick={unitTicks[unit.nodeId]} drafts={drafts.get(rowKey(file.path, unit.nodeId)) ?? []} composer={composer} onComposer={onComposer} />
          ))}
          <CommentList comments={fileDrafts} />
          {composerHere && (
            <CommentComposer placeholder={`Comment on ${basename(file.path)}…`} onAdd={(body) => addReviewComment(file.path, null, body)} onCancel={() => onComposer(null)} />
          )}
        </>
      )}
    </div>
  );
}

function GitHubCommentLink({ comments }: { comments: readonly PrGitHubComment[] }) {
  if (comments.length === 0) {
    return null;
  }
  const href = comments.find((comment) => comment.url.length > 0)?.url;
  const label = `${comments.length} GitHub ${comments.length === 1 ? "comment" : "comments"} ↗`;
  return href ? (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      style={GITHUB_COMMENT_LINK}
      title="Open the review comment on GitHub"
      onClick={(event) => event.stopPropagation()}
    >
      {label}
    </a>
  ) : <span style={GITHUB_COMMENT_LINK}>{label}</span>;
}

function DeletedImpact(props: {
  impact: NonNullable<ReviewFileRow["deletedImpact"]>;
  currentNodes: ReadonlyMap<string, unknown>;
  onSelect: (nodeId: string) => void;
}) {
  const { impact, currentNodes, onSelect } = props;
  return (
    <div style={IMPACT_BLOCK}>
      <div style={SECTION_TITLE}>STILL CALLED BY</div>
      {impact.callers.map((caller) => {
        const navigable = currentNodes.has(caller.nodeId);
        const content = (
          <>
            <span style={CALLER_NAME}>{caller.displayName}</span>
            <span style={CALLER_LOCATION}>{caller.file}:{caller.line}</span>
          </>
        );
        return navigable ? (
          <button
            key={caller.nodeId}
            type="button"
            style={{ ...CALLER_ROW, cursor: "pointer" }}
            title={`${caller.displayName} — click to reveal on the graph`}
            onClick={() => onSelect(caller.nodeId)}
          >
            {content}
          </button>
        ) : (
          <div key={caller.nodeId} style={CALLER_ROW}>
            {content}
          </div>
        );
      })}
      {impact.unresolvedCount > 0 && (
        <div style={IMPACT_NOTE}>{impact.unresolvedCount} unresolved call sites may also reference this</div>
      )}
      {impact.callers.length === 0 && impact.unresolvedCount === 0 && (
        <div style={IMPACT_NOTE}>no surviving callers</div>
      )}
      {impact.truncated && <div style={IMPACT_NOTE}>+{impact.omittedCallerCount} more callers</div>}
    </div>
  );
}

function byGraphThenPath(a: ReviewFileRow, b: ReviewFileRow): number {
  const aInGraph = isInGraph(a);
  const bInGraph = isInGraph(b);
  if (aInGraph !== bInGraph) {
    return aInGraph ? -1 : 1;
  }
  return pathCompare(a.path, b.path);
}

function byRisk(a: ReviewFileRow, b: ReviewFileRow): number {
  const aInGraph = isInGraph(a);
  const bInGraph = isInGraph(b);
  if (aInGraph !== bInGraph) {
    return aInGraph ? -1 : 1;
  }
  if (a.blastRadius !== b.blastRadius) {
    return b.blastRadius - a.blastRadius;
  }
  const aCallers = a.deletedImpact?.callers.length ?? 0;
  const bCallers = b.deletedImpact?.callers.length ?? 0;
  if (aCallers !== bCallers) {
    return bCallers - aCallers;
  }
  return pathCompare(a.path, b.path);
}

function isInGraph(file: ReviewFileRow): boolean {
  return file.moduleId !== null || file.deletedImpact !== null;
}

function pathCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Bright basename first, dim directory after — the eye lands on the file, the dir disambiguates
 * and is what the ellipsis eats when the row is tight. */
function FilePath({ path }: { path: string }) {
  const slash = path.lastIndexOf("/");
  const dir = slash === -1 ? "" : path.slice(0, slash);
  return (
    <span style={PATH_WRAP}>
      <span style={PATH_BASE}>{path.slice(slash + 1)}</span>
      {dir && <span style={PATH_DIR}> {dir}/</span>}
    </span>
  );
}

export const ReviewFilesSection = memo(ReviewFilesSectionImpl);

const FILE_BLOCK: React.CSSProperties = { borderRadius: 8, border: "1px solid #1B212A", background: "#0D1117", marginBottom: 6, paddingBottom: 2 };
const SECTION_TOGGLE: React.CSSProperties = { flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 8, border: "none", background: "transparent", cursor: "pointer", font: "inherit", padding: 0, textAlign: "left", ...NO_FOCUS_RING };
const SORT_TOGGLE: React.CSSProperties = { display: "inline-flex", alignItems: "center", gap: 3, flexShrink: 0, fontSize: 9.5 };
const SORT_DIVIDER: React.CSSProperties = { color: "#3A4452" };
const SORT_BUTTON: React.CSSProperties = { border: "none", background: "transparent", cursor: "pointer", font: "inherit", fontSize: 9.5, padding: "1px 2px", ...NO_FOCUS_RING };
const sortButtonStyle = (active: boolean): React.CSSProperties => ({ ...SORT_BUTTON, color: active ? "#E6EDF3" : "#5A6472", fontWeight: active ? 700 : 500 });
const EXPAND_TOGGLE: React.CSSProperties = {
  width: 22,
  height: 22,
  flexShrink: 0,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  border: "1px solid #2A3441",
  borderRadius: 5,
  background: "transparent",
  color: "#9AA4B2",
  cursor: "pointer",
  font: "inherit",
  fontSize: 12,
  lineHeight: 1,
  padding: 0,
  ...NO_FOCUS_RING,
};
const FILE_HEAD: React.CSSProperties = { display: "flex", alignItems: "center", gap: 2, padding: "2px 6px 2px 4px" };
const CARET_BTN: React.CSSProperties = { display: "inline-flex", alignItems: "center", justifyContent: "center", width: 18, alignSelf: "stretch", border: "none", background: "transparent", cursor: "pointer", padding: 0, flexShrink: 0, ...NO_FOCUS_RING };
const FILE_MAIN: React.CSSProperties = { flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 6, border: "none", background: "transparent", cursor: "pointer", font: "inherit", padding: "5px 2px", textAlign: "left", ...NO_FOCUS_RING };
const STATUS_LETTER: React.CSSProperties = { fontFamily: MONO, fontSize: 11, fontWeight: 700, width: 12, flexShrink: 0, textAlign: "center" };
const PATH_WRAP: React.CSSProperties = { flex: 1, minWidth: 0, fontFamily: MONO, fontSize: 11.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" };
const PATH_DIR: React.CSSProperties = { color: "#5A6472" };
const PATH_BASE: React.CSSProperties = { color: "#E6EDF3", fontWeight: 600 };
const BLAST_BADGE: React.CSSProperties = { fontSize: 9.5, fontWeight: 600, color: "#7D8695", background: "#151B23", border: "1px solid #252D38", borderRadius: 9, padding: "0 5px", flexShrink: 0 };
const CALLERS_BADGE: React.CSSProperties = { fontSize: 9.5, fontWeight: 700, color: "#E3B341", background: "#2B2110", border: "1px solid #5C4718", borderRadius: 9, padding: "0 6px", flexShrink: 0 };
const NOT_IN_GRAPH: React.CSSProperties = { fontSize: 9.5, fontStyle: "italic", color: "#5A6472", flexShrink: 0 };
const GITHUB_COMMENT_LINK: React.CSSProperties = { color: "#7DD3FC", fontSize: 9.5, textDecoration: "none", whiteSpace: "nowrap", flexShrink: 0 };
const IMPACT_BLOCK: React.CSSProperties = { margin: "4px 8px 5px 24px", padding: "7px 8px", borderLeft: "2px solid #5C4718", background: "#121417", borderRadius: "0 5px 5px 0" };
const CALLER_ROW: React.CSSProperties = { width: "100%", minWidth: 0, display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8, border: "none", background: "transparent", font: "inherit", padding: "3px 0", textAlign: "left", ...NO_FOCUS_RING };
const CALLER_NAME: React.CSSProperties = { minWidth: 0, color: "#E6EDF3", fontSize: 11.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
const CALLER_LOCATION: React.CSSProperties = { color: "#5A6472", fontFamily: MONO, fontSize: 9.5, flexShrink: 0 };
const IMPACT_NOTE: React.CSSProperties = { color: "#6E7781", fontSize: 10, fontStyle: "italic", paddingTop: 3 };
const COMMENT_FALLBACK: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 5, margin: "3px 6px 5px 26px" };
const COMMENT_FALLBACK_LABEL: React.CSSProperties = { color: "#7B8695", fontSize: 9.5, fontWeight: 650 };
