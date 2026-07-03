// Round 3: dive, select a hub (direct trace), switch to full impact, open detail panel rows.
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
const census = () => page.evaluate(() => {
  const counts = { down: 0, up: 0, rest: 0, off: 0 };
  for (const path of document.querySelectorAll(".react-flow__edge path.react-flow__edge-path")) {
    const stroke = getComputedStyle(path).stroke;
    const opacity = parseFloat(getComputedStyle(path).opacity);
    if (stroke === "rgb(78, 225, 196)") counts.down += 1;
    else if (stroke === "rgb(167, 139, 250)") counts.up += 1;
    else if (opacity < 0.1) counts.off += 1;
    else counts.rest += 1;
  }
  return JSON.stringify(counts);
});

await nodeByTitle("Src").dblclick({ force: true });
await page.waitForTimeout(2800);

// Select the Store package (exact title match on its header text).
await page.locator(".react-flow__node").filter({ hasText: /^.*Store\s*53/ }).first().click({ position: { x: 80, y: 16 }, force: true });
await page.waitForTimeout(900);
console.log("direct trace:", await census());
await page.screenshot({ path: join(outDir, "10-direct.png") });

// Switch to full impact in the detail panel.
await page.getByRole("button", { name: "Full impact" }).click();
await page.waitForTimeout(900);
console.log("full trace:", await census());
await page.screenshot({ path: join(outDir, "11-full.png") });

// Walk the selection via the first OUT connection row.
const outRow = page.locator("button", { hasText: "→" }).first();
await outRow.click();
await page.waitForTimeout(900);
await page.screenshot({ path: join(outDir, "12-walked.png") });

if (errors.length) console.log("PAGE ERRORS:\n" + errors.slice(0, 8).join("\n"));
await browser.close();
