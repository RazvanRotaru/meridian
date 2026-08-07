/**
 * One-hop source neighbours for the ordinary full-source reader. The rail deliberately describes
 * only the currently loaded graph: progressive projections can know about additional files without
 * having their nodes or relationships resident yet. It owns neither the source window nor its close
 * lifecycle; selecting a row replaces the source inside the existing full-source host.
 */

import { ArrowLeftIcon, ArrowRightIcon } from "@radix-ui/react-icons";
import { useEffect, useRef } from "react";
import type { GraphEdge, GraphNode } from "@meridian/core";
import { isSourceBackedNode } from "../../derive/sourceBackedNode";
import type { GraphIndex } from "../../graph/graphIndex";
import { useBlueprint, useBlueprintActions } from "../../state/StoreContext";
import { relationColor } from "../../theme/relationTheme";
import { MONO } from "../nodes/modulemap/frameChrome";
import { FLOATING_SOURCE_WINDOW_ID } from "./FloatingSourceWindow";

export type RelatedCodeDirection = "incoming" | "outgoing";

export interface RelatedCodeNeighbor {
  direction: RelatedCodeDirection;
  relation: GraphEdge["kind"];
  node: GraphNode;
  /** Every exact artifact edge represented by this deduplicated row, in stable id order. */
  edgeIds: readonly string[];
}

export interface RelatedCodeGroup {
  relation: GraphEdge["kind"];
  neighbors: readonly RelatedCodeNeighbor[];
}

/**
 * Derive direct, source-openable neighbours from the resident graph. Parallel edges collapse only
 * when relation, direction, and endpoint all agree; opposite directions and distinct relationship
 * kinds remain separate facts.
 */
export function deriveRelatedCodeGroups(
  index: Pick<GraphIndex, "inEdges" | "outEdges" | "nodesById">,
  currentNode: GraphNode,
  canOpenSource: (node: GraphNode) => boolean = () => true,
): RelatedCodeGroup[] {
  const deduplicated = new Map<string, {
    direction: RelatedCodeDirection;
    relation: GraphEdge["kind"];
    node: GraphNode;
    edgeIds: Set<string>;
  }>();

  const collect = (
    edges: readonly GraphEdge[],
    direction: RelatedCodeDirection,
  ) => {
    for (const edge of edges) {
      const expectedCurrentId = direction === "incoming" ? edge.target : edge.source;
      if (expectedCurrentId !== currentNode.id) continue;
      const neighborId = direction === "incoming" ? edge.source : edge.target;
      if (neighborId === currentNode.id) continue;
      const node = index.nodesById.get(neighborId);
      if (!isSourceBackedNode(node) || !canOpenSource(node)) continue;

      const key = `${edge.kind}\u0000${direction}\u0000${neighborId}`;
      const existing = deduplicated.get(key);
      if (existing) {
        existing.edgeIds.add(edge.id);
      } else {
        deduplicated.set(key, {
          direction,
          relation: edge.kind,
          node,
          edgeIds: new Set([edge.id]),
        });
      }
    }
  };

  collect(index.inEdges.get(currentNode.id) ?? [], "incoming");
  collect(index.outEdges.get(currentNode.id) ?? [], "outgoing");

  const byRelation = new Map<GraphEdge["kind"], RelatedCodeNeighbor[]>();
  for (const entry of deduplicated.values()) {
    const neighbor: RelatedCodeNeighbor = {
      direction: entry.direction,
      relation: entry.relation,
      node: entry.node,
      edgeIds: [...entry.edgeIds].sort((left, right) => left.localeCompare(right)),
    };
    const group = byRelation.get(entry.relation);
    group ? group.push(neighbor) : byRelation.set(entry.relation, [neighbor]);
  }

  return [...byRelation]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([relation, neighbors]) => ({
      relation,
      neighbors: neighbors.sort(compareRelatedCodeNeighbors),
    }));
}

