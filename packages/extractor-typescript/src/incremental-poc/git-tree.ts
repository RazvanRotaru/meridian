import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  readlinkSync,
  realpathSync,
} from "node:fs";
import {
  isAbsolute as isHostAbsolute,
  posix,
  relative,
  resolve,
  sep,
} from "node:path";
import { TextDecoder } from "node:util";
import type { GitSymlinkInputFingerprint } from "./model";

const MAX_GIT_OUTPUT_BYTES = 128 * 1024 * 1024;
const UTF8 = new TextDecoder("utf-8", { fatal: true });

export interface GitBlobEntry {
  path: string;
  oid: string;
  mode: string;
  byteSize: number;
}

export interface GitCheckoutVerification {
  repoRoot: string;
  expectedTreeOid: string;
  headCommitOid: string;
  headTreeOid: string;
}

export interface VerifiedGitTreeInputs {
  regularBlobs: GitBlobEntry[];
  symlinks: GitSymlinkInputFingerprint[];
}

/** Lists every blob recursively using Git's NUL-delimited tree format (no shell parsing). */
export async function listGitTreeBlobs(repoRoot: string, treeOid: string): Promise<GitBlobEntry[]> {
  const exactTreeOid = normalizeExactOid(treeOid);
  await requireTreeObject(repoRoot, exactTreeOid);
  const output = await runGit(repoRoot, [
    "ls-tree",
    "-r",
    "-z",
    "--full-tree",
    "-l",
    exactTreeOid,
  ]);

  const entries: GitBlobEntry[] = [];
  for (const record of splitNul(output)) {
    const separator = record.indexOf(0x09);
    if (separator < 0) {
      throw new Error("git ls-tree returned a malformed record");
    }
    const header = record.subarray(0, separator).toString("ascii");
    const match = /^([0-7]{6}) ([a-z]+) ([0-9a-f]{40}|[0-9a-f]{64}) +([0-9]+|-)$/.exec(header);
    if (match === null) {
      throw new Error(`git ls-tree returned a malformed header: ${header}`);
    }
    const path = UTF8.decode(record.subarray(separator + 1));
    if (match[2] !== "blob") {
      throw new Error(`exact blob listing cannot represent Git ${match[2]} entry: ${path}`);
    }
    const byteSize = Number(match[4]);
    if (!Number.isSafeInteger(byteSize) || byteSize < 0) {
      throw new Error(`git blob ${match[3]} has an unsupported size`);
    }
    entries.push({
      path,
      oid: match[3],
      mode: match[1],
      byteSize,
    });
  }
  return entries;
}

/**
 * Admits only regular blobs and direct, relative links to tracked regular blobs. The returned
 * symlink topology is portable cache-key input; the checkout observations prove that the host
 * materialized the same topology before TypeScript is allowed to inspect it.
 */
export async function verifyGitTreeInputs(
  repoRoot: string,
  entries: readonly GitBlobEntry[],
): Promise<VerifiedGitTreeInputs> {
  const canonicalRoot = realpathSync(repoRoot);
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  const regularBlobs: GitBlobEntry[] = [];
  const symlinks: GitSymlinkInputFingerprint[] = [];

  for (const entry of entries) {
    if (entry.mode === "100644" || entry.mode === "100755") {
      regularBlobs.push({ ...entry });
      continue;
    }
    if (entry.mode !== "120000") {
      throw new Error(`POC cannot prove extraction through Git mode ${entry.mode}: ${entry.path}`);
    }

    const linkBytes = await readGitBlob(repoRoot, entry);
    const target = UTF8.decode(linkBytes);
    if (target.length === 0 || target.includes("\0") || target.includes("\\")
      || posix.isAbsolute(target)) {
      throw new Error(`tracked symlink has an unsupported target: ${entry.path}`);
    }
    const resolvedPath = posix.normalize(posix.join(posix.dirname(entry.path), target));
    if (resolvedPath === ".." || resolvedPath.startsWith("../") || posix.isAbsolute(resolvedPath)) {
      throw new Error(`tracked symlink escapes the repository: ${entry.path}`);
    }
    const resolved = byPath.get(resolvedPath);
    if (resolved === undefined) {
      throw new Error(`tracked symlink target is not in the exact Git tree: ${entry.path}`);
    }
    if (resolved.mode !== "100644" && resolved.mode !== "100755") {
      throw new Error(`tracked symlink target is not a regular Git blob: ${entry.path}`);
    }

    const absoluteLink = repositoryPath(repoRoot, entry.path);
    const absoluteTarget = repositoryPath(repoRoot, resolvedPath);
    if (!lstatSync(absoluteLink).isSymbolicLink()) {
      throw new Error(`tracked symlink is not materialized as a symlink: ${entry.path}`);
    }
    const observedTarget = readlinkSync(absoluteLink, { encoding: "buffer" });
    if (!Buffer.isBuffer(observedTarget) || !observedTarget.equals(linkBytes)) {
      throw new Error(`tracked symlink bytes differ from Git tree: ${entry.path}`);
    }
    if (!lstatSync(absoluteTarget).isFile()) {
      throw new Error(`tracked symlink target is not a regular checkout file: ${entry.path}`);
    }
    const expectedRealpath = resolve(canonicalRoot, ...resolvedPath.split("/"));
    if (realpathSync(absoluteLink) !== expectedRealpath || realpathSync(absoluteTarget) !== expectedRealpath) {
      throw new Error(`tracked symlink realpath differs from Git topology: ${entry.path}`);
    }
    verifyGitBlobBytes(readFileSync(absoluteTarget), resolved);

    symlinks.push({
      path: entry.path,
      linkBlobOid: entry.oid,
      linkByteSize: entry.byteSize,
      target,
      resolvedPath,
      resolvedBlobOid: resolved.oid,
      resolvedMode: resolved.mode,
      resolvedByteSize: resolved.byteSize,
    });
  }

  return { regularBlobs, symlinks };
}

