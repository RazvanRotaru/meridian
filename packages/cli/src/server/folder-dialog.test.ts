import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pickerInvocations, runPicker, windowsEncodedScript } from "./folder-dialog";

describe("pickerInvocations — cross-platform folder dialog contract", () => {
  it("uses a single-threaded PowerShell FolderBrowserDialog on Windows", () => {
    const [win, ...rest] = pickerInvocations("win32");
    expect(rest).toHaveLength(0);
    expect(win.command).toBe("powershell.exe");
    expect(win.args).toContain("-STA");
    expect(win.args).toContain("-EncodedCommand");
    // The encoded payload really is the FolderBrowserDialog script (decoded from UTF-16LE base64).
    const decoded = Buffer.from(win.args[win.args.indexOf("-EncodedCommand") + 1], "base64").toString("utf16le");
    expect(decoded).toContain("FolderBrowserDialog");
    expect(win.cancelExitCodes).toEqual([]); // Windows prints nothing on cancel; no cancel exit code
  });

  it("uses osascript on macOS and treats exit 1 as cancel", () => {
    const [mac, ...rest] = pickerInvocations("darwin");
    expect(rest).toHaveLength(0);
    expect(mac.command).toBe("osascript");
    expect(mac.args.join(" ")).toContain("choose folder");
    expect(mac.cancelExitCodes).toContain(1);
  });

  it("falls back from zenity to kdialog on Linux, both cancel on exit 1", () => {
    const linux = pickerInvocations("linux");
    expect(linux.map((entry) => entry.command)).toEqual(["zenity", "kdialog"]);
    for (const entry of linux) {
      expect(entry.cancelExitCodes).toContain(1);
    }
  });

  it("encodes the Windows script as base64 with no surviving quotes to break the argv", () => {
    const encoded = windowsEncodedScript();
    expect(encoded).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(encoded).not.toContain("'");
    expect(encoded).not.toContain('"');
  });

  it("kills an active picker child, waits for its exit, and preserves the abort reason", async () => {
    const root = mkdtempSync(join(tmpdir(), "meridian-folder-picker-abort-"));
    const pidPath = join(root, "picker.pid");
    const controller = new AbortController();
    const shutdownReason = new Error("service shutdown");
    let pid: number | undefined;

    try {
      const running = runPicker({
        command: process.execPath,
        args: [
          "-e",
          [
            "const fs = require('node:fs');",
            "process.on('SIGTERM', () => {});",
            "fs.writeFileSync(process.argv[1], String(process.pid));",
            "setInterval(() => {}, 1_000);",
          ].join(" "),
          pidPath,
        ],
        cancelExitCodes: [],
      }, controller.signal);

      await waitFor(() => existsSync(pidPath));
      pid = Number(readFileSync(pidPath, "utf8"));
      expect(Number.isSafeInteger(pid)).toBe(true);
      expect(isProcessAlive(pid)).toBe(true);

      controller.abort(shutdownReason);

      await expect(running).rejects.toBe(shutdownReason);
      // `runPicker` must reject from the child's `close` event, not merely after requesting a kill.
      expect(isProcessAlive(pid)).toBe(false);
    } finally {
      if (pid !== undefined && isProcessAlive(pid)) {
        process.kill(pid, "SIGKILL");
      }
      rmSync(root, { recursive: true, force: true });
    }
  }, 10_000);
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for picker child");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
