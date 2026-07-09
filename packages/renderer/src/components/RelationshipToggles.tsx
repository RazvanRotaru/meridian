/**
 * The Module-map RELATIONSHIP filter row: one coloured pill per wire kind (Calls / Constructs /
 * Extends / Implements / References / Imports / IPC), each carrying its colour dot. An ACTIVE
 * (filled) pill means that kind is drawn; clicking paints its wires out in place — no relayout — so
 * you can isolate "just the inheritance" or "just the calls". Heading + "All" reset live in the
 * Toolbar; this renders only the pills.
 */

import { useBlueprint, useBlueprintActions } from "../state/StoreContext";
import { RELATIONSHIP_KINDS } from "../theme/relationshipKinds";
import { Pill } from "./controlpanel/panelKit";

export function RelationshipToggles() {
  const hiddenRelKinds = useBlueprint((state) => state.hiddenRelKinds);
  const toggleRelKind = useBlueprintActions().toggleRelKind;
  return (
    <div style={ROW_STYLE} role="group" aria-label="Relationship kinds">
      {RELATIONSHIP_KINDS.map(({ key, label, color }) => {
        const shown = !hiddenRelKinds.has(key);
        return (
          <Pill
            key={key}
            active={shown}
            accent={color}
            title={shown ? `Hide ${label}` : `Show ${label}`}
            onClick={() => toggleRelKind(key)}
          >
            {label}
          </Pill>
        );
      })}
    </div>
  );
}

const ROW_STYLE: React.CSSProperties = { display: "flex", flexWrap: "wrap", gap: 7 };
