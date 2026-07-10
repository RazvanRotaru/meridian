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
import type { ReviewComment, ReviewTick } from "../../state/reviewTicksPref";
import { CommentButton, CommentComposer, CommentList } from "./ReviewComments";
import { UnitRow } from "./ReviewUnitRow";
import { basename, CARET, MONO, SECTION_COUNT, SECTION_HEAD, SECTION_TITLE, TICK_BTN, TICK_COLOR, TICK_GLYPH, type CommentTarget } from "./reviewPanelKit";

const STATUS_COLOR: Record<string, string> = { added: "#3FB950", modified: "#D29922", deleted: "#F85149", renamed: "#7DD3FC" };

/** Drafts grouped by row in one pass (vs a per-row scan on every render). */
type DraftsByRow = ReadonlyMap<string, ReviewComment[]>;

const rowKey = (path: string, nodeId: string | null): string => nodeId ?? `file:${path}`;

function ReviewFilesSectionImpl() {
  const files = useBlueprint((state) => state.reviewFiles);
  const unitTicks = useBlueprint((state) => state.reviewUnitTicks);
  const fileTicks = useBlueprint((state) => state.reviewFileTicks);
  const comments = useBlueprint((state) => state.reviewComments);
  const [open, setOpen] = useState(true);
  const [composer, setComposer] = useState<CommentTarget | null>(null);
  const drafts: DraftsByRow = useMemo(() => {
    const map = new Map<string, ReviewComment[]>();
    for (const comment of comments) {
      const key = rowKey(comment.path, comment.nodeId);
      const bucket = map.get(key);
      bucket ? bucket.push(comment) : map.set(key, [comment]);
    }
    return map;
  }, [comments]);
  if (files.length === 0) {
    return null;
  }
  const viewed = files.filter((file) => fileViewState(file, unitTicks, fileTicks) === "done").length;
  return (
    <section>
      <button type="button" style={SECTION_HEAD} onClick={() => setOpen((value) => !value)}>
        <span style={CARET}>{open ? "▾" : "▸"}</span>
        <span style={SECTION_TITLE}>Files changed</span>
        <span style={SECTION_COUNT}>{viewed}/{files.length} viewed</span>
      </button>
      {open &&
        files.map((file) => (
          <FileRow key={file.path} file={file} unitTicks={unitTicks} fileTicks={fileTicks} drafts={drafts} composer={composer} onComposer={setComposer} />
        ))}
    </section>
  );
}

function FileRow(props: {
  file: ReviewFileRow;
  unitTicks: Record<string, ReviewTick>;
  fileTicks: Record<string, ReviewTick>;
  drafts: DraftsByRow;
  composer: CommentTarget | null;
  onComposer: (target: CommentTarget | null) => void;
}) {
  const { file, unitTicks, fileTicks, drafts, composer, onComposer } = props;
  const { toggleReviewFileViewed, addReviewComment, setReviewLit, focusReviewFile } = useBlueprintActions();
  const focused = useBlueprint((state) => file.moduleId !== null && state.reviewSelectedId === file.moduleId);
  const [openOverride, setOpenOverride] = useState<boolean | null>(null);
  const [hovered, setHovered] = useState(false);
  const view = fileViewState(file, unitTicks, fileTicks);
  // A viewed file folds shut (GitHub's gesture). A manual chevron override holds only until the
  // viewed state next CHANGES — then the derived fold wins again, so completing the last unit
  // always folds the file even after a manual expand.
  useEffect(() => {
    setOpenOverride(null);
  }, [view]);
  const expanded = openOverride ?? (view !== "done");
  const fileDrafts = drafts.get(rowKey(file.path, null)) ?? [];
  const composerHere = composer !== null && composer.path === file.path && composer.nodeId === null;
  const doneUnits = file.units.filter((unit) => checkStateOf(unit.fingerprint, unitTicks[unit.nodeId]) === "done").length;
  return (
    <div style={focused ? FILE_BLOCK_FOCUSED : FILE_BLOCK}>
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
          <span style={{ ...CARET, visibility: file.units.length > 0 || fileDrafts.length > 0 ? "visible" : "hidden" }}>{expanded ? "▾" : "▸"}</span>
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
          {file.moduleId === null && (
            <span style={NOT_IN_GRAPH} title="this change mapped to no extracted code block">not in graph</span>
          )}
        </button>
        <CommentButton
          count={fileDrafts.length}
          active={composerHere}
          visible={hovered}
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
const FILE_BLOCK_FOCUSED: React.CSSProperties = { ...FILE_BLOCK, borderColor: "#2E3A4D", background: "rgba(46,58,77,0.18)" };
const FILE_HEAD: React.CSSProperties = { display: "flex", alignItems: "center", gap: 2, padding: "2px 6px 2px 4px" };
const CARET_BTN: React.CSSProperties = { display: "inline-flex", alignItems: "center", justifyContent: "center", width: 18, alignSelf: "stretch", border: "none", background: "transparent", cursor: "pointer", padding: 0, flexShrink: 0 };
const FILE_MAIN: React.CSSProperties = { flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 6, border: "none", background: "transparent", cursor: "pointer", font: "inherit", padding: "5px 2px", textAlign: "left" };
const STATUS_LETTER: React.CSSProperties = { fontFamily: MONO, fontSize: 11, fontWeight: 700, width: 12, flexShrink: 0, textAlign: "center" };
const PATH_WRAP: React.CSSProperties = { flex: 1, minWidth: 0, fontFamily: MONO, fontSize: 11.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" };
const PATH_DIR: React.CSSProperties = { color: "#5A6472" };
const PATH_BASE: React.CSSProperties = { color: "#E6EDF3", fontWeight: 600 };
const NOT_IN_GRAPH: React.CSSProperties = { fontSize: 9.5, fontStyle: "italic", color: "#5A6472", flexShrink: 0 };
