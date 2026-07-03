// Reproduce the "alambicat" full-graph state: dive into Src, expand several containers,
// then fit-view and screenshot the whole thing.
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const [url = "http://localhost:4700", outDir = "./shots", ...titles] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1760, height: 1000 } });
page.on("pageerror", (e) => console.log("PAGEERROR:", String(e)));

await page.goto(url, { waitUntil: "networkidle" });
await page.waitForSelector(".react-flow__node", { timeout: 120000 });
await page.waitForTimeout(800);

const nodeByTitle = (t) => page.locator(".react-flow__node", { hasText: t }).first();
const fit = async () => { await page.locator(".react-flow__controls-fitview").click(); await page.waitForTimeout(700); };

await nodeByTitle(titles[0] ?? "Src").dblclick({ force: true });
await page.waitForTimeout(2000);
await fit();
await page.screenshot({ path: join(outDir, "20-dive-fit.png") });
console.log(`dive+fit: nodes ${await page.locator(".react-flow__node").count()}, edges ${await page.locator(".react-flow__edge").count()}`);

let i = 0;
for (const child of titles.slice(1)) {
  const t = Date.now();
  await nodeByTitle(child).click({ position: { x: 14, y: 14 }, force: true });
  await page.waitForTimeout(2500);
  await fit();
  console.log(`expand(${child}): ${Date.now() - t}ms, nodes: ${await page.locator(".react-flow__node").count()}, edges: ${await page.locator(".react-flow__edge").count()}`);
  await page.screenshot({ path: join(outDir, `2${++i}-fit-${child.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.png`) });
}
await browser.close();
