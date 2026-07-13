import type { FlowSourceAnchor } from "@meridian/core";
import type { Node } from "ts-morph";

/** Exact portable range for a static flow site. ts-morph exposes 1-based columns; Meridian's
 * source contracts use 0-based columns, matching Istanbul's coverage locations. */
export function flowSource(node: Node, relativeFile: string): FlowSourceAnchor {
  const sourceFile = node.getSourceFile();
  const start = sourceFile.getLineAndColumnAtPos(node.getStart());
  const end = sourceFile.getLineAndColumnAtPos(node.getEnd());
  return {
    file: relativeFile.replace(/\\/g, "/"),
    line: start.line,
    col: start.column - 1,
    endLine: end.line,
    endCol: end.column - 1,
  };
}
