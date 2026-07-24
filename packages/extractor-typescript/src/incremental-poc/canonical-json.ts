import { createHash } from "node:crypto";

export type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue };

/** Canonical JSON for cache identities: sorted object keys and no insignificant whitespace. */
export function canonicalJson(value: unknown): string {
  return serialize(value, new Set<object>(), "$");
}

export function canonicalJsonBytes(value: unknown): Buffer {
  return Buffer.from(canonicalJson(value), "utf8");
}

export function sha256Hex(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

export function canonicalJsonSha256(value: unknown): string {
  return sha256Hex(canonicalJsonBytes(value));
}

/** Locale-independent ordering for every array that contributes to a cache identity. */
export function compareCanonicalStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function serialize(value: unknown, active: Set<object>, path: string): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`canonical JSON rejects non-finite number at ${path}`);
    }
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    throw new TypeError(`canonical JSON rejects ${typeof value} at ${path}`);
  }
  if (active.has(value)) {
    throw new TypeError(`canonical JSON rejects cycle at ${path}`);
  }

  active.add(value);
  try {
    return Array.isArray(value)
      ? serializeArray(value, active, path)
      : serializeObject(value, active, path);
  } finally {
    active.delete(value);
  }
}

function serializeArray(value: unknown[], active: Set<object>, path: string): string {
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string" || !isArrayIndex(key, value.length))) {
    throw new TypeError(`canonical JSON rejects non-index array property at ${path}`);
  }
  const items: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (descriptor === undefined) {
      throw new TypeError(`canonical JSON rejects sparse array at ${path}[${index}]`);
    }
    if (!("value" in descriptor)) {
      throw new TypeError(`canonical JSON rejects array accessor at ${path}[${index}]`);
    }
    items.push(serialize(descriptor.value, active, `${path}[${index}]`));
  }
  return `[${items.join(",")}]`;
}

function serializeObject(value: object, active: Set<object>, path: string): string {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`canonical JSON rejects non-plain object at ${path}`);
  }

  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== "string")) {
    throw new TypeError(`canonical JSON rejects symbol key at ${path}`);
  }

  const record = value as Record<string, unknown>;
  const entries: string[] = [];
  for (const key of (ownKeys as string[]).sort()) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      throw new TypeError(`canonical JSON rejects hidden or accessor property at ${path}.${key}`);
    }
    entries.push(`${JSON.stringify(key)}:${serialize(descriptor.value, active, `${path}.${key}`)}`);
  }
  return `{${entries.join(",")}}`;
}

function isArrayIndex(key: string, length: number): boolean {
  if (key === "length") {
    return true;
  }
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === key;
}
