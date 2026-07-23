/**
 * Keep the small set of graph registrations used by this browser view protected on the server.
 *
 * The lease only carries opaque graph ids. Graph artifacts stay on the server and are fetched by
 * the existing graph endpoints; this controller never retains artifact data or graph metadata.
 */

export const MAX_PROTECTED_GRAPH_IDS = 5;

const MAX_GRAPH_ID_LENGTH = 256;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const UPDATE_ERROR_MESSAGE = "Unable to renew graph view protection.";
const INACTIVE_ERROR_MESSAGE = "Graph view protection is no longer active.";

export interface GraphViewLeaseGrant {
  version: 1;
  leaseId: string;
  url: string;
  createUrl: string;
  expiresAtMs: number;
  heartbeatIntervalMs: number;
}

export interface GraphViewLeaseHandoff {
  /** Commit the prepared pair only after the renderer has successfully installed its review. */
  commit(): Promise<void>;
  /** Drop this pending pair without disturbing a newer handoff or the mounted pair. */
  release(): Promise<void>;
}

export interface GraphViewLeaseController {
  readonly leaseId: string;
  /**
   * Protect a handoff before its graph artifacts are loaded. Existing prepared ids remain pinned
   * until the returned transaction is explicitly committed or released.
   */
  beginPreparedGraphHandoff(graphIds: readonly string[]): Promise<GraphViewLeaseHandoff>;
  /** Reflect a mounted-state change while always preserving the boot graph id. */
  replacePreparedGraphIds(graphIds: readonly string[]): Promise<void>;
  /** Stop renewal, remove browser listeners, and best-effort release the server lease. */
  dispose(): void;
}

/**
 * Start managing an already-issued server lease. The grant initially protects `baseGraphId`, so
 * the first network request is deferred until the desired set changes or renewal is due.
 */
