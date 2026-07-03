# ADR 0001 — Graph Artifact Schema (the contract everything depends on)

- Status: Accepted
- Date: 2026-06-27
- Deciders: blueprint team
- Issue: #1 ("the contract everything depends on")
- Supersedes: the parked Python/pyan3/`__qualname__`-as-join plan in the seeded `README.md`

## Context

`meridian` is a CLI + dark-mode web renderer that visualizes a codebase as
Unreal-Engine-Blueprints-style hierarchical boxes a non-technical person drills down:
system → module → class → function. Two CLI commands (`generate`: source → graph-JSON
artifact; `view`: serve the renderer on an artifact) sit on opposite sides of one data
contract. The product is language-agnostic via a pluggable `LanguageExtractor`
(TypeScript/ts-morph first; Go/Rust/Python later as additive adapters). A pluggable
**mock** telemetry overlay (call count, latency p50/p95/p99, error rate) must paint onto
the same graph today, with the schema and node ids forward-compatible so a **real**
Tempo/OTel overlay drops in later with no re-keying. A mandatory UI ENV selector gates
telemetry and must **never** default to prod.

Because both commands, every future extractor, the renderer, and every future overlay
compile against this one artifact, the schema must be: versioned; language-agnostic; flat
and partial-load-friendly for drill-down; honest about static-analysis limits; and
forward-compatible with telemetry — without being over-engineered for a v1 that only emits
TypeScript.

## Decision

Adopt **GraphArtifact v1.0.0**: one JSON file = one project snapshot, emitted by
`generate`, consumed by `view`.

1. **Flat nodes + `parentId`, not a nested tree.** Containment is expressed by reference
   (`node.parentId`), never as an edge. Edges carry only behavioural relationships. This
   beats AppMap's embedded `children` tree for drill-down, partial loading, and telemetry
   joins while keeping identical semantics.

2. **Node kinds = a small, OPEN vocabulary.** Registry: `package, module, namespace,
   class, interface, enum, typeAlias, function, method` (the v1 TS extractor emits the
   first set; `enum`/`typeAlias` are reserved). Edge kinds open too: `calls, references,
   imports, extends, implements, instantiates`. Open vocabularies (pattern-validated, with
   a warn-level registry lint) are mandated by "other languages slot in later": a closed
   enum would force a breaking MAJOR every time a Go/Rust adapter needs
   `struct`/`trait`/`protocol`. The single closed enum is `edge.resolution` (`resolved |
   external | unresolved`) — a complete, language-independent classification.

3. **Stable, language-agnostic node id = the generalized `__qualname__`.**
   `<lang>:<modulePath>[#<qualname>][~<n>]`. The `<lang>:<modulePath>#` prefix globalizes
   Python's module-local `__qualname__`: the lang tag prevents cross-language collisions,
   the repo-root-relative POSIX `modulePath` prevents cross-module collisions and stays
   machine-portable. Native scope separators normalize to `.`; static-vs-instance is NOT
   in the separator (it lives in `tags`); Python `<locals>` collapse to match TS closures;
   colliding siblings (overloads, declaration merging) disambiguate with a positional `~n`
   (sorted by `startLine,startCol`), so adding a same-name interface never silently
   re-ids a class.

4. **`node.id` is THE telemetry JOIN key.** Real instrumentation stamps it as one span
   attribute for exact match. A per-node `telemetry` object (function|method only)
   materializes OTel source-code coords (`code.namespace`, `code.function`,
   `spanNameHints`; `code.filepath`/`code.lineno` derived from `location`) as a fallback
   join. The org rule is baked into the data, not just the UI: `service.name` /
   `deployment.environment.name` appear NOWHERE in the artifact; the top-level `telemetry`
   contract declares `requiredRuntimeAttributes` and asserts `serviceDefaulting:
   "forbidden"` — a machine-checkable invariant.

5. **Adversarial honesty.** Static call resolution is imperfect (ts-morph `getSymbol()`
   can be undefined/external/ambiguous), so every edge carries `resolution` and
   over-approximated edges may carry `confidence`. External/unresolved targets are
   pseudo-ids (`ext:`, `unresolved:`) tolerated without a backing node.

