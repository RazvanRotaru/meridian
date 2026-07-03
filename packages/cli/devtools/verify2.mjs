// Round 3 verification with DOM assertions on the path-trace colours.
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

await nodeByTitle("Src").dblclick({ force: true });
await page.waitForTimeout(2800);
await page.screenshot({ path: join(outDir, "02-dive-src.png") });

// Click the exact node whose title is "Store" (package) — body click = select.
const store = page.locator('.react-flow__node:has-text("Store")').filter({ hasNot: page.locator("text=/Sync|Restore/") }).first();
await store.click({ position: { x: 80, y: 16 }, force: true });
await page.waitForTimeout(1000);

const strokes = await page.evaluate(() => {
  const counts = { down: 0, up: 0, rest: 0, off: 0, other: 0 };
  for (const path of document.querySelectorAll(".react-flow__edge path.react-flow__edge-path")) {
    const stroke = getComputedStyle(path).stroke;
    const opacity = parseFloat(getComputedStyle(path).opacity);
    if (stroke === "rgb(78, 225, 196)") counts.down += 1;
    else if (stroke === "rgb(167, 139, 250)") counts.up += 1;
    else if (opacity < 0.1) counts.off += 1;
    else counts.rest += 1;
  }
  return counts;
});
console.log("edge stroke census after select:", JSON.stringify(strokes));
const dimmedNodes = await page.evaluate(() => {
  let dim = 0, lit = 0;
  for (const el of document.querySelectorAll(".react-flow__node > div")) {
    const opacity = parseFloat(getComputedStyle(el).opacity);
    if (opacity < 0.5) dim += 1; else lit += 1;
  }
  return { dim, lit };
});
console.log("node dim census:", JSON.stringify(dimmedNodes));
await page.screenshot({ path: join(outDir, "04-path-trace.png") });

// Zoom into the selected region for a close-up of the lit path.
await page.locator(".react-flow__controls-zoomin").click();
await page.locator(".react-flow__controls-zoomin").click();
await page.waitForTimeout(500);
await page.screenshot({ path: join(outDir, "05-path-zoom.png") });

if (errors.length) console.log("PAGE ERRORS:\n" + errors.slice(0, 8).join("\n"));
await browser.close();
