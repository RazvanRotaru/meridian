/**
 * Stable addresses for nodes in the rendered Logic flow tree.
 *
 * The graph builder and runtime traversal correlator must speak exactly the same path grammar. Keep
 * that grammar here so telemetry evidence cannot silently detach when one renderer nesting rule is
 * renamed. These helpers build addresses only; they do not inspect flow steps or graph state.
 */

/** The top-level prefix used when one of a container's bodies is charted as an independent flow. */
export function logicTopLevelBodyPrefix(bodyIndex: number): string {
  return `p${bodyIndex}/`;
}

/** Append one step's stable source index to its containing sequence prefix. */
export function logicStepPath(prefix: string, stepIndex: number): string {
  return `${prefix}${stepIndex}`;
}

/** Enter the expanded body of a call occurrence. */
export function logicCallBodyPrefix(callPath: string): string {
  return `${callPath}/`;
}

/** Enter one body of an expanded loop, callback, or try/catch container. */
export function logicControlBodyPrefix(controlPath: string, bodyIndex: number): string {
  return `${controlPath}/p${bodyIndex}/`;
}

/** Enter one conditional branch arm. */
export function logicBranchBodyPrefix(branchPath: string, pathIndex: number): string {
  return `${branchPath}/b${pathIndex}/`;
}

/** Enter the mandatory cleanup phase charted after a try/catch merge. Unlike an alternative
 * branch arm, `finally` is shared by every protected route and therefore has its own stable lane. */
export function logicFinallyBodyPrefix(tryPath: string): string {
  return `${tryPath}/finally/`;
}

/** Resolve a flow-local path into its globally namespaced React Flow node id. */
export function logicNodeId(rootId: string, path: string): string {
  return `${rootId}::${path}`;
}

/** Service frames share the first step's path but live in their own id namespace. */
export function logicServiceFrameId(rootId: string, firstStepPath: string): string {
  return `${rootId}::svc/${firstStepPath}`;
}
