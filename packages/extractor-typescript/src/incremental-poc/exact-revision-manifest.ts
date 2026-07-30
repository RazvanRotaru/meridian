import {
  createPrivateKey,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import {
  requireAdmissionCapability,
  type RevisionShardAdmissionCapability,
  type RevisionShardAdmissionSigner,
} from "./admission";
import {
  canonicalJsonBytes,
  canonicalJsonSha256,
  compareCanonicalStrings,
} from "./canonical-json";
import {
  POC_MANIFEST_VERSION,
  POC_SHARD_VERSION,
  type AnalysisPolicyFingerprint,
  type ExtractorProvenance,
} from "./model";

export const REVISION_REQUEST_FINGERPRINT_VERSION = 1 as const;
export const REVISION_MANIFEST_ADMISSION_VERSION = 1 as const;

const REQUEST_FINGERPRINT_KIND = "typescript-exact-revision-request" as const;
const MANIFEST_ADMISSION_DOMAIN = Buffer.from(
  "meridian.typescript-revision-manifest-admission.v1\0",
  "utf8",
);
const SHA256_DIGEST = /^[a-f0-9]{64}$/;
const GIT_OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const MAX_SUPPLEMENTAL_FILES = 100_000;
const MAX_SUPPLEMENTAL_PATH_BYTES = 4_096;

export interface RevisionRequestFingerprintInputV1 {
  treeOid: string;
  supplementalFiles: readonly string[];
  policy: AnalysisPolicyFingerprint;
  provenance: ExtractorProvenance;
  workspaceDigest: string;
  hermeticPolicyVersion: string;
}

export interface RevisionRequestFingerprintV1 {
  version: typeof REVISION_REQUEST_FINGERPRINT_VERSION;
  kind: typeof REQUEST_FINGERPRINT_KIND;
  treeOid: string;
  supplementalFiles: string[];
  policy: AnalysisPolicyFingerprint;
  provenance: ExtractorProvenance;
  workspaceDigest: string;
  hermeticPolicyVersion: string;
}

export interface RevisionRequestIdentityV1 {
  fingerprint: RevisionRequestFingerprintV1;
  requestKey: string;
}

export interface RevisionManifestAdmissionInputs {
  requestKey: string;
  treeOid: string;
  manifestAddress: string;
  manifestPayloadDigest: string;
  normalizedResultDigest: string;
}

export interface RevisionManifestAdmissionReceipt {
  version: typeof REVISION_MANIFEST_ADMISSION_VERSION;
  shardSchemaVersion: typeof POC_SHARD_VERSION;
  manifestSchemaVersion: typeof POC_MANIFEST_VERSION;
  requestKey: string;
  treeOid: string;
  manifestAddress: string;
  manifestPayloadDigest: string;
  normalizedResultDigest: string;
  keyId: string;
  signature: string;
}

interface UnsignedRevisionManifestAdmissionReceipt {
  version: typeof REVISION_MANIFEST_ADMISSION_VERSION;
  shardSchemaVersion: typeof POC_SHARD_VERSION;
  manifestSchemaVersion: typeof POC_MANIFEST_VERSION;
  requestKey: string;
  treeOid: string;
  manifestAddress: string;
  manifestPayloadDigest: string;
  normalizedResultDigest: string;
  keyId: string;
}

/**
 * Builds the path-independent identity of one exact-tree TypeScript extraction request.
 * All caller-owned arrays and nested records are copied before hashing.
 */
export function buildRevisionRequestFingerprintV1(
  input: RevisionRequestFingerprintInputV1,
): RevisionRequestIdentityV1 {
  const record = requireExactRecord(input, [
    "hermeticPolicyVersion",
    "policy",
    "provenance",
    "supplementalFiles",
    "treeOid",
    "workspaceDigest",
  ], "revision request fingerprint input");
  const fingerprint: RevisionRequestFingerprintV1 = {
    version: REVISION_REQUEST_FINGERPRINT_VERSION,
    kind: REQUEST_FINGERPRINT_KIND,
    treeOid: normalizeGitObjectId(record.treeOid),
    supplementalFiles: normalizeSupplementalFiles(record.supplementalFiles),
    policy: copyPolicy(record.policy),
    provenance: copyProvenance(record.provenance),
    workspaceDigest: requireSha256(record.workspaceDigest, "workspace digest"),
    hermeticPolicyVersion: requireVersion(
      record.hermeticPolicyVersion,
      "hermetic policy version",
    ),
  };
  return {
    fingerprint,
    requestKey: canonicalJsonSha256(fingerprint),
  };
}

export function createRevisionManifestAdmissionReceipt(
  signer: RevisionShardAdmissionSigner,
  inputs: RevisionManifestAdmissionInputs,
): RevisionManifestAdmissionReceipt {
  const privateKey = requireManifestAdmissionSigner(signer);
  const unsigned = unsignedReceipt(signer, inputs);
  return {
    ...unsigned,
    signature: sign(null, receiptBytes(unsigned), privateKey).toString("base64"),
  };
}

export function verifyRevisionManifestAdmissionReceipt(
  verifier: RevisionShardAdmissionCapability,
  value: unknown,
  expected: RevisionManifestAdmissionInputs,
): value is RevisionManifestAdmissionReceipt {
  const publicKey = requireAdmissionCapability(verifier).publicKey;
  if (!isRevisionManifestAdmissionReceipt(value)) return false;
  const unsigned = unsignedReceipt(verifier, expected);
  if (
    value.version !== unsigned.version
    || value.shardSchemaVersion !== unsigned.shardSchemaVersion
    || value.manifestSchemaVersion !== unsigned.manifestSchemaVersion
    || value.requestKey !== unsigned.requestKey
    || value.treeOid !== unsigned.treeOid
    || value.manifestAddress !== unsigned.manifestAddress
    || value.manifestPayloadDigest !== unsigned.manifestPayloadDigest
    || value.normalizedResultDigest !== unsigned.normalizedResultDigest
    || value.keyId !== unsigned.keyId
  ) {
    return false;
  }
  const signature = canonicalEd25519Signature(value.signature);
  return signature !== null
    && verify(null, receiptBytes(unsigned), publicKey, signature);
}

function unsignedReceipt(
  capability: RevisionShardAdmissionCapability,
  inputs: RevisionManifestAdmissionInputs,
): UnsignedRevisionManifestAdmissionReceipt {
  const record = requireExactRecord(inputs, [
    "manifestAddress",
    "manifestPayloadDigest",
    "normalizedResultDigest",
    "requestKey",
    "treeOid",
  ], "revision manifest admission inputs");
  return {
    version: REVISION_MANIFEST_ADMISSION_VERSION,
    shardSchemaVersion: POC_SHARD_VERSION,
    manifestSchemaVersion: POC_MANIFEST_VERSION,
    requestKey: requireSha256(record.requestKey, "request key"),
    treeOid: normalizeGitObjectId(record.treeOid),
    manifestAddress: requireSha256(record.manifestAddress, "manifest address"),
    manifestPayloadDigest: requireSha256(
      record.manifestPayloadDigest,
      "manifest payload digest",
    ),
    normalizedResultDigest: requireSha256(
      record.normalizedResultDigest,
      "normalized result digest",
    ),
    keyId: capability.keyId,
  };
}

function receiptBytes(receipt: UnsignedRevisionManifestAdmissionReceipt): Buffer {
  return Buffer.concat([MANIFEST_ADMISSION_DOMAIN, canonicalJsonBytes(receipt)]);
}

function requireManifestAdmissionSigner(
  signer: RevisionShardAdmissionSigner,
): KeyObject {
  const { capability } = requireAdmissionCapability(signer);
  if (capability.kind !== "signer") {
    throw new TypeError("revision manifest admission requires a signer capability");
  }
  // requireAdmissionCapability has already checked canonical key encodings, Ed25519 key type,
  // public-key identity, and a signing proof that the private/public keypair matches.
  try {
    return createPrivateKey({
      key: Buffer.from(capability.privateKeyPkcs8, "base64"),
      format: "der",
      type: "pkcs8",
    });
  } catch (cause) {
    throw new TypeError("invalid revision manifest admission private key", { cause });
  }
}

function isRevisionManifestAdmissionReceipt(
  value: unknown,
): value is RevisionManifestAdmissionReceipt {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const receipt = value as Record<string, unknown>;
  if (!hasExactKeys(receipt, [
    "keyId",
    "manifestAddress",
    "manifestPayloadDigest",
    "manifestSchemaVersion",
    "normalizedResultDigest",
    "requestKey",
    "shardSchemaVersion",
    "signature",
    "treeOid",
    "version",
  ])) {
    return false;
  }
  return receipt.version === REVISION_MANIFEST_ADMISSION_VERSION
    && receipt.shardSchemaVersion === POC_SHARD_VERSION
    && receipt.manifestSchemaVersion === POC_MANIFEST_VERSION
    && [
      receipt.requestKey,
      receipt.manifestAddress,
      receipt.manifestPayloadDigest,
      receipt.normalizedResultDigest,
      receipt.keyId,
    ].every((part) => typeof part === "string" && SHA256_DIGEST.test(part))
    && typeof receipt.treeOid === "string"
    && GIT_OBJECT_ID.test(receipt.treeOid)
    && typeof receipt.signature === "string";
}

function copyPolicy(value: unknown): AnalysisPolicyFingerprint {
  const policy = requireExactRecord(value, [
    "depth",
    "emitImportEdges",
    "exclude",
    "includeExternal",
    "includeUnresolved",
    "valueRefs",
  ], "analysis policy");
  if (
    policy.depth !== "package"
    && policy.depth !== "module"
    && policy.depth !== "class"
    && policy.depth !== "function"
  ) {
    throw new TypeError("analysis policy has an invalid extraction depth");
  }
  if (!Array.isArray(policy.exclude) || !policy.exclude.every(
    (entry) => typeof entry === "string",
  )) {
    throw new TypeError("analysis policy exclude must be an array of strings");
  }
  return {
    depth: policy.depth,
    exclude: [...policy.exclude],
    includeExternal: requireBoolean(policy.includeExternal, "analysis policy includeExternal"),
    includeUnresolved: requireBoolean(
      policy.includeUnresolved,
      "analysis policy includeUnresolved",
    ),
    emitImportEdges: requireBoolean(
      policy.emitImportEdges,
      "analysis policy emitImportEdges",
    ),
    valueRefs: requireBoolean(policy.valueRefs, "analysis policy valueRefs"),
  };
}

function copyProvenance(value: unknown): ExtractorProvenance {
  const provenance = requireExactRecord(value, [
    "analysisPolicyVersion",
    "extractorVersion",
    "schemaVersion",
    "shardSchemaVersion",
    "tsMorphVersion",
    "typescriptVersion",
  ], "extractor provenance");
  if (provenance.shardSchemaVersion !== POC_SHARD_VERSION) {
    throw new TypeError("extractor provenance has a mismatched shard schema version");
  }
  return {
    extractorVersion: requireVersion(provenance.extractorVersion, "extractor version"),
    analysisPolicyVersion: requireVersion(
      provenance.analysisPolicyVersion,
      "analysis policy version",
    ),
    schemaVersion: requireVersion(provenance.schemaVersion, "graph schema version"),
    shardSchemaVersion: POC_SHARD_VERSION,
    tsMorphVersion: requireVersion(provenance.tsMorphVersion, "ts-morph version"),
    typescriptVersion: requireVersion(provenance.typescriptVersion, "TypeScript version"),
  };
}

function normalizeSupplementalFiles(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_SUPPLEMENTAL_FILES) {
    throw new TypeError(
      `supplemental files must be an array of at most ${MAX_SUPPLEMENTAL_FILES} paths`,
    );
  }
  const unique = new Set<string>();
  for (const path of value) {
    if (
      typeof path !== "string"
      || path.length === 0
      || Buffer.byteLength(path) > MAX_SUPPLEMENTAL_PATH_BYTES
      || path.includes("\0")
      || path.includes("\\")
      || path.startsWith("/")
      || !/\.tsx?$/.test(path)
      || path.split("/").some(
        (segment) => segment === "" || segment === "." || segment === ".." || segment === ".git",
      )
    ) {
      throw new TypeError(
        "supplemental files must be safe root-relative POSIX .ts or .tsx paths",
      );
    }
    unique.add(path);
  }
  return [...unique].sort(compareCanonicalStrings);
}

