# PR diff opens full-screen on the minimal-graph overlay

## Goal

When a reviewer picks a PR in the `PRs` lens, run the existing analysis (clone → checkout →
extract, with the step panel visible), and **on completion open the PR's minimal graph
full-screen by reusing the Module-map's `MinimalGraphView` overlay** — the same element that
already frames a "current selection" full-screen. The overlay's floating panel indicates the
current PR; the directly-affected logic flows sit in a docked side panel.

## Decisions (confirmed)

- **Reuse `MinimalGraphView` directly** (not a forked shell).
- **Keep the `PRs` lens list** as the selection panel; selection still runs `analyzePr` and shows
  the clone/checkout/extract step panel while running.

## Changes

### 1. `MinimalGraphView` — one additive optional prop
`override?: { nodes; edges; title; onClose }`.
- **Absent (Module map):** today's store-driven path, unchanged byte-for-byte. This is what keeps
  the parallel MinimalGraphView work safe.
- **Present (PR overlay):** render `override.nodes/edges`; the floating panel shows `override.title`
  (the current PR) and a single `✕ Close`; Reset is hidden; Escape and Close call `override.onClose`;
  the Module-map click/navigate/expand handlers are detached (read-only diff view). The hook is still
  called unconditionally (hook-order safe); only the wired handlers change.

The PR minimal graph is produced by the *same* pipeline (`derivePrMinimalGraph` → the shared
`deriveMinimalGraphLayout`), so its nodes are the same `file`/stub shape `MinimalGraphView` already
renders; the change ring rides on `node.style.outline` and survives `emphasize` (which only touches
opacity).

### 2. `PrDiffOverlay` (new, `components/prs/`)
Full-cover (`position:absolute; inset:0`) surface rendered when `prAnalyzeStatus === "ready"`.
Contains `<MinimalGraphView override=… />` plus a floating, scrollable `AffectedFlowList` panel
docked top-right beneath the PR panel. `title = "PR #<n> · <title>"`; `onClose = clearPrAnalysis`.

### 3. `PrsView` / `PrAnalysisPane`
- `PrsView` renders `<PrDiffOverlay/>` over the page on `ready`.
- `PrAnalysisPane`'s `ready` branch no longer mounts `PrMinimalCanvas` (avoids two React Flow
  canvases); it shows a small "diff open — Esc to close" note behind the overlay.

## Non-goals
- No server/analysis changes; the clone→checkout→extract flow and its progress are untouched.
- No new tests (POC scope, per PR 107). Verified end-to-end headless against a live repo.
