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

  it("preserves a valid __proto__ Git filename as an own file fingerprint", () => {
    const result = reviewFingerprintsFromArtifact({ extensions: {
      reviewFingerprints: {
        version: 1,
        algorithm: "sha256-source-bytes",
        complete: true,
        units: {},
        files: Object.fromEntries([
          ["__proto__", { address: "file:v1\0__proto__", digest }],
        ]),
      },
    } });

    expect(result).not.toBeNull();
    expect(Object.hasOwn(result!.files, "__proto__")).toBe(true);
    expect(result!.files["__proto__"]?.address).toBe("file:v1\0__proto__");
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
