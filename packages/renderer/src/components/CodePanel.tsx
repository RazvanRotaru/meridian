/**
 * Shared source rendering with two hosts. `CodePanel` is the centered overlay that expands an
 * ordinary node/PR source view; `EdgeSourcePane` is the backdrop-free left half of the graph-local
 * edge inspection dock. The latter deliberately owns no close gesture—the dock closes source and
 * wire evidence together. CodeBlock escapes source as plain text children.
 */

import { useEffect, useMemo, useState } from "react";
import { anchorableHunks } from "../derive/reviewSubmit";
import { formatCallSite } from "../graph/edgeEvidence";
import { useBlueprint, useBlueprintActions } from "../state/StoreContext";
import type { CodeView } from "../state/store";
import { relationColor } from "../theme/relationTheme";
import { useClearOnEscape } from "./canvas/useClearOnEscape";
import { CodeBlock } from "./CodeBlock";
import { useCodeReviewComments } from "./review/useCodeReviewComments";
import { summarizeChangeKinds, useChangeSummary, useChangedLines, useLineChangeKinds } from "./useChangedLines";

export function CodePanel() {
  const codeView = useBlueprint((state) => state.codeView);
  const { closeCode } = useBlueprintActions();
  const open = codeView?.mode === "modal" && codeView.edgeEvidence === undefined;

  // Edge evidence has a graph-local host beside its wire inspector. Keeping the global panel
  // deliberately empty prevents the old second modal (and its independent close lifecycle).
  useClearOnEscape(closeCode, open);
  if (!codeView || !open) {
    return null;
  }
  return (
    <div style={BACKDROP_STYLE} onClick={closeCode}>
      <SourcePanel codeView={codeView} presentation="modal" onClose={closeCode} />
    </div>
  );
}

/** Contextual source hosted inside the graph-local edge inspection dock. It has no backdrop,
 * close control, or Escape layer: the dock owns that one lifecycle for both of its panes. */
export function EdgeSourcePane() {
  const codeView = useBlueprint((state) => state.codeView);
  if (!codeView || codeView.mode !== "modal" || codeView.edgeEvidence === undefined) {
    return null;
  }
  return <SourcePanel codeView={codeView} presentation="edge" />;
}

