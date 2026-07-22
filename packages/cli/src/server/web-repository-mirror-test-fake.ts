import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { throwIfAborted } from "./web-cancellation";
import {
  repositoryKeyFor,
  type AcquireCachedWorkspaceInput,
  type AcquirePreparedPullRequestInput,
  type AcquireWorkspaceInput,
  type PreparePullRequestInput,
  type PreparedPullRequest,
  type RepositoryMirror,
  type RepositoryWorkspaceLease,
} from "./web-repository-mirror";

interface WorkspaceRecord {
  repositoryKey: string;
  remoteUrl: string;
  commit: string;
  repoDir: string;
}

export interface FakeRepositoryLeaseRecord {
  readonly lease: RepositoryWorkspaceLease;
  readonly released: boolean;
}

/**
 * Structural test double for high-level cache orchestration.
 *
 * It models the contract that exact-SHA workspaces persist independently of leases, while every
 * acquisition returns a new idempotent lease. Real mirror/Git behavior belongs in
 * web-repository-mirror.test.ts rather than being reimplemented through git-exec mocks here.
 */
export class FakeRepositoryMirror implements RepositoryMirror {
  readonly acquireCachedWorkspaceCalls: AcquireCachedWorkspaceInput[] = [];
  readonly acquireWorkspaceCalls: AcquireWorkspaceInput[] = [];
  readonly leaseRecords: FakeRepositoryLeaseRecord[] = [];

  readonly #root: string;
  readonly #populate: (repoDir: string) => void;
  readonly #workspaces = new Map<string, WorkspaceRecord>();

  constructor(root: string, populate: (repoDir: string) => void = () => {}) {
    this.#root = root;
    this.#populate = populate;
  }

  get activeLeaseCount(): number {
    return this.leaseRecords.filter((record) => !record.released).length;
  }

  get releasedLeaseCount(): number {
    return this.leaseRecords.filter((record) => record.released).length;
  }

  seedWorkspace(remoteUrl: string, commit: string): string {
    return this.#workspace(remoteUrl, commit).repoDir;
  }

  async acquireCachedWorkspace(
    inputs: AcquireCachedWorkspaceInput,
  ): Promise<RepositoryWorkspaceLease | null> {
    throwIfAborted(inputs.signal);
    this.acquireCachedWorkspaceCalls.push(inputs);
    const workspace = this.#workspaces.get(workspaceKey(inputs.remoteUrl, inputs.expectedSha));
    return workspace === undefined ? null : this.#lease(workspace, "hit");
  }

  async acquireWorkspace(inputs: AcquireWorkspaceInput): Promise<RepositoryWorkspaceLease> {
    throwIfAborted(inputs.signal);
    this.acquireWorkspaceCalls.push(inputs);
    const key = workspaceKey(inputs.remoteUrl, inputs.revision.expectedSha);
    let workspace = this.#workspaces.get(key);
    let cache: "hit" | "miss" = "hit";
    if (workspace === undefined) {
      cache = "miss";
      await inputs.onCacheMiss?.();
      workspace = this.#workspace(inputs.remoteUrl, inputs.revision.expectedSha);
      await inputs.onFetchComplete?.();
    }
    throwIfAborted(inputs.signal);
    return this.#lease(workspace, cache);
  }

  async preparePullRequest(_inputs: PreparePullRequestInput): Promise<PreparedPullRequest> {
    throw new Error("FakeRepositoryMirror does not implement pull-request preparation");
  }

  async acquirePreparedPullRequest(
    _inputs: AcquirePreparedPullRequestInput,
  ): Promise<PreparedPullRequest | null> {
    return null;
  }

  async close(): Promise<void> {}

  releaseAllForTest(): void {
    for (const record of this.leaseRecords) record.lease.release();
  }

  #lease(workspace: WorkspaceRecord, cache: "hit" | "miss"): RepositoryWorkspaceLease {
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
    };
    const lease: RepositoryWorkspaceLease = {
      ...workspace,
      cache,
      release,
      [Symbol.dispose]: release,
    };
    this.leaseRecords.push({
      lease,
      get released() {
        return released;
      },
    });
    return lease;
  }

  #workspace(remoteUrl: string, commit: string): WorkspaceRecord {
    const key = workspaceKey(remoteUrl, commit);
    const existing = this.#workspaces.get(key);
    if (existing !== undefined) return existing;
    const repositoryKey = repositoryKeyFor(remoteUrl);
    const repoDir = join(this.#root, repositoryKey, commit, "repo");
    mkdirSync(repoDir, { recursive: true });
    this.#populate(repoDir);
    const workspace = { repositoryKey, remoteUrl, commit, repoDir };
    this.#workspaces.set(key, workspace);
    return workspace;
  }
}

export function fakeRepositoryLease(inputs: {
  repositoryKey: string;
  remoteUrl: string;
  commit: string;
  repoDir: string;
  release: () => void;
}): RepositoryWorkspaceLease {
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    inputs.release();
  };
  return {
    cache: "hit",
    repositoryKey: inputs.repositoryKey,
    remoteUrl: inputs.remoteUrl,
    commit: inputs.commit,
    repoDir: inputs.repoDir,
    release,
    [Symbol.dispose]: release,
  };
}

function workspaceKey(remoteUrl: string, commit: string): string {
  return `${remoteUrl}\0${commit}`;
}
