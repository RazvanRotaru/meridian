import { EventEmitter } from "node:events";
import type { Server } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { listenWithRetry } from "./listen";

describe("listenWithRetry cancellation", () => {
  it("waits for a pending bind and closes a listener that appears after abort", async () => {
    const server = new DeferredServer();
    const controller = new AbortController();
    const pending = listenWithRetry(server as unknown as Server, "127.0.0.1", 4_183, controller.signal);

    controller.abort();
    let settled = false;
    void pending.finally(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(server.close).not.toHaveBeenCalled();

    server.finishBind();

    await expect(pending).resolves.toBeNull();
    expect(server.close).toHaveBeenCalledTimes(1);
    expect(server.closeIdleConnections).toHaveBeenCalledTimes(1);
    expect(server.listening).toBe(false);
  });

  it("does not begin a bind when already aborted", async () => {
    const server = new DeferredServer();
    const controller = new AbortController();
    controller.abort();

    await expect(listenWithRetry(
      server as unknown as Server,
      "127.0.0.1",
      4_183,
      controller.signal,
    )).resolves.toBeNull();
    expect(server.listen).not.toHaveBeenCalled();
  });
});

class DeferredServer extends EventEmitter {
  listening = false;
  readonly closeIdleConnections = vi.fn();
  readonly listen = vi.fn((_port: number, _host: string) => this);
  readonly close = vi.fn((callback?: (error?: Error) => void) => {
    this.listening = false;
    queueMicrotask(() => callback?.());
    return this;
  });

  finishBind(): void {
    this.listening = true;
    this.emit("listening");
  }
}
