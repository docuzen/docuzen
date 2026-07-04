// Shared helpers for the visual-regression suite: stage the fixture doc into
// a scratch temp dir (so the running docd sidecar's `.had/` writes never
// touch the committed fixture) and re-export the same sidecar+Vite launcher
// tools/parity/run.mjs uses — `launchTree` only cares about a repo root and a
// doc path, nothing parity-specific, so this suite reuses it rather than
// forking a second copy.
import { mkdtemp, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";

export { launchTree } from "../parity/launch.mjs";

const tempDirs = [];

/**
 * Copy `fixtureAbsPath` into a fresh temp dir. Unlike tools/parity's
 * `stageDoc`, this reads straight off disk instead of `git show HEAD:...` —
 * parity needs HEAD because its sample docs accumulate incidental local
 * edits from manual app sessions; this suite's fixtures live only under
 * tools/visual/fixtures/ and are never opened+saved outside of a temp copy,
 * so the working tree IS the source of truth and there's no need to require
 * a commit before `node tools/visual/run.mjs` can pick up a fixture edit.
 */
export async function stageFixture(fixtureAbsPath) {
  const dir = await mkdtemp(join(tmpdir(), "visual-"));
  tempDirs.push(dir);
  const dst = join(dir, basename(fixtureAbsPath));
  await copyFile(fixtureAbsPath, dst);
  return dst;
}

export async function cleanupStaged() {
  const dirs = tempDirs.splice(0, tempDirs.length);
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
}

/** Screenshot with focus cleared (kills caret blink) and CSS animations/
 * transitions frozen to their end state (kills the chat spinner's pulse) —
 * both are real sources of frame-to-frame flake in a pixel-diffed suite. */
export async function shoot(page, outDir, name) {
  await page.evaluate(() => {
    const el = document.activeElement;
    if (el && typeof el.blur === "function") el.blur();
  });
  await page.screenshot({ path: `${outDir}/${name}.png`, fullPage: true, animations: "disabled" });
}
