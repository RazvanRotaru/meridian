import type { StepData } from "./flowSteps";
import type { GhostData } from "./ghostDeps";
import type { BlockData, ModuleCardData, UnitCardData } from "./moduleLevel";
import type { ModulePackageData } from "./packageOverview";

export type ModuleGroupData = ModulePackageData & { isContainer: boolean; isExpanded: boolean };

/** One node in the drawn containment tree, in DFS preorder (parents BEFORE children — React Flow
 * requires a parent to appear first). `parentId` is the drawn parent (null at the frontier root). */
export interface VisibleModuleNode {
  id: string;
  parentId: string | null;
  kind: "package" | "file" | "unit" | "block" | "step" | "ghost";
  isContainer: boolean;
  isExpanded: boolean;
  depth: number;
  childCount: number;
  data: ModuleGroupData | ModuleCardData | UnitCardData | BlockData | StepData | GhostData;
}

/** A wire between two visible nodes. `category` "import" is the file/package import graph;
 * "dep" is a code-dependency wire (it touches at least one drawn unit frame or block). `crossFrame`
 * = a group is involved (coupling gold). */
export interface ModuleTreeEdge {
  id: string;
  source: string;
  target: string;
  weight: number;
  crossFrame: boolean;
  category: "import" | "dep" | "flow";
  /** The far endpoint is a GHOST card (an off-screen definition/caller) — drawn dashed. */
  ghost?: boolean;
}

export interface ModuleTree {
  nodes: VisibleModuleNode[];
  edges: ModuleTreeEdge[];
  effectiveFocus: string | null;
}
