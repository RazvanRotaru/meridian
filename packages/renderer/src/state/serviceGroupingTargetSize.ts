/**
 * Reader-selectable target sizes for balanced Service partitions.
 *
 * Keeping this a small, explicit set makes shared URLs stable and prevents a hand-edited query
 * from asking the partitioner for pathological one-node or whole-repository groups.
 */
export const SERVICE_GROUPING_TARGET_SIZES = [6, 8, 12, 16, 24, 32] as const;

export type ServiceGroupingTargetSize = (typeof SERVICE_GROUPING_TARGET_SIZES)[number];

export const DEFAULT_SERVICE_GROUPING_TARGET_SIZE: ServiceGroupingTargetSize = 12;

export function isServiceGroupingTargetSize(value: number): value is ServiceGroupingTargetSize {
  return SERVICE_GROUPING_TARGET_SIZES.some((option) => option === value);
}
