/**
 * Minimal ambient typings for the node builtins the parity suite's SOURCE SCAN uses
 * (elkIdentity.test.ts runs in vitest's node environment). The renderer's tsconfig deliberately
 * carries NO "node" types — it is a browser package, and a stray node import must not typecheck
 * its way into the bundle silently — so this shim types exactly the three calls the scan needs
 * and nothing more. Delete it if @types/node ever joins the package for real.
 */

declare module "node:fs" {
  export interface ScanDirent {
    name: string;
    parentPath: string;
    isFile(): boolean;
  }
  export function readdirSync(path: string, options: { recursive: true; withFileTypes: true }): ScanDirent[];
  export function readFileSync(path: string, encoding: "utf8"): string;
}

declare module "node:path" {
  export function join(...parts: string[]): string;
  export function relative(from: string, to: string): string;
  export function dirname(path: string): string;
}

declare module "node:url" {
  export function fileURLToPath(url: string | URL): string;
}
