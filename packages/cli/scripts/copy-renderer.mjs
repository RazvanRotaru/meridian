// Copy the built renderer SPA into the CLI package so `blueprint view` ships self-contained.
import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, "../../renderer/dist");
const destination = resolve(here, "../renderer-dist");

if (!existsSync(source)) {
  throw new Error(`renderer build not found at ${source} — run \`pnpm --filter @meridian/renderer build\` first`);
}

rmSync(destination, { recursive: true, force: true });
cpSync(source, destination, { recursive: true });
process.stdout.write(`copied renderer dist -> ${destination}\n`);
