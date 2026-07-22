/**
 * Argv-level tests for the shared git runner — no real git, `spawn` is mocked. These pin the
 * security invariants: argv-only spawn, credential transport outside argv/URLs, token/base64
 * scrubbed from stderr AND thrown error text, and the per-call timeout kill.
 */

import { describe, expect, it, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { base64Auth, runGit } from "./git-exec";
import { WebError } from "./web-error";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

const TOKEN = "ghp_secret123";

interface FakeChild extends EventEmitter {
  pid?: number;
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
}

describe("runGit", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(spawn).mockReset();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("funnels through the shared spawn: argv-only, cwd honored, stdout returned", async () => {
    const child = nextChild();
    const pending = runGit(["fetch", "origin", "main"], { cwd: "/clone" });
    child.stdout.emit("data", Buffer.from("out-line\n"));
    child.emit("close", 0);
    await expect(pending).resolves.toBe("out-line\n");
    expect(spawn).toHaveBeenCalledWith("git", ["fetch", "origin", "main"], expect.objectContaining({
      cwd: "/clone",
      detached: process.platform !== "win32",
    }));
  });

  it("decodes a UTF-8 character split across stdout chunks without replacement characters", async () => {
    const child = nextChild();
    const pending = runGit(["diff"], { cwd: "/clone" });
    const encoded = Buffer.from("before é after", "utf8");
    const split = encoded.indexOf(0xc3) + 1;
    child.stdout.emit("data", encoded.subarray(0, split));
    child.stdout.emit("data", encoded.subarray(split));
    child.emit("close", 0);

    await expect(pending).resolves.toBe("before é after");
  });

  it("injects the token through a dedicated child environment variable — never argv", async () => {
    const child = nextChild();
    const pending = runGit(["fetch", "origin", "main"], { cwd: "/clone", token: TOKEN });
    child.emit("close", 0);
    await pending;
    const argv = vi.mocked(spawn).mock.calls[0][1] as string[];
    const options = vi.mocked(spawn).mock.calls[0][2];
    expect(argv).toEqual([
      "--config-env=http.extraHeader=MERIDIAN_GIT_HTTP_EXTRA_HEADER",
      "fetch",
      "origin",
      "main",
    ]);
    expect(argv.join(" ")).not.toContain(TOKEN);
    expect(argv.join(" ")).not.toContain(base64Auth(TOKEN));
    expect(options?.env?.MERIDIAN_GIT_HTTP_EXTRA_HEADER)
      .toBe(`AUTHORIZATION: basic ${base64Auth(TOKEN)}`);
  });

  it("does not inherit the dedicated credential variable on an anonymous invocation", async () => {
    vi.stubEnv("MERIDIAN_GIT_HTTP_EXTRA_HEADER", "stale-secret");
    const child = nextChild();
    const pending = runGit(["status"], { cwd: "/clone" });
    child.emit("close", 0);
    await pending;

    const options = vi.mocked(spawn).mock.calls[0][2];
    expect(options?.env).not.toHaveProperty("MERIDIAN_GIT_HTTP_EXTRA_HEADER");
  });

  it("scrubs the token and its base64 form from git's stderr in the rejection", async () => {
    const child = nextChild();
    const pending = runGit(["fetch", "origin", "main"], { cwd: "/clone", token: TOKEN });
    child.stderr.emit("data", Buffer.from(`fatal: ${TOKEN} rejected (AUTHORIZATION: basic ${base64Auth(TOKEN)})`));
    child.emit("close", 128);
    const message = await rejectionMessage(pending);
    expect(message).not.toContain(TOKEN);
    expect(message).not.toContain(base64Auth(TOKEN));
    expect(message).toContain("***");
  });

  it("scrubs the token from a spawn error's own text", async () => {
    const child = nextChild();
    const pending = runGit(["fetch", "origin", "main"], { cwd: "/clone", token: TOKEN });
    child.emit("error", new Error(`ENOENT while running git with ${TOKEN}`));
    const message = await rejectionMessage(pending);
    expect(message).toContain("could not run git");
    expect(message).not.toContain(TOKEN);
  });

  it("kills the child and rejects when the per-call timeout elapses", async () => {
    vi.useFakeTimers();
    const child = nextChild();
    const pending = runGit(["fetch", "origin", "main"], { cwd: "/clone", timeoutMs: 5_000 });
    vi.advanceTimersByTime(5_000);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    let settled = false;
    void pending.catch(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    child.emit("close", null, "SIGKILL");
    await expect(pending).rejects.toThrow("git timed out after 5s");
  });

  it("rejects an already-aborted run without spawning git", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(runGit(["fetch", "origin", "main"], {
      cwd: "/clone",
      signal: controller.signal,
    })).rejects.toThrow("git operation was cancelled");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("kills and settles a running git child exactly once when aborted", async () => {
    const child = nextChild();
    const controller = new AbortController();
    const pending = runGit(["fetch", "origin", "main"], {
      cwd: "/clone",
      signal: controller.signal,
    });

    controller.abort();
    controller.abort();
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");

    child.stderr.emit("data", Buffer.from("fatal: late failure"));
    child.emit("close", 128);
    await expect(pending).rejects.toThrow("git operation was cancelled");
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it.skipIf(process.platform === "win32")("kills the complete POSIX Git process group", async () => {
    const groupKill = vi.spyOn(process, "kill").mockImplementation(() => true);
    const child = nextChild(4_321);
    const controller = new AbortController();
    const pending = runGit(["fetch", "origin", "main"], {
      cwd: "/clone",
      signal: controller.signal,
    });

    controller.abort();
    expect(groupKill).toHaveBeenCalledWith(-4_321, "SIGKILL");
    expect(child.kill).not.toHaveBeenCalled();

    let settled = false;
    void pending.catch(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    child.emit("close", null, "SIGKILL");
    await expect(pending).rejects.toThrow("git operation was cancelled");
  });

  it.runIf(process.platform === "win32")("kills the complete Windows Git process tree", async () => {
    const child = fakeChild(4_321);
    const killer = fakeChild();
    vi.mocked(spawn).mockReturnValueOnce(child as never).mockReturnValueOnce(killer as never);
    const controller = new AbortController();
    const pending = runGit(["fetch", "origin", "main"], {
      cwd: "C:\\clone",
      signal: controller.signal,
    });

    controller.abort();
    expect(spawn).toHaveBeenNthCalledWith(2, "taskkill.exe", ["/pid", "4321", "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    child.emit("close", null, "SIGKILL");
    let settled = false;
    void pending.catch(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    killer.emit("close", 0);
    await expect(pending).rejects.toThrow("git operation was cancelled");
  });

  it("does not kill a completed child when the signal aborts later", async () => {
    const child = nextChild();
    const controller = new AbortController();
    const pending = runGit(["status"], { cwd: "/clone", signal: controller.signal });
    child.emit("close", 0);
    await expect(pending).resolves.toBe("");

    controller.abort();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("rejects stdout overflow instead of returning a plausible truncated prefix", async () => {
    const child = nextChild();
    const pending = runGit(["diff", "--name-status", "-z"], { cwd: "/clone" });
    child.stdout.emit("data", Buffer.alloc(32 * 1024 * 1024 + 1, 0));
    child.emit("close", 0);
    await expect(pending).rejects.toThrow("refusing truncated output");
  });
});

/** Queue one fake child for the next spawn call; the test drives its streams and exit. */
function nextChild(pid?: number): FakeChild {
  const child = fakeChild(pid);
  vi.mocked(spawn).mockReturnValueOnce(child as never);
  return child;
}

function fakeChild(pid?: number): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

async function rejectionMessage(pending: Promise<unknown>): Promise<string> {
  try {
    await pending;
  } catch (error) {
    expect(error).toBeInstanceOf(WebError);
    return (error as WebError).message;
  }
  throw new Error("expected the git run to reject");
}
