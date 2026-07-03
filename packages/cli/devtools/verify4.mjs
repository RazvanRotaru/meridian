// Change-lens verification: pills at roll-up level, hot wires, drawer + j stepping.
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const [url = "http://localhost:4700", outDir = "./shots"] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1760, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

await page.goto(url, { waitUntil: "networkidle" });
await page.waitForSelector(".react-flow__node", { timeout: 120000 });
await page.waitForTimeout(1500);

const nodeByTitle = (t) => page.locator(".react-flow__node", { hasText: t }).first();

// Structural ops relayout asynchronously; wait until the node count stops moving, then let
// the fit animation land.
async function waitForStableNodeCount(target) {
  let previous = -1;
  for (let i = 0; i < 40; i += 1) {
    const count = await target.locator(".react-flow__node").count();
    if (count === previous && count > 0) {
      await target.waitForTimeout(900);
      return;
    }
    previous = count;
    await target.waitForTimeout(400);
  }
}

// Top level: Src should wear the rolled-up pill (+xxx −yy · 7Δ) and the RANGE row shows.
await page.screenshot({ path: join(outDir, "20-top-range.png") });

await nodeByTitle("Src").dblclick({ force: true });
await page.waitForTimeout(2800);
const hotCount = await page.evaluate(() => {
  let hot = 0;
  for (const path of document.querySelectorAll(".react-flow__edge path.react-flow__edge-path")) {
    if (getComputedStyle(path).stroke === "rgb(229, 83, 75)") hot += 1;
  }
  return hot;
});
console.log("hot wires at Src level:", hotCount);
await page.screenshot({ path: join(outDir, "21-dive-hot.png") });

// Expand Hooks, select useMessageActions.ts, open its diff.
await nodeByTitle("Hooks").getByRole("button", { name: "Expand" }).click({ force: true });
await waitForStableNodeCount(page);
await page.screenshot({ path: join(outDir, "22-hooks-expanded.png") });

// Deterministic selection via the exposed store (no brittle off-viewport clicks).
await page.evaluate(() => {
  window.__MERIDIAN_STORE__.getState().select("ts:src/hooks/useMessageActions.ts");
});
await page.waitForTimeout(900);
await page.screenshot({ path: join(outDir, "23-selected-changed.png") });

await page.getByRole("button", { name: /Open diff/ }).click();
await page.waitForTimeout(1500);
await page.screenshot({ path: join(outDir, "24-drawer.png") });

// Step with j twice.
await page.keyboard.press("j");
await page.waitForTimeout(1200);
await page.keyboard.press("j");
await page.waitForTimeout(1200);
await page.screenshot({ path: join(outDir, "25-drawer-stepped.png") });

if (errors.length) console.log("PAGE ERRORS:\n" + errors.slice(0, 8).join("\n"));
await browser.close();
