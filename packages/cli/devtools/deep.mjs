// Deep-dive scenario: expand/dive into the largest package and expand children.
// Usage: node deep.mjs <url> <outdir> <containerTitle> [expandChildren...]
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const [url = "http://localhost:4700", outDir = "./shots", title = "Src", ...children] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1760, height: 1000 } });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String(e)));

await page.goto(url, { waitUntil: "networkidle" });
await page.waitForSelector(".react-flow__node", { timeout: 120000 });
await page.waitForTimeout(800);

const nodeByTitle = (t) => page.locator(".react-flow__node", { hasText: t }).first();

// Dive INTO the target container (double-click its frame).
let t = Date.now();
await nodeByTitle(title).dblclick({ force: true });
await page.waitForTimeout(400);
await page.waitForFunction(() => document.querySelectorAll(".react-flow__node").length > 3, { timeout: 120000 }).catch(() => {});
await page.waitForTimeout(1500);
console.log(`dive(${title}): ${Date.now() - t}ms, nodes: ${await page.locator(".react-flow__node").count()}, edges: ${await page.locator(".react-flow__edge").count()}`);
await page.screenshot({ path: join(outDir, "10-dive.png") });

// Expand requested children by clicking their headers (toggle).
let i = 0;
for (const child of children) {
  t = Date.now();
  await nodeByTitle(child).click({ position: { x: 14, y: 14 }, force: true });
  await page.waitForTimeout(2200);
  console.log(`expand(${child}): ${Date.now() - t}ms, nodes: ${await page.locator(".react-flow__node").count()}, edges: ${await page.locator(".react-flow__edge").count()}`);
  await page.screenshot({ path: join(outDir, `1${++i}-expand-${child.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.png`) });
}

if (errors.length) console.log("CONSOLE ERRORS:\n" + errors.slice(0, 10).join("\n"));
await browser.close();
