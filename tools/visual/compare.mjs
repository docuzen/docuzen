// Pixel-level baseline comparison via pixelmatch. Deliberately more forgiving
// than "byte identical": headless Chromium's own text/subpixel antialiasing
// can shift by a pixel or two between otherwise-identical runs, and this
// suite cares about catching real regressions (e.g. a table cell going
// near-black) — not chasing font-rendering jitter to zero.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";

// pixelmatch's own per-pixel color-distance sensitivity (0..1, lower = stricter).
const PIXEL_THRESHOLD = 0.1;
// Fraction of the image's pixels allowed to differ before the state fails.
// Loose enough to absorb antialiasing jitter, tight enough that a whole
// table going near-black (thousands of pixels) always fails.
const MAX_DIFF_RATIO = 0.004;

/**
 * Compare `currentPath` against `baselinePath`. On mismatch (or size
 * mismatch), writes a red-highlighted diff PNG to `diffPath`.
 * Returns { pass, reason } | { pass, mismatched, total, ratio }.
 */
export function compareImage(baselinePath, currentPath, diffPath) {
  let baselineBuf, currentBuf;
  try {
    baselineBuf = readFileSync(baselinePath);
  } catch {
    return { pass: false, reason: `no baseline at ${baselinePath} — run with --update first` };
  }
  currentBuf = readFileSync(currentPath); // let this throw; a missing current screenshot is a real bug in the capture step

  const baseline = PNG.sync.read(baselineBuf);
  const current = PNG.sync.read(currentBuf);
  if (baseline.width !== current.width || baseline.height !== current.height) {
    return {
      pass: false,
      reason: `size mismatch: baseline ${baseline.width}x${baseline.height} vs current ${current.width}x${current.height}`,
    };
  }

  const { width, height } = baseline;
  const diff = new PNG({ width, height });
  const mismatched = pixelmatch(baseline.data, current.data, diff.data, width, height, {
    threshold: PIXEL_THRESHOLD,
  });
  const total = width * height;
  const ratio = mismatched / total;
  const pass = ratio <= MAX_DIFF_RATIO;
  if (!pass) {
    mkdirSync(dirname(diffPath), { recursive: true });
    writeFileSync(diffPath, PNG.sync.write(diff));
  }
  return { pass, mismatched, total, ratio };
}
