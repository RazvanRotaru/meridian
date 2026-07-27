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

  it("passes the trusted-admission and cross-pair cache opt-ins explicitly", async () => {
    await buildProgram().parseAsync([
      "node",
      "meridian",
      "web",
      "--no-open",
      "--typescript-incremental",
      "admitted",
      "--experimental-pr-revision-cache",
    ]);

    expect(runWeb).toHaveBeenCalledWith(undefined, expect.objectContaining({
      experimentalPrRevisionCache: true,
      open: false,
      typescriptIncremental: "admitted",
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
      "TypeScript incremental mode must be empty, shadow, admitted, or verified-experimental",
    );
  });
});
