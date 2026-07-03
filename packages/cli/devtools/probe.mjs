import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage();
page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") console.log(m.type().toUpperCase()+":", m.text().slice(0, 500)); });
page.on("pageerror", (e) => console.log("PAGEERROR:", String(e).slice(0, 800)));
await page.goto(process.argv[2] ?? "http://localhost:4700", { waitUntil: "networkidle" });
await page.waitForTimeout(6000);
console.log("body text:", (await page.locator("body").innerText()).slice(0, 300));
await browser.close();