function SourcePanel({
  codeView,
  presentation,
  onClose,
}: {
  codeView: CodeView;
  presentation: "modal" | "edge";
  onClose?: () => void;
}) {
  const review = useBlueprint((state) => state.review);
  const prReviewed = useBlueprint((state) => state.prReviewed);
  const index = useBlueprint((state) => state.index);
  const removed = useBlueprint((state) => state.reviewRemovedByFile[codeView.node.location?.file ?? ""] ?? EMPTY_REMOVED);
  const removedTruncated = useBlueprint((state) => state.reviewRemovedTruncatedByFile[codeView.node.location?.file ?? ""] === true);
  const removedAtHead = useBlueprint((state) => state.reviewFileDelta[codeView.node.location?.file ?? ""]?.status === "removed");
  const { addReviewComment, selectEdgeEvidence } = useBlueprintActions();
  const wholeFile = codeView.wholeFile ?? false;
  // A PR-review panel carries its own head-relative diff; otherwise the artifact's `changedSince`
  // drives the paint. The hooks run unconditionally (rules of hooks) and are overridden when carried.
  const hookChangedLines = useChangedLines(codeView.node, wholeFile);
  const hookChangedLineKinds = useLineChangeKinds(codeView.node, wholeFile);
  const hookSummary = useChangeSummary(codeView.node, wholeFile);
  const changedLines = codeView.changedLines ?? hookChangedLines;
  const changedLineKinds = codeView.changedLineKinds ?? hookChangedLineKinds;
  const summary = codeView.changedLineKinds ? summarizeChangeKinds(codeView.changedLineKinds) : hookSummary;
  const edgeEvidence = codeView.edgeEvidence;
  const activeEvidence = edgeEvidence?.contexts[edgeEvidence.activeIndex];
  const evidenceLines = useMemo(() => {
    if (!edgeEvidence) return EMPTY_EVIDENCE_LINES;
    const lines = new Set<number>();
    for (let line = edgeEvidence.focusStartLine; line <= edgeEvidence.focusEndLine; line += 1) {
      lines.add(line);
    }
    return lines;
  }, [edgeEvidence]);
  const reviewFile = codeView.node.location?.file ?? null;
  const reviewBaseLine = codeView.baseLine ?? codeView.node.location?.startLine ?? 1;
  const visibleLineCount = codeView.code === null ? 0 : codeView.code.split("\n").length;
  const visibleEnd = reviewBaseLine + Math.max(visibleLineCount - 1, 0);
  const existingComments = useCodeReviewComments(reviewFile, reviewBaseLine, codeView.code);
  const commentableLines = useMemo(() => {
    if (reviewFile === null || review === null) {
      return EMPTY_COMMENTABLE_LINES;
    }
    // A live PR source panel renders the file's HEAD-side text. Match GitHub's full-file review
    // affordance by allowing a draft on every row the reader can see, not just the rows painted as
    // added/modified. Unchanged files and removed files are not HEAD-side review targets.
    if (prReviewed !== null) {
      const changedFile = review.context.changedFiles.find((candidate) => candidate.path === reviewFile);
      if (changedFile === undefined || changedFile.status === "deleted" || removedAtHead) {
        return EMPTY_COMMENTABLE_LINES;
      }
      return new Set(Array.from({ length: visibleLineCount }, (_, index) => reviewBaseLine + index));
    }
    if (anchorableHunks(reviewFile, review.context).length === 0) {
      return EMPTY_COMMENTABLE_LINES;
    }
    // Review code is HEAD-side in both modes: sync fetches the head file, while swapped graph
    // locations are head-native. These absolute values therefore map directly to RIGHT-side lines.
    return changedLineKinds.size > 0
      ? new Set([...changedLineKinds].filter(([, kind]) => kind === "added" || kind === "modified").map(([line]) => line))
      : new Set(changedLines);
  }, [changedLineKinds, changedLines, prReviewed, removedAtHead, review, reviewBaseLine, reviewFile, visibleLineCount]);
  const visibleRemovedRows = useMemo(() => {
    const rows = new Map<number, string[]>();
    for (const entry of removed) {
      if ((entry.afterNewLine === 0 && reviewBaseLine === 1) || (entry.afterNewLine >= reviewBaseLine && entry.afterNewLine <= visibleEnd)) {
        rows.set(entry.afterNewLine, [...(rows.get(entry.afterNewLine) ?? []), ...entry.lines]);
      }
    }
    return rows;
  }, [removed, reviewBaseLine, visibleEnd]);
  const [activeCommentLine, setActiveCommentLine] = useState<number | null>(null);
  useEffect(() => setActiveCommentLine(null), [codeView.node.id, reviewBaseLine]);

  const { node, code, loading, error, truncated } = codeView;
  const { file, startLine, endLine } = node.location;
  const baseLine = codeView.baseLine ?? startLine;
  // A PR-review panel shows the HEAD file sliced to where the unit moved to, so the subtitle range
  // must track the shown lines (baseLine..+len), not the node's base span. Whole-file view titles by
  // the file and lands on the first change, so its own span in the subtitle would be misleading too.
  const isHead = codeView.changedLineKinds !== undefined;
  const shownEnd = isHead ? baseLine + Math.max((code?.split("\n").length ?? 1) - 1, 0) : endLine ?? startLine;
  const evidenceTitle = activeEvidence
    ? `${index.nodesById.get(activeEvidence.source)?.displayName ?? activeEvidence.source} → ${index.nodesById.get(activeEvidence.target)?.displayName ?? activeEvidence.target}`
    : null;
  const title = presentation === "edge" && activeEvidence
    ? `Source · ${file.split("/").pop() ?? file}`
    : evidenceTitle ?? (wholeFile ? (file.split("/").pop() ?? file) : node.displayName);
  const range = shownEnd !== baseLine ? `${baseLine}-${shownEnd}` : String(baseLine);
  const location = activeEvidence && edgeEvidence
    ? displayedEvidenceLocation(activeEvidence.site, edgeEvidence.focusStartLine, edgeEvidence.focusEndLine)
    : wholeFile
      ? file
      : `${file}:${range}`;

  return (
    <div
      style={presentation === "edge" ? EDGE_PANEL_STYLE : PANEL_STYLE}
      role={presentation === "edge" ? "region" : "dialog"}
      aria-modal={presentation === "modal" ? true : undefined}
      aria-label={presentation === "edge" ? "Highlighted edge source" : "Source code"}
      onClick={(event) => event.stopPropagation()}
    >
        <header style={HEADER_STYLE}>
          <div style={HEADER_TEXT_STYLE}>
            <div style={TITLE_STYLE} title={node.qualifiedName}>{title}</div>
            <div style={LOCATION_STYLE} title={file}>{location}</div>
            {activeEvidence && edgeEvidence ? (
              <div style={EVIDENCE_ROW_STYLE}>
                <span style={{ ...EVIDENCE_DOT_STYLE, background: relationColor(activeEvidence.kind) ?? "#7DD3FC" }} />
                <span style={EVIDENCE_KIND_STYLE}>{activeEvidence.kind}</span>
                <span style={EVIDENCE_COUNT_STYLE}>
                  Evidence {edgeEvidence.activeIndex + 1} of {edgeEvidence.contexts.length}
                </span>
                {edgeEvidence.contexts.length > 1 ? (
                  <span style={EVIDENCE_NAV_STYLE}>
                    <button
                      type="button"
                      style={EVIDENCE_NAV_BUTTON_STYLE}
                      disabled={edgeEvidence.activeIndex === 0}
                      aria-label="Previous edge evidence"
                      onClick={() => void selectEdgeEvidence(edgeEvidence.activeIndex - 1)}
                    >
                      ‹
                    </button>
                    <button
                      type="button"
                      style={EVIDENCE_NAV_BUTTON_STYLE}
                      disabled={edgeEvidence.activeIndex === edgeEvidence.contexts.length - 1}
                      aria-label="Next edge evidence"
                      onClick={() => void selectEdgeEvidence(edgeEvidence.activeIndex + 1)}
                    >
                      ›
                    </button>
                  </span>
                ) : null}
              </div>
            ) : null}
            {summary ? (
              <div style={SUMMARY_ROW_STYLE}>
                <span style={ADDED_STYLE}>{`+${summary.added} lines`}</span>
                <span style={DELETED_STYLE}>{`-${summary.deleted} lines`}</span>
              </div>
            ) : null}
          </div>
          {onClose ? (
            <button type="button" style={CLOSE_STYLE} onClick={onClose} aria-label="Close source">
              ×
            </button>
          ) : null}
        </header>
        <div style={BODY_STYLE}>
          {loading ? <div style={STATUS_STYLE}>Loading source…</div> : null}
          {error ? <div style={ERROR_STYLE}>{error}</div> : null}
          {code !== null ? (
            <CodeBlock
              code={code}
              maxHeight={presentation === "edge" ? "62vh" : "70vh"}
              startLine={baseLine}
              showGutter
              changedLines={changedLines}
              changedLineKinds={changedLineKinds}
              evidenceLines={evidenceLines}
              commentableLines={commentableLines}
              onLineClick={commentableLines.size > 0 ? setActiveCommentLine : undefined}
              lineComposer={activeCommentLine === null || !commentableLines.has(activeCommentLine) ? null : {
                line: activeCommentLine,
                onAdd: (body) => addReviewComment(file, null, body, activeCommentLine),
                onCancel: () => setActiveCommentLine(null),
              }}
              existingComments={existingComments}
              removedRows={visibleRemovedRows}
              removedTruncated={removedTruncated}
            />
          ) : null}
          {truncated ? <div style={TRUNCATED_STYLE}>Snippet truncated by the server.</div> : null}
        </div>
    </div>
  );
}

