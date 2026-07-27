import {
  constants,
  type Stats,
} from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  unlink,
  writeFile,
} from "node:fs/promises";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
  verify,
} from "node:crypto";
import { join, resolve } from "node:path";
import type {
  RevisionShardAdmissionSigner,
  RevisionShardAdmissionVerifier,
} from "@meridian/extractor-typescript";

const AUTHORITY_FORMAT_VERSION = 1 as const;
const AUTHORITY_FILE = "admission-authority-v1.json";
const MAX_AUTHORITY_BYTES = 8 * 1024;
const MAX_PUBLIC_KEY_BYTES = 1024;
const MAX_PRIVATE_KEY_BYTES = 2048;
const SHA256 = /^[a-f0-9]{64}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const KEYPAIR_PROOF = Buffer.from(
  "meridian.typescript-revision-shard-admission.keypair.v1",
  "utf8",
);

interface StoredAdmissionAuthority {
  formatVersion: typeof AUTHORITY_FORMAT_VERSION;
  keyId: string;
  publicKeySpki: string;
  privateKeyPkcs8: string;
}

export interface TypeScriptRevisionShardAuthority {
  signer: RevisionShardAdmissionSigner;
  verifier: RevisionShardAdmissionVerifier;
}

/**
 * Load or atomically create the host-local cold-oracle signing authority. This file is deliberately
 * adjacent to, rather than inside, the GC-able shard namespace.
 */
