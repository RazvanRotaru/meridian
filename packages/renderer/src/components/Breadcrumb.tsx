/**
 * The dive-in breadcrumb: "System" (home) then the containment path root..focusId. Each
 * segment is clickable — "System" surfaces all the way out, an ancestor jumps to that level.
 * The trail IS how the focused box is represented, since a focused container is never drawn.
 */

import { Fragment } from "react";
import { useBlueprint, useBlueprintActions } from "../state/StoreContext";
import { titleCase } from "../theme/displayName";

export function Breadcrumb() {
  const focusId = useBlueprint((state) => state.focusId);
  const index = useBlueprint((state) => state.index);
  const { diveHome, diveTo } = useBlueprintActions();
  const trail = focusId ? index.ancestorsOf(focusId) : [];
  return (
    <nav style={NAV_STYLE} aria-label="Focus path">
      <Segment label="System" current={focusId === null} onClick={diveHome} />
      {trail.map((node) => (
        <Fragment key={node.id}>
          <span style={SEPARATOR_STYLE} aria-hidden>
            ›
          </span>
          <Segment
            label={titleCase(node.displayName)}
            current={node.id === focusId}
            onClick={() => diveTo(node.id)}
          />
        </Fragment>
      ))}
    </nav>
  );
}

function Segment(props: { label: string; current: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      style={segmentStyle(props.current)}
      onClick={props.onClick}
      aria-current={props.current ? "page" : undefined}
    >
      {props.label}
    </button>
  );
}

const NAV_STYLE: React.CSSProperties = { display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" };
const SEPARATOR_STYLE: React.CSSProperties = { color: "#4B535F", fontSize: 12 };

function segmentStyle(current: boolean): React.CSSProperties {
  return {
    background: "transparent",
    border: "none",
    padding: "2px 4px",
    borderRadius: 4,
    cursor: "pointer",
    font: "inherit",
    fontSize: 12,
    fontWeight: current ? 600 : 400,
    color: current ? "#E6EDF3" : "#9AA4B2",
  };
}
