/**
 * Argv-level tests for the shared git runner — no real git, `spawn` is mocked. These pin the
 * security invariants: argv-only spawn, token only via `-c http.extraHeader` (never a URL),
 * token/base64 scrubbed from stderr AND thrown error text, and the per-call timeout kill.
 */

import { describe, expect, it, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { base64Auth, runGit, runGitClone } from "./git-exec";
import { WebError } from "./web-error";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

const TOKEN = "ghp_secret123";

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
}

describe("runGit", () => {
  afterEach(() => {
    vi.mocked(spawn).mockReset();
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
    const message = await rejectionMessage(pending);
    expect(message).toContain("could not run git");
    expect(message).not.toContain(TOKEN);
  });

  it("kills the child and rejects when the per-call timeout elapses", async () => {
    vi.useFakeTimers();
    const child = nextChild();
    const pending = runGit(["fetch", "origin", "main"], { cwd: "/clone", timeoutMs: 5_000 });
    vi.advanceTimersByTime(5_000);
    await expect(pending).rejects.toThrow("git timed out after 5s");
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });
});

describe("runGitClone", () => {
  afterEach(() => {
    vi.mocked(spawn).mockReset();
  });

  it("passes its argv through unchanged and resolves to undefined", async () => {
    const child = nextChild();
    const args = ["-c", "core.longpaths=true", "clone", "--", "https://github.com/o/r.git", "/tmp/x"];
    const pending = runGitClone(args);
    child.stdout.emit("data", Buffer.from("ignored"));
    child.emit("close", 0);
    await expect(pending).resolves.toBeUndefined();
    expect(spawn).toHaveBeenCalledWith("git", args, expect.anything());
  });

  it("flags auth-like clone failures with the token scrubbed", async () => {
    const child = nextChild();
    const pending = runGitClone(["clone", "--", "https://github.com/o/r.git", "/tmp/x"], TOKEN);
    child.stderr.emit("data", Buffer.from(`Authentication failed for repo (used ${TOKEN})`));
    child.emit("close", 128);
    const message = await rejectionMessage(pending);
    expect(message).toContain("authentication failed");
    expect(message).not.toContain(TOKEN);
  });
});

/** Queue one fake child for the next spawn call; the test drives its streams and exit. */
function nextChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
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
