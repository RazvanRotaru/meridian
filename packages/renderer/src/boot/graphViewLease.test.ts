import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_PROTECTED_GRAPH_IDS,
  startGraphViewLease,
  type GraphViewLeaseGrant,
  type PreparedReviewHandoffGrant,
} from "./graphViewLease";

const GRANT: GraphViewLeaseGrant = {
  version: 1,
  leaseId: "view-lease-1",
  url: "/api/graph-view-leases/view-lease-1",
  createUrl: "/api/graph-views",
  expiresAtMs: 50_000,
  heartbeatIntervalMs: 1_000,
};

const BROWSER_ORIGIN = "http://127.0.0.1:4173";

const PREPARED_REVIEW_GRANT: PreparedReviewHandoffGrant = {
  version: 1,
  claimId: "a".repeat(32),
  url: `/api/pr-review-handoffs/${"a".repeat(32)}`,
  expiresAtMs: 45_000,
  headGraphId: "prepared-head",
  comparisonGraphId: "prepared-comparison",
};

describe("graph view lease", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("atomically protects a handoff, then replaces it with the mounted graph set", async () => {
    const browser = stubBrowser();
    const fetchMock = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal("fetch", fetchMock);
    const lease = startGraphViewLease(GRANT, "base");

    // The grant already protects the boot graph, so construction does not need a redundant PUT.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(lease.leaseId).toBe("view-lease-1");

    const first = await lease.beginPreparedGraphHandoff(["head", "comparison", "head"]);
    expectPut(fetchMock, 0, ["base", "head", "comparison"]);

    // Publishing candidate ids into renderer state is not a transaction commit: the old mounted
    // pair remains protected until review derivation succeeds and explicitly commits.
    await lease.replacePreparedGraphIds(["head", "comparison"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Committing the already-protected pair is deduplicated rather than generating lease traffic.
    await first.commit();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await lease.replacePreparedGraphIds(["comparison", "head"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const next = await lease.beginPreparedGraphHandoff(["head-next", "comparison-next", "head-next"]);
    expectPut(fetchMock, 1, ["base", "comparison", "head", "head-next", "comparison-next"]);
    await next.commit();
    expectPut(fetchMock, 2, ["base", "head-next", "comparison-next"]);

    lease.dispose();
    expectDelete(fetchMock, 3);
    expect(browser.listenerCount()).toBe(0);
  });

  it("renews the server-issued initial graph pair on the first heartbeat", async () => {
    stubBrowser();
    const fetchMock = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal("fetch", fetchMock);
    const lease = startGraphViewLease({
      ...GRANT,
      graphIds: ["base", "prepared-head", "prepared-comparison"],
    }, "base");

    expect(fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(GRANT.heartbeatIntervalMs);
    expectPut(fetchMock, 0, ["base", "prepared-head", "prepared-comparison"]);
    lease.dispose();
  });

  it("attaches a prepared-review claim after protecting its union and commits it in order", async () => {
    stubBrowser();
    const fetchMock = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal("fetch", fetchMock);
    const lease = startGraphViewLease(GRANT, "base");

    await lease.replacePreparedGraphIds(["mounted-head", "mounted-comparison"]);
    const handoff = await lease.beginPreparedReviewHandoff(PREPARED_REVIEW_GRANT);

    expectPut(fetchMock, 1, [
      "base",
      "mounted-head",
      "mounted-comparison",
      "prepared-head",
      "prepared-comparison",
    ]);
    expectPreparedReviewAttach(fetchMock, 2, PREPARED_REVIEW_GRANT);

    await handoff.commit();
    expectPut(fetchMock, 3, ["base", "prepared-head", "prepared-comparison"]);
    expectPreparedReviewCommit(fetchMock, 4, PREPARED_REVIEW_GRANT);
    await handoff.commit();
    expect(fetchMock).toHaveBeenCalledTimes(5);
    lease.dispose();
  });

  it("restores the prior mounted set before releasing a prepared-review claim", async () => {
    stubBrowser();
    const fetchMock = vi.fn().mockImplementation((_url: string, init?: RequestInit) => (
      init?.method === "DELETE" ? noContentResponse() : Promise.resolve(okResponse())
    ));
    vi.stubGlobal("fetch", fetchMock);
    const lease = startGraphViewLease(GRANT, "base");

    await lease.replacePreparedGraphIds(["mounted-head", "mounted-comparison"]);
    const handoff = await lease.beginPreparedReviewHandoff(PREPARED_REVIEW_GRANT);
    await handoff.release();

    expectPut(fetchMock, 3, ["base", "mounted-head", "mounted-comparison"]);
    expectPreparedReviewRelease(fetchMock, 4, PREPARED_REVIEW_GRANT);
    await handoff.release();
    expect(fetchMock).toHaveBeenCalledTimes(5);
    lease.dispose();
  });

  it("keeps identical-pair claims independent across browser view controllers", async () => {
    stubBrowser();
    const otherLeaseGrant: GraphViewLeaseGrant = {
      ...GRANT,
      leaseId: "view-lease-2",
      url: "/api/graph-view-leases/view-lease-2",
    };
    const otherClaim: PreparedReviewHandoffGrant = {
      ...PREPARED_REVIEW_GRANT,
      claimId: "b".repeat(32),
      url: `/api/pr-review-handoffs/${"b".repeat(32)}`,
    };
    const fetchMock = vi.fn().mockImplementation((_url: string, init?: RequestInit) => (
      init?.method === "DELETE" ? noContentResponse() : Promise.resolve(okResponse())
    ));
    vi.stubGlobal("fetch", fetchMock);
    const firstLease = startGraphViewLease(GRANT, "base");
    const secondLease = startGraphViewLease(otherLeaseGrant, "base");

    const [first, second] = await Promise.all([
      firstLease.beginPreparedReviewHandoff(PREPARED_REVIEW_GRANT),
      secondLease.beginPreparedReviewHandoff(otherClaim),
    ]);
    expect(fetchMock.mock.calls.filter(
      ([url]) => url === absoluteEndpoint(PREPARED_REVIEW_GRANT.url),
    )).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(
      ([url]) => url === absoluteEndpoint(otherClaim.url),
    )).toHaveLength(1);

    await first.release();
    expect(fetchMock.mock.calls.filter(
      ([url]) => url === absoluteEndpoint(PREPARED_REVIEW_GRANT.url),
    )).toHaveLength(2);
    expect(fetchMock.mock.calls.filter(
      ([url]) => url === absoluteEndpoint(otherClaim.url),
    )).toHaveLength(1);
    await second.commit();
    expect(fetchMock.mock.calls.filter(
      ([url]) => url === absoluteEndpoint(otherClaim.url),
    )).toHaveLength(2);
    firstLease.dispose();
    secondLease.dispose();
  });

  it("retains a prepared-review commit transaction after network failure and retries safely", async () => {
    stubBrowser();
    const commitFailure = new TypeError("network unavailable");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(okResponse())
      .mockResolvedValueOnce(okResponse())
      .mockResolvedValueOnce(okResponse())
      .mockResolvedValueOnce(okResponse())
      .mockRejectedValueOnce(commitFailure)
      .mockResolvedValueOnce(okResponse())
      .mockResolvedValueOnce(okResponse())
      .mockResolvedValueOnce(okResponse());
    vi.stubGlobal("fetch", fetchMock);
    const lease = startGraphViewLease(GRANT, "base");

    await lease.replacePreparedGraphIds(["mounted-head", "mounted-comparison"]);
    const handoff = await lease.beginPreparedReviewHandoff(PREPARED_REVIEW_GRANT);
    await expect(handoff.commit()).rejects.toThrow(
      "Unable to transfer prepared review protection.",
    );
    // The failed claim commit restores the full old + candidate union before returning the error.
    expectPut(fetchMock, 5, [
      "base",
      "mounted-head",
      "mounted-comparison",
      "prepared-head",
      "prepared-comparison",
    ]);

    await handoff.commit();
    expectPut(fetchMock, 6, ["base", "prepared-head", "prepared-comparison"]);
    expectPreparedReviewCommit(fetchMock, 7, PREPARED_REVIEW_GRANT);
    await handoff.commit();
    expect(fetchMock).toHaveBeenCalledTimes(8);
    lease.dispose();
  });

  it("rolls back a failed claim attachment and permits a clean retry", async () => {
    stubBrowser();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(okResponse())
      .mockRejectedValueOnce(new TypeError("network unavailable"))
      .mockResolvedValueOnce(okResponse())
      .mockResolvedValueOnce(okResponse())
      .mockResolvedValueOnce(okResponse())
      .mockResolvedValueOnce(okResponse())
      .mockResolvedValueOnce(noContentResponse());
    vi.stubGlobal("fetch", fetchMock);
    const lease = startGraphViewLease(GRANT, "base");

    await expect(lease.beginPreparedReviewHandoff(PREPARED_REVIEW_GRANT))
      .rejects.toThrow("Unable to transfer prepared review protection.");
    const handoff = await lease.beginPreparedReviewHandoff(PREPARED_REVIEW_GRANT);

    // A begin failure cannot return a release handle, so it restores the base set before retry.
    expectPut(fetchMock, 0, ["base", "prepared-head", "prepared-comparison"]);
    expectPreparedReviewAttach(fetchMock, 1, PREPARED_REVIEW_GRANT);
    expectPut(fetchMock, 2, ["base"]);
    expectPut(fetchMock, 3, ["base", "prepared-head", "prepared-comparison"]);
    expectPreparedReviewAttach(fetchMock, 4, PREPARED_REVIEW_GRANT);
    await handoff.release();
    expectPut(fetchMock, 5, ["base"]);
    expectPreparedReviewRelease(fetchMock, 6, PREPARED_REVIEW_GRANT);
    lease.dispose();
  });

  it("does not attach or settle a stale prepared-review generation", async () => {
    stubBrowser();
    const firstPut = deferred<Response>();
    const nextClaim: PreparedReviewHandoffGrant = {
      ...PREPARED_REVIEW_GRANT,
      claimId: "c".repeat(32),
      url: `/api/pr-review-handoffs/${"c".repeat(32)}`,
      headGraphId: "next-head",
      comparisonGraphId: "next-comparison",
    };
    const fetchMock = vi.fn()
      .mockReturnValueOnce(firstPut.promise)
      .mockResolvedValue(okResponse());
    vi.stubGlobal("fetch", fetchMock);
    const lease = startGraphViewLease(GRANT, "base");

    const stalePromise = lease.beginPreparedReviewHandoff(PREPARED_REVIEW_GRANT);
    const currentPromise = lease.beginPreparedReviewHandoff(nextClaim);
    firstPut.resolve(okResponse());
    const [stale, current] = await Promise.all([stalePromise, currentPromise]);

    expect(fetchMock.mock.calls.some(
      ([url]) => url === absoluteEndpoint(PREPARED_REVIEW_GRANT.url),
    )).toBe(false);
    expectPreparedReviewAttach(fetchMock, 2, nextClaim);
    await stale.commit();
    await stale.release();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await current.commit();
    expectPreparedReviewCommit(fetchMock, 3, nextClaim);
    lease.dispose();
  });

  it("serializes heartbeat renewal behind an in-flight prepared-review attach", async () => {
    stubBrowser();
    const attachResponse = deferred<Response>();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(okResponse())
      .mockReturnValueOnce(attachResponse.promise)
      .mockResolvedValue(okResponse());
    vi.stubGlobal("fetch", fetchMock);
    const lease = startGraphViewLease(GRANT, "base");

    const handoff = lease.beginPreparedReviewHandoff(PREPARED_REVIEW_GRANT);
    await flushMicrotasks();
    expectPreparedReviewAttach(fetchMock, 1, PREPARED_REVIEW_GRANT);
    await vi.advanceTimersByTimeAsync(GRANT.heartbeatIntervalMs);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    attachResponse.resolve(okResponse());
    await handoff;
    await flushMicrotasks();
    expectPut(fetchMock, 2, ["base", "prepared-head", "prepared-comparison"]);
    lease.dispose();
  });

  it("serializes concurrent changes and lets the newest complete set win", async () => {
    stubBrowser();
    const firstResponse = deferred<Response>();
    const fetchMock = vi.fn()
      .mockReturnValueOnce(firstResponse.promise)
      .mockResolvedValue(okResponse());
    vi.stubGlobal("fetch", fetchMock);
    const lease = startGraphViewLease(GRANT, "base");

    const protecting = lease.beginPreparedGraphHandoff(["head-old", "comparison-old"]);
    expectPut(fetchMock, 0, ["base", "head-old", "comparison-old"]);

    const replacing = lease.beginPreparedGraphHandoff(["head-new", "comparison-new"]);
    // A second request is not allowed to race the first and arrive at the server out of order.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    firstResponse.resolve(okResponse());
    const [, newest] = await Promise.all([protecting, replacing]);
    expectPut(fetchMock, 1, ["base", "head-new", "comparison-new"]);
    await newest.commit();
    lease.dispose();
  });

  it("replaces a stale pending handoff while retaining only the mounted pair", async () => {
    stubBrowser();
    const fetchMock = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal("fetch", fetchMock);
    const lease = startGraphViewLease(GRANT, "base");

    await lease.replacePreparedGraphIds(["mounted-head", "mounted-base"]);
    await lease.beginPreparedGraphHandoff(["stale-head", "stale-base"]);
    const next = await lease.beginPreparedGraphHandoff(["next-head", "next-base"]);

    expectPut(fetchMock, 2, ["base", "mounted-head", "mounted-base", "next-head", "next-base"]);
    await lease.replacePreparedGraphIds(["next-head", "next-base"]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await next.release();
    expectPut(fetchMock, 3, ["base", "mounted-head", "mounted-base"]);
    lease.dispose();
  });

  it("skips a failed superseded request and still commits the latest complete set", async () => {
    stubBrowser();
    const firstResponse = deferred<Response>();
    const fetchMock = vi.fn()
      .mockReturnValueOnce(firstResponse.promise)
      .mockResolvedValue(okResponse());
    vi.stubGlobal("fetch", fetchMock);
    const lease = startGraphViewLease(GRANT, "base");

    const stale = lease.beginPreparedGraphHandoff(["stale"]);
    const latest = lease.beginPreparedGraphHandoff(["latest"]);
    firstResponse.resolve({ ok: false, status: 503 } as Response);

    const [, newest] = await Promise.all([stale, latest]);
    expectPut(fetchMock, 1, ["base", "latest"]);
    await newest.commit();
    lease.dispose();
  });

  it("reports a safe error for a failed current PUT and permits a clean retry", async () => {
    stubBrowser();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json(
        { error: "secret /workspace/repository path", code: "capacity" },
        { status: 500, statusText: "secret /workspace/repository path" },
      ))
      .mockResolvedValue(okResponse());
    vi.stubGlobal("fetch", fetchMock);
    const lease = startGraphViewLease(GRANT, "base");

    const failure = await lease.beginPreparedGraphHandoff(["head"]).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("Unable to renew graph view protection. (HTTP 500)");
    expect((failure as Error).message).not.toContain("workspace");
    await expect(lease.beginPreparedGraphHandoff(["head"])).resolves.toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    lease.dispose();
  });

  it("keeps a failed commit releasable without dropping the old mounted pair", async () => {
    stubBrowser();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(okResponse())
      .mockResolvedValueOnce(okResponse())
      .mockResolvedValueOnce(Response.json({ code: "capacity" }, { status: 503 }))
      .mockResolvedValue(okResponse());
    vi.stubGlobal("fetch", fetchMock);
    const lease = startGraphViewLease(GRANT, "base");

    await lease.replacePreparedGraphIds(["mounted-head", "mounted-comparison"]);
    const handoff = await lease.beginPreparedGraphHandoff(["next-head", "next-comparison"]);
    await expect(handoff.commit()).rejects.toThrow(
      "Unable to renew graph view protection. (HTTP 503)",
    );
    expectPut(fetchMock, 2, ["base", "next-head", "next-comparison"]);

    // A failed commit restores the transaction's union. The caller can still roll it back, and
    // rollback converges to the previously mounted pair rather than accepting the failed commit.
    await handoff.release();
    expectPut(fetchMock, 3, ["base", "mounted-head", "mounted-comparison"]);
    await handoff.release();
    expect(fetchMock).toHaveBeenCalledTimes(4);
    lease.dispose();
  });

  it("retries candidate removal after a failed release without renewing the candidate", async () => {
    stubBrowser();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(okResponse())
      .mockResolvedValueOnce(okResponse())
      .mockResolvedValueOnce(Response.json({ code: "capacity" }, { status: 503 }))
      .mockResolvedValue(okResponse());
    vi.stubGlobal("fetch", fetchMock);
    const lease = startGraphViewLease(GRANT, "base");

    await lease.replacePreparedGraphIds(["mounted-head", "mounted-comparison"]);
    const handoff = await lease.beginPreparedGraphHandoff(["next-head", "next-comparison"]);
    await expect(handoff.release()).rejects.toThrow(
      "Unable to renew graph view protection. (HTTP 503)",
    );

    // Release is logically final even when its PUT fails. Repeating it is idempotent, while the
    // heartbeat retries the smaller base + mounted set and never renews the discarded candidate.
    await handoff.release();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(GRANT.heartbeatIntervalMs);
    expectPut(fetchMock, 3, ["base", "mounted-head", "mounted-comparison"]);
    lease.dispose();
  });

  it("rejects malformed successful PUT bodies and retries the desired set", async () => {
    stubBrowser();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("{", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(Response.json({ version: 1 }, { status: 200 }))
      .mockResolvedValue(okResponse());
    vi.stubGlobal("fetch", fetchMock);
    const lease = startGraphViewLease(GRANT, "base");

    await expect(lease.beginPreparedGraphHandoff(["head"]))
      .rejects.toThrow("Unable to renew graph view protection.");
    await expect(lease.beginPreparedGraphHandoff(["head"]))
      .rejects.toThrow("Unable to renew graph view protection.");
    await expect(lease.beginPreparedGraphHandoff(["head"]))
      .resolves.toBeDefined();
    expectPut(fetchMock, 0, ["base", "head"]);
    expectPut(fetchMock, 1, ["base", "head"]);
    expectPut(fetchMock, 2, ["base", "head"]);
    lease.dispose();
  });

  it("bounds and validates the compact protected id set without mutating it on rejection", async () => {
    stubBrowser();
    const fetchMock = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal("fetch", fetchMock);
    const lease = startGraphViewLease(GRANT, "base");
    const prepared = Array.from(
      { length: MAX_PROTECTED_GRAPH_IDS - 1 },
      (_, index) => `prepared-${index}`,
    );

    await lease.replacePreparedGraphIds(prepared);
    await expect(lease.beginPreparedGraphHandoff(["one-too-many"]))
      .rejects.toThrow(`at most ${MAX_PROTECTED_GRAPH_IDS}`);
    await expect(lease.beginPreparedGraphHandoff([" invalid "]))
      .rejects.toThrow("Invalid graph registration id.");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await lease.replacePreparedGraphIds(["mounted"]);
    expectPut(fetchMock, 1, ["base", "mounted"]);
    lease.dispose();
  });

  it("renews the current set on heartbeat, visible transition, and pageshow", async () => {
    const browser = stubBrowser();
    const fetchMock = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal("fetch", fetchMock);
    const lease = startGraphViewLease(GRANT, "base");
    await lease.replacePreparedGraphIds(["head", "comparison"]);

    await vi.advanceTimersByTimeAsync(GRANT.heartbeatIntervalMs);
    expectPut(fetchMock, 1, ["base", "head", "comparison"]);

    browser.setVisibility("hidden");
    await flushMicrotasks();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    browser.setVisibility("visible");
    await flushMicrotasks();
    expectPut(fetchMock, 2, ["base", "head", "comparison"]);

    browser.dispatchWindow("pageshow", { persisted: true });
    await flushMicrotasks();
    expectPut(fetchMock, 3, ["base", "head", "comparison"]);
    lease.dispose();
  });

  it("reacquires an expired lease after BFCache or suspension and releases the new token", async () => {
    const browser = stubBrowser();
    const recreatedUrl = `/api/graph-views/${"b".repeat(32)}`;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(okResponse())
      .mockResolvedValueOnce(Response.json(
        { error: "the graph view lease has expired", code: "unknown_lease" },
        { status: 410 },
      ))
      .mockResolvedValueOnce(Response.json({
        version: 1,
        leaseId: "b".repeat(32),
        url: recreatedUrl,
        expiresAtMs: 60_000,
        heartbeatIntervalMs: 1_000,
      }, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const lease = startGraphViewLease(GRANT, "base");
    await lease.replacePreparedGraphIds(["head", "comparison"]);

    browser.dispatchWindow("pageshow", { persisted: true });
    await flushMicrotasks();

    expectPut(fetchMock, 1, ["base", "head", "comparison"]);
    expectCreate(fetchMock, 2, ["base", "head", "comparison"]);
    expect(lease.leaseId).toBe("b".repeat(32));
    lease.dispose();
    expectDelete(fetchMock, 3, recreatedUrl);
  });

  it("rejects a malformed recreated grant and retries recreation on the next heartbeat", async () => {
    stubBrowser();
    const recreatedUrl = `/api/graph-views/${"c".repeat(32)}`;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(unknownLeaseResponse())
      .mockResolvedValueOnce(Response.json({
        version: 1,
        leaseId: "c".repeat(32),
        url: recreatedUrl,
        expiresAtMs: 60_000,
        // Missing heartbeatIntervalMs makes this a malformed successful response.
      }, { status: 201 }))
      .mockResolvedValueOnce(unknownLeaseResponse())
      .mockResolvedValueOnce(recreatedGrantResponse("c", recreatedUrl));
    vi.stubGlobal("fetch", fetchMock);
    const lease = startGraphViewLease(GRANT, "base");

    await expect(lease.replacePreparedGraphIds(["head"]))
      .rejects.toThrow("Unable to renew graph view protection.");
    expect(lease.leaseId).toBe(GRANT.leaseId);

    await vi.advanceTimersByTimeAsync(GRANT.heartbeatIntervalMs);
    expectPut(fetchMock, 2, ["base", "head"]);
    expectCreate(fetchMock, 3, ["base", "head"]);
    expect(lease.leaseId).toBe("c".repeat(32));
    lease.dispose();
    expectDelete(fetchMock, 4, recreatedUrl);
  });

  it("keeps the old token after recreation fails and retries the complete flow", async () => {
    stubBrowser();
    const recreatedUrl = `/api/graph-views/${"d".repeat(32)}`;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(unknownLeaseResponse())
      .mockResolvedValueOnce(Response.json({ code: "capacity" }, { status: 503 }))
      .mockResolvedValueOnce(unknownLeaseResponse())
      .mockResolvedValueOnce(recreatedGrantResponse("d", recreatedUrl));
    vi.stubGlobal("fetch", fetchMock);
    const lease = startGraphViewLease(GRANT, "base");

    await expect(lease.replacePreparedGraphIds(["head", "comparison"]))
      .rejects.toThrow("Unable to renew graph view protection. (HTTP 503)");
    expect(lease.leaseId).toBe(GRANT.leaseId);

    await vi.advanceTimersByTimeAsync(GRANT.heartbeatIntervalMs);
    expectPut(fetchMock, 2, ["base", "head", "comparison"]);
    expectCreate(fetchMock, 3, ["base", "head", "comparison"]);
    expect(lease.leaseId).toBe("d".repeat(32));
    lease.dispose();
    expectDelete(fetchMock, 4, recreatedUrl);
  });

  it("keeps a bfcache page, but releases and tears down on a final pagehide", async () => {
    const browser = stubBrowser();
    const fetchMock = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal("fetch", fetchMock);
    const lease = startGraphViewLease(GRANT, "base");

    browser.dispatchWindow("pagehide", { persisted: true });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(browser.listenerCount()).toBe(3);

    browser.dispatchWindow("pagehide", { persisted: false });
    expectDelete(fetchMock, 0);
    expect(browser.listenerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(GRANT.heartbeatIntervalMs * 2);
    browser.dispatchWindow("pageshow", { persisted: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Disposal is idempotent after pagehide already released the lease.
    lease.dispose();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(lease.beginPreparedGraphHandoff(["late"]))
      .rejects.toThrow("no longer active");
  });

  it("strictly validates prepared-review claims before changing the protected graph set", async () => {
    stubBrowser();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const lease = startGraphViewLease(GRANT, "base");

    await expect(lease.beginPreparedReviewHandoff({
      ...PREPARED_REVIEW_GRANT,
      claimId: "short",
    })).rejects.toThrow("Invalid prepared review handoff contract.");
    await expect(lease.beginPreparedReviewHandoff({
      ...PREPARED_REVIEW_GRANT,
      url: "https://evil.example/handoff",
    })).rejects.toThrow("same-origin");
    await expect(lease.beginPreparedReviewHandoff({
      ...PREPARED_REVIEW_GRANT,
      comparisonGraphId: PREPARED_REVIEW_GRANT.headGraphId,
    })).rejects.toThrow("Invalid prepared review handoff contract.");
    await expect(lease.beginPreparedReviewHandoff({
      ...PREPARED_REVIEW_GRANT,
      headGraphId: " invalid ",
    })).rejects.toThrow("Invalid graph registration id.");
    expect(fetchMock).not.toHaveBeenCalled();
    lease.dispose();
  });

  it("rejects cross-origin and malformed grants before installing lifecycle work", () => {
    const browser = stubBrowser();
    vi.stubGlobal("fetch", vi.fn());

    expect(() => startGraphViewLease({ ...GRANT, url: "https://evil.example/lease" }, "base"))
      .toThrow("same-origin");
    expect(() => startGraphViewLease({ ...GRANT, createUrl: "https://evil.example/views" }, "base"))
      .toThrow("same-origin");
    expect(() => startGraphViewLease({ ...GRANT, heartbeatIntervalMs: 0 }, "base"))
      .toThrow("Invalid graph view lease contract.");
    expect(() => startGraphViewLease(GRANT, ""))
      .toThrow("Invalid graph registration id.");
    expect(browser.listenerCount()).toBe(0);
  });
});

function stubBrowser() {
  const windowListeners = new Map<string, Set<(event: unknown) => void>>();
  const documentListeners = new Map<string, Set<(event: unknown) => void>>();
  let visibilityState: DocumentVisibilityState = "visible";

  const add = (target: Map<string, Set<(event: unknown) => void>>, type: string, listener: unknown) => {
    const listeners = target.get(type) ?? new Set();
    listeners.add(listener as (event: unknown) => void);
    target.set(type, listeners);
  };
  const remove = (target: Map<string, Set<(event: unknown) => void>>, type: string, listener: unknown) => {
    target.get(type)?.delete(listener as (event: unknown) => void);
  };
  const dispatch = (target: Map<string, Set<(event: unknown) => void>>, type: string, event: unknown) => {
    target.get(type)?.forEach((listener) => listener(event));
  };

  vi.stubGlobal("window", {
    location: {
      href: `${BROWSER_ORIGIN}/view?id=base`,
      origin: BROWSER_ORIGIN,
    },
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    addEventListener: (type: string, listener: unknown) => add(windowListeners, type, listener),
    removeEventListener: (type: string, listener: unknown) => remove(windowListeners, type, listener),
  });
  vi.stubGlobal("document", {
    get visibilityState() {
      return visibilityState;
    },
    addEventListener: (type: string, listener: unknown) => add(documentListeners, type, listener),
    removeEventListener: (type: string, listener: unknown) => remove(documentListeners, type, listener),
  });

  return {
    setVisibility(next: DocumentVisibilityState) {
      visibilityState = next;
      dispatch(documentListeners, "visibilitychange", {});
    },
    dispatchWindow(type: string, event: unknown) {
      dispatch(windowListeners, type, event);
    },
    listenerCount() {
      return [...windowListeners.values(), ...documentListeners.values()]
        .reduce((count, listeners) => count + listeners.size, 0);
    },
  };
}

function expectPut(fetchMock: ReturnType<typeof vi.fn>, call: number, graphIds: string[]): void {
  expectSafeRequestPolicy(fetchMock, call);
  expect(fetchMock).toHaveBeenNthCalledWith(
    call + 1,
    absoluteEndpoint(GRANT.url),
    expect.objectContaining({
      method: "PUT",
      body: JSON.stringify({ version: 1, graphIds }),
    }),
  );
}

function expectCreate(fetchMock: ReturnType<typeof vi.fn>, call: number, graphIds: string[]): void {
  expectSafeRequestPolicy(fetchMock, call);
  expect(fetchMock).toHaveBeenNthCalledWith(
    call + 1,
    absoluteEndpoint(GRANT.createUrl),
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ version: 1, baseGraphId: "base", graphIds }),
    }),
  );
}

function expectPreparedReviewAttach(
  fetchMock: ReturnType<typeof vi.fn>,
  call: number,
  grant: PreparedReviewHandoffGrant,
  viewLeaseId = GRANT.leaseId,
): void {
  expectSafeRequestPolicy(fetchMock, call);
  expect(fetchMock).toHaveBeenNthCalledWith(
    call + 1,
    absoluteEndpoint(grant.url),
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ version: 1, viewLeaseId }),
    }),
  );
}

function expectPreparedReviewCommit(
  fetchMock: ReturnType<typeof vi.fn>,
  call: number,
  grant: PreparedReviewHandoffGrant,
  viewLeaseId = GRANT.leaseId,
): void {
  expectSafeRequestPolicy(fetchMock, call);
  expect(fetchMock).toHaveBeenNthCalledWith(
    call + 1,
    absoluteEndpoint(grant.url),
    expect.objectContaining({
      method: "PUT",
      body: JSON.stringify({ version: 1, viewLeaseId, action: "commit" }),
    }),
  );
}

function expectPreparedReviewRelease(
  fetchMock: ReturnType<typeof vi.fn>,
  call: number,
  grant: PreparedReviewHandoffGrant,
): void {
  expectSafeRequestPolicy(fetchMock, call);
  expect(fetchMock).toHaveBeenNthCalledWith(
    call + 1,
    absoluteEndpoint(grant.url),
    expect.objectContaining({ method: "DELETE" }),
  );
}

function expectDelete(fetchMock: ReturnType<typeof vi.fn>, call: number, url = GRANT.url): void {
  expectSafeRequestPolicy(fetchMock, call);
  expect(fetchMock).toHaveBeenNthCalledWith(call + 1, absoluteEndpoint(url), {
    method: "DELETE",
    redirect: "error",
    credentials: "same-origin",
    cache: "no-store",
    keepalive: true,
  });
}

function expectSafeRequestPolicy(fetchMock: ReturnType<typeof vi.fn>, call: number): void {
  const init = fetchMock.mock.calls[call]?.[1];
  expect(init).toEqual(expect.objectContaining({
    redirect: "error",
    credentials: "same-origin",
    cache: "no-store",
  }));
  expect(init).not.toHaveProperty("mode");
}

function absoluteEndpoint(value: string): string {
  return new URL(value, BROWSER_ORIGIN).href;
}

function okResponse(): Response {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve({ version: 1, expiresAtMs: 50_000 }),
  } as Response;
}

function noContentResponse(): Response {
  return { ok: true, status: 204 } as Response;
}

function unknownLeaseResponse(): Response {
  return Response.json(
    { error: "the graph view lease has expired", code: "unknown_lease" },
    { status: 410 },
  );
}

function recreatedGrantResponse(token: string, url: string): Response {
  return Response.json({
    version: 1,
    leaseId: token.repeat(32),
    url,
    expiresAtMs: 60_000,
    heartbeatIntervalMs: 1_000,
  }, { status: 201 });
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function flushMicrotasks(): Promise<void> {
  // The controller drains fetch, response parsing, and its serialized update queue before the
  // next lifecycle renewal may start. Let fake timers exhaust that complete microtask chain.
  await vi.advanceTimersByTimeAsync(0);
}
