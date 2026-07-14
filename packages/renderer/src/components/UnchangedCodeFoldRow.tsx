import type { UnchangedCodeFold } from "./codeFolding";

export function UnchangedCodeFoldRow(props: {
  fold: UnchangedCodeFold;
  expanded: boolean;
  gutterVisible: boolean;
  onToggle(): void;
}) {
  const action = props.expanded ? "Collapse" : "Expand";
  const unit = props.fold.lineCount === 1 ? "line" : "lines";
  const label = `${action} ${props.fold.lineCount} unchanged ${unit}`;
  return (
    <tr data-unchanged-lines={`${props.fold.startLine}-${props.fold.endLine}`}>
      <td colSpan={props.gutterVisible ? 2 : 1} style={CELL_STYLE}>
        <button
          type="button"
          style={BUTTON_STYLE}
          aria-expanded={props.expanded}
          aria-label={label}
          title={label}
          onClick={(event) => {
            event.stopPropagation();
            props.onToggle();
          }}
        >
          <span aria-hidden="true">{props.expanded ? "▴" : "⋯"}</span>
          <span>{props.fold.lineCount} unchanged {unit}</span>
          <span aria-hidden="true">{props.expanded ? "▴" : "⋯"}</span>
        </button>
      </td>
    </tr>
  );
}

const CELL_STYLE: React.CSSProperties = {
  height: 24,
  padding: 0,
  background: "rgba(56,139,253,0.08)",
  borderTop: "1px solid rgba(56,139,253,0.22)",
  borderBottom: "1px solid rgba(56,139,253,0.22)",
};

const BUTTON_STYLE: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 8,
  width: "100%",
  minHeight: 24,
  padding: "2px 10px",
  border: 0,
  background: "transparent",
  color: "#7DD3FC",
  font: "inherit",
  fontSize: 10.5,
  cursor: "pointer",
};
