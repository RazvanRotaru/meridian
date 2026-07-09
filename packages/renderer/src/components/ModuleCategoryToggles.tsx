/**
 * The Module-map CATEGORY filter row: one coloured pill per toggleable category (UI / Utilities /
 * Config). An ACTIVE (filled) pill means that category is shown; clicking paints those cards out of
 * the map in place (no relayout). Entry and App always show, so they're not offered. The section
 * heading + "Clear" reset live in the Toolbar; this renders only the pills.
 */

import { useBlueprint, useBlueprintActions } from "../state/StoreContext";
import { CATEGORY_LABEL, TOGGLEABLE_CATEGORIES } from "../derive/moduleCategory";
import { categoryColor } from "../theme/categoryColors";
import { Pill } from "./controlpanel/panelKit";

export function ModuleCategoryToggles() {
  const hiddenCategories = useBlueprint((state) => state.hiddenCategories);
  const toggleCategory = useBlueprintActions().toggleCategory;
  return (
    <div style={ROW_STYLE} role="group" aria-label="Module categories">
      {TOGGLEABLE_CATEGORIES.map((category) => {
        const shown = !hiddenCategories.has(category);
        return (
          <Pill
            key={category}
            active={shown}
            accent={categoryColor(category)}
            title={shown ? `Hide ${CATEGORY_LABEL[category]}` : `Show ${CATEGORY_LABEL[category]}`}
            onClick={() => toggleCategory(category)}
          >
            {CATEGORY_LABEL[category]}
          </Pill>
        );
      })}
    </div>
  );
}

const ROW_STYLE: React.CSSProperties = { display: "flex", flexWrap: "wrap", gap: 7 };
