import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import { canonicalJsonBytes } from "./canonical-json";
import { POC_SHARD_VERSION } from "./model";

export const REVISION_SHARD_ADMISSION_VERSION = 1 as const;

export interface RevisionShardAdmissionVerifier {
  version: typeof REVISION_SHARD_ADMISSION_VERSION;
  kind: "verifier";
  keyId: string;
  publicKeySpki: string;
}

export interface RevisionShardAdmissionSigner {
  version: typeof REVISION_SHARD_ADMISSION_VERSION;
  kind: "signer";
  keyId: string;
  publicKeySpki: string;
  privateKeyPkcs8: string;
}

export type RevisionShardAdmissionCapability =
  | RevisionShardAdmissionVerifier
  | RevisionShardAdmissionSigner;

export interface RevisionShardAdmissionReceipt {
  version: typeof REVISION_SHARD_ADMISSION_VERSION;
  shardSchemaVersion: typeof POC_SHARD_VERSION;
  shardKey: string;
  baseInputKey: string;
  payloadDigest: string;
  keyId: string;
  signature: string;
}

interface UnsignedRevisionShardAdmissionReceipt {
  version: typeof REVISION_SHARD_ADMISSION_VERSION;
  shardSchemaVersion: typeof POC_SHARD_VERSION;
  shardKey: string;
  baseInputKey: string;
  payloadDigest: string;
  keyId: string;
}

const DOMAIN = Buffer.from("meridian.typescript-revision-shard-admission.v1\0", "utf8");

export function createRevisionShardAdmissionReceipt(
  signer: RevisionShardAdmissionSigner,
  inputs: {
    shardKey: string;
    baseInputKey: string;
    payloadDigest: string;
  },
): RevisionShardAdmissionReceipt {
  const privateKey = requireAdmissionSigner(signer);
  const unsigned = unsignedReceipt(signer, inputs);
  return {
    ...unsigned,
    signature: sign(null, receiptBytes(unsigned), privateKey).toString("base64"),
  };
}

export function verifyRevisionShardAdmissionReceipt(
  verifier: RevisionShardAdmissionCapability,
  value: unknown,
  expected: {
    shardKey: string;
    baseInputKey: string;
    payloadDigest: string;
  },
): value is RevisionShardAdmissionReceipt {
  const publicKey = requireAdmissionCapability(verifier).publicKey;
  if (!isReceipt(value)) return false;
  const unsigned = unsignedReceipt(verifier, expected);
  if (
    value.version !== unsigned.version
    || value.shardSchemaVersion !== unsigned.shardSchemaVersion
    || value.shardKey !== unsigned.shardKey
    || value.baseInputKey !== unsigned.baseInputKey
    || value.payloadDigest !== unsigned.payloadDigest
    || value.keyId !== unsigned.keyId
  ) {
    return false;
  }
  const signature = canonicalBase64(value.signature);
  return signature !== null
    && verify(null, receiptBytes(unsigned), publicKey, signature);
}

export function isRevisionShardAdmissionCapability(
  value: unknown,
): value is RevisionShardAdmissionCapability {
  try {
    requireAdmissionCapability(value);
    return true;
  } catch {
    return false;
  }
}

export function requireAdmissionCapability(
  value: unknown,
): { capability: RevisionShardAdmissionCapability; publicKey: KeyObject } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("invalid revision shard admission capability");
  }
  const capability = value as Record<string, unknown>;
  const expectedKeys = capability.kind === "signer"
    ? ["keyId", "kind", "privateKeyPkcs8", "publicKeySpki", "version"]
    : ["keyId", "kind", "publicKeySpki", "version"];
  if (
    Object.keys(capability).sort().join("\0") !== expectedKeys.join("\0")
    || capability.version !== REVISION_SHARD_ADMISSION_VERSION
    || (capability.kind !== "verifier" && capability.kind !== "signer")
    || typeof capability.keyId !== "string"
    || !/^[a-f0-9]{64}$/.test(capability.keyId)
    || typeof capability.publicKeySpki !== "string"
  ) {
    throw new TypeError("invalid revision shard admission capability");
  }
  const publicDer = canonicalBase64(capability.publicKeySpki);
  if (publicDer === null || publicDer.byteLength > 1024) {
    throw new TypeError("invalid revision shard admission public key");
  }
  let publicKey: KeyObject;
  try {
    publicKey = createPublicKey({ key: publicDer, format: "der", type: "spki" });
  } catch (cause) {
    throw new TypeError("invalid revision shard admission public key", { cause });
  }
  if (
    publicKey.asymmetricKeyType !== "ed25519"
    || createHash("sha256").update(publicDer).digest("hex") !== capability.keyId
  ) {
    throw new TypeError("invalid revision shard admission public key identity");
  }
  if (capability.kind === "signer") {
    requireAdmissionSigner(capability as unknown as RevisionShardAdmissionSigner, publicDer);
  }
  return {
    capability: capability as unknown as RevisionShardAdmissionCapability,
    publicKey,
  };
}

