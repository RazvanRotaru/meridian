/**
 * Runtime-neutral protocol shared by the standalone mock-telemetry parent and child.
 *
 * Keep this module valid JavaScript: source workers can load it directly without installing a
 * TypeScript loader in every short-lived child process. The adjacent declaration file supplies
 * the compile-time contract to the TypeScript callers.
 */

export const MAX_STANDALONE_MOCK_RESPONSE_BYTES = 16 * 1024 * 1024;

/** @param {unknown} value */
export function isStandaloneMockWorkerRequest(value) {
  if (!isRecord(value) || Object.keys(value).length !== 5) return false;
  return value.type === "render"
    && (value.kind === "overlay" || value.kind === "traces")
    && typeof value.artifactPath === "string" && value.artifactPath.length > 0
    && typeof value.outputPath === "string" && value.outputPath.length > 0
    && typeof value.environment === "string" && value.environment.trim().length > 0
    && Buffer.byteLength(value.environment, "utf8") <= 1_024;
}

/** @param {unknown} value */
export function isStandaloneMockWorkerResponse(value) {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (value.type === "result") {
    return Object.keys(value).length === 3
      && typeof value.outputPath === "string"
      && Number.isSafeInteger(value.bytes);
  }
  return value.type === "error"
    && Object.keys(value).length === 2
    && (value.reason === "invalid-request"
      || value.reason === "invalid-artifact"
      || value.reason === "too-large"
      || value.reason === "internal");
}

/** @param {unknown} value */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
