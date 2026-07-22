import { createHash } from "node:crypto";
import { join } from "node:path";
import { buildCloneArgs, parseGitHubSource } from "./clone";
import type { GenerateRequest } from "./web-request";
import { runGit, runGitClone } from "./git-exec";
import { isOperationCancelled, throwIfAborted } from "./web-cancellation";
import { WebError } from "./web-error";
import type { PhaseAdmission } from "./web-analysis-coordinator";
import {
  createStageDirectory,
  isDirectory,
  publishImmutable,
  readJson,
  removeEntry,
  writePrivateJson,
} from "./web-cache-storage";

const CACHE_FORMAT_VERSION = 2;
const COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;

export interface CachedCheckout {
  branch?: string;
  cache: "hit" | "miss";
  commit: string;
  repoDir: string;
  repositoryKey: string;
  remoteUrl: string;
}

interface CheckoutMetadata {
  formatVersion: number;
  repositoryKey: string;
  commit: string;
  remoteUrl: string;
}

export async function checkoutFor(
  cacheRoot: string,
  request: GenerateRequest,
  cwd: string,
  runPreparation: PhaseAdmission,
  token?: string,
  onClone: () => void | Promise<void> = () => {},
  signal?: AbortSignal,
): Promise<CachedCheckout> {
  throwIfAborted(signal);
  const { advertised, parent, remoteUrl, repositoryKey } = await checkoutIdentity(cacheRoot, request, cwd, token, signal);
  const advertisedEntry = join(parent, advertised.commit);
  if (await validCheckout(advertisedEntry, repositoryKey, advertised.commit, remoteUrl, signal)) {
    return { ...advertised, cache: "hit", repoDir: join(advertisedEntry, "repo"), repositoryKey, remoteUrl };
  }
  return runPreparation(async () => {
    // Another semantic key can resolve to the same immutable commit while this request waits for a
    // preparation slot. Recheck under admission so it reuses the winner instead of cloning twice.
    if (await validCheckout(advertisedEntry, repositoryKey, advertised.commit, remoteUrl, signal)) {
      return { ...advertised, cache: "hit", repoDir: join(advertisedEntry, "repo"), repositoryKey, remoteUrl };
    }
    throwIfAborted(signal);
    removeEntry(advertisedEntry);
    await onClone();
    throwIfAborted(signal);
    return cloneCheckout(parent, repositoryKey, remoteUrl, request.ref, advertised.branch, token, signal);
  });
}

export async function probeCheckout(
  cacheRoot: string,
  request: GenerateRequest,
  cwd: string,
  token?: string,
  signal?: AbortSignal,
): Promise<CachedCheckout | null> {
  throwIfAborted(signal);
  const { advertised, parent, remoteUrl, repositoryKey } = await checkoutIdentity(cacheRoot, request, cwd, token, signal);
  const entry = join(parent, advertised.commit);
  if (!(await validCheckout(entry, repositoryKey, advertised.commit, remoteUrl, signal))) {
    return null;
  }
  return { ...advertised, cache: "hit", repoDir: join(entry, "repo"), repositoryKey, remoteUrl };
}

async function checkoutIdentity(
  cacheRoot: string,
  request: GenerateRequest,
  cwd: string,
  token?: string,
  signal?: AbortSignal,
): Promise<{ advertised: { branch?: string; commit: string }; parent: string; remoteUrl: string; repositoryKey: string }> {
  const remoteUrl = parseGitHubSource(request.value);
  const repositoryKey = repositoryCacheKey(remoteUrl);
  return {
    advertised: await remoteCommit(remoteUrl, request.ref, cwd, token, signal),
    parent: join(cacheRoot, "repositories", repositoryKey),
    remoteUrl,
    repositoryKey,
  };
}

async function cloneCheckout(
  parent: string,
  repositoryKey: string,
  remoteUrl: string,
  ref: string | undefined,
  branch: string | undefined,
  token: string | undefined,
  signal?: AbortSignal,
): Promise<CachedCheckout> {
  const stage = createStageDirectory(parent);
  const stagedRepo = join(stage, "repo");
  try {
    await runGitClone(buildCloneArgs(remoteUrl, stagedRepo, { ref, token }), token, { signal });
    const commit = requireCommit((await runGit(["rev-parse", "HEAD"], { cwd: stagedRepo, signal })).trim());
    throwIfAborted(signal);
    const metadata: CheckoutMetadata = {
      formatVersion: CACHE_FORMAT_VERSION,
      repositoryKey,
      commit,
      remoteUrl,
    };
    writePrivateJson(join(stage, "metadata.json"), metadata);
    const destination = join(parent, commit);
    publishImmutable(stage, destination);
    if (!(await validCheckout(destination, repositoryKey, commit, remoteUrl, signal))) {
      throw new WebError(422, "cached checkout failed verification");
    }
    return { branch, cache: "miss", commit, repoDir: join(destination, "repo"), repositoryKey, remoteUrl };
  } catch (error) {
    removeEntry(stage);
    throw error;
  }
}

async function validCheckout(
  entry: string,
  repositoryKey: string,
  commit: string,
  remoteUrl: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const repoDir = join(entry, "repo");
  if (!isDirectory(repoDir)) {
    return false;
  }
  try {
    const metadata = readJson(join(entry, "metadata.json")) as Partial<CheckoutMetadata>;
    if (
      metadata.formatVersion !== CACHE_FORMAT_VERSION
      || metadata.repositoryKey !== repositoryKey
      || metadata.commit !== commit
      || metadata.remoteUrl !== remoteUrl
    ) {
      return false;
    }
    return requireCommit((await runGit(["rev-parse", "HEAD"], { cwd: repoDir, signal })).trim()) === commit;
  } catch (error) {
    if (isOperationCancelled(error)) throw error;
    return false;
  }
}

async function remoteCommit(
  url: string,
  ref: string | undefined,
  cwd: string,
  token?: string,
  signal?: AbortSignal,
): Promise<{ branch?: string; commit: string }> {
  const patterns = ref ? [`refs/heads/${ref}`, `refs/tags/${ref}`, `refs/tags/${ref}^{}`] : ["HEAD"];
  const output = await runGit(["ls-remote", "--exit-code", url, ...patterns], { cwd, token, signal });
  const rows = output.trim().split("\n").map((line) => line.trim().split(/\s+/, 2));
  const preferred = ref
    ? [`refs/heads/${ref}`, `refs/tags/${ref}^{}`, `refs/tags/${ref}`]
    : ["HEAD"];
  for (const name of preferred) {
    const row = rows.find(([, candidate]) => candidate === name);
    if (row?.[0]) {
      return { branch: name.startsWith("refs/heads/") ? ref : undefined, commit: requireCommit(row[0]) };
    }
  }
  throw new WebError(422, `remote ref was not found: ${ref ?? "HEAD"}`);
}

function requireCommit(value: string): string {
  if (!COMMIT.test(value)) {
    throw new WebError(422, "git returned an invalid commit id");
  }
  return value.toLowerCase();
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);
}

export function repositoryCacheKey(remoteUrl: string): string {
  return hash([CACHE_FORMAT_VERSION, remoteUrl]);
}
