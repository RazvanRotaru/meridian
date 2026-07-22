import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getHeapStatistics: vi.fn(),
  spawnSync: vi.fn(),
}));

vi.mock("node:child_process", () => ({ spawnSync: mocks.spawnSync }));
vi.mock("node:v8", () => ({ getHeapStatistics: mocks.getHeapStatistics }));

import { ensureHeadroom } from "./heap";

const ORIGINAL_NODE_OPTIONS = process.env.NODE_OPTIONS;
const ORIGINAL_HEAP_RAISED = process.env.MERIDIAN_HEAP_RAISED;

describe("CLI heap admission", () => {
  beforeEach(() => {
    delete process.env.NODE_OPTIONS;
    delete process.env.MERIDIAN_HEAP_RAISED;
    mocks.getHeapStatistics.mockReturnValue({ heap_size_limit: 512 * 1024 * 1024 });
    mocks.spawnSync.mockReturnValue({ status: 0 });
  });

  afterEach(() => {
    restoreEnvironment("NODE_OPTIONS", ORIGINAL_NODE_OPTIONS);
    restoreEnvironment("MERIDIAN_HEAP_RAISED", ORIGINAL_HEAP_RAISED);
    vi.restoreAllMocks();
    mocks.getHeapStatistics.mockReset();
    mocks.spawnSync.mockReset();
  });

  it("keeps the web parent under the ambient heap ceiling", () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

    ensureHeadroom([process.execPath, "/package/dist/bin.js", "web", "."]);

    expect(mocks.getHeapStatistics).not.toHaveBeenCalled();
    expect(mocks.spawnSync).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it("still gives in-process generate extraction explicit headroom", () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

    ensureHeadroom([process.execPath, "/package/dist/bin.js", "generate", "."]);

    expect(mocks.getHeapStatistics).toHaveBeenCalledOnce();
    expect(mocks.spawnSync).toHaveBeenCalledWith(
      process.execPath,
      ["--max-old-space-size=8192", "/package/dist/bin.js", "generate", "."],
      expect.objectContaining({
        stdio: "inherit",
        env: expect.objectContaining({ MERIDIAN_HEAP_RAISED: "1" }),
      }),
    );
    expect(exit).toHaveBeenCalledWith(0);
  });
});

function restoreEnvironment(name: "NODE_OPTIONS" | "MERIDIAN_HEAP_RAISED", value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
