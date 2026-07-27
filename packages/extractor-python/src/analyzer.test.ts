import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ExtractionProgress } from "@meridian/core";
import { describe, expect, it, vi } from "vitest";
import {
  ANALYZER_DIAGNOSTIC_TAIL_CHARS,
  collectAnalyzerProcess,
  createAnalyzerStderrParser,
  runAnalyzerCandidates,
} from "./analyzer";

const PROGRESS_PREFIX = "MERIDIAN_PROGRESS\t";

function progressFrame(current: number, total: number, path: string): Buffer {
  return Buffer.from(
    `${PROGRESS_PREFIX}${JSON.stringify({ phase: "project-load", current, total, path })}\n`,
    "utf8",
  );
}

describe("Python analyzer stderr protocol", () => {
  it("discards high-volume progress while decoding split Unicode frames and diagnostics", () => {
    let count = 0;
    let last: ExtractionProgress | undefined;
    const parser = createAnalyzerStderrParser({
      root: ".",
      onProgress: (event) => {
        count += 1;
        last = event;
      },
    });

    for (let current = 1; current <= 10_000; current += 1) {
      parser.push(progressFrame(current, 10_001, `src/file-${current}.py`));
    }
    const unicodeFrame = progressFrame(10_001, 10_001, "src/🔥.py");
    const flame = unicodeFrame.indexOf(Buffer.from("🔥"));
    parser.push(unicodeFrame.subarray(0, flame + 1));
    parser.push(unicodeFrame.subarray(flame + 1, flame + 3));
    parser.push(unicodeFrame.subarray(flame + 3));

    const diagnostic = Buffer.from("failed near 🔥\n", "utf8");
    const diagnosticFlame = diagnostic.indexOf(Buffer.from("🔥"));
    parser.push(diagnostic.subarray(0, diagnosticFlame + 2));
    parser.push(diagnostic.subarray(diagnosticFlame + 2));

    expect(parser.finish()).toBe("failed near 🔥\n");
    expect(count).toBe(10_001);
    expect(last?.sourceFile).toEqual({
      current: 10_001,
      total: 10_001,
      path: "src/🔥.py",
    });
  });

  it("retains malformed frames and bounds an unterminated diagnostic line", () => {
    const malformed = createAnalyzerStderrParser({ root: "." });
    malformed.push(Buffer.from(`${PROGRESS_PREFIX}{not-json}\n`, "utf8"));
    expect(malformed.finish()).toBe(`${PROGRESS_PREFIX}{not-json}\n`);

    const bounded = createAnalyzerStderrParser({ root: "." });
    bounded.push(Buffer.from("x".repeat(ANALYZER_DIAGNOSTIC_TAIL_CHARS * 3), "utf8"));

    const diagnostics = bounded.finish();
    expect(diagnostics.length).toBe(ANALYZER_DIAGNOSTIC_TAIL_CHARS);
    expect(diagnostics).toBe("x".repeat(ANALYZER_DIAGNOSTIC_TAIL_CHARS));
    expect(bounded.finish()).toBe(diagnostics);
  });
});

describe("Python analyzer process completion", () => {
  it("waits for close after an overflow kill error while continuing to drain progress", async () => {
    const child = new FakeAnalyzerProcess();
    let observed = 0;
    const attempt = collectAnalyzerProcess(child, {
      root: ".",
      onProgress: () => {
        observed += 1;
      },
    }, 4);
    let settled = false;
    void attempt.then(() => {
      settled = true;
    });

    child.stdout.write(Buffer.from("12345"));
    child.stderr.write(progressFrame(1, 1, "still-draining.py"));
    await Promise.resolve();

    expect(child.kill).toHaveBeenCalledOnce();
    expect(observed).toBe(1);
    expect(settled).toBe(false);

    child.emit("close", null, "SIGTERM");
    await expect(attempt).resolves.toEqual({
      kind: "output-overflow",
      failure: "stdout exceeded 4 bytes",
    });
  });

  it("classifies ENOENT only after the spawn-failure close event", async () => {
    const child = new FakeAnalyzerProcess();
    const attempt = collectAnalyzerProcess(child, { root: "." });
    let settled = false;
    void attempt.then(() => {
      settled = true;
    });

    child.emit("error", Object.assign(new Error("spawn missing"), { code: "ENOENT" }));
    await Promise.resolve();
    expect(settled).toBe(false);

    child.emit("close", -2, null);
    await expect(attempt).resolves.toEqual({ kind: "missing" });
  });
});

describe("Python analyzer interpreter fallback", () => {
  it("does not try another interpreter after deterministic output overflow", async () => {
    const execute = vi.fn(async (interpreter: string) => (
      interpreter === "python-first"
        ? { kind: "output-overflow" as const, failure: "stdout exceeded 4 bytes" }
        : { kind: "success" as const, stdout: "{}" }
    ));

    await expect(runAnalyzerCandidates(
      ["python-first", "python-never"],
      execute,
    )).rejects.toThrow("Python analyzer output limit exceeded");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith("python-first");
  });

  it("still falls back after an interpreter-specific failure", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ kind: "failure", failure: "incompatible runtime" })
      .mockResolvedValueOnce({ kind: "success", stdout: "{\"language\":\"python\"}" });

    await expect(runAnalyzerCandidates(
      ["python-first", "python-second"],
      execute,
    )).resolves.toBe("{\"language\":\"python\"}");
    expect(execute).toHaveBeenCalledTimes(2);
  });
});

class FakeAnalyzerProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn(() => {
    this.emit("error", Object.assign(new Error("kill failed"), { code: "ESRCH" }));
    return false;
  });
}
