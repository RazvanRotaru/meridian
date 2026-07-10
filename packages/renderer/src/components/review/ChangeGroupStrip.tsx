/**
 * The CHANGE GROUPS strip: when a PR splits into >1 disjoint change groups, offer one row per group
 * (plus "All groups") that ISOLATES the review to that group — the graph re-seeds to only its
 * modules, and the files/flows sections scope to its members (via useActiveChangeGroup). Hidden
 * entirely for the common single-group PR, so an undivided change costs nothing. Selection is full
 * isolation, not a highlight — the store's `selectReviewGroup` swaps the minimal overlay's seeds.
 */

import { memo, useMemo } from "react";
import type { ChangeGroup } from "@meridian/core";
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
  const totalFlows = useBlueprint((state) => state.review?.rows.length ?? 0);
  const { selectReviewGroup } = useBlueprintActions();
  if (!reviewGroups || reviewGroups.groups.length <= 1) {
    return null;
  }
  const totalFiles = reviewGroups.groups.reduce((sum, group) => sum + group.files.length, 0);
  return (
    <section style={STRIP}>
      <div style={STRIP_HEAD}>
        <span style={SECTION_TITLE}>Change groups</span>
        <span style={SECTION_COUNT}>{reviewGroups.groups.length}</span>
        <span style={SPLIT_NOTE}>⑂ {reviewGroups.groups.length} independent changes</span>
      </div>
      <button type="button" aria-pressed={activeGroupId === null} style={activeGroupId === null ? ROW_SELECTED : ROW} onClick={() => selectReviewGroup(null)}>
        <span style={ALL_DOT} />
        <span style={ROW_LABEL}>All groups</span>
        <span style={ROW_META}>{totalFiles} files · {totalFlows} flows</span>
      </button>
      {reviewGroups.groups.map((group, index) => {
        const selected = activeGroupId === group.id;
        return (
          <button key={group.id} type="button" aria-pressed={selected} style={selected ? ROW_SELECTED : ROW} onClick={() => selectReviewGroup(group.id)} title={group.label}>
            <span style={{ ...DOT, background: DOT_PALETTE[index % DOT_PALETTE.length] }} />
            <span style={ROW_LABEL}>{group.label}</span>
            <span style={ROW_META}>{group.files.length} files · {group.flowIds.length} flows</span>
          </button>
        );
      })}
    </section>
  );
}

export const ChangeGroupStrip = memo(ChangeGroupStripImpl);

const STRIP: React.CSSProperties = { padding: "8px 10px", borderBottom: "1px solid #20262F", display: "flex", flexDirection: "column", gap: 2 };
const STRIP_HEAD: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, padding: "0 4px 6px" };
const SPLIT_NOTE: React.CSSProperties = { marginLeft: "auto", fontSize: 10.5, color: "#7D8695" };
const ROW: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, width: "100%", border: "1px solid transparent", borderRadius: 7, background: "transparent", cursor: "pointer", font: "inherit", padding: "5px 8px", textAlign: "left", ...NO_FOCUS_RING };
const ROW_SELECTED: React.CSSProperties = { ...ROW, borderColor: "#2E3A4D", background: "rgba(46,58,77,0.25)" };
const DOT: React.CSSProperties = { width: 9, height: 9, borderRadius: "50%", flexShrink: 0 };
const ALL_DOT: React.CSSProperties = { ...DOT, background: "transparent", border: "1.5px solid #7D8695" };
const ROW_LABEL: React.CSSProperties = { flex: 1, minWidth: 0, fontSize: 12.5, color: "#E6EDF3", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" };
const ROW_META: React.CSSProperties = { fontSize: 10.5, color: "#7D8695", flexShrink: 0, whiteSpace: "nowrap" };
