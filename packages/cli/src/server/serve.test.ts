import { EventEmitter, once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { Reporter } from "../reporter";
import { createHttpService } from "./http-service";
import { serve, type ShutdownSignalSource } from "./serve";

describe("serve owned shutdown", () => {
  it("returns cleanly when the owned service was already closed", async () => {
    const service = testService();
    const signals = new EventEmitter();
    await service.close();

    await serve(
      service,
      {
        host: "127.0.0.1",
        startPort: 0,
        openBrowser: false,
        signalSource: signals as ShutdownSignalSource,
      },
      new Reporter({ quiet: true }),
    );

    expect(service.server.listening).toBe(false);
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
  });

  it.each(["SIGINT", "SIGTERM"] as const)("awaits %s cleanup and removes both signal listeners", async (signal) => {
    const service = testService();
    const server = service.server;
    const close = vi.spyOn(service, "close");
    const signals = new EventEmitter();
    const serving = serve(
      service,
      {
        host: "127.0.0.1",
        startPort: 0,
        openBrowser: false,
        signalSource: signals as ShutdownSignalSource,
      },
      new Reporter({ quiet: true }),
    );
    await once(server, "listening");

    signals.emit(signal);
    await serving;

    expect(close).toHaveBeenCalledTimes(1);
    expect(server.listening).toBe(false);
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
  });

  it("observes a signal emitted by an earlier listening listener", async () => {
    const service = testService();
    const signals = new EventEmitter();
    service.server.once("listening", () => signals.emit("SIGTERM"));

    await serve(
      service,
      {
        host: "127.0.0.1",
        startPort: 0,
        openBrowser: false,
        signalSource: signals as ShutdownSignalSource,
      },
      new Reporter({ quiet: true }),
    );

    expect(service.signal.aborted).toBe(true);
    expect(service.server.listening).toBe(false);
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
  });

  it("cancels a pending bind when the signal arrives before listening", async () => {
    const service = testService();
    const signals = new EventEmitter();
    const serving = serve(
      service,
      {
        host: "127.0.0.1",
        startPort: 0,
        openBrowser: false,
        signalSource: signals as ShutdownSignalSource,
      },
      new Reporter({ quiet: true }),
    );

    signals.emit("SIGTERM");
    await serving;

    expect(service.signal.aborted).toBe(true);
    expect(service.server.listening).toBe(false);
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
  });

  it("observes an ordinary close started by an earlier listening listener", async () => {
    const service = testService();
    const signals = new EventEmitter();
    const close = vi.spyOn(service, "close");
    service.server.once("listening", () => void service.close());

    await serve(
      service,
      {
        host: "127.0.0.1",
        startPort: 0,
        openBrowser: false,
        signalSource: signals as ShutdownSignalSource,
      },
      new Reporter({ quiet: true }),
    );

    expect(close).toHaveBeenCalledTimes(2);
    expect(close.mock.results[0]?.value).toBe(close.mock.results[1]?.value);
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
  });

  it("stays pending until owned cleanup finishes and ignores a second signal", async () => {
    let release!: () => void;
    const cleanup = new Promise<void>((resolve) => { release = resolve; });
    const service = testService([() => cleanup]);
    const signals = new EventEmitter();
    const close = vi.spyOn(service, "close");
    const serving = serve(
      service,
      {
        host: "127.0.0.1",
        startPort: 0,
        openBrowser: false,
        signalSource: signals as ShutdownSignalSource,
      },
      new Reporter({ quiet: true }),
    );
    await once(service.server, "listening");

    signals.emit("SIGINT");
    signals.emit("SIGTERM");
    await expect(Promise.race([serving.then(() => "closed"), Promise.resolve("pending")]))
      .resolves.toBe("pending");
    expect(close).toHaveBeenCalledTimes(1);
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(signals.listenerCount("SIGTERM")).toBe(0);

    release();
    await serving;
  });

  it("awaits cleanup on bind failure, preserves the bind error, and removes listeners", async () => {
    let markCleanupStarted!: () => void;
    const cleanupStarted = new Promise<void>((resolve) => { markCleanupStarted = resolve; });
    let release!: () => void;
    const cleanup = new Promise<void>((_resolve, reject) => {
      release = () => reject(new Error("secondary cleanup failure"));
    });
    const service = testService([() => { markCleanupStarted(); return cleanup; }]);
    const signals = new EventEmitter();
    const serving = serve(
      service,
      {
        host: "127.0.0.999",
        startPort: 0,
        openBrowser: false,
        signalSource: signals as ShutdownSignalSource,
      },
      new Reporter({ quiet: true }),
    );

    await cleanupStarted;
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
    release();
    await expect(serving).rejects.toThrow(/cannot bind/i);
  });
});

function testService(beginShutdown: readonly (() => void | Promise<void>)[] = []) {
  return createHttpService({
    handle: (_request, response) => { response.end("ok"); },
    handleError: (response) => response.destroy(),
    rejectRequest: (response) => response.writeHead(503).end(),
    beginShutdown,
  });
}
