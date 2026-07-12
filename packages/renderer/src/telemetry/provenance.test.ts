import { describe, expect, it } from "vitest";
import type { TelemetrySourceDescriptor } from "@meridian/core";
import { telemetryProvenance, telemetryProvenanceLabel } from "./provenance";

const SAVED: TelemetrySourceDescriptor = {
  id: "snapshot",
  kind: "file",
  label: "Snapshot",
  provenance: "saved",
  environments: ["prod"],
  supportsMetrics: true,
  supportsTraces: true,
};

describe("telemetry provenance presentation", () => {
  it("uses the selected source trust level instead of upgrading a saved Tempo payload to live observed", () => {
    expect(telemetryProvenance([SAVED], SAVED.id, "tempo")).toBe("saved");
    expect(telemetryProvenanceLabel(telemetryProvenance([SAVED], SAVED.id, "tempo"))).toBe("SAVED SNAPSHOT");
  });

  it("falls back to producer provenance for legacy sessions without a source catalog", () => {
    expect(telemetryProvenanceLabel(telemetryProvenance([], null, "mock"))).toBe("SYNTHETIC DEMO");
    expect(telemetryProvenanceLabel(telemetryProvenance([], null, "tempo"))).toBe("OBSERVED REQUEST");
  });
});