export function startGraphViewLease(
  grant: GraphViewLeaseGrant,
  baseGraphId: string,
): GraphViewLeaseController {
  let endpoint = validateGrant(grant);
  const createEndpoint = validateSameOriginEndpoint(grant.createUrl);
  const baseId = validateGraphId(baseGraphId);
  let currentLeaseId = grant.leaseId;

  let desiredGraphIds = [baseId];
  let mountedPreparedGraphIds: string[] = [];
  let pendingHandoff: { generation: number; graphIds: string[]; key: string } | null = null;
  let nextHandoffGeneration = 0;
  let desiredKey = graphIdSetKey(desiredGraphIds);
  // The server created the grant for the boot graph. Treat that initial set as synchronized.
  let synchronizedKey = desiredKey;
  let renewalGeneration = 0;
  let synchronizedRenewalGeneration = 0;
  let drainPromise: Promise<void> | null = null;
  let activeRequest: AbortController | null = null;
  let disposed = false;

  const onVisibilityChange = () => {
    if (document.visibilityState === "visible") {
      renewInBackground();
    }
  };
  const onPageShow = () => renewInBackground();
  const onPageHide = (event: PageTransitionEvent) => {
    if (!event.persisted) {
      release();
    }
  };

  const timer = window.setInterval(() => renewInBackground(), grant.heartbeatIntervalMs);
  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("pageshow", onPageShow);
  window.addEventListener("pagehide", onPageHide);

  function renewInBackground(): void {
    if (disposed) return;
    renewalGeneration += 1;
    void synchronize().catch((error: unknown) => {
      // A transient renewal failure is recoverable: the next heartbeat or visibility transition
      // retries the full desired set. Never log response bodies, lease URLs, or opaque graph ids.
      console.warn(error instanceof Error ? error.message : UPDATE_ERROR_MESSAGE);
    });
  }

  function setDesiredGraphIds(next: readonly string[]): Promise<void> {
    if (disposed) {
      return Promise.reject(new Error(INACTIVE_ERROR_MESSAGE));
    }
    let normalized: string[];
    try {
      normalized = uniqueGraphIds(next);
    } catch (error) {
      return Promise.reject(error);
    }
    if (normalized.length > MAX_PROTECTED_GRAPH_IDS) {
      return Promise.reject(new Error(
        `A graph view can protect at most ${MAX_PROTECTED_GRAPH_IDS} graph registrations.`,
      ));
    }
    const nextKey = graphIdSetKey(normalized);
    desiredGraphIds = normalized;
    desiredKey = nextKey;
    return synchronize();
  }

  function synchronize(): Promise<void> {
    if (disposed) {
      return Promise.reject(new Error(INACTIVE_ERROR_MESSAGE));
    }
    if (!needsSynchronization()) {
      return drainPromise ?? Promise.resolve();
    }
    if (drainPromise) {
      return drainPromise;
    }

    const running = drainSynchronizations();
    const tracked = running.finally(() => {
      if (drainPromise === tracked) {
        drainPromise = null;
      }
    });
    drainPromise = tracked;
    return tracked;
  }

  function needsSynchronization(): boolean {
    return desiredKey !== synchronizedKey
      || renewalGeneration !== synchronizedRenewalGeneration;
  }

  async function drainSynchronizations(): Promise<void> {
    while (!disposed && needsSynchronization()) {
      const graphIds = [...desiredGraphIds];
      const graphIdsKey = desiredKey;
      const requestedRenewalGeneration = renewalGeneration;
      try {
        await putGraphIds(graphIds);
      } catch (error) {
        if (disposed) {
          throw new Error(INACTIVE_ERROR_MESSAGE);
        }
        // A newer full desired set supersedes a failed request. Continue directly to that set so
        // concurrent protect/replace calls share one ordered drain and stale failures cannot win.
        if (graphIdsKey !== desiredKey || requestedRenewalGeneration !== renewalGeneration) {
          continue;
        }
        throw error;
      }
      if (disposed) return;
      synchronizedKey = graphIdsKey;
      synchronizedRenewalGeneration = requestedRenewalGeneration;
    }
  }

  async function putGraphIds(graphIds: readonly string[]): Promise<void> {
    const controller = new AbortController();
    activeRequest = controller;
    try {
      let response: Response;
      try {
        response = await fetch(endpoint, {
          method: "PUT",
          mode: "same-origin",
          credentials: "same-origin",
          cache: "no-store",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ version: 1, graphIds }),
          signal: controller.signal,
        });
      } catch {
        throw new Error(UPDATE_ERROR_MESSAGE);
      }
      const result = await readResponseJson(response);
      if (!response.ok) {
        if (response.status === 410 && errorCode(result) === "unknown_lease") {
          await recreateLease(graphIds, controller.signal);
          return;
        }
        // Status is safe diagnostic context. Deliberately do not expose statusText or a body that
        // could contain server internals, filesystem paths, or repository information.
        throw new Error(`${UPDATE_ERROR_MESSAGE} (HTTP ${response.status})`);
      }
      if (
        typeof result !== "object"
        || result === null
        || (result as Record<string, unknown>).version !== 1
        || typeof (result as Record<string, unknown>).expiresAtMs !== "number"
        || !Number.isFinite((result as Record<string, unknown>).expiresAtMs)
      ) {
        throw new Error(UPDATE_ERROR_MESSAGE);
      }
    } finally {
      if (activeRequest === controller) {
        activeRequest = null;
      }
    }
  }

  async function recreateLease(graphIds: readonly string[], signal: AbortSignal): Promise<void> {
    let response: Response;
    try {
      response = await fetch(createEndpoint, {
        method: "POST",
        mode: "same-origin",
        credentials: "same-origin",
        cache: "no-store",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ version: 1, baseGraphId: baseId, graphIds }),
        signal,
      });
    } catch {
      throw new Error(UPDATE_ERROR_MESSAGE);
    }
    const result = await readResponseJson(response);
    if (!response.ok) {
      throw new Error(`${UPDATE_ERROR_MESSAGE} (HTTP ${response.status})`);
    }
    const recreated = parseRecreatedGrant(result, grant.createUrl);
    currentLeaseId = recreated.leaseId;
    endpoint = validateSameOriginEndpoint(recreated.url);
  }

  function release(): void {
    if (disposed) return;
    disposed = true;
    window.clearInterval(timer);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    window.removeEventListener("pageshow", onPageShow);
    window.removeEventListener("pagehide", onPageHide);
    activeRequest?.abort();
    activeRequest = null;

    // This is intentionally fire-and-forget: pagehide and dispose must not hold the page open.
    // keepalive gives the tiny release request a chance to complete during navigation.
    try {
      void fetch(endpoint, {
        method: "DELETE",
        mode: "same-origin",
        credentials: "same-origin",
        cache: "no-store",
        keepalive: true,
      }).catch(() => undefined);
    } catch {
      // The server expiry is the final cleanup boundary when a browser cannot start the request.
    }
  }

  return {
    get leaseId() {
      return currentLeaseId;
    },
    async beginPreparedGraphHandoff(graphIds) {
      const prepared = uniqueGraphIds(graphIds);
      const complete = uniqueGraphIds([baseId, ...mountedPreparedGraphIds, ...prepared]);
      if (complete.length > MAX_PROTECTED_GRAPH_IDS) {
        throw new Error(
          `A graph view can protect at most ${MAX_PROTECTED_GRAPH_IDS} graph registrations.`,
        );
      }
      const generation = ++nextHandoffGeneration;
      pendingHandoff = { generation, graphIds: prepared, key: graphIdSetKey(prepared) };
      try {
        await setDesiredGraphIds(complete);
      } catch (error) {
        if (pendingHandoff?.generation === generation) {
          pendingHandoff = null;
          desiredGraphIds = uniqueGraphIds([baseId, ...mountedPreparedGraphIds]);
          desiredKey = graphIdSetKey(desiredGraphIds);
        }
        throw error;
      }
      let settled = false;
      let settlementPromise: Promise<void> | null = null;
      const settle = (commit: boolean): Promise<void> => {
        if (settlementPromise !== null) return settlementPromise;
        if (settled) return Promise.resolve();

        const settlement = settleOnce(commit);
        const tracked = settlement.finally(() => {
          if (settlementPromise === tracked) settlementPromise = null;
        });
        settlementPromise = tracked;
        return tracked;
      };

      const settleOnce = async (commit: boolean): Promise<void> => {
        if (pendingHandoff?.generation !== generation) {
          settled = true;
          return;
        }
        const previousMounted = mountedPreparedGraphIds;
        if (commit) mountedPreparedGraphIds = prepared;
        pendingHandoff = null;

        // Releasing a candidate is a logical state transition, even when the server update fails.
        // Keep the smaller desired set so the next heartbeat retries removal. Restoring the union
        // here would renew the candidate indefinitely when callers intentionally ignore rollback
        // errors during cancellation.
        if (!commit) settled = true;
        try {
          await setDesiredGraphIds([baseId, ...mountedPreparedGraphIds]);
          if (commit) settled = true;
        } catch (error) {
          if (commit && pendingHandoff === null) {
            // A failed commit cannot assume the server dropped the old mounted pair. Restore the
            // protected union and transaction so the caller can explicitly release the candidate.
            mountedPreparedGraphIds = previousMounted;
            pendingHandoff = { generation, graphIds: prepared, key: graphIdSetKey(prepared) };
            desiredGraphIds = uniqueGraphIds([baseId, ...previousMounted, ...prepared]);
            desiredKey = graphIdSetKey(desiredGraphIds);
          }
          throw error;
        }
      };
      return {
        commit: () => settle(true),
        release: () => settle(false),
      };
    },
    replacePreparedGraphIds(graphIds) {
      let mounted: string[];
      try {
        mounted = uniqueGraphIds(graphIds);
        const complete = uniqueGraphIds([baseId, ...mounted]);
        if (complete.length > MAX_PROTECTED_GRAPH_IDS) {
          throw new Error(
            `A graph view can protect at most ${MAX_PROTECTED_GRAPH_IDS} graph registrations.`,
          );
        }
        // The store publishes candidate ids before review derivation finishes. A matching pending
        // handoff is not a commit signal; only its transaction may drop the rollback pair.
        if (pendingHandoff !== null && graphIdSetKey(mounted) === pendingHandoff.key) {
          return Promise.resolve();
        }
        mountedPreparedGraphIds = mounted;
        return setDesiredGraphIds([
          ...complete,
          ...(pendingHandoff?.graphIds ?? []),
        ]);
      } catch (error) {
        return Promise.reject(error);
      }
    },
    dispose: release,
  };
}

