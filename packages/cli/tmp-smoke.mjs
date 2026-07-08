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
await page.click('nav[aria-label="Containment level"] button[aria-label="Expand cards on this level"]');
await page.waitForSelector('[data-id="ts:src/services/orderService.ts#OrderService.placeOrder"]');
await page.waitForTimeout(600);
// steps stay closed; blocks expandable; open placeOrder then a step inside it
await page.click('[data-id="ts:src/services/orderService.ts#OrderService.placeOrder"] button');
await page.waitForSelector('[data-id^="step:ts:src/services/orderService.ts#OrderService.placeOrder"]');
const ghosts = await page.$$eval(".react-flow__node", (ns) => ns.map((n) => n.getAttribute("data-id")).filter((id) => !id.startsWith("ts:src/") || false).length);
// multi-select: ctrl+click two blocks, both selected
await page.click('[data-id="ts:src/services/orderService.ts#OrderService.getOrder"]');
await page.click('[data-id="ts:src/services/orderService.ts#OrderService.constructor"]', { modifiers: ["Control"] });
const selCount = await page.$$eval(".react-flow__node div", (ds) => ds.filter((d) => d.style.boxShadow.includes("107, 227, 138")).length);
console.log("multi-select highlighted nodes:", selCount, "| steps drawn:", await page.$$eval('[data-id^="step:"]', n => n.length), "| errors:", errors.length ? errors : "none");
await page.screenshot({ path: "/home/orocismaru/.claude/jobs/838247ac/tmp/verify-merge.png" });
await browser.close();
