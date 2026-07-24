# PR review direct preparation and exact-revision reuse

Status: **implemented and validated locally; revise before production admission**  
Baseline inspected before implementation: `origin/main`
`44cb54a29d03e28f9971e7f1902bc28a8200a7f4` (2026-07-23)

This note is intentionally separate from the TypeScript incremental-extraction POC. This change
reuses a complete, immutable graph for an exact comparison revision; it does not yet admit
per-package shards into PR serving.

During final validation `origin/main` advanced to
`49724ad3a8b1ba61e67685d28542c70d021b3134` (“Make graph registry capacity a soft target”).
That commit's graph-retention changes were forward-ported into the dirty POC worktree without
resetting or discarding the validated changes.

## Current-main diagnosis

The selected-PR path did perform redundant work:

1. The Git integration page called `/api/generate` for the PR base branch and waited for that graph.
2. It navigated to the generated base-tip graph with `prn=<number>&rev=1`.
3. Renderer URL restoration then called `/api/pr/analyze`, which resolved the live PR refs and
   prepared another graph for the exact HEAD plus one for Git's exact merge-base.
4. The renderer downloaded and indexed those review artifacts before it could project the review.

For a repository-wide selection, step 1 was a repository-wide extraction whose graph was only a
bootstrap authority for step 3. It was not the semantic comparison graph unless the base tip
happened to equal the merge-base. Different PR-pair cache entries could also extract the same
merge-base independently, which explains why a second sibling PR could navigate quickly but remain
in the opaque loading screen for minutes.

## Direct preparation flow

```text
selected PR snapshot
  -> POST /api/pr/prepare(repository, PR number, base ref, head ref, selected HEAD SHA)
  -> resolve exact remote HEAD and base; reject if selected HEAD already moved
  -> run the ordinary PR pair pipeline
       exact HEAD artifact
       exact merge-base artifact (extract or verified revision-cache hit)
  -> publish/register the immutable pair
  -> navigate to /view?id=<HEAD graph id>&prn=<number>&rev=1
  -> boot and index that exact HEAD artifact
  -> re-resolve live refs through POST /api/pr/analyze
       same HEAD graph id: reuse the boot artifact and its existing index; load only comparison
       different graph id: lease, load, validate, and atomically install the new exact pair
  -> project the review
```

The second analysis request is deliberate. Direct preparation removes the redundant base-tip
extraction and makes navigation exact for the picker snapshot; renderer restoration re-resolves
both moving refs so a force-push or base update between preparation and display cannot silently
open stale content. The normal exact-pair cache makes the unchanged case a verified hit without
another extraction.

Renderer HEAD reuse has one rule: the live result's immutable graph ID must exactly equal the boot
graph ID. It then reuses both the already-decoded artifact and its index, and does not fetch HEAD
graph bytes or HEAD execution metadata again. Any ID change follows the ordinary two-artifact
load/swap path. Graph-view leases cover the pair before either new artifact is installed.

## Canonical revision caches

Two strict immutable roles are eligible:

- A normal, populated comparison revision is branch-neutral: `changedSince: null`, no empty-side
  hints, and complete review fingerprints (`mode: "all"`).
- A normal, populated HEAD revision is bound to the exact HEAD commit, exact resolved merge-base,
  HEAD branch, `changedSince: <merge-base>`, no empty-side hints, and changed-file review
  fingerprints (`mode: "changed"`). The moving base-tip commit is deliberately absent: once the
  exact merge-base is resolved, it is not an input to HEAD extraction.

Pair slots and graph IDs remain base-tip-sensitive. A base update therefore still resolves a new
pair and obtains its own workspace and lease set, but an unchanged HEAD plus unchanged merge-base
can reference the same verified immutable HEAD bytes without running analysis again. Any artifact
that requires empty-side hints remains pair-local. A populated comparison for a whole-subtree
deletion can still be canonical and shared; a materialized empty side cannot.

The version-1 input identity is SHA-256-addressed over:

- repository key and normalized remote URL;
- exact role-specific commits (comparison commit, or HEAD plus merge-base), target name, HEAD
  branch where applicable, and extraction subdirectory;
