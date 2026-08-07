export const MAX_SOURCE_SYMBOL_SELECTION_LENGTH = 256;

export interface SourceTextSelection {
  readonly isCollapsed: boolean;
  readonly anchorNode: Node | null;
  readonly focusNode: Node | null;
  toString(): string;
}

export interface SourceSelectionRoot {
  contains(node: Node | null): boolean;
}

export interface SourceSelectionDocument {
  getSelection(): SourceTextSelection | null;
  addEventListener(type: "selectionchange", listener: () => void): void;
  removeEventListener(type: "selectionchange", listener: () => void): void;
}

export type SourceSymbolSelectionHandler = (symbol: string | null) => void;

const SOURCE_SYMBOL_SEGMENT = String.raw`[$_\p{ID_Start}][$_\u200C\u200D\p{ID_Continue}]*`;
const SOURCE_SYMBOL_SELECTION = new RegExp(
  `^${SOURCE_SYMBOL_SEGMENT}(?:\\.${SOURCE_SYMBOL_SEGMENT})*$`,
  "u",
);

/** Return one lookup-safe symbol selected wholly inside one rendered source cell. We preserve
 * Unicode identifiers, `_`/`$`, and qualified names instead of guessing punctuation away. */
export function selectedSourceSymbol(
  selection: SourceTextSelection | null,
  root: SourceSelectionRoot | null,
): string | null {
  const anchorCell = selection === null || root === null
    ? null
    : sourceCodeCellForSelectionEndpoint(selection.anchorNode, root);
  const focusCell = selection === null || root === null
    ? null
    : sourceCodeCellForSelectionEndpoint(selection.focusNode, root);
  if (
    selection === null
    || root === null
    || selection.isCollapsed
    || anchorCell === null
    || focusCell === null
    || anchorCell !== focusCell
  ) {
    return null;
  }

  const raw = selection.toString();
  if (/\r|\n|\u2028|\u2029/u.test(raw)) return null;
  const symbol = raw.trim();
  if (
    symbol.length === 0
    || symbol.length > MAX_SOURCE_SYMBOL_SELECTION_LENGTH
    || !SOURCE_SYMBOL_SELECTION.test(symbol)
  ) {
    return null;
  }
  return symbol;
}

/** Publish both valid selections and null invalidations so the dock never retains a stale lookup. */
export function publishSourceSymbolSelection(
  root: SourceSelectionRoot | null,
  selection: SourceTextSelection | null,
  onSymbolSelection: SourceSymbolSelectionHandler | undefined,
): void {
  onSymbolSelection?.(selectedSourceSymbol(selection, root));
}

/** Track the document selection instead of relying on pointer or keyboard events from the listing.
 * This covers assistive/programmatic selections and publishes a null when selection moves away. */
export function subscribeToSourceSymbolSelection(
  root: SourceSelectionRoot,
  ownerDocument: SourceSelectionDocument,
  onSymbolSelection: SourceSymbolSelectionHandler,
): () => void {
  const publish = () => publishSourceSymbolSelection(
    root,
    ownerDocument.getSelection(),
    onSymbolSelection,
  );
  ownerDocument.addEventListener("selectionchange", publish);
  return () => {
    ownerDocument.removeEventListener("selectionchange", publish);
    onSymbolSelection(null);
  };
}

function sourceCodeCellForSelectionEndpoint(
  node: Node | null,
  root: SourceSelectionRoot,
): Element | null {
  if (node === null) return null;
  const element = typeof (node as Element).closest === "function"
    ? node as Element
    : node.parentElement;
  const codeCell = element?.closest('[data-source-code-text="true"]') ?? null;
  return codeCell !== null && root.contains(codeCell) ? codeCell : null;
}
