/**
 * Shared chrome for the Map's expandable cards: the chevron that expands a card in place, and the
 * transparent-frame + title-bar styling an expanded card wears. One source so the package card and
 * the file card can't drift apart on the expand affordance or the frame treatment.
 */

import type { ChangeStatus } from "@meridian/core";
import { isSourceBackedNode } from "../../../derive/sourceBackedNode";
import { useBlueprint, useBlueprintActions } from "../../../state/StoreContext";
import { changedColor } from "../../../theme/changedColors";
import { useSurfaceReadOnly, useSurfaceToggleExpand } from "../../canvas/SurfaceInteractionContext";

export const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";
export const SELECT_ACCENT = "#6BE38A";

/** Shared title strip for every expanded Module-map container frame: the expand chevron and the
 * frame's identity (label, badges, chips). Per-frame "expand all / collapse all" controls were
 * removed — they crowded a narrow frame's title bar and could squeeze the name to nothing. */
export function FrameTitleBar({
  chevron,
  children,
  status,
}: {
  chevron?: React.ReactNode;
  children: React.ReactNode;
  status?: ChangeStatus;
}) {
  return (
    <div style={frameTitleBarStyle(status)}>
      {children}
      {chevron}
    </div>
  );
}

/** A changed expanded container keeps its status on the compact title strip, where the signal
 * remains readable without depending on the size of the frame or the amount of nested content. */
export function frameTitleBarStyle(status: ChangeStatus | undefined): React.CSSProperties {
  if (status === undefined) {
    return TITLE_BAR;
  }
  const color = changedColor(status);
  return {
    ...TITLE_BAR,
    borderBottomColor: color,
    // Stronger than the frame's subtle body wash: the title is the container's compact status band.
    backgroundImage: `linear-gradient(0deg, ${color}66, ${color}66)`,
  };
}

/**
 * The `</>` code button every located Map node (file, class/interface, function/method) carries:
 * opens the code modal on JUST THAT NODE'S span — the clicked function/class/interface (a file node
 * spans the whole file), with its changed lines marked in the gutter + rows (+ head-side additions
 * and replacements / − removed lines). Scoped to the unit on purpose: a changed function should
 * show the function, not the whole file it sits in. Shown for changed AND unchanged nodes. Needs a
 * source location AND the server serving source (`sourceUrl`), so it never dangles. Structural and
 * boundary nodes carry pseudo-locations for graph semantics, but those locations do not name
 * readable source files.
 */
export function CodeButton({ id }: { id: string }) {
  const node = useBlueprint((state) => state.index.nodesById.get(id));
  const sourceUrl = useBlueprint((state) => state.sourceUrl);
  const { showCode, expandCode } = useBlueprintActions();
  if (!isSourceBackedNode(node) || !sourceUrl) {
    return null;
  }
  return (
    <button
      type="button"
      style={CODE_BTN}
      title="View source — changed lines marked + / −"
      aria-label="View source"
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
  const readOnly = useSurfaceReadOnly();
  const surfaceToggleExpand = useSurfaceToggleExpand();
  const storeToggleExpand = useBlueprintActions().toggleModuleExpand;
  const toggleExpand = resolveSurfaceExpandAction(readOnly, surfaceToggleExpand, storeToggleExpand);
  if (toggleExpand === null) {
    return null;
  }
  const label = isExpanded ? "Collapse" : "Expand";
  return (
    <button
      type="button"
      style={CHEVRON}
      title={isExpanded ? label : (collapsedTitle ?? label)}
      aria-label={label}
      onClick={(event) => {
        event.stopPropagation();
        toggleExpand(id);
      }}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      {isExpanded ? "▾" : "▸"}
    </button>
  );
}

/** Read-only normally suppresses structural gestures, but a surface may provide a local disclosure
 * action which takes precedence over the shared store action. Kept pure for contract tests. */
export function resolveSurfaceExpandAction(
  readOnly: boolean,
  surfaceAction: ((nodeId: string) => void) | null,
  storeAction: (nodeId: string) => void,
): ((nodeId: string) => void) | null {
  return surfaceAction ?? (readOnly ? null : storeAction);
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
/** ONE selection ink for every card kind: a bright neutral focus ring. The old "own accent,
 * heavier" treatment meant selection looked different on every card and was indistinguishable from
 * the amber changed-ring on amber (class/config) cards — a state must have one costume. The card's
 * accent stays on its border/rail; the RING says "selected". */
export const SELECTION_RING = "#DCE6F2";

export function frameSelectedStyle(accent: string): React.CSSProperties {
  return { ...frameStyle(accent), border: `2px solid ${accent}`, boxShadow: `0 0 0 2px ${SELECTION_RING}` };
}

/** The same neutral-ring selection treatment for a COLLAPSED card (given its base style). */
export function cardSelectedStyle(base: React.CSSProperties, accent: string): React.CSSProperties {
  return { ...base, borderColor: accent, boxShadow: `0 0 0 2px ${SELECTION_RING}` };
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