6. **One schema, two encodings.** The schema is authored once as a **zod** schema in
   `@meridian/core` (source of truth; `z.infer` → the TS types; `.safeParse` → the
   runtime Tier-1 validator). A build step emits `graph-artifact-1.0.0.json` (JSON Schema
   2020-12) from it via zod's native `z.toJSONSchema` for non-JS consumers and this ADR.
   `validateArtifact()` layers Tier-2 cross-array checks (id uniqueness, parentId
   acyclicity, edge-id determinism, registry lint, the `serviceDefaulting` invariant) that
   JSON Schema/zod cannot express.

The full schema (JSON Schema + TS types + node-id grammar + join ladder + SemVer rules) is
the project's canonical reference and lives alongside the code in `@meridian/core`.

## The contract

### Top-level shape

```
GraphArtifact = {
  schemaVersion, generatedAt, generator{name,version},
  target{name, version?, root, language, vcs?},
  telemetry?{ joinKey:"node.id", requiredRuntimeAttributes[], serviceDefaulting:"forbidden", semconvVersion? },
  nodes: Node[], edges: Edge[], extensions?
}
```

Containment lives ONLY in `node.parentId` (never an edge). Edges carry behavioural
relationships only.

### Node

```
Node = {
  id,                 // <lang>:<modulePath>[#<qualname>][~<n>]  — stable, language-agnostic, = telemetry join key
  kind,               // OPEN vocab: package|module|namespace|class|interface|enum|typeAlias|function|method|...
  qualifiedName,      // native fully-scoped name, e.g. "OrderService.placeOrder"
  displayName,        // LOCAL source name only, e.g. "placeOrder" (renderer prettifies; NOT pre-humanized)
  summary?,           // issue #6 one-liner from the JSDoc/doc first sentence; null if none
  parentId?,          // containment by reference; null/absent at roots
  language?,          // polyglot override of target.language
  location{ file, startLine, endLine?, startCol? },
  signature?,         // textual typed-pin descriptor, e.g. "placeOrder(request: OrderRequest): Order"
  tags?,              // modifiers (public/private/async/static/abstract/export) AND semantic (entrypoint/io/...)
  telemetry?{ codeNamespace?, codeFunction, spanNameHints[] }   // EMITTED ON function|method ONLY
}
```

### Edge

```
Edge = {
  id,                 // `${kind}@${source}|${target}` — at most one edge per (source,target,kind)
  source,             // node id, always in-graph
  target,             // node id; in-graph when resolution=resolved, else an ext:/unresolved: pseudo-id
  kind,               // OPEN vocab: calls|references|imports|extends|implements|instantiates|...
  resolution,         // CLOSED enum: resolved | external | unresolved  (default resolved)
  weight?,            // >=1; when callSites present, weight === callSites.length
  callSites?[{file,line,col?}],
  confidence?         // 0..1, for over-approximated interface-dispatch/overload edges
}
```

### Node-id convention (the generalized `__qualname__`)

Grammar: `<lang> ":" <modulePath> [ "#" <qualname> ] [ "~" <n> ]`

- `<lang>`: short lowercase tag (`ts`, `py`, `go`…). Reserved pseudo-langs `ext`,
  `unresolved` for non-resolved edge TARGETS only.
- `<modulePath>`: `target.root`-relative POSIX locator. File-based langs (TS/JS): file
  path WITH extension (`src/services/orderService.ts`); a package node = its directory
  path (`src/services`). Logical-module langs (Python): dotted module name
  (`app.services.auth`).
- `<qualname>`: the substring after `#` IS the generalized `__qualname__` = dotted chain
  of enclosing named containers + member. Normalizations make it cross-language: every
  native scope separator (`::`, `#`, `$`, `.`) normalizes to `.`; static-vs-instance is
  NOT encoded in the separator (lives in `tags`); Python `<locals>` collapse
  (`login.<locals>._helper` → `login._helper`, identical to a TS closure).
- `<n>`: source-order ordinal appended ONLY to disambiguate colliding siblings (TS overload
  signature+impl, declaration merging, two same-name local fns). Sort colliding set by
  `(startLine,startCol)` asc; first keeps the bare id, rest get `~1`, `~2`…

Worked (fixture, `target.root = "examples/orders-service"`):

```
ts:src/services                                          (package)
ts:src/services/orderService.ts                          (module)
ts:src/services/orderService.ts#OrderService             (class)
ts:src/services/orderService.ts#OrderService.placeOrder  (method)
ext:typescript/lib.es5.d.ts#Error                        (external base, only as an edge target)
```

### Telemetry join ladder (forward-compatible, never prod by default)