export function RelatedCodeRail({ currentNode }: { currentNode: GraphNode }) {
  const index = useBlueprint((state) => state.index);
  const composerConfirmDiscard = useBlueprint(
    (state) => state.reviewLineComposer?.confirmDiscard ?? false,
  );
  const { canShowCode, showCode } = useBlueprintActions();
  const groups = deriveRelatedCodeGroups(index, currentNode, canShowCode);
  const previousNodeIdRef = useRef(currentNode.id);
  const focusSourceAfterNavigationRef = useRef(false);
  useEffect(() => {
    const changed = previousNodeIdRef.current !== currentNode.id;
    previousNodeIdRef.current = currentNode.id;
    if (!changed || !focusSourceAfterNavigationRef.current || typeof window === "undefined") return;
    focusSourceAfterNavigationRef.current = false;
    const frame = window.requestAnimationFrame(() => {
      document.getElementById(FLOATING_SOURCE_WINDOW_ID)
        ?.querySelector<HTMLElement>('[data-source-window-title="true"]')
        ?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [currentNode.id]);
  useEffect(() => {
    if (composerConfirmDiscard || !focusSourceAfterNavigationRef.current) return;
    // Keep editing cancels a guarded related-source activation. Drop its pending focus handoff so
    // an unrelated later source change cannot unexpectedly pull focus away from the retained row.
    const frame = window.requestAnimationFrame(() => {
      if (previousNodeIdRef.current === currentNode.id) {
        focusSourceAfterNavigationRef.current = false;
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [composerConfirmDiscard, currentNode.id]);

  return (
    <div
      data-related-code-rail="true"
      style={RAIL_STYLE}
    >
      <header style={HEADER_STYLE}>
        <span style={TITLE_STYLE}>Related in loaded graph</span>
        <span style={COUNT_STYLE}>{groups.reduce((total, group) => total + group.neighbors.length, 0)}</span>
      </header>
      {groups.length === 0 ? (
        <div role="status" data-related-code-empty="true" style={EMPTY_STYLE}>
          No related code in the loaded graph.
        </div>
      ) : (
        <div style={GROUPS_STYLE}>
          {groups.map((group) => (
            <section
              key={group.relation}
              aria-label={`${group.relation} relationships`}
              data-related-code-relation={group.relation}
              style={GROUP_STYLE}
            >
              <h3 style={GROUP_HEADER_STYLE}>
                <span
                  aria-hidden="true"
                  style={{
                    ...RELATION_DOT_STYLE,
                    background: relationColor(group.relation) ?? "#8B95A3",
                  }}
                />
                <span>{group.relation}</span>
              </h3>
              <div style={ROWS_STYLE}>
                {group.neighbors.map((neighbor) => (
                  <button
                    key={`${neighbor.direction}:${neighbor.node.id}`}
                    type="button"
                    aria-label={relatedCodeOpenLabel(neighbor)}
                    title={relatedCodeOpenLabel(neighbor)}
                    data-related-code-direction={neighbor.direction}
                    data-related-code-node-id={neighbor.node.id}
                    data-related-code-edge-count={neighbor.edgeIds.length}
                    style={ROW_STYLE}
                    onClick={() => {
                      focusSourceAfterNavigationRef.current = true;
                      void showCode(neighbor.node, { mode: "modal" });
                    }}
                  >
                    <span style={DIRECTION_STYLE} title={neighbor.direction}>
                      {neighbor.direction === "incoming"
                        ? <ArrowLeftIcon aria-hidden="true" />
                        : <ArrowRightIcon aria-hidden="true" />}
                    </span>
                    <span style={ROW_TEXT_STYLE}>
                      <span style={ROW_NAME_STYLE}>{neighbor.node.displayName}</span>
                      <span style={ROW_LOCATION_STYLE}>{relatedCodeLocation(neighbor.node)}</span>
                    </span>
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function compareRelatedCodeNeighbors(left: RelatedCodeNeighbor, right: RelatedCodeNeighbor): number {
  const direction = directionRank(left.direction) - directionRank(right.direction);
  if (direction !== 0) return direction;
  return left.node.displayName.localeCompare(right.node.displayName)
    || left.node.qualifiedName.localeCompare(right.node.qualifiedName)
    || left.node.id.localeCompare(right.node.id);
}

function directionRank(direction: RelatedCodeDirection): number {
  return direction === "incoming" ? 0 : 1;
}

function relatedCodeLocation(node: GraphNode): string {
  const line = node.location.startLine;
  return `${node.location.file}:${line}`;
}

function relatedCodeOpenLabel(neighbor: RelatedCodeNeighbor): string {
  return `Open ${neighbor.node.displayName}, ${neighbor.direction} ${neighbor.relation}, in source`;
}

const RAIL_STYLE: React.CSSProperties = {
  minWidth: 0,
  height: "100%",
  boxSizing: "border-box",
  overflowX: "hidden",
  overflowY: "auto",
  overscrollBehavior: "contain",
  color: "#C9D1D9",
  fontFamily: MONO,
};

const HEADER_STYLE: React.CSSProperties = {
  position: "sticky",
  top: 0,
  zIndex: 1,
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
  padding: "10px 12px",
  borderBottom: "1px solid #30363d",
  background: "rgba(22, 27, 34, 0.98)",
};

const TITLE_STYLE: React.CSSProperties = {
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  color: "#E6EDF3",
  fontSize: 11.5,
  fontWeight: 700,
};

const COUNT_STYLE: React.CSSProperties = {
  flexShrink: 0,
  minWidth: 18,
  padding: "1px 5px",
  borderRadius: 999,
  background: "#1A212B",
  color: "#8B95A3",
  fontSize: 9.5,
  textAlign: "center",
};

const GROUPS_STYLE: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 12,
  padding: "10px 12px 12px",
};

const GROUP_STYLE: React.CSSProperties = { minWidth: 0 };

const GROUP_HEADER_STYLE: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  margin: 0,
  color: "#C9D1D9",
  fontSize: 10.5,
  fontWeight: 700,
};

const RELATION_DOT_STYLE: React.CSSProperties = {
  width: 7,
  height: 7,
  flexShrink: 0,
  borderRadius: "50%",
};

const ROWS_STYLE: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 5,
  marginTop: 7,
};

const ROW_STYLE: React.CSSProperties = {
  width: "100%",
  minWidth: 0,
  display: "flex",
  alignItems: "flex-start",
  gap: 7,
  padding: "7px 8px",
  border: "1px solid #262D38",
  borderRadius: 6,
  background: "#111821",
  color: "inherit",
  font: "inherit",
  textAlign: "left",
  cursor: "pointer",
};

const DIRECTION_STYLE: React.CSSProperties = {
  width: 14,
  height: 16,
  flex: "0 0 14px",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  color: "#7DD3FC",
};

const ROW_TEXT_STYLE: React.CSSProperties = {
  minWidth: 0,
  display: "flex",
  flex: 1,
  flexDirection: "column",
  gap: 2,
};

const ROW_NAME_STYLE: React.CSSProperties = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  color: "#D8E4F0",
  fontSize: 10.5,
  fontWeight: 600,
};

const ROW_LOCATION_STYLE: React.CSSProperties = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  color: "#7B8695",
  fontSize: 9,
};

const EMPTY_STYLE: React.CSSProperties = {
  margin: 12,
  padding: "12px 10px",
  border: "1px dashed #30363d",
  borderRadius: 6,
  color: "#7B8695",
  fontSize: 10.5,
  lineHeight: 1.4,
  textAlign: "center",
};
