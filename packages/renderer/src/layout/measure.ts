/** Layout measurement primitives shared across the call-flow, logic-flow, and module-map sizing paths. */

/** Clamp `value` to the inclusive `[min, max]` range. Raw min/max — the caller rounds if it wants. */
export function clamp(min: number, max: number, value: number): number {
  return Math.min(max, Math.max(min, value));
}

// Every card renders in the mono stack (ui-monospace / SF Mono / Menlo), where each glyph's advance is
// a stable fraction of the font size — so a label's pixel width is `chars × fontSize × ADVANCE` with no
// DOM measuring. Nudged a hair above the ~0.6em real advance so a full label never kisses the ellipsis.
const MONO_ADVANCE = 0.62;

/** The rendered pixel width of `text` set in the mono stack at `fontSize`. */
export function monoTextWidth(text: string, fontSize: number): number {
  return text.length * fontSize * MONO_ADVANCE;
}

/** A pill / chip / badge box: its mono caption plus letter-spacing, symmetric horizontal padding, and a
 * 1px border each side — the total horizontal room the pill occupies in a card's header. */
export function pillWidth(text: string, fontSize: number, opts: { padX?: number; letterSpacing?: number } = {}): number {
  const padX = opts.padX ?? 4;
  const letterSpacing = opts.letterSpacing ?? 0;
  return monoTextWidth(text, fontSize) + text.length * letterSpacing + padX * 2 + 2;
}

/** A metric row of alternating muted-label / value spans (e.g. `uses N used by N`, `in N out N`) laid
 * out with a fixed flex gap between each span — its width is the captions plus the inter-span gaps. */
export function countsRowWidth(parts: ReadonlyArray<string>, fontSize: number, gap: number): number {
  const text = parts.reduce((sum, part) => sum + monoTextWidth(part, fontSize), 0);
  return text + gap * Math.max(0, parts.length - 1);
}
