import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionStore } from "./session";
import { probeRemoteGraph } from "./web-cache-probe";
import { handleCacheStatus } from "./web-cache-status";

vi.mock("./web-cache-probe", () => ({ probeRemoteGraph: vi.fn() }));
vi.mock("./web-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./web-auth")>();
  return { ...actual, githubTokenFor: vi.fn(() => undefined) };
});

describe("cache-status analysis identity", () => {
  beforeEach(() => {
    vi.mocked(probeRemoteGraph).mockResolvedValue({ status: "miss" });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("forwards repository, ref, and subdirectory while ignoring the retired language selector", async () => {
    await handleCacheStatus(
      {
        cacheRoot: "/cache",
        cwd: "/workspace",
        refreshCache: false,
        sessions: new SessionStore(),
        github: {} as never,
      },
      request(),
      response(),
      new URLSearchParams({
        repo: " octo/repo ",
        ref: " main ",
        subdir: " packages/app ",
        lang: " typescript ",
      }),
    );

    expect(probeRemoteGraph).toHaveBeenCalledWith({
      cacheRoot: "/cache",
      cwd: "/workspace",
      request: {
        kind: "github",
        value: "octo/repo",
        ref: "main",
        subdir: "packages/app",
        refresh: false,
      },
      token: undefined,
    });
  });
});

function request(): IncomingMessage {
  return Object.assign(Readable.from([]), { headers: {} }) as unknown as IncomingMessage;
}

function response(): ServerResponse {
  return {
    writeHead: vi.fn(),
    end: vi.fn(),
  } as unknown as ServerResponse;
}
