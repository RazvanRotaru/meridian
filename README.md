# meridian

**Turn any codebase into a live, navigable map of how it flows** — like Unreal Engine's
Blueprints editor, but for real code. Point it at a repo and it draws the system as boxes and
wires you can drill into: system → module → class → function. The map is generated straight
from the source, so it can't rot.

`meridian` is a CLI + a dark-mode web renderer. It **generates** a versioned graph artifact
from source and **views** it as an interactive blueprint — with a "black box" dive-in, a
call-flow ↔ UI-composition lens, and an optional live-telemetry overlay.

> 📊 **[Visual explainer → `docs/how-it-works.html`](docs/how-it-works.html)** (diagrams, ~no text) ·
> ▶ **[20-second tour](docs/media/meridian-tour.webm)**

## Quickstart

```bash
pnpm install && pnpm build

# The web way — paste a repo, see its graph (self-hosted; nothing is uploaded)
node packages/cli/dist/bin.js web sindresorhus/ky        # any GitHub owner/repo, URL, or local path

# The CLI way — generate an artifact, then view it
node packages/cli/dist/bin.js generate ./my-service -o graph.json    # auto-detects TypeScript or Python
node packages/cli/dist/bin.js view graph.json --overlay mock --env staging
```

Private repos: set `GITHUB_TOKEN` (or paste a token into the local-only field). It stays on your
machine and is never uploaded, logged, or stored.

## Gallery

Captured headless on the `shopfront` fixture (a deliberately-tangled TS + React app) and the
small examples.

**Call flow + live telemetry** — the whole system with a mock overlay painted on. Red high-error
wires converge on the `Utils` god-module (fan-in made visible):

![Call flow with telemetry overlay](docs/media/01-callflow-telemetry.png)

**Dive-in "black box"** — double-click a box to re-root the canvas *into* it; here, focused into
the tangled `services` layer (breadcrumb `System › Src › Services`), everything else hidden:

![Dive-in focused into the services layer](docs/media/02-divein.png)

**UI-composition view** — the same graph as the React render tree (`renders` edges), one lens away:

![UI composition render tree](docs/media/03-ui-composition.png)

