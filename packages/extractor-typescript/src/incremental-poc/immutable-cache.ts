import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { canonicalJson, canonicalJsonBytes, canonicalJsonSha256 } from "./canonical-json";

const CACHE_FORMAT = "meridian.incremental-poc.immutable-json.v1";

interface CacheEnvelope<T> {
  format: typeof CACHE_FORMAT;
  address: string;
  payloadDigest: string;
  value: T;
}

export interface ImmutableJsonCacheEntry<T> {
  address: string;
  value: T;
  payloadDigest: string;
  path: string;
  byteSize: number;
}

export interface ImmutableJsonCacheWriteResult<T> extends ImmutableJsonCacheEntry<T> {
  created: boolean;
}

export interface ImmutableJsonCacheAccess {
  /**
   * Existing server-owned root below which every path component must be a real directory.
   * Defaults to the logical cache root for standalone callers and tests.
   */
  trustedRoot?: string;
}

export class ImmutableCacheCorruptionError extends Error {
  constructor(
    message: string,
    readonly address: string,
    readonly cachePath: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ImmutableCacheCorruptionError";
  }
}

export class ImmutableCacheCollisionError extends Error {
  constructor(readonly address: string, readonly cachePath: string) {
    super(`immutable cache address ${address} already contains a different payload`);
    this.name = "ImmutableCacheCollisionError";
  }
}

export function immutableJsonCachePath(root: string, address: string): string {
  assertAddress(address);
  return join(root, address.slice(0, 2), `${address}.json`);
}

export async function readImmutableJsonCache<T>(
  root: string,
  address: string,
  access: ImmutableJsonCacheAccess = {},
): Promise<ImmutableJsonCacheEntry<T> | null> {
  const path = immutableJsonCachePath(root, address);
  const trustedRoot = resolve(access.trustedRoot ?? root);
  if (!await ensureTrustedDirectoryPath(
    trustedRoot,
    dirname(path),
    false,
  )) {
    return null;
  }
  let bytes: Buffer;
  try {
    const entry = await lstat(path);
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error("entry is not a regular no-follow file");
    }
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      bytes = await handle.readFile();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return null;
    }
    throw new ImmutableCacheCorruptionError(
      `immutable cache entry ${address} is not safely readable`,
      address,
      path,
      { cause: error },
    );
  }

  try {
    const source = bytes.toString("utf8");
    const decoded: unknown = JSON.parse(source);
    if (canonicalJson(decoded) !== source) {
      throw new Error("entry is not canonical JSON");
    }
    if (!isEnvelope(decoded, address)) {
      throw new Error("entry envelope is invalid");
    }
    const actualPayloadDigest = canonicalJsonSha256(decoded.value);
    if (decoded.payloadDigest !== actualPayloadDigest) {
      throw new Error("payload digest does not match");
    }
    return {
      address,
      value: decoded.value as T,
      payloadDigest: actualPayloadDigest,
      path,
      byteSize: bytes.byteLength,
    };
  } catch (error) {
    throw new ImmutableCacheCorruptionError(
      `immutable cache entry ${address} is corrupt`,
      address,
      path,
      { cause: error },
    );
  }
}

export async function writeImmutableJsonCache<T>(
  root: string,
  address: string,
  value: T,
  access: ImmutableJsonCacheAccess = {},
): Promise<ImmutableJsonCacheWriteResult<T>> {
  const path = immutableJsonCachePath(root, address);
  const trustedRoot = resolve(access.trustedRoot ?? root);
  const envelope: CacheEnvelope<T> = {
    format: CACHE_FORMAT,
    address,
    payloadDigest: canonicalJsonSha256(value),
    value,
  };
  const bytes = canonicalJsonBytes(envelope);
  await ensureTrustedDirectoryPath(trustedRoot, dirname(path), true);

  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, bytes, { flag: "wx", mode: 0o444 });
  let created = false;
  try {
    try {
      await link(temporaryPath, path);
      created = true;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") {
        throw error;
      }
    }
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }

  if (created) {
    return cacheResult(path, envelope, bytes.byteLength, true);
  }

  const existing = await readImmutableJsonCache<T>(root, address, access);
  if (existing === null
    || existing.payloadDigest !== envelope.payloadDigest
    || canonicalJson(existing.value) !== canonicalJson(value)) {
    throw new ImmutableCacheCollisionError(address, path);
  }
  return { ...existing, created: false };
}

