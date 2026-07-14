# Synthetic flow execution POC

Status: implementation POC
Scope: opt-in TypeScript projects with an explicit scenario manifest; local code and consent-gated
GitHub PR code use separate execution boundaries
Fixtures: `examples/orders-service`, `examples/shopfront`

## Product outcome

For a selected Logic flow, Meridian should be able to generate or accept one synthetic input, run
the real project code, and project the observed execution back onto the same static graph. A reviewer
should be able to answer:

1. Which callable occurrences ran, and in what causal order?
2. What bounded value entered and left each occurrence?
3. Which value transformation introduced a changed or suspicious field?
4. Which static calls and branches are only possible code context, rather than observed execution?
5. Does the PR change the output for the same scenario?

The execution result reuses the request-trace and request Logic-flow pipeline. Synthetic execution is
a separate capability from a telemetry provider: it creates trace-shaped evidence, but it is not live
observability data and is always labeled as generated.

## Execution and snapshot contract

Every runnable scenario is explicit repository configuration. It identifies the static root node, an
editable default JSON input, and a module export/factory invocation recipe. Meridian never guesses a
class constructor, dependency-injection graph, receiver, credential, or external service.

One run returns:

- a normal `RequestTrace`, whose span `nodeId` values join exactly to `GraphNode.id`;
- one bounded input/output snapshot per captured span occurrence;
- the resolved final output, warnings, and scenario/artifact identity;
- errors on the occurrence that threw, without manufacturing a successful output.

Snapshots remain separate from OpenTelemetry attributes because structured values are not valid OTel
attribute values and have different privacy and size requirements. Repeated or recursive calls keep
separate `spanId`-keyed snapshots.

## What is automatic

| Capability | POC | Direction |
| --- | --- | --- |
| Compile the selected TypeScript project | Automatic | Reuse the configured `tsconfig` |
| Instrument supported functions and methods | Automatic | Generated-output transform; source remains unchanged |
| Capture parent/child call order, duration, return, and throw | Automatic | Emit the existing request-trace model |
| Map occurrences back to graph nodes | Automatic | Exact `GraphNode.id`, never label matching |
| Generate an editable starter input | Manifest-provided | Add bounded type-checker generation for primitives/records/unions |
| Construct a method receiver and its dependencies | Explicit manifest | Later mine suitable test fixtures/factories; never silently guess |
| Execute branches/loops with path evidence | Static context in the first slice | Add generated stable site IDs and branch/loop probes |
| Install dependencies or call real infrastructure | Unsupported | Add explicit hermetic adapters/mocks, not ambient access |
| Execute a remote PR checkout | Explicit opt-in | Compile and run the exact PR HEAD in the disposable OCI boundary described below |

## Safety boundary

Code execution is disabled by default. Local and untrusted-PR execution have separate CLI flags,
per-graph trust records, endpoints, and server-side admission checks. A button in the browser is not
an authority: the server rechecks the graph source, runtime, scenario, source fingerprint, loopback
host, and (for a PR run) the explicit consent header for every request.

For trusted local code, the POC compiles the project closure and runs the emitted JavaScript in a
separate Node process with:

- read access only to the emitted temporary tree;
- no filesystem writes, network, child processes, workers, native add-ons, or inherited secrets;
- a scrubbed environment, memory limit, output cap, and wall-clock timeout;
- no capability advertisement or unrestricted fallback when the required permission controls are
  unavailable;
- a SHA-256 fingerprint over the manifest, project config, and artifact source files, captured when
  the action is advertised and checked both before compilation and immediately before child launch;
- unconditional temporary-directory cleanup.

Node permissions remain defense in depth, not a hostile-code security boundary. GitHub/PR code is
therefore never passed to that host-process path. With `--allow-synthetic-pr-execution`, Meridian
admits the exact extracted PR HEAD only when a prebuilt OCI worker and a preinstalled runtime image
are available. Each confirmed run starts a disposable container with:

