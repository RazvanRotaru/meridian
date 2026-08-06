/**
 * Structural cloning, extracted from utils/legacy.
 */

/** A structural deep clone that is fine for the plain data this fixture moves around. */
export function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
