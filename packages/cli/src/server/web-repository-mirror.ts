/**
 * One credential-free, bare partial mirror per remote repository.
 *
 * Moving remote refs are never used as workspace identity. Callers first resolve a ref and pass
 * its expected commit; this store fetches that exact remote ref into an opaque internal ref,
 * verifies the preflight SHA, and materializes only detached exact-SHA workspaces. Ordinary remote
 * generation reuses one stable workspace per commit. PR preparation deliberately creates a unique
 * pair because whole-subtree add/delete analysis may materialize empty directories in either side.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { runGit } from "./git-exec";
import { canonicalGitRemoteUrl } from "./clone";
import { isAllowedCloneRef } from "./git-ref";
import { throwIfAborted } from "./web-cancellation";
import { WebError } from "./web-error";

const STORE_FORMAT_VERSION = 1;
const COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;
const WORKSPACE_ID = /^[a-f0-9]{32}$/;
const SESSION_ID = /^[a-f0-9-]{36}$/;
const DEFAULT_GIT_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_STALE_LOCK_MS = 15 * 60_000;
const LOCK_RETRY_MS = 25;

type GitObjectFormat = "sha1" | "sha256";

export interface WebRepositoryMirrorOptions {
  cacheRoot: string;
  gitTimeoutMs?: number;
  /** Optional contention deadline. By default callers wait for release, stale recovery, or abort. */
  lockWaitTimeoutMs?: number;
  staleLockMs?: number;
  /** Real-Git tests use local bare remotes. Web callers must retain the normal http(s) boundary. */
  allowFileRemotesForTests?: boolean;
  /** Internal test seam for verifying request-scoped Git credentials and command boundaries. */
  git?: typeof runGit;
}

export interface ExpectedRemoteRef {
  /** `HEAD` or a complete remote ref such as `refs/heads/main` or `refs/pull/41/head`. */
  remoteRef: string;
  /** Exact commit observed during the caller's credentialed preflight. */
  expectedSha: string;
}

export interface AcquireCachedWorkspaceInput {
  remoteUrl: string;
  expectedSha: string;
  signal?: AbortSignal;
}

export interface AcquireWorkspaceInput {
  remoteUrl: string;
  revision: ExpectedRemoteRef;
  token?: string;
  signal?: AbortSignal;
  onCacheMiss?: () => void | Promise<void>;
  onFetchComplete?: () => void | Promise<void>;
}

export interface PreparePullRequestInput {
  remoteUrl: string;
  base: ExpectedRemoteRef;
  head: ExpectedRemoteRef;
  token?: string;
  signal?: AbortSignal;
  onFetchComplete?: () => void | Promise<void>;
}

export interface AcquirePreparedPullRequestInput {
  repositoryKey: string;
  remoteUrl: string;
  workspaceId: string;
  baseSha: string;
  headSha: string;
  mergeBaseSha: string;
  signal?: AbortSignal;
}

export interface RepositoryWorkspaceLease {
  /** Whether this acquisition created the physical workspace or reused an immutable publication. */
  readonly cache: "hit" | "miss";
  readonly repositoryKey: string;
  readonly remoteUrl: string;
  readonly commit: string;
  readonly repoDir: string;
  release(): void;
  [Symbol.dispose](): void;
}

export interface PreparedPullRequest {
  readonly repositoryKey: string;
  readonly remoteUrl: string;
  readonly workspaceId: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly mergeBaseSha: string;
  readonly head: RepositoryWorkspaceLease;
  readonly comparison: RepositoryWorkspaceLease;
  release(): void;
  /** Remove an unpublished/failed PR generation through Git, then prune its worktree records. */
  discard(): Promise<void>;
  [Symbol.dispose](): void;
}

/** Required repository-preparation dependency used by cache and request orchestration. */
export interface RepositoryMirror {
  acquireCachedWorkspace(inputs: AcquireCachedWorkspaceInput): Promise<RepositoryWorkspaceLease | null>;
  acquireWorkspace(inputs: AcquireWorkspaceInput): Promise<RepositoryWorkspaceLease>;
  preparePullRequest(inputs: PreparePullRequestInput): Promise<PreparedPullRequest>;
  acquirePreparedPullRequest(inputs: AcquirePreparedPullRequestInput): Promise<PreparedPullRequest | null>;
  close(): Promise<void>;
}

interface RepositoryIdentityMetadata {
  formatVersion: number;
  objectFormat: GitObjectFormat;
  repositoryKey: string;
  remoteUrl: string;
}

interface MirrorMetadata extends RepositoryIdentityMetadata {
  historyMode: "tip" | "promoting" | "complete";
}

interface CommitWorkspaceMetadata extends RepositoryIdentityMetadata {
  kind: "commit";
  commit: string;
}

interface PullRequestWorkspaceMetadata extends RepositoryIdentityMetadata {
  kind: "pull-request";
  workspaceId: string;
  baseSha: string;
  headSha: string;
  mergeBaseSha: string;
}

interface RepositoryRecord {
  entry: string;
  mirrorDir: string;
  objectFormat: GitObjectFormat;
  repositoryKey: string;
  remoteUrl: string;
}

interface WorkspaceRecord extends RepositoryRecord {
  commit: string;
  repoDir: string;
}

interface CommitWorkspaceResult {
  cache: "hit" | "miss";
  workspace: WorkspaceRecord;
}

interface PullRequestRecord extends RepositoryRecord {
  workspaceId: string;
  baseSha: string;
  headSha: string;
  mergeBaseSha: string;
  root: string;
  headDir: string;
  comparisonDir: string;
}

type RepositoryMutation =
  | {
    formatVersion: number;
    incomingCount: 1;
    kind: "commit-workspace";
    operationId: string;
    repositoryKey: string;
    commit: string;
  }
  | {
    formatVersion: number;
    incomingCount: 2;
    kind: "pull-request-workspace";
    operationId: string;
    repositoryKey: string;
    workspaceId: string;
  };

interface LockOwner {
  formatVersion: number;
  host: string;
  nonce: string;
  pid: number;
}

interface LeaseOwner extends LockOwner {
  kind: "workspace-lease";
  sessionNonce: string;
}

interface StoreOwner {
  formatVersion: number;
  host: string;
}

interface LeaseSessionOwner extends StoreOwner {
  kind: "lease-session";
  nonce: string;
  pid: number;
}

interface SharedJob<Result> {
  controller: AbortController;
  promise: Promise<Result>;
  settled: boolean;
  waiters: Set<symbol>;
}

class RepositoryLockOwnershipLostError extends WebError {
  constructor() {
    super(503, "repository mirror lock ownership was lost");
    this.name = "RepositoryLockOwnershipLostError";
  }
}

// Cleanup must ignore an ordinary caller disconnect while the process still owns the repository
// lock, but it must stop immediately if fencing is lost. Keep that ownership-only signal separate
// from the combined request/ownership signal passed to normal preparation work.
const REPOSITORY_LOCK_FENCING = new WeakMap<AbortSignal, AbortSignal>();

/** Canonical cache identity for every remote artifact, mirror, and workspace. */
export function repositoryKeyFor(remoteUrl: string): string {
  return createHash("sha256")
    .update(JSON.stringify([STORE_FORMAT_VERSION, canonicalGitRemoteUrl(remoteUrl, { allowFile: true })]))
    .digest("hex")
    .slice(0, 24);
}

export class WebRepositoryMirror implements RepositoryMirror {
  readonly #root: string;
  readonly #repositoriesRoot: string;
  readonly #locksRoot: string;
  readonly #gitTimeoutMs: number;
  readonly #lockWaitTimeoutMs: number | undefined;
  readonly #staleLockMs: number;
  readonly #allowFileRemotes: boolean;
  readonly #git: typeof runGit;
  readonly #jobs = new Map<string, SharedJob<unknown>>();
  readonly #leaseMarkers = new Set<string>();
  readonly #leaseSessionNonce = randomUUID();
  #leaseSessionHeartbeat: NodeJS.Timeout | undefined;