- repository-analysis, graph-schema, generator, and cache-format versions;
- a deterministic build SHA-256 over the CLI/core/extractor source trees, package and TypeScript
  configuration, workspace configuration, and lockfile;
- exact Node version, platform, architecture, TypeScript version, and ts-morph version;
- a random server-process nonce, which is the hard interim reuse boundary;
- the complete repository-analysis policy;
- the fixed canonical role: comparison has no changed-since base and full fingerprints; HEAD has
  the exact merge-base as changed-since input and changed-file fingerprints; both require no hints,
  non-empty analysis, and the exact fingerprint format version and algorithm.

Publication stages an artifact, validates its canonical facts, and writes an immutable object below
its artifact-byte digest plus snapshot ID. A separate input-digest pointer is replaced atomically.
Every hit verifies the exact input object, pointer and metadata digests, artifact length and SHA-256,
summary, target/repository/commit coordinates, and the role-specific changed-since facts before
returning a file-backed artifact.

| Condition | Result |
|---|---|
| Different HEAD/merge-base commit, repository, target, branch, or subdirectory | Different input identity; extract |
| Base tip moves but exact HEAD and merge-base do not | New pair slot; verified HEAD and comparison reuse before analysis admission |
| Analysis policy or analysis/schema/generator/fingerprint/cache version changes | Different input identity; extract |
| Explicit cache refresh | Bypass the shared read and publish a new immutable result |
| Missing, malformed, mismatched, or corrupt pointer/metadata/artifact bytes | Fail closed to extraction |
| Populated sibling PRs with the same complete identity in one server process | Reuse the verified merge-base artifact |
| Server restart, including an otherwise identical build and environment | New process nonce; extract |
| Hinted or materialized empty-side artifact | Never admitted to this shared cache |

Cold and warm use one canonical pipeline. A cold miss calls the ordinary comparison extractor with
the canonical inputs and publishes its exact bytes; a warm hit returns those same bytes only after
verification. No prior `GraphArtifact` is patched or semantically restamped. The cold extractor
therefore remains the semantic oracle, while the warm path is byte-preserving reuse of one of its
published results.

## Visible progress

The landing page now distinguishes repository preparation, HEAD extraction, merge-base extraction
or verified reuse, and opening the result. The renderer replaces the generic “Loading blueprint…”
screen with observable boot/review milestones:

- graph download, indexing, services, and initial layout;
- PR details, clone/checkout, HEAD extraction, merge-base extraction or reuse;
- review-artifact loading/indexing and final review projection.

Both entry points consume one browser-safe versioned model with the same ordered steps, labels,
revision states, status formatter, error/cancellation rules, and optional extraction observation.
The live status reserves seven lines in the landing/card surface, five in the wider boot surface,
and two in compact inline controls before extraction begins. The two revision lanes also reserve
their wrapped height. Rapidly changing file paths therefore stay inside a bounded, anywhere-wrapped
viewport instead of moving the card; full text remains in the live region and hover title, while
terminal errors remain unclamped.
The landing page stores a destination-scoped, PR-number-bound, one-shot session handoff before
navigation. Renderer boot may consume it only for the exact destination and PR within its 60-second
TTL, then continues at artifact loading rather than resetting to a contradictory generic splash.
Back/Forward navigation and a change of PR identity reset the active progress model so a previous
PR's state cannot appear in the new route. Copied URLs and malformed, mismatched, replayed, or stale
handoffs simply start from conservative boot state. These stages are presentation-only telemetry
and do not participate in cache identity.

## Known limits

- Immutable revision objects and input entries have no garbage collector yet.
- There is no cross-pair in-flight singleflight for a first-time revision miss. Concurrent sibling
  requests can duplicate HEAD or comparison extraction; immutable publication and verification
  preserve correctness.
- The renderer still must hold and index the exact HEAD and merge-base graphs to compute the review.
  This removes a throwaway base-tip graph and a duplicate HEAD fetch/index, not the two semantic
  review inputs.
- Exact-pair and exact-revision hits still resolve remote refs and acquire the required workspace and
  graph leases.
