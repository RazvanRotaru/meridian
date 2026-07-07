import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1720, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => m.type() === "error" && errors.push(`console: ${m.text()}`));
await page.goto("http://127.0.0.1:4941", { waitUntil: "networkidle" });
await page.waitForSelector(".react-flow__node");
await page.dblclick('[data-id="ts:src"]');
await page.waitForSelector('[data-id="ts:src/services"]');
await page.dblclick('[data-id="ts:src/services"]');
await page.waitForSelector('[data-id="ts:src/services/orderService.ts"]');
await page.click("text=⊞ Expand all");
await page.waitForSelector('[data-id="ts:src/services/orderService.ts#OrderService.placeOrder"]');
// open placeOrder's flow, then SELECT its second step (the resolved PricingService.price call)
await page.click('[data-id="ts:src/services/orderService.ts#OrderService.placeOrder"] button');
await page.waitForSelector('[data-id^="step:"]');
const steps = await page.$$eval('[data-id^="step:"]', (ns) => ns.map((n) => n.getAttribute("data-id")));
await page.click(`[data-id="${steps[1]}"]`);
await page.waitForTimeout(500);
// The ghost definition should wear the selection border; its wire hidden; a guide arrow may pin the edge.
const ghostBorder = await page.$$eval(".react-flow__node", (ns) =>
  ns.filter((n) => !n.getAttribute("data-id").startsWith("ts:src/services") && !n.getAttribute("data-id").startsWith("step:"))
    .map((n) => [n.getAttribute("data-id"), n.querySelector("div")?.style.borderColor]),
);
console.log("ghost borders after step select:", JSON.stringify(ghostBorder, null, 1));
const hiddenWires = await page.$$eval(".react-flow__edge", (es) =>
  es.filter((e) => e.querySelector("path")?.style.opacity === "0").map((e) => e.getAttribute("data-id")));
console.log("withheld wires:", JSON.stringify(hiddenWires));
const arrows = await page.$$eval('button[title*="bring it into view"]', (bs) => bs.length);
console.log("edge-of-screen guide arrows:", arrows);
// Legend
await page.click("text=◫ Legend");
const legend = await page.textContent("text=Selection reads >> xpath=ancestor::div[1]");
console.log("legend open:", legend !== null);
await page.screenshot({ path: "/home/orocismaru/.claude/jobs/838247ac/tmp/verify-beacon.png" });
console.log("errors:", errors.length ? errors : "none");
await browser.close();
