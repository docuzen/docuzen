// Reconnect drill: boot app, kill sidecar, assert amber status, restart sidecar,
// assert green + a working RPC (search still returns counts) — all without reload.
import { chromium } from "playwright";
import { spawn } from "node:child_process";

const WT = new URL("../..", import.meta.url).pathname;
function startSidecar() {
  const child = spawn("npx", ["tsx", "packages/docd/src/server/main.ts", "--port", "8337"],
    { cwd: WT, env: { ...process.env, LLM_API_KEY: "" }, stdio: ["ignore", "pipe", "inherit"], detached: true });
  return new Promise((res, rej) => {
    let buf = "";
    child.stdout.on("data", d => { buf += d; if (buf.includes("DOCD_PORT=")) res(child); });
    child.on("exit", c => rej(new Error("sidecar died " + c)));
    setTimeout(() => rej(new Error("sidecar start timeout")), 20000);
  });
}

let sidecar = await startSidecar();
const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();
await page.goto("http://127.0.0.1:4600/?docdPort=8337");
await page.waitForFunction(() => (document.querySelector("#log")?.textContent ?? "").includes("editor mounted"), null, { timeout: 20000 });
// Docname readiness now comes from the active tab label — the topbar's
// separate `#docname` subtitle was removed as redundant with the tab strip.
await page.waitForFunction(() => {
  const el = document.querySelector("#tabs .tab.active .tname");
  return !!el && el.textContent !== "";
}, null, { timeout: 15000 });
const status = () => page.locator("#connStatus").innerText();
console.log("boot status:", await status());

process.kill(-sidecar.pid, "SIGKILL"); // group-kill: npx wraps the real server
await page.waitForFunction(() => /reconnect/i.test(document.querySelector("#connStatus")?.textContent ?? ""), null, { timeout: 15000 });
console.log("after kill:", await status());

sidecar = await startSidecar();
await page.waitForFunction(() => !/reconnect|disconnect/i.test(document.querySelector("#connStatus")?.textContent ?? ""), null, { timeout: 20000 });
console.log("after restart:", await status());

// prove RPC works post-reconnect without reload: open search and get a real count
await page.locator("#searchBtn").click();
await page.locator("#searchInput").fill("the");
await page.waitForFunction(() => {
  const c = document.querySelector("#searchCount")?.textContent ?? "";
  return c !== "Type to search" && c.trim() !== "";
}, null, { timeout: 10000 });
console.log("post-reconnect search count:", await page.locator("#searchCount").textContent());

try { process.kill(-sidecar.pid, "SIGTERM"); } catch {}
await browser.close();
console.log("DRILL OK");
