// Round verification: dive into Src, expand two packages, click a node to trace its path,
// click an edge, then clear. Screenshots at every step + console error capture.
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const [url = "http://localhost:4700", outDir = "./shots"] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1760, height: 1000 } });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String(e)));

await page.goto(url, { waitUntil: "networkidle" });
await page.waitForSelector(".react-flow__node", { timeout: 120000 });
await page.waitForTimeout(1500);
await page.screenshot({ path: join(outDir, "01-top.png") });

const nodeByTitle = (t) => page.locator(".react-flow__node", { hasText: t }).first();

// Dive into Src — the camera should auto-fit now (no manual fit click).
await nodeByTitle("Src").dblclick({ force: true });
await page.waitForTimeout(2600);
console.log(`dive(Src): nodes ${await page.locator(".react-flow__node").count()}, edges ${await page.locator(".react-flow__edge").count()}`);
await page.screenshot({ path: join(outDir, "02-dive-src.png") });

// Expand Services via its chevron — camera should follow.
await nodeByTitle("Services").getByRole("button", { name: "Expand" }).click({ force: true });
await page.waitForTimeout(3000);
console.log(`expand(Services): nodes ${await page.locator(".react-flow__node").count()}, edges ${await page.locator(".react-flow__edge").count()}`);
await page.screenshot({ path: join(outDir, "03-expand-services.png") });

// Click a leaf/collapsed node BODY (not header) to trace its path.
const target = page.locator(".react-flow__node", { hasText: "Store" }).first();
await target.click({ position: { x: 60, y: 40 }, force: true });
await page.waitForTimeout(900);
await page.screenshot({ path: join(outDir, "04-path-trace.png") });

// Clear via pane click.
await page.mouse.click(880, 60);
await page.waitForTimeout(600);
await page.screenshot({ path: join(outDir, "05-cleared.png") });

if (errors.length) console.log("CONSOLE ERRORS:\n" + errors.slice(0, 12).join("\n"));
await browser.close();
