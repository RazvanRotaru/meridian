/**
 * The Module-map category filter: one pill per toggleable category (UI / Utilities / Config). An
 * ACTIVE (filled) pill means that category is shown; clicking it paints those cards out of the map in
 * place (no relayout — positions stay put). Entry and App always show, so they're not offered. Mirrors
 * TestsToggle's pill styling.
 */

import { useBlueprint, useBlueprintActions } from "../state/StoreContext";
import { CATEGORY_LABEL, TOGGLEABLE_CATEGORIES } from "../derive/moduleCategory";

export function ModuleCategoryToggles() {
  const hiddenCategories = useBlueprint((state) => state.hiddenCategories);
  const toggleCategory = useBlueprintActions().toggleCategory;
  return (
    <section style={SECTION_STYLE} aria-label="Module categories">
      <span style={HEADER_STYLE}>Show categories</span>
      <div style={ROW_STYLE} role="group">
        {TOGGLEABLE_CATEGORIES.map((category) => {
          const shown = !hiddenCategories.has(category);
          return (
            <button
              key={category}
              type="button"
              style={pillStyle(shown)}
              aria-pressed={shown}
              title={shown ? `Hide ${CATEGORY_LABEL[category]}` : `Show ${CATEGORY_LABEL[category]}`}
              onClick={() => toggleCategory(category)}
            >
              {shown ? "◉" : "◎"} {CATEGORY_LABEL[category]}
            </button>
          );
        })}
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
const HEADER_STYLE: React.CSSProperties = {
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  color: "#7B8695",
};
const ROW_STYLE: React.CSSProperties = { display: "flex", flexWrap: "wrap", gap: 6 };

function pillStyle(active: boolean): React.CSSProperties {
  return {
    border: "1px solid #2A2F37",
    borderRadius: 6,
    padding: "4px 10px",
    fontSize: 12,
    cursor: "pointer",
    font: "inherit",
    fontWeight: active ? 600 : 400,
    background: active ? "#1F2530" : "#0E1116",
    color: active ? "#E6EDF3" : "#9AA4B2",
  };
}
