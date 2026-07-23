import type { GenerateRequest } from "./web-request";
import { runGit } from "./git-exec";
import { throwIfAborted } from "./web-cancellation";
import { WebError } from "./web-error";
import type { PhaseAdmission } from "./web-analysis-coordinator";
import {
  repositoryKeyFor,
  type ExpectedRemoteRef,
  type RepositoryMirror,
  type RepositoryWorkspaceLease,
} from "./web-repository-mirror";
import { parseGitHubSource } from "./clone";
import { isAllowedCloneRef } from "./git-ref";

const COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;

export interface CachedCheckout {
  branch?: string;
  cache: "hit" | "miss";
  commit: string;
  repoDir: string;
  repositoryKey: string;
  remoteUrl: string;
  sourceLease: RepositoryWorkspaceLease;
}

interface CheckoutIdentity {
  branch?: string;
  commit: string;
  remoteUrl: string;
  repositoryKey: string;
  revision: ExpectedRemoteRef;
}

/** Resolve and authorize the moving selector before touching any persistent cached source. */
export async function checkoutIdentity(
  request: GenerateRequest,
  cwd: string,
  token?: string,
  signal?: AbortSignal,
): Promise<CheckoutIdentity> {
  if (request.ref && !isAllowedCloneRef(request.ref)) {
    throw new WebError(400, "branch contains illegal characters");
  }
  const remoteUrl = parseGitHubSource(request.value);
  const advertised = await remoteCommit(remoteUrl, request.ref, cwd, token, signal);
  return {
    ...advertised,
    remoteUrl,
    repositoryKey: repositoryKeyFor(remoteUrl),
  };
}

export async function checkoutFor(
  repositories: RepositoryMirror,
  request: GenerateRequest,
  cwd: string,
  runPreparation: PhaseAdmission,
  token?: string,
  onClone: () => void | Promise<void> = () => {},
  signal?: AbortSignal,
): Promise<CachedCheckout> {
  throwIfAborted(signal);
  const identity = await checkoutIdentity(request, cwd, token, signal);
  const cached = await cachedCheckout(repositories, identity, signal);
  if (cached) return cached;

  let ownedCheckout: CachedCheckout | undefined;
  try {
    const admitted = await runPreparation(async (phaseSignal) => {
      // A different selector can publish the same exact commit while this request waits for a
      // preparation slot. Recheck under admission so it never creates a redundant worktree.
      const winner = await cachedCheckout(repositories, identity, phaseSignal);
      if (winner) {
        ownedCheckout = winner;
        return winner;
      }
      throwIfAborted(phaseSignal);
      const sourceLease = await repositories.acquireWorkspace({
        remoteUrl: identity.remoteUrl,
        revision: identity.revision,
        token,
        signal: phaseSignal,
        onCacheMiss: onClone,
      });
      const prepared = checkoutFromLease(identity, sourceLease, sourceLease.cache);
      ownedCheckout = prepared;
      return prepared;
    });
    ownedCheckout = undefined;
    return admitted;
  } catch (error) {
    ownedCheckout?.sourceLease.release();
    throw error;
  }
}

export async function probeCheckout(
  repositories: RepositoryMirror,
  request: GenerateRequest,
  cwd: string,
  token?: string,
  signal?: AbortSignal,
): Promise<CachedCheckout | null> {
  throwIfAborted(signal);
  const identity = await checkoutIdentity(request, cwd, token, signal);
  return cachedCheckout(repositories, identity, signal);
}

async function cachedCheckout(
  repositories: RepositoryMirror,
  identity: CheckoutIdentity,
  signal?: AbortSignal,
): Promise<CachedCheckout | null> {
  const sourceLease = await repositories.acquireCachedWorkspace({
    remoteUrl: identity.remoteUrl,
    expectedSha: identity.commit,
    signal,
  });
  return sourceLease === null ? null : checkoutFromLease(identity, sourceLease, "hit");
}

function checkoutFromLease(
  identity: CheckoutIdentity,
  sourceLease: RepositoryWorkspaceLease,
  cache: "hit" | "miss",
): CachedCheckout {
  if (
    sourceLease.repositoryKey !== identity.repositoryKey
    || sourceLease.remoteUrl !== identity.remoteUrl
    || sourceLease.commit !== identity.commit
  ) {
    sourceLease.release();
    throw new WebError(422, "repository workspace did not match its requested revision");
  }
  return {
    branch: identity.branch,
    cache,
    commit: identity.commit,
    repoDir: sourceLease.repoDir,
    repositoryKey: identity.repositoryKey,
    remoteUrl: identity.remoteUrl,
    sourceLease,
  };
}

async function remoteCommit(
  url: string,
  ref: string | undefined,
  cwd: string,
  token?: string,
  signal?: AbortSignal,
): Promise<{ branch?: string; commit: string; revision: ExpectedRemoteRef }> {
  const patterns = ref ? [`refs/heads/${ref}`, `refs/tags/${ref}`, `refs/tags/${ref}^{}`] : ["HEAD"];
  const output = await runGit(["ls-remote", "--exit-code", url, ...patterns], { cwd, token, signal });
  const rows = output.trim().split("\n").map((line) => line.trim().split(/\s+/, 2));
  const preferred = ref
    ? [`refs/heads/${ref}`, `refs/tags/${ref}^{}`, `refs/tags/${ref}`]
    : ["HEAD"];
  for (const name of preferred) {
    const row = rows.find(([, candidate]) => candidate === name);
    if (!row?.[0]) continue;
    const commit = requireCommit(row[0]);
    const remoteRef = name.endsWith("^{}") ? name.slice(0, -3) : name;
    return {
      branch: name.startsWith("refs/heads/") ? ref : undefined,
      commit,
      revision: { remoteRef, expectedSha: commit },
    };
  }
  throw new WebError(422, `remote ref was not found: ${ref ?? "HEAD"}`);
}

function requireCommit(value: string): string {
  if (!COMMIT.test(value)) {
    throw new WebError(422, "git returned an invalid commit id");
  }
  return value.toLowerCase();
}
