/**
 * The CHANGE GROUPS strip: when a PR splits into >1 disjoint change groups, offer one row per group
 * (plus "All groups") that ISOLATES the review to that group — the graph re-seeds to only its
 * modules, and the files/flows sections scope to its members (via useActiveChangeGroup). A path
 * prefix can narrow any group further, including the common single-group PR. Selection is full
 * isolation, not a highlight — the store swaps the minimal overlay's seeds.
 */

import { memo, useEffect, useMemo, useState } from "react";
import type { ChangeGroup } from "@meridian/core";
import { isReviewPathInScope, normalizeReviewPathScope, reviewPathSuggestions } from "../../derive/reviewPathScope";
import { useBlueprint, useBlueprintActions } from "../../state/StoreContext";
import { NO_FOCUS_RING, SECTION_COUNT, SECTION_TITLE } from "./reviewPanelKit";

// One accent per group, cycled by index — purely decorative (groups isolate, they never co-paint).
const DOT_PALETTE = ["#D29922", "#58C4DC", "#A371F7", "#6BE38A", "#F97583", "#79B8FF"] as const;

/** The group currently isolating the review, or null for "All groups" — the one lens the strip,
 * files section, and flows section must agree on. */
export function useActiveChangeGroup(): ChangeGroup | null {
  const groups = useBlueprint((state) => state.reviewGroups);
  const activeId = useBlueprint((state) => state.reviewActiveGroupId);
  return useMemo(
    () => (activeId === null ? null : groups?.groups.find((group) => group.id === activeId) ?? null),
    [groups, activeId],
  );
}

function ChangeGroupStripImpl() {
  const reviewGroups = useBlueprint((state) => state.reviewGroups);
  const activeGroupId = useBlueprint((state) => state.reviewActiveGroupId);
  const pathScope = useBlueprint((state) => state.reviewPathScope);
  const focusedSubgraph = useBlueprint((state) => state.reviewFocusedSubgraph);
  const allFiles = useBlueprint((state) => state.reviewFiles);
  const review = useBlueprint((state) => state.review);
  const impactedFlowIds = useMemo(
    () => new Set((review?.rows ?? []).filter((row) => row.group === "impacted").map((row) => row.flow.flowId)),
    [review],
  );
  const { selectReviewGroup, selectReviewPathScope, closeReviewSubgraph } = useBlueprintActions();
  const [pathDraft, setPathDraft] = useState(pathScope ?? "");
  useEffect(() => setPathDraft(pathScope ?? ""), [pathScope]);

  const activeGroup = activeGroupId === null
    ? null
    : reviewGroups?.groups.find((group) => group.id === activeGroupId) ?? null;
  const eligibleFiles = useMemo(() => {
    const groupFiles = activeGroup === null ? null : new Set(activeGroup.files);
    return allFiles.filter((file) => file.moduleId !== null && (groupFiles === null || groupFiles.has(file.path)));
  }, [activeGroup, allFiles]);
  const suggestions = useMemo(
    () => reviewPathSuggestions(eligibleFiles.map((file) => file.path)),
    [eligibleFiles],
  );
  const normalizedDraft = normalizeReviewPathScope(pathDraft);
  const matchingDraftFiles = normalizedDraft === ""
    ? eligibleFiles.length
    : eligibleFiles.filter((file) => isReviewPathInScope(file.path, normalizedDraft)).length;
  const pathIsValid = normalizedDraft === "" || matchingDraftFiles > 0;
  const pathScopedFileCount = pathScope === null
    ? eligibleFiles.length
    : eligibleFiles.filter((file) => isReviewPathInScope(file.path, pathScope)).length;
  const scopedFileCount = focusedSubgraph?.filePaths.length ?? pathScopedFileCount;
  const showGroups = (reviewGroups?.groups.length ?? 0) > 1;
  if (!review || eligibleFiles.length === 0) {
    return null;
  }
  const groupedFiles = reviewGroups?.groups.reduce((sum, group) => sum + group.files.length, 0) ?? 0;
  const totalFiles = allFiles.length;
  const groupImpactedCount = (group: ChangeGroup) => group.flowIds.filter((flowId) => impactedFlowIds.has(flowId)).length;
  return (
    <section style={STRIP}>
      <div style={STRIP_HEAD}>
        <span style={SECTION_TITLE}>Review scope</span>
        <span style={SECTION_COUNT}>{scopedFileCount}/{eligibleFiles.length} graph files</span>
        {showGroups && <span style={SPLIT_NOTE}>⑂ {reviewGroups!.groups.length} independent changes</span>}
      </div>
      {focusedSubgraph !== null && (
        <div style={FOCUS_ROW} role="status">
          <span style={FOCUS_MARK}>◎</span>
          <span style={FOCUS_LABEL} title={focusedSubgraph.rootId}>Focused subgraph: {focusedSubgraph.label}</span>
          <span style={ROW_META}>{focusedSubgraph.filePaths.length} changed files</span>
          <button type="button" style={FOCUS_BACK} onClick={closeReviewSubgraph}>Back to previous graph</button>
        </div>
      )}
      {showGroups && (
        <div style={GROUP_LIST} role="region" aria-label="Change groups list">
          <button type="button" aria-pressed={activeGroupId === null} style={activeGroupId === null ? ROW_SELECTED : ROW} onClick={() => selectReviewGroup(null)}>
            <span style={ALL_DOT} />
            <span style={ROW_LABEL}>All groups</span>
            <span style={ROW_META}>{groupedFiles < totalFiles ? `${groupedFiles} of ${totalFiles} files · ${impactedFlowIds.size} impacted` : `${groupedFiles} files · ${impactedFlowIds.size} impacted`}</span>
          </button>
          {reviewGroups!.groups.map((group, index) => {
            const selected = activeGroupId === group.id;
            return (
              <button key={group.id} type="button" aria-pressed={selected} style={selected ? ROW_SELECTED : ROW} onClick={() => selectReviewGroup(group.id)} title={group.label}>
                <span style={{ ...DOT, background: DOT_PALETTE[index % DOT_PALETTE.length] }} />
                <span style={ROW_LABEL}>{group.label}</span>
                <span style={ROW_META}>{group.files.length} files · {groupImpactedCount(group)} impacted</span>
              </button>
            );
          })}
        </div>
      )}
      <form
        style={PATH_FORM}
        onSubmit={(event) => {
          event.preventDefault();
          if (pathIsValid) {
            selectReviewPathScope(normalizedDraft || null);
          }
        }}
      >
        <label htmlFor="review-path-scope" style={PATH_LABEL}>Path</label>
        <input
          id="review-path-scope"
          list="review-path-suggestions"
          value={pathDraft}
          onChange={(event) => setPathDraft(event.target.value)}
          placeholder="e.g. src/aria/app"
          aria-label="Filter review by path"
          aria-invalid={!pathIsValid}
          spellCheck={false}
          style={{ ...PATH_INPUT, borderColor: pathIsValid ? "#303844" : "#F85149" }}
        />
        <datalist id="review-path-suggestions">
          {suggestions.map((suggestion) => <option key={suggestion.path} value={suggestion.path}>{suggestion.files} files</option>)}
        </datalist>
        <button type="submit" style={PATH_BUTTON} disabled={!pathIsValid || normalizedDraft === (pathScope ?? "")}>Apply</button>
        {pathScope !== null && <button type="button" style={PATH_BUTTON} onClick={() => selectReviewPathScope(null)}>Clear</button>}
        <span style={{ ...PATH_META, color: pathIsValid ? "#7D8695" : "#F97583" }}>
          {pathIsValid ? `${matchingDraftFiles} changed graph ${matchingDraftFiles === 1 ? "file" : "files"}` : "No changed graph files"}
        </span>
      </form>
    </section>
  );
}

