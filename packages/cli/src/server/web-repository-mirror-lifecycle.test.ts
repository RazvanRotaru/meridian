import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  RepositoryMirrorClosedError,
  WebRepositoryMirror,
} from "./web-repository-mirror";

const COMMIT = "1".repeat(40);

describe("WebRepositoryMirror shutdown", () => {
  it("aborts and awaits underlying Git cleanup, stays closed, and preserves the persistent store", async () => {
    const root = mkdtempSync(join(tmpdir(), "meridian-mirror-close-"));
    const cacheRoot = join(root, "cache");
    const remoteRoot = join(root, "remote.git");
    mkdirSync(remoteRoot);
    const gitStarted = deferred<AbortSignal | undefined>();
    const releaseGit = deferred<void>();
    const git: typeof import("./git-exec").runGit = async (_args, options) => {
      gitStarted.resolve(options.signal);
      await releaseGit.promise;
      if (options.signal?.aborted) throw options.signal.reason;
      return "";
    };
    const mirror = new WebRepositoryMirror({
      cacheRoot,
      allowFileRemotesForTests: true,
      git,
      retention: { initialDelayMs: 60_000 },
    });
    const remoteUrl = pathToFileURL(remoteRoot).href;
    const operation = mirror.acquireWorkspace({
      remoteUrl,
      revision: { remoteRef: "refs/heads/main", expectedSha: COMMIT },
    });
    void operation.catch(() => {});
    try {
      const gitSignal = await gitStarted.promise;
      const closing = mirror.close();
      expect(mirror.close()).toBe(closing);
      expect(gitSignal?.aborted).toBe(true);

      let closed = false;
      void closing.then(() => {
        closed = true;
      });
      await Promise.resolve();
      expect(closed).toBe(false);

      releaseGit.resolve();
      await expect(operation).rejects.toBeInstanceOf(RepositoryMirrorClosedError);
      await closing;
      expect(existsSync(cacheRoot)).toBe(true);

      await expect(mirror.acquireCachedWorkspace({
        remoteUrl: "not a remote",
        expectedSha: "not a commit",
      })).rejects.toBeInstanceOf(RepositoryMirrorClosedError);
      await expect(mirror.acquireWorkspace({
        remoteUrl: "not a remote",
        revision: { remoteRef: "--invalid", expectedSha: "not a commit" },
      })).rejects.toBeInstanceOf(RepositoryMirrorClosedError);
      await expect(mirror.preparePullRequest({
        remoteUrl: "not a remote",
        base: { remoteRef: "--invalid", expectedSha: "not a commit" },
        head: { remoteRef: "--invalid", expectedSha: "not a commit" },
      })).rejects.toBeInstanceOf(RepositoryMirrorClosedError);
      await expect(mirror.acquirePreparedPullRequest({
        repositoryKey: "invalid",
        remoteUrl: "not a remote",
        workspaceId: "invalid",
        baseSha: "invalid",
        headSha: "invalid",
        mergeBaseSha: "invalid",
      })).rejects.toBeInstanceOf(RepositoryMirrorClosedError);
    } finally {
      releaseGit.resolve();
      await mirror.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function deferred<Value>() {
  let resolve!: (value: Value | PromiseLike<Value>) => void;
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