export async function typeScriptRevisionShardAuthority(
  cacheRootInput: string,
): Promise<TypeScriptRevisionShardAuthority> {
  const cacheRoot = resolve(cacheRootInput);
  await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
  await requirePrivateDirectory(cacheRoot, false);
  const shardRoot = join(cacheRoot, "typescript-revision-shards-v1");
  await mkdir(shardRoot, { mode: 0o700 }).catch((error) => {
    if (errorCode(error) !== "EEXIST") throw error;
  });
  await requirePrivateDirectory(shardRoot, true);
  const authorityPath = join(shardRoot, AUTHORITY_FILE);

  const generated = generateAuthority();
  const temporaryPath = join(shardRoot, `.${AUTHORITY_FILE}.${process.pid}.${randomUUID()}.tmp`);
  await writeFile(temporaryPath, `${JSON.stringify(generated)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  try {
    try {
      await link(temporaryPath, authorityPath);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
  return readAuthority(authorityPath);
}

async function readAuthority(path: string): Promise<TypeScriptRevisionShardAuthority> {
  const entry = await lstat(path);
  requirePrivateAuthorityFile(entry);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes: Buffer;
  try {
    const openedEntry = await handle.stat();
    requirePrivateAuthorityFile(openedEntry);
    if (openedEntry.size === 0 || openedEntry.size > MAX_AUTHORITY_BYTES) {
      throw new Error("TypeScript revision-shard admission authority has an invalid size");
    }
    bytes = Buffer.alloc(openedEntry.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const read = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
      if (read.bytesRead === 0) {
        throw new Error("TypeScript revision-shard admission authority changed while reading");
      }
      offset += read.bytesRead;
    }
    const trailing = await handle.read(Buffer.alloc(1), 0, 1, offset);
    if (trailing.bytesRead !== 0) {
      throw new Error("TypeScript revision-shard admission authority changed while reading");
    }
  } finally {
    await handle.close();
  }
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (cause) {
    throw new Error("TypeScript revision-shard admission authority is invalid", { cause });
  }
  if (!isStoredAuthority(value)) {
    throw new Error("TypeScript revision-shard admission authority is invalid");
  }
  const signer: RevisionShardAdmissionSigner = {
    version: 1,
    kind: "signer",
    keyId: value.keyId,
    publicKeySpki: value.publicKeySpki,
    privateKeyPkcs8: value.privateKeyPkcs8,
  };
  validateAuthorityKeyPair(signer);
  return {
    signer,
    verifier: {
      version: 1,
      kind: "verifier",
      keyId: signer.keyId,
      publicKeySpki: signer.publicKeySpki,
    },
  };
}

function generateAuthority(): StoredAdmissionAuthority {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicDer = publicKey.export({ format: "der", type: "spki" });
  const privateDer = privateKey.export({ format: "der", type: "pkcs8" });
  if (!Buffer.isBuffer(publicDer) || !Buffer.isBuffer(privateDer)) {
    throw new Error("could not serialize TypeScript revision-shard admission authority");
  }
  return {
    formatVersion: AUTHORITY_FORMAT_VERSION,
    keyId: createHash("sha256").update(publicDer).digest("hex"),
    publicKeySpki: publicDer.toString("base64"),
    privateKeyPkcs8: privateDer.toString("base64"),
  };
}

function isStoredAuthority(value: unknown): value is StoredAdmissionAuthority {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const authority = value as Record<string, unknown>;
  return Object.keys(authority).sort().join("\0") === [
    "formatVersion",
    "keyId",
    "privateKeyPkcs8",
    "publicKeySpki",
  ].join("\0")
    && authority.formatVersion === AUTHORITY_FORMAT_VERSION
    && typeof authority.keyId === "string" && SHA256.test(authority.keyId)
    && typeof authority.publicKeySpki === "string" && authority.publicKeySpki.length > 0
    && typeof authority.privateKeyPkcs8 === "string" && authority.privateKeyPkcs8.length > 0;
}

function validateAuthorityKeyPair(authority: RevisionShardAdmissionSigner): void {
  try {
    const publicDer = decodeBase64(authority.publicKeySpki, MAX_PUBLIC_KEY_BYTES);
    const privateDer = decodeBase64(authority.privateKeyPkcs8, MAX_PRIVATE_KEY_BYTES);
    if (createHash("sha256").update(publicDer).digest("hex") !== authority.keyId) {
      throw new Error("public key does not match its key id");
    }
    const publicKey = createPublicKey({ key: publicDer, format: "der", type: "spki" });
    const privateKey = createPrivateKey({ key: privateDer, format: "der", type: "pkcs8" });
    if (publicKey.asymmetricKeyType !== "ed25519" || privateKey.asymmetricKeyType !== "ed25519") {
      throw new Error("authority keys are not Ed25519");
    }
    const signature = sign(null, KEYPAIR_PROOF, privateKey);
    if (!verify(null, KEYPAIR_PROOF, publicKey, signature)) {
      throw new Error("authority public and private keys do not match");
    }
  } catch (cause) {
    throw new Error("TypeScript revision-shard admission authority keypair is invalid", { cause });
  }
}

function decodeBase64(value: string, maxBytes: number): Buffer {
  if (value.length > 4096 || !BASE64.test(value)) {
    throw new Error("authority key is not canonical base64");
  }
  const bytes = Buffer.from(value, "base64");
  if (
    bytes.byteLength === 0
    || bytes.byteLength > maxBytes
    || bytes.toString("base64") !== value
  ) {
    throw new Error("authority key is not canonical base64");
  }
  return bytes;
}

async function requirePrivateDirectory(path: string, makePrivate: boolean): Promise<void> {
  let entry = await lstat(path);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error("TypeScript revision-shard authority root is not a real directory");
  }
  if ((entry.mode & 0o077) !== 0) {
    if (!makePrivate) return;
    await chmod(path, 0o700);
    entry = await lstat(path);
    if ((entry.mode & 0o077) !== 0) {
      throw new Error("could not make TypeScript revision-shard authority root private");
    }
  }
}

function requirePrivateAuthorityFile(entry: Stats): void {
  if (!entry.isFile() || entry.isSymbolicLink() || (entry.mode & 0o077) !== 0) {
    throw new Error("TypeScript revision-shard admission authority is not a private regular file");
  }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}
