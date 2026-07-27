import { constants, type Stats } from "node:fs";
import { open } from "node:fs/promises";

const DEFAULT_MAX_EXACT_FILE_BYTES = 512 * 1024 * 1024;
const COMPARE_CHUNK_BYTES = 1024 * 1024;

/**
 * Compare two bounded regular files literally, without following their final path components.
 *
 * Digests are deliberately not an equality shortcut here. Shadow admission uses this primitive
 * after both canonical pipelines have materialized their evidence, so a matching result means the
 * persisted bytes themselves matched.
 */
export async function exactRegularFilesEqual(
  leftPath: string,
  rightPath: string,
  maxBytes = DEFAULT_MAX_EXACT_FILE_BYTES,
): Promise<boolean> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new TypeError("exact file comparison byte limit must be a positive safe integer");
  }
  const left = await open(leftPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let right: Awaited<ReturnType<typeof open>> | undefined;
  try {
    right = await open(rightPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const [leftBefore, rightBefore] = await Promise.all([left.stat(), right.stat()]);
    requireBoundedRegularFile(leftBefore, maxBytes);
    requireBoundedRegularFile(rightBefore, maxBytes);
    if (leftBefore.size !== rightBefore.size) return false;

    const leftBuffer = Buffer.allocUnsafe(Math.min(COMPARE_CHUNK_BYTES, leftBefore.size || 1));
    const rightBuffer = Buffer.allocUnsafe(Math.min(COMPARE_CHUNK_BYTES, rightBefore.size || 1));
    let offset = 0;
    while (offset < leftBefore.size) {
      const length = Math.min(leftBuffer.byteLength, leftBefore.size - offset);
      const [leftRead, rightRead] = await Promise.all([
        left.read(leftBuffer, 0, length, offset),
        right.read(rightBuffer, 0, length, offset),
      ]);
      if (leftRead.bytesRead !== length || rightRead.bytesRead !== length) {
        throw new Error("exact comparison file changed size while it was read");
      }
      if (!leftBuffer.subarray(0, length).equals(rightBuffer.subarray(0, length))) {
        return false;
      }
      offset += length;
    }

    const [leftAfter, rightAfter] = await Promise.all([left.stat(), right.stat()]);
    requireStableFile(leftBefore, leftAfter);
    requireStableFile(rightBefore, rightAfter);
    return true;
  } finally {
    await Promise.allSettled([
      left.close(),
      ...(right === undefined ? [] : [right.close()]),
    ]);
  }
}

function requireBoundedRegularFile(
  entry: Stats,
  maxBytes: number,
): void {
  if (
    !entry.isFile()
    || !Number.isSafeInteger(entry.size)
    || entry.size < 0
    || entry.size > maxBytes
  ) {
    throw new Error(`exact comparison input exceeds the ${maxBytes}-byte regular-file limit`);
  }
}

function requireStableFile(
  before: Stats,
  after: Stats,
): void {
  if (
    before.dev !== after.dev
    || before.ino !== after.ino
    || before.size !== after.size
    || before.mtimeMs !== after.mtimeMs
  ) {
    throw new Error("exact comparison file changed while it was read");
  }
}
