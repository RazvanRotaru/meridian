/**
 * Shared plumbing for the end-to-end suite: locating the built CLI, generating a graph from
 * the fixture, and starting a real `blueprint view` server we can point a browser at.
 */

import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const HERE = dirname(fileURLToPath(import.meta.url));
export const CLI = join(HERE, "..", "dist", "bin.js");
export const RENDERER_INDEX = join(HERE, "..", "renderer-dist", "index.html");
export const FIXTURE = join(HERE, "..", "..", "..", "examples", "orders-service");

export function chromiumInstalled(): boolean {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}

export function ensureBuilt(): void {
  if (!existsSync(CLI)) {
    throw new Error(`CLI not built at ${CLI} — run \`pnpm e2e\` (it builds first).`);
  }
  if (!existsSync(RENDERER_INDEX)) {
    throw new Error("renderer bundle missing — run `pnpm --filter @meridian/cli copy-renderer`.");
  }
}

export function generateGraph(): { graphPath: string; dir: string } {
  return generateGraphFrom(FIXTURE);
}

/** Generate a graph artifact from ANY example fixture (the parity drive uses shopfront — it has a
 * render tree, so all three lenses have substance). */
export function generateGraphFrom(fixtureDir: string): { graphPath: string; dir: string } {
  ensureBuilt();
  const dir = mkdtempSync(join(tmpdir(), "blueprint-e2e-"));
  const graphPath = join(dir, "fixture.graph.json");
  execFileSync(process.execPath, [CLI, "generate", fixtureDir, "-o", graphPath], { stdio: "ignore" });
  return { graphPath, dir };
}

export function runCli(args: string[]): { code: number; stderr: string } {
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
  return { code: result.status ?? -1, stderr: result.stderr ?? "" };
}

export function startView(graphPath: string, port = 4399): Promise<{ server: ChildProcess; url: string }> {
  const server = spawn(
    process.execPath,
    [CLI, "view", graphPath, "--overlay", "mock", "--env", "staging", "--no-open", "--port", String(port)],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  return new Promise((resolve, reject) => {
    let buffer = "";
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString();
      const match = buffer.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) {
        resolve({ server, url: match[0] });
      }
    };
    server.stdout?.on("data", onData);
    server.stderr?.on("data", onData);
    setTimeout(() => reject(new Error(`view did not announce a URL in time:\n${buffer}`)), 30_000);
  });
}
