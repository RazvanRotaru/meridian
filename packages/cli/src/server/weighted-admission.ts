/**
 * Synchronous weighted admission for resources whose aggregate cost matters more than job count.
 *
 * Admission never queues and never retains completed values. Callers either receive an explicit
 * lease or reject overload before beginning work; the lease owns exactly one idempotent release.
 */

export interface WeightedAdmissionSnapshot {
  readonly capacity: number;
  readonly used: number;
  readonly available: number;
  readonly active: number;
}

export interface WeightedAdmissionLease {
  readonly weight: number;
  release(): void;
}

export class WeightedAdmission {
  private usedWeight = 0;
  private activeLeases = 0;

  constructor(readonly capacity: number) {
    requirePositiveSafeInteger(capacity, "weighted admission capacity");
  }

  get snapshot(): WeightedAdmissionSnapshot {
    return {
      capacity: this.capacity,
      used: this.usedWeight,
      available: this.capacity - this.usedWeight,
      active: this.activeLeases,
    };
  }

  tryAcquire(weight: number): WeightedAdmissionLease | null {
    requirePositiveSafeInteger(weight, "weighted admission lease");
    if (weight > this.capacity - this.usedWeight) return null;

    this.usedWeight += weight;
    this.activeLeases += 1;
    let released = false;
    return {
      weight,
      release: () => {
        if (released) return;
        released = true;
        this.usedWeight -= weight;
        this.activeLeases -= 1;
      },
    };
  }
}

function requirePositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
}
