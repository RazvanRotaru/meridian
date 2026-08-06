/**
 * Id minting, extracted from utils/legacy. Renamed from `uuid` because it never was one:
 * `mintId` says what it does — hand out a prefixed, process-unique identifier.
 */

let counter = 0;

/** Mint a not-really-random but good-enough unique id with a prefix. */
export function mintId(prefix: string): string {
  counter += 1;
  return `${prefix}_${counter.toString(36)}${(counter * 2654435761).toString(36)}`;
}
