/**
 * Best-effort launch of the OS default browser on the served URL.
 *
 * Opening a browser is a convenience, never load-bearing: the process is detached and any
 * failure is swallowed so a headless box (CI, a server over SSH) still serves happily.
 */

import { spawn } from "node:child_process";

export function openInBrowser(url: string): void {
  const [command, ...args] = openerCommand(url);
  try {
    spawn(command, args, { stdio: "ignore", detached: true }).unref();
  } catch {
    // Headless environments have no opener; the URL was already printed to stderr.
  }
}

function openerCommand(url: string): string[] {
  if (process.platform === "darwin") {
    return ["open", url];
  }
  if (process.platform === "win32") {
    return ["cmd", "/c", "start", "", url];
  }
  return ["xdg-open", url];
}
