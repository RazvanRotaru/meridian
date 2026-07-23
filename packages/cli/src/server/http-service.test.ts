import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { createHttpService, type HttpService } from "./http-service";

describe("createHttpService", () => {
  it("cancels a pending direct bind before close resolves", async () => {
    const service = createHttpService({
      handle: (_request, response) => { response.end("ok"); },
      handleError: (response) => response.destroy(),
      rejectRequest: (response) => response.writeHead(503).end(),
    });

    service.server.listen(0, "127.0.0.1");
    await service.close();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(service.server.listening).toBe(false);
  });

  it("publishes one promise before synchronous cancellation and reentrant resource shutdown", async () => {
    let service!: HttpService;
    let reentered: Promise<void> | undefined;
    const events: string[] = [];
    service = createHttpService({
      handle: (_request, response) => { response.end(); },
      handleError: (response) => response.destroy(),
      rejectRequest: (response) => response.writeHead(503).end(),
      beginShutdown: [
        () => {
          events.push(`signal:${service.signal.aborted}`);
          reentered = service.close();
        },
        () => { events.push("second"); },
      ],
    });

    const first = service.close();

    expect(service.signal.aborted).toBe(true);
    expect(reentered).toBe(first);
    expect(service.close()).toBe(first);
    expect(events).toEqual(["signal:true", "second"]);
    await first;
  });

  it("keeps close pending until an accepted handler and its response have drained", async () => {
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let release!: () => void;
    const work = new Promise<void>((resolve) => { release = resolve; });
    const service = createHttpService({
      async handle(_request, response) {
        markStarted();
        await work;
        response.end("done");
      },
      handleError: (response) => response.destroy(),
      rejectRequest: (response) => response.writeHead(503).end(),
    });
    const base = await listen(service);
    const response = fetch(base);
    await started;

    const close = service.close();
    let settled = false;
    void close.finally(() => { settled = true; });
    await Promise.resolve();

    expect(service.signal.aborted).toBe(true);
    expect(settled).toBe(false);
    expect(service.close()).toBe(close);

    release();
    expect(await (await response).text()).toBe("done");
    await close;
  });

  it("awaits every shutdown task, always finalizes once, and aggregates failures", async () => {
    const first = new Error("first close failure");
    const second = new Error("final disposal failure");
    const finish = vi.fn(() => { throw second; });
    const waited = vi.fn();
    const service = createHttpService({
      handle: (_request, response) => { response.end(); },
      handleError: (response) => response.destroy(),
      rejectRequest: (response) => response.writeHead(503).end(),
      beginShutdown: [
        () => Promise.reject(first),
        async () => { await Promise.resolve(); waited(); },
      ],
      finishShutdown: finish,
    });

    const close = service.close();
    await expect(close).rejects.toMatchObject({
      name: "AggregateError",
      errors: [first, second],
    });
    expect(waited).toHaveBeenCalledOnce();
    expect(finish).toHaveBeenCalledOnce();
    expect(service.close()).toBe(close);
  });

  it("destroys the response when an error responder throws and still drains accounting", async () => {
    const service = createHttpService({
      handle: () => { throw new Error("route failure"); },
      handleError: () => { throw new Error("responder failure"); },
      rejectRequest: (response) => response.writeHead(503).end(),
    });
    const base = await listen(service);

    await expect(fetch(base)).rejects.toThrow();
    await expect(service.close()).resolves.toBeUndefined();
  });
});

function listen(service: HttpService): Promise<string> {
  return new Promise((resolve, reject) => {
    service.server.once("error", reject);
    service.server.listen(0, "127.0.0.1", () => {
      service.server.removeListener("error", reject);
      const port = (service.server.address() as AddressInfo).port;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}
