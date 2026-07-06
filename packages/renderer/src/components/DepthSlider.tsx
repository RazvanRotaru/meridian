/**
 * The Module-map depth dial: a real range slider that trims how many import hops out from the root
 * the map draws. Positions 1..maxObservedDepth are literal hop counts; one extra position past the
 * end is "All" (the whole blast radius), mapped to the GHOST_DEPTH_ALL sentinel. The slider's ceiling
 * is the UNBOUNDED diameter (moduleMaxDepth), so dialing down never shrinks the range and strands the
 * reader at a low depth.
 */

import { useBlueprint, useBlueprintActions } from "../state/StoreContext";
import { GHOST_DEPTH_ALL } from "../state/store";

export function DepthSlider() {
  const moduleDepth = useBlueprint((state) => state.moduleDepth);
  const moduleMaxDepth = useBlueprint((state) => state.moduleMaxDepth);
  const setModuleDepth = useBlueprintActions().setModuleDepth;

  const maxHop = Math.max(1, moduleMaxDepth);
  const allPosition = maxHop + 1;
  const isAll = moduleDepth >= GHOST_DEPTH_ALL;
  const position = isAll ? allPosition : Math.min(Math.max(1, moduleDepth), maxHop);

  const onChange = (value: number) => setModuleDepth(value >= allPosition ? GHOST_DEPTH_ALL : value);

  return (
    <section style={SECTION_STYLE} aria-label="Import depth">
      <div style={HEADER_ROW_STYLE}>
        <span style={HEADER_STYLE}>Import depth</span>
        <span style={VALUE_STYLE}>{isAll ? "All" : position}</span>
      </div>
      <input
        style={SLIDER_STYLE}
        type="range"
        min={1}
        max={allPosition}
        step={1}
        value={position}
        aria-valuetext={isAll ? "All hops" : `${position} hop(s)`}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <div style={SCALE_STYLE}>
        <span>1</span>
        <span>All</span>
      </div>
    </section>
  );
}

const SECTION_STYLE: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 5,
  paddingTop: 8,
  borderTop: "1px solid #2A2F37",
};
const HEADER_ROW_STYLE: React.CSSProperties = { display: "flex", alignItems: "baseline", justifyContent: "space-between" };
const HEADER_STYLE: React.CSSProperties = {
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  color: "#7B8695",
};
const VALUE_STYLE: React.CSSProperties = { fontSize: 12, fontWeight: 700, color: "#E6EDF3" };
const SLIDER_STYLE: React.CSSProperties = { width: "100%", accentColor: "#5B9BE3", cursor: "pointer" };
const SCALE_STYLE: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  fontSize: 10,
  color: "#6C7683",
};