/**
 * Enumerate canonical immutable entries without following a cache-controlled directory or file
 * symlink. Temporary files from an in-flight atomic publication are ignored.
 */
export async function listImmutableJsonCacheAddresses(
  root: string,
  access: ImmutableJsonCacheAccess = {},
): Promise<string[]> {
  const logicalRoot = resolve(root);
  const trustedRoot = resolve(access.trustedRoot ?? root);
  if (!await ensureTrustedDirectoryPath(trustedRoot, logicalRoot, false)) return [];
  const prefixes = await readdir(logicalRoot, { withFileTypes: true });
  const addresses: string[] = [];
  for (const prefix of prefixes.sort((left, right) => compareNames(left.name, right.name))) {
    if (!/^[a-f0-9]{2}$/.test(prefix.name) || !prefix.isDirectory() || prefix.isSymbolicLink()) {
      throw new Error(`immutable cache prefix is not a trusted directory: ${prefix.name}`);
    }
    const prefixPath = join(logicalRoot, prefix.name);
    await ensureTrustedDirectoryPath(trustedRoot, prefixPath, false);
    const entries = await readdir(prefixPath, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => compareNames(left.name, right.name))) {
      if (entry.name.includes(".tmp")) continue;
      const match = /^([a-f0-9]{64})\.json$/.exec(entry.name);
      if (
        match === null
        || !match[1]!.startsWith(prefix.name)
        || !entry.isFile()
        || entry.isSymbolicLink()
      ) {
        throw new Error(`immutable cache entry is not a trusted regular file: ${entry.name}`);
      }
      addresses.push(match[1]!);
    }
  }
  return addresses;
}

function cacheResult<T>(
  path: string,
  envelope: CacheEnvelope<T>,
  byteSize: number,
  created: boolean,
): ImmutableJsonCacheWriteResult<T> {
  return {
    address: envelope.address,
    value: envelope.value,
    payloadDigest: envelope.payloadDigest,
    path,
    byteSize,
    created,
  };
}

function isEnvelope(value: unknown, address: string): value is CacheEnvelope<unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return keys.join("\0") === ["address", "format", "payloadDigest", "value"].join("\0")
    && record.format === CACHE_FORMAT
    && record.address === address
    && typeof record.payloadDigest === "string"
    && /^[0-9a-f]{64}$/.test(record.payloadDigest);
}

function assertAddress(address: string): void {
  if (!/^[0-9a-f]{64}$/.test(address)) {
    throw new TypeError("immutable cache address must be a lowercase SHA-256 hex digest");
  }
}

async function ensureTrustedDirectoryPath(
  trustedRootInput: string,
  directoryInput: string,
  create: boolean,
): Promise<boolean> {
  const trustedRoot = resolve(trustedRootInput);
  const directory = resolve(directoryInput);
  const relativeDirectory = relative(trustedRoot, directory);
  if (
    relativeDirectory === ".."
    || relativeDirectory.startsWith(`..${sep}`)
    || isAbsolute(relativeDirectory)
  ) {
    throw new TypeError("immutable cache path escapes its trusted root");
  }
  let rootEntry;
  try {
    rootEntry = await lstat(trustedRoot);
  } catch (error) {
    if (errorCode(error) === "ENOENT" && !create) return false;
    if (errorCode(error) !== "ENOENT") throw error;
    // Standalone callers must create/own their top-level root before asking this helper to write.
    throw new Error("immutable cache trusted root does not exist");
  }
  if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) {
    throw new Error("immutable cache trusted root is not a real directory");
  }

  let current = trustedRoot;
  for (const segment of relativeDirectory.split(sep).filter(Boolean)) {
    current = join(current, segment);
    let entry;
    try {
      entry = await lstat(current);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
      if (!create) return false;
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (mkdirError) {
        if (errorCode(mkdirError) !== "EEXIST") throw mkdirError;
      }
      entry = await lstat(current);
    }
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error(`immutable cache path component is not a real directory: ${current}`);
    }
  }
  return true;
}

function compareNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}
