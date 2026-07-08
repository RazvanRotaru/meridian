/**
 * Shared chrome for the Map's expandable cards: the chevron that expands a card in place, and the
 * transparent-frame + title-bar styling an expanded card wears. One source so the package card and
 * the file card can't drift apart on the expand affordance or the frame treatment.
 */

import { useBlueprint, useBlueprintActions } from "../../../state/StoreContext";

export const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";
export const SELECT_ACCENT = "#6BE38A";

/** Shared title strip for every expanded Module-map container frame. `readOnly` drops the
 * expand/collapse actions for a presentational frame (the minimal-graph overlay), whose store
 * actions would otherwise mutate the underlying Map's expansion state. */
export function FrameTitleBar({
  actionsId,
  chevron,
  readOnly,
  children,
}: {
  actionsId: string;
  chevron?: React.ReactNode;
  readOnly?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div style={TITLE_BAR}>
      {chevron}
      {children}
      {readOnly ? null : <FrameLevelActions id={actionsId} />}
    </div>
  );
}

/**
 * The `</>` diff button a CHANGED Map leaf (function level and below) carries: opens the code modal
 * scrolled to the diff, whose gutter + rows mark the changed lines (+ added / − deleted / ~ modified).
 * Gated to changed nodes on purpose — an unchanged node has nothing to show, so a `</>` there would
 * just open plain source and leave the reader hunting for a "+/-" that isn't there. Also needs a
 * source location AND the server serving source (`sourceUrl`), so it never dangles a dead button.
 */
export function CodeButton({ id }: { id: string }) {
  const node = useBlueprint((state) => state.index.nodesById.get(id));
  const sourceUrl = useBlueprint((state) => state.sourceUrl);
  const changed = useBlueprint((state) => state.index.changedIds.has(id));
  const { showCode, expandCode } = useBlueprintActions();
  if (!changed || !node?.location || !sourceUrl) {
    return null;
  }
  return (
    <button
      type="button"
      style={CODE_BTN}
      title="View the diff — changed lines marked + / − / ~"
      aria-label="View diff"
      onClick={(event) => {
        event.stopPropagation();
        void showCode(node);
        expandCode();
      }}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      {"</>"}
    </button>
  );
}

const CODE_BTN: React.CSSProperties = {
  flexShrink: 0,
  border: "1px solid #2A3140",
  background: "rgba(0,0,0,0.25)",
  color: "#9AA4B2",
  borderRadius: 4,
  padding: "0 4px",
  fontSize: 9,
  lineHeight: "15px",
  fontFamily: MONO,
  cursor: "pointer",
};


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

/** One-level controls for an expanded frame's direct toggleable child containers. */
export function FrameLevelActions({ id }: { id: string }) {
  const { expandModuleChildren, collapseModuleChildren } = useBlueprintActions();
  return (
    <span style={FRAME_ACTIONS}>
      <button
        type="button"
        style={FRAME_ACTION}
        title="Expand each child card in this frame"
        aria-label="Expand child cards in this frame"
        onClick={(event) => {
          event.stopPropagation();
          expandModuleChildren(id);
        }}
      >
        Expand all
      </button>
      <button
        type="button"
        style={FRAME_ACTION}
        title="Collapse child cards in this frame"
        aria-label="Collapse child cards in this frame"
        onClick={(event) => {
          event.stopPropagation();
          collapseModuleChildren(id);
        }}
      >
        Collapse all
      </button>
    </span>
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

// Selection reads as the card's OWN accent, just heavier — a 2px solid border (vs the 1px faint one
// at rest) plus a soft accent halo. No separate selection colour, so a hue always means one thing.
export function frameSelectedStyle(accent: string): React.CSSProperties {
  return { ...frameStyle(accent), border: `2px solid ${accent}`, boxShadow: `0 0 0 2px ${accent}55` };
}

/** The same "own accent, heavier" selection treatment for a COLLAPSED card (given its base style). */
export function cardSelectedStyle(base: React.CSSProperties, accent: string): React.CSSProperties {
  return { ...base, borderColor: accent, boxShadow: `0 0 0 2px ${accent}` };
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
const FRAME_ACTIONS: React.CSSProperties = { display: "inline-flex", alignItems: "center", gap: 2, flexShrink: 0 };
const FRAME_ACTION: React.CSSProperties = {
  background: "transparent",
  border: "none",
  borderRadius: 4,
  color: "#9AA4B2",
  cursor: "pointer",
  font: "inherit",
  fontSize: 11,
  lineHeight: "14px",
  padding: "2px 4px",
  whiteSpace: "nowrap",
};
