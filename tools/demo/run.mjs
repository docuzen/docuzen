// Records the README hero GIF: boots one real sidecar+Vite tree (default
// harness = Codex), drives the review flow (flow.mjs) while Playwright records
// video, then converts the .webm to docs/media/demo.gif via ffmpeg.
//
//   node tools/demo/run.mjs                 # record + write docs/media/demo.gif
//   node tools/demo/run.mjs --speed 1.3     # speed the final GIF (tighten dwell)
//   node tools/demo/run.mjs --start 1 --end 24   # trim seconds off the recording
import { chromium } from "playwright";
import { mkdir, readdir, rm } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchTree, stageFixture, cleanupStaged } from "../visual/support.mjs";
import { driveDemo } from "./flow.mjs";
import { gifFromVideo } from "./gif.mjs";

// apps/desktop/vite.config.ts binds to `host: process.env.TAURI_DEV_HOST || false`.
// With it unset, Vite listens on localhost/::1 (IPv6), which launchTree's
// 127.0.0.1 HTTP poll can't reach on IPv6-first hosts (Node 25). Pin the bind
// host to IPv4 so launchTree sees Vite come up.
process.env.TAURI_DEV_HOST ??= "127.0.0.1";

// The comment author defaults to the OS username; pin a neutral name so the
// recorded review card doesn't bake a machine-local identity into the GIF.
process.env.DOCUZEN_AUTHOR ??= "you";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const fixture = resolve(here, "fixtures/demo.md");
const VITE_PORT = 4620; // distinct from tools/visual (4610) and tools/parity (4501/4502)

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const n = Number(process.argv[i + 1]);
  return Number.isFinite(n) ? n : def;
}

async function main() {
  const outDir = resolve(here, "out");
  const videoDir = join(outDir, "video");
  await rm(outDir, { recursive: true, force: true });
  await mkdir(videoDir, { recursive: true });
  const gifPath = resolve(repoRoot, "docs/media/demo.gif");
  await mkdir(dirname(gifPath), { recursive: true });

  const docPath = await stageFixture(fixture);
  const srv = await launchTree(repoRoot, { vitePort: VITE_PORT, docPath });
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({
      viewport: { width: 1400, height: 900 },
      recordVideo: { dir: videoDir, size: { width: 1400, height: 900 } },
    });
    const page = await ctx.newPage();
    await driveDemo(page, srv.url);
    await ctx.close(); // finalizes the .webm
    const [webm] = (await readdir(videoDir)).filter((f) => f.endsWith(".webm"));
    if (!webm) throw new Error("no video recorded");
    gifFromVideo(join(videoDir, webm), gifPath, {
      fps: 15, width: 820,
      // cropBottom drops the app status bar (which renders the staged doc's
      // machine-local temp path); start default skips the boot "reconnecting" flash.
      cropBottom: 28,
      speed: arg("speed", 1),
      start: arg("start", 1),
      end: arg("end", undefined),
    });
    console.log(`[demo] wrote ${gifPath}`);
  } finally {
    await browser.close();
    await srv.stop();
    await cleanupStaged();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
