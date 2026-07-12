import { telemetryEnvironmentSchema } from "@meridian/core";
import { CliError, EXIT } from "./errors";

/** Canonical CLI boundary for the source/overlay/trace environment coordinate. */
export function normalizeTelemetryEnvironment(value: string): string {
  const parsed = telemetryEnvironmentSchema.safeParse(value);
  if (!parsed.success) {
    throw new CliError(
      EXIT.usage,
      "--env must be a non-empty environment name of at most 256 characters",
    );
  }
  return parsed.data;
}