export const ChangeGroupStrip = memo(ChangeGroupStripImpl);

const STRIP: React.CSSProperties = { padding: "8px 10px", borderBottom: "1px solid #20262F", boxSizing: "border-box", display: "flex", flexDirection: "column", gap: 4, maxHeight: "min(250px, 34%)", minHeight: 0, flexShrink: 1, overflow: "hidden" };
const STRIP_HEAD: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, padding: "0 4px 6px" };
const GROUP_LIST: React.CSSProperties = { minHeight: 0, overflowY: "auto", overscrollBehavior: "contain", paddingRight: 2 };
const SPLIT_NOTE: React.CSSProperties = { marginLeft: "auto", fontSize: 10.5, color: "#7D8695" };
const ROW: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, width: "100%", border: "1px solid transparent", borderRadius: 7, background: "transparent", cursor: "pointer", font: "inherit", padding: "5px 8px", textAlign: "left", ...NO_FOCUS_RING };
const ROW_SELECTED: React.CSSProperties = { ...ROW, borderColor: "#2E3A4D", background: "rgba(46,58,77,0.25)" };
const DOT: React.CSSProperties = { width: 9, height: 9, borderRadius: "50%", flexShrink: 0 };
const ALL_DOT: React.CSSProperties = { ...DOT, background: "transparent", border: "1.5px solid #7D8695" };
const ROW_LABEL: React.CSSProperties = { flex: 1, minWidth: 0, fontSize: 12.5, color: "#E6EDF3", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" };
const ROW_META: React.CSSProperties = { fontSize: 10.5, color: "#7D8695", flexShrink: 0, whiteSpace: "nowrap" };
const PATH_FORM: React.CSSProperties = { display: "grid", gridTemplateColumns: "auto minmax(90px, 1fr) auto auto", alignItems: "center", gap: 6, padding: "6px 4px 2px" };
const PATH_LABEL: React.CSSProperties = { fontSize: 10.5, color: "#7D8695", textTransform: "uppercase", letterSpacing: "0.06em" };
const PATH_INPUT: React.CSSProperties = { minWidth: 0, height: 26, boxSizing: "border-box", border: "1px solid #303844", borderRadius: 6, background: "#10151D", color: "#E6EDF3", padding: "0 7px", fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", fontSize: 10.5, outline: "none" };
const PATH_BUTTON: React.CSSProperties = { height: 26, border: "1px solid #303844", borderRadius: 6, background: "#161C25", color: "#C9D1D9", padding: "0 8px", cursor: "pointer", font: "inherit", fontSize: 10.5, ...NO_FOCUS_RING };
const PATH_META: React.CSSProperties = { gridColumn: "2 / -1", minWidth: 0, fontSize: 9.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" };
const FOCUS_ROW: React.CSSProperties = { display: "flex", alignItems: "center", gap: 7, margin: "0 4px 4px", padding: "6px 8px", border: "1px solid #34537A", borderRadius: 7, background: "rgba(56,139,253,0.09)" };
const FOCUS_MARK: React.CSSProperties = { color: "#58A6FF", fontSize: 13, lineHeight: 1 };
const FOCUS_LABEL: React.CSSProperties = { flex: 1, minWidth: 0, color: "#DCE6F2", fontSize: 11.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" };
const FOCUS_BACK: React.CSSProperties = { border: "none", background: "transparent", color: "#79B8FF", padding: 0, cursor: "pointer", font: "inherit", fontSize: 10.5, whiteSpace: "nowrap", ...NO_FOCUS_RING };
