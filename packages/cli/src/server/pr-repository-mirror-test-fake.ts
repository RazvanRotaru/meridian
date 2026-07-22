import { mkdirSync, rmSync } from "node:fs";
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

export interface FakePrWorkspace {
  readonly ordinal: number;
  readonly workspaceId: string;
  readonly root: string;
  readonly headDir: string;
  readonly comparisonDir: string;
}

export interface FakePrLeaseRecord {
  readonly workspaceId: string;
  readonly side: "head" | "comparison";
  readonly lease: RepositoryWorkspaceLease;
  readonly releaseCount: number;
}

interface StoredPullRequest extends FakePrWorkspace {
  readonly repositoryKey: string;
  readonly remoteUrl: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly mergeBaseSha: string;
}

/**
 * Contract-level PR mirror double. It intentionally models only immutable generations and leases;
 * fetch, ref validation, worktree creation, and cleanup semantics are exercised with real Git by
 * web-repository-mirror.test.ts.
 */
export class FakePrRepositoryMirror implements RepositoryMirror {
  readonly prepareCalls: PreparePullRequestInput[] = [];
  readonly acquirePreparedCalls: AcquirePreparedPullRequestInput[] = [];
  readonly leaseRecords: FakePrLeaseRecord[] = [];
  readonly discardedWorkspaceIds: string[] = [];
  readonly createdWorkspaces: FakePrWorkspace[] = [];

  mergeBaseSha: string;
  beforeFetchComplete: (inputs: PreparePullRequestInput, workspace: FakePrWorkspace) => void | Promise<void> =
    () => {};
  afterFetchComplete: (inputs: PreparePullRequestInput, workspace: FakePrWorkspace) => void | Promise<void> =
    () => {};
  materialize: (inputs: PreparePullRequestInput, workspace: FakePrWorkspace) => void | Promise<void> =
    () => {};

  readonly #root: string;
  readonly #pullRequests = new Map<string, StoredPullRequest>();
  #ordinal = 0;

  constructor(root: string, mergeBaseSha: string) {
    this.#root = root;
    this.mergeBaseSha = mergeBaseSha;
  }

  get activeLeaseCount(): number {
    return this.leaseRecords.filter((record) => record.releaseCount === 0).length;
  }

  async acquireCachedWorkspace(
    _inputs: AcquireCachedWorkspaceInput,
  ): Promise<RepositoryWorkspaceLease | null> {
    return null;
  }

  async acquireWorkspace(_inputs: AcquireWorkspaceInput): Promise<RepositoryWorkspaceLease> {
    throw new Error("FakePrRepositoryMirror only supports pull-request workspaces");
  }

  async preparePullRequest(inputs: PreparePullRequestInput): Promise<PreparedPullRequest> {
    throwIfAborted(inputs.signal);
    this.prepareCalls.push(inputs);
    const ordinal = ++this.#ordinal;
    const workspaceId = ordinal.toString(16).padStart(32, "0");
    const root = join(this.#root, "fake-pr-workspaces", workspaceId);
    const workspace: FakePrWorkspace = {
      ordinal,
      workspaceId,
      root,
      headDir: join(root, "head"),
      comparisonDir: join(root, "comparison"),
    };
    this.createdWorkspaces.push(workspace);
    mkdirSync(workspace.headDir, { recursive: true });
    mkdirSync(workspace.comparisonDir, { recursive: true });
    try {
      await this.beforeFetchComplete(inputs, workspace);
      throwIfAborted(inputs.signal);
      await inputs.onFetchComplete?.();
      await this.afterFetchComplete(inputs, workspace);
      throwIfAborted(inputs.signal);
      await this.materialize(inputs, workspace);
      throwIfAborted(inputs.signal);
      const stored: StoredPullRequest = {
        ...workspace,
        repositoryKey: repositoryKeyFor(inputs.remoteUrl),
        remoteUrl: inputs.remoteUrl,
        workspaceId,
        baseSha: inputs.base.expectedSha,
        headSha: inputs.head.expectedSha,
        mergeBaseSha: this.mergeBaseSha,
      };
      this.#pullRequests.set(workspaceId, stored);
      return this.#prepared(stored, "miss");
    } catch (error) {
      rmSync(root, { recursive: true, force: true });
      throw error;
    }
  }

  async acquirePreparedPullRequest(
    inputs: AcquirePreparedPullRequestInput,
  ): Promise<PreparedPullRequest | null> {
    throwIfAborted(inputs.signal);
    this.acquirePreparedCalls.push(inputs);
    const stored = this.#pullRequests.get(inputs.workspaceId);
    if (
      stored === undefined
      || stored.repositoryKey !== inputs.repositoryKey
      || stored.remoteUrl !== inputs.remoteUrl
      || stored.baseSha !== inputs.baseSha
      || stored.headSha !== inputs.headSha
      || stored.mergeBaseSha !== inputs.mergeBaseSha
    ) {
      return null;
    }
    throwIfAborted(inputs.signal);
    return this.#prepared(stored, "hit");
  }

  async close(): Promise<void> {}

  releaseAllForTest(): void {
    for (const record of this.leaseRecords) record.lease.release();
  }

  leaseRecordsFor(workspaceId: string): FakePrLeaseRecord[] {
    return this.leaseRecords.filter((record) => record.workspaceId === workspaceId);
  }

  #prepared(stored: StoredPullRequest, cache: "hit" | "miss"): PreparedPullRequest {
    const head = this.#lease(stored, "head", cache);
    const comparison = this.#lease(stored, "comparison", cache);
    let discarded = false;
    const release = () => {
      head.release();
      comparison.release();
    };
    const discard = async () => {
      if (discarded) return;
      discarded = true;
      release();
      this.#pullRequests.delete(stored.workspaceId);
      this.discardedWorkspaceIds.push(stored.workspaceId);
      rmSync(stored.root, { recursive: true, force: true });
    };
    return {
      repositoryKey: stored.repositoryKey,
      remoteUrl: stored.remoteUrl,
      workspaceId: stored.workspaceId,
      baseSha: stored.baseSha,
      headSha: stored.headSha,
      mergeBaseSha: stored.mergeBaseSha,
      head,
      comparison,
      release,
      discard,
      [Symbol.dispose]: release,
    };
  }

  #lease(
    stored: StoredPullRequest,
    side: "head" | "comparison",
    cache: "hit" | "miss",
  ): RepositoryWorkspaceLease {
    let releaseCount = 0;
    const release = () => {
      releaseCount += 1;
    };
    const lease: RepositoryWorkspaceLease = {
      cache,
      repositoryKey: stored.repositoryKey,
      remoteUrl: stored.remoteUrl,
      commit: side === "head" ? stored.headSha : stored.mergeBaseSha,
      repoDir: side === "head" ? stored.headDir : stored.comparisonDir,
      release,
      [Symbol.dispose]: release,
    };
    this.leaseRecords.push({
      workspaceId: stored.workspaceId,
      side,
      lease,
      get releaseCount() {
        return releaseCount;
      },
    });
    return lease;
  }
}
