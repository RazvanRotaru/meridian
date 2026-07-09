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
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    // A missing opener (headless box: no `xdg-open`) surfaces ASYNChronously as an 'error' event,
    // which the try/catch below cannot reach — left unhandled it crashes the whole server. Swallow
    // it here so serving stays load-bearing; the URL was already printed to stderr.
    child.on("error", () => {});
    child.unref();
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
