/**
 * One-request child entry for full-artifact mock overlay/trace derivation.
 *
 * This entry deliberately has no runtime imports from CLI TypeScript modules. Newer Node runtimes
 * can therefore execute the source with native type stripping; older supported runtimes use the
 * tsx loader. Packaged execution always uses the bundled JavaScript entry.
 */

import { readFile, writeFile } from "node:fs/promises";
import { buildMockOverlay, buildMockTraceBundle } from "@meridian/core/mock";
import { telemetryEnvironmentSchema, validateArtifact } from "@meridian/core";
import {
  isStandaloneMockWorkerRequest,
  MAX_STANDALONE_MOCK_RESPONSE_BYTES,
  type StandaloneMockWorkerResponse,
} from "./standalone-view-mock-worker-protocol.js";

let finished = false;

if (typeof process.send !== "function") {
  process.exitCode = 1;
} else {
  process.once("message", (value: unknown) => {
    void handle(value);
  });
  process.once("disconnect", () => {
    if (!finished) process.exit(1);
  });
}

async function handle(value: unknown): Promise<void> {
  if (!isStandaloneMockWorkerRequest(value)) {
    reply({ type: "error", reason: "invalid-request" });
    return;
  }
  const environment = telemetryEnvironmentSchema.safeParse(value.environment);
  if (!environment.success) {
    reply({ type: "error", reason: "invalid-request" });
    return;
  }
  const artifact = await readArtifact(value.artifactPath);
  if (!artifact) {
    reply({ type: "error", reason: "invalid-artifact" });
    return;
  }
  try {
    const body = value.kind === "overlay"
      ? buildMockOverlay(artifact, environment.data)
      : buildMockTraceBundle(artifact, environment.data);
    const serialized = JSON.stringify(body);
    const bytes = Buffer.byteLength(serialized);
    if (bytes < 1 || bytes > MAX_STANDALONE_MOCK_RESPONSE_BYTES) {
      reply({ type: "error", reason: "too-large" });
      return;
    }
    await writeFile(value.outputPath, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
    reply({ type: "result", outputPath: value.outputPath, bytes });
  } catch {
    reply({ type: "error", reason: "internal" });
  }
}

async function readArtifact(path: string) {
  try {
    const validation = validateArtifact(JSON.parse(await readFile(path, "utf8")));
    return validation.ok ? validation.artifact : undefined;
  } catch {
    return undefined;
  }
}

function reply(message: StandaloneMockWorkerResponse): void {
  if (finished || typeof process.send !== "function" || !process.connected) {
    process.exitCode = 1;
    return;
  }
  process.send(message, (error) => {
    finished = true;
    process.exitCode = error ? 1 : 0;
    if (process.connected) process.disconnect?.();
  });
}