function validateGrant(grant: GraphViewLeaseGrant): string {
  if (
    grant.version !== 1
    || typeof grant.leaseId !== "string"
    || grant.leaseId.length === 0
    || grant.leaseId.length > 256
    || !Number.isFinite(grant.expiresAtMs)
    || grant.expiresAtMs < 0
    || !Number.isInteger(grant.heartbeatIntervalMs)
    || grant.heartbeatIntervalMs <= 0
    || grant.heartbeatIntervalMs > MAX_TIMER_DELAY_MS
    || typeof grant.url !== "string"
    || grant.url.length === 0
    || typeof grant.createUrl !== "string"
    || grant.createUrl.length === 0
  ) {
    throw new Error("Invalid graph view lease contract.");
  }
  validateSameOriginEndpoint(grant.createUrl);
  return validateSameOriginEndpoint(grant.url);
}

function validateSameOriginEndpoint(value: string): string {
  let endpoint: URL;
  try {
    endpoint = new URL(value, window.location.href);
  } catch {
    throw new Error("Invalid graph view lease contract.");
  }
  if (endpoint.origin !== window.location.origin || endpoint.username || endpoint.password) {
    throw new Error("Graph view lease endpoint must be same-origin.");
  }
  // Fetch a root-relative endpoint so the controller cannot accidentally retain or transmit an
  // origin supplied by boot HTML. URL fragments are client-only and do not belong on the request.
  return `${endpoint.pathname}${endpoint.search}`;
}

