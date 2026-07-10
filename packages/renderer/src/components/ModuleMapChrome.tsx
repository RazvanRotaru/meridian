/**
 * The Map lens's floating chrome, kept out of the surface component: the containment breadcrumb
 * (the zoom trail), the expand-all / collapse-all cluster acting on the CURRENT level, the
 * "Extract selection" action strip, and the empty-level card. All pure presentational — every
 * action arrives as a prop.
 */

import type { Crumb } from "./canvas/surfaceSpec";

/**
 * The zoom trail: the surface's root ("Repository" / "All services") then each container you
 * descended into (folders on the Map, the dived cluster on the Service lens). Every segment but
 * the last is a button that zooms back to that level; the last is the current level.
 * Expand/collapse-all now lives in the top-left toolbar (scoped to the selection or root), so this
 * is purely the containment trail. Mirrors the call lens's Breadcrumb control language.
 */
export function LevelBreadcrumb(props: {
  focus: string | null;
  packageCount: number;
  crumbs: Crumb[];
  onFocus: (id: string | null) => void;
  rootLabel?: string;
  rootNoun?: string;
}) {
  const atRoot = props.focus === null;
  const rootLabel = props.rootLabel ?? "Repository";
  const rootNoun = props.rootNoun ?? "packages";
  return (
    <nav style={BREADCRUMB_STYLE} aria-label="Containment level">
      {atRoot ? (
        <span style={CRUMB_CURRENT_STYLE} aria-current="page">{rootLabel} — {props.packageCount} {rootNoun}</span>
      ) : (
        <button type="button" style={CRUMB_STYLE} onClick={() => props.onFocus(null)}>{rootLabel}</button>
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
    </nav>
  );
}

/**
 * The Service lens's trail while SCOPED to a cluster neighbourhood: `All services › <label> ✕`,
 * gaining ` › <cluster>` when a frame is dived into (the cluster zoom composes with the scope).
 * "All services" is the full exit (scope AND zoom); the ✕ drops the scope filter only; a focused
 * scope label steps back out of the zoom into the scoped lens. Mirrors LevelBreadcrumb's chrome so
 * the two read as one control.
 */
export function ServiceScopeBreadcrumb(props: {
  label: string;
  crumbs?: Crumb[];
  onClear: () => void;
  onExitScope: () => void;
  onFocus?: (id: string | null) => void;
}) {
  const crumbs = props.crumbs ?? [];
  const focused = crumbs.length > 0;
  return (
    <nav style={BREADCRUMB_STYLE} aria-label="Service scope">
      <button type="button" style={CRUMB_STYLE} onClick={props.onClear}>All services</button>
      <span style={SEG_WRAP}>
        <span style={CRUMB_SEP_STYLE} aria-hidden>›</span>
        {focused ? (
          <button type="button" style={CRUMB_STYLE} onClick={() => props.onFocus?.(null)}>{props.label}</button>
        ) : (
          <span style={CRUMB_CURRENT_STYLE} aria-current="page">{props.label}</span>
        )}
        <button type="button" style={CRUMB_STYLE} aria-label="Exit service scope" onClick={props.onExitScope}>✕</button>
      </span>
      {crumbs.map((crumb) => (
        <span key={crumb.id} style={SEG_WRAP}>
          <span style={CRUMB_SEP_STYLE} aria-hidden>›</span>
          <span style={CRUMB_CURRENT_STYLE} aria-current="page" title={crumb.id}>{crumb.label}</span>
        </span>
      ))}
    </nav>
  );
}

/** The floating action a selection (one card or more) reveals: extract it into the minimal-graph overlay. */
export function BuildMinimalGraphButton(props: { count: number; onBuild: () => void }) {
  return (
    <button type="button" style={BUILD_BUTTON_STYLE} onClick={props.onBuild}>
      Extract selection ({props.count})
    </button>
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
// Floats bottom-center over the canvas; the emphasis green ties it to the selected cards' rings.
const BUILD_BUTTON_STYLE: React.CSSProperties = {
  position: "absolute",
  bottom: 24,
  left: "50%",
  transform: "translateX(-50%)",
  zIndex: 5,
  border: "1px solid #2F5C3B",
  borderRadius: 8,
  background: "rgba(86,194,113,0.16)",
  padding: "8px 16px",
  cursor: "pointer",
  font: "inherit",
  fontSize: 13,
  fontWeight: 700,
  color: "#6BE38A",
};
