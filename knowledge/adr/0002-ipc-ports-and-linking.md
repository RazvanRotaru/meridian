# ADR 0002 — IPC ports, channel nodes, and cross-artifact linking

**Status:** accepted · **Date:** 2026-07-06 · **Builds on:** ADR 0001 (the graph-artifact contract)

## Context

Static analysis cannot follow a call across a process boundary: `ipcRenderer.invoke("get-user")`
dead-ends as an external call, an express route looks like an unused handler, and two separately
analyzed repos that talk over HTTP share no edge at all. Yet both ends of an IPC operation are
statically visible — and they share a **channel key** (the IPC channel string, the route path, the
topic). Runtime approaches (telemetry import, eBPF maps, instrumented runs) were considered and
deliberately **excluded**: this decision covers only what static analysis plus repository evidence
can claim, with zero manual marking.

## Decision

### 1. Ports — the boundary, detected per repo

An extractor may report **ports**: typed entries/exits where the code crosses a process boundary.

```
Port { nodeId, direction: "in"|"out", protocol, channel: string|null, label, callSite }
```

- Ports ride `extensions.ports` — the ADR-0001 escape hatch; **no schema change, no version bump**.
- `protocol` is an open vocabulary (`http`, `electron`, …), like every other kind in the contract.
- **Honesty rule:** `channel` is read ONLY from a string literal (or expression-free template).
  A dynamic channel is reported with `channel: null` — the boundary is never hidden, and never guessed.
- Detection is a **matcher registry** keyed on import names + callee shapes (textual, not the type
  checker, so cloned repos work without `node_modules`). v1 surfaces: electron `ipcRenderer`/
  `ipcMain`/`webContents.send`; `fetch`/axios exits; express route registrations.

### 2. Channels — the join, materialized as pseudo-nodes

Matching ends join through a **channel node**, never a direct edge:

```
sender —sends→ [ ipc:<protocol>/<channel-slug> ] —handles→ handler
```

- The `ipc:` pseudo-id reuses the ADR-0001 node-id grammar exactly as `ext:`/`unresolved:` do.
- `channel`/`system` node kinds and `sends`/`handles` edge kinds join the lint vocabulary
  (open vocabulary — warn-level, never breaking).
- A **one-ended channel is kept** — a dangling channel IS the finding ("someone sends on this and
  nobody listens"), the port-level analog of honest resolution.
- Fan-in/fan-out fall out for free: N senders and M handlers all wire to one channel node.

### 3. Linking — N artifacts, one system graph, static evidence only

`meridian link a.json b.json …` merges artifacts:

- Each source becomes a `system` container (`sys:<name>`); its node ids are **namespaced** by
  prefixing the module path with the system name (`ts:src/x.ts` → `ts:orders-api/src/x.ts`) so two
  repos' identical paths never collide. `ext:`/`unresolved:`/`ipc:` ids are deliberately NOT
  namespaced — they are the shared space where systems meet.
- Channels are **rebuilt from scratch** over the merged port set (per-artifact channel nodes are
  stripped first) so intra- and cross-system joins come out of one code path.
- One extra join rule for HTTP: a concrete exit path unifies onto an entry **route template**
  (`GET /api/orders/123` → `GET /api/orders/:id`) when exactly one template matches, most-specific
  first; an ambiguous tie matches nothing.
- The linked artifact is a plain `GraphArtifact` (generator `meridian-link`, language `mixed`) —
  the renderer, `coverage`, and every other consumer work on it unchanged.

## Consequences

- The renderer needs no new machinery: channels/systems are ordinary nodes with kind accents;
  `sends`/`handles` join the behavioural edge set so flows trace across process boundaries.
- Future protocols (queues, gRPC, WebSockets, workers) are new matchers, not new contract.
- Future *evidence* tiers (docker-compose env resolution, contract files, package-registry joins,
  runtime confirmation) can raise `edge.confidence` on the same edges — the shape doesn't change.
- Known limits, accepted: dynamic channels join nothing (reported, not guessed); express routers
  mounted under a prefix keep their unprefixed paths; the HTTP join ignores hosts (path identity is
  assumed within a linked set — correct for the common one-API case, revisit with config mining).
