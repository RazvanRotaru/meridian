/**
 * The amber banner above the list for changed-file paths that didn't resolve cleanly: plain
 * unmatched paths (no file in this graph), and ambiguous paths (several equally-good module
 * candidates — a monorepo duplicated-tail trap). Each row can drop its path from the affected
 * set; an ambiguous row can also "apply" a candidate, swapping the raw path for that module's
 * canonical file so it re-matches on the next relayout.
 */

import { useState } from "react";
import { normalizePath } from "../derive/matchAffectedFiles";
import type { ReviewModel } from "../derive/reviewModel";
import { useBlueprint, useBlueprintActions } from "../state/StoreContext";
import { basename } from "./reviewListText";

export function ReviewUnmatchedBanner(props: { model: ReviewModel }) {
  const { model } = props;
  const affectedFiles = useBlueprint((state) => state.affectedFiles);
  const changeStatusByFile = useBlueprint((state) => state.changeStatusByFile);
  const index = useBlueprint((state) => state.index);
  const { setAffectedFiles } = useBlueprintActions();
  const [expanded, setExpanded] = useState(false);

  const total = model.unmatched.length + model.ambiguous.length;
  if (total === 0) {
    return null;
  }

  // Carry the current status map through both edits — dropping it would silently reset every file to
  // "modified". Stale keys for a removed path are harmless (looked up only for files still present).
  const remove = (path: string) =>
    setAffectedFiles(affectedFiles.filter((file) => normalizePath(file) !== path), changeStatusByFile);
  const apply = (path: string, candidateId: string) => {
    const file = index.nodesById.get(candidateId)?.location?.file ?? candidateId;
    setAffectedFiles(affectedFiles.map((raw) => (normalizePath(raw) === path ? file : raw)), changeStatusByFile);
  };

  return (
    <div style={BANNER_STYLE}>
      <button type="button" style={HEAD_STYLE} aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
        <span style={CHEVRON_STYLE}>{expanded ? "▾" : "▸"}</span>
        <span>
          {total} path{total === 1 ? "" : "s"} didn't match any file in this graph
        </span>
      </button>
      {expanded ? (
        <div style={BODY_STYLE}>
          {model.unmatched.map((path) => (
            <PathRow key={path} path={path} onRemove={() => remove(path)} />
          ))}
          {model.ambiguous.map((item) => (
            <div key={item.path} style={AMBIGUOUS_GROUP_STYLE}>
              <PathRow path={item.path} onRemove={() => remove(item.path)} />
              <div style={CANDIDATE_ROW_STYLE}>
                {item.candidates.map((candidateId) => (
                  <button
                    key={candidateId}
                    type="button"
                    style={CANDIDATE_CHIP_STYLE}
                    title={candidateId}
                    onClick={() => apply(item.path, candidateId)}
                  >
                    apply {basename(index.nodesById.get(candidateId)?.location?.file ?? candidateId)}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function PathRow(props: { path: string; onRemove: () => void }) {
  return (
    <div style={PATH_ROW_STYLE}>
      <span style={PATH_TEXT_STYLE} title={props.path}>
        {props.path}
      </span>
      <button type="button" style={REMOVE_BUTTON_STYLE} onClick={props.onRemove}>
        remove
      </button>
    </div>
  );
}

const BANNER_STYLE: React.CSSProperties = {
  border: "1px solid rgba(227,179,65,0.35)",
  borderRadius: 8,
  background: "rgba(227,179,65,0.08)",
  margin: 10,
};
const HEAD_STYLE: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  width: "100%",
  background: "transparent",
  border: "none",
  color: "#E3B341",
  fontSize: 12,
  fontWeight: 600,
  padding: "8px 10px",
  cursor: "pointer",
  font: "inherit",
  textAlign: "left",
};
const CHEVRON_STYLE: React.CSSProperties = { fontSize: 9 };
const BODY_STYLE: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 8, padding: "0 10px 10px 24px" };
const AMBIGUOUS_GROUP_STYLE: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 4 };
const PATH_ROW_STYLE: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8 };
const PATH_TEXT_STYLE: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontSize: 11.5,
  color: "#E6EDF3",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
const REMOVE_BUTTON_STYLE: React.CSSProperties = {
  flexShrink: 0,
  background: "transparent",
  border: "none",
  color: "#9AA4B2",
  fontSize: 10.5,
  cursor: "pointer",
  padding: 0,
  font: "inherit",
  textDecoration: "underline",
  textUnderlineOffset: 2,
};
const CANDIDATE_ROW_STYLE: React.CSSProperties = { display: "flex", flexWrap: "wrap", gap: 6, paddingLeft: 2 };
const CANDIDATE_CHIP_STYLE: React.CSSProperties = {
  background: "#1A1F27",
  color: "#3FB7C4",
  border: "1px solid #2A2F37",
  borderRadius: 10,
  padding: "2px 8px",
  fontSize: 10.5,
  cursor: "pointer",
  font: "inherit",
};
