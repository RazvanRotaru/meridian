import type { LogicFlows } from "@meridian/core";
import type { FlowSelectionRef } from "../../derive/flowBlocks";
import type { FlowTreeEntry } from "../../derive/flowTree";
import { useBlueprintActions } from "../../state/StoreContext";
import { FlowBlockRows, hasBlockRows } from "./FlowBlockRows";
import { sameFlowSelection } from "./flowSelection";

interface FlowTreeRowProps {
  entry: FlowTreeEntry;
  depth: number;
  filterActive: boolean;
  flows: LogicFlows;
  openEntries: ReadonlySet<string>;
  openBlocks: ReadonlySet<string>;
  selection: FlowSelectionRef | null;
  onToggleEntry: (id: string) => void;
  onToggleBlock: (key: string) => void;
  onOpenEntry: (id: string) => void;
  onOpenBlocks: (keys: readonly string[]) => void;
}

export function FlowTreeRow(props: FlowTreeRowProps) {
  const { selectFlowEntry } = useBlueprintActions();
  const ref = props.entry.flowRootId ? { rootId: props.entry.flowRootId, blockPath: [] } : null;
  const selected = sameFlowSelection(props.selection, ref);
  const locallyOpen = props.openEntries.has(props.entry.id);
  const childrenOpen = props.filterActive || locallyOpen;
  const blockRowsOpen = locallyOpen;
  const hasBlocks = ref ? hasBlockRows(props.flows, ref.rootId, ref.blockPath) : false;
  const expandable = props.entry.children.length > 0 || hasBlocks;
  const caretOpen = (props.entry.children.length > 0 && childrenOpen) || (hasBlocks && blockRowsOpen);
  const onRowClick = () => {
    if (ref) {
      props.onOpenEntry(props.entry.id);
      selectFlowEntry(selected ? null : ref);
      return;
    }
    if (expandable) {
      props.onOpenEntry(props.entry.id);
    }
  };
  return (
    <>
      <button type="button" style={rowStyle(props.depth, selected, ref !== null || expandable)} title={props.entry.id} onClick={onRowClick}>
        <span style={CARET_SLOT}>
          {expandable ? (
            <span
              style={CARET}
              onClick={(event) => {
                event.stopPropagation();
                props.onToggleEntry(props.entry.id);
              }}
            >
              {caretOpen ? "▾" : "▸"}
            </span>
          ) : null}
        </span>
        <span style={KIND}>{kindGlyph(props.entry.kind)}</span>
        <span style={LABEL}>{props.entry.label}</span>
      </button>
      {ref && blockRowsOpen ? (
        <FlowBlockRows
          rootId={ref.rootId}
          blockPath={ref.blockPath}
          depth={props.depth + 1}
          flows={props.flows}
          openBlocks={props.openBlocks}
          selection={props.selection}
          onToggleBlock={props.onToggleBlock}
          onOpenBlocks={props.onOpenBlocks}
        />
      ) : null}
      {childrenOpen
        ? props.entry.children.map((child) => (
            <FlowTreeRow
              key={child.id}
              entry={child}
              depth={props.depth + 1}
              filterActive={props.filterActive}
              flows={props.flows}
              openEntries={props.openEntries}
              openBlocks={props.openBlocks}
              selection={props.selection}
              onToggleEntry={props.onToggleEntry}
              onToggleBlock={props.onToggleBlock}
              onOpenEntry={props.onOpenEntry}
              onOpenBlocks={props.onOpenBlocks}
            />
          ))
        : null}
    </>
  );
}

function kindGlyph(kind: FlowTreeEntry["kind"]): string {
  if (kind === "container") return "▣";
  if (kind === "module") return "▤";
  if (kind === "class") return "◆";
  return "ƒ";
}

function rowStyle(depth: number, selected: boolean, selectable: boolean): React.CSSProperties {
  return {
    width: "100%",
    display: "flex",
    alignItems: "center",
    gap: 5,
    minHeight: 28,
    padding: `4px 8px 4px ${10 + depth * 14}px`,
    border: "none",
    borderLeft: `3px solid ${selected ? "#56C271" : "transparent"}`,
    background: selected ? "rgba(86,194,113,0.15)" : "transparent",
    color: selected ? "#E6F8EC" : selectable ? "#D6DEE9" : "#9AA4B2",
    cursor: selectable ? "pointer" : "default",
    font: "inherit",
    textAlign: "left",
  };
}

const CARET_SLOT: React.CSSProperties = { width: 14, flexShrink: 0, color: "#7B8695" };
const CARET: React.CSSProperties = { display: "inline-block", width: 14, cursor: "pointer" };
const KIND: React.CSSProperties = { width: 14, flexShrink: 0, color: "#5E74C6", fontSize: 11 };
const LABEL: React.CSSProperties = {
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  fontSize: 12.5,
};
