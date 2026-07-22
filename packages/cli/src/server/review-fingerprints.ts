/** Build review fingerprints while the disposable worker owns the artifact and checkout. */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import {
  NON_BLOCK_KINDS,
  REVIEW_FINGERPRINT_EXTENSION,
  REVIEW_FINGERPRINT_VERSION,
  changedFileManifestFromExtensions,
  type GraphArtifact,
  type GraphNode,
  type JsonValue,
  type ReviewContentFingerprint,
  type ReviewFingerprintExtension,
} from "@meridian/core";
import type { ReviewFingerprintSelection } from "./repository-analysis-worker-job";

const MAX_ENTRIES = 100_000;
const MAX_TEXT_BYTES = 16 * 1024 * 1024;

export function withReviewFingerprints(
  artifact: GraphArtifact,
  absoluteRoot: string,
  selection: ReviewFingerprintSelection = { mode: "all" },
): GraphArtifact {
  const units: Record<string, ReviewContentFingerprint> = {};
  const files: Record<string, ReviewContentFingerprint> = {};
  const manifestFiles = (changedFileManifestFromExtensions(artifact.extensions) ?? [])
    .filter((entry) => entry.status !== "deleted")
    .map((entry) => normalizePath(entry.path));
  const selectedFiles = selection.mode === "all"
    ? null
    : new Set(selection.mode === "changed" ? manifestFiles : selection.files.map(normalizePath));
  const nodesByFile = new Map<string, GraphNode[]>();
  const addressCounts = new Map<string, number>();
  for (const node of artifact.nodes) {
    if (NON_BLOCK_KINDS.has(node.kind)) continue;
    const file = normalizePath(node.location.file);
    if (selectedFiles !== null && !selectedFiles.has(file)) continue;
    const bucket = nodesByFile.get(file);
    bucket ? bucket.push(node) : nodesByFile.set(file, [node]);
    const address = semanticAddress(file, node);
    addressCounts.set(address, (addressCounts.get(address) ?? 0) + 1);
  }
  const filePaths = new Set<string>([
    ...(selectedFiles ?? []),
    ...nodesByFile.keys(),
    ...artifact.nodes
      .filter((node) => node.kind === "module")
      .map((node) => normalizePath(node.location.file))
      .filter((file) => selectedFiles === null || selectedFiles.has(file)),
    ...manifestFiles.filter((file) => selectedFiles === null || selectedFiles.has(file)),
  ]);
  let complete = true;
  let entries = 0;
  let textBytes = 0;
  const addresses = new Set<string>();

  for (const file of [...filePaths].sort()) {
    const sourcePath = sourcePathWithin(absoluteRoot, file);
    if (sourcePath === null) {
      complete = false;
      continue;
    }
    let bytes: Buffer;
    try {
      bytes = readFileSync(sourcePath);
    } catch {
      complete = false;
      continue;
    }
    const fileAddress = `file:v1\0${file}`;
    if (!add(files, file, fileAddress, sha256(bytes))) {
      complete = false;
      continue;
    }
    const offsets = lineOffsets(bytes);
    for (const node of nodesByFile.get(file) ?? []) {
      const address = semanticAddress(file, node);
      if (addressCounts.get(address) !== 1) {
        complete = false;
        continue;
      }
      const start = offsets[node.location.startLine - 1];
      const end = offsets[node.location.endLine ?? node.location.startLine];
      if (start === undefined || end === undefined || end < start) {
        complete = false;
        continue;
      }
      if (!add(units, node.id, address, sha256(bytes.subarray(start, end)))) complete = false;
    }
  }

  const extension: ReviewFingerprintExtension = {
    version: REVIEW_FINGERPRINT_VERSION,
    algorithm: "sha256-source-bytes",
    complete,
    units,
    files,
  };
  return {
    ...artifact,
    extensions: {
      ...artifact.extensions,
      [REVIEW_FINGERPRINT_EXTENSION]: extension as unknown as JsonValue,
    },
  };

  function add(
    target: Record<string, ReviewContentFingerprint>,
    key: string,
    address: string,
    digest: string,
  ): boolean {
    const addedBytes = key.length + address.length + digest.length;
    if (entries >= MAX_ENTRIES || textBytes + addedBytes > MAX_TEXT_BYTES || addresses.has(address)) return false;
    target[key] = { address, digest };
    addresses.add(address);
    entries += 1;
    textBytes += addedBytes;
    return true;
  }
}

function semanticAddress(file: string, node: GraphNode): string {
  return `unit:v1\0${file}\0${node.kind}\0${node.qualifiedName}`;
}

function sourcePathWithin(root: string, file: string): string | null {
  if (!file || isAbsolute(file) || file.split("/").some((part) => part === "" || part === "." || part === "..")) return null;
  const path = resolve(root, file);
  const rel = relative(root, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel) ? path : null;
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/");
}

function lineOffsets(bytes: Buffer): number[] {
  const offsets = [0];
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] === 0x0a) offsets.push(index + 1);
  }
  if (offsets[offsets.length - 1] !== bytes.length) offsets.push(bytes.length);
  return offsets;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