function normalizeGitObjectId(value: unknown): string {
  if (typeof value !== "string") {
    throw new TypeError("tree OID must be an exact Git object ID");
  }
  const normalized = value.toLowerCase();
  if (!GIT_OBJECT_ID.test(normalized)) {
    throw new TypeError("tree OID must be a 40- or 64-character Git object ID");
  }
  return normalized;
}

function requireSha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256_DIGEST.test(value)) {
    throw new TypeError(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new TypeError(`${label} must be boolean`);
  }
  return value;
}

function requireVersion(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > 256
    || value !== value.trim()
    || value.includes("\0")
  ) {
    throw new TypeError(`${label} must be an explicit non-empty version`);
  }
  return value;
}

function canonicalEd25519Signature(value: string): Buffer | null {
  if (
    value.length === 0
    || value.length > 128
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    return null;
  }
  const bytes = Buffer.from(value, "base64");
  return bytes.byteLength === 64 && bytes.toString("base64") === value ? bytes : null;
}

function requireExactRecord(
  value: unknown,
  expectedKeys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    throw new TypeError(`${label} must be a plain object`);
  }
  const record = value as Record<string, unknown>;
  if (!hasExactKeys(record, expectedKeys)) {
    throw new TypeError(`${label} has unexpected or missing fields`);
  }
  return record;
}

function hasExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): boolean {
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== "string")) return false;
  const actual = ownKeys as string[];
  if (actual.some((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor === undefined || !descriptor.enumerable || !("value" in descriptor);
  })) {
    return false;
  }
  actual.sort(compareCanonicalStrings);
  const expected = [...expectedKeys].sort(compareCanonicalStrings);
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}
