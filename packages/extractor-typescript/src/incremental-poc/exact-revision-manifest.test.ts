import { createHash, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildRevisionRequestFingerprintV1,
  createRevisionManifestAdmissionReceipt,
  verifyRevisionManifestAdmissionReceipt,
  type RevisionManifestAdmissionInputs,
  type RevisionRequestFingerprintInputV1,
} from "./exact-revision-manifest";
import {
  POC_MANIFEST_VERSION,
  POC_SHARD_VERSION,
  type AnalysisPolicyFingerprint,
  type ExtractorProvenance,
} from "./model";
import type {
  RevisionShardAdmissionSigner,
  RevisionShardAdmissionVerifier,
} from "./admission";

const TREE_OID = "a".repeat(40);
const WORKSPACE_DIGEST = "b".repeat(64);

describe("exact revision request fingerprints", () => {
  it("is deterministic and canonicalizes supplemental file order and duplicates", () => {
    const first = buildRevisionRequestFingerprintV1(requestInput({
      supplementalFiles: [
        "packages/z/src/index.ts",
        "packages/a/src/index.tsx",
        "packages/z/src/index.ts",
      ],
    }));
    const second = buildRevisionRequestFingerprintV1(requestInput({
      supplementalFiles: [
        "packages/a/src/index.tsx",
        "packages/z/src/index.ts",
      ],
    }));

    expect(first).toEqual(second);
    expect(first.fingerprint.supplementalFiles).toEqual([
      "packages/a/src/index.tsx",
      "packages/z/src/index.ts",
    ]);
    expect(first.requestKey).toMatch(/^[a-f0-9]{64}$/);
  });

  it("changes identity for supplemental, policy, provenance, workspace, tree, and hermetic inputs", () => {
    const base = buildRevisionRequestFingerprintV1(requestInput()).requestKey;
    const changedInputs: RevisionRequestFingerprintInputV1[] = [
      requestInput({ supplementalFiles: ["new/index.ts"] }),
      requestInput({ policy: { ...policy(), valueRefs: true } }),
      requestInput({ provenance: { ...provenance(), extractorVersion: "extractor-2" } }),
      requestInput({ workspaceDigest: "c".repeat(64) }),
      requestInput({ treeOid: "d".repeat(40) }),
      requestInput({ hermeticPolicyVersion: "hermetic-worktree-v2" }),
    ];

    expect(changedInputs.map(
      (input) => buildRevisionRequestFingerprintV1(input).requestKey,
    )).not.toContain(base);
    expect(new Set(changedInputs.map(
      (input) => buildRevisionRequestFingerprintV1(input).requestKey,
    )).size).toBe(changedInputs.length);
  });
});

describe("exact revision manifest admission receipts", () => {
  it("authenticates every bound identity with a verifier-only capability", () => {
    const { signer, verifier } = authority();
    const inputs = admissionInputs();
    const receipt = createRevisionManifestAdmissionReceipt(signer, inputs);

    expect(verifyRevisionManifestAdmissionReceipt(verifier, receipt, inputs)).toBe(true);
    expect(receipt.shardSchemaVersion).toBe(POC_SHARD_VERSION);
    expect(receipt.manifestSchemaVersion).toBe(POC_MANIFEST_VERSION);
    expect(receipt).not.toHaveProperty("privateKeyPkcs8");
  });

  it("rejects signature, identity, exact-key, and canonical-base64 tampering", () => {
    const { signer, verifier } = authority();
    const inputs = admissionInputs();
    const receipt = createRevisionManifestAdmissionReceipt(signer, inputs);
    const changedSignature = `${receipt.signature[0] === "A" ? "B" : "A"}${receipt.signature.slice(1)}`;

    expect(verifyRevisionManifestAdmissionReceipt(verifier, {
      ...receipt,
      signature: changedSignature,
    }, inputs)).toBe(false);
    expect(verifyRevisionManifestAdmissionReceipt(verifier, {
      ...receipt,
      signature: receipt.signature.replace(/=+$/, ""),
    }, inputs)).toBe(false);
    for (const [field, value] of [
      ["requestKey", "5".repeat(64)],
      ["treeOid", "6".repeat(40)],
      ["manifestAddress", "7".repeat(64)],
      ["manifestPayloadDigest", "8".repeat(64)],
      ["normalizedResultDigest", "9".repeat(64)],
    ] as const) {
      expect(verifyRevisionManifestAdmissionReceipt(verifier, {
        ...receipt,
        [field]: value,
      }, {
        ...inputs,
        [field]: value,
      })).toBe(false);
    }
    expect(verifyRevisionManifestAdmissionReceipt(verifier, {
      ...receipt,
      unexpected: true,
    }, inputs)).toBe(false);
    expect(verifyRevisionManifestAdmissionReceipt(verifier, {
      ...receipt,
      manifestAddress: "A".repeat(64),
    }, inputs)).toBe(false);
  });

  it("rejects wrong keys, schema changes, and a mismatched signer keypair", () => {
    const first = authority();
    const second = authority();
    const inputs = admissionInputs();
    const receipt = createRevisionManifestAdmissionReceipt(first.signer, inputs);

    expect(verifyRevisionManifestAdmissionReceipt(second.verifier, receipt, inputs)).toBe(false);
    for (const changed of [
      { ...receipt, version: 2 },
      { ...receipt, shardSchemaVersion: POC_SHARD_VERSION + 1 },
      { ...receipt, manifestSchemaVersion: POC_MANIFEST_VERSION + 1 },
    ]) {
      expect(verifyRevisionManifestAdmissionReceipt(first.verifier, changed, inputs)).toBe(false);
    }

    expect(() => createRevisionManifestAdmissionReceipt({
      ...first.signer,
      privateKeyPkcs8: second.signer.privateKeyPkcs8,
    }, inputs)).toThrow(/keypair does not match/);
  });
});

function requestInput(
  overrides: Partial<RevisionRequestFingerprintInputV1> = {},
): RevisionRequestFingerprintInputV1 {
  return {
    treeOid: TREE_OID,
    supplementalFiles: [],
    policy: policy(),
    provenance: provenance(),
    workspaceDigest: WORKSPACE_DIGEST,
    hermeticPolicyVersion: "hermetic-worktree-v1",
    ...overrides,
  };
}

function policy(): AnalysisPolicyFingerprint {
  return {
    depth: "function",
    exclude: ["**/node_modules/**", "**/dist/**"],
    includeExternal: false,
    includeUnresolved: false,
    emitImportEdges: true,
    valueRefs: false,
  };
}

function provenance(): ExtractorProvenance {
  return {
    extractorVersion: "extractor-1",
    analysisPolicyVersion: "analysis-1",
    schemaVersion: "graph-1",
    shardSchemaVersion: POC_SHARD_VERSION,
    tsMorphVersion: "28.0.0",
    typescriptVersion: "6.0.3",
  };
}

function admissionInputs(): RevisionManifestAdmissionInputs {
  return {
    requestKey: "1".repeat(64),
    treeOid: TREE_OID,
    manifestAddress: "2".repeat(64),
    manifestPayloadDigest: "3".repeat(64),
    normalizedResultDigest: "4".repeat(64),
  };
}

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