**Boundary edges** — `--include-external` surfaces library/builtin calls as dim/dashed wires into
an `External` group (honest about what static analysis can't resolve):

![External boundary edges](docs/media/04-boundary-edges.png)

**Language-agnostic** — the identical renderer on a Python service (`py:` node ids, docstring
summaries):

![Python blueprint](docs/media/05-python.png)

**`meridian web`** — paste a GitHub repo (or a local path); it clones + extracts + renders in your
browser. Nothing uploaded; private repos use a local token:

![The meridian web front door](docs/media/06-web-landing.png)

## How it works

Three layers, joined by one stable key — the language-agnostic **node id**
(`<lang>:<modulePath>#<qualname>`, the generalized `__qualname__`). The same id is the React Flow
node id **and** the telemetry join key, so structure and runtime data never desync.

1. **Structure (`meridian generate`).** A pluggable `LanguageExtractor` turns a source tree into a
   versioned graph-JSON artifact: nodes (package → module → class → function) with human display
   names and one-line summaries from doc comments, plus edges (calls, instantiates, extends,
   renders). **TypeScript/TSX** (via `ts-morph`) and **Python** (via the stdlib `ast`) ship today,
   auto-detected; new languages slot in as additional extractors against the same contract. The
   artifact *is* the code — re-generate it and it stays in sync.
2. **Renderer (`meridian view` / `web`).** A dark-mode SPA (React + `@xyflow/react` + `elkjs`):
   compound nodes with custom expand/collapse, auto-layout that routes edges across nested groups,
   typed pins, and progressive disclosure from the system level down. **Dive-in ("black box"):**
   double-click a box to re-root the canvas *into* it, with a breadcrumb to climb out — so a huge
   graph stays readable one box at a time. **View modes:** Call-flow ↔ UI-composition — the same
   graph as either the call graph or, for React, the component render tree.
3. **Telemetry overlay (pluggable).** Paint runtime metrics — call count, latency percentiles, error
   rate — joined by node id. A deterministic **mock** provider ships today; a real Tempo/OTel
   provider drops into the same contract with zero re-keying. The environment selector is
   **mandatory** and never defaults to prod.

The contract is specified in
[`knowledge/adr/0001-graph-artifact-schema.md`](knowledge/adr/0001-graph-artifact-schema.md) and
published as JSON Schema at
[`packages/core/schema/graph-artifact-1.0.0.json`](packages/core/schema/graph-artifact-1.0.0.json).

## CLI

| Command | What it does |
| --- | --- |
| `meridian generate [path]` | Extract a codebase into a graph artifact. `--lang` (auto: `typescript` \| `python`), `-o`, `--depth package\|module\|class\|function`, `--include-external`, `--include`, `--exclude`, `--tsconfig`. Solution-style tsconfigs (`"files": []` + references) fall back to a pruned glob scan, so monorepo roots extract too. |
| `meridian change [graph]` | Mint a **change-lens overlay** (`change/1.0`) from a git range: `--repo <dir>`, `--range A..B`, `--prefix` (path from the repo root to the extracted target), `-o`. Joins `git diff` hunks onto node source spans — modules carry whole-file totals, functions/classes light up only when a hunk intersects their span. |
| `meridian view [graph]` | Serve the renderer on a graph + open the browser. `--port`, `--host`, `--no-open`, `--overlay <file\|mock>`, `--env`, `--change <file>` (adds `/api/change` + `/api/file-diff`). |
| `meridian web [source]` | Local web UI: paste a **GitHub repo** (`owner/repo` or URL) / local path — clones (`--depth 1`) + extracts + renders. Private repos via `GITHUB_TOKEN`/`GH_TOKEN` or a local-only token field. `--port`, `--host`, `--no-open`. |
| `meridian mock-telemetry [graph]` | Mint a deterministic mock overlay. **`--env` is required** (no default, never prod); `-o`, `--seed`. |

### The change lens — review a PR on the map

```bash
meridian generate ./repo/apps/web -o graph.json
meridian change graph.json --repo ./repo --prefix apps/web --range main..HEAD -o change.json
meridian view graph.json --change change.json
```

The range is painted onto the blueprint: **± pills** on every touched box (containers roll up
their files' totals), **red dotted hot wires** where both endpoints changed, a **RANGE row** in
the toolbar, and a **diff drawer** (bottom) streaming the real unified diff of the selected
node, scroll-anchored at its source span. `j` / `k` walk every changed symbol in file order —
the map auto-expands and re-selects as you step, so reviewing a PR becomes a lap across the
codebase instead of a scroll through a flat file list.

### Reading & navigating the canvas

- **Click** a box: select it and trace its path — **direct neighbours** by default, **full
  impact** (transitive closure) one toggle away in the detail panel. Downstream wires teal,
  upstream violet; everything off-path dims.
- **Double-click** a container: dive in (the breadcrumb climbs back out). The **chevron**
  expands in place; clicking a connection row in the detail panel walks the selection.
- **Wire language:** `calls` solid steel · `instantiates` amber dots · `extends`/`implements`
  purple dashes · `renders` cyan · unresolved stays dim + dashed · **hot** (change at both
  ends) red dots.
- **Comments:** node-anchored review notes in the detail panel (localStorage per target);
  💬 open-counts roll up onto collapsed containers.

## Packages

```
packages/
  core/                  @meridian/core — the contract: zod schema (source of truth) + TS types
                         + node-id grammar + validateArtifact + overlay types + the
                         LanguageExtractor interface. (@meridian/core/mock = node-only mock overlay.)
  extractor-typescript/  @meridian/extractor-typescript — the ts-morph TS/TSX adapter (incl. JSX renders).
  extractor-python/      @meridian/extractor-python — a stdlib-ast analyzer + adapter.
  cli/                   @meridian/cli — the `meridian` binary (generate / view / web / mock-telemetry).
  renderer/              @meridian/renderer — the dark Unreal-Blueprints SPA.
examples/
  orders-service/        a small readable TypeScript fixture.
  orders-service-py/     the same service in Python — proves the extractor seam is language-agnostic.
  shopfront/             a bigger, deliberately-tangled TS + React app — the scale / UI stress test.
```

## Develop

```bash
pnpm install
pnpm build                # build every package (tsup libs + the Vite renderer)
pnpm test                 # unit + golden suites (~100 tests)
pnpm typecheck

# End-to-end (generate → view → headless Chromium). Install the browser once:
npx playwright install chromium
pnpm e2e
```

**Troubleshooting — `esbuild … EACCES` on build:** pnpm 10 skips dependency install scripts by
default (you'll see *"Ignored build scripts: esbuild"*). If a build fails with an esbuild permission
error, run `pnpm approve-builds` (select esbuild) or:
```bash
find node_modules/.pnpm -path '*@esbuild*/bin/esbuild' -exec chmod +x {} \;
```

> **React note:** function components + JSX composition become `renders` edges (UI-composition mode).
> Class-component JSX is currently sourced from the `render()` method rather than the class — a known
> limitation while function components are the norm.

## Why build this

Adversarially-verified research found **no off-the-shelf competitor**: every trace-derived
"application map" (Grafana/Tempo service graph, SigNoz, Azure App Insights) stops at
service-to-service granularity — module/function level is unserved. The closest UX match (CodeViz)
is cloud-only SaaS. AppMap (MIT + Commons Clause) is the closest prior art for "code map with runtime
data" — its `.appmap.json` taxonomy informed our schema (see ADR 0001), but it's an execution
recorder, not an artifact a static extractor and an OTel trace store both feed, so we don't embed it.

## Org rules that apply here

- Dark mode for all rendered artifacts; no white/light gradients.
- **Never default to prod:** the telemetry env selector is mandatory with no fallback. The rule is
  encoded in the data — `service.name` / `deployment.environment.name` never appear in an artifact.