const EMPTY_COMMENTABLE_LINES: ReadonlySet<number> = new Set<number>();
const EMPTY_EVIDENCE_LINES: ReadonlySet<number> = new Set<number>();
const EMPTY_REMOVED: readonly { afterNewLine: number; lines: string[] }[] = [];

function displayedEvidenceLocation(
  site: { file: string; line: number; col?: number; endLine?: number; endCol?: number },
  shownStart: number,
  shownEnd: number,
): string {
  if (shownStart === site.line && shownEnd === (site.endLine ?? site.line)) {
    return formatCallSite(site);
  }
  return shownStart === shownEnd ? `${site.file}:${shownStart}` : `${site.file}:${shownStart}–${shownEnd}`;
}

const BACKDROP_STYLE: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  background: "rgba(8,10,14,0.6)",
  zIndex: 30,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};
const PANEL_STYLE: React.CSSProperties = {
  width: "70vw",
  maxWidth: 900,
  height: "75vh",
  display: "flex",
  flexDirection: "column",
  background: "#0E1116",
  border: "1px solid #2A2F37",
  borderRadius: 12,
  overflow: "hidden",
  boxShadow: "0 24px 64px rgba(0,0,0,0.55)",
};
const EDGE_PANEL_STYLE: React.CSSProperties = {
  width: "min(58vw, 820px)",
  minWidth: 0,
  height: "min(72vh, 700px)",
  display: "flex",
  flexDirection: "column",
  background: "#0E1116",
  borderRight: "1px solid #30363d",
  overflow: "hidden",
};
const HEADER_STYLE: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 12,
  padding: "12px 14px",
  borderBottom: "1px solid #2A2F37",
  background: "#161B22",
};
const HEADER_TEXT_STYLE: React.CSSProperties = { flex: 1, minWidth: 0 };
const TITLE_STYLE: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 600,
  color: "#E6EDF3",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
