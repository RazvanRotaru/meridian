import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { ExtractionResult } from "@meridian/core";
import {
  DIFFERENTIAL_CATEGORIES,
  describeDifferentialCategoryValue,
  type DifferentialCategory,
  type DifferentialMismatch,
  type DifferentialReport,
} from "./differential";
import {
  canonicalJsonBytes,
  sha256Hex,
} from "./canonical-json";
import { exactRegularFilesEqual } from "./exact-file-parity";
import {
  CANONICAL_SEMANTIC_CATEGORY_ORDER,
  semanticExtractionCategory,
} from "./semantic-normalize";

const EVIDENCE_PREFIX = "meridian-extraction-evidence-";
const MAX_EVIDENCE_FILE_BYTES = 512 * 1024 * 1024;

export interface ExactCanonicalEvidence {
  readonly path: string;
  readonly byteSize: number;
  /** Diagnostic only; exact equality always compares the file bytes. */
  readonly digest: string;
}

export interface PersistedExtractionDifferentialEvidence {
  readonly formatVersion: 1;
  readonly directory: string;
  readonly digest: string;
  readonly categories: Record<
    DifferentialCategory,
    ExactCanonicalEvidence & { readonly description: string }
  >;
}

/**
 * Persist canonical semantic bytes before the complete incremental graph is released.
 *
 * Evidence is private, process-owned, and temporary. Digests make mismatch reports useful, but
 * admission is gated by an exact no-follow file comparison against a separately materialized cold
 * oracle.
 */
export function persistExtractionDifferentialEvidence(
  result: ExtractionResult,
): PersistedExtractionDifferentialEvidence {
  const directory = mkdtempSync(join(tmpdir(), EVIDENCE_PREFIX));
  try {
    const categories = {} as PersistedExtractionDifferentialEvidence["categories"];
    const aggregate = createHash("sha256");
    aggregate.update("{");
    for (const [index, category] of CANONICAL_SEMANTIC_CATEGORY_ORDER.entries()) {
      const value = semanticExtractionCategory(result, category);
      const bytes = canonicalJsonBytes(value);
      const evidence = writeCanonicalEvidenceBytes(
        directory,
        `${category}.json`,
        bytes,
      );
      categories[category] = {
        ...evidence,
        description: describeDifferentialCategoryValue(category, value),
      };
      if (index > 0) aggregate.update(",");
      aggregate.update(JSON.stringify(category));
      aggregate.update(":");
      aggregate.update(bytes);
    }
    aggregate.update("}");
    return {
      formatVersion: 1,
      directory,
      digest: aggregate.digest("hex"),
      categories,
    };
  } catch (error) {
    removeEvidenceDirectory(directory);
    throw error;
  }
}

/**
 * Compare a cold graph with persisted incremental evidence category-by-category.
 *
 * A disposable cold evidence directory keeps the comparator bounded to two file chunks even
 * though canonicalization itself still owns one semantic category at a time.
 */
export async function comparePersistedExtractionEvidence(
  incremental: PersistedExtractionDifferentialEvidence,
  cold: ExtractionResult,
): Promise<DifferentialReport> {
  requireEvidenceDirectory(incremental.directory);
  const coldEvidence = persistExtractionDifferentialEvidence(cold);
  try {
    const mismatches: DifferentialMismatch[] = [];
    for (const category of DIFFERENTIAL_CATEGORIES) {
      const incrementalCategory = incremental.categories[category];
      const coldCategory = coldEvidence.categories[category];
      if (await exactRegularFilesEqual(
        incrementalCategory.path,
        coldCategory.path,
        MAX_EVIDENCE_FILE_BYTES,
      )) {
        continue;
      }
      mismatches.push({
        category,
        incrementalDigest: incrementalCategory.digest,
        coldDigest: coldCategory.digest,
        message: [
          `${category} differ`,
          `(incremental ${incrementalCategory.description}, sha256=${incrementalCategory.digest};`,
          `cold ${coldCategory.description}, sha256=${coldCategory.digest})`,
        ].join(" "),
      });
    }
    return {
      equal: mismatches.length === 0,
      incrementalDigest: incremental.digest,
      coldDigest: coldEvidence.digest,
      mismatches,
    };
  } finally {
    disposeExtractionDifferentialEvidence(coldEvidence);
  }
}

/** Write one canonical value beside the semantic category files for exact unit evidence. */
export function writeCanonicalEvidence(
  directoryInput: string,
  fileName: string,
  value: unknown,
): ExactCanonicalEvidence {
  return writeCanonicalEvidenceBytes(
    directoryInput,
    fileName,
    canonicalJsonBytes(value),
  );
}

function writeCanonicalEvidenceBytes(
  directoryInput: string,
  fileName: string,
  bytes: Buffer,
): ExactCanonicalEvidence {
  const directory = requireEvidenceDirectory(directoryInput);
  if (!/^[a-z0-9][a-z0-9-]{0,63}\.json$/.test(fileName)) {
    throw new TypeError("canonical evidence file name is invalid");
  }
  if (bytes.byteLength > MAX_EVIDENCE_FILE_BYTES) {
    throw new Error(`canonical evidence exceeds the ${MAX_EVIDENCE_FILE_BYTES}-byte limit`);
  }
  const path = join(directory, fileName);
  const descriptor = openSync(
    path,
    constants.O_WRONLY
      | constants.O_CREAT
      | constants.O_EXCL
      | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    const entry = fstatSync(descriptor);
    if (!entry.isFile() || entry.size !== bytes.byteLength) {
      throw new Error("canonical evidence was not written as an exact regular file");
    }
  } finally {
    closeSync(descriptor);
  }
  return {
    path,
    byteSize: bytes.byteLength,
    digest: sha256Hex(bytes),
  };
}

export function disposeExtractionDifferentialEvidence(
  evidence: PersistedExtractionDifferentialEvidence,
): void {
  removeEvidenceDirectory(evidence.directory);
}

function requireEvidenceDirectory(directoryInput: string): string {
  const directory = resolve(directoryInput);
  if (
    dirname(directory) !== resolve(tmpdir())
    || !basename(directory).startsWith(EVIDENCE_PREFIX)
  ) {
    throw new Error("extraction differential evidence directory is not process-owned");
  }
  const entry = lstatSync(directory);
  if (!entry.isDirectory() || entry.isSymbolicLink() || (entry.mode & 0o077) !== 0) {
    throw new Error("extraction differential evidence directory is unsafe");
  }
  return directory;
}

function removeEvidenceDirectory(directoryInput: string): void {
  const directory = resolve(directoryInput);
  if (
    dirname(directory) !== resolve(tmpdir())
    || !basename(directory).startsWith(EVIDENCE_PREFIX)
  ) {
    throw new Error("refusing to remove an unowned extraction evidence directory");
  }
  rmSync(directory, { recursive: true, force: true });
}
