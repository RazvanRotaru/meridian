import { useBlueprint, useBlueprintActions } from "../state/StoreContext";
import { MODULE_GROUPING_LABEL, MODULE_GROUPINGS } from "../derive/moduleGrouping";

export function ModuleGroupingToggle() {
  const grouping = useBlueprint((state) => state.moduleGrouping);
  const setModuleGrouping = useBlueprintActions().setModuleGrouping;
  return (
    <section style={SECTION_STYLE} aria-label="Service composition overview grouping">
      <span style={HEADER_STYLE}>Overview mode</span>
      <div style={ROW_STYLE} role="group">
        {MODULE_GROUPINGS.map((mode) => (
          <button
            key={mode}
            type="button"
            style={pillStyle(grouping === mode)}
            aria-pressed={grouping === mode}
            onClick={() => setModuleGrouping(mode)}
          >
            {MODULE_GROUPING_LABEL[mode]}
          </button>
        ))}
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
const ROW_STYLE: React.CSSProperties = { display: "flex", gap: 6 };

function pillStyle(active: boolean): React.CSSProperties {
  return {
    flex: 1,
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
