/**
 * The Module-map highlight-radius dial: with nodes selected, it sets how many import hops out from
 * EACH selected node light up (the union of their neighbourhoods at this level). PAINT-ONLY — it
 * never relayouts; the surface recomputes the lit set in a useMemo. Hidden until at least one node
 * is selected (radius means nothing without a focus of attention). Positions 1..MAX_HOPS are literal
 * hops; one past the end is "All".
 */

import { useBlueprint, useBlueprintActions } from "../state/StoreContext";
import { GHOST_DEPTH_ALL } from "../state/store";

const MAX_HOPS = 4;
const ALL_POSITION = MAX_HOPS + 1;

export function DepthSlider() {
  const radius = useBlueprint((state) => state.moduleRadius);
  const selectedCount = useBlueprint((state) => state.moduleSelected.size);
  const setModuleRadius = useBlueprintActions().setModuleRadius;

  if (selectedCount === 0) {
    return null;
  }
  const isAll = radius >= GHOST_DEPTH_ALL;
  const position = isAll ? ALL_POSITION : Math.min(Math.max(1, radius), MAX_HOPS);
  const onChange = (value: number) => setModuleRadius(value >= ALL_POSITION ? GHOST_DEPTH_ALL : value);

  return (
    <section style={SECTION_STYLE} aria-label="Highlight radius">
      <div style={HEADER_ROW_STYLE}>
        <span style={HEADER_STYLE}>Highlight radius</span>
        <span style={VALUE_STYLE}>{isAll ? "All" : position}</span>
      </div>
      <input
        style={SLIDER_STYLE}
        type="range"
        min={1}
        max={ALL_POSITION}
        step={1}
        value={position}
        aria-valuetext={isAll ? "All connected hops" : `${position} hop(s)`}
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
