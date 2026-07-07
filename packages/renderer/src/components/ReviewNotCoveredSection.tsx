/**
 * The list's bottom section: affected files no qualifying flow defines or reaches. Not
 * checkable (there is no flow to tick) and excluded from the "N / M reviewed" denominator —
 * collapsed by default so a clean PR doesn't clutter the list with an empty accordion.
 */

import { useState } from "react";
import type { NotCoveredFile } from "../derive/reviewFlows";
import { basename } from "./reviewListText";

export function ReviewNotCoveredSection(props: { notCovered: NotCoveredFile[] }) {
  const { notCovered } = props;
  const [expanded, setExpanded] = useState(false);
  if (notCovered.length === 0) {
    return null;
  }
  return (
    <div style={SECTION_STYLE}>
      <button type="button" style={HEAD_STYLE} aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
        <span style={CHEVRON_STYLE}>{expanded ? "▾" : "▸"}</span>
        <span>Not covered by any flow ({notCovered.length})</span>
      </button>
      {expanded ? (
        <div style={BODY_STYLE}>
          {notCovered.map((entry) => (
            <div key={entry.file} style={ROW_STYLE} title={entry.file}>
              <span style={NAME_STYLE}>{basename(entry.file)}</span>
              <span style={REASON_STYLE}>{entry.reason}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

const SECTION_STYLE: React.CSSProperties = { borderTop: "1px solid #2A2F37" };
const HEAD_STYLE: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  width: "100%",
  background: "transparent",
  border: "none",
  color: "#9AA4B2",
  fontSize: 11.5,
  padding: "8px 12px",
  cursor: "pointer",
  font: "inherit",
  textAlign: "left",
};
const CHEVRON_STYLE: React.CSSProperties = { fontSize: 9, color: "#6C7683" };
const BODY_STYLE: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 4, padding: "0 12px 10px 26px" };
const ROW_STYLE: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 1 };
const NAME_STYLE: React.CSSProperties = {
  fontSize: 11.5,
  color: "#9AA4B2",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
const REASON_STYLE: React.CSSProperties = { fontSize: 10.5, color: "#6C7683" };