- Shared reuse deliberately excludes empty-side hinted analyses.
- Shared reuse is deliberately process-local. This preserves the sibling-PR benefit but does not
  reuse persisted PR artifacts after restart.
- A new process nonce makes old pair and revision entries unreachable, while those immutable
  entries currently have no garbage collector. Repeated server restarts therefore duplicate disk
  use. Keep this cache experimental or isolate it behind bounded ephemeral retention until quota,
  age, and reference-aware cleanup exist.
- This cache is whole-artifact reuse, not the incremental TypeScript shard POC. Any future semantic
  input is not assumed to be covered by the deterministic digest. Python interpreter/package
  state, Git implementation/configuration, filesystem behavior, and the full transitive analysis
  closure are not yet hermetically captured; the process nonce is the fail-closed boundary while
  that provenance remains incomplete.
- An external interpreter, dependency, or Git configuration mutated while the same server process
  remains alive is not detected. Operational validation must restart the server after such changes.
- No production PR-serving rollout, admission policy, operational cache sizing, or eviction policy
  is decided by this implementation.

## Validation

Recorded commands and outcomes:

| Command | Outcome |
|---|---|
| `pnpm --filter @meridian/cli exec vitest run src/analysis-runtime-fingerprint.test.ts src/server/web-pr-cache.test.ts src/server/web-pr-analyze.test.ts --testTimeout=30000` | 3 files, 54 tests passed |
| From `packages/cli`: `./node_modules/.bin/vitest run src/server/web-pr-cache.test.ts --pool=forks --maxWorkers=1` | 1 file, 9 tests passed |
| `pnpm --filter @meridian/cli exec vitest run src/server/web-pr-analyze.test.ts` | 1 file, 41 tests passed in 1.07 s |
| `pnpm --filter @meridian/cli exec vitest run src/server/web-server.test.ts` | 1 file, 27 tests passed in 4.26 s with localhost sandbox escalation |
| `pnpm --filter @meridian/cli exec vitest run --exclude src/server/folder-dialog.test.ts --testTimeout=30000` | 67 files, 652 passed and 3 skipped |
| `pnpm --filter @meridian/cli exec vitest run src/server/folder-dialog.test.ts --testTimeout=30000` | 1 file, 5 tests passed |
| Focused incremental policy/worker/cache suites | 4 files, 31 tests passed |
| `pnpm --filter @meridian/core test` | 23 files, 204 tests passed |
| `pnpm --filter @meridian/extractor-typescript test` | 35 files, 280 tests passed |
| `pnpm --filter @meridian/extractor-python test` | 9 files, 54 tests passed |
| `pnpm --filter @meridian/cli typecheck` | Passed |
| Focused renderer boot/navigation/PR suites | 7 files, 139 tests passed |
| `pnpm --filter @meridian/renderer typecheck` | Passed |
| `pnpm --filter @meridian/renderer test` | 234 files, 2,108 tests passed |
| `pnpm --filter @meridian/cli exec vitest run --config vitest.e2e.config.ts e2e/pr-review-progress-layout.e2e.ts` | 1 file, 2 headless-browser geometry tests passed; short, pictured, maximum unbroken, and reused states retained the same reserved geometry with no horizontal overflow |
| `pnpm typecheck` | All 6 workspace packages passed |
| `pnpm build` | All package builds and renderer copy passed; existing renderer large-chunk warning remains |
| `git diff --check` | Passed |

Sandboxed CLI/E2E attempts could not bind loopback listeners (`EPERM`). Running the complete CLI
suite and focused browser suite with localhost permission produced the passing results above; the
sandbox failures were environmental, not assertion failures.

The first full TypeScript run had one process-sharing fixture exceed its former 20-second
per-test timeout under suite contention (24.6 seconds). The exact test passed alone in 7.2 seconds
and the complete retry passed; its fixture timeout is now 30 seconds. No product timeout changed.

Focused coverage includes direct preparation, selected-HEAD movement rejection, live ref
revalidation, exact-ID boot HEAD/index reuse with no second HEAD artifact/metadata fetch, moved-ID
replacement, sibling merge-base reuse, refresh bypass, corruption fallback, subdirectory
separation, stage streaming, landing-page routing without `/api/generate`, and cancellation of an
accepted Back navigation during initial review restoration.

