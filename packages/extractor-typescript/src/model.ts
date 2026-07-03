/**
 * Internal structural model. A `NodeDescriptor` is a still-mutable staging record produced
 * by the structural pass: it keeps a reference to its parent descriptor (so parent ids can
 * be resolved after ordinal disambiguation) and to the ts-morph nodes that back it (so the
 * edge pass can resolve call targets and enclosing callers).
 */

import type { Node } from "ts-morph";
import type { NodeKind, SourceLocation, TelemetryKey } from "@meridian/core";

export interface NodeIdParts {
  lang: string;
  modulePath: string;
  qualname?: string;
}

export interface NodeDescriptor {
  kind: NodeKind;
  idParts: NodeIdParts;
  displayName: string;
  qualifiedName: string;
  summary: string | null;
  signature: string | null;
  tags: string[];
  telemetry: TelemetryKey | null;
  location: SourceLocation;
  startCol: number;
  parent: NodeDescriptor | null;
  /** The declaration ts-morph node, used to resolve edge TARGETS. Null for packages. */
  declarationNode: Node | null;
  /** The body-bearing ts-morph node, used to resolve enclosing edge SOURCES. */
  callableNode: Node | null;
  finalId: string;
}

/** A stable key for a ts-morph node: same file plus start offset is unique within a project. */
export function nodeKey(node: Node): string {
  return `${node.getSourceFile().getFilePath()}#${node.getStart()}`;
}

export function lineColOf(node: Node): { line: number; column: number } {
  return node.getSourceFile().getLineAndColumnAtPos(node.getStart());
}
