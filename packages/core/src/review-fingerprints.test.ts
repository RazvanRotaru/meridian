import { describe, expect, it } from "vitest";
import { reviewFingerprintsFromArtifact } from "./review-fingerprints";
import type { GraphArtifact } from "./types";

const digest = "a".repeat(64);

describe("reviewFingerprintsFromArtifact", () => {
  it("accepts the strict versioned contract", () => {
    expect(reviewFingerprintsFromArtifact({ extensions: {
      reviewFingerprints: {
        version: 1,
        algorithm: "sha256-source-bytes",
        complete: true,
        units: { A: { address: "unit:v1\0a.ts\0function\0run", digest } },
        files: { "a.ts": { address: "file:v1\0a.ts", digest } },
      },
    } })).toMatchObject({ version: 1, complete: true });
  });

  it("rejects duplicate semantic addresses, unknown fields, and invalid digests", () => {
    const extension = (units: Record<string, unknown>): Pick<GraphArtifact, "extensions"> => ({ extensions: {
      reviewFingerprints: {
        version: 1,
        algorithm: "sha256-source-bytes",
        complete: false,
        units: units as never,
        files: {},
      },
    } });
    expect(reviewFingerprintsFromArtifact(extension({
      A: { address: "same", digest },
      B: { address: "same", digest },
    }))).toBeNull();
    expect(reviewFingerprintsFromArtifact(extension({ A: { address: "a", digest, extra: true } }))).toBeNull();
    expect(reviewFingerprintsFromArtifact(extension({ A: { address: "a", digest: "bad" } }))).toBeNull();
  });
});
