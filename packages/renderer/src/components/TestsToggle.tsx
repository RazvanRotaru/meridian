/**
 * The "Tests" visibility switch: one click removes every test file (and its edges) from the
 * diagram, one click brings them back. Disabled — but still visible, as an honest "none
 * found" — when the graph contains no test code.
 */

import { useBlueprint, useBlueprintActions } from "../state/StoreContext";
import type { BlueprintState } from "../state/store";

export function TestsToggle() {
  const showTests = useBlueprint((state) => state.showTests);
  const testFileCount = useBlueprint(countTestFiles);
  const toggleShowTests = useBlueprintActions().toggleShowTests;
  const none = testFileCount === 0;
  return (
    <button
      type="button"
      style={toggleStyle(showTests && !none, none)}
      aria-pressed={showTests}
      disabled={none}
      title={none ? "No test files in this graph" : showTests ? "Hide test files" : "Show test files"}
      onClick={toggleShowTests}
    >
      {showTests && !none ? "◉" : "◎"} Tests {none ? "(none)" : `(${testFileCount})`}
    </button>
  );
}

function countTestFiles(state: BlueprintState): number {
  let count = 0;
  for (const id of state.index.testIds) {
    if (state.index.nodesById.get(id)?.kind === "module") {
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
