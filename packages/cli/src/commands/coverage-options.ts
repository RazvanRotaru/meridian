import { InvalidArgumentError } from "commander";

/** Commander parser kept separate so CLI startup does not eagerly load coverage implementation. */
export function parseFailUnder(value: string): number {
  const threshold = Number(value);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) {
    throw new InvalidArgumentError("--fail-under must be a number in 0..100");
  }
  return threshold;
}
