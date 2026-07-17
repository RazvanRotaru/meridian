/** Per-server admission for source reads and raw source response bodies. */

import { SOURCE_TEXT_MAX_BYTES } from "@meridian/core";
import { WeightedAdmission, type WeightedAdmissionLease } from "./weighted-admission";

/** Input file + optional normalized body + socket/encoding transient. */
export const SOURCE_TEXT_RESIDENT_MULTIPLIER = 3;
/** Bounded remote JSON bytes + UTF-16 JSON/content + decoded bytes + UTF-16 visible code. */
export const REMOTE_SOURCE_TEXT_RESIDENT_MULTIPLIER = 12;
export const SOURCE_TEXT_MIN_RESERVATION_BYTES = 256 * 1024;
export const SOURCE_TEXT_MAX_RESERVATION_BYTES = SOURCE_TEXT_MAX_BYTES * SOURCE_TEXT_RESIDENT_MULTIPLIER;
export const DEFAULT_SOURCE_TEXT_ACTIVE_REQUESTS = 16;
/** Two maximum-size reads fit; smaller slices use the same pool proportionally. */
export const DEFAULT_SOURCE_TEXT_MEMORY_BUDGET_BYTES = SOURCE_TEXT_MAX_RESERVATION_BYTES * 2;

export interface SourceTextAdmissionOptions {
  maxActive?: number;
  memoryBudgetBytes?: number;
}

export interface SourceTextAdmissionLease {
  release(): void;
}

export class SourceTextAdmission {
  private readonly memory: WeightedAdmission;
  private readonly maxActive: number;
  private active = 0;

  constructor(options: SourceTextAdmissionOptions = {}) {
    this.maxActive = positiveSafeInteger(
      options.maxActive ?? DEFAULT_SOURCE_TEXT_ACTIVE_REQUESTS,
      "source text maxActive",
    );
    this.memory = new WeightedAdmission(positiveSafeInteger(
      options.memoryBudgetBytes ?? DEFAULT_SOURCE_TEXT_MEMORY_BUDGET_BYTES,
      "source text memoryBudgetBytes",
    ));
  }

  get snapshot(): { active: number; usedBytes: number; availableBytes: number } {
    const memory = this.memory.snapshot;
    return { active: this.active, usedBytes: memory.used, availableBytes: memory.available };
  }

  tryAcquire(weight: number): SourceTextAdmissionLease | null {
    positiveSafeInteger(weight, "source text admission weight");
    if (this.active >= this.maxActive) return null;
    const memoryLease = this.memory.tryAcquire(weight);
    if (memoryLease === null) return null;
    this.active += 1;
    return this.lease(memoryLease);
  }

  private lease(memoryLease: WeightedAdmissionLease): SourceTextAdmissionLease {
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.active -= 1;
        memoryLease.release();
      },
    };
  }
}

export function sourceTextReservationBytes(fileBytes: number): number {
  return reservationBytes(fileBytes, SOURCE_TEXT_RESIDENT_MULTIPLIER);
}

export function remoteSourceTextReservationBytes(fileBytes: number): number {
  return reservationBytes(fileBytes, REMOTE_SOURCE_TEXT_RESIDENT_MULTIPLIER);
}

function reservationBytes(fileBytes: number, multiplier: number): number {
  if (!Number.isSafeInteger(fileBytes) || fileBytes < 0 || fileBytes > SOURCE_TEXT_MAX_BYTES) {
    throw new RangeError(`source text file bytes must be between 0 and ${SOURCE_TEXT_MAX_BYTES}`);
  }
  return Math.max(
    SOURCE_TEXT_MIN_RESERVATION_BYTES,
    fileBytes * multiplier,
  );
}

export function createSourceTextAdmission(
  options: SourceTextAdmissionOptions = {},
): SourceTextAdmission {
  return new SourceTextAdmission(options);
}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
  return value;
}
