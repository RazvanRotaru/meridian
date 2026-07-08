import { useEffect, useMemo, useState } from "react";
import { useBlueprint, useBlueprintActions } from "../../state/StoreContext";
import { filterFlowTree } from "./flowTreeFilter";
import { FlowTreeRow } from "./FlowTreeRow";
import { useFlowTree, useLogicFlows } from "./useFlowTree";
import { blockOpenKeysForSelection, entryOpenKeysForSelection, withOpenKeys } from "./flowTreeOpenState";

export function FlowExplorerPanel() {
  const open = useBlueprint((state) => state.flowExplorerOpen);
  const viewMode = useBlueprint((state) => state.viewMode);
  const selection = useBlueprint((state) => state.flowSelection);
  const { selectFlowEntry } = useBlueprintActions();
  const tree = useFlowTree();
  const flows = useLogicFlows();
  const [filter, setFilter] = useState("");
  const [openEntries, setOpenEntries] = useState<Set<string>>(new Set());
  const [openBlocks, setOpenBlocks] = useState<Set<string>>(new Set());
  const visibleTree = useMemo(() => filterFlowTree(tree, filter), [tree, filter]);
  useEffect(() => {
    const entryKeys = entryOpenKeysForSelection(tree, selection);
    if (entryKeys.length > 0) {
      setOpenEntries((current) => withOpenKeys(current, entryKeys));
    }
    const blockKeys = blockOpenKeysForSelection(selection);
    if (blockKeys.length > 0) {
      setOpenBlocks((current) => withOpenKeys(current, blockKeys));
    }
  }, [selection, tree]);
  if (!open || (viewMode !== "ui" && viewMode !== "modules")) {
    return null;
  }
  const filterActive = filter.trim().length > 0;
  return (
    <aside
      style={PANEL}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          selectFlowEntry(null);
        }
      }}
    >
      <header style={HEADER}>
        <strong style={TITLE}>Code flows</strong>
        <input
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Filter"
          aria-label="Filter code flows"
          style={FILTER}
        />
      </header>
      <div style={TREE}>
        {visibleTree.length === 0 ? <div style={EMPTY}>No matching flows.</div> : null}
        {visibleTree.map((entry) => (
          <FlowTreeRow
            key={entry.id}
            entry={entry}
            depth={0}
            filterActive={filterActive}
            flows={flows}
            openEntries={openEntries}
            openBlocks={openBlocks}
            selection={selection}
            onToggleEntry={(id) => setOpenEntries((current) => toggled(current, id))}
            onToggleBlock={(key) => setOpenBlocks((current) => toggled(current, key))}
            onOpenEntry={(id) => setOpenEntries((current) => withOpenKeys(current, [id]))}
            onOpenBlocks={(keys) => setOpenBlocks((current) => withOpenKeys(current, keys))}
          />
        ))}
      </div>
    </aside>
  );
}

function toggled(current: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(current);
  if (!next.delete(id)) {
    next.add(id);
  }
  return next;
}

const PANEL: React.CSSProperties = {
  width: 300,
  minWidth: 280,
  maxWidth: 340,
  height: "100%",
  display: "flex",
  flexDirection: "column",
  background: "#0B0E13",
  borderRight: "1px solid #222732",
  color: "#D6DEE9",
  overflow: "hidden",
};

const HEADER: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
  padding: 12,
  borderBottom: "1px solid #1B2028",
  background: "#0E1116",
};

const TITLE: React.CSSProperties = { fontSize: 13, color: "#E6EDF3" };
const FILTER: React.CSSProperties = {
  height: 28,
  border: "1px solid #2A313D",
  borderRadius: 6,
  background: "#12171E",
  color: "#D6DEE9",
  padding: "0 8px",
  fontSize: 12,
  outline: "none",
};
const TREE: React.CSSProperties = { flex: 1, minHeight: 0, overflow: "auto", padding: "6px 0" };
const EMPTY: React.CSSProperties = { padding: "10px 14px", color: "#6B7482", fontSize: 12 };
