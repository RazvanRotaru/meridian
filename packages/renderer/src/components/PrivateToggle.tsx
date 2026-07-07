/**
 * The "Private" visibility switch for the Map lens: one click stops painting every `private`-tagged
 * member block (a class's internal helpers), one click brings them back. PAINT-ONLY, like the Tests
 * toggle — privates keep their layout space, so toggling never moves a card. Disabled — but still
 * visible, as an honest "none found" — when nothing is tagged private.
 */

import { useBlueprint, useBlueprintActions } from "../state/StoreContext";

export function PrivateToggle() {
  const showPrivate = useBlueprint((state) => state.showPrivate);
  const privateCount = useBlueprint((state) => state.index.privateIds.size);
  const togglePrivateMembers = useBlueprintActions().togglePrivateMembers;
  const none = privateCount === 0;
  return (
    <button
      type="button"
      style={toggleStyle(showPrivate && !none, none)}
      aria-pressed={showPrivate}
      disabled={none}
      title={none ? "Nothing is tagged private in this graph" : showPrivate ? "Hide private members" : "Show private members"}
      onClick={togglePrivateMembers}
    >
      {showPrivate && !none ? "◉" : "◎"} Private {none ? "(none)" : `(${privateCount})`}
    </button>
  );
}

function toggleStyle(active: boolean, disabled: boolean): React.CSSProperties {
  return {
    border: "1px solid #2A2F37",
    borderRadius: 6,
    padding: "4px 10px",
    fontSize: 12,
    cursor: disabled ? "default" : "pointer",
    font: "inherit",
    fontWeight: active ? 600 : 400,
    background: active ? "#1F2530" : "#0E1116",
    color: disabled ? "#565E68" : active ? "#E6EDF3" : "#9AA4B2",
    opacity: disabled ? 0.7 : 1,
  };
}
