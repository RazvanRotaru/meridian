/**
 * Best-effort fetch of the git-history behavior report (`--behavior`). The payload is UNTRUSTED
 * — it carries git-derived file paths — so it goes through `parseBehavior`'s strict shape guard,
 * and every failure mode (no URL, HTTP error, bad JSON, malformed shape) resolves to null: the
 * app simply shows no behavior data, mirroring `loadEnvironments`' never-throw posture.
 */

import { parseBehavior, type BehaviorData } from "../derive/behavior";

export async function loadBehavior(behaviorUrl: string | null): Promise<BehaviorData | null> {
  if (behaviorUrl === null) {
    return null;
  }
  try {
    const response = await fetch(behaviorUrl);
    if (!response.ok) {
      return null;
    }
    return parseBehavior(await response.json());
  } catch {
    return null;
  }
}
