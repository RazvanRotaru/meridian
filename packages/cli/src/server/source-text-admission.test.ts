import { describe, expect, it } from "vitest";
import { SOURCE_TEXT_MAX_BYTES } from "@meridian/core";
import { FILE_AT_REF_MAX_BYTES } from "./github";
import {
  REMOTE_SOURCE_TEXT_RESIDENT_MULTIPLIER,
  SourceTextAdmission,
  remoteSourceTextReservationBytes,
  sourceTextReservationBytes,
} from "./source-text-admission";

describe("SourceTextAdmission", () => {
  it("bounds count and bytes before work begins, then releases idempotently", () => {
    const admission = new SourceTextAdmission({
      maxActive: 3,
      memoryBudgetBytes: 12,
    });
    const first = admission.tryAcquire(6)!;
    const second = admission.tryAcquire(6)!;

    expect(admission.snapshot).toEqual({ active: 2, usedBytes: 12, availableBytes: 0 });
    expect(admission.tryAcquire(1)).toBeNull();
    first.release();
    first.release();
    expect(admission.snapshot).toEqual({ active: 1, usedBytes: 6, availableBytes: 6 });
    expect(admission.tryAcquire(6)).not.toBeNull();
    second.release();
  });

  it("enforces the count boundary independently from available bytes", () => {
    const admission = new SourceTextAdmission({
      maxActive: 1,
      memoryBudgetBytes: 20,
    });
    const lease = admission.tryAcquire(5)!;
    expect(admission.tryAcquire(1)).toBeNull();
    expect(admission.snapshot).toEqual({ active: 1, usedBytes: 5, availableBytes: 15 });
    lease.release();
  });

  it("admits small reads into spare bytes while two maximum reads consume the pool", () => {
    const maximum = sourceTextReservationBytes(SOURCE_TEXT_MAX_BYTES);
    const small = sourceTextReservationBytes(1_024);
    const admission = new SourceTextAdmission({ maxActive: 16, memoryBudgetBytes: maximum * 2 });

    const firstLarge = admission.tryAcquire(maximum)!;
    const firstSmall = admission.tryAcquire(small)!;
    expect(firstSmall).not.toBeNull();
    expect(admission.tryAcquire(maximum)).toBeNull();
    firstSmall.release();
    const secondLarge = admission.tryAcquire(maximum)!;
    expect(secondLarge).not.toBeNull();
    expect(admission.tryAcquire(small)).toBeNull();
    firstLarge.release();
    secondLarge.release();
  });

  it("charges remote PR-head reads for bounded base64 JSON and decoded text", () => {
    expect(remoteSourceTextReservationBytes(FILE_AT_REF_MAX_BYTES)).toBe(
      FILE_AT_REF_MAX_BYTES * REMOTE_SOURCE_TEXT_RESIDENT_MULTIPLIER,
    );
    expect(remoteSourceTextReservationBytes(FILE_AT_REF_MAX_BYTES)).toBe(24_000_000);
  });
});
