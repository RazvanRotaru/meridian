/**
 * Shared source rendering for the floating full-source window and its edge-evidence variant.
 * `SourcePanel` owns the code/review tools; the floating frame owns movement, resize, persistence,
 * and responsive related-code presentation. CodeBlock escapes source as plain text children.
 */

import {
  Cross2Icon,
  MagnifyingGlassIcon,
  MoveIcon,
  ResetIcon,
  RowsIcon,
  SymbolIcon,
} from "@radix-ui/react-icons";
import { useEffect, useMemo, useState } from "react";
import { formatCallSite } from "../graph/edgeEvidence";
import { useBlueprint, useBlueprintActions } from "../state/StoreContext";
import type { CodeView } from "../state/store";
import { relationColor } from "../theme/relationTheme";
import { ReviewFileViewedControl } from "./review/ReviewFileNodeViewedControls";
import { useReviewLineComposerGuard } from "./review/useReviewLineComposerGuard";
import { SourceDiffBody, useSourceDiffModel } from "./SourceDiffBody";
import {
  FLOATING_SOURCE_WINDOW_RAIL_ID,
  FloatingSourceWindow,
  type FloatingSourceWindowControls,
} from "./source/FloatingSourceWindow";
import { deriveRelatedCodeGroups, RelatedCodeRail } from "./source/RelatedCodeRail";
import { SOURCE_SEARCH_ID, SourceSearchBar } from "./source/SourceSearchBar";
import { useSourceSearch } from "./source/useSourceSearch";

export function CodePanel({
  onLookupSymbol,
}: {
  onLookupSymbol?: (symbol: string | null) => void;
} = {}) {
  const codeView = useBlueprint((state) => state.codeView);
  const index = useBlueprint((state) => state.index);
  const { canShowCode, closeCode } = useBlueprintActions();
  const open = codeView?.mode === "modal" && codeView.edgeEvidence === undefined;
  const requestClose = useReviewLineComposerGuard(
    closeCode,
    open ? codeView?.node.location.file ?? null : null,
  );

  // Edge evidence has a graph-local host beside its wire inspector. Keeping the global panel
  // deliberately empty prevents a second source host (and its independent close lifecycle).
  if (!codeView || !open) {
    return null;
  }
  const relatedCount = deriveRelatedCodeGroups(index, codeView.node, canShowCode)
    .reduce((total, group) => total + group.neighbors.length, 0);

  return (
    <FloatingSourceWindow
      ariaLabel="Source code"
      onClose={requestClose}
      defaultRegionElementId="meridian-review-graph-pane"
      railLabel="Related code blocks"
      railCount={relatedCount}
      rail={<RelatedCodeRail currentNode={codeView.node} />}
      main={(windowControls) => (
        <SourcePanel
          codeView={codeView}
          presentation="dock"
          onClose={requestClose}
          windowControls={windowControls}
          relatedCodeCount={relatedCount}
          relatedRailLabel="Related code blocks"
          onLookupSymbol={onLookupSymbol}
        />
      )}
    />
  );
}

/** Contextual source hosted inside the graph-local edge inspection window. The shared frame owns
 * movement, resize, persistence, and Escape; this pane contributes its visible source controls. */
export function EdgeSourcePane({
  windowControls,
  relatedCodeCount = 0,
  relatedRailLabel = "Related code blocks",
  onClose,
}: {
  windowControls?: FloatingSourceWindowControls;
  relatedCodeCount?: number;
  relatedRailLabel?: string;
  onClose?: () => void;
} = {}) {
  const codeView = useBlueprint((state) => state.codeView);
  if (!codeView || codeView.mode !== "modal" || codeView.edgeEvidence === undefined) {
    return null;
  }
  return (
    <SourcePanel
      codeView={codeView}
      presentation="edge"
      windowControls={windowControls}
      relatedCodeCount={relatedCodeCount}
      relatedRailLabel={relatedRailLabel}
      onClose={onClose}
    />
  );
}

