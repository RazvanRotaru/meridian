import type { FlowBlockSegment, FlowSelectionRef } from "../../derive/flowBlocks";

export function sameFlowSelection(a: FlowSelectionRef | null, b: FlowSelectionRef | null): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return a.rootId === b.rootId && sameBlockPath(a.blockPath, b.blockPath);
}

export function selectionKey(ref: FlowSelectionRef | null): string {
  if (ref === null) {
    return "none";
  }
  const path = ref.blockPath.map((segment) =>
    segment.path === undefined ? String(segment.step) : `${segment.step}-${segment.path}`,
  );
  return `${encodeURIComponent(ref.rootId)}@${path.join(".")}`;
}

export function childSelection(
  rootId: string,
  blockPath: readonly FlowBlockSegment[],
  segment: FlowBlockSegment,
): FlowSelectionRef {
  return { rootId, blockPath: [...blockPath, segment] };
}

export function ancestorSelection(ref: FlowSelectionRef, depth: number): FlowSelectionRef {
  return { rootId: ref.rootId, blockPath: ref.blockPath.slice(0, depth) };
}

function sameBlockPath(a: readonly FlowBlockSegment[], b: readonly FlowBlockSegment[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return a.every((segment, index) => segment.step === b[index].step && segment.path === b[index].path);
}
