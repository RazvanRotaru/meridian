import type { VisibleModuleNode } from "./moduleTree";

type ChildContainerKind = "package" | "file" | "unit" | "block";

export function moduleChildContainerIds(tree: { nodes: readonly VisibleModuleNode[] }, containerId: string | null): string[] {
  const byParent = childrenByParent(tree.nodes);
  return childContainerIdsOf(byParent, containerId);
}

function childContainerIdsOf(byParent: ReadonlyMap<string | null, VisibleModuleNode[]>, containerId: string | null): string[] {
  return (byParent.get(containerId) ?? []).filter(isChildContainer).map((node) => node.id);
}

function childrenByParent(nodes: readonly VisibleModuleNode[]): Map<string | null, VisibleModuleNode[]> {
  const byParent = new Map<string | null, VisibleModuleNode[]>();
  nodes.forEach((node) => {
    const siblings = byParent.get(node.parentId);
    if (siblings) {
      siblings.push(node);
      return;
    }
    byParent.set(node.parentId, [node]);
  });
  return byParent;
}

function isChildContainer(node: VisibleModuleNode): boolean {
  return node.isContainer && isChildContainerKind(node.kind);
}

function isChildContainerKind(kind: VisibleModuleNode["kind"]): kind is ChildContainerKind {
  return kind === "package" || kind === "file" || kind === "unit" || kind === "block";
}
