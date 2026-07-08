# Selection-scoped Expand all / Collapse all

## Problem

Expand/collapse-all is scattered across three touchpoints with inconsistent scope:

1. **Top-left Toolbar** — a lone **Collapse all** that hard-resets the whole surface (and is a
   no-op in the Logic view, whose expansion lives in a different set).
2. **Floating level breadcrumb** (Map) — **Expand all / Collapse all** acting on the current
   zoom level only.
3. **Per-frame chrome** — each expanded card's own one-level Expand/Collapse.

There is no single, predictable "expand/collapse what I'm looking at" control.

## Goal

One **Expand all / Collapse all** pair in the top-left toolbar that operates on the **current
selection**, or — when nothing is selected — on the **root container** (the current view's
frontier/focus). One containment level per click, symmetric (collapse reverses expand click by
click). Works across every view that has a containment/expansion notion.

Decisions confirmed with the user:
- **Depth:** Expand reveals one level per click.
- **Home:** the top-left toolbar. Remove the redundant breadcrumb pair and the old lone button.
- **Scope:** all views (Map/modules, Service/call, UI call-flow, Logic-flow).

Self-made calls (noted for review):
- **Expand is one-level-per-click; Collapse is a full collapse of the scope** (closes every open
  container in scope in one click). A one-level "peel" was the first attempt, but the "deepest open
  level" logic assumed a plain expanded set and broke on the two surfaces whose open-ness isn't a
  plain set: the service lens's **always-open unit cards** (a frame could never be re-collapsed) and
  the Logic graph's **XOR-from-default set** (collapse left stale overrides, so expand/collapse
  didn't round-trip). Full collapse is robust on every surface, matches the "Collapse all" label,
  and is the common tree-UI pairing (expand incrementally, collapse-all resets).
- **Per-frame chrome buttons stay** — they are an in-context, per-frame affordance, complementary
  to the top control, and out of scope for this rethink.

## Design

### Pure core: `derive/scopedExpansion.ts`

Surface-agnostic. Operates on a normalized visible-node list and a scope, returns the node ids to
open/close — never touches store state.

```ts
interface ExpandableNode { id: string; parentId: string | null; isContainer: boolean; isExpanded: boolean }

// scope: a list of node ids to scope to, or [null] meaning "the whole current view (root container)".
idsToExpand(nodes: ExpandableNode[], scope: (string | null)[]): string[]
idsToCollapse(nodes: ExpandableNode[], scope: (string | null)[]): string[]
```

- **In-scope set:** for `[null]`, every visible node. For a real id N, N plus its visible
  descendants (walked via `parentId`).
- **idsToExpand:** in-scope nodes that are `isContainer && !isExpanded` — reveal the next level.
  A collapsed selected card has no visible children, so it returns just the card itself; the next
  click descends. Cascades one level per click.
- **idsToCollapse:** in-scope nodes that are `isContainer && isExpanded` — **every** open container
  in scope, closed in one click. No ancestor/"deepest" reasoning (which mis-modelled always-open and
  XOR surfaces), so it is correct regardless of how a surface backs its open-ness.

### Store: `expandAll()` / `collapseAll()` (surface-aware)

Both dispatch by `viewMode`. Each surface normalizes its own visible nodes into `ExpandableNode`,
picks the scope from its own selection state, computes ids, applies to its own expansion set:

| viewMode         | visible nodes                     | selection → scope        | expansion set   | apply             |
|------------------|-----------------------------------|--------------------------|-----------------|-------------------|
| `modules`/`call` | `deriveModuleTree`/`ServiceTree`  | `moduleSelected` or [null] | `moduleExpanded`| set union / minus |
| `ui`             | `computeVisible(expanded, focus)` | `selectedId` or [null]   | `expanded`      | set union / minus |
| `logic`          | `logicRfNodes` data               | [null] (no container sel)| `expandedLogic` | XOR-toggle ids    |
| `prs`            | —                                 | —                        | —               | no-op             |

`expandedLogic` is an XOR-from-default set, so the Logic surface *toggles* the returned ids rather
than adding/removing. The Map/UI surfaces use a plain expanded set (add to expand, remove to
collapse).

Each action skips its relayout when the computed id set is empty (harmless no-op click).

### Components

- **Toolbar.tsx** — replace the lone `Collapse all` with an `Expand all` + `Collapse all` pair in
  the title row, wired to the two store actions. Rendered for every non-`prs` view.
- **ModuleMapChrome.tsx / ModuleMapView.tsx** — drop the breadcrumb's `onExpandAll`/`onCollapseAll`
  buttons, props, and the now-unused `hasExpansions` computation. The breadcrumb keeps only the
  zoom trail.

## Testing

- `scopedExpansion.test.ts` — pure: expand cascades one level per call; collapse closes every open
  container in scope (incl. an always-open child alongside its set-backed parent frame); scoping to
  a selected id confines both; multi-select unions.
- Store test — `expandAll`/`collapseAll` dispatch correctly on `modules`, `ui`, and `logic`
  (incl. the multi-level XOR full-collapse), honoring selection vs. root scope.
- e2e visual smoke via Playbook (view a fixture, click the toolbar buttons, screenshot).
