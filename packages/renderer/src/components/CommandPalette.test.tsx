import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CommandPalette } from "./CommandPalette";

describe("CommandPalette closed state", () => {
  it("mounts only the shortcut shell and does not require or retain graph data", () => {
    // A closed palette used to read artifact/index and build every searchable symbol before its
    // early return. Rendering without a StoreProvider proves the closed shell no longer touches it.
    expect(renderToStaticMarkup(<CommandPalette />)).toBe("");
  });
});
