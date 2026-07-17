/**
 * The control panel's identity header: a project chip (status dot + name) and a
 * "Repository · N packages · M files" summary line counted from the graph index. Canvas actions
 * live in the bottom action bar, leaving the project name room to breathe.
 */

import { useMemo } from "react";
import type { GraphIndex } from "../../graph/graphIndex";
import { useBlueprint } from "../../state/StoreContext";
import { TOKENS } from "./panelKit";

const PROJECT_DOT = "#5B9BE3";

export function ControlPanelHeader() {
  const targetName = useBlueprint((state) => state.artifact.target.name);
  const index = useBlueprint((state) => state.index);
  const counts = useMemo(() => countKinds(index), [index]);
  return (
    <div style={WRAP_STYLE}>
      <div style={PROJECT_CHIP_STYLE} title={targetName}>
        <span style={DOT_STYLE} />
        <span style={NAME_STYLE}>{targetName}</span>
      </div>
      <div style={SUBTITLE_STYLE}>{subtitle(counts)}</div>
    </div>
  );
}

interface Counts {
  packages: number;
  files: number;
}

// Use the Map's actual overview frontier so tagged npm ownership roots and structural roots from
// other languages are counted together. Package-less module fallback cards remain files, not
// pretend packages.
export function countKinds(index: GraphIndex): Counts {
  return {
    packages: index.structure.repositorySummary.overviewPackageCount,
    files: index.structure.repositorySummary.sourceFileCount,
  };
}

function subtitle(counts: Counts): string {
  const parts = ["Repository"];
  if (counts.packages > 0) {
    parts.push(`${counts.packages} ${counts.packages === 1 ? "package" : "packages"}`);
  }
  parts.push(`${counts.files} ${counts.files === 1 ? "file" : "files"}`);
  return parts.join(" · ");
}

const WRAP_STYLE: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 8 };
const PROJECT_CHIP_STYLE: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  minWidth: 0,
  flex: 1,
  padding: "7px 10px",
  borderRadius: 9,
  border: `1px solid ${TOKENS.surfaceBorder}`,
  background: TOKENS.surface,
};
const DOT_STYLE: React.CSSProperties = { width: 8, height: 8, borderRadius: 999, background: PROJECT_DOT, flexShrink: 0 };
const NAME_STYLE: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontSize: 14,
  fontWeight: 600,
  color: TOKENS.text,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
const SUBTITLE_STYLE: React.CSSProperties = { fontSize: 12, color: TOKENS.textDim, letterSpacing: "0.01em" };