async function readResponseJson(response: Response): Promise<unknown> {
  // Always drain the body, including non-2xx responses. This keeps browser request accounting and
  // connection reuse correct without ever surfacing server-provided text to the user.
  try {
    return await response.json();
  } catch {
    throw new Error(UPDATE_ERROR_MESSAGE);
  }
}

function errorCode(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const code = (value as Record<string, unknown>).code;
  return typeof code === "string" ? code : null;
}

function parseRecreatedGrant(value: unknown, createUrl: string): GraphViewLeaseGrant {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(UPDATE_ERROR_MESSAGE);
  }
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate).sort();
  if (
    keys.length !== 5
    || keys[0] !== "expiresAtMs"
    || keys[1] !== "heartbeatIntervalMs"
    || keys[2] !== "leaseId"
    || keys[3] !== "url"
    || keys[4] !== "version"
  ) {
    throw new Error(UPDATE_ERROR_MESSAGE);
  }
  const recreated: GraphViewLeaseGrant = {
    version: candidate.version as 1,
    leaseId: candidate.leaseId as string,
    url: candidate.url as string,
    createUrl,
    expiresAtMs: candidate.expiresAtMs as number,
    heartbeatIntervalMs: candidate.heartbeatIntervalMs as number,
  };
  validateGrant(recreated);
  return recreated;
}

function uniqueGraphIds(graphIds: readonly string[]): string[] {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const value of graphIds) {
    const graphId = validateGraphId(value);
    if (!seen.has(graphId)) {
      seen.add(graphId);
      unique.push(graphId);
    }
  }
  return unique;
}

function validateGraphId(value: string): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > MAX_GRAPH_ID_LENGTH
    || value.trim() !== value
  ) {
    throw new Error("Invalid graph registration id.");
  }
  return value;
}

function graphIdSetKey(graphIds: readonly string[]): string {
  // Set order is not meaningful. Sort a copy so an equivalent reordered input is deduplicated;
  // length-prefixing avoids delimiter collisions while retaining only a compact string key.
  return [...graphIds]
    .sort()
    .map((graphId) => `${graphId.length}:${graphId}`)
    .join("|");
}
