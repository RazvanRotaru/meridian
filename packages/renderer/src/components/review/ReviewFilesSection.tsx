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
import { checkStateOf, fileViewState, type ReviewFileRow } from "../../derive/reviewFiles";
import type { PrGitHubComment } from "../../state/prTypes";
import type { ReviewComment, ReviewTick } from "../../state/reviewTicksPref";
import { useActiveChangeGroup } from "./ChangeGroupStrip";
import { ExistingCommentLinks, ExistingCommentList } from "./ExistingReviewComments";
import { CommentButton, CommentComposer, CommentList } from "./ReviewComments";
import { UnitRow } from "./ReviewUnitRow";
import { isHeadSideReviewComment } from "./useCodeReviewComments";
import { isReviewPathInScope } from "../../derive/reviewPathScope";
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

function ReviewFilesSectionImpl() {
  const allFiles = useBlueprint((state) => state.reviewFiles);
  const sort = useBlueprint((state) => state.reviewFilesSort);
  const unitTicks = useBlueprint((state) => state.reviewUnitTicks);
  const fileTicks = useBlueprint((state) => state.reviewFileTicks);
  const comments = useBlueprint((state) => state.reviewComments);
  const discussion = useBlueprint((state) => state.prDiscussion);
  const commentsVisible = useBlueprint((state) => state.reviewCommentsVisible);
  const pathScope = useBlueprint((state) => state.reviewPathScope);
  const focusedSubgraphPaths = useBlueprint((state) => state.reviewFocusedSubgraph?.filePaths ?? null);
  const { setReviewFilesSort } = useBlueprintActions();
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
  const viewed = files.filter((file) => fileViewState(file, unitTicks, fileTicks) === "done").length;
  const unmatchedCount = files.filter((file) => file.moduleId === null).length;
  return (
    <section>
      <div style={{ ...SECTION_HEAD, boxSizing: "border-box", cursor: "default" }}>
        <button type="button" style={SECTION_TOGGLE} onClick={() => setOpen((value) => !value)}>
          <span style={CARET}>{open ? "▾" : "▸"}</span>
          <span style={SECTION_TITLE}>Files changed</span>
          <span style={SECTION_COUNT} title={unmatchedCount > 0 ? "the graph shows the base branch, added files join it after Extract head graph." : undefined}>
            {unmatchedCount > 0 ? `${files.length} files · ${unmatchedCount} not in this graph` : `${viewed}/${files.length} viewed`}
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
      </div>
      {open &&
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
  const preparedArtifactCurrent = useBlueprint((state) => state.prPreparedArtifactCurrent);
  const { toggleReviewFileViewed, addReviewComment, setReviewLit, focusReviewFile, selectReviewNode } = useBlueprintActions();
  const [openOverride, setOpenOverride] = useState<boolean | null>(null);
  const [hovered, setHovered] = useState(false);
  const view = fileViewState(file, unitTicks, fileTicks);
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
          title={file.moduleId !== null ? `${file.path} — click to reveal on the graph` : file.path}
          onClick={() => {
            // In-graph file: the click REVEALS it (select + light + center); the caret alone folds.
            if (file.moduleId !== null) {
              focusReviewFile(file.path);
              setOpenOverride(true);
            } else {
              setOpenOverride(!expanded);
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
          {file.moduleId === null && file.deletedImpact === null && (
            file.status === "added" && !preparedArtifactCurrent ? (
              <span style={NOT_IN_GRAPH} title="This file is new in the PR. Extract head graph to include it.">added — extract head to view</span>
            ) : (
              <span style={NOT_IN_GRAPH} title="this change mapped to no extracted code block">not in graph</span>
            )
          )}
        </button>
        <CommentButton
          count={aggregateDraftCount}
          active={composerHere}
          visible={hovered}
          title={`${counts.file} file · ${counts.unit} unit · ${counts.line} line drafts${existingComments.length > 0 ? ` (${existingComments.length} on GitHub)` : ""}`}
          suffix={existingComments.length > 0 ? `(${existingComments.length} on GitHub)` : undefined}
          onClick={() => {
            // The composer renders in the file body — opening it on a folded (viewed) file unfolds it.
            if (!composerHere) {
              setOpenOverride(true);
            }
            onComposer(composerHere ? null : { path: file.path, nodeId: null });
          }}
        />
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
const IMPACT_BLOCK: React.CSSProperties = { margin: "4px 8px 5px 24px", padding: "7px 8px", borderLeft: "2px solid #5C4718", background: "#121417", borderRadius: "0 5px 5px 0" };
const CALLER_ROW: React.CSSProperties = { width: "100%", minWidth: 0, display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8, border: "none", background: "transparent", font: "inherit", padding: "3px 0", textAlign: "left", ...NO_FOCUS_RING };
const CALLER_NAME: React.CSSProperties = { minWidth: 0, color: "#E6EDF3", fontSize: 11.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
const CALLER_LOCATION: React.CSSProperties = { color: "#5A6472", fontFamily: MONO, fontSize: 9.5, flexShrink: 0 };
const IMPACT_NOTE: React.CSSProperties = { color: "#6E7781", fontSize: 10, fontStyle: "italic", paddingTop: 3 };
const COMMENT_FALLBACK: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 5, margin: "3px 6px 5px 26px" };
const COMMENT_FALLBACK_LABEL: React.CSSProperties = { color: "#7B8695", fontSize: 9.5, fontWeight: 650 };
