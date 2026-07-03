import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
const [url = "http://localhost:4700", outDir = "./shots"] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1760, height: 1000 } });
page.on("pageerror", (e) => console.log("PAGEERROR:", String(e).slice(0, 300)));
await page.goto(url, { waitUntil: "networkidle" });
await page.waitForSelector(".react-flow__node", { timeout: 60000 });
await page.waitForTimeout(1200);
// Select the changed hook module and add a comment via the panel UI.
await page.evaluate(() => {
  const s = window.__MERIDIAN_STORE__.getState();
  s.diveInto("ts:src");
});
await page.waitForTimeout(2500);
await page.evaluate(() => window.__MERIDIAN_STORE__.getState().select("ts:src/hooks"));
await page.waitForTimeout(800);
await page.getByPlaceholder("Add a review note…").fill("Branch flow: verificați că agenticApi.test.ts acoperă createSession cu parentMessageId — lipsește din PR.");
await page.getByRole("button", { name: "Comment", exact: true }).click();
await page.waitForTimeout(800);
await page.screenshot({ path: outDir + "/30-comment-added.png" });
// Badge check + persistence across reload.
const badge = await page.locator(".react-flow__node", { hasText: "Hooks" }).first().innerText();
console.log("hooks node text:", JSON.stringify(badge));
await page.reload({ waitUntil: "networkidle" });
await page.waitForSelector(".react-flow__node", { timeout: 60000 });
await page.waitForTimeout(1500);
const persisted = await page.evaluate(() => JSON.stringify(window.__MERIDIAN_STORE__.getState().comments));
console.log("persisted after reload:", persisted.slice(0, 160));
await browser.close();