  constructor(options: WebRepositoryMirrorOptions) {
    const gitTimeoutMs = options.gitTimeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
    requirePositiveInteger(gitTimeoutMs, "gitTimeoutMs");
    if (options.lockWaitTimeoutMs !== undefined) {
      requirePositiveInteger(options.lockWaitTimeoutMs, "lockWaitTimeoutMs");
    }
    requirePositiveInteger(options.staleLockMs ?? DEFAULT_STALE_LOCK_MS, "staleLockMs");
    this.#root = resolve(options.cacheRoot, `repository-store-v${STORE_FORMAT_VERSION}`);
    this.#repositoriesRoot = join(this.#root, "repositories");
    this.#locksRoot = join(this.#root, "locks");
    this.#gitTimeoutMs = gitTimeoutMs;
    this.#lockWaitTimeoutMs = options.lockWaitTimeoutMs;
    this.#staleLockMs = options.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
    this.#allowFileRemotes = options.allowFileRemotesForTests === true;
    this.#git = options.git ?? runGit;
  }

  /** Probe only. Never creates the store, initializes a mirror, fetches, repairs, or checks out. */
  async acquireCachedWorkspace(inputs: AcquireCachedWorkspaceInput): Promise<RepositoryWorkspaceLease | null> {
    throwIfAborted(inputs.signal);
    const remoteUrl = this.#canonicalRemote(inputs.remoteUrl);
    const commit = requireCommit(inputs.expectedSha);
    const repositoryKey = repositoryKeyFor(remoteUrl);
    const repository = this.#repositoryRecord(remoteUrl, repositoryKey, objectFormatForCommit(commit));
    const workspace = this.#commitWorkspaceRecord(repository, commit);
    // Preserve a non-mutating miss probe: only an existing candidate needs the short lease lock.
    if (!isPlainDirectory(workspace.repoDir)) return null;
    return this.#acquireCommitLease(workspace, "hit", inputs.signal);
  }

