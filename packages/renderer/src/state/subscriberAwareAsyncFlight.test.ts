import { describe, expect, it, vi } from "vitest";
import { SubscriberAwareAsyncFlight } from "./subscriberAwareAsyncFlight";

interface Deferred<Value> {
  promise: Promise<Value>;
  resolve: (value: Value) => void;
}

function deferred<Value>(): Deferred<Value> {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("SubscriberAwareAsyncFlight", () => {
  it("shares one physical operation and removes only the cancelled owner", async () => {
    const gate = deferred<string>();
    const execute = vi.fn(async () => gate.promise);
    const flight = new SubscriberAwareAsyncFlight<string, string>(execute);
    const firstController = new AbortController();
    const secondController = new AbortController();

    const first = flight.subscribe({ owner: "module", signal: firstController.signal });
    const second = flight.subscribe({ owner: "flow-pane", signal: secondController.signal });
    expect(execute).toHaveBeenCalledOnce();
    expect(flight.owners).toEqual(new Set(["module", "flow-pane"]));

    firstController.abort();
    await expect(first).resolves.toEqual({ status: "cancelled" });
    expect(flight.signal.aborted).toBe(false);
    expect(flight.owners).toEqual(new Set(["flow-pane"]));

    gate.resolve("projection");
    await expect(second).resolves.toEqual({ status: "completed", value: "projection" });
    expect(flight.subscriberCount).toBe(0);
  });

  it("aborts physical work only when the final subscriber leaves", async () => {
    const gate = deferred<string>();
    const flight = new SubscriberAwareAsyncFlight<string, string>(async () => {
      return gate.promise; // deliberately ignore abort so cancellation must still settle the caller.
    });
    const controller = new AbortController();
    const subscription = flight.subscribe({ owner: "logic", signal: controller.signal });

    controller.abort();
    await expect(subscription).resolves.toEqual({ status: "cancelled" });
    expect(flight.signal.aborted).toBe(true);
    expect(flight.subscriberCount).toBe(0);

    gate.resolve("drained");
    await gate.promise;
  });

  it("explicit abort cancels every subscriber and rejects later ownership", async () => {
    const gate = deferred<string>();
    const flight = new SubscriberAwareAsyncFlight<string, string>(async () => gate.promise);
    const first = flight.subscribe({ owner: "module" });
    const second = flight.subscribe({ owner: "flow-pane" });

    flight.abort(new DOMException("navigation", "AbortError"));
    await expect(first).resolves.toEqual({ status: "cancelled" });
    await expect(second).resolves.toEqual({ status: "cancelled" });
    await expect(flight.subscribe({ owner: "logic" })).resolves.toEqual({ status: "cancelled" });
    expect(flight.subscriberCount).toBe(0);

    gate.resolve("drained");
    await gate.promise;
  });
});
