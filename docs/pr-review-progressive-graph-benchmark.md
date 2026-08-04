# Partial-runtime-only PR graph benchmark and recordings

`packages/cli/scripts/benchmark-pr-review-progressive.mjs` measures the production PR-review path
after the bounded graph became the lasting model. A progressive review never starts, downloads, or
reconciles a complete graph in the background.

The final harness measures one contract only:

1. **Partial-only production path (`progressive:true`)** — resolve the exact HEAD and merge base,
   semantically extract and project the bounded affected-file depth-1 slice so the first-neighbour
   ring is the initial ghost frontier, reserve that pair, emit `ready`, emit an authoritative
   `done` for the *same* graph IDs/pair ID, and end the NDJSON stream. The landing page may navigate
   as soon as `ready` arrives. Depth changes, ghost promotion, and disconnected search picks later
   request cumulative, bounded partial projections. The initial depth-1/prefetch-3 reservation is
   the only wider boot request; after first action the renderer warms the exact depth-2 slice
   (`depth=2`, `prefetchDepth=2`) and never speculates past it. Depths 3–6 are built only after the
   reader explicitly selects them, so a shallow review cannot drift toward a repository-wide graph.

The `--partial-runtime-only` mode requests only this path. It never sends `progressive:false`, never
adds a complete-graph benchmark capability header, and never constructs a complete repository graph.

## Publishability gates

A complete report is rejected if any configured case lacks evidence. There are no silent skips.
Publishable evidence requires all of the following:

- at least two open `UiPath/Autopilot` PRs and at least two prepared partial repetitions;
- exact, stable PR HEAD/ref/repository provenance and an exact merge-base binding;
- one `ready` and one adjacent terminal `done`, with identical partial HEAD/comparison graph IDs,
  20-hex pair ID, SHAs, counts, changed-file manifest, and depth-1/prefetch-3 reservation;
- observed NDJSON EOF immediately after that `done`, with no post-ready extract/reuse/lane events;
- no `/api/graph` request or response, no `/api/generate`, and no
  `meridian:pr-canonical-graph-reconciled` mark during the post-terminal navigation dwell;
- no `progressive:false` analysis request, complete-graph capability header, or service launched
  with that benchmark capability;
- zero repository-analysis workers at the terminal; worker PIDs are sampled across the dwell, and
  every newly observed PID must fit the same-dwell source-index, partial-projection, or partial-warm
  request delta and its conservative per-request worker bound;
- progressive transport only through `/api/graph/project`, with zero `/api/graph` traffic;
- the exact changed-file review surface in every repetition, a non-empty actionable partial canvas,
  and no renderer/page/critical-API errors;
- a renderer-started symbol request accepted by
  `meridian:progressive-symbol-index-ready`. This is a syntax-only disposable source scan that
  emits compact symbol and import/dynamic-import/exact-IPC topology files; it does not construct a
  full semantic graph;
- adjustable-depth evidence, next-ring warming, nonresident Cmd/Ctrl+P hydration to ready, and
  canvas growth after adding the searched symbol;
- authoritative CDP graph-transfer accounting and separately labelled browser heap, browser RSS,
  service RSS, and disposable-worker RSS;
- absolute time-to-action, loading, and memory measurements only. The current run has one lane and
  computes no cross-variant comparisons, reductions, or other relative percentages;
- **exactly two progressive recordings for every PR**: one partial startup recording and one
  separate partial depth-plus-search recording. A single recording cannot stand in for these
  different claims. No second-variant video is produced;
- every video decodes, uses the expected viewport, has moving non-black frames, and retains its
  codec, dimensions, duration, sampled/distinct frames, size, SHA-256, and validation timestamp.

## Run

Build Meridian first and start the same normal service used for production review on port 4189. Do
not add any benchmark-only capability flags:

```bash
node packages/cli/dist/bin.js web \
  --host 127.0.0.1 \
  --port 4189 \
  --no-open \
  --typescript-incremental admitted \
  --experimental-pr-revision-cache
```

Then point the harness at that service:

