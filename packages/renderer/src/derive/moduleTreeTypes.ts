import type { StepData } from "./flowSteps";
import type { GhostData } from "./ghostDeps";
import type { BlockData, ModuleCardData, UnitCardData } from "./moduleLevel";
import type { ModulePackageData } from "./packageOverview";

export type ModuleGroupData = ModulePackageData & {
  isContainer: boolean;
  isExpanded: boolean;
  /** Overrides the Map-native `N files` copy for artificial architectural parents. */
  countLabel?: string;
  /** A first-class synthetic Service container (`backend`, `analytics`, ...), never an artifact id. */
  serviceDomain?: boolean;
  serviceDomainKind?: "services" | "unassigned";
  /** A filtered/presentational package card: package coupling counts are not computed. Structural
   * interaction availability is owned separately by the active SurfaceInteractionContext. */
  readOnly?: boolean;
};

/** Paint/interaction metadata for the reversible ghost-neighbour inspection trail. These flags
 * decorate the ordinary module-card data rather than minting a parallel node kind: a visited ghost
 * is temporarily materialized as its exact file/unit/block card, while its one-hop call frontier
 * remains the shared ghost vocabulary. */
// `type` (not interface) preserves the implicit string index compatibility required by React
// Flow's `Node<Record<string, unknown>>` boundary when intersected with the existing data aliases.
export type GhostInspectionNodeData = {
  /** This card belongs to the retained inspection trail or its current one-hop call frontier. */
  ghostInspectionPath?: true;
  /** This exact artifact was explicitly visited by clicking through the ghost trail. */
  ghostInspectionVisited?: true;
  /** This card is one call hop from a visited artifact and may extend the trail. */
  ghostInspectionFrontier?: true;
  /** The visited card is reversible context, not yet covered by a committed `mapExtra` root. */
  ghostInspectionPreview?: true;
};

export type ModuleTreeNodeData = (
  | ModuleGroupData
  | ModuleCardData
  | UnitCardData
  | BlockData
  | StepData
  | GhostData
) & GhostInspectionNodeData;

/** One node in the drawn containment tree, in DFS preorder (parents BEFORE children — React Flow
 * requires a parent to appear first). `parentId` is the drawn parent (null at the frontier root). */
export interface VisibleModuleNode {
  id: string;
  parentId: string | null;
  kind: "package" | "serviceDomain" | "file" | "unit" | "block" | "step" | "ghost";
  isContainer: boolean;
  isExpanded: boolean;
  depth: number;
  childCount: number;
  data: ModuleTreeNodeData;
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
  /** True when any ORIGINAL artifact relationship behind this drawn wire crosses an npm-package,
   * linked-system, or external boundary. Never inferred from the lifted/drawn boxes. */
  crossPackage: boolean;
  /** True when this wire terminates at context materialized from outside the current drawn view. */
  outsideView: boolean;
  category: "import" | "dep" | "flow" | "ipc";
  /** Canonical exact relationship kind. Flow/order edges intentionally omit it. */
  relationKind?: string;
  /** For `dep` wires: the underlying coupling kind (calls / instantiates / extends / implements /
   * references), so the paint layer colours per relationship type and the toggles filter by it.
   * @deprecated Read `relationKind` through `relationKindOf`; retained for serialized/RF parity. */
  depKind?: string;
  /** The far endpoint is a GHOST card (an off-screen definition/caller) — drawn dashed. */
  ghost?: boolean;
  /** The artifact edge ids this wire aggregates — the Wire Inspector resolves them back to real
   * symbol→symbol links and their call sites. Absent on synthetic wires (flow chains, IPC). */
  underlyingEdgeIds?: string[];
  /** The target is a demoted COMMONS hub (see commonsDemotion): hidden at rest, lit like any wire. */
  commons?: boolean;
  /** A direct incoming/outgoing call hop from an explicitly visited ghost-inspection node. */
  ghostInspectionPath?: true;
}

export interface ModuleTree {
  nodes: VisibleModuleNode[];
  edges: ModuleTreeEdge[];
  effectiveFocus: string | null;
}
