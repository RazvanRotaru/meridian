/**
 * Shared chrome for the Map's expandable cards: the chevron that expands a card in place, and the
 * transparent-frame + title-bar styling an expanded card wears. One source so the package card and
 * the file card can't drift apart on the expand affordance or the frame treatment.
 */

import { useBlueprintActions } from "../../../state/StoreContext";

export const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";
export const SELECT_ACCENT = "#6BE38A";

/** The in-place expand/collapse chevron; stops propagation so it never also selects the card. */
export function ExpandChevron({ id, isExpanded, collapsedTitle }: { id: string; isExpanded: boolean; collapsedTitle?: string }) {
  const toggleModuleExpand = useBlueprintActions().toggleModuleExpand;
  const label = isExpanded ? "Collapse" : "Expand";
  return (
    <button
      type="button"
      style={CHEVRON}
      title={isExpanded ? label : (collapsedTitle ?? label)}
      aria-label={label}
      onClick={(event) => {
        event.stopPropagation();
        toggleModuleExpand(id);
      }}
    >
      {isExpanded ? "▾" : "▸"}
    </button>
  );
}

/** An expanded card's near-transparent frame, tinted by the card family's accent. */
export function frameStyle(accent: string): React.CSSProperties {
  return {
    position: "relative",
    width: "100%",
    height: "100%",
    boxSizing: "border-box",
    border: `1px solid ${accent}55`,
    borderRadius: 8,
    background: "rgba(18,23,30,0.55)",
    overflow: "hidden",
    fontFamily: MONO,
  };
}

export function frameSelectedStyle(accent: string): React.CSSProperties {
  return { ...frameStyle(accent), borderColor: SELECT_ACCENT, boxShadow: `0 0 0 2px ${SELECT_ACCENT}` };
}

export const TITLE_BAR: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  height: 30,
  padding: "0 12px",
  borderBottom: "1px solid #232935",
  background: "rgba(18,23,30,0.9)",
};

export const PIN: React.CSSProperties = { width: 6, height: 6, background: "#C8D3E0", border: "none", minWidth: 0, minHeight: 0 };

const CHEVRON: React.CSSProperties = {
  flexShrink: 0,
  width: 16,
  height: 16,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 0,
  border: "none",
  borderRadius: 3,
  background: "transparent",
  color: "#9AA4B2",
  cursor: "pointer",
  font: "inherit",
  fontSize: 11,
};
