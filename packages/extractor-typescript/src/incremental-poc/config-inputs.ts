import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { ts } from "ts-morph";
import {
  absoluteRoot,
  isUnderRoot,
  relativeToRoot,
  toPosix,
} from "../paths";
import { compareCanonicalStrings, sha256Hex } from "./canonical-json";
import type {
  GitBlobIdentity,
  ReuseEligibilityFingerprint,
} from "./model";

export type TypeScriptConfigPathState =
  | "absent"
  | "file"
  | "directory"
  | "symlink"
  | "other";

export interface TypeScriptConfigSelectionProbe {
  role: "unit" | "root";
  address: string;
  exists: boolean;
  state: TypeScriptConfigPathState;
}

export interface TypeScriptConfigFileInput {
  address: string;
  digest: string;
  byteSize: number;
  trackedBlobOid: string | null;
  trackedMode: string | null;
}

export interface TypeScriptConfigExtendsInput {
  from: string;
  index: number;
  specifier: string;
  resolvedAddress: string | null;
}

/**
 * Exact per-unit config provenance for the current `loadUnitProject` selection rule.
 *
 * Selection probes contain only path state: bytes from an unchosen root config cannot affect a
 * unit whose own config won. Every regular file in the selected local `extends` graph is then
 * content-addressed. Unsupported inputs are still represented, but make the result ineligible.
 */
export interface TypeScriptConfigInputFingerprint {
  selectedConfigAddress: string | null;
  selectionProbes: TypeScriptConfigSelectionProbe[];
  configFiles: TypeScriptConfigFileInput[];
  extendsInputs: TypeScriptConfigExtendsInput[];
  reuseEligibility: ReuseEligibilityFingerprint;
}

export function typeScriptConfigInputs(
  rootInput: string,
  unitDir: string,
  treeBlobs: readonly GitBlobIdentity[],
): TypeScriptConfigInputFingerprint {
  const root = absoluteRoot(rootInput);
  requireUnitDir(unitDir);
  const trackedByPath = trackedBlobMap(treeBlobs);
  const unitConfigPath = unitDir === ""
    ? resolve(root, "tsconfig.json")
    : resolve(root, ...unitDir.split("/"), "tsconfig.json");
  const rootConfigPath = resolve(root, "tsconfig.json");
  const unitProbe = selectionProbe(root, unitConfigPath, "unit");
  const rootProbe = selectionProbe(root, rootConfigPath, "root");
  const selectedPath = unitProbe.exists
    ? unitConfigPath
    : rootProbe.exists
      ? rootConfigPath
      : null;
  const reasons = new Set<string>();
  const configFiles = new Map<string, TypeScriptConfigFileInput>();
  const extendsInputs: TypeScriptConfigExtendsInput[] = [];
  if (selectedPath !== null) {
    visitConfig(
      root,
      selectedPath,
      trackedByPath,
      configFiles,
      extendsInputs,
      reasons,
      new Set(),
      new Set(),
    );
  }
  const sortedReasons = [...reasons].sort(compareCanonicalStrings);
  return {
    selectedConfigAddress: selectedPath === null ? null : repoAddress(root, selectedPath),
    selectionProbes: [unitProbe, rootProbe],
    configFiles: [...configFiles.values()]
      .sort((left, right) => compareCanonicalStrings(left.address, right.address)),
    extendsInputs: extendsInputs
      .sort((left, right) => compareExtendsInput(left, right)),
    reuseEligibility: {
      eligible: sortedReasons.length === 0,
      reasons: sortedReasons,
    },
  };
}

function visitConfig(
  root: string,
  pathInput: string,
  trackedByPath: ReadonlyMap<string, GitBlobIdentity>,
  configFiles: Map<string, TypeScriptConfigFileInput>,
  extendsInputs: TypeScriptConfigExtendsInput[],
  reasons: Set<string>,
  active: Set<string>,
  complete: Set<string>,
): void {
  const path = toPosix(pathInput);
  const address = repoAddress(root, path);
  if (complete.has(address)) return;
  if (active.has(address)) {
    reasons.add("cyclic-config-extends");
    return;
  }
  active.add(address);
  try {
    const observed = inspectPath(path);
    if (observed.state === "symlink") {
      reasons.add("unsupported-config-symlink");
      return;
    }
    if (observed.state === "absent") {
      reasons.add("unresolved-config-input");
      return;
    }
    if (observed.state !== "file") {
      reasons.add("unsupported-config-input-kind");
      return;
    }

    const bytes = readFileSync(path);
    const relative = relativeToRoot(root, path);
    const tracked = trackedByPath.get(relative) ?? null;
    if (tracked === null) {
      reasons.add("untracked-config-input");
    } else {
      verifyTrackedBytes(bytes, tracked, address);
    }
    configFiles.set(address, {
      address,
      digest: sha256Hex(bytes),
      byteSize: bytes.byteLength,
      trackedBlobOid: tracked?.oid ?? null,
      trackedMode: tracked?.mode ?? null,
    });

    const parsed = ts.parseConfigFileTextToJson(path, bytes.toString("utf8"));
    if (parsed.error !== undefined || !isPlainRecord(parsed.config)) {
      reasons.add("malformed-config-input");
      return;
    }
    const specifiers = configExtendsSpecifiers(parsed.config.extends);
    if (specifiers === null) {
      reasons.add("invalid-config-extends");
      return;
    }
    for (const [index, specifier] of specifiers.entries()) {
      const resolvedPath = resolveLocalExtends(root, path, specifier, reasons);
      const resolvedAddress = resolvedPath === null ? null : repoAddress(root, resolvedPath);
      extendsInputs.push({
        from: address,
        index,
        specifier,
        resolvedAddress,
      });
      if (resolvedPath !== null) {
        visitConfig(
          root,
          resolvedPath,
          trackedByPath,
          configFiles,
          extendsInputs,
          reasons,
          active,
          complete,
        );
      }
    }
    complete.add(address);
  } finally {
    active.delete(address);
  }
}

