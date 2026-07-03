/**
 * Path resolution against the global `--cwd` and the POSIX root-relative locator the
 * artifact header records. The renderer and telemetry join treat node ids (which embed the
 * root-relative module path) as opaque, so `target.root` must be the same POSIX shape.
 */

import { isAbsolute, relative, resolve, sep } from "node:path";

export function resolveCwd(cwdOption: string | undefined): string {
  return cwdOption ? resolve(process.cwd(), cwdOption) : process.cwd();
}

export function resolveAgainst(baseDirectory: string, target: string): string {
  return isAbsolute(target) ? target : resolve(baseDirectory, target);
}

/** The artifact's `target.root`: where the scanned tree sits relative to `--cwd`, POSIX. */
export function rootRelativeToCwd(cwd: string, absoluteRoot: string): string {
  const relativePath = relative(cwd, absoluteRoot);
  if (relativePath === "") {
    return ".";
  }
  return toPosix(relativePath);
}

function toPosix(nativePath: string): string {
  return sep === "/" ? nativePath : nativePath.split(sep).join("/");
}
