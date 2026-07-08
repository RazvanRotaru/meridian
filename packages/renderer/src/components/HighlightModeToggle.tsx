import { useBlueprint, useBlueprintActions } from "../state/StoreContext";

export function HighlightModeToggle() {
  const mode = useBlueprint((state) => state.highlightMode);
  const toggleHighlightMode = useBlueprintActions().toggleHighlightMode;
  const reach = mode === "reach";
  return (
    <button
      type="button"
      style={toggleStyle(reach)}
      aria-pressed={reach}
      title={reach ? "Reach mode: selection lights radius-based upstream/downstream paths" : "Node mode: selection lights only incident caller/callee wires"}
      onClick={toggleHighlightMode}
    >
      {reach ? "◉" : "◎"} Reach
    </button>
  );
}

function toggleStyle(active: boolean): React.CSSProperties {
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
