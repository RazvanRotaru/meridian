/**
 * The Map lens's floating chrome, kept out of the surface component: the containment breadcrumb
 * (the zoom trail), the expand-all / collapse-all cluster acting on the CURRENT level, and the
 * empty-level card. All pure presentational — every action arrives as a prop.
 */

import type { GraphIndex } from "../graph/graphIndex";

export interface Crumb {
  id: string;
  label: string;
}

/** The containment trail from the repo down to the focus: the package-node ancestors (inclusive). */
export function crumbsFor(focus: string | null, index: GraphIndex): Crumb[] {
  if (focus === null) {
    return [];
  }
  return index
    .ancestorsOf(focus)
    .filter((node) => node.kind === "package")
    .map((node) => ({ id: node.id, label: node.displayName ?? node.id }));
}

/**
 * The zoom trail: "Repository" (level 0) then each package/directory you descended into. Every
 * segment but the last is a button that zooms back to that level; the last is the current level.
 * The right-hand cluster expands EVERY container reachable from this level (dirs → files → flows)
 * or collapses them all back to the frontier. Mirrors the call lens's Breadcrumb control language.
 */
export function LevelBreadcrumb(props: {
  focus: string | null;
  packageCount: number;
  crumbs: Crumb[];
  hasExpansions: boolean;
  onFocus: (id: string | null) => void;
  onExpandAll: () => void;
  onCollapseAll: () => void;
}) {
  const atRoot = props.focus === null;
  return (
    <nav style={BREADCRUMB_STYLE} aria-label="Containment level">
      {atRoot ? (
        <span style={CRUMB_CURRENT_STYLE} aria-current="page">Repository — {props.packageCount} packages</span>
      ) : (
        <button type="button" style={CRUMB_STYLE} onClick={() => props.onFocus(null)}>Repository</button>
      )}
      {props.crumbs.map((crumb, i) => {
        const isLast = i === props.crumbs.length - 1;
        return (
          <span key={crumb.id} style={SEG_WRAP}>
            <span style={CRUMB_SEP_STYLE} aria-hidden>›</span>
            {isLast ? (
              <span style={CRUMB_CURRENT_STYLE} aria-current="page" title={crumb.id}>{crumb.label}</span>
            ) : (
              <button type="button" style={CRUMB_STYLE} title={crumb.id} onClick={() => props.onFocus(crumb.id)}>{crumb.label}</button>
            )}
          </span>
        );
      })}
      <span style={DIVIDER} aria-hidden />
      <button type="button" style={ACTION_STYLE} title="Expand every card on this level, all the way down" onClick={props.onExpandAll}>
        ⊞ Expand all
      </button>
      <button
        type="button"
        style={props.hasExpansions ? ACTION_STYLE : ACTION_DISABLED_STYLE}
        disabled={!props.hasExpansions}
        title={props.hasExpansions ? "Collapse every expanded card back to this level" : "Nothing is expanded"}
        onClick={props.onCollapseAll}
      >
        ⊟ Collapse all
      </button>
    </nav>
  );
}

/** Shown when a level is empty — a focus with no in-project files, so the lens is never a silent blank. */
export function EmptyModuleMapCard(props: { focus: string | null }) {
  return (
    <div style={EMPTY_WRAP_STYLE}>
      <div style={EMPTY_CARD_STYLE}>
        <span style={EMPTY_MARK_STYLE}>∅</span>
        <span>
          {props.focus === null
            ? "No npm packages with resolved imports in this artifact."
            : "Nothing in-project here — this directory's files import only external packages, or it has none."}
        </span>
      </div>
    </div>
  );
}

const BREADCRUMB_STYLE: React.CSSProperties = {
  position: "absolute",
  top: 16,
  left: 340,
  zIndex: 5,
  display: "flex",
  alignItems: "center",
  gap: 2,
  border: "1px solid #2A2F37",
  borderRadius: 8,
  background: "rgba(18,23,30,0.92)",
  padding: "4px 8px",
  maxWidth: "60vw",
  overflow: "hidden",
};
const SEG_WRAP: React.CSSProperties = { display: "inline-flex", alignItems: "center", gap: 2, minWidth: 0 };
const CRUMB_STYLE: React.CSSProperties = {
  background: "transparent",
  border: "none",
  padding: "2px 4px",
  borderRadius: 4,
  cursor: "pointer",
  font: "inherit",
  fontSize: 13,
  color: "#9AA4B2",
};
const CRUMB_CURRENT_STYLE: React.CSSProperties = { ...CRUMB_STYLE, color: "#E6EDF3", fontWeight: 600, cursor: "default" };
const CRUMB_SEP_STYLE: React.CSSProperties = { color: "#4B535F", fontSize: 13 };
const DIVIDER: React.CSSProperties = { width: 1, alignSelf: "stretch", margin: "2px 6px", background: "#2A2F37" };
const ACTION_STYLE: React.CSSProperties = { ...CRUMB_STYLE, whiteSpace: "nowrap", fontSize: 12 };
const ACTION_DISABLED_STYLE: React.CSSProperties = { ...ACTION_STYLE, color: "#565E68", cursor: "default" };
const EMPTY_WRAP_STYLE: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  pointerEvents: "none",
  padding: "0 48px",
};
const EMPTY_CARD_STYLE: React.CSSProperties = {
  pointerEvents: "auto",
  display: "flex",
  alignItems: "center",
  gap: 12,
  maxWidth: 520,
  border: "1px dashed #2A2F37",
  borderRadius: 10,
  background: "#12171E",
  padding: "16px 18px",
  fontSize: 13,
  color: "#7B8695",
};
const EMPTY_MARK_STYLE: React.CSSProperties = { fontSize: 22, opacity: 0.5 };
