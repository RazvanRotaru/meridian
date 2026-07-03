// Full-monorepo demo run: boot timing, top-level pills, dive into src, hot wires, drawer walk.
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
const [url = "http://localhost:4701", outDir = "./shots"] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1760, height: 1000 } });
page.on("pageerror", (e) => console.log("PAGEERROR:", String(e).slice(0, 300)));
const t0 = Date.now();
await page.goto(url, { waitUntil: "networkidle" });
await page.waitForSelector(".react-flow__node", { timeout: 180000 });
await page.waitForTimeout(1500);
console.log(`boot+first layout: ${Date.now() - t0}ms, nodes: ${await page.locator(".react-flow__node").count()}`);
await page.screenshot({ path: outDir + "/40-monorepo-top.png" });

let t = Date.now();
await page.evaluate(() => window.__MERIDIAN_STORE__.getState().diveInto("ts:src"));
await page.waitForFunction(() => window.__MERIDIAN_STORE__.getState().layoutStatus === "ready", { timeout: 180000 });
await page.waitForTimeout(1000);
console.log(`dive(src): ${Date.now() - t}ms, nodes: ${await page.locator(".react-flow__node").count()}, edges: ${await page.locator(".react-flow__edge").count()}`);
await page.screenshot({ path: outDir + "/41-src-dive.png" });

// Walk the diff from the first stop.
t = Date.now();
await page.evaluate(() => {
  const s = window.__MERIDIAN_STORE__.getState();
  const stopId = Object.keys(s.change.nodes).find((id) => id.includes("useMessageActions.ts#useBranchConversation"));
  s.expandPath(stopId); s.select(stopId); s.openDiff(stopId);
});
await page.waitForFunction(() => window.__MERIDIAN_STORE__.getState().layoutStatus === "ready", { timeout: 180000 });
await page.waitForTimeout(1800);
console.log(`reveal+drawer: ${Date.now() - t}ms`);
await page.screenshot({ path: outDir + "/42-drawer-branch.png" });
await page.keyboard.press("j");
await page.waitForFunction(() => window.__MERIDIAN_STORE__.getState().layoutStatus === "ready", { timeout: 180000 });
await page.waitForTimeout(1500);
await page.screenshot({ path: outDir + "/43-drawer-next.png" });
await browser.close();
