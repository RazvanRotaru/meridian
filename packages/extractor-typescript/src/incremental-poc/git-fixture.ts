import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { FIXTURE_SOURCE_FILES } from "./fixture-source";

const OBJECT_OID = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const COMMIT_EPOCH_MS = Date.UTC(2000, 0, 1);

export interface GitFixtureRevision {
  commitOid: string;
  treeOid: string;
}

export interface GitMonorepoFixture {
  /** Canonical path to the tracked repository consumed by the extractor. */
  readonly root: string;
  /** Persistent-across-checkout cache directory outside the tracked repository. */
  readonly cacheDir: string;
  readonly seedRevision: GitFixtureRevision;
  writeFile(path: string, contents: string): void;
  readFile(path: string): string;
  removeFile(path: string): void;
  renameFile(from: string, to: string): void;
  commit(message: string, options?: { allowEmpty?: boolean }): GitFixtureRevision;
  currentRevision(): GitFixtureRevision;
  checkoutExact(revision: GitFixtureRevision | string): GitFixtureRevision;
  cleanup(): void;
}

/** Create a disposable real-Git, three-package TypeScript workspace and its initial revision. */
export function createGitMonorepoFixture(): GitMonorepoFixture {
  const ownerRoot = realpathSync(mkdtempSync(join(tmpdir(), "meridian-incremental-git-")));
  const root = join(ownerRoot, "repository");
  const cacheDir = join(ownerRoot, "shard-cache");
  mkdirSync(root, { mode: 0o700 });
  mkdirSync(cacheDir, { mode: 0o700 });
  initializeRepository(root);

  let active = true;
  let commitOrdinal = 0;
  const requireActive = (): void => {
    if (!active) throw new Error("Git fixture has already been cleaned up");
  };
  const write = (path: string, contents: string): void => {
    requireActive();
    const absolute = fixturePath(root, path);
    mkdirSync(resolve(absolute, ".."), { recursive: true });
    writeFileSync(absolute, contents, { encoding: "utf8", mode: 0o600 });
  };
  for (const [path, contents] of Object.entries(FIXTURE_SOURCE_FILES).sort(([left], [right]) => (
    left < right ? -1 : left > right ? 1 : 0
  ))) {
    write(path, contents);
  }

  const commit = (message: string, options: { allowEmpty?: boolean } = {}): GitFixtureRevision => {
    requireActive();
    const cleanMessage = message.trim();
    if (cleanMessage.length === 0 || cleanMessage.includes("\0")) {
      throw new Error("Git fixture commit message must be non-empty");
    }
    git(root, ["add", "--all", "--", "."]);
    const date = new Date(COMMIT_EPOCH_MS + commitOrdinal * 1_000).toISOString();
    commitOrdinal += 1;
    git(
      root,
      [
        "commit",
        "--no-gpg-sign",
        "--no-verify",
        ...(options.allowEmpty ? ["--allow-empty"] : []),
        "--message",
        cleanMessage,
      ],
      {
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_DATE: date,
      },
    );
    return revisionAt(root, "HEAD");
  };

  const seedRevision = commit("seed incremental extraction fixture");
  return {
    root,
    cacheDir,
    seedRevision,
    writeFile: write,
    readFile: (path) => {
      requireActive();
      return readFileSync(fixturePath(root, path), "utf8");
    },
    removeFile: (path) => {
      requireActive();
      const absolute = fixturePath(root, path);
      requireRegularFile(absolute, "remove");
      unlinkSync(absolute);
    },
    renameFile: (from, to) => {
      requireActive();
      const source = fixturePath(root, from);
      const destination = fixturePath(root, to);
      requireRegularFile(source, "rename");
      if (existsSync(destination)) {
        throw new Error(`Git fixture rename destination already exists: ${to}`);
      }
      mkdirSync(resolve(destination, ".."), { recursive: true });
      renameSync(source, destination);
    },
    commit,
    currentRevision: () => {
      requireActive();
      return revisionAt(root, "HEAD");
    },
    checkoutExact: (revision) => {
      requireActive();
      const expectedCommit = typeof revision === "string"
        ? requireOid(revision)
        : requireOid(revision.commitOid);
      const expectedTree = typeof revision === "string" ? undefined : requireOid(revision.treeOid);
      // The repository and every untracked entry below it are owned by this fixture.
      git(root, ["clean", "-d", "-f", "-x"]);
      git(root, ["checkout", "--detach", "--force", expectedCommit]);
      const actual = revisionAt(root, "HEAD");
      if (actual.commitOid !== expectedCommit
        || (expectedTree !== undefined && actual.treeOid !== expectedTree)) {
        throw new Error("Git fixture checkout did not materialize the requested exact revision");
      }
      if (git(root, ["status", "--porcelain=v1", "--untracked-files=all"]).length !== 0) {
        throw new Error("Git fixture checkout is not clean");
      }
      return actual;
    },
    cleanup: () => {
      if (!active) return;
      active = false;
      rmSync(ownerRoot, { recursive: true, force: true });
    },
  };
}

function initializeRepository(root: string): void {
  git(root, ["init", "--initial-branch=main"]);
  for (const [key, value] of [
    ["user.name", "Meridian Fixture"],
    ["user.email", "fixture@meridian.invalid"],
    ["commit.gpgSign", "false"],
    ["core.autocrlf", "false"],
    ["core.fileMode", "false"],
  ]) {
    git(root, ["config", "--local", key, value]);
  }
}

function revisionAt(root: string, ref: string): GitFixtureRevision {
  return {
    commitOid: requireOid(git(root, ["rev-parse", `${ref}^{commit}`])),
    treeOid: requireOid(git(root, ["rev-parse", `${ref}^{tree}`])),
  };
}

function fixturePath(root: string, path: string): string {
  if (!path || path.includes("\0") || path.includes("\\") || isAbsolute(path)
    || path.split("/").some((part) => part === "" || part === "." || part === ".." || part === ".git")) {
    throw new Error(`Git fixture path must be a safe repository-relative POSIX path: ${path}`);
  }
  const absolute = resolve(root, path);
  const rel = relative(root, absolute);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Git fixture path escapes its repository: ${path}`);
  }
  return absolute;
}

function requireRegularFile(path: string, operation: string): void {
  let regular = false;
  try {
    regular = lstatSync(path).isFile();
  } catch {
    // The stable fixture error below is more useful than an OS-specific lstat error.
  }
  if (!regular) throw new Error(`Git fixture can only ${operation} an existing regular file`);
}

function requireOid(value: string): string {
  const oid = value.trim().toLowerCase();
  if (!OBJECT_OID.test(oid)) throw new Error(`Git returned an invalid object id: ${value}`);
  return oid;
}

function git(root: string, args: string[], extraEnvironment: NodeJS.ProcessEnv = {}): string {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      LC_ALL: "C",
      TZ: "UTC",
      ...extraEnvironment,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw new Error(`could not run Git fixture command: ${result.error.message}`);
  if (result.status !== 0) {
    const reason = result.stderr.trim().split(/\r?\n/).slice(-3).join(" ");
    throw new Error(`Git fixture command failed (${args[0] ?? "git"}): ${reason || `exit ${result.status}`}`);
  }
  return result.stdout.trim();
}
