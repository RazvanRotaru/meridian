import type { FlowSourceAnchor } from "@meridian/core";
import type { Node } from "ts-morph";

/** A portable POC source anchor for static FlowSteps. The owning flow supplies the module identity;
 * a production probe manifest should replace this basename/line fallback with a generated site id,
 * project-relative path, and column. */
export function flowSource(node: Node): FlowSourceAnchor {
  return {
    file: node.getSourceFile().getBaseName(),
    line: node.getStartLineNumber(),
  };
}
