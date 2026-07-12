/**
 * Lookup tables the edge pass builds once over the finalized descriptors: declaration node
 * -> node id (for edge TARGETS), body node -> node id (for behavioural edge SOURCES), and
 * semantic declaration node -> node id (for type-reference SOURCES).
 */

import { externalSpecifierMatcher, type ExternalSpecifierMatcher } from "./external-specifier";
import { nodeKey, type NodeDescriptor } from "./model";

export interface ResolutionIndex {
  targetByDeclKey: Map<string, string>;
  sourceByCallableKey: Map<string, string>;
  sourceBySemanticDeclKey: Map<string, string>;
  nodeIds: Set<string>;
  /** Absolute paths selected into this extraction. Import-based external fallback uses this to
   * distinguish an out-of-scope alias target from an in-project symbol we simply do not emit. */
  sourceFilePaths: ReadonlySet<string>;
  isExternalSpecifier: ExternalSpecifierMatcher;
}

export function buildResolutionIndex(
  descriptors: NodeDescriptor[],
  moduleByFilePath: ReadonlyMap<string, NodeDescriptor>,
  root: string,
): ResolutionIndex {
  const targetByDeclKey = new Map<string, string>();
  const sourceByCallableKey = new Map<string, string>();
  const sourceBySemanticDeclKey = new Map<string, string>();
  const nodeIds = new Set<string>();
  for (const descriptor of descriptors) {
    nodeIds.add(descriptor.finalId);
    if (descriptor.declarationNode) {
      const key = nodeKey(descriptor.declarationNode);
      targetByDeclKey.set(key, descriptor.finalId);
      // Unlike calls/renders, a type reference can live in a declaration's signature rather
      // than its body. Keeping this separate from sourceByCallableKey preserves the existing
      // body-only behavioural semantics while letting the reference pass find the nearest
      // emitted callable or container declaration. Modules/packages have no declaration node,
      // so genuinely top-level references still fall back to their module.
      sourceBySemanticDeclKey.set(key, descriptor.finalId);
    }
    if (descriptor.callableNode) {
      sourceByCallableKey.set(nodeKey(descriptor.callableNode), descriptor.finalId);
    }
  }
  return {
    targetByDeclKey,
    sourceByCallableKey,
    sourceBySemanticDeclKey,
    nodeIds,
    sourceFilePaths: new Set(moduleByFilePath.keys()),
    isExternalSpecifier: externalSpecifierMatcher(root),
  };
}