## Runtime results

Environment: macOS arm64, Node 26.2.0, persistent server
`meridian-app-99f9` on `127.0.0.1:4187`. The run used a unique empty
`MERIDIAN_CACHE_DIR`. An already-open browser tab briefly initiated the old landing implementation
and was closed; before the measured run, both `pr-artifacts` and `pr-revision-artifacts` contained
zero files. The Git mirror and unrelated generic artifact cache were warm, so this is a cold PR
pair/revision extraction, not a cold network clone.

The live fixtures were open PRs in `RazvanRotaru/meridian`:

- #205 HEAD `47cf143c629d2290ae041ea202b8a63c66a13e0d`;
- #206 HEAD `324331c3e5558501e7e04082d9800ce63c4ac2f1`;
- live base `49724ad3a8b1ba61e67685d28542c70d021b3134`;
- shared merge-base `e7de9a78c9436d36c8ae86a57eb291d66d71b9bb`.

| Scenario | Observed result |
|---|---|
| #205 cold PR pair | HEAD extraction visible by 2.6 s; merge-base extraction visible by 26.9 s; pair snapshot published at approximately 35.2 s; complete review visible by 43.9 s. |
| #205 exact-pair warm request | `done` only, `cache:"hit"`, 0.738 s. |
| #205 renderer-style live revalidation | `done` only, `cache:"hit"`, 0.651 s; returned the exact boot HEAD graph ID. |
| #206 sibling pair | HEAD extraction visible by 4.7 s; stage-aware renderer showed “Resolving exact PR revisions…” at 19.0 s; pair snapshot published at approximately 19.4 s; complete review visible by 25.3 s. |
| #206 exact-pair warm request | `done` only, `cache:"hit"`, 0.676 s. |
| Moving-ref race | Covered by selected-HEAD rejection, same-ID reuse, and changed-ID replacement tests; no live PR was mutated. |

The sibling end-to-end time was about 42% lower than the first pair. The important correctness
evidence is the cache metadata, not the timing: exactly two pair snapshots were published, both
named the same exact merge-base and both contained the identical complete
`comparisonStorage.reference`:

```text
inputDigest    67bac78276ef3b9e0970e57d032dd66b3d800d28d3f3557d2b5b3fe5a0ea001c
artifactDigest a4bc9aa02a9484195514a1d5d53dac5a9a99f3487216ae217932bd882e25ec7c
snapshotId     e791263931862539
artifactBytes  34,170,927
```

The canonical object's persisted input had `changedSince:null`, no hints,
`reviewFingerprints.mode:"all"`, the build/runtime fingerprint, and the current process nonce.
There was one canonical merge-base object, not one copy per PR. Both staging roots were empty after
the run.

Disk use after both PRs was 63,668 KiB for pair snapshots, 33,424 KiB for the one canonical
revision store, and 84,568 KiB for the isolated Git repository store. The two PR cache areas
together used 97,092 KiB (94.8 MiB). Server RSS was 94,896 KiB before the run and 192,528 KiB after
both reviews; this is a post-run observation, not a sampled peak.

The browser run visibly used the new PR-specific landing stages, then the renderer's exact-revision
stage instead of “Loading blueprint…”. PR #205's tab was closed before opening #206, so the browser
did not retain both complete review graphs concurrently. The server shared the file-backed
canonical object by immutable reference.

## Representative Autopilot benchmark

The smaller Meridian fixtures overstated how warm a sibling review feels. A second run used the
same persistent process and already-populated Git mirror for `UiPath/Autopilot`, then prepared three
open PRs whose **live Git merge-base** was the same exact commit
`e12ba3a32c99dc11d05204e850ab3882b8fad393`. This is the common post-clone user case: network clone
and object fetches are warm, but each new PR HEAD is a new semantic revision.

Command shape:

```text
node packages/cli/scripts/benchmark-pr-prepare.mjs \
  --url http://127.0.0.1:4187 \
  --repository UiPath/Autopilot \
  --pr <number> --base main --head <ref> --head-sha <exact SHA>
```

