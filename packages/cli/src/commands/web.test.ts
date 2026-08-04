/** The public web command is also the only entry point for serving an existing graph artifact. */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runView } from "./view";
import { runWeb, type WebOptions } from "./web";
import { createWebService } from "../server/web-server";
import { serve } from "../server/serve";

vi.mock("./view", () => ({ runView: vi.fn() }));
vi.mock("../server/web-server", () => ({ createWebService: vi.fn(() => ({})) }));
vi.mock("../server/serve", () => ({ serve: vi.fn() }));

const typeScriptIncrementalModes = [
  "empty",
  "shadow",
  "admitted",
  "verified-experimental",
] as const;

describe("web launcher", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
    roots.length = 0;
    vi.unstubAllEnvs();
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

  it.each([
    ...typeScriptIncrementalModes.map((mode) => ({
      name: `TypeScript incremental ${mode}`,
      options: { typescriptIncremental: mode },
      flag: `--typescript-incremental ${mode}`,
    })),
    {
      name: "cross-PR revision artifacts",
      options: { experimentalPrRevisionCache: true },
      flag: "--experimental-pr-revision-cache",
    },
    {
      name: "complete PR graph benchmark controls",
      options: { benchmarkPrFullBaseline: true },
      flag: "--benchmark-pr-full-baseline",
    },
  ])("rejects $name on a non-loopback host", async ({ options, flag }) => {
    await expect(runWeb(undefined, {
      cwd: process.cwd(),
      host: "0.0.0.0",
      port: 4180,
      open: false,
      ...options,
    })).rejects.toThrow(`${flag} requires a loopback --host`);
  });

  it.each(typeScriptIncrementalModes)(
    "accepts TypeScript incremental %s on a loopback host",
    async (typescriptIncremental) => {
      const root = mkdtempSync(join(tmpdir(), "meridian-web-incremental-loopback-"));
      roots.push(root);
      const graph = join(root, "graph.json");
      writeFileSync(graph, "{}", "utf8");
      vi.mocked(runView).mockResolvedValue();
      const options: WebOptions = {
        cwd: root,
        host: "127.0.0.1",
        port: 4180,
        open: false,
        typescriptIncremental,
      };

      await runWeb("graph.json", options);

      expect(runView).toHaveBeenCalledWith("graph.json", options);
    },
  );

  it("keeps complete PR baselines disabled unless the loopback benchmark flag is explicit", async () => {
    vi.stubEnv("GITHUB_TOKEN", "ghp_test");
    const common: WebOptions = {
      cwd: process.cwd(),
      host: "127.0.0.1",
      port: 4180,
      open: false,
      quiet: true,
    };

    await runWeb(undefined, common);
    expect(createWebService).toHaveBeenLastCalledWith(expect.objectContaining({
      benchmarkPrFullBaseline: false,
    }));

    await runWeb(undefined, { ...common, benchmarkPrFullBaseline: true });
    expect(createWebService).toHaveBeenLastCalledWith(expect.objectContaining({
      benchmarkPrFullBaseline: true,
    }));
    expect(serve).toHaveBeenCalledTimes(2);
  });
});
