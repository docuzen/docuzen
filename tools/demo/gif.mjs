// Deterministic video -> animated GIF via a two-pass ffmpeg palette (best
// quality for GIF's 256-color limit). Optional trim (start/end seconds) and
// playback speed (setpts) let the caller tighten a recording after the fact.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function run(args) {
  const r = spawnSync("ffmpeg", args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`ffmpeg failed (${r.status}): ${r.stderr?.slice(-600) ?? ""}`);
}

export function gifFromVideo(inPath, outPath, opts = {}) {
  const { fps = 15, width = 820, speed = 1, start, end, cropBottom = 0 } = opts;
  const trim = [];
  if (start != null) trim.push("-ss", String(start));
  if (end != null) trim.push("-to", String(end));
  const pts = speed !== 1 ? `setpts=${(1 / speed).toFixed(4)}*PTS,` : "";
  // cropBottom drops N px off the bottom (e.g. an app status bar carrying a
  // machine-local path) before scaling. Applied on the source geometry.
  const crop = cropBottom > 0 ? `crop=in_w:in_h-${cropBottom}:0:0,` : "";
  const chain = `${pts}${crop}fps=${fps},scale=${width}:-1:flags=lanczos`;

  const work = mkdtempSync(join(tmpdir(), "gifpal-"));
  const palette = join(work, "palette.png");
  try {
    run([...trim, "-i", inPath, "-vf", `${chain},palettegen=stats_mode=diff`, "-y", palette]);
    run([...trim, "-i", inPath, "-i", palette, "-lavfi", `${chain}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3`, "-y", outPath]);
    return outPath;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
