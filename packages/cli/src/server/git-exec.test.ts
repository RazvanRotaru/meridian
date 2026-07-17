/**
 * Argv-level tests for the shared git runner — no real git, `spawn` is mocked. These pin the
 * security invariants: argv-only spawn, token only via `-c http.extraHeader` (never a URL),
 * token/base64 scrubbed from stderr AND thrown error text, and the per-call timeout kill.
 */

import { describe, expect, it, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { base64Auth, runGit, streamGitLines } from "./git-exec";
import { WebError } from "./web-error";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

const TOKEN = "ghp_secret123";

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
  pid?: number;
}

describe("runGit", () => {
  afterEach(() => {
    vi.mocked(spawn).mockReset();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("funnels through the shared spawn: argv-only, cwd honored, stdout returned", async () => {
    const child = nextChild();
    const pending = runGit(["fetch", "origin", "main"], { cwd: "/clone" });
    child.stdout.emit("data", Buffer.from("out-line\n"));
    child.emit("close", 0);
    await expect(pending).resolves.toBe("out-line\n");
    expect(spawn).toHaveBeenCalledWith("git", ["fetch", "origin", "main"], expect.objectContaining({ cwd: "/clone" }));
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

  it("streams split lines with consumer backpressure and bounded carry", async () => {
    const child = nextChild();
    let resumeFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { resumeFirst = resolve; });
    let firstStarted!: () => void;
    const started = new Promise<void>((resolve) => { firstStarted = resolve; });
    const lines: string[] = [];
    const pending = streamGitLines(["for-each-ref"], { cwd: "/clone" }, async (line) => {
      lines.push(line);
      if (line === "first") {
        firstStarted();
        await firstGate;
      }
    });

    child.stdout.emit("data", Buffer.from("first\nsec"));
    child.stdout.emit("data", Buffer.from("ond\nthird"));
    child.emit("close", 0);
    await started;
    expect(lines).toEqual(["first"]);

    resumeFirst();
    await expect(pending).resolves.toBeUndefined();
    expect(lines).toEqual(["first", "second", "third"]);
  });

  it("injects the token ONLY as a -c http.extraHeader before the subcommand — never raw in argv", async () => {
    const child = nextChild();
    const pending = runGit(["fetch", "origin", "main"], { cwd: "/clone", token: TOKEN });
    child.emit("close", 0);
    await pending;
    const argv = vi.mocked(spawn).mock.calls[0][1] as string[];
    expect(argv.slice(0, 2)).toEqual(["-c", `http.extraHeader=AUTHORIZATION: basic ${base64Auth(TOKEN)}`]);
    expect(argv.slice(2)).toEqual(["fetch", "origin", "main"]);
    expect(argv.join(" ")).not.toContain(TOKEN);
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
    child.emit("close", null);
    const message = await rejectionMessage(pending);
    expect(message).toContain("could not run git");
    expect(message).not.toContain(TOKEN);
  });

  it("scrubs a synchronous spawn failure", async () => {
    vi.mocked(spawn).mockImplementationOnce(() => {
      throw new Error(`invalid spawn option containing ${TOKEN}`);
    });
    const message = await rejectionMessage(runGit(["status"], { cwd: "/clone", token: TOKEN }));
    expect(message).toContain("could not run git");
    expect(message).not.toContain(TOKEN);
  });

  it("kills the child and rejects when the per-call timeout elapses", async () => {
    vi.useFakeTimers();
    const child = nextChild();
    const pending = runGit(["fetch", "origin", "main"], { cwd: "/clone", timeoutMs: 5_000 });
    let settled = false;
    void pending.finally(() => {
      settled = true;
    }).catch(() => undefined);
    vi.advanceTimersByTime(5_000);
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    child.emit("close", null, "SIGTERM");
    await expect(pending).rejects.toThrow("git timed out after 5s");
  });

  it("honors cancellation and rejects only after the git process closes", async () => {
    const child = nextChild();
    const controller = new AbortController();
    const reason = new Error("request disconnected");
    reason.name = "AbortError";
    const pending = runGit(["fetch", "origin", "main"], { cwd: "/clone", signal: controller.signal });
    let settled = false;
    void pending.finally(() => {
      settled = true;
    }).catch(() => undefined);

    controller.abort(reason);
    await Promise.resolve();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(settled).toBe(false);

    child.emit("close", null, "SIGTERM");
    await expect(pending).rejects.toBe(reason);
  });

  it("keeps a cancelled run pending until its POSIX process group is killed", async () => {
    if (process.platform === "win32") return;
    vi.useFakeTimers();
    let groupAlive = true;
    const kill = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
      expect(pid).toBe(-4242);
      if (signal === 0) {
        if (!groupAlive) throw Object.assign(new Error("gone"), { code: "ESRCH" });
        return true;
      }
      return true;
    }) as typeof process.kill);
    const child = nextChild(4242);
    const pending = runGit(["fetch", "origin"], { cwd: "/clone", timeoutMs: 10 });
    let settled = false;
    void pending.finally(() => { settled = true; }).catch(() => undefined);

    vi.advanceTimersByTime(10);
    child.emit("close", null, "SIGTERM");
    vi.advanceTimersByTime(4_999);
    await Promise.resolve();
    expect(settled).toBe(false);
    vi.advanceTimersByTime(1);
    await Promise.resolve();
    expect(settled).toBe(false);
    groupAlive = false;
    vi.advanceTimersByTime(25);
    await expect(pending).rejects.toThrow("git timed out");
    expect(kill).toHaveBeenCalledWith(-4242, "SIGTERM");
    expect(kill).toHaveBeenCalledWith(-4242, "SIGKILL");
  });

  it("surfaces a bounded failure when POSIX cannot confirm process-group disappearance", async () => {
    if (process.platform === "win32") return;
    vi.useFakeTimers();
    vi.spyOn(process, "kill").mockImplementation(((pid: number, _signal?: string | number) => {
      expect(pid).toBe(-4343);
      return true;
    }) as typeof process.kill);
    const child = nextChild(4343);
    const pending = runGit(["fetch", "origin"], { cwd: "/clone", timeoutMs: 10 });

    vi.advanceTimersByTime(10);
    child.emit("close", null, "SIGTERM");
    vi.advanceTimersByTime(10_000);
    await expect(pending).rejects.toMatchObject({
      status: 500,
      message: "could not confirm git process tree termination",
    });
  });

  it("escalates a non-isolated Git child without killing its supervisor's process group", async () => {
    if (process.platform === "win32") return;
    vi.useFakeTimers();
    const groupKill = vi.spyOn(process, "kill");
    const child = nextChild(4444);
    const pending = runGit(["diff", "--stat"], {
      cwd: "/clone",
      timeoutMs: 10,
      isolateProcessGroup: false,
    });

    vi.advanceTimersByTime(10);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    vi.advanceTimersByTime(4_999);
    expect(child.kill).not.toHaveBeenCalledWith("SIGKILL");
    vi.advanceTimersByTime(1);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(groupKill).not.toHaveBeenCalled();
    child.emit("close", null, "SIGKILL");
    await expect(pending).rejects.toThrow("git timed out");
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
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  child.pid = pid;
  vi.mocked(spawn).mockReturnValueOnce(child as never);
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
