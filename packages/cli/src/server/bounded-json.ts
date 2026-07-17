/** Exact JSON encoding without materializing one response-sized string. */

const STRING_TOKEN_CODE_UNITS = 4 * 1024;

/** Count exact UTF-8 JSON bytes without materializing the encoding. */
export function jsonEncodedByteLength(value: unknown): number {
  const bytes = jsonValueByteLength(value, new Set());
  if (!Number.isSafeInteger(bytes)) throw new RangeError("encoded JSON exceeds the safe byte range");
  return bytes;
}

/**
 * Yield complete JSON in UTF-8-bounded chunks. The caller controls transport backpressure and
 * therefore never needs to retain the concatenated encoding.
 */
export function* boundedJsonChunks(value: unknown, maxChunkBytes: number): Generator<string> {
  if (!Number.isSafeInteger(maxChunkBytes) || maxChunkBytes < STRING_TOKEN_CODE_UNITS * 3) {
    throw new RangeError(`JSON chunk size must be at least ${STRING_TOKEN_CODE_UNITS * 3} bytes`);
  }
  let chunk = "";
  let chunkBytes = 0;
  for (const token of jsonTokens(value, new Set())) {
    const tokenBytes = Buffer.byteLength(token, "utf8");
    if (tokenBytes > maxChunkBytes) {
      throw new Error("bounded JSON token exceeded the configured chunk size");
    }
    if (chunkBytes > 0 && chunkBytes + tokenBytes > maxChunkBytes) {
      yield chunk;
      chunk = "";
      chunkBytes = 0;
    }
    chunk += token;
    chunkBytes += tokenBytes;
  }
  if (chunkBytes > 0) yield chunk;
}

function jsonValueByteLength(value: unknown, ancestors: Set<object>): number {
  if (value === null) return 4;
  if (typeof value === "string") return jsonStringByteLength(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return 4;
    return Object.is(value, -0) ? 1 : String(value).length;
  }
  if (typeof value === "boolean") return value ? 4 : 5;
  if (typeof value === "bigint") throw new TypeError("BigInt cannot be encoded as JSON");
  if (typeof value !== "object") throw new TypeError("top-level JSON value is not serializable");
  requirePlainJsonContainer(value);
  if (ancestors.has(value)) throw new TypeError("cyclic value cannot be encoded as JSON");
  ancestors.add(value);
  try {
    let bytes = 2;
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (index > 0) bytes += 1;
        const entry = value[index];
        bytes += entry === undefined || typeof entry === "function" || typeof entry === "symbol"
          ? 4
          : jsonValueByteLength(entry, ancestors);
      }
      return bytes;
    }

    let emitted = 0;
    for (const key of Object.keys(value)) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry === undefined || typeof entry === "function" || typeof entry === "symbol") continue;
      if (emitted > 0) bytes += 1;
      bytes += jsonStringByteLength(key) + 1 + jsonValueByteLength(entry, ancestors);
      emitted += 1;
    }
    return bytes;
  } finally {
    ancestors.delete(value);
  }
}

function jsonStringByteLength(value: string): number {
  let bytes = 2;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c
      || code === 0x08 || code === 0x0c || code === 0x0a || code === 0x0d || code === 0x09) {
      bytes += 2;
    } else if (code < 0x20 || isLoneSurrogate(value, index, code)) {
      bytes += 6;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      index += 1;
    } else if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function* jsonTokens(value: unknown, ancestors: Set<object>): Generator<string> {
  if (value === null) {
    yield "null";
    return;
  }
  if (typeof value === "string") {
    yield* jsonStringTokens(value);
    return;
  }
  if (typeof value === "number") {
    yield Number.isFinite(value) ? JSON.stringify(value) : "null";
    return;
  }
  if (typeof value === "boolean") {
    yield value ? "true" : "false";
    return;
  }
  if (typeof value === "bigint") {
    throw new TypeError("BigInt cannot be encoded as JSON");
  }
  if (typeof value !== "object") {
    throw new TypeError("top-level JSON value is not serializable");
  }
  requirePlainJsonContainer(value);
  if (ancestors.has(value)) throw new TypeError("cyclic value cannot be encoded as JSON");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      yield "[";
      for (let index = 0; index < value.length; index += 1) {
        if (index > 0) yield ",";
        const entry = value[index];
        if (entry === undefined || typeof entry === "function" || typeof entry === "symbol") {
          yield "null";
        } else {
          yield* jsonTokens(entry, ancestors);
        }
      }
      yield "]";
      return;
    }

    yield "{";
    let emitted = 0;
    for (const key of Object.keys(value)) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry === undefined || typeof entry === "function" || typeof entry === "symbol") continue;
      if (emitted > 0) yield ",";
      yield* jsonStringTokens(key);
      yield ":";
      yield* jsonTokens(entry, ancestors);
      emitted += 1;
    }
    yield "}";
  } finally {
    ancestors.delete(value);
  }
}

function* jsonStringTokens(value: string): Generator<string> {
  yield "\"";
  let plainStart = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    let escaped: string | null = null;
    if (code === 0x22) escaped = "\\\"";
    else if (code === 0x5c) escaped = "\\\\";
    else if (code === 0x08) escaped = "\\b";
    else if (code === 0x0c) escaped = "\\f";
    else if (code === 0x0a) escaped = "\\n";
    else if (code === 0x0d) escaped = "\\r";
    else if (code === 0x09) escaped = "\\t";
    else if (code < 0x20 || isLoneSurrogate(value, index, code)) {
      escaped = `\\u${code.toString(16).padStart(4, "0")}`;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      // A valid surrogate pair stays in one plain token and is encoded as one UTF-8 code point.
      index += 1;
    }

    if (escaped !== null) {
      if (plainStart < index) yield value.slice(plainStart, index);
      yield escaped;
      plainStart = index + 1;
      continue;
    }
    if (index + 1 - plainStart >= STRING_TOKEN_CODE_UNITS) {
      yield value.slice(plainStart, index + 1);
      plainStart = index + 1;
    }
  }
  if (plainStart < value.length) yield value.slice(plainStart);
  yield "\"";
}

function isLoneSurrogate(value: string, index: number, code: number): boolean {
  if (code >= 0xdc00 && code <= 0xdfff) return true;
  if (code < 0xd800 || code > 0xdbff) return false;
  const next = value.charCodeAt(index + 1);
  return !(next >= 0xdc00 && next <= 0xdfff);
}

function requirePlainJsonContainer(value: object): void {
  if (Array.isArray(value)) return;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("bounded JSON accepts only arrays and plain objects");
  }
}