function configExtendsSpecifiers(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
    return [...value];
  }
  return null;
}

/**
 * TypeScript checks a relative path exactly and then appends `.json` when needed. Package-name
 * resolution and absolute paths are deliberately outside this POC's portable eligibility domain.
 */
function resolveLocalExtends(
  root: string,
  fromPath: string,
  specifierInput: string,
  reasons: Set<string>,
): string | null {
  const specifier = specifierInput.replaceAll("\\", "/");
  if (specifier.length === 0 || specifier.includes("\0")) {
    reasons.add("unresolved-config-extends");
    return null;
  }
  if (isAbsolute(specifier)) {
    reasons.add("external-config-extends");
    return null;
  }
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
    reasons.add("unsupported-package-config-extends");
    return null;
  }
  const exact = toPosix(resolve(dirname(fromPath), ...specifier.split("/")));
  const relative = relativeToRoot(root, exact);
  if (!isUnderRoot(relative)) {
    reasons.add("external-config-extends");
    return null;
  }
  if (isFileLike(exact)) return exact;
  if (!exact.endsWith(".json")) {
    const withJson = `${exact}.json`;
    if (isFileLike(withJson)) return withJson;
  }
  reasons.add("unresolved-config-extends");
  return null;
}

function isFileLike(path: string): boolean {
  try {
    const entry = lstatSync(path);
    if (entry.isFile()) return true;
    return entry.isSymbolicLink() && statSync(path).isFile();
  } catch {
    return false;
  }
}

function selectionProbe(
  root: string,
  path: string,
  role: TypeScriptConfigSelectionProbe["role"],
): TypeScriptConfigSelectionProbe {
  return {
    role,
    address: repoAddress(root, path),
    exists: existsSync(path),
    state: inspectPath(path).state,
  };
}

function inspectPath(path: string): { state: TypeScriptConfigPathState } {
  try {
    const entry = lstatSync(path);
    return {
      state: entry.isFile()
        ? "file"
        : entry.isDirectory()
          ? "directory"
          : entry.isSymbolicLink()
            ? "symlink"
            : "other",
    };
  } catch (error) {
    if (filesystemErrorCode(error) === "ENOENT" || filesystemErrorCode(error) === "ENOTDIR") {
      return { state: "absent" };
    }
    throw error;
  }
}

function repoAddress(root: string, path: string): string {
  const relative = relativeToRoot(root, path);
  if (!isUnderRoot(relative)) {
    throw new Error(`TypeScript config input escapes the repository: ${path}`);
  }
  return `repo:${relative}`;
}

function trackedBlobMap(
  treeBlobs: readonly GitBlobIdentity[],
): ReadonlyMap<string, GitBlobIdentity> {
  const byPath = new Map<string, GitBlobIdentity>();
  for (const blob of treeBlobs) {
    if (byPath.has(blob.path)) {
      throw new Error(`duplicate Git blob identity: ${blob.path}`);
    }
    byPath.set(blob.path, blob);
  }
  return byPath;
}

function verifyTrackedBytes(
  bytes: Buffer,
  tracked: GitBlobIdentity,
  address: string,
): void {
  const algorithm = tracked.oid.length === 40
    ? "sha1"
    : tracked.oid.length === 64
      ? "sha256"
      : null;
  if (algorithm === null) {
    throw new Error(`unsupported Git object id length for config input: ${address}`);
  }
  const actual = createHash(algorithm)
    .update(`blob ${bytes.byteLength}\0`)
    .update(bytes)
    .digest("hex");
  if (actual !== tracked.oid || bytes.byteLength !== tracked.byteSize) {
    throw new Error(`TypeScript config bytes differ from Git tree: ${address}`);
  }
}

function requireUnitDir(unitDir: string): void {
  if (
    isAbsolute(unitDir)
    || unitDir.includes("\\")
    || unitDir.split("/").some(
      (segment) => segment === "." || segment === ".." || (segment === "" && unitDir !== ""),
    )
  ) {
    throw new TypeError(`workspace unit directory must be root-relative POSIX: ${unitDir}`);
  }
}

function compareExtendsInput(
  left: TypeScriptConfigExtendsInput,
  right: TypeScriptConfigExtendsInput,
): number {
  const from = compareCanonicalStrings(left.from, right.from);
  if (from !== 0) return from;
  if (left.index !== right.index) return left.index - right.index;
  return compareCanonicalStrings(left.specifier, right.specifier);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function filesystemErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}
