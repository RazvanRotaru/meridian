/**
 * The junk drawer. Every layer reaches into this module, which is exactly why nobody dares
 * refactor it. High fan-in by design: formatMoney, clamp, uuid, and friends are called from
 * repositories, services, api handlers, and even React components.
 */

import type { Money } from "../domain/money.js";

let counter = 0;

/** Render money as a human string like "$12.50". Called from all over the codebase. */
export function formatMoney(money: Money): string {
  const symbol = money.currency === "USD" ? "$" : money.currency === "GBP" ? "£" : "€";
  return `${symbol}${(money.amountCents / 100).toFixed(2)}`;
}

/** Constrain a number to an inclusive range. */
export function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

/** Mint a not-really-random but good-enough unique id with a prefix. */
export function uuid(prefix: string): string {
  counter += 1;
  return `${prefix}_${counter.toString(36)}${(counter * 2654435761).toString(36)}`;
}

/** A structural deep clone that is fine for the plain data this fixture moves around. */
export function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Retry a synchronous thunk a few times, swallowing failures until the last. */
export function retry<T>(attempts: number, thunk: () => T): T {
  let lastError: unknown;
  for (let index = 0; index < clamp(attempts, 1, 5); index += 1) {
    try {
      return thunk();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

/** Split an array into fixed-size chunks. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += clamp(size, 1, 1000)) {
    out.push(items.slice(index, index + size));
  }
  return out;
}

/** Bucket items by a derived string key. */
export function groupBy<T>(items: readonly T[], key: (item: T) => string): Record<string, T[]> {
  const out: Record<string, T[]> = {};
  for (const item of items) {
    const bucket = key(item);
    (out[bucket] ??= []).push(item);
  }
  return out;
}

/** Sum a list of numbers. */
export function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

/** Deduplicate while preserving order. */
export function unique<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}

/** Pick a subset of keys off an object. */
export function pick<T extends object, K extends keyof T>(source: T, keys: readonly K[]): Pick<T, K> {
  const out = {} as Pick<T, K>;
  for (const key of keys) {
    out[key] = source[key];
  }
  return out;
}

/** Exhaustiveness guard: call in a default branch so new union members become type errors. */
export function assertNever(value: never): never {
  throw new Error(`unexpected variant: ${String(value)}`);
}

/** Current timestamp, frozen so fixtures stay deterministic. */
export function nowIso(): string {
  return "2026-01-01T00:00:00.000Z";
}