function SourcePanel({
  codeView,
  presentation,
  onClose,
  onLookupSymbol,
  windowControls,
  relatedCodeCount = 0,
  relatedRailLabel = "Related code blocks",
}: {
  codeView: CodeView;
  presentation: "dock" | "edge";
  onClose?: () => void;
  onLookupSymbol?: (symbol: string | null) => void;
  windowControls?: FloatingSourceWindowControls;
  relatedCodeCount?: number;
  relatedRailLabel?: string;
}) {
  const index = useBlueprint((state) => state.index);
  const { selectEdgeEvidence } = useBlueprintActions();
  const model = useSourceDiffModel(codeView);
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null);
  const sourceIdentity = useMemo(() => ({
    nodeId: model.view.node.id,
    file: model.file,
    baseLine: model.baseLine,
    sourceSide: model.sourceSide,
    code: model.view.code,
  }), [model.baseLine, model.file, model.sourceSide, model.view.code, model.view.node.id]);
  const search = useSourceSearch({
    code: model.view.code ?? "",
    enabled: windowControls !== undefined,
    hiddenLines: model.hiddenSourceLines,
    lineCount: model.sourceLineCount,
    shortcutBlocked: windowControls?.railOpen ?? false,
    shortcutScope: "source",
    sourceIdentity,
    startLine: model.baseLine,
  });
  const wholeFile = codeView.wholeFile ?? false;
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
  const { node } = codeView;
  const { file, startLine, endLine } = node.location;
  const baseLine = model.baseLine;
  // A PR-review panel shows the HEAD file sliced to where the unit moved to, so the subtitle range
  // must track the shown lines (baseLine..+len), not the node's base span. Whole-file view titles by
  // the file and lands on the first change, so its own span in the subtitle would be misleading too.
  const shownEnd = codeView.code === null ? endLine ?? startLine : model.shownEnd;
  const evidenceTitle = activeEvidence
    ? `${index.nodesById.get(activeEvidence.source)?.displayName ?? activeEvidence.source} → ${index.nodesById.get(activeEvidence.target)?.displayName ?? activeEvidence.target}`
    : null;
  const title = presentation === "edge" && activeEvidence
    ? `Source · ${file.split("/").pop() ?? file}`
    : evidenceTitle ?? (wholeFile ? (file.split("/").pop() ?? file) : node.displayName);
  const emptySource = codeView.code !== null && model.sourceLineCount === 0;
  const range = emptySource
    ? "empty"
    : shownEnd !== baseLine ? `${baseLine}-${shownEnd}` : String(baseLine);
  const location = activeEvidence && edgeEvidence
    ? displayedEvidenceLocation(activeEvidence.site, edgeEvidence.focusStartLine, edgeEvidence.focusEndLine)
    : wholeFile
      ? `${file}${emptySource ? " · empty" : ""}`
      : `${file}:${range}`;
  useEffect(() => {
    setSelectedSymbol(null);
  }, [sourceIdentity]);
  useEffect(() => {
    if (windowControls?.railOpen && search.open) search.close(false);
  }, [search.close, search.open, windowControls?.railOpen]);

  return (
    <div
      style={presentation === "edge" ? EDGE_PANEL_STYLE : DOCK_PANEL_STYLE}
      role={presentation === "edge" ? "region" : undefined}
      aria-label={presentation === "edge" ? "Highlighted edge source" : undefined}
      data-source-code-dock={presentation === "dock" ? "true" : undefined}
      onClick={(event) => event.stopPropagation()}
    >
        <header style={HEADER_STYLE} {...windowControls?.headerDragProps}>
          <div style={HEADER_TEXT_STYLE}>
            <h2
              style={TITLE_STYLE}
              title={node.qualifiedName}
              tabIndex={-1}
              data-source-window-title="true"
            >
              {title}
            </h2>
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
            {model.summary ? (
              <div style={SUMMARY_ROW_STYLE}>
                <span style={ADDED_STYLE}>{`+${model.summary.added} lines`}</span>
                <span style={DELETED_STYLE}>{`-${model.summary.deleted} lines`}</span>
              </div>
            ) : null}
          </div>
          {onClose || windowControls ? (
            <div style={HEADER_ACTIONS_STYLE} data-source-header-actions="true">
              {windowControls ? (
                <>
                  <button
                    {...windowControls.moveHandleProps}
                    style={HEADER_ACTION_STYLE}
                  >
                    <MoveIcon />
                  </button>
                  <button
                    type="button"
                    style={HEADER_ACTION_STYLE}
                    aria-label="Reset source window position and size"
                    title="Reset source window position and size"
                    data-source-window-reset="true"
                    onClick={windowControls.resetGeometry}
                  >
                    <ResetIcon />
                  </button>
                  {windowControls.railCollapsed ? (
                    <button
                      ref={windowControls.railToggleRef}
                      type="button"
                      style={{
                        ...HEADER_ACTION_STYLE,
                        ...(windowControls.railOpen ? HEADER_ACTION_ACTIVE_STYLE : {}),
                      }}
                      aria-label={`${relatedRailLabel} (${relatedCodeCount})`}
                      aria-expanded={windowControls.railOpen}
                      aria-controls={FLOATING_SOURCE_WINDOW_RAIL_ID}
                      title={`${relatedRailLabel} (${relatedCodeCount})`}
                      data-source-window-related-toggle="true"
                      onClick={windowControls.toggleRail}
                    >
                      <RowsIcon />
                    </button>
                  ) : null}
                </>
              ) : null}
              {presentation === "dock" ? <ReviewFileViewedControl path={model.reviewPath} compact /> : null}
              {onLookupSymbol ? (
                <button
                  type="button"
                  style={{ ...HEADER_ACTION_STYLE, ...(selectedSymbol !== null ? HEADER_ACTION_ACTIVE_STYLE : {}) }}
                  onClick={() => onLookupSymbol(selectedSymbol)}
                  aria-label={selectedSymbol === null
                    ? "Search repository symbols"
                    : `Look up “${selectedSymbol}” in repository symbols`}
                  title={selectedSymbol === null
                    ? "Search repository symbols"
                    : `Look up “${selectedSymbol}” in repository symbols`}
                  data-source-symbol-lookup-trigger="true"
                >
                  <SymbolIcon />
                </button>
              ) : null}
              <button
                ref={(node) => {
                  search.triggerRef.current = node;
                }}
                type="button"
                style={{ ...HEADER_ACTION_STYLE, ...(search.open ? HEADER_ACTION_ACTIVE_STYLE : {}) }}
                onClick={search.openSearch}
                aria-label="Open source search"
                aria-expanded={search.open}
                aria-controls={SOURCE_SEARCH_ID}
                aria-keyshortcuts="Control+F Meta+F"
                title="Find in current source (Ctrl/⌘F)"
              >
                <MagnifyingGlassIcon />
              </button>
              {onClose ? (
                <button
                  type="button"
                  style={HEADER_ACTION_STYLE}
                  onClick={onClose}
                  aria-label="Close source"
                  title="Close source"
                >
                  <Cross2Icon />
                </button>
              ) : null}
            </div>
          ) : null}
        </header>
        {search.open ? <SourceSearchBar search={search} /> : null}
        <div
          style={presentation === "dock" ? DOCK_BODY_STYLE : EDGE_BODY_STYLE}
          data-source-code-body={presentation}
        >
          <SourceDiffBody
            model={model}
            maxHeight="none"
            evidenceLines={evidenceLines}
            searchMatches={search.open ? search.matches : EMPTY_SEARCH_MATCHES}
            activeSearchIndex={search.open ? search.activeIndex : -1}
            onSymbolSelection={presentation === "dock" && onLookupSymbol ? setSelectedSymbol : undefined}
            showGutter
            fillHeight
          />
        </div>
    </div>
  );
}

