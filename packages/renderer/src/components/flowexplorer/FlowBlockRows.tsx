import type { LogicFlows } from "@meridian/core";
import { blockChildren, stepsAt, type FlowBlockSegment, type FlowSelectionRef } from "../../derive/flowBlocks";
import { useBlueprintActions } from "../../state/StoreContext";
import { blockDisplayLabel } from "./flowBlockLabels";
import { childSelection, sameFlowSelection, selectionKey } from "./flowSelection";
import { blockOpenKeysForSelection } from "./flowTreeOpenState";

interface FlowBlockRowsProps {
  rootId: string;
  blockPath: FlowBlockSegment[];
  depth: number;
  flows: LogicFlows;
  openBlocks: ReadonlySet<string>;
  selection: FlowSelectionRef | null;
  onToggleBlock: (key: string) => void;
  onOpenBlocks: (keys: readonly string[]) => void;
}

export function FlowBlockRows(props: FlowBlockRowsProps) {
  const steps = stepsAt(props.flows, { rootId: props.rootId, blockPath: props.blockPath });
  if (!steps) {
    return null;
  }
  return blockChildren(steps).map((child) => {
    const ref = childSelection(props.rootId, props.blockPath, child.segment);
    return (
      <FlowBlockRow
        key={selectionKey(ref)}
        refValue={ref}
        fallbackLabel={child.label}
        steps={steps}
        depth={props.depth}
        flows={props.flows}
        openBlocks={props.openBlocks}
        selection={props.selection}
        onToggleBlock={props.onToggleBlock}
        onOpenBlocks={props.onOpenBlocks}
      />
    );
  });
}

export function hasBlockRows(flows: LogicFlows, rootId: string, blockPath: FlowBlockSegment[]): boolean {
  const steps = stepsAt(flows, { rootId, blockPath });
  return steps ? blockChildren(steps).length > 0 : false;
}

interface FlowBlockRowProps {
  refValue: FlowSelectionRef;
  fallbackLabel: string;
  steps: NonNullable<ReturnType<typeof stepsAt>>;
  depth: number;
  flows: LogicFlows;
  openBlocks: ReadonlySet<string>;
  selection: FlowSelectionRef | null;
  onToggleBlock: (key: string) => void;
  onOpenBlocks: (keys: readonly string[]) => void;
}

function FlowBlockRow(props: FlowBlockRowProps) {
  const { selectFlowEntry } = useBlueprintActions();
  const key = selectionKey(props.refValue);
  const selected = sameFlowSelection(props.selection, props.refValue);
  const open = props.openBlocks.has(key);
  const hasChildren = hasBlockRows(props.flows, props.refValue.rootId, props.refValue.blockPath);
  const label = blockDisplayLabel(props.steps, props.refValue.blockPath.at(-1)!, props.fallbackLabel);
  return (
    <>
      <button
        type="button"
        style={rowStyle(props.depth, selected)}
        title={label}
        onClick={() => {
          props.onOpenBlocks(blockOpenKeysForSelection(props.refValue));
          selectFlowEntry(selected ? null : props.refValue);
        }}
      >
        <span style={CARET_SLOT}>
          {hasChildren ? (
            <span
              style={CARET}
              onClick={(event) => {
                event.stopPropagation();
                props.onToggleBlock(key);
              }}
            >
              {open ? "▾" : "▸"}
            </span>
          ) : null}
        </span>
        <span style={LABEL}>{label}</span>
      </button>
      {open && hasChildren ? (
        <FlowBlockRows
          rootId={props.refValue.rootId}
          blockPath={props.refValue.blockPath}
          depth={props.depth + 1}
          flows={props.flows}
          openBlocks={props.openBlocks}
          selection={props.selection}
          onToggleBlock={props.onToggleBlock}
          onOpenBlocks={props.onOpenBlocks}
        />
      ) : null}
    </>
  );
}

function rowStyle(depth: number, selected: boolean): React.CSSProperties {
  return {
    width: "100%",
    display: "flex",
    alignItems: "center",
    gap: 4,
    minHeight: 26,
    padding: `3px 8px 3px ${14 + depth * 14}px`,
    border: "none",
    borderLeft: `3px solid ${selected ? "#56C271" : "transparent"}`,
    background: selected ? "rgba(86,194,113,0.13)" : "transparent",
    color: selected ? "#DFF8E8" : "#98A3B3",
    cursor: "pointer",
    font: "inherit",
    textAlign: "left",
  };
}

const CARET_SLOT: React.CSSProperties = { width: 13, flexShrink: 0, color: "#6B7482" };
const CARET: React.CSSProperties = { display: "inline-block", width: 13 };
const LABEL: React.CSSProperties = {
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  fontSize: 12,
};
