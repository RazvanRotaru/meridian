/**
 * The list's removed-files section: files deleted in the PR. They have no node at HEAD, so they
 * aren't drawn on the graph and can't be ticked — they're surfaced here for completeness, excluded
 * from the "N / M reviewed" denominator. Collapsed by default so a PR that deletes nothing stays
 * quiet. Modeled on `ReviewNotCoveredSection`; the red accent echoes the graph's "removed" swatch.
 */

import { useState } from "react";
import { REVIEW_COLORS } from "../theme/reviewColors";
import { basename } from "./reviewListText";

export function ReviewRemovedSection(props: { removed: string[] }) {
  const { removed } = props;
  const [expanded, setExpanded] = useState(false);
  if (removed.length === 0) {
    return null;
  }
  return (
    <div style={SECTION_STYLE}>
      <button type="button" style={HEAD_STYLE} aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
        <span style={CHEVRON_STYLE}>{expanded ? "▾" : "▸"}</span>
        <span style={DOT_STYLE} aria-hidden />
        <span>Removed ({removed.length})</span>
      </button>
      {expanded ? (
        <div style={BODY_STYLE}>
          {removed.map((file) => (
            <div key={file} style={ROW_STYLE} title={file}>
              <span style={NAME_STYLE}>{basename(file)}</span>
              <span style={PATH_STYLE}>{file}</span>
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
const DOT_STYLE: React.CSSProperties = {
  width: 8,
  height: 8,
  borderRadius: 2,
  background: REVIEW_COLORS.removed,
  flexShrink: 0,
};
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
const PATH_STYLE: React.CSSProperties = {
  fontSize: 10.5,
  color: "#6C7683",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