  /** Admitted miss path: verify one preflighted ref and create/reuse its stable commit workspace. */
  async acquireWorkspace(inputs: AcquireWorkspaceInput): Promise<RepositoryWorkspaceLease> {
    throwIfAborted(inputs.signal);
    const remoteUrl = this.#canonicalRemote(inputs.remoteUrl);
    const revision = normalizeExpectedRef(inputs.revision);
    const repositoryKey = repositoryKeyFor(remoteUrl);
    // Do not let one credential scope inherit another scope's transient fetch failure. The token
    // itself is never retained; its process-local digest only partitions active singleflight jobs.
    const credentialScope = inputs.token === undefined
      ? "anonymous"
      : createHash("sha256").update(inputs.token).digest("hex");
    const key = `commit:${repositoryKey}:${revision.expectedSha}:${credentialScope}`;
    const acquired = await this.#shared(
      key,
      inputs.signal,
      (sharedSignal) => this.#prepareCommitWorkspace(
        remoteUrl,
        repositoryKey,
        revision,
        inputs.token,
        inputs.onCacheMiss,
        inputs.onFetchComplete,
        sharedSignal,
      ),
    );
    throwIfAborted(inputs.signal);
    const lease = await this.#acquireCommitLease(acquired.workspace, acquired.cache, inputs.signal);
    if (lease === null) {
      throw new WebError(409, "repository workspace changed before it could be leased; retry");
    }
    return lease;
  }

  /**
   * Fetch and verify the exact base/head pair, resolve their merge base, and create one unique PR
   * generation. No PR generation is shared by physical path, even when its commits are identical.
   */
  async preparePullRequest(inputs: PreparePullRequestInput): Promise<PreparedPullRequest> {
    throwIfAborted(inputs.signal);
    const remoteUrl = this.#canonicalRemote(inputs.remoteUrl);
    const base = normalizeExpectedRef(inputs.base);
    const head = normalizeExpectedRef(inputs.head);
    const objectFormat = matchingObjectFormat(base.expectedSha, head.expectedSha);
    const repositoryKey = repositoryKeyFor(remoteUrl);
    let prepared: PreparedPullRequest | undefined;
    let createdRecord: PullRequestRecord | undefined;
    try {
      prepared = await this.#withRepositoryLock(repositoryKey, inputs.signal, async (lockSignal) => {
        const repository = await this.#ensureRepository(remoteUrl, repositoryKey, objectFormat, lockSignal);
        const workspaceId = randomBytes(16).toString("hex");
        const mutation: RepositoryMutation = {
          formatVersion: STORE_FORMAT_VERSION,
          incomingCount: 2,
          kind: "pull-request-workspace",
          operationId: workspaceId,
          repositoryKey,
          workspaceId,
        };
        this.#beginMutation(repository, mutation);
        let owned: PreparedPullRequest | undefined;
        try {
          const refs = await this.#fetchExpectedRefs(
            repository,
            [base, head],
            "complete",
            mutation.operationId,
            inputs.token,
            lockSignal,
          );
          const mergeBaseSha = await this.#mergeBase(repository, refs[0]!, refs[1]!, lockSignal);
          await inputs.onFetchComplete?.();
          throwIfAborted(lockSignal);
          const record = await this.#createPullRequestWorkspace(
            repository,
            workspaceId,
            base.expectedSha,
            head.expectedSha,
            mergeBaseSha,
            inputs.token,
            lockSignal,
          );
          createdRecord = record;
          owned = this.#prepared(record, "miss");
          this.#finishMutation(repository, mutation);
          return owned;
        } catch (error) {
          owned?.release();
          const ownershipLoss = repositoryLockOwnershipLoss(lockSignal, error);
          if (ownershipLoss !== null) throw ownershipLoss;
          const cleaned = await this.#rollbackMutation(repository, mutation, lockSignal);
          if (cleaned) this.#finishMutation(repository, mutation);
          throw error;
        }
      });
      throwIfAborted(inputs.signal);
      return prepared;
    } catch (error) {
      if (prepared !== undefined) await Promise.allSettled([prepared.discard()]);
      else if (createdRecord !== undefined) await Promise.allSettled([this.#discardPrepared(createdRecord)]);
      throw error;
    }
  }

  /** Cache-hit/restart path. It validates and leases an existing generation without any mutation. */
  async acquirePreparedPullRequest(inputs: AcquirePreparedPullRequestInput): Promise<PreparedPullRequest | null> {
    throwIfAborted(inputs.signal);
    const remoteUrl = this.#canonicalRemote(inputs.remoteUrl);
    const repositoryKey = requireRepositoryKey(inputs.repositoryKey);
    if (repositoryKeyFor(remoteUrl) !== repositoryKey) return null;
    const workspaceId = requireWorkspaceId(inputs.workspaceId);
    const baseSha = requireCommit(inputs.baseSha);
    const headSha = requireCommit(inputs.headSha);
    const mergeBaseSha = requireCommit(inputs.mergeBaseSha);
    const objectFormat = matchingObjectFormat(baseSha, headSha, mergeBaseSha);
    const repository = this.#repositoryRecord(remoteUrl, repositoryKey, objectFormat);
    const root = join(repository.entry, "workspaces", "pull-requests", workspaceId);
    const metadata = readMetadata<PullRequestWorkspaceMetadata>(join(root, "metadata.json"));
    if (
      metadata === null
      || metadata.formatVersion !== STORE_FORMAT_VERSION
      || metadata.objectFormat !== objectFormat
      || metadata.kind !== "pull-request"
      || metadata.repositoryKey !== repositoryKey
      || metadata.remoteUrl !== remoteUrl
      || metadata.workspaceId !== workspaceId
      || metadata.baseSha !== baseSha
      || metadata.headSha !== headSha
      || metadata.mergeBaseSha !== mergeBaseSha
    ) {
      return null;
    }
    const record: PullRequestRecord = {
      ...repository,
      workspaceId,
      root,
      baseSha,
      headSha,
      mergeBaseSha,
      headDir: join(root, "head"),
      comparisonDir: join(root, "comparison"),
    };
    if (!isPlainDirectory(record.headDir) || !isPlainDirectory(record.comparisonDir)) return null;
    let prepared: PreparedPullRequest | undefined;
    try {
      prepared = await this.#withRepositoryLock(repositoryKey, inputs.signal, async (lockSignal) => {
        if (this.#readMutation(repository) !== null) return undefined;
        if (!(await this.#validPullRequestWorkspace(record, lockSignal))) return undefined;
        return this.#prepared(record, "hit");
      });
      throwIfAborted(inputs.signal);
      return prepared ?? null;
    } catch (error) {
      prepared?.release();
      throw error;
    }
  }

  /** Mirrors and released workspaces are intentionally persistent. Retention owns later removal. */
  async close(): Promise<void> {}

  async #prepareCommitWorkspace(
    remoteUrl: string,
    repositoryKey: string,
    revision: ExpectedRemoteRef,
    token: string | undefined,
    onCacheMiss: (() => void | Promise<void>) | undefined,
    onFetchComplete: (() => void | Promise<void>) | undefined,
    signal: AbortSignal,
  ): Promise<CommitWorkspaceResult> {
    const objectFormat = objectFormatForCommit(revision.expectedSha);
    const repository = this.#repositoryRecord(remoteUrl, repositoryKey, objectFormat);
    const cached = this.#commitWorkspaceRecord(repository, revision.expectedSha);
    if (await this.#validCommitWorkspace(cached, signal)) return { cache: "hit", workspace: cached };
    return this.#withRepositoryLock(repositoryKey, signal, async (lockSignal) => {
      if (await this.#validCommitWorkspace(cached, lockSignal)) return { cache: "hit", workspace: cached };
      await onCacheMiss?.();
      throwIfAborted(lockSignal);
      const preparedRepository = await this.#ensureRepository(remoteUrl, repositoryKey, objectFormat, lockSignal);
      // The pending mutation may only own an absent target. Reject a leased invalid publication or
      // remove an unleased one before journaling, so rollback can never delete another reader's tree.
      await this.#removeBrokenCommitWorkspace(cached, lockSignal);
      const mutation: RepositoryMutation = {
        formatVersion: STORE_FORMAT_VERSION,
        incomingCount: 1,
        kind: "commit-workspace",
        operationId: randomBytes(16).toString("hex"),
        repositoryKey,
        commit: revision.expectedSha,
      };
      this.#beginMutation(preparedRepository, mutation);
      try {
        await this.#fetchExpectedRefs(
          preparedRepository,
          [revision],
          "shallow",
          mutation.operationId,
          token,
          lockSignal,
        );
        await onFetchComplete?.();
        throwIfAborted(lockSignal);
        mkdirPrivate(dirname(cached.repoDir));
        await this.#addWorktree(preparedRepository, cached.repoDir, revision.expectedSha, token, lockSignal);
        if (!(await this.#validWorktree(cached.repoDir, revision.expectedSha, lockSignal))) {
          throw new WebError(422, "repository workspace failed verification");
        }
        // Metadata is the immutable publication marker. A crash before this atomic write leaves an
        // incomplete generation that the next locked mutation can prune; warm hits never scan trees.
        writePrivateJson(join(dirname(cached.repoDir), "metadata.json"), {
          formatVersion: STORE_FORMAT_VERSION,
          objectFormat,
          kind: "commit",
          repositoryKey,
          remoteUrl,
          commit: revision.expectedSha,
        } satisfies CommitWorkspaceMetadata);
        this.#finishMutation(preparedRepository, mutation);
        return { cache: "miss", workspace: cached };
      } catch (error) {
        const ownershipLoss = repositoryLockOwnershipLoss(lockSignal, error);
        if (ownershipLoss !== null) throw ownershipLoss;
        const cleaned = await this.#rollbackMutation(preparedRepository, mutation, lockSignal);
        if (cleaned) this.#finishMutation(preparedRepository, mutation);
        throw error;
      }
    });
  }

  async #ensureRepository(
    remoteUrl: string,
    repositoryKey: string,
    objectFormat: GitObjectFormat,
    signal: AbortSignal,
  ): Promise<RepositoryRecord> {
    const repository = this.#repositoryRecord(remoteUrl, repositoryKey, objectFormat);
    // Initialization uses one deterministic stage under the same per-repository lock. A crash can
    // therefore leave at most this exact path, which the next owner recovers in O(1).
    const stage = join(this.#repositoriesRoot, `.stage-${repositoryKey}`);
    if (existsSync(stage)) removeWithin(this.#root, stage);
    if (await this.#validRepository(repository, signal)) {
      await this.#recoverInterruptedMutations(repository, signal);
      return repository;
    }
    if (existsSync(repository.entry)) {
      if (this.#hasLeasesWithin(join(repository.entry, "workspaces"))) {
        throw new WebError(409, "repository mirror is invalid while an existing workspace is in use");
      }
      removeWithin(this.#root, repository.entry);
    }
    mkdirPrivate(this.#repositoriesRoot);
    const mirrorDir = join(stage, "mirror.git");
    try {
      mkdirPrivate(stage);
      await this.#git(["init", "--bare", `--object-format=${objectFormat}`, mirrorDir], {
        cwd: stage,
        timeoutMs: this.#gitTimeoutMs,
        signal,
      });
      await this.#git(["remote", "add", "origin", remoteUrl], {
        cwd: mirrorDir,
        timeoutMs: this.#gitTimeoutMs,
        signal,
      });
      // Fetches intentionally omit blobs; mark origin as the promisor so worktree checkout can
      // hydrate missing objects through the request-scoped credential without persisting it.
      await this.#git(["config", "remote.origin.promisor", "true"], {
        cwd: mirrorDir,
        timeoutMs: this.#gitTimeoutMs,
        signal,
      });
      await this.#git(["config", "remote.origin.partialclonefilter", "blob:none"], {
        cwd: mirrorDir,
        timeoutMs: this.#gitTimeoutMs,
        signal,
      });
      await this.#git(["config", "core.longpaths", "true"], {
        cwd: mirrorDir,
        timeoutMs: this.#gitTimeoutMs,
        signal,
      });
      await this.#git(["config", "gc.auto", "0"], { cwd: mirrorDir, timeoutMs: this.#gitTimeoutMs, signal });
      await this.#git(["config", "maintenance.auto", "false"], {
        cwd: mirrorDir,
        timeoutMs: this.#gitTimeoutMs,
        signal,
      });
      writePrivateJson(join(stage, "metadata.json"), {
        formatVersion: STORE_FORMAT_VERSION,
        historyMode: "tip",
        objectFormat,
        repositoryKey,
        remoteUrl,
      } satisfies MirrorMetadata);
      renameSync(stage, repository.entry);
      if (!(await this.#validRepository(repository, signal))) {
        throw new WebError(422, "repository mirror failed verification");
      }
      return repository;
    } catch (error) {
      const ownershipLoss = repositoryLockOwnershipLoss(signal, error);
      if (ownershipLoss !== null) throw ownershipLoss;
      removeWithin(this.#root, stage);
      throw error;
    }
  }

  async #validRepository(repository: RepositoryRecord, signal?: AbortSignal): Promise<boolean> {
    if (!isPlainDirectory(repository.entry) || !isPlainDirectory(repository.mirrorDir)) return false;
    const metadata = readMetadata<MirrorMetadata>(join(repository.entry, "metadata.json"));
    if (
      metadata === null
      || metadata.formatVersion !== STORE_FORMAT_VERSION
      || !isHistoryMode(metadata.historyMode)
      || metadata.objectFormat !== repository.objectFormat
      || metadata.repositoryKey !== repository.repositoryKey
      || metadata.remoteUrl !== repository.remoteUrl
    ) return false;
    try {
      const bare = (await this.#git(["rev-parse", "--is-bare-repository"], {
        cwd: repository.mirrorDir,
        timeoutMs: this.#gitTimeoutMs,
        signal,
      })).trim();
      const origin = (await this.#git(["config", "--get", "remote.origin.url"], {
        cwd: repository.mirrorDir,
        timeoutMs: this.#gitTimeoutMs,
        signal,
      })).trim();
      const objectFormat = (await this.#git(["rev-parse", "--show-object-format"], {
        cwd: repository.mirrorDir,
        timeoutMs: this.#gitTimeoutMs,
        signal,
      })).trim();
      return bare === "true" && origin === repository.remoteUrl && objectFormat === repository.objectFormat;
    } catch (error) {
      if (signal?.aborted) throw error;
      return false;
    }
  }

  async #fetchExpectedRefs(
    repository: RepositoryRecord,
    revisions: readonly ExpectedRemoteRef[],
    history: "shallow" | "complete",
    operationId: string,
    token: string | undefined,
    signal: AbortSignal,
  ): Promise<string[]> {
    const targets = revisions.map((revision) => internalRef(revision));
    if (!WORKSPACE_ID.test(operationId)) throw new WebError(500, "repository mutation id is invalid");
    const incomingNamespace = `refs/meridian/incoming/${operationId}`;
    const incoming = revisions.map((_revision, index) => `${incomingNamespace}/${index}`);
    let failure: unknown;
    let fetched: string[] | undefined;
    try {
      // Fetch into request-unique staging refs. A force-push race must never overwrite an already
      // verified immutable snapshot ref before the fetched commit is checked against preflight.
      const metadataPath = join(repository.entry, "metadata.json");
      const metadata = readMetadata<MirrorMetadata>(metadataPath);
      if (!isHistoryMode(metadata?.historyMode)) {
        throw new WebError(422, "repository mirror history metadata is invalid");
      }
      let historyMode = metadata.historyMode;
      if (history === "complete" && historyMode === "tip") {
        // Publish intent before the destructive shallow -> complete transition. A crash can leave
        // `promoting`, but no later ordinary fetch may then re-shallow the shared object store.
        writePrivateJson(metadataPath, {
          formatVersion: STORE_FORMAT_VERSION,
          historyMode: "promoting",
          objectFormat: repository.objectFormat,
          repositoryKey: repository.repositoryKey,
          remoteUrl: repository.remoteUrl,
        } satisfies MirrorMetadata);
        historyMode = "promoting";
      }
      const shallow = (await this.#git(["rev-parse", "--is-shallow-repository"], {
        cwd: repository.mirrorDir,
        timeoutMs: this.#gitTimeoutMs,
        signal,
      })).trim() === "true";
      if (historyMode === "complete" && shallow) {
        throw new WebError(422, "repository mirror complete-history invariant was violated");
      }
      // History promotion is monotonic. Re-shallowing a shared mirror could invalidate an active
      // PR comparison after its lease escaped the repository lock, so complete mirrors only ever
      // receive ordinary incremental fetches.
      const historyArgs = historyMode === "tip"
        ? ["--depth=1"]
        : shallow ? ["--unshallow"] : [];
      await this.#git([
        "fetch",
        "--no-tags",
        "--filter=blob:none",
        "--no-write-fetch-head",
        ...historyArgs,
        "origin",
        ...revisions.map((revision, index) => `+${revision.remoteRef}:${incoming[index]}`),
      ], {
        cwd: repository.mirrorDir,
        token,
        timeoutMs: this.#gitTimeoutMs,
        signal,
      });
      if (historyMode === "promoting") {
        const remainsShallow = (await this.#git(["rev-parse", "--is-shallow-repository"], {
          cwd: repository.mirrorDir,
          timeoutMs: this.#gitTimeoutMs,
          signal,
        })).trim() === "true";
        if (remainsShallow) {
          throw new WebError(422, "repository remote could not provide complete comparison history");
        }
        writePrivateJson(metadataPath, {
          formatVersion: STORE_FORMAT_VERSION,
          historyMode: "complete",
          objectFormat: repository.objectFormat,
          repositoryKey: repository.repositoryKey,
          remoteUrl: repository.remoteUrl,
        } satisfies MirrorMetadata);
      }
      for (let index = 0; index < revisions.length; index += 1) {
        const actual = requireCommit((await this.#git(["rev-parse", `${incoming[index]}^{commit}`], {
          cwd: repository.mirrorDir,
          timeoutMs: this.#gitTimeoutMs,
          signal,
        })).trim());
        if (actual !== revisions[index]!.expectedSha) {
          throw new WebError(409, "remote revision changed during repository preparation; retry");
        }
      }
      for (let index = 0; index < revisions.length; index += 1) {
        await this.#git(["update-ref", targets[index]!, revisions[index]!.expectedSha], {
          cwd: repository.mirrorDir,
          timeoutMs: this.#gitTimeoutMs,
          signal,
        });
      }
      fetched = targets;
    } catch (error) {
      failure = error;
    }
    // Cleanup deliberately gets its own uncancelled Git calls. The caller's abort still rejects
    // the operation, while temporary refs cannot accumulate and accidentally pin repository data.
    let cleanupFailure: unknown;
    try {
      await this.#deleteInternalRefs(repository, incoming, signal);
    } catch (error) {
      cleanupFailure = error;
    }
    if (failure !== undefined) throw failure;
    if (cleanupFailure !== undefined) {
      throw new WebError(500, "repository temporary refs could not be cleaned");
    }
    return fetched!;
  }

  async #recoverInterruptedMutations(repository: RepositoryRecord, signal: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    const mutation = this.#readMutation(repository);
    if (mutation === null) return;
    await this.#deleteInternalRefs(repository, incomingRefs(mutation), signal);
    if (mutation.kind === "commit-workspace") {
      const workspace = this.#commitWorkspaceRecord(repository, mutation.commit);
      // Exact-SHA commit workspaces are durable cache publications. A crash after metadata was
      // written but before the journal was cleared does not invalidate an otherwise complete hit.
      if (await this.#validCommitWorkspace(workspace, signal)) {
        this.#finishMutation(repository, mutation);
        return;
      }
    }
    if (this.#mutationHasLeases(repository, mutation)) {
      throw new WebError(409, "interrupted repository workspace is still in use");
    }
    const cleaned = await this.#rollbackMutation(repository, mutation);
    if (!cleaned) throw new WebError(500, "interrupted repository workspace could not be recovered");
    this.#finishMutation(repository, mutation);
  }

  #beginMutation(repository: RepositoryRecord, mutation: RepositoryMutation): void {
    const path = join(repository.entry, "pending.json");
    if (existsSync(path)) {
      throw new WebError(409, "repository has an unfinished mutation; retry");
    }
    writePrivateJson(path, mutation);
  }

  #readMutation(repository: RepositoryRecord): RepositoryMutation | null {
    const path = join(repository.entry, "pending.json");
    if (!existsSync(path)) return null;
    const mutation = readMetadata<RepositoryMutation>(path);
    const common = mutation?.formatVersion === STORE_FORMAT_VERSION
      && mutation.repositoryKey === repository.repositoryKey
      && typeof mutation.operationId === "string"
      && WORKSPACE_ID.test(mutation.operationId);
    const validCommit = common
      && mutation.kind === "commit-workspace"
      && mutation.incomingCount === 1
      && typeof mutation.commit === "string"
      && COMMIT.test(mutation.commit);
    const validPullRequest = common
      && mutation.kind === "pull-request-workspace"
      && mutation.incomingCount === 2
      && typeof mutation.workspaceId === "string"
      && WORKSPACE_ID.test(mutation.workspaceId)
      && mutation.workspaceId === mutation.operationId;
    if (!validCommit && !validPullRequest) {
      throw new WebError(422, "repository mutation journal is invalid");
    }
    return mutation as RepositoryMutation;
  }

  #finishMutation(repository: RepositoryRecord, expected: RepositoryMutation): void {
    const current = this.#readMutation(repository);
    if (
      current === null
      || current.kind !== expected.kind
      || current.operationId !== expected.operationId
    ) {
      throw new RepositoryLockOwnershipLostError();
    }
    rmSync(join(repository.entry, "pending.json"), { force: true });
  }

  #mutationHasLeases(repository: RepositoryRecord, mutation: RepositoryMutation): boolean {
    if (mutation.kind === "commit-workspace") {
      return this.#hasLeasesWithin(dirname(this.#commitWorkspaceRecord(repository, mutation.commit).repoDir));
    }
    return this.#hasLeasesWithin(
      join(repository.entry, "workspaces", "pull-requests", mutation.workspaceId),
    );
  }

  async #rollbackMutation(
    repository: RepositoryRecord,
    mutation: RepositoryMutation,
    ownershipSignal?: AbortSignal,
  ): Promise<boolean> {
    let refsCleaned = true;
    try {
      await this.#deleteInternalRefs(repository, incomingRefs(mutation), ownershipSignal);
    } catch (error) {
      const ownershipLoss = repositoryLockOwnershipLoss(ownershipSignal, error);
      if (ownershipLoss !== null) throw ownershipLoss;
      refsCleaned = false;
    }
    if (mutation.kind === "commit-workspace") {
      const workspace = this.#commitWorkspaceRecord(repository, mutation.commit);
      const worktreeCleaned = await this.#cleanupFailedWorktrees(
        repository,
        [workspace.repoDir],
        dirname(workspace.repoDir),
        ownershipSignal,
      );
      return refsCleaned && worktreeCleaned;
    }
    const root = join(repository.entry, "workspaces", "pull-requests", mutation.workspaceId);
    const worktreeCleaned = await this.#cleanupFailedWorktrees(
      repository,
      [join(root, "comparison"), join(root, "head")],
      root,
      ownershipSignal,
    );
    return refsCleaned && worktreeCleaned;
  }

  async #deleteInternalRefs(
    repository: RepositoryRecord,
    refs: readonly string[],
    ownershipSignal?: AbortSignal,
  ): Promise<void> {
    const fencingSignal = repositoryLockFencingSignal(ownershipSignal);
    const failures: unknown[] = [];
    for (const ref of refs) {
      try {
        const ownershipLoss = repositoryLockOwnershipLoss(ownershipSignal);
        if (ownershipLoss !== null) throw ownershipLoss;
        await this.#git(["update-ref", "-d", ref], {
          cwd: repository.mirrorDir,
          timeoutMs: this.#gitTimeoutMs,
          signal: fencingSignal,
        });
        const lostAfterUpdate = repositoryLockOwnershipLoss(ownershipSignal);
        if (lostAfterUpdate !== null) throw lostAfterUpdate;
      } catch (error) {
        failures.push(error);
      }
    }
    const ownershipLoss = repositoryLockOwnershipLoss(ownershipSignal);
    if (ownershipLoss !== null) throw ownershipLoss;
    if (failures.length > 0) {
      throw new WebError(500, "repository temporary refs could not be cleaned");
    }
  }

  async #mergeBase(
    repository: RepositoryRecord,
    baseRef: string,
    headRef: string,
    signal: AbortSignal,
  ): Promise<string> {
    // Preserve GitHub/base...head argument order. In a criss-cross history plain merge-base selects
    // the same single best base the previous full-clone pipeline used; comparison stays compatible.
    const output = (await this.#git(["merge-base", baseRef, headRef], {
      cwd: repository.mirrorDir,
      timeoutMs: this.#gitTimeoutMs,
      signal,
    })).trim();
    return requireCommit(output);
  }

  async #createPullRequestWorkspace(
    repository: RepositoryRecord,
    workspaceId: string,
    baseSha: string,
    headSha: string,
    mergeBaseSha: string,
    token: string | undefined,
    signal: AbortSignal,
  ): Promise<PullRequestRecord> {
    const root = join(repository.entry, "workspaces", "pull-requests", workspaceId);
    const record: PullRequestRecord = {
      ...repository,
      workspaceId,
      root,
      baseSha,
      headSha,
      mergeBaseSha,
      headDir: join(root, "head"),
      comparisonDir: join(root, "comparison"),
    };
    mkdirPrivate(root);
    try {
      await this.#addWorktree(repository, record.headDir, headSha, token, signal);
      await this.#addWorktree(repository, record.comparisonDir, mergeBaseSha, token, signal);
      if (!(await this.#validPullRequestWorktreePair(record, signal))) {
        throw new WebError(422, "pull request workspaces failed verification");
      }
      writePrivateJson(join(root, "metadata.json"), {
        formatVersion: STORE_FORMAT_VERSION,
        objectFormat: repository.objectFormat,
        kind: "pull-request",
        repositoryKey: repository.repositoryKey,
        remoteUrl: repository.remoteUrl,
        workspaceId,
        baseSha,
        headSha,
        mergeBaseSha,
      } satisfies PullRequestWorkspaceMetadata);
      return record;
    } catch (error) {
      const ownershipLoss = repositoryLockOwnershipLoss(signal, error);
      if (ownershipLoss !== null) throw ownershipLoss;
      await this.#cleanupFailedWorktrees(
        repository,
        [record.comparisonDir, record.headDir],
        root,
        signal,
      );
      throw error;
    }
  }

  async #addWorktree(
    repository: RepositoryRecord,
    path: string,
    commit: string,
    token: string | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    await this.#git(["worktree", "add", "--detach", "--no-checkout", path, commit], {
      cwd: repository.mirrorDir,
      token,
      timeoutMs: this.#gitTimeoutMs,
      signal,
    });
    await this.#git(["checkout", "--detach", "--force", commit], {
      cwd: path,
      token,
      timeoutMs: this.#gitTimeoutMs,
      signal,
    });
  }

  async #validCommitWorkspace(workspace: WorkspaceRecord, signal?: AbortSignal): Promise<boolean> {
    const metadata = readMetadata<CommitWorkspaceMetadata>(join(dirname(workspace.repoDir), "metadata.json"));
    return metadata !== null
      && metadata.formatVersion === STORE_FORMAT_VERSION
      && metadata.objectFormat === workspace.objectFormat
      && metadata.kind === "commit"
      && metadata.repositoryKey === workspace.repositoryKey
      && metadata.remoteUrl === workspace.remoteUrl
      && metadata.commit === workspace.commit
      && await this.#validWorktree(workspace.repoDir, workspace.commit, signal);
  }

  async #validPullRequestWorkspace(record: PullRequestRecord, signal?: AbortSignal): Promise<boolean> {
    return await this.#validPullRequestWorktreePair(record, signal);
  }

  async #validPullRequestWorktreePair(record: PullRequestRecord, signal?: AbortSignal): Promise<boolean> {
    return await this.#validWorktree(record.headDir, record.headSha, signal)
      && await this.#validWorktree(record.comparisonDir, record.mergeBaseSha, signal);
  }

  async #validWorktree(path: string, expectedSha: string, signal?: AbortSignal): Promise<boolean> {
    if (!isPlainDirectory(path)) return false;
    try {
      // Workspaces are private, host-local immutable publications. Main historically validated
      // cached clones by exact HEAD; keep that boundary instead of adding an O(repository) status
      // scan to every warm hit. Same-user filesystem tampering is outside this cache's trust model.
      const actual = requireCommit((await this.#git(["rev-parse", "HEAD"], {
        cwd: path,
        timeoutMs: this.#gitTimeoutMs,
        signal,
      })).trim());
      return actual === expectedSha;
    } catch (error) {
      if (signal?.aborted) throw error;
      return false;
    }
  }

  async #removeBrokenCommitWorkspace(workspace: WorkspaceRecord, signal: AbortSignal): Promise<void> {
    if (!existsSync(dirname(workspace.repoDir))) return;
    if (this.#hasLeasesWithin(dirname(workspace.repoDir))) {
      throw new WebError(409, "repository workspace is invalid while in use");
    }
    if (await this.#validRepository(workspace, signal)) {
      await this.#cleanupWorktree(workspace, workspace.repoDir, signal);
      await this.#pruneWorktrees(workspace, signal);
    }
    removeWithin(this.#root, dirname(workspace.repoDir));
  }

  async #acquireCommitLease(
    workspace: WorkspaceRecord,
    cache: "hit" | "miss" = "hit",
    signal?: AbortSignal,
  ): Promise<RepositoryWorkspaceLease | null> {
    let lease: RepositoryWorkspaceLease | null | undefined;
    try {
      lease = await this.#withRepositoryLock(workspace.repositoryKey, signal, async (lockSignal) => {
        if (!(await this.#validCommitWorkspace(workspace, lockSignal))) return null;
        return this.#lease(workspace, cache);
      });
      throwIfAborted(signal);
      return lease;
    } catch (error) {
      lease?.release();
      throw error;
    }
  }

  #prepared(record: PullRequestRecord, cache: "hit" | "miss"): PreparedPullRequest {
    const head = this.#lease({ ...record, commit: record.headSha, repoDir: record.headDir }, cache);
    let comparison: RepositoryWorkspaceLease;
    try {
      comparison = this.#lease({ ...record, commit: record.mergeBaseSha, repoDir: record.comparisonDir }, cache);
    } catch (error) {
      head.release();
      throw error;
    }
    let released = false;
    let discardPromise: Promise<void> | undefined;
    const release = () => {
      if (released) return;
      released = true;
      head.release();
      comparison.release();
    };
    const prepared: PreparedPullRequest = {
      repositoryKey: record.repositoryKey,
      remoteUrl: record.remoteUrl,
      workspaceId: record.workspaceId,
      baseSha: record.baseSha,
      headSha: record.headSha,
      mergeBaseSha: record.mergeBaseSha,
      head,
      comparison,
      release,
      discard: () => {
        release();
        discardPromise ??= this.#discardPrepared(record);
        return discardPromise;
      },
      [Symbol.dispose]: release,
    };
    return prepared;
  }

  async #discardPrepared(record: PullRequestRecord): Promise<void> {
    if (!existsSync(record.root)) return;
    if (this.#hasLeasesWithin(record.root)) {
      throw new WebError(409, "pull request workspace is still in use");
    }
    await this.#withRepositoryLock(record.repositoryKey, undefined, async (signal) => {
      if (!existsSync(record.root)) return;
      if (this.#hasLeasesWithin(record.root)) {
        throw new WebError(409, "pull request workspace is still in use");
      }
      if (await this.#validRepository(record, signal)) {
        await this.#cleanupWorktree(record, record.comparisonDir, signal);
        await this.#cleanupWorktree(record, record.headDir, signal);
        await this.#pruneWorktrees(record, signal);
      }
      removeWithin(this.#root, record.root);
      const mutation = this.#readMutation(record);
      if (mutation?.kind === "pull-request-workspace" && mutation.workspaceId === record.workspaceId) {
        await this.#deleteInternalRefs(record, incomingRefs(mutation), signal);
        this.#finishMutation(record, mutation);
      }
    });
  }

  /**
   * Finish rollback independently of the cancelled request that caused it. Each Git command keeps
   * the manager's bounded timeout; failures remain best-effort so the original operation error is
   * preserved, and prune is attempted even when one side is only partially registered.
   */
  async #cleanupFailedWorktrees(
    repository: RepositoryRecord,
    paths: readonly string[],
    root: string,
    ownershipSignal?: AbortSignal,
  ): Promise<boolean> {
    const fencingSignal = repositoryLockFencingSignal(ownershipSignal);
    let complete = true;
    for (const path of paths) {
      try {
        const ownershipLoss = repositoryLockOwnershipLoss(ownershipSignal);
        if (ownershipLoss !== null) throw ownershipLoss;
        await this.#cleanupWorktree(repository, path, fencingSignal);
      } catch {
        complete = false;
        // The direct-path fallback inside cleanup may itself fail. Continue to the other side and
        // prune so one cleanup failure cannot strand every worktree in the generation.
      }
    }
    try {
      const ownershipLoss = repositoryLockOwnershipLoss(ownershipSignal);
      if (ownershipLoss !== null) throw ownershipLoss;
      await this.#pruneWorktrees(repository, fencingSignal);
    } catch {
      complete = false;
      // Preserve the request's original failure. A later locked mutation prunes again.
    }
    try {
      const ownershipLoss = repositoryLockOwnershipLoss(ownershipSignal);
      if (ownershipLoss !== null) throw ownershipLoss;
      removeWithin(this.#root, root);
    } catch {
      complete = false;
      // Preserve the original failure; retention can remove an unpublished orphan later.
    }
    const ownershipLoss = repositoryLockOwnershipLoss(ownershipSignal);
    if (ownershipLoss !== null) throw ownershipLoss;
    return complete && !existsSync(root);
  }

  async #cleanupWorktree(repository: RepositoryRecord, path: string, signal?: AbortSignal): Promise<void> {
    if (!existsSync(path)) return;
    try {
      await this.#git(["worktree", "remove", "--force", path], {
        cwd: repository.mirrorDir,
        timeoutMs: this.#gitTimeoutMs,
        signal,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      // A failed `worktree add` may leave a directory without a complete Git registration. Removing
      // that unpublished directory is safe; the following prune removes any one-sided admin entry.
      removeWithin(this.#root, path);
    }
  }

  async #pruneWorktrees(repository: RepositoryRecord, signal?: AbortSignal): Promise<void> {
    await this.#git(["worktree", "prune", "--expire", "now"], {
      cwd: repository.mirrorDir,
      timeoutMs: this.#gitTimeoutMs,
      signal,
    });
  }

  #lease(workspace: WorkspaceRecord, cache: "hit" | "miss"): RepositoryWorkspaceLease {
    // The marker makes leases visible to every service process sharing this host-local cache. All
    // creation happens under the repository lock, so repair cannot pass a no-lease check while a
    // reader is acquiring the path.
    const leaseRoot = join(dirname(workspace.repoDir), ".leases");
    const owner: LeaseOwner = {
      formatVersion: STORE_FORMAT_VERSION,
      host: hostname(),
      kind: "workspace-lease",
      nonce: randomUUID(),
      pid: process.pid,
      sessionNonce: this.#leaseSessionNonce,
    };
    mkdirPrivate(leaseRoot);
    const marker = join(leaseRoot, `${owner.nonce}.json`);
    this.#startLeaseHeartbeat();
    try {
      writePrivateJson(marker, owner);
    } catch (error) {
      this.#stopLeaseHeartbeatIfIdle();
      throw error;
    }
    this.#leaseMarkers.add(marker);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.#leaseMarkers.delete(marker);
      rmSync(marker, { force: true });
      this.#stopLeaseHeartbeatIfIdle();
    };
    return {
      cache,
      repositoryKey: workspace.repositoryKey,
      remoteUrl: workspace.remoteUrl,
      commit: workspace.commit,
      repoDir: workspace.repoDir,
      release,
      [Symbol.dispose]: release,
    };
  }

  #hasLeasesWithin(root: string): boolean {
    if (!isPlainDirectory(root)) return false;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      const path = join(root, entry.name);
      if (entry.isSymbolicLink()) return true;
      if (!entry.isDirectory()) continue;
      if (entry.name === ".leases") {
        if (this.#leaseDirectoryHasLiveMarker(path)) return true;
        continue;
      }
      // Lease directories are adjacent to worktree roots. Never traverse repository source trees.
      if (entry.name === "repo" || entry.name === "head" || entry.name === "comparison") continue;
      if (this.#hasLeasesWithin(path)) return true;
    }
    return false;
  }

  #leaseDirectoryHasLiveMarker(leaseRoot: string): boolean {
    for (const entry of readdirSync(leaseRoot, { withFileTypes: true })) {
      const marker = join(leaseRoot, entry.name);
      if (!entry.isFile() || entry.isSymbolicLink()) return true;
      const owner = readMetadata<LeaseOwner>(marker);
      const validOwner = owner?.formatVersion === STORE_FORMAT_VERSION
        && owner.kind === "workspace-lease"
        && typeof owner.host === "string"
        && typeof owner.nonce === "string"
        && typeof owner.sessionNonce === "string"
        && SESSION_ID.test(owner.sessionNonce)
        && Number.isSafeInteger(owner.pid)
        && owner.pid! > 0;
      if (validOwner && owner.host !== hostname()) return true;
      if (validOwner) {
        try {
          const session = join(this.#root, "sessions", `${owner.sessionNonce}.json`);
          const sessionOwner = readMetadata<LeaseSessionOwner>(session);
          if (
            sessionOwner?.formatVersion === STORE_FORMAT_VERSION
            && sessionOwner.host === hostname()
            && sessionOwner.kind === "lease-session"
            && sessionOwner.nonce === owner.sessionNonce
            && Date.now() - statSync(session).mtimeMs < this.#staleLockMs
          ) return true;
        } catch {
          // Fall through to the live-process safety net below.
        }
        try {
          process.kill(owner.pid!, 0);
          return true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
        }
      }
      try {
        if (Date.now() - statSync(marker).mtimeMs < this.#staleLockMs) return true;
        rmSync(marker, { force: true });
      } catch {
        return true;
      }
    }
    return false;
  }

  #startLeaseHeartbeat(): void {
    if (this.#leaseSessionHeartbeat !== undefined) return;
    const session = join(this.#root, "sessions", `${this.#leaseSessionNonce}.json`);
    writePrivateJson(session, {
      formatVersion: STORE_FORMAT_VERSION,
      host: hostname(),
      kind: "lease-session",
      nonce: this.#leaseSessionNonce,
      pid: process.pid,
    } satisfies LeaseSessionOwner);
    this.#leaseSessionHeartbeat = setInterval(() => {
      const now = new Date();
      try {
        utimesSync(session, now, now);
      } catch {
        // Lease acquisition/repair fails closed while a marker has no fresh owning session.
      }
    }, Math.max(10, Math.min(30_000, Math.floor(this.#staleLockMs / 3))));
    this.#leaseSessionHeartbeat.unref();
  }

  #stopLeaseHeartbeatIfIdle(): void {
    if (this.#leaseMarkers.size !== 0 || this.#leaseSessionHeartbeat === undefined) return;
    clearInterval(this.#leaseSessionHeartbeat);
    this.#leaseSessionHeartbeat = undefined;
    rmSync(join(this.#root, "sessions", `${this.#leaseSessionNonce}.json`), { force: true });
  }

  #repositoryRecord(
    remoteUrl: string,
    repositoryKey: string,
    objectFormat: GitObjectFormat,
  ): RepositoryRecord {
    const entry = join(this.#repositoriesRoot, repositoryKey);
    return { entry, mirrorDir: join(entry, "mirror.git"), objectFormat, repositoryKey, remoteUrl };
  }

  #commitWorkspaceRecord(repository: RepositoryRecord, commit: string): WorkspaceRecord {
    const slot = createHash("sha256").update(commit).digest("hex").slice(0, 24);
    return {
      ...repository,
      commit,
      repoDir: join(repository.entry, "workspaces", "commits", slot, "repo"),
    };
  }

  async #withRepositoryLock<Result>(
    repositoryKey: string,
    sourceSignal: AbortSignal | undefined,
    work: (signal: AbortSignal) => Promise<Result>,
  ): Promise<Result> {
    throwIfAborted(sourceSignal);
    await this.#assertHostLocalStore(sourceSignal);
    mkdirPrivate(this.#locksRoot);
    const lockDir = join(this.#locksRoot, `${repositoryKey}.lock`);
    const owner: LockOwner = {
      formatVersion: STORE_FORMAT_VERSION,
      host: hostname(),
      nonce: randomUUID(),
      pid: process.pid,
    };
    const started = Date.now();
    while (true) {
      throwIfAborted(sourceSignal);
      try {
        mkdirSync(lockDir, { mode: 0o700 });
        try {
          writePrivateJson(join(lockDir, "owner.json"), owner);
        } catch (error) {
          removeWithin(this.#root, lockDir);
          throw error;
        }
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const recovery = this.#lockRecoveryState(lockDir);
        if (recovery === "live-owner") {
          throw new WebError(503, "repository mirror owner is unresponsive; retry the request");
        }
        if (recovery === "recoverable") {
          const stale = join(this.#locksRoot, `.stale-${repositoryKey}-${randomUUID()}`);
          try {
            renameSync(lockDir, stale);
            removeWithin(this.#root, stale);
            continue;
          } catch {
            // Another process recovered or released it first. Retry the normal acquisition path.
          }
        }
        if (this.#lockWaitTimeoutMs !== undefined && Date.now() - started >= this.#lockWaitTimeoutMs) {
          throw new WebError(503, "repository mirror is busy; retry the request");
        }
        await abortableDelay(LOCK_RETRY_MS, sourceSignal);
      }
    }
    const controller = new AbortController();
    const fencingController = new AbortController();
    REPOSITORY_LOCK_FENCING.set(controller.signal, fencingController.signal);
    const abort = () => controller.abort(sourceSignal?.reason);
    const loseOwnership = () => {
      const error = new RepositoryLockOwnershipLostError();
      fencingController.abort(error);
      controller.abort(error);
    };
    const heartbeat = setInterval(
      () => this.#renewLock(lockDir, owner, loseOwnership),
      Math.max(10, Math.min(30_000, Math.floor(this.#staleLockMs / 3))),
    );
    heartbeat.unref();
    sourceSignal?.addEventListener("abort", abort, { once: true });
    if (sourceSignal?.aborted) abort();
    try {
      // Do not perform a post-work abort check here. Some callbacks publish a lease as their
      // result; rejecting after the callback has returned would hide that owned handle from the
      // caller and make cancellation cleanup impossible. Signal-bearing callers check again only
      // after assigning the result, so ownership always escapes before cancellation can win.
      return await work(controller.signal);
    } finally {
      clearInterval(heartbeat);
      REPOSITORY_LOCK_FENCING.delete(controller.signal);
      sourceSignal?.removeEventListener("abort", abort);
      const current = readMetadata<LockOwner>(join(lockDir, "owner.json"));
      if (current?.nonce === owner.nonce) removeWithin(this.#root, lockDir);
    }
  }

  #lockRecoveryState(lockDir: string): "fresh" | "live-owner" | "recoverable" {
    try {
      const ownerPath = join(lockDir, "owner.json");
      const heartbeatPath = isPlainFile(ownerPath) ? ownerPath : lockDir;
      if (Date.now() - statSync(heartbeatPath).mtimeMs < this.#staleLockMs) return "fresh";
      const owner = readMetadata<LockOwner>(ownerPath);
      if (
        owner?.host === hostname()
        && Number.isSafeInteger(owner.pid)
        && owner.pid! > 0
        && processIsLive(owner.pid!)
      ) {
        // Never steal from a live process. Heartbeat delay can mean a blocked event loop, and PID
        // reuse cannot be distinguished portably; a retryable failure is safer than two writers.
        return "live-owner";
      }
      return "recoverable";
    } catch {
      return "fresh";
    }
  }

  #renewLock(lockDir: string, owner: LockOwner, loseOwnership: () => void): void {
    const ownerPath = join(lockDir, "owner.json");
    try {
      const current = readMetadata<LockOwner>(ownerPath);
      if (current?.nonce !== owner.nonce) {
        loseOwnership();
        return;
      }
      writeFileSync(ownerPath, `${JSON.stringify(owner, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
    } catch {
      // Stop the in-flight Git process before another owner can recover the stale lock.
      loseOwnership();
    }
  }

  async #assertHostLocalStore(signal?: AbortSignal): Promise<void> {
    mkdirPrivate(this.#root);
    const marker = join(this.#root, "host.json");
    try {
      writeFileSync(marker, `${JSON.stringify({
        formatVersion: STORE_FORMAT_VERSION,
        host: hostname(),
      } satisfies StoreOwner, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    // Multiple processes on one host are supported. A network volume shared by unrelated hosts
    // needs distributed lease semantics and is rejected rather than guessed at.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const owner = readMetadata<StoreOwner>(marker);
      if (owner?.formatVersion === STORE_FORMAT_VERSION && owner.host === hostname()) return;
      if (owner?.host !== undefined && owner.host !== hostname()) {
        throw new WebError(409, "repository mirror cache is host-local and already belongs to another host");
      }
      await abortableDelay(5, signal);
    }
    throw new WebError(409, "repository mirror cache ownership metadata is invalid");
  }

  #shared<Result>(
    key: string,
    signal: AbortSignal | undefined,
    work: (signal: AbortSignal) => Promise<Result>,
  ): Promise<Result> {
    throwIfAborted(signal);
    let job = this.#jobs.get(key) as SharedJob<Result> | undefined;
    if (!job) {
      const controller = new AbortController();
      const created: SharedJob<Result> = {
        controller,
        promise: Promise.resolve(undefined as Result),
        settled: false,
        waiters: new Set(),
      };
      created.promise = Promise.resolve().then(() => work(controller.signal)).finally(() => {
        created.settled = true;
        if (this.#jobs.get(key) === created) this.#jobs.delete(key);
      });
      this.#jobs.set(key, created as SharedJob<unknown>);
      job = created;
    }
    const waiter = Symbol(key);
    job.waiters.add(waiter);
    return new Promise<Result>((resolveJob, rejectJob) => {
      let active = true;
      const detach = () => {
        if (!active) return false;
        active = false;
        signal?.removeEventListener("abort", abort);
        job!.waiters.delete(waiter);
        if (!job!.settled && job!.waiters.size === 0 && !job!.controller.signal.aborted) {
          job!.controller.abort(new WebError(499, "repository preparation was cancelled"));
        }
        return true;
      };
      const abort = () => {
        if (detach()) rejectJob(signal?.reason ?? new WebError(499, "repository preparation was cancelled"));
      };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      job!.promise.then(
        (result) => { if (detach()) resolveJob(result); },
        (error: unknown) => { if (detach()) rejectJob(error); },
      );
    });
  }

  #canonicalRemote(value: string): string {
    return canonicalGitRemoteUrl(value, { allowFile: this.#allowFileRemotes });
  }
}

function normalizeExpectedRef(value: ExpectedRemoteRef): ExpectedRemoteRef {
  const remoteRef = requireRemoteRef(value.remoteRef);
  const expectedSha = requireCommit(value.expectedSha);
  return { remoteRef, expectedSha };
}

function repositoryLockOwnershipLoss(
  signal?: AbortSignal,
  error?: unknown,
): RepositoryLockOwnershipLostError | null {
  if (error instanceof RepositoryLockOwnershipLostError) return error;
  if (signal === undefined) return null;
  const fencingReason = REPOSITORY_LOCK_FENCING.get(signal)?.reason;
  if (fencingReason instanceof RepositoryLockOwnershipLostError) return fencingReason;
  return signal.reason instanceof RepositoryLockOwnershipLostError ? signal.reason : null;
}

function repositoryLockFencingSignal(signal?: AbortSignal): AbortSignal | undefined {
  return signal === undefined ? undefined : REPOSITORY_LOCK_FENCING.get(signal);
}

function processIsLive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function requireRemoteRef(value: string): string {
  if (value === "HEAD") return value;
  for (const prefix of ["refs/heads/", "refs/tags/"] as const) {
    if (value.startsWith(prefix) && isAllowedCloneRef(value.slice(prefix.length))) return value;
  }
  if (/^refs\/pull\/[1-9]\d*\/head$/.test(value)) return value;
  throw new WebError(400, "repository remote ref is invalid");
}

function requireCommit(value: string): string {
  if (!COMMIT.test(value)) throw new WebError(422, "git returned an invalid commit id");
  return value.toLowerCase();
}

function objectFormatForCommit(commit: string): GitObjectFormat {
  return commit.length === 64 ? "sha256" : "sha1";
}

function matchingObjectFormat(first: string, ...rest: string[]): GitObjectFormat {
  const objectFormat = objectFormatForCommit(first);
  if (rest.some((commit) => objectFormatForCommit(commit) !== objectFormat)) {
    throw new WebError(422, "repository revisions use inconsistent Git object formats");
  }
  return objectFormat;
}

function isHistoryMode(value: unknown): value is MirrorMetadata["historyMode"] {
  return value === "tip" || value === "promoting" || value === "complete";
}

function requireWorkspaceId(value: string): string {
  if (!WORKSPACE_ID.test(value)) throw new WebError(400, "pull request workspace id is invalid");
  return value;
}

function requireRepositoryKey(value: string): string {
  if (!/^[a-f0-9]{24}$/.test(value)) throw new WebError(400, "repository key is invalid");
  return value;
}

function internalRef(revision: ExpectedRemoteRef): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([STORE_FORMAT_VERSION, revision.remoteRef, revision.expectedSha]))
    .digest("hex");
  return `refs/meridian/snapshots/${digest}`;
}

function incomingRefs(mutation: RepositoryMutation): string[] {
  return Array.from(
    { length: mutation.incomingCount },
    (_unused, index) => `refs/meridian/incoming/${mutation.operationId}/${index}`,
  );
}

function mkdirPrivate(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

function writePrivateJson(path: string, value: unknown): void {
  mkdirPrivate(dirname(path));
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function readMetadata<Value>(path: string): Partial<Value> | null {
  try {
    if (!isPlainFile(path)) return null;
    return JSON.parse(readFileSync(path, "utf8")) as Partial<Value>;
  } catch {
    return null;
  }
}

function isPlainFile(path: string): boolean {
  try {
    const entry = lstatSync(path);
    return entry.isFile() && !entry.isSymbolicLink();
  } catch {
    return false;
  }
}

function isPlainDirectory(path: string): boolean {
  try {
    const entry = lstatSync(path);
    return entry.isDirectory() && !entry.isSymbolicLink();
  } catch {
    return false;
  }
}

function removeWithin(root: string, path: string): void {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(path);
  if (resolvedPath === resolvedRoot || !resolvedPath.startsWith(resolvedRoot + sep)) {
    throw new Error(`refusing to remove a path outside the repository store: ${basename(path)}`);
  }
  rmSync(resolvedPath, { recursive: true, force: true });
}

function requirePositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${label} must be a positive integer`);
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolveDelay, rejectDelay) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolveDelay();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      rejectDelay(signal?.reason);
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}