const LOCATION_STYLE: React.CSSProperties = {
  marginTop: 2,
  fontSize: 11,
  color: "#7B8695",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
const EVIDENCE_ROW_STYLE: React.CSSProperties = {
  marginTop: 7,
  display: "flex",
  alignItems: "center",
  gap: 6,
  minHeight: 24,
};
const EVIDENCE_DOT_STYLE: React.CSSProperties = { width: 8, height: 8, borderRadius: "50%", flexShrink: 0 };
const EVIDENCE_KIND_STYLE: React.CSSProperties = {
  color: "#D8E4F0",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: 11,
  fontWeight: 700,
};
const EVIDENCE_COUNT_STYLE: React.CSSProperties = { color: "#7B8695", fontSize: 10.5 };
const EVIDENCE_NAV_STYLE: React.CSSProperties = { display: "inline-flex", gap: 4, marginLeft: 2 };
const EVIDENCE_NAV_BUTTON_STYLE: React.CSSProperties = {
  width: 24,
  height: 22,
  padding: 0,
  border: "1px solid #364252",
  borderRadius: 5,
  background: "#111821",
  color: "#B9D9F5",
  fontSize: 17,
  lineHeight: "18px",
  cursor: "pointer",
};
const SUMMARY_ROW_STYLE: React.CSSProperties = {
  marginTop: 6,
  display: "flex",
  gap: 6,
  alignItems: "center",
  flexWrap: "wrap",
};
const ADDED_STYLE: React.CSSProperties = {
  fontSize: 10.5,
  fontWeight: 700,
  color: "#56C271",
  border: "1px solid rgba(86,194,113,0.45)",
  borderRadius: 4,
  padding: "1px 6px",
  background: "rgba(86,194,113,0.1)",
};
const DELETED_STYLE: React.CSSProperties = {
  fontSize: 10.5,
  fontWeight: 700,
  color: "#F0787C",
  border: "1px solid rgba(240,120,124,0.45)",
  borderRadius: 4,
  padding: "1px 6px",
  background: "rgba(240,120,124,0.1)",
};
const CLOSE_STYLE: React.CSSProperties = {
  flexShrink: 0,
  background: "#1A1F27",
  color: "#9AA4B2",
  border: "1px solid #2A2F37",
  borderRadius: 6,
  width: 26,
  height: 26,
  fontSize: 16,
  lineHeight: 1,
  cursor: "pointer",
};
const BODY_STYLE: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflow: "auto",
  padding: 12,
};
const STATUS_STYLE: React.CSSProperties = { fontSize: 12, color: "#7B8695" };
const ERROR_STYLE: React.CSSProperties = { fontSize: 12, color: "#f2777a" };
const TRUNCATED_STYLE: React.CSSProperties = { marginTop: 8, fontSize: 11, color: "#7B8695" };
