import { describe, expect, it, vi } from "vitest";
import {
  MAX_SOURCE_SYMBOL_SELECTION_LENGTH,
  publishSourceSymbolSelection,
  selectedSourceSymbol,
  subscribeToSourceSymbolSelection,
  type SourceTextSelection,
} from "./sourceSymbolSelection";

describe("source symbol selection", () => {
  const insideCell = {} as Element;
  const secondInsideCell = {} as Element;
  const outsideCell = {} as Element;
  const insideElement = { closest: () => insideCell } as unknown as HTMLElement;
  const secondInsideElement = { closest: () => secondInsideCell } as unknown as HTMLElement;
  const outsideElement = { closest: () => outsideCell } as unknown as HTMLElement;
  const insideText = { parentElement: insideElement } as unknown as Node;
  const secondInsideText = { parentElement: secondInsideElement } as unknown as Node;
  const outsideText = { parentElement: outsideElement } as unknown as Node;
  const root = {
    contains: (node: Node | null) => node === insideCell || node === secondInsideCell,
  };
  const selection = (
    text: string,
    overrides: Partial<SourceTextSelection> = {},
  ): SourceTextSelection => ({
    isCollapsed: false,
    anchorNode: insideText,
    focusNode: insideText,
    toString: () => text,
    ...overrides,
  });

  it.each([
    ["  loyaltyTierFor  ", "loyaltyTierFor"],
    ["_private.$cache", "_private.$cache"],
    ["Δelta.μέθοδος", "Δelta.μέθοδος"],
    ["变量.读取2", "变量.读取2"],
    ["cafe\u0301", "cafe\u0301"],
  ])("accepts the lookup-safe selection %j", (raw, expected) => {
    expect(selectedSourceSymbol(selection(raw), root)).toBe(expected);
  });

  it.each([
    "",
    "   ",
    "foo bar",
    "foo\nbar",
    "foo\rbar",
    ".foo",
    "foo.",
    "foo..bar",
    "foo()",
    "🙂",
  ])("rejects the unsafe selection %j", (raw) => {
    expect(selectedSourceSymbol(selection(raw), root)).toBeNull();
  });

  it("rejects collapsed, out-of-source, cross-cell, and overlong selections", () => {
    expect(selectedSourceSymbol(selection("valid", { isCollapsed: true }), root)).toBeNull();
    expect(selectedSourceSymbol(selection("valid", {
      anchorNode: outsideText,
      focusNode: outsideText,
    }), root)).toBeNull();
    expect(selectedSourceSymbol(selection("valid", { focusNode: outsideText }), root)).toBeNull();
    expect(selectedSourceSymbol(selection("valid", { focusNode: secondInsideText }), root)).toBeNull();
    expect(selectedSourceSymbol(selection("a".repeat(MAX_SOURCE_SYMBOL_SELECTION_LENGTH + 1)), root)).toBeNull();
    expect(selectedSourceSymbol(null, root)).toBeNull();
    expect(selectedSourceSymbol(selection("valid"), null)).toBeNull();
  });

  it("publishes valid selections and null invalidations to the optional host callback", () => {
    const onSymbolSelection = vi.fn();

    publishSourceSymbolSelection(root, selection("  loyaltyTierFor "), onSymbolSelection);
    publishSourceSymbolSelection(root, selection("not a symbol"), onSymbolSelection);
    publishSourceSymbolSelection(root, selection("ignored"), undefined);

    expect(onSymbolSelection).toHaveBeenNthCalledWith(1, "loyaltyTierFor");
    expect(onSymbolSelection).toHaveBeenNthCalledWith(2, null);
    expect(onSymbolSelection).toHaveBeenCalledTimes(2);
  });

  it("tracks document-level selection changes and invalidates on cleanup", () => {
    const onSymbolSelection = vi.fn();
    let currentSelection: SourceTextSelection | null = selection("loyaltyTierFor");
    let listener: (() => void) | undefined;
    const ownerDocument = {
      getSelection: () => currentSelection,
      addEventListener: vi.fn((_type: "selectionchange", next: () => void) => { listener = next; }),
      removeEventListener: vi.fn((_type: "selectionchange", current: () => void) => {
        if (listener === current) listener = undefined;
      }),
    };

    const unsubscribe = subscribeToSourceSymbolSelection(root, ownerDocument, onSymbolSelection);
    listener?.();
    currentSelection = selection("outside", { anchorNode: outsideText, focusNode: outsideText });
    listener?.();
    unsubscribe();

    expect(onSymbolSelection.mock.calls).toEqual([
      ["loyaltyTierFor"],
      [null],
      [null],
    ]);
    expect(ownerDocument.addEventListener).toHaveBeenCalledWith("selectionchange", expect.any(Function));
    expect(ownerDocument.removeEventListener).toHaveBeenCalledWith("selectionchange", expect.any(Function));
    expect(listener).toBeUndefined();
  });
});
