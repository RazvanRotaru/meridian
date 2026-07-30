import { DEPTH_RANK, rankOfKind, type ExtractionDepth } from "@meridian/core";
import type { NodeDescriptor } from "./model";

/** Which unit descriptors survive the global depth collapse. */
export function survivorIdsAtDepth(
  descriptors: NodeDescriptor[],
  depth: ExtractionDepth,
): Set<string> {
  const maxRank = DEPTH_RANK[depth];
  return new Set(
    descriptors
      .filter((descriptor) => rankOfKind(descriptor.kind) <= maxRank)
      .map((descriptor) => descriptor.finalId),
  );
}
