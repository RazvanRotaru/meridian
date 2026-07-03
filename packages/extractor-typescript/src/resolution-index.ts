/**
 * Lookup tables the edge pass builds once over the finalized descriptors: declaration node
 * -> node id (for edge TARGETS) and body node -> node id (for the enclosing edge SOURCE).
 */

import { nodeKey, type NodeDescriptor } from "./model";

export interface ResolutionIndex {
  targetByDeclKey: Map<string, string>;
  sourceByCallableKey: Map<string, string>;
  nodeIds: Set<string>;
}

export function buildResolutionIndex(descriptors: NodeDescriptor[]): ResolutionIndex {
  const targetByDeclKey = new Map<string, string>();
  const sourceByCallableKey = new Map<string, string>();
  const nodeIds = new Set<string>();
  for (const descriptor of descriptors) {
    nodeIds.add(descriptor.finalId);
    if (descriptor.declarationNode) {
      targetByDeclKey.set(nodeKey(descriptor.declarationNode), descriptor.finalId);
    }
    if (descriptor.callableNode) {
      sourceByCallableKey.set(nodeKey(descriptor.callableNode), descriptor.finalId);
    }
  }
  return { targetByDeclKey, sourceByCallableKey, nodeIds };
}