| Scenario | Changed files | HEAD work | Merge-base work | End-to-end |
|---|---:|---:|---:|---:|
| PR #4466, first pair in this process | 1 | 179.1 s | 179.0 s extraction | 363.0 s |
| PR #4466, exact repeat | 1 | verified pair hit | verified pair hit | 1.04 s |
| PR #4480, sibling pair | 4 | 179.0 s | verified revision reuse | 183.6 s |
| PR #4307, sibling pair | 57 | 187.6 s | verified revision reuse | 192.6 s |

The final rebuilt app was rerun against the then-current live PR revisions. PR #4466 used HEAD
`23f36d7f30ad6ef0ea79cd35fe2bd29c3df3a487` and exact merge-base
`e12ba3a32c99dc11d05204e850ab3882b8fad393`. PR #4480 had moved since its earlier selection, so the
server first rejected stale selected HEAD `624369…` in 0.957 seconds, then accepted refreshed HEAD
`5addfa98a058459dfcbf457fd2eb7717977b86d3`.

| Final-source scenario | Progress evidence | Reuse evidence | End-to-end |
|---|---|---|---:|
| PR #4466, cold pair | First real source file at 6.1 s; 395 bounded events | Both exact revisions extracted | 353.7 s |
| PR #4466, exact repeat | One terminal event | Verified exact-pair hit | 1.07 s |
| PR #4480, refreshed sibling pair | 198 bounded events | Exact merge-base reused; only the new HEAD extracted | 177.4 s |

The final sibling run was almost exactly half the cold pair. It demonstrates the intended
post-clone benefit while also confirming the remaining limitation: a distinct PR HEAD is still a
whole-repository extraction even when only a few files changed.

The sibling cache is working: #4480 and #4307 did not extract the 353,282,541-byte merge-base
artifact again. The remaining latency is also real: every distinct HEAD still performs whole-repo
extraction, regardless of whether Git reports 1, 4, or 57 changed files. This is why “warm” needs
three explicit meanings:

1. **Git-mirror warm** avoids a network clone but does not reuse semantic extraction.
2. **Sibling warm** reuses only an identical, verified merge-base and is roughly twice as fast as
   the first pair on this cohort.
3. **Exact-pair warm** reuses both immutable artifacts and is approximately one second.

The three Autopilot reviews that motivated this follow-up were not sibling-cache hits at all. Their
persisted pairs named three different merge bases (`7417dbf…`, `5820337…`, and `29c8ff7…`) for
HEADs `516b1de…`, `061eec4…`, and `d88ef6…`. Only the Git mirror was warm, so each pair still needed
two repository-wide graphs. Their workspace-to-snapshot intervals were approximately 367–386
seconds; the third also began while another analysis owned the single memory-heavy worker, adding
queue time before useful extraction. A shared target branch is therefore not a reuse proof: the
exact live merge-base OID must match.

The largest sampled analysis-worker RSS in the final runs was 6,901,744 KiB (about 6.58 GiB), during
the #4480 sibling run; the #4466 cold run was sampled at about 6.14 GiB. These are periodic samples,
not instrumented exact peaks. The #4466 HEAD artifact was 337,298,359 bytes (321.7 MiB), with 59,346
nodes and 229,127 edges; both sides reported 6,842 source files. These numbers make concurrent
first-time PR requests especially expensive: the current memory-heavy worker serializes analysis,
so a later request can spend minutes waiting without doing file work of its own.

### Live long-unit and moving-base follow-up

Autopilot PR #4472 was then rebuilt against exact HEAD
`91ad7ee0cd1d954e4f278354efb2240ea206834d`, selected base tip
`b339f389c0ab13dc1ab8292dab51e64e1bc21b45`, and exact merge-base
`9569676c8c7bd5d3573773113643fdf2c5fd9270`. The cold pair completed in 489.9 seconds:
the HEAD lane spent about 233.6 seconds in extraction and the comparison lane about 250.8 seconds.
The two disposable workers produced 741 bounded progress observations. The final graph contained
59,789 nodes and 229,587 edges; the HEAD artifact was 338,664,575 bytes and the comparison artifact
352,618,707 bytes. The pair cache occupied 341,652 KiB. The shared revision-object store occupied
2,789,656 KiB in total, but that directory also contained earlier benchmark revisions, so it is a
retained-store observation rather than this pair's incremental disk cost.

