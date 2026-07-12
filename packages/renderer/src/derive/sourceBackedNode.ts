/**
 * Whether a graph node's `location.file` names source bytes the server can read. The artifact schema
 * requires a location on every node, including structural and boundary nodes whose "file" is really
 * a directory, package name, protocol, or external module label, so presence alone is not a source
 * capability signal.
 */

import { parseNodeId, type GraphNode } from "@meridian/core";

const SOURCELESS_KINDS: ReadonlySet<string> = new Set([
  "package",
  "system",
  "external",
  "unresolved",
  "channel",
]);

const SOURCELESS_LANGS: ReadonlySet<string> = new Set(["sys", "ext", "unresolved", "ipc"]);

/** Structural/synthetic nodes stay navigable, but must never issue a source-file request. */
export function isSourceBackedNode(node: GraphNode | null | undefined): node is GraphNode {
  if (!node || node.location.file.trim().length === 0) {
    return false;
  }
  return !SOURCELESS_KINDS.has(node.kind) && !SOURCELESS_LANGS.has(parseNodeId(node.id).lang);
}
