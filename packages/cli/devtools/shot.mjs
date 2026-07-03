// Screenshot driver for meridian renderer iterations.
// Usage: node shot.mjs <url> <outdir> [scenario]
// Scenarios: baseline (default) = load + expand-first-container + dive-in
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const [url = "http://localhost:4700", outDir = "./shots", scenario = "baseline"] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1760, height: 1000 } });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String(e)));

const t0 = Date.now();
await page.goto(url, { waitUntil: "networkidle" });
// Wait for layout: React Flow nodes appear once ELK finishes.
await page.waitForSelector(".react-flow__node", { timeout: 120000 });
await page.waitForTimeout(1200);
console.log(`first-layout: ${Date.now() - t0}ms, nodes on screen: ${await page.locator(".react-flow__node").count()}, edges: ${await page.locator(".react-flow__edge").count()}`);
await page.screenshot({ path: join(outDir, "01-top.png") });

if (scenario === "baseline") {
  // Expand the first visible container via its header chevron (single click on header toggles).
  const header = page.locator(".react-flow__node").first();
  await header.dblclick({ position: { x: 10, y: 10 }, force: true }).catch(() => {});
  const t1 = Date.now();
  await page.waitForTimeout(2500);
  console.log(`after-dblclick: ${Date.now() - t1}ms, nodes: ${await page.locator(".react-flow__node").count()}`);
  await page.screenshot({ path: join(outDir, "02-dive.png") });

  // Try expanding via header click (expand/collapse toggle) on first container.
  const first = page.locator(".react-flow__node").first();
  await first.click({ position: { x: 12, y: 12 }, force: true }).catch(() => {});
  await page.waitForTimeout(2500);
  console.log(`after-expand: nodes: ${await page.locator(".react-flow__node").count()}`);
  await page.screenshot({ path: join(outDir, "03-expand.png") });
}

if (errors.length) console.log("CONSOLE ERRORS:\n" + errors.slice(0, 10).join("\n"));
await browser.close();
