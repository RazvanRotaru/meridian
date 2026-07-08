/**
 * Pure placement for the minimal-graph overlay — it MIRRORS the Module map instead of running a fresh
 * layout. Every file the map had on screen keeps its exact absolute map position (captured at build);
 * files that weren't on the map (off-level neighbours, later expansions) and the [+n] stubs are placed
 * RELATIVE to an already-placed, import-connected node, so nothing already placed ever jumps. Flat: no
 * package frames, no parentId — just absolute rects. Deterministic (id-sorted, no clock/random).
 */

export interface PlacedRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type StubDirection = "in" | "out";

export interface PlacementStub {
  id: string;
  sourceId: string;
  direction: StubDirection;
}

export interface PlacementInput {
  fileIds: string[];
  stubs: PlacementStub[];
  /** Directed file→file import edges (source imports target). */
  importEdges: { source: string; target: string }[];
  /** Absolute map positions captured at build, keyed by file id. */
  basePositions: Record<string, PlacedRect>;
}

export const FILE_WIDTH = 210;
export const FILE_HEIGHT = 54;
export const STUB_WIDTH = 48;
export const STUB_HEIGHT = 30;
export const GAP_X = 220;
export const GAP_Y = 70;
/** Modest offset so [+n] stubs still hug their source card, independent of the wide inter-column GAP_X. */
export const STUB_GAP = 40;

const V_STEP = FILE_HEIGHT + GAP_Y;

/** Place every file + stub to an absolute rect: captured files at their map spot, the rest relative. */
export function placeMinimalNodes(input: PlacementInput): Record<string, PlacedRect> {
  const placed = new Map<string, PlacedRect>();
  placeCapturedFiles(input, placed);
  placeConnectedFiles(input, placed);
  placeDisconnectedFiles(input, placed);
  const result: Record<string, PlacedRect> = Object.fromEntries(placed);
  placeStubs(input.stubs, placed, result);
  return result;
}

/** Step A — a file with a captured map position lands exactly there, at its captured size. */
function placeCapturedFiles(input: PlacementInput, placed: Map<string, PlacedRect>): void {
  for (const id of input.fileIds) {
    const base = input.basePositions[id];
    if (base) {
      placed.set(id, { ...base });
    }
  }
}

/** Step B — grow the placed set: any unplaced file with placed import-neighbours lands flow-aware
 * against ALL of them — left of its leftmost importee if it imports any, else right of its rightmost
 * importer — at the nearest free vertical slot. Repeat until a full pass places nothing (the
 * connected frontier is exhausted). */
function placeConnectedFiles(input: PlacementInput, placed: Map<string, PlacedRect>): void {
  const { out, in: inbound } = adjacency(input.importEdges);
  const ordered = [...input.fileIds].sort();
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const id of ordered) {
      if (placed.has(id)) {
        continue;
      }
      const target = placementTarget(id, out, inbound, placed);
      if (!target) {
        continue;
      }
      placed.set(id, placeAt(target.x, target.refY, placed));
      progressed = true;
    }
  }
}

/** Step B tail — files with no placed import-neighbour go in a spare column right of the bounding box. */
function placeDisconnectedFiles(input: PlacementInput, placed: Map<string, PlacedRect>): void {
  const remaining = input.fileIds.filter((id) => !placed.has(id)).sort();
  if (remaining.length === 0) {
    return;
  }
  const box = boundingBox(placed);
  const x = box.maxX + GAP_X;
  let y = box.minY;
  for (const id of remaining) {
    placed.set(id, { x, y, width: FILE_WIDTH, height: FILE_HEIGHT });
    y += V_STEP;
  }
}

/** Step C — each stub sits beside its source: in→left, out→right, vertically centred on the source. */
function placeStubs(stubs: readonly PlacementStub[], placed: Map<string, PlacedRect>, result: Record<string, PlacedRect>): void {
  for (const stub of stubs) {
    const source = placed.get(stub.sourceId);
    if (!source) {
      continue; // a stub whose source never got placed has nowhere to hang.
    }
    const x = stub.direction === "in" ? source.x - STUB_WIDTH - STUB_GAP : source.x + source.width + STUB_GAP;
    const y = source.y + source.height / 2 - STUB_HEIGHT / 2;
    result[stub.id] = { x, y, width: STUB_WIDTH, height: STUB_HEIGHT };
  }
}

