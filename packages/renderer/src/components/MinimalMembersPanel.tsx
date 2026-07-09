/**
 * The minimal-graph overlay's MEMBERS panel: a floating list of the current working-set members, each
 * with a remove ✕ that demotes it back to a ghost (or drops it entirely if it has no member neighbour).
 * The last member can't be removed (the store refuses), so the overlay never goes blank. Module-map
 * (non-override) mode only — the PR diff owns its own chrome.
 */

import { useBlueprint, useBlueprintActions } from "../state/StoreContext";
import { MEMBERS_PANEL_STYLE } from "./minimalGraphStyles";

export function MinimalMembersPanel() {
  const memberIds = useBlueprint((state) => state.minimalMemberIds);
  const index = useBlueprint((state) => state.index);
  const { demoteMinimalMember } = useBlueprintActions();
  const canRemove = memberIds.length > 1;
  return (
    <div style={MEMBERS_PANEL_STYLE}>
      <span style={TITLE}>{memberIds.length} member{memberIds.length === 1 ? "" : "s"}</span>
      <ul style={LIST}>
        {[...memberIds].sort().map((id) => (
          <li key={id} style={ROW}>
            <span style={LABEL} title={id}>{index.nodesById.get(id)?.displayName ?? id}</span>
            <button
              type="button"
              style={{ ...REMOVE, ...(canRemove ? {} : DISABLED) }}
              onClick={() => demoteMinimalMember(id)}
              disabled={!canRemove}
              title={canRemove ? "Remove from the working set" : "The last member can't be removed"}
              aria-label={`Remove ${index.nodesById.get(id)?.displayName ?? id}`}
            >
              ✕
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

const TITLE: React.CSSProperties = { fontSize: 12, fontWeight: 700, color: "#E6EDF3" };
const LIST: React.CSSProperties = { listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 4, maxHeight: 260, overflowY: "auto" };
const ROW: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, justifyContent: "space-between" };
const LABEL: React.CSSProperties = {
  fontSize: 11.5,
  color: "#C8D3E0",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  maxWidth: 200,
};
const REMOVE: React.CSSProperties = {
  flexShrink: 0,
  background: "transparent",
  border: "1px solid #2A2F37",
  borderRadius: 4,
  color: "#9AA4B2",
  cursor: "pointer",
  fontSize: 11,
  lineHeight: 1,
  padding: "2px 6px",
};
const DISABLED: React.CSSProperties = { opacity: 0.4, cursor: "default" };