const EMPTY_EVIDENCE_LINES: ReadonlySet<number> = new Set<number>();
const EMPTY_SEARCH_MATCHES: readonly [] = [];
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

const DOCK_PANEL_STYLE: React.CSSProperties = {
  minWidth: 0,
  height: "100%",
  flex: 1,
  display: "flex",
  flexDirection: "column",
  background: "#0E1116",
  overflow: "hidden",
};
const EDGE_PANEL_STYLE: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  height: "100%",
  display: "flex",
  flexDirection: "column",
  background: "#0E1116",
  overflow: "hidden",
};
const HEADER_STYLE: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  flexWrap: "wrap",
  gap: 12,
  padding: "12px 14px",
  borderBottom: "1px solid #2A2F37",
  background: "#161B22",
};
const HEADER_ACTIONS_STYLE: React.CSSProperties = {
  minWidth: 0,
  maxWidth: "100%",
  marginLeft: "auto",
  display: "flex",
  alignItems: "center",
  justifyContent: "flex-end",
  flexWrap: "wrap",
  gap: 6,
};
const HEADER_TEXT_STYLE: React.CSSProperties = { flex: 1, minWidth: 0 };
const TITLE_STYLE: React.CSSProperties = {
  margin: 0,
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
const HEADER_ACTION_STYLE: React.CSSProperties = {
  flexShrink: 0,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
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
const HEADER_ACTION_ACTIVE_STYLE: React.CSSProperties = {
  borderColor: "#4F6B8A",
  background: "rgba(56,139,253,0.16)",
  color: "#B9D9F5",
};
const DOCK_BODY_STYLE: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflow: "hidden",
  display: "flex",
  flexDirection: "column",
};
const EDGE_BODY_STYLE: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflow: "hidden",
  display: "flex",
  flexDirection: "column",
  padding: 12,
};
