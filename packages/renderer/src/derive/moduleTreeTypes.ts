import type { StepData } from "./flowSteps";
import type { GhostData } from "./ghostDeps";
import type { BlockData, ModuleCardData, UnitCardData } from "./moduleLevel";
import type { ModulePackageData } from "./packageOverview";

export type ModuleGroupData = ModulePackageData & {
  isContainer: boolean;
  isExpanded: boolean;
  /** A presentational frame (the minimal-graph overlay): no expand/collapse actions, no package
   * coupling counts (they aren't computed for a filtered subgraph). Absent on the real Map. */
  readOnly?: boolean;
};

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
  category: "import" | "dep" | "flow" | "ipc";
  /** For `dep` wires: the underlying coupling kind (calls / instantiates / extends / implements /
   * references), so the paint layer colours per relationship type and the toggles filter by it. */
  depKind?: string;
  /** The far endpoint is a GHOST card (an off-screen definition/caller) — drawn dashed. */
  ghost?: boolean;
  /** The artifact edge ids this wire aggregates — the Wire Inspector resolves them back to real
   * symbol→symbol links and their call sites. Absent on synthetic wires (flow chains, IPC). */
  underlyingEdgeIds?: string[];
  /** The target is a demoted COMMONS hub (see commonsDemotion): hidden at rest, lit like any wire. */
  commons?: boolean;
}

export interface ModuleTree {
  nodes: VisibleModuleNode[];
  edges: ModuleTreeEdge[];
  effectiveFocus: string | null;
}
