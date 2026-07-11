/**
 * The minimal-graph overlay's MEMBERS panel: a floating list of the current working-set members, each
 * with a remove ✕ that demotes it back to a ghost (or drops it entirely if it has no member neighbour).
 * The last member can't be removed (the store refuses), so the overlay never goes blank.
 */

import { useId } from "react";
import { useBlueprint, useBlueprintActions } from "../state/StoreContext";
import { MEMBERS_PANEL_STYLE } from "./minimalGraphStyles";

export function MinimalMembersPanel() {
  const memberIds = useBlueprint((state) => state.minimalMemberIds);
  const index = useBlueprint((state) => state.index);
  const { demoteMinimalMember } = useBlueprintActions();
  const canRemove = memberIds.length > 1;
  return (
    <section style={MEMBERS_PANEL_STYLE} aria-label="Extracted selection">
      <span style={TITLE}>Extracted selection · {memberIds.length} member{memberIds.length === 1 ? "" : "s"}</span>
      {canRemove ? null : <span style={MEMBER_HINT}>At least one member is required</span>}
      <ul style={LIST}>
        {[...memberIds].sort().map((id) => (
          <li key={id} style={ROW}>
            <span style={LABEL} title={id}>{index.nodesById.get(id)?.displayName ?? id}</span>
            <MemberRemoveButton
              label={index.nodesById.get(id)?.displayName ?? id}
              canRemove={canRemove}
              onRemove={() => demoteMinimalMember(id)}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

function MemberRemoveButton({ label, canRemove, onRemove }: { label: string; canRemove: boolean; onRemove: () => void }) {
  const descriptionId = useId();
  const description = canRemove ? "Remove from the working set" : "The last member can't be removed";
  return (
    <span style={REMOVE_WRAPPER} title={description}>
      <button
        type="button"
        style={{ ...REMOVE, ...(canRemove ? {} : DISABLED) }}
        onClick={(event) => {
          if (!canRemove) {
            event.preventDefault();
            event.stopPropagation();
            return;
          }
          onRemove();
        }}
        aria-disabled={!canRemove}
        aria-describedby={descriptionId}
        aria-label={`Remove ${label}`}
        title={description}
      >
        ✕
      </button>
      <span id={descriptionId} style={SCREEN_READER_ONLY}>{description}</span>
    </span>
  );
}

const TITLE: React.CSSProperties = {
  flexShrink: 0,
  maxWidth: "100%",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  fontSize: 12,
  fontWeight: 700,
  color: "#E6EDF3",
};
const LIST: React.CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "flex",
  flexDirection: "column",
  gap: 4,
  minHeight: 0,
  maxHeight: 260,
  flexShrink: 1,
  overflowY: "auto",
};
const MEMBER_HINT: React.CSSProperties = { flexShrink: 0, fontSize: 10.5, color: "#8B949E" };
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
const REMOVE_WRAPPER: React.CSSProperties = { position: "relative", display: "inline-flex", flexShrink: 0 };
const DISABLED: React.CSSProperties = { opacity: 0.4, cursor: "default" };
const SCREEN_READER_ONLY: React.CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0, 0, 0, 0)",
  whiteSpace: "nowrap",
  border: 0,
};
