/** Deterministic source/config fingerprint for advertised synthetic scenarios. */

import { createHash, type Hash } from "node:crypto";
import {
  closeSync,
  existsSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { isAbsolute, posix, relative, resolve, sep } from "node:path";
import type { GraphArtifact } from "@meridian/core";
import { SyntheticExecutionError } from "./synthetic-error";
import { discoverSyntheticManifestFiles } from "./synthetic-manifest-files";

const OPTIONAL_CONFIG = ["package.json", "tsconfig.json"] as const;
const NON_SOURCE_KINDS = new Set(["package", "external", "unresolved", "channel", "system"]);
const READ_BUFFER_BYTES = 64 * 1024;

/**
 * Hash the exact repository inputs that make an advertised synthetic run meaningful. Artifact
 * metadata itself is intentionally excluded: callers already bind the selected root separately,
 * while this guard detects source/config replacement between advertisement and execution.
 */
export function syntheticSourceFingerprint(sourceRoot: string, artifact: GraphArtifact): string {
  const root = canonicalRoot(sourceRoot);
  const hash = createHash("sha256");
  hash.update("meridian-synthetic-source-v1\0");

  const manifests = discoverSyntheticManifestFiles(root);
  if (manifests.length === 0) {
    throw new SyntheticExecutionError("invalid-manifest", 400, "Synthetic execution manifest is unavailable.");
  }
  for (const manifest of manifests) {
    const path = canonicalFile(root, manifest.logicalPath, true);
    addFile(hash, `config:${manifest.logicalPath}`, path!);
  }
  const optionalConfigs = new Set<string>(OPTIONAL_CONFIG);
  for (const manifest of manifests) {
    for (const name of OPTIONAL_CONFIG) {
      optionalConfigs.add(manifest.logicalDirectory === "" ? name : posix.join(manifest.logicalDirectory, name));
    }
  }
  for (const name of [...optionalConfigs].sort()) {
    const path = canonicalFile(root, name, false);
    if (path !== null) addFile(hash, `config:${name}`, path);
  }

  const logicalFiles = [...new Set(artifact.nodes
    .filter((node) => !NON_SOURCE_KINDS.has(node.kind))
    .map((node) => normalizeLogicalPath(node.location.file))
    .filter((file): file is string => file !== null))].sort();
  for (const logicalFile of logicalFiles) {
    const path = canonicalFile(root, logicalFile, false);
    if (path !== null) addFile(hash, `source:${logicalFile}`, path);
  }
  return hash.digest("hex");
}

function canonicalRoot(path: string): string {
  try {
    const canonical = realpathSync.native(resolve(path));
    if (!statSync(canonical).isDirectory()) throw new Error("not a directory");
    return canonical;
  } catch {
    throw new SyntheticExecutionError("invalid-request", 400, "Synthetic execution source root is unavailable.");
  }
}

function canonicalFile(root: string, logicalPath: string, required: boolean): string | null {
  const lexical = resolve(root, logicalPath);
  if (!isWithin(root, lexical)) {
    throw new SyntheticExecutionError("invalid-request", 400, "Synthetic execution source path escapes its root.");
  }
  if (!existsSync(lexical)) {
    if (required) throw new SyntheticExecutionError("invalid-manifest", 400, "Synthetic execution manifest is unavailable.");
    return null;
  }
  try {
    const canonical = realpathSync.native(lexical);
    if (!isWithin(root, canonical)) {
      throw new SyntheticExecutionError("invalid-request", 400, "Synthetic execution source path escapes its root.");
    }
    if (!statSync(canonical).isFile()) {
      if (required) throw new Error("not a file");
      return null;
    }
    return canonical;
  } catch (error) {
    if (error instanceof SyntheticExecutionError) throw error;
    throw new SyntheticExecutionError("invalid-request", 400, "Synthetic execution source files could not be read.");
  }
}

function normalizeLogicalPath(path: string): string | null {
  const normalized = path.replaceAll("\\", "/");
  if (normalized.length === 0) return null;
  if (isAbsolute(normalized) || /^[A-Za-z]:\//.test(normalized) || normalized.split("/").includes("..")) {
    throw new SyntheticExecutionError("invalid-request", 400, "Synthetic execution source path escapes its root.");
  }
  const logical = posix.normalize(normalized);
  return logical === "." ? null : logical;
}

function addFile(hash: Hash, label: string, path: string): void {
  try {
    const size = statSync(path).size;
    hash.update(`${label.length}:${label}:${size}:`);
    const descriptor = openSync(path, "r");
    const buffer = Buffer.allocUnsafe(READ_BUFFER_BYTES);
    try {
      let bytesRead = 0;
      do {
        bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
        if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
      } while (bytesRead > 0);
    } finally {
      closeSync(descriptor);
    }
    hash.update("\0");
  } catch {
    throw new SyntheticExecutionError("invalid-request", 400, "Synthetic execution source files could not be read.");
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relativePath = relative(resolve(root), resolve(candidate));
  return relativePath === "" || (!relativePath.startsWith(`..${sep}`) && relativePath !== ".." && !isAbsolute(relativePath));
}