function requireAdmissionSigner(
  signer: RevisionShardAdmissionSigner,
  expectedPublicDer?: Buffer,
): KeyObject {
  if (typeof signer.privateKeyPkcs8 !== "string") {
    throw new TypeError("revision shard admission signer lacks a private key");
  }
  const privateDer = canonicalBase64(signer.privateKeyPkcs8);
  const publicDer = expectedPublicDer ?? canonicalBase64(signer.publicKeySpki);
  if (
    privateDer === null
    || privateDer.byteLength > 2048
    || publicDer === null
    || publicDer.byteLength > 1024
  ) {
    throw new TypeError("invalid revision shard admission private key");
  }
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey({ key: privateDer, format: "der", type: "pkcs8" });
  } catch (cause) {
    throw new TypeError("invalid revision shard admission private key", { cause });
  }
  const publicKey = createPublicKey({ key: publicDer, format: "der", type: "spki" });
  const proof = Buffer.from("meridian.typescript-revision-shard-admission.keypair.v1", "utf8");
  if (
    privateKey.asymmetricKeyType !== "ed25519"
    || !verify(null, proof, publicKey, sign(null, proof, privateKey))
  ) {
    throw new TypeError("revision shard admission keypair does not match");
  }
  return privateKey;
}

function unsignedReceipt(
  capability: RevisionShardAdmissionCapability,
  inputs: {
    shardKey: string;
    baseInputKey: string;
    payloadDigest: string;
  },
): UnsignedRevisionShardAdmissionReceipt {
  for (const value of [inputs.shardKey, inputs.baseInputKey, inputs.payloadDigest]) {
    if (!/^[a-f0-9]{64}$/.test(value)) {
      throw new TypeError("revision shard admission identity must be a SHA-256 digest");
    }
  }
  return {
    version: REVISION_SHARD_ADMISSION_VERSION,
    shardSchemaVersion: POC_SHARD_VERSION,
    shardKey: inputs.shardKey,
    baseInputKey: inputs.baseInputKey,
    payloadDigest: inputs.payloadDigest,
    keyId: capability.keyId,
  };
}

function receiptBytes(receipt: UnsignedRevisionShardAdmissionReceipt): Buffer {
  return Buffer.concat([DOMAIN, canonicalJsonBytes(receipt)]);
}

function canonicalBase64(value: string): Buffer | null {
  if (
    value.length === 0
    || value.length > 4096
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    return null;
  }
  const bytes = Buffer.from(value, "base64");
  return bytes.toString("base64") === value ? bytes : null;
}

function isReceipt(value: unknown): value is RevisionShardAdmissionReceipt {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const receipt = value as Record<string, unknown>;
  const keys = Object.keys(receipt).sort();
  return keys.join("\0") === [
    "baseInputKey",
    "keyId",
    "payloadDigest",
    "shardKey",
    "shardSchemaVersion",
    "signature",
    "version",
  ].join("\0")
    && receipt.version === REVISION_SHARD_ADMISSION_VERSION
    && receipt.shardSchemaVersion === POC_SHARD_VERSION
    && [
      receipt.shardKey,
      receipt.baseInputKey,
      receipt.payloadDigest,
      receipt.keyId,
    ].every((part) => typeof part === "string" && /^[a-f0-9]{64}$/.test(part))
    && typeof receipt.signature === "string";
}
