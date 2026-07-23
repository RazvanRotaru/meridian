/**
 * Open the OS-native "choose a folder" dialog and resolve to the absolute path the user picked
 * (null when they cancel). `meridian web` runs on the user's OWN machine, so the SERVER can pop the
 * real dialog and hand back a filesystem path — a browser folder picker deliberately can't expose
 * one. Cross-platform: Windows PowerShell `FolderBrowserDialog`, macOS `osascript`, Linux
 * `zenity`/`kdialog`. Every invocation is an argv-only spawn (never a shell), so the fixed prompt
 * text can't be interpreted as a command.
 */

import { spawn } from "node:child_process";

/** The picker binary isn't installed, no desktop session, or it timed out — the caller should fall
 * back to the type-a-path field rather than treating this as a hard error. `missing` marks the
 * specific "binary not found" case so `pickFolder` can try the next candidate. */
export class FolderDialogUnavailable extends Error {
  missing = false;
}

const PROMPT = "Select a repository folder to analyze";
// A picker can sit open while the user browses; only kill it after a generous idle window.
const DIALOG_TIMEOUT_MS = 5 * 60_000;

export interface PickerInvocation {
  command: string;
  args: string[];
  /** Exit codes that mean "the user cancelled" (resolve null) rather than a failure. */
  cancelExitCodes: number[];
}

export interface PickFolderOptions {
  platform?: NodeJS.Platform;
  signal?: AbortSignal;
}

/** The ordered picker candidates for a platform — the first whose binary exists is used. Pure and
 * exported so the cross-platform contract can be unit-tested without opening a real dialog. */
export function pickerInvocations(platform: NodeJS.Platform): PickerInvocation[] {
  if (platform === "win32") {
    return [{ command: "powershell.exe", args: ["-NoProfile", "-STA", "-EncodedCommand", windowsEncodedScript()], cancelExitCodes: [] }];
  }
  if (platform === "darwin") {
    return [{ command: "osascript", args: ["-e", `POSIX path of (choose folder with prompt "${PROMPT}")`], cancelExitCodes: [1] }];
  }
  return [
    { command: "zenity", args: ["--file-selection", "--directory", `--title=${PROMPT}`], cancelExitCodes: [1] },
    { command: "kdialog", args: ["--getexistingdirectory", ".", "--title", PROMPT], cancelExitCodes: [1] },
  ];
}

/** The WinForms FolderBrowserDialog script, base64-encoded as UTF-16LE for `-EncodedCommand` (so no
 * quoting survives into the argv). Cancel prints nothing; OK prints the selected path with no newline. */
export function windowsEncodedScript(): string {
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms;",
    "$d = New-Object System.Windows.Forms.FolderBrowserDialog;",
    `$d.Description = '${PROMPT}';`,
    "$d.ShowNewFolderButton = $false;",
    "if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }",
  ].join(" ");
  return Buffer.from(script, "utf16le").toString("base64");
}

export async function pickFolder(options: PickFolderOptions = {}): Promise<string | null> {
  const platform = options.platform ?? process.platform;
  const candidates = pickerInvocations(platform);
  for (let i = 0; i < candidates.length; i++) {
    const isLast = i === candidates.length - 1;
    try {
      return await runPicker(candidates[i], options.signal);
    } catch (error) {
      // A missing binary just means "try the next candidate"; anything else (or the last one) bubbles.
      if (isLast || !(error instanceof FolderDialogUnavailable && error.missing)) {
        throw error;
      }
    }
  }
  throw new FolderDialogUnavailable("no folder picker is available on this platform");
}

export function runPicker(invocation: PickerInvocation, signal?: AbortSignal): Promise<string | null> {
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  const cancelCodes = new Set(invocation.cancelExitCodes);
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    let settled = false;
    let terminalReason: unknown;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    };
    const settle = (act: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      act();
    };
    const terminate = (reason: unknown) => {
      if (settled || terminalReason !== undefined) return;
      terminalReason = reason;
      clearTimeout(timer);
      child.kill("SIGKILL");
    };
    const abort = () => {
      if (signal !== undefined) terminate(abortReason(signal));
    };
    const timer = setTimeout(() => terminate(
      new FolderDialogUnavailable("folder picker timed out"),
    ), DIALOG_TIMEOUT_MS);
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk) => {
      if (terminalReason !== undefined) return;
      out += chunk.toString();
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      const unavailable = new FolderDialogUnavailable(`could not launch ${invocation.command}`);
      unavailable.missing = error.code === "ENOENT";
      if (child.pid === undefined) settle(() => reject(unavailable));
      else terminate(unavailable);
    });
    child.on("close", (code) => {
      if (terminalReason !== undefined) {
        settle(() => reject(terminalReason));
        return;
      }
      const path = out.trim();
      if (path) {
        settle(() => resolve(path));
        return;
      }
      // No path on stdout: exit 0 or a known cancel code == the user dismissed the dialog.
      if (code === 0 || cancelCodes.has(code ?? -1)) {
        settle(() => resolve(null));
        return;
      }
      settle(() => reject(new FolderDialogUnavailable(`folder picker exited with code ${code}`)));
    });
    if (signal?.aborted) abort();
  });
}

function abortReason(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason;
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}
