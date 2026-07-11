import type { Node } from "@xyflow/react";

/**
 * Expose the fixed numeric dimensions carried in a node's style to React Flow's user-node model.
 * React Flow recognises measured, top-level, or initial dimensions, but its MiniMap does not use
 * `style.width` / `style.height`. Keep the style as the rendering source and fill only dimensions
 * that React Flow cannot already resolve.
 */
export function withReactFlowDimensions(nodes: Node[]): Node[] {
  let promoted: Node[] | null = null;

  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    const next = withNodeDimensions(node);
    if (next === node) {
      continue;
    }
    promoted ??= [...nodes];
    promoted[index] = next;
  }

  return promoted ?? nodes;
}

function withNodeDimensions(node: Node): Node {
  const hasWidth = resolvedWidth(node) !== undefined;
  const hasHeight = resolvedHeight(node) !== undefined;
  if (hasWidth && hasHeight) {
    return node;
  }

  const styleWidth = node.style?.width;
  const styleHeight = node.style?.height;
  const promotedWidth = !hasWidth && isFiniteNumber(styleWidth) ? styleWidth : undefined;
  const promotedHeight = !hasHeight && isFiniteNumber(styleHeight) ? styleHeight : undefined;
  // A partial result still fails React Flow's dimension guard, so promote only when the existing
  // and style-backed axes combine into a complete pair.
  if ((!hasWidth && promotedWidth === undefined) || (!hasHeight && promotedHeight === undefined)) {
    return node;
  }

  return {
    ...node,
    ...(promotedWidth !== undefined ? { width: promotedWidth } : {}),
    ...(promotedHeight !== undefined ? { height: promotedHeight } : {}),
  };
}

function resolvedWidth(node: Node): number | undefined {
  return node.measured?.width ?? node.width ?? node.initialWidth;
}

function resolvedHeight(node: Node): number | undefined {
  return node.measured?.height ?? node.height ?? node.initialHeight;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