- no network namespace access and no implicit image pull or dependency install;
- a read-only root filesystem and read-only mounts for the PR source and one bundled worker file;
  the bounded, schema-validated job arrives over stdin rather than another host mount;
- no host credentials, environment, `node_modules`, Docker socket, or writable workspace mount;
- a non-root user, all Linux capabilities dropped, `no-new-privileges`, and bounded CPU, memory,
  process count, file descriptors, output, and wall-clock time;
- a small `noexec`, `nosuid`, `nodev` temporary filesystem for generated output;
- force-removal on timeout and no process-only fallback.

The UI shows the repository and immutable PR HEAD SHA and requires fresh, non-persisted consent for
each run or rerun. A missing or malformed PR manifest fails closed by omitting the runnable scenario;
it does not prevent the graph or PR review from loading.

The OCI boundary protects the host; it does not make evidence emitted by adversarial application
code authoritative. PR code shares the instrumented JavaScript realm and can forge, suppress, or
distort its own trace/snapshot output. The UI therefore labels sandbox results as a forgeable
inspection aid, never as a security proof. Strong evidence integrity would require a separately
privileged observer/IPC design outside the application realm.

## PR-review experience

The action appears in the existing split Logic-flow header only when the selected root has an
advertised scenario. The reviewer can inspect/edit the JSON seed, explicitly run it, and regenerate.
The lower pane switches from possible static flow to the observed occurrence graph while retaining the
upper PR graph, its review baseline, and the adjustable split.

Each occurrence card shows compact **IN** and **OUT** (or **ERROR**) rows. Nodes start collapsed; the
existing disclosure grafts their static body and retains the distinction between the strong observed
runtime path and subdued code context. Clicking an occurrence continues to highlight the exact node in
the upper graph. Missing snapshots mean “not captured,” never `null` and never “unchanged.”

## POC limitations and next increments

- TypeScript only; constructors, generators, declaration-only callables, dynamic/eval code, and
  projects requiring undeclared runtime packages are not instrumented.
- PR execution requires a working local OCI runtime and the configured image already present. The
  POC never pulls an image or installs repository dependencies during a run.
- Invocation currently accepts one JSON input. Multiple positional arguments and fixtures should be
  made explicit in a future manifest version.
- Values are depth/width/byte capped and normalized to JSON; prototypes, functions, symbols, bigint,
  accessors, cycles, and non-finite numbers cannot cross the runner boundary.
- Automatic type-driven input generation is intentionally deferred. It should support a conservative
  subset and surface unsupported fields instead of inventing plausible-looking values.
- Comparing base and head runs is the natural PR-review follow-up: execute the same scenario twice,
  align occurrences by stable node/site identity, and show field-level output deltas.
- Production branch highlighting needs generated stable call/branch/loop site IDs. Source line fallback
  remains inspection-only because edits and same-named files can make it ambiguous.

## Acceptance criteria

- Without the CLI opt-in, no execution URL or scenario is exposed and no Generate action is rendered.
- A GitHub/PR graph additionally requires the PR-specific opt-in, OCI availability, an exact prepared
  HEAD graph, an authored scenario, and explicit per-run consent; otherwise it cannot execute.
- Selecting the fixture's `OrderService.placeOrder` flow exposes an editable deterministic order input.
- Running the scenario executes compiled fixture code and returns a schema-validated trace plus exact
  per-occurrence snapshots for validation, pricing, assembly, persistence, and notification work.
- The synthetic occurrence graph opens inside the existing split without losing PR graph curation.
- **IN**/**OUT** values visibly demonstrate the request → money → order transformation.
- Clicking a generated occurrence highlights the same exact graph node.
- Infinite loops, excessive output, permission violations, malformed manifests, and oversized payloads
  fail with bounded user-facing errors and leave no child process or temporary tree behind.
- A PR run receives no network, credentials, host package tree, writable source, or process-only
  fallback, and the prepared graph's scenario/trust capability is swapped and restored with that graph.