PRIMARY key = `node.id` (real instrumentation stamps it as one attribute; exact match).
Fallback ladder a future Tempo/OTel overlay uses with ZERO re-keying / ZERO schema change:

1. span carries the blueprint node-id attribute → exact `node.id` match (best)
2. `(span.code.namespace, span.code.function)` == `(telemetry.codeNamespace, telemetry.codeFunction)`
3. `(span.code.filepath, span.code.lineno)` == `(location.file, line ∈ [startLine,endLine])`
4. `span.name` ∈ `telemetry.spanNameHints` (fuzzy)

Org rule baked into the data: `service.name` / `deployment.environment.name` appear
NOWHERE in the artifact; the top-level `telemetry` contract declares them via
`requiredRuntimeAttributes` and asserts `serviceDefaulting: "forbidden"`. The UI's
mandatory ENV selector supplies them at view time and must never default to prod.

### Versioning + two-tier validation

SemVer on `schemaVersion`: PATCH = docs; MINOR = purely additive (new optional field / new
well-known vocab value / new `extensions` key — readers ignore unknowns; optional never
becomes required); MAJOR = removal/rename, optional→required, narrowing, or closing an open
vocab into an enum. The `extensions` bag is the guaranteed-non-breaking channel. Readers
accept `MAJOR == reader` and `MINOR <= reader`.

- Tier 1 (`graphArtifactSchema.safeParse`): structural shape.
- Tier 2 (`validateArtifact`, cross-array — zod can't express): duplicate node ids;
  parentId resolves + forest acyclicity; resolved-edge source/target resolve to existing
  nodes (ext:/unresolved: targets exempt); `edge.id === `${kind}@${source}|${target}``;
  `weight === callSites.length` when both present; `telemetry.serviceDefaulting ===
  "forbidden"` when telemetry present; unknown `node.kind`/`edge.kind` → WARN (renderer
  uses default box).

`generate` fails-closed on Tier-1 + Tier-2 errors; `view` runs Tier-1 + warn-level Tier-2
so a new-language adapter is never blocked on a renderer release.

## Alternatives considered

- **Heavier "Design B" schema** (per-node priority-ordered telemetry descriptor[];
  per-object `ext`/`^x-` escape hatches; structured typed `ports`). Rejected for v1 as
  premature: duplicates `node.id` + OTel coords for providers with no consumer yet. Its
  genuinely-better ideas were merged: first-class `interface/enum/typeAlias` kinds +
  `extends/implements` edges, open-vocab-with-lint, edge `callSites[]`/`confidence`, and
  the org-rule-as-contract object.
- **AppMap `.appmap.json` format (adopt directly).** Rejected: MIT + Commons Clause
  (study-only), and it is a runtime *execution recorder* (dynamic `events` stream,
  value/exception objects) structurally unlike our static analysis. Used as a *design
  donor*: its `package/class/function` taxonomy, `{type}:{hierarchical-id}` id strategy,
  local-name/location/labels fields, and the span↔function `(path:lineno)` join all
  informed this schema; its `children` tree was inverted to flat `parentId`.
- **dagre / pyan3 / Python-first with `__qualname__` as the literal join key** (the parked
  README plan). Rejected: the product pivoted to TS-first with a pluggable extractor and a
  mock overlay; `__qualname__` is Python-specific and neither globally unique nor portable
  — we generalize it into the `<lang>:<modulePath>#<qualname>` id instead.
- **Containment as edges.** Rejected: bloats the edge list, conflates structure with
  behaviour, and complicates edge-lifting in the renderer. `parentId` is strictly simpler.

## Consequences

- The renderer maps `node.id` → React Flow node id verbatim and `parentId` → React Flow
  `parentId` containment; ids stay stable as the telemetry join key end-to-end.
- Every consumer must tolerate unknown additive members and unknown (registry-absent) kinds
  (default box). New data lands in `extensions` first, promoted to a named optional field
  in a later MINOR.
- A new-language adapter ships without a renderer or schema MAJOR bump (open vocab +
  extensions bag).
- A real Tempo/OTel overlay binds via `node.id` first, OTel coords second, span name last —
  zero re-keying, zero schema change. The mock overlay validates exactly this contract today.
- `generate` fails-closed on validation; `view` is lenient (warn-level) so adapters aren't
  blocked on renderer releases.
- The seeded `README.md` is now stale and must be rewritten to the TS-first / mock-overlay
  plan (tracked separately).