/**
 * Verifies that HEAD names the requested exact tree and that Git sees no tracked, staged,
 * untracked, or dirty-submodule changes. HEAD is re-read after status to catch revision races.
 */
export async function verifyCleanCheckoutAtTree(
  repoRoot: string,
  expectedTreeOid: string,
): Promise<GitCheckoutVerification> {
  const expected = normalizeExactOid(expectedTreeOid);
  await requireTreeObject(repoRoot, expected);

  const before = await readHeadIdentity(repoRoot);
  if (before.treeOid !== expected) {
    throw new Error(`HEAD tree ${before.treeOid} does not match requested tree ${expected}`);
  }

  const status = await runGit(repoRoot, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    "--ignore-submodules=none",
  ]);
  if (status.byteLength !== 0) {
    throw new Error(`checkout is not clean (${splitNul(status).length} status record(s))`);
  }

  const after = await readHeadIdentity(repoRoot);
  if (after.commitOid !== before.commitOid || after.treeOid !== before.treeOid) {
    throw new Error("HEAD changed while checkout cleanliness was being verified");
  }
  return {
    repoRoot,
    expectedTreeOid: expected,
    headCommitOid: after.commitOid,
    headTreeOid: after.treeOid,
  };
}

async function readHeadIdentity(repoRoot: string): Promise<{ commitOid: string; treeOid: string }> {
  const [commit, tree] = await Promise.all([
    runGit(repoRoot, ["rev-parse", "--verify", "HEAD^{commit}"]),
    runGit(repoRoot, ["rev-parse", "--verify", "HEAD^{tree}"]),
  ]);
  return {
    commitOid: normalizeGitOutputOid(commit),
    treeOid: normalizeGitOutputOid(tree),
  };
}

async function requireTreeObject(repoRoot: string, oid: string): Promise<void> {
  const type = (await runGit(repoRoot, ["cat-file", "-t", oid])).toString("ascii").trim();
  if (type !== "tree") {
    throw new Error(`Git object ${oid} is ${type}, not a tree`);
  }
}

function normalizeGitOutputOid(output: Buffer): string {
  return normalizeExactOid(output.toString("ascii").trim());
}

function normalizeExactOid(oid: string): string {
  if (!/^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/.test(oid)) {
    throw new TypeError("expected an exact 40- or 64-character Git object ID");
  }
  return oid.toLowerCase();
}

async function readGitBlob(repoRoot: string, entry: GitBlobEntry): Promise<Buffer> {
  const type = (await runGit(repoRoot, ["cat-file", "-t", entry.oid])).toString("ascii").trim();
  if (type !== "blob") {
    throw new Error(`Git object ${entry.oid} is ${type}, not a blob`);
  }
  const bytes = await runGit(repoRoot, ["cat-file", "blob", entry.oid]);
  if (bytes.byteLength !== entry.byteSize) {
    throw new Error(`git blob ${entry.oid} size differs from its tree entry`);
  }
  return bytes;
}

function repositoryPath(repoRoot: string, relativePath: string): string {
  const root = resolve(repoRoot);
  const absolute = resolve(root, ...relativePath.split("/"));
  const rel = relative(root, absolute);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isHostAbsolute(rel)) {
    throw new Error(`Git tree path escapes the repository: ${relativePath}`);
  }
  return absolute;
}

function verifyGitBlobBytes(bytes: Buffer, entry: GitBlobEntry): void {
  // Ask Git to hash with the repository's configured object format.
  // This keeps SHA-1 and SHA-256 repositories on the same verification path.
  const algorithm = entry.oid.length === 40 ? "sha1" : entry.oid.length === 64 ? "sha256" : null;
  if (algorithm === null) throw new Error(`unsupported Git object id length: ${entry.oid.length}`);
  const actual = createHash(algorithm)
    .update(`blob ${bytes.byteLength}\0`)
    .update(bytes)
    .digest("hex");
  if (actual !== entry.oid) {
    throw new Error(`tracked symlink target bytes differ from Git tree: ${entry.path}`);
  }
}

function splitNul(output: Buffer): Buffer[] {
  const records: Buffer[] = [];
  let start = 0;
  for (let cursor = 0; cursor < output.length; cursor += 1) {
    if (output[cursor] === 0) {
      records.push(output.subarray(start, cursor));
      start = cursor + 1;
    }
  }
  if (start !== output.length) {
    throw new Error("Git returned a non-NUL-terminated record");
  }
  return records.filter((record) => record.byteLength > 0);
}

function runGit(repoRoot: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["-C", repoRoot, ...args],
      { encoding: "buffer", maxBuffer: MAX_GIT_OUTPUT_BYTES },
      (error, stdout, stderr) => {
        if (error !== null) {
          const detail = Buffer.isBuffer(stderr) ? stderr.toString("utf8").trim() : String(stderr).trim();
          reject(new Error(`git ${args[0]} failed${detail === "" ? "" : `: ${detail}`}`, { cause: error }));
          return;
        }
        resolve(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout));
      },
    );
  });
}
