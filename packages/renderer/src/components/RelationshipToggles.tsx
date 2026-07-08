/**
 * The Module-map relationship filter: one pill per wire kind (Calls / Constructs / Extends /
 * Implements / References / Imports / IPC), each carrying its colour dot. An ACTIVE (filled) pill
 * means that kind is drawn; clicking paints its wires out in place — no relayout — so you can isolate
 * "just the inheritance" or "just the calls". Mirrors ModuleCategoryToggles' styling.
 */

import { useBlueprint, useBlueprintActions } from "../state/StoreContext";
import { RELATIONSHIP_KINDS } from "../theme/relationshipKinds";

export function RelationshipToggles() {
  const hiddenRelKinds = useBlueprint((state) => state.hiddenRelKinds);
  const toggleRelKind = useBlueprintActions().toggleRelKind;
  return (
    <section style={SECTION_STYLE} aria-label="Relationship kinds">
      <span style={HEADER_STYLE}>Show relationships</span>
      <div style={ROW_STYLE} role="group">
        {RELATIONSHIP_KINDS.map(({ key, label, color }) => {
          const shown = !hiddenRelKinds.has(key);
          return (
            <button
              key={key}
              type="button"
              style={pillStyle(shown)}
              aria-pressed={shown}
              title={shown ? `Hide ${label}` : `Show ${label}`}
              onClick={() => toggleRelKind(key)}
            >
              <span style={{ ...DOT_STYLE, background: shown ? color : "transparent", borderColor: color }} />
              {label}
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
  gap: 6,
};
const HEADER_STYLE: React.CSSProperties = {
  fontSize: 10,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "#565E68",
};
const ROW_STYLE: React.CSSProperties = { display: "flex", flexWrap: "wrap", gap: 6 };
const DOT_STYLE: React.CSSProperties = { display: "inline-block", width: 8, height: 8, borderRadius: 2, border: "1px solid", flexShrink: 0 };

function pillStyle(shown: boolean): React.CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    border: `1px solid ${shown ? "#3A424E" : "#242A32"}`,
    borderRadius: 7,
    background: shown ? "#1B222D" : "transparent",
    color: shown ? "#C8D3E0" : "#6C7683",
    padding: "3px 8px",
    fontSize: 11,
    fontWeight: 600,
    cursor: "pointer",
  };
}
