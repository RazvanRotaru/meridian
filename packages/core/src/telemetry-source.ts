/**
 * Serializable telemetry-source metadata shared by the CLI and renderer.
 *
 * `kind` describes how Meridian reaches the source, while `provenance` is the user-facing trust
 * label. Environment suggestions are separate from the acceptance policy so a synthetic provider
 * can advertise useful choices without accidentally rejecting an explicitly requested environment.
 */

import { z } from "zod";

const sourceIdSchema = z.string().trim().min(1).max(256);
const sourceLabelSchema = z.string().trim().min(1).max(512);
export const telemetryEnvironmentSchema = z.string().trim().min(1).max(256);
const environmentsSchema = z.array(telemetryEnvironmentSchema).max(256)
  .refine((environments) => new Set(environments).size === environments.length, "environments must be unique");

const commonSourceFields = {
  id: sourceIdSchema,
  label: sourceLabelSchema,
  environments: environmentsSchema,
  environmentMode: z.enum(["enumerated", "arbitrary"]).optional(),
  supportsMetrics: z.boolean(),
  supportsTraces: z.boolean(),
};

export type TelemetrySourceKind = "mock" | "file" | "tempo";
export type TelemetryProvenance = "synthetic" | "saved" | "observed";

export interface TelemetrySourceDescriptor {
  id: string;
  kind: TelemetrySourceKind;
  label: string;
  provenance: TelemetryProvenance;
  environments: string[];
  environmentMode?: "enumerated" | "arbitrary";
  supportsMetrics: boolean;
  supportsTraces: boolean;
}

export const telemetrySourceDescriptorSchema: z.ZodType<TelemetrySourceDescriptor> = z.discriminatedUnion("kind", [
  z.object({ ...commonSourceFields, kind: z.literal("mock"), provenance: z.literal("synthetic") }),
  z.object({ ...commonSourceFields, kind: z.literal("file"), provenance: z.literal("saved") }),
  z.object({ ...commonSourceFields, kind: z.literal("tempo"), provenance: z.literal("observed") }),
]);

/** Producer kinds carried by aggregate overlays and request-trace bundles. A saved file retains
 * the producer stamped into its payload, so `file` is intentionally not a producer kind. */
export const telemetryProducerKindSchema = z.enum(["mock", "tempo"]);
export type TelemetryProducerKind = z.infer<typeof telemetryProducerKindSchema>;

export function telemetrySourceAllowsEnvironment(
  source: Pick<TelemetrySourceDescriptor, "environmentMode" | "environments">,
  environment: string,
): boolean {
  return source.environmentMode === "arbitrary" || source.environments.includes(environment);
}

/** Returns the producer a direct source must emit. Saved files preserve their embedded producer. */
export function expectedTelemetryProducerKind(
  source: Pick<TelemetrySourceDescriptor, "kind">,
): TelemetryProducerKind | null {
  return source.kind === "file" ? null : source.kind;
}
