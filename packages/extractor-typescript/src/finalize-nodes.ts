/**
 * Ordinal disambiguation + final GraphNode materialization. Sibling declarations that
 * collide on a base id (overload signature+impl, declaration merging, same-name locals) are
 * ordered by (startLine, startCol); the first keeps the bare id, the rest gain `~n`.
 */

import { buildNodeId } from "@meridian/core";
import type { GraphNode } from "@meridian/core";
import { baseIdOf } from "./descriptor-factory";
import type { NodeDescriptor } from "./model";

export function assignFinalIds(descriptors: NodeDescriptor[]): void {
  for (const group of collisionGroups(descriptors).values()) {
    assignOrdinals(group);
  }
}

function collisionGroups(descriptors: NodeDescriptor[]): Map<string, NodeDescriptor[]> {
  const groups = new Map<string, NodeDescriptor[]>();
  for (const descriptor of descriptors) {
    const baseId = baseIdOf(descriptor);
    const group = groups.get(baseId);
    if (group) {
      group.push(descriptor);
    } else {
      groups.set(baseId, [descriptor]);
    }
  }
  return groups;
}

function assignOrdinals(group: NodeDescriptor[]): void {
  [...group].sort(byStartPosition).forEach((descriptor, ordinal) => {
    descriptor.finalId = buildNodeId({ ...descriptor.idParts, ordinal });
  });
}

function byStartPosition(left: NodeDescriptor, right: NodeDescriptor): number {
  const lineDelta = left.location.startLine - right.location.startLine;
  return lineDelta !== 0 ? lineDelta : left.startCol - right.startCol;
}

export function buildGraphNodes(descriptors: NodeDescriptor[]): GraphNode[] {
  return descriptors.map(toGraphNode);
}

function toGraphNode(descriptor: NodeDescriptor): GraphNode {
  const node: GraphNode = {
    id: descriptor.finalId,
    kind: descriptor.kind,
    qualifiedName: descriptor.qualifiedName,
    displayName: descriptor.displayName,
    summary: descriptor.summary,
    parentId: descriptor.parent ? descriptor.parent.finalId : null,
    location: descriptor.location,
  };
  if (descriptor.signature) node.signature = descriptor.signature;
  if (descriptor.tags.length > 0) node.tags = descriptor.tags;
  if (descriptor.telemetry) node.telemetry = descriptor.telemetry;
  return node;
}
