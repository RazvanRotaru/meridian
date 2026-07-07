/**
 * The "Private" visibility switch for the Map lens: one click removes every `private`-tagged
 * member block (a class's internal helpers) from the drawn frames, one click brings them back.
 * A DERIVE-level filter — frames resize and member counts stay honest — so flipping it relayouts.
 * Disabled — but still visible, as an honest "none found" — when nothing is tagged private.
 */

import { useBlueprint, useBlueprintActions } from "../state/StoreContext";
import type { BlueprintState } from "../state/store";

export function PrivateToggle() {
  const showPrivate = useBlueprint((state) => state.showPrivate);
  const privateCount = useBlueprint(countPrivateMembers);
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

function countPrivateMembers(state: BlueprintState): number {
  let count = 0;
  for (const node of state.index.nodesById.values()) {
    if (node.tags?.includes("private")) {
      count += 1;
    }
  }
  return count;
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
