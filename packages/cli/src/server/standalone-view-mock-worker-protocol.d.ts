export const MAX_STANDALONE_MOCK_RESPONSE_BYTES: number;

export type StandaloneMockTelemetryKind = "overlay" | "traces";

export interface StandaloneMockWorkerRequest {
  type: "render";
  kind: StandaloneMockTelemetryKind;
  artifactPath: string;
  outputPath: string;
  environment: string;
}

export type StandaloneMockWorkerResponse =
  | { type: "result"; outputPath: string; bytes: number }
  | { type: "error"; reason: "invalid-request" | "invalid-artifact" | "too-large" | "internal" };

export function isStandaloneMockWorkerRequest(value: unknown): value is StandaloneMockWorkerRequest;
export function isStandaloneMockWorkerResponse(value: unknown): value is StandaloneMockWorkerResponse;
