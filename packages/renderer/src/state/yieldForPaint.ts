/**
 * Let React commit a pending busy state and let the browser paint it before a main-thread graph
 * derivation starts. A single animation-frame callback still runs before paint; handing off to a
 * task from that callback gives the browser an opportunity to present the frame in between. A
 * bounded timer is independent of animation frames, which browsers may suspend for a background
 * tab; the loading action must never stay active merely because rAF was throttled.
 */
export function yieldForPaint(): Promise<void> {
  if (typeof globalThis.requestAnimationFrame !== "function") {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      globalThis.clearTimeout(fallback);
      resolve();
    };
    const fallback = globalThis.setTimeout(finish, 100);
    globalThis.requestAnimationFrame(() => {
      globalThis.setTimeout(finish, 0);
    });
  });
}
