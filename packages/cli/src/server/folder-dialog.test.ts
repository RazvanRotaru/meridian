import { describe, expect, it } from "vitest";
import { pickerInvocations, windowsEncodedScript } from "./folder-dialog";

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
});
