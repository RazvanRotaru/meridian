import { createHash, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createRevisionShardAdmissionReceipt,
  isRevisionShardAdmissionCapability,
  verifyRevisionShardAdmissionReceipt,
  type RevisionShardAdmissionSigner,
  type RevisionShardAdmissionVerifier,
} from "./admission";

const SHARD_KEY = "a".repeat(64);
const BASE_INPUT_KEY = "b".repeat(64);
const PAYLOAD_DIGEST = "c".repeat(64);

describe("cold-oracle shard admission receipts", () => {
  it("authenticates an exact shard payload with a verifier-only capability", () => {
    const { signer, verifier } = authority();
    const receipt = createRevisionShardAdmissionReceipt(signer, {
      shardKey: SHARD_KEY,
      baseInputKey: BASE_INPUT_KEY,
      payloadDigest: PAYLOAD_DIGEST,
    });

    expect(verifyRevisionShardAdmissionReceipt(verifier, receipt, {
      shardKey: SHARD_KEY,
      baseInputKey: BASE_INPUT_KEY,
      payloadDigest: PAYLOAD_DIGEST,
    })).toBe(true);
    expect(receipt).not.toHaveProperty("privateKeyPkcs8");
  });

  it("rejects key rotation and every changed identity field", () => {
    const { signer, verifier } = authority();
    const other = authority();
    const receipt = createRevisionShardAdmissionReceipt(signer, {
      shardKey: SHARD_KEY,
      baseInputKey: BASE_INPUT_KEY,
      payloadDigest: PAYLOAD_DIGEST,
    });

    expect(verifyRevisionShardAdmissionReceipt(other.verifier, receipt, {
      shardKey: SHARD_KEY,
      baseInputKey: BASE_INPUT_KEY,
      payloadDigest: PAYLOAD_DIGEST,
    })).toBe(false);
    for (const [field, value] of [
      ["shardKey", "d".repeat(64)],
      ["baseInputKey", "e".repeat(64)],
      ["payloadDigest", "f".repeat(64)],
    ] as const) {
      expect(verifyRevisionShardAdmissionReceipt(verifier, receipt, {
        shardKey: field === "shardKey" ? value : SHARD_KEY,
        baseInputKey: field === "baseInputKey" ? value : BASE_INPUT_KEY,
        payloadDigest: field === "payloadDigest" ? value : PAYLOAD_DIGEST,
      })).toBe(false);
    }
    expect(verifyRevisionShardAdmissionReceipt(verifier, {
      ...receipt,
      signature: `${receipt.signature.slice(0, -4)}AAAA`,
    }, {
      shardKey: SHARD_KEY,
      baseInputKey: BASE_INPUT_KEY,
      payloadDigest: PAYLOAD_DIGEST,
    })).toBe(false);
  });

  it("strictly rejects mismatched, malformed, and overprivileged capabilities", () => {
    const first = authority();
    const second = authority();
    expect(isRevisionShardAdmissionCapability(first.signer)).toBe(true);
    expect(isRevisionShardAdmissionCapability(first.verifier)).toBe(true);
    expect(isRevisionShardAdmissionCapability({
      ...first.signer,
      publicKeySpki: second.signer.publicKeySpki,
    })).toBe(false);
    expect(isRevisionShardAdmissionCapability({
      ...first.verifier,
      privateKeyPkcs8: first.signer.privateKeyPkcs8,
    })).toBe(false);
    expect(isRevisionShardAdmissionCapability({
      ...first.verifier,
      unexpected: true,
    })).toBe(false);
  });
});

function authority(): {
  signer: RevisionShardAdmissionSigner;
  verifier: RevisionShardAdmissionVerifier;
} {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicDer = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  const keyId = createHash("sha256").update(publicDer).digest("hex");
  return {
    signer: {
      version: 1,
      kind: "signer",
      keyId,
      publicKeySpki: publicDer.toString("base64"),
      privateKeyPkcs8: (privateKey.export({ format: "der", type: "pkcs8" }) as Buffer)
        .toString("base64"),
    },
    verifier: {
      version: 1,
      kind: "verifier",
      keyId,
      publicKeySpki: publicDer.toString("base64"),
    },
  };
}