The formerly opaque `src/aria/app` relationship unit visibly advanced through individual files in
calls/types, imports, value references, Promise discovery, Promise linking, logic flows, ports, and
exports. Periodic process samples showed active CPU rather than a deadlock: approximately 103% CPU
and 5.0 GiB RSS during one large-unit sample, later reaching about 6.17 GiB RSS while still
runnable. This run is not a controlled speed comparison with the earlier cohort: it used different
live revisions and system load. It proves progress visibility and continued execution, not a
material end-to-end extractor speedup.

The immediate repeat also reproduced the warm-path bug that exact-pair timing alone concealed.
During the cold run, live `main` moved from `b339f389…` to
`6daea0ca1a57d8fdb1388f7cbb72d3c149f3c027`, while the selected HEAD and resolved merge-base stayed
unchanged. Because pair identity correctly includes the live base tip, the repeat missed the old
pair and began extracting the identical HEAD again; it was cancelled after about 25 seconds and
the disposable worker exited cleanly.

The populated-HEAD revision cache now covers exactly that case. It resolves and validates the new
pair workspace first, then probes the HEAD identity bound to the exact HEAD, exact merge-base,
branch, repository/subdirectory, runtime/provenance, policy, and changed-file fingerprint mode.
When both role-specific revision objects verify, it publishes the new base-tip-sensitive pair
snapshot without entering analysis admission. Focused tests prove moving-base reuse, plus
conservative misses for a changed merge-base, changed HEAD ref, changed subdirectory/runtime,
refresh, corruption, and empty-side hints. The new path is test-proven but was not re-seeded with
another eight-minute live run after the final process restart.

The post-navigation lane was profiled independently for the same pair:

| Artifact | Loopback transfer (3 runs) | Read | JSON parse | Index | Standalone max RSS |
|---|---:|---:|---:|---:|---:|
| HEAD, 321.7 MiB | 130.0–165.8 ms | 25.5 ms | 610.1 ms | 152.1 ms | 1.63 GiB |
| Merge base, 336.9 MiB | 139.6–171.0 ms | 27.3 ms | 626.0 ms | 145.4 ms | 1.68 GiB |

Uncontended transfer, decode, and indexing for both graphs total about 1.9 seconds, not minutes.
The multi-minute “Loading blueprint…” interval was therefore hiding extraction or queueing.
Renderer memory remains a secondary performance risk: the in-app path can retain its boot graph
while decoding HEAD and merge-base graphs concurrently. The review projection also rebuilt an
already-available merge-base index; the POC now passes the prepared immutable index through instead,
removing that duplicate map allocation. Persistent HTTP caching remains intentionally out of scope
until private-code retention has an explicit security policy.

Progress now travels through the extractor and worker as presentation-only telemetry. Each detailed
event identifies the exact 40- or 64-character revision OID, whether it is HEAD or merge-base, its
position in the two-commit execution, and real language work. TypeScript reports package/unit
position plus source-file position within the actually loaded project. Python separately reports
all discovered files while parsing and all successfully parsed files while building structure, so
a syntax-error file is never presented as structurally analyzed. TypeScript cannot truthfully know
a repository-wide compiler file total before loading every project, so the UI says
“unit X/Y, file A/B” rather than presenting a fabricated global counter. Phase labels remain visible
beside file counts, and relationship, stitch, and finalize phases are guaranteed per language after
the last file so “last file” cannot be mistaken for “graph ready”. IPC sampling, event counts, UTF-8
path sizes, Python stdout, and diagnostic tails are bounded. Synchronous throws and rejected async
progress observers cannot affect extraction output.

