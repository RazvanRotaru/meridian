/**
 * The control panel's identity header: a project chip (status dot + name + chevron), the
 * expand-all / collapse-all icon buttons, and a "Repository · N packages · M files" summary line
 * counted from the graph index.
 */

import { useMemo } from "react";
import type { GraphNode } from "@meridian/core";
import { useBlueprint, useBlueprintActions } from "../../state/StoreContext";
import { IconButton, TOKENS } from "./panelKit";
import { ChevronDownIcon, CollapseIcon, ExpandIcon } from "./icons";

const PROJECT_DOT = "#5B9BE3";

export function ControlPanelHeader(props: { showExpandControls: boolean }) {
  const targetName = useBlueprint((state) => state.artifact.target.name);
  const index = useBlueprint((state) => state.index);
  const { expandAll, collapseAll } = useBlueprintActions();
  const counts = useMemo(() => countKinds(index.roots, index.nodesById), [index]);
  return (
    <div style={WRAP_STYLE}>
      <div style={TOP_ROW_STYLE}>
        <div style={PROJECT_CHIP_STYLE} title={targetName}>
          <span style={DOT_STYLE} />
          <span style={NAME_STYLE}>{targetName}</span>
          <span style={CHEVRON_STYLE}>
            <ChevronDownIcon />
          </span>
        </div>
        {props.showExpandControls ? (
          <div style={ACTIONS_STYLE}>
            <IconButton title="Expand the selection one level — or the whole view when nothing is selected" onClick={expandAll}>
              <ExpandIcon />
            </IconButton>
            <IconButton title="Collapse the selection one level — or the whole view when nothing is selected" onClick={collapseAll}>
              <CollapseIcon />
            </IconButton>
          </div>
        ) : null}
      </div>
      <div style={SUBTITLE_STYLE}>{subtitle(counts)}</div>
    </div>
  );
}

interface Counts {
  packages: number;
  files: number;
}

// "Packages" counts the declared npm packages (the `npm-package` tag — matches the cards the Map
// overview draws for a monorepo). Extractors that don't tag them (a plain single service) fall back
// to root package nodes, so a lone service still reads "1 package". "Files" counts every module.
function countKinds(roots: readonly GraphNode[], nodesById: ReadonlyMap<string, GraphNode>): Counts {
  let files = 0;
  let npmPackages = 0;
  for (const node of nodesById.values()) {
    if (node.kind === "module") {
      files += 1;
    } else if (node.kind === "package" && node.tags?.includes("npm-package")) {
      npmPackages += 1;
    }
  }
  const packages = npmPackages > 0 ? npmPackages : roots.filter((node) => node.kind === "package").length;
  return { packages, files };
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
const TOP_ROW_STYLE: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8 };
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
const CHEVRON_STYLE: React.CSSProperties = { display: "inline-flex", color: TOKENS.textDim, flexShrink: 0 };
const ACTIONS_STYLE: React.CSSProperties = { display: "flex", gap: 6, flexShrink: 0 };
const SUBTITLE_STYLE: React.CSSProperties = { fontSize: 12, color: TOKENS.textDim, letterSpacing: "0.01em" };
