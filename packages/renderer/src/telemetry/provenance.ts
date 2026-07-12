import type {
  TelemetryProvenance,
  TelemetrySourceDescriptor,
  TraceBundle,
} from "@meridian/core";

/** Resolve the reader-facing trust label from the selected source contract. The payload's producer
 * is only a compatibility fallback: a saved snapshot may contain Tempo-produced data, but must
 * still be presented as saved rather than live observed telemetry. */
export function telemetryProvenance(
  sources: readonly TelemetrySourceDescriptor[],
  sourceId: string | null,
  producer: TraceBundle["source"] | null,
): TelemetryProvenance | null {
  const selected = sourceId === null ? null : sources.find((source) => source.id === sourceId) ?? null;
  if (selected !== null) return selected.provenance;
  if (producer === "mock") return "synthetic";
  if (producer === "tempo") return "observed";
  return null;
}

export function telemetryProvenanceLabel(provenance: TelemetryProvenance | null): string {
  if (provenance === "synthetic") return "SYNTHETIC DEMO";
  if (provenance === "observed") return "OBSERVED REQUEST";
  if (provenance === "saved") return "SAVED SNAPSHOT";
  return "REQUEST TRACE";
}
