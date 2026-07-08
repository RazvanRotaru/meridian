import type { ModuleTree, VisibleModuleNode } from "./moduleTree";

type ChildContainerKind = "package" | "file";

export function moduleChildContainerIds(tree: ModuleTree, containerId: string | null): string[] {
  return tree.nodes.filter((node) => isDirectChildContainer(node, containerId)).map((node) => node.id);
}

function isDirectChildContainer(node: VisibleModuleNode, containerId: string | null): boolean {
  return node.parentId === containerId && node.isContainer && isChildContainerKind(node.kind);
}

function isChildContainerKind(kind: VisibleModuleNode["kind"]): kind is ChildContainerKind {
  return kind === "package" || kind === "file";
}