```bash
node packages/cli/scripts/benchmark-pr-review-progressive.mjs \
  --url http://127.0.0.1:4189 \
  --repository UiPath/Autopilot \
  --prs 4712,4703,3851 \
  --repetitions 3 \
  --partial-runtime-only \
  --output artifacts/pr-review-progressive-poc-2026-08-03-ready-v21
```

The output directory must not already exist. The default run includes isolated cold services and
validated recordings. In `--partial-runtime-only` mode, `--no-cold`, `--no-recordings`,
`--skip-video-validation`, and `--allow-search-skip` are rejected during argument parsing. Fewer
than two PRs, fewer than two repetitions, or a non-Autopilot corpus keeps the result diagnostic
rather than publishable.

Cold services use a fresh private `MERIDIAN_CACHE_DIR`, the same capability-disabled configuration,
and a tracked process tree for each PR. Cleanup proves every recorded PID/process group absent before
deleting the owned temporary directory. Interrupting the harness invokes the same bounded cleanup.

## Artifacts

The output contains exactly two progressive videos per PR, plus their evidence and report:

- `results.json` — machine-readable timings, transfer/memory measurements, exact revisions,
  ready/done/EOF proof, worker/network quiescence, interactions, and recording validation;
- `report.html` — a standalone browser-openable report with embedded evidence and relative videos;
- `metadata/autopilot-pr-*.json` — live PR snapshots used to reject revision drift;
- `videos/autopilot-pr-*-progressive-cold-startup.webm` — partial startup recordings;
- `videos/autopilot-pr-*-progressive.webm` — separate depth/search functionality recordings.

Re-render a saved complete report without rerunning browsers:

```bash
node packages/cli/scripts/render-pr-review-poc-report.mjs \
  --results artifacts/pr-review-progressive-poc-2026-08-03-ready-v21/results.json \
  --output artifacts/pr-review-progressive-poc-2026-08-03-ready-v21/report-rerendered.html
```

The renderer refuses to overwrite results/media, revalidates complete evidence, re-hashes every
recording, and fails if a referenced artifact is missing or changed. Only documents declaring
`deliveryContract: "partial-runtime-only-v1"` can substantiate the current absolute,
no-full-work claim.

## Measurement boundaries

Time to action is the renderer-owned `meridian:first-actionable-canvas` mark. The landing shell
also records the manifest-actionable and bounded-ready marks on a calibrated browser/Node monotonic
timeline. In the partial lane, settled loading means navigation restored, fonts ready, and two
animation frames; no full-graph build, download, or reconciliation exists in that path.

The report presents the observed values directly: cold and prepared time to action, settled loading,
graph-transfer bytes, browser heap/RSS, service RSS, and disposable-worker RSS. It does not derive
cross-variant differences or reduction percentages because this contract deliberately has one lane.

Graph bytes come from a CDP request-hop ledger. `Network.loadingFinished.encodedDataLength` is the
authoritative terminal total. Redirects, cache hits, request-ID reuse, blocked requests, incomplete
streams, and accounting anomalies stay explicit and prevent publication when they affect graph
routes. Background symbol/topology traffic remains visible in route diagnostics but is not counted
as initial graph transfer.

The cold partial proof combines five independent observations:

1. `ready → same-pair done → EOF` in the fully drained preparation stream;
2. a top-level `/view?...progressive=1&partial=1&pair=...` document request;
3. no canonical graph request/response or retired reconciliation mark during the dwell;
4. an owned-process snapshot with zero `repository-analysis-worker` descendants after terminal; and
5. service-process provenance proving the complete-graph benchmark capability flag was absent.

Later repository-analysis workers are allowed only with a partial-projection or partial-warm
request observed in the same sampled dwell interval. Graph-project workers likewise require a
same-dwell partial-projection, partial-warm, or source-index request. Initial page-load counters
cannot authorize a newly observed worker, and request-to-worker cardinality is bounded. Syntax
symbol/topology indexing is separately admitted and labelled; its presence is not evidence of a
full graph.
