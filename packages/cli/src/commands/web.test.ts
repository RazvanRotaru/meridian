/** The public web command is also the only entry point for serving an existing graph artifact. */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runView } from "./view";
import { runWeb, type WebOptions } from "./web";

vi.mock("./view", () => ({ runView: vi.fn() }));

describe("web launcher", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
    roots.length = 0;
    vi.clearAllMocks();
  });

  it("routes an existing graph file through the artifact server", async () => {
    const root = mkdtempSync(join(tmpdir(), "meridian-web-artifact-"));
    roots.push(root);
    const graph = join(root, "graph.json");
    writeFileSync(graph, "{}", "utf8");
    vi.mocked(runView).mockResolvedValue();
    const options: WebOptions = {
      cwd: root,
      host: "127.0.0.1",
      port: 4180,
      open: false,
      overlay: "mock",
      env: "staging",
    };

    await runWeb("graph.json", options);

    expect(runView).toHaveBeenCalledWith("graph.json", options);
  });
});
