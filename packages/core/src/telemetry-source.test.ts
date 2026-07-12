import { describe, expect, it } from "vitest";
import {
  expectedTelemetryProducerKind,
  telemetryEnvironmentSchema,
  telemetrySourceAllowsEnvironment,
  telemetrySourceDescriptorSchema,
} from "./telemetry-source";

describe("telemetry source descriptor contract", () => {
  it("canonicalizes bounded environment coordinates once for overlays, traces, and sources", () => {
    expect(telemetryEnvironmentSchema.parse(" staging ")).toBe("staging");
    expect(telemetryEnvironmentSchema.safeParse("x".repeat(257)).success).toBe(false);
  });

  it("accepts the three supported source/provenance pairs", () => {
    expect(parse({ kind: "mock", provenance: "synthetic" }).success).toBe(true);
    expect(parse({ kind: "file", provenance: "saved" }).success).toBe(true);
    expect(parse({ kind: "tempo", provenance: "observed" }).success).toBe(true);
  });

  it("rejects provenance that contradicts the source kind", () => {
    expect(parse({ kind: "mock", provenance: "observed" }).success).toBe(false);
    expect(parse({ kind: "file", provenance: "synthetic" }).success).toBe(false);
  });

  it("keeps advertised environments separate from an arbitrary-environment policy", () => {
    const enumerated = telemetrySourceDescriptorSchema.parse(descriptor());
    const arbitrary = telemetrySourceDescriptorSchema.parse(descriptor({ environmentMode: "arbitrary" }));

    expect(telemetrySourceAllowsEnvironment(enumerated, "demo")).toBe(true);
    expect(telemetrySourceAllowsEnvironment(enumerated, "qa-west")).toBe(false);
    expect(telemetrySourceAllowsEnvironment(arbitrary, "qa-west")).toBe(true);
  });

  it("rejects duplicate environment suggestions and distinguishes saved-file producers", () => {
    expect(parse({ environments: ["demo", "demo"] }).success).toBe(false);
    expect(expectedTelemetryProducerKind(telemetrySourceDescriptorSchema.parse(descriptor()))).toBe("mock");
    expect(expectedTelemetryProducerKind(telemetrySourceDescriptorSchema.parse(descriptor({ kind: "file", provenance: "saved" })))).toBeNull();
  });
});

function parse(overrides: Record<string, unknown>) {
  return telemetrySourceDescriptorSchema.safeParse(descriptor(overrides));
}

function descriptor(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "demo",
    kind: "mock",
    label: "Synthetic demo",
    provenance: "synthetic",
    environments: ["demo"],
    supportsMetrics: true,
    supportsTraces: true,
    ...overrides,
  };
}