interface Adjacency {
  out: Map<string, Set<string>>;
  in: Map<string, Set<string>>;
}

function adjacency(edges: readonly { source: string; target: string }[]): Adjacency {
  const out = new Map<string, Set<string>>();
  const inbound = new Map<string, Set<string>>();
  for (const { source, target } of edges) {
    addEdge(out, source, target);
    addEdge(inbound, target, source);
  }
  return { out, in: inbound };
}

function addEdge(map: Map<string, Set<string>>, key: string, value: string): void {
  const set = map.get(key) ?? new Set<string>();
  set.add(value);
  map.set(key, set);
}

/** The target column x + reference row y for an unplaced `id`, computed from ALL its placed
 * import-neighbours so it flows left-to-right. A file imports its importees, so it's their caller and
 * sits LEFT of the leftmost of them; failing that, it's a callee of its importers and sits RIGHT of
 * the rightmost of them. A node with both placed importees and importers prefers the importees branch
 * (left of its leftmost import) — a caller reads before what it calls. Null ⇒ no placed neighbour yet
 * (left for the disconnected-column step). Deterministic: id-sorted, x-ties broken by smallest id. */
function placementTarget(
  id: string,
  out: Map<string, Set<string>>,
  inbound: Map<string, Set<string>>,
  placed: Map<string, PlacedRect>,
): { x: number; refY: number } | null {
  const importees = [...(out.get(id) ?? [])].filter((p) => placed.has(p)); // id → p
  if (importees.length > 0) {
    const rect = placed.get(leftmost(importees, placed))!;
    return { x: rect.x - FILE_WIDTH - GAP_X, refY: rect.y };
  }
  const importers = [...(inbound.get(id) ?? [])].filter((p) => placed.has(p)); // p → id
  if (importers.length > 0) {
    const rect = placed.get(rightmost(importers, placed))!;
    return { x: rect.x + rect.width + GAP_X, refY: rect.y };
  }
  return null;
}

/** The placed id with the smallest left edge; x-ties broken by smallest id (ascending scan, replace
 * on strict `<`). */
function leftmost(ids: readonly string[], placed: Map<string, PlacedRect>): string {
  const sorted = [...ids].sort();
  let best = sorted[0];
  for (const id of sorted) {
    if (placed.get(id)!.x < placed.get(best)!.x) {
      best = id;
    }
  }
  return best;
}

/** The placed id with the largest right edge; x-ties broken by smallest id (ascending scan, replace
 * on strict `>`). */
function rightmost(ids: readonly string[], placed: Map<string, PlacedRect>): string {
  const sorted = [...ids].sort();
  let best = sorted[0];
  for (const id of sorted) {
    const rect = placed.get(id)!;
    const bestRect = placed.get(best)!;
    if (rect.x + rect.width > bestRect.x + bestRect.width) {
      best = id;
    }
  }
  return best;
}

/** A rect at the fixed column `x`, at the nearest vertical slot near `refY` that no already-placed
 * rect occupies (try level, then down, then up, alternating). */
function placeAt(x: number, refY: number, placed: Map<string, PlacedRect>): PlacedRect {
  const rects = [...placed.values()];
  for (const offset of verticalOffsets(rects.length + 4)) {
    const rect: PlacedRect = { x, y: refY + offset, width: FILE_WIDTH, height: FILE_HEIGHT };
    if (!rects.some((other) => overlaps(rect, other))) {
      return rect;
    }
  }
  return { x, y: refY, width: FILE_WIDTH, height: FILE_HEIGHT };
}

/** 0, +step, -step, +2·step, -2·step, … — level first, then stack downward, then upward. */
function verticalOffsets(count: number): number[] {
  const offsets = [0];
  for (let i = 1; i <= count; i += 1) {
    offsets.push(i * V_STEP, -i * V_STEP);
  }
  return offsets;
}

function overlaps(a: PlacedRect, b: PlacedRect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

function boundingBox(placed: Map<string, PlacedRect>): { maxX: number; minY: number } {
  let maxX = 0;
  let minY = 0;
  let seen = false;
  for (const rect of placed.values()) {
    if (!seen) {
      maxX = rect.x + rect.width;
      minY = rect.y;
      seen = true;
      continue;
    }
    maxX = Math.max(maxX, rect.x + rect.width);
    minY = Math.min(minY, rect.y);
  }
  return { maxX, minY };
}
