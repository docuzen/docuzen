import { test, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { gifFromVideo } from "./gif.mjs";

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

test.skipIf(!hasFfmpeg)("gifFromVideo writes a valid animated GIF", () => {
  const dir = mkdtempSync(join(tmpdir(), "gif-"));
  const src = join(dir, "src.webm");
  // 2s synthetic test video, no external assets.
  const gen = spawnSync("ffmpeg", ["-f", "lavfi", "-i", "testsrc=duration=2:size=320x240:rate=10", "-y", src]);
  expect(gen.status).toBe(0);

  const out = join(dir, "out.gif");
  const res = gifFromVideo(src, out, { fps: 10, width: 160 });
  expect(res).toBe(out);
  expect(existsSync(out)).toBe(true);
  // GIF magic header.
  expect(readFileSync(out).subarray(0, 6).toString("latin1")).toMatch(/^GIF8[79]a$/);
});
