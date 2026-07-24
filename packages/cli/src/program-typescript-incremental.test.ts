import { describe, expect, it, vi } from "vitest";
import { buildProgram } from "./program";
import { runWeb } from "./commands/web";

vi.mock("./commands/web", () => ({ runWeb: vi.fn() }));

describe("web TypeScript incremental opt-in", () => {
  it("passes only an explicit supported mode to the server launcher", async () => {
    await buildProgram().parseAsync([
      "node",
      "meridian",
      "web",
      "--no-open",
      "--typescript-incremental",
      "shadow",
    ]);

    expect(runWeb).toHaveBeenCalledWith(undefined, expect.objectContaining({
      open: false,
      typescriptIncremental: "shadow",
    }));
  });

  it("rejects unknown modes at the CLI boundary", async () => {
    await expect(buildProgram().parseAsync([
      "node",
      "meridian",
      "web",
      "--typescript-incremental",
      "on",
    ])).rejects.toThrow(
      "TypeScript incremental mode must be empty, shadow, or verified-experimental",
    );
  });
});