The TypeScript relationship phase is divided into activity-level markers for calls and types,
imports, optional value references, Promise discovery and linking, logic flows, ports, and exports.
Their file counters describe the primary traversal that emits observations, not every internal
traversal: Promise-link preparation and port classification still contain repository scans and
correlation work for which the POC cannot identify a single current file without changing those
algorithms. During that work the displayed path is therefore the most recently observed primary
file, and reaching `file N/N` is not a completion signal; later activity transitions and the
terminal stitch/finalize transitions remain the completion oracle. Exports are reported only by the
per-package pipeline, and Promise linking appears only when Promise resources exist. Ordinary file
observations are sampled at one hertz to keep the text readable and IPC bounded; activity
transitions and terminal phases use separate reserved capacity, so a workspace with many small
units cannot crowd out `stitch` or `finalize`. Observer-free extraction does not construct these
callbacks or progress objects. Progress remains outside graph bytes and every cache identity.

A final browser check selected Autopilot PR #4466 from the Git integration page. Before redirect it
rendered the canonical five-step progress model and both revision lanes; renderer boot then
continued with the same labels and states while loading the already-prepared pair. Clicking
“Review in graph” from the in-app PR tab rendered that same five-step model, the same HEAD and
merge-base lanes, and the same resolving status. The exact-pair hit completed in under a second;
the UI then conservatively reported that #4466's one YAML-only change had no matching graph nodes
instead of presenting an empty review as actionable.

A later post-change browser attempt could open the landing surface but could not enumerate PRs
because that browser session's GitHub API request was refused for rate-limit or scope reasons.
Consequently, the new `reuse-head` transition and the final activity labels are covered by shared
model/component/landing tests and live NDJSON benchmark output, but were not exercised through a
second browser-selected PR after the final rebuild.

### Revision-shard follow-up

The revision-safe TypeScript POC is now connected behind the server-owned
`--typescript-incremental empty|shadow|verified-experimental` option; it remains disabled by
default. The client cannot choose the cache directory, tree, build/runtime fingerprint, or policy.
Shadow mode compares against the same pipeline with a new empty cache and serves the cold result.
No production cache admission or default serving behavior changed.

On the exact PR #4472 revisions above, the final schema-v6 controlled runs produced:

| Scenario | Total | Unit reuse | Source-byte reuse | Semantic digest |
|---|---:|---:|---:|---|
| Merge base cold | 230.9 s | 0/27 | 0% | `24ef0007…` |
| Merge base warm, new process | 48.8 s | 27/27 | 100% | `24ef0007…` |
| HEAD using the warm base cache | 203.2 s | 25/28 | 21.8% | `cbe4625e…` |
| HEAD isolated empty-cache oracle | 283.2 s | 0/28 | 0% | `cbe4625e…` |
| HEAD warm, new process | 64.0 s | 28/28 | 100% | `cbe4625e…` |

The cross-revision run and isolated oracle also produced the same manifest address and the same 28
unit shard keys. The three rebuilt units were the changed 4,528-file app, the iframe package whose
compiler program observed changed app inputs, and the newly admitted delegate-web package. The
other 25 existing units reused immutable merge-base contributions.

This improves first-time HEAD extraction by 28.3% for this PR and repeat HEAD extraction by 77.4%.
It does not make the first review instant: the changed app alone contains about 74% of selected
source bytes. The next performance boundary is a smaller compiler-derived semantic unit inside
that package, plus a hit path that proves inputs without constructing the full TypeScript Project.
The complete model, parity matrix, disk/RSS measurements, risks, and production sequence are in
`docs/revision-safe-incremental-extraction-poc.md`.

## Recommendation

- **Proceed** with direct selected-PR preparation, exact-ID boot HEAD/index reuse, stage-aware
  progress, PR-identity-safe Back/Forward resets, and strict process-local populated-HEAD reuse
  after an unchanged exact merge-base is proven.
- **Revise before production** for the whole-revision cache. Keep it process-scoped and
  experimental until cache retention/GC, cross-pair miss singleflight, full external-runtime
  provenance, and broader controlled concurrency/restart benchmarks are complete.
- Keep the cold extractor as the semantic oracle. The runtime run proves exact byte-reference reuse
  for these two revisions; it does not prove arbitrary environment soundness or replace the
  differential/shadow requirements in the incremental-extraction POC.
