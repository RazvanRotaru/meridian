import { describe, expect, it } from "vitest";
import { CliError, EXIT } from "./errors";
import { normalizeTelemetryEnvironment } from "./telemetry-environment";

describe("normalizeTelemetryEnvironment", () => {
  it("trims the shared environment coordinate", () => {
    expect(normalizeTelemetryEnvironment(" qa-west ")).toBe("qa-west");
  });

  it("rejects empty and oversized coordinates as CLI usage errors", () => {
    for (const value of ["   ", "x".repeat(257)]) {
      try {
        normalizeTelemetryEnvironment(value);
        throw new Error("expected validation failure");
      } catch (error) {
        expect(error).toBeInstanceOf(CliError);
        expect((error as CliError).exitCode).toBe(EXIT.usage);
      }
    }
  });
});
