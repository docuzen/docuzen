// Launches one tree's docd sidecar + Vite dev server for parity runs.
// The sidecar picks its own port (--port 0) and announces it on stdout;
// Vite gets an explicit port so the two trees never collide.
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";

const execFileAsync = promisify(execFile);

function waitForLine(child, pattern, timeoutMs = 30_000) {
  return new Promise((res, rej) => {
    let buf = "";
    const onData = (d) => {
      buf += d.toString();
      const m = buf.match(pattern);
      if (m) settle(() => res(m));
    };
    const onExit = (code) => settle(() => rej(new Error(`exited ${code} before ${pattern}`)));
    const t = setTimeout(() => settle(() => rej(new Error(`timeout waiting for ${pattern}`))), timeoutMs);
    function settle(fn) {
      clearTimeout(t);
      child.stdout.off("data", onData);
      child.off("exit", onExit);
      fn();
    }
    child.stdout.on("data", onData);
    child.on("exit", onExit);
  });
}

// Send SIGTERM and wait for the child to actually exit before returning, so
// callers that reuse a fixed port (e.g. Vite's --strictPort) for the next
// scenario don't race the old process's shutdown. Falls back to SIGKILL if
// the child hasn't exited within timeoutMs.
function terminate(child, timeoutMs = 5_000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.once("exit", () => {
      clearTimeout(t);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

// Temp dirs created by stageDoc, removed by cleanupTempDirs() at the end of
// the run.
const tempDirs = [];

export async function cleanupTempDirs() {
  const dirs = tempDirs.splice(0, tempDirs.length);
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
}

async function waitForHttp(url, timeoutMs = 30_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try { const r = await fetch(url); if (r.ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timeout waiting for ${url}`);
}

/**
 * Stage a sample doc into a fresh temp dir so each side's .had state is isolated.
 * Reads the file's committed HEAD content via `git show` rather than the working
 * tree — a tree's working copy can carry incidental local edits (e.g. from a
 * manual app session against a sample doc), and those must not leak into the
 * parity baseline as a false mismatch.
 */
export async function stageDoc(tree, sampleRel) {
  const dir = await mkdtemp(join(tmpdir(), "parity-"));
  tempDirs.push(dir);
  const dst = join(dir, basename(sampleRel));
  const { stdout } = await execFileAsync(
    "git", ["show", `HEAD:${sampleRel}`],
    { cwd: tree, encoding: "buffer", maxBuffer: 10 * 1024 * 1024 },
  );
  await writeFile(dst, stdout);
  return dst;
}

/**
 * A throwaway HOME for the sidecar holding a minimal app config, so a run never depends on
 * (or touches) the developer's machine:
 *  - `~/.docuzen/config.toml` names a harness, so the first-run setup modal never opens
 *    (it covers the UI and swallows every scripted click on a machine without a config);
 *  - there is no `~/.pi/agent/models.json`, so pi is deterministically offline and any
 *    agent call fails fast with the same message everywhere — no accidental live LLM call
 *    because the developer happens to have a model with a stored key;
 *  - the global git-excludes write (had/hide.ts) lands in the temp HOME, not the real one.
 */
async function hermeticHome() {
  const home = await mkdtemp(join(tmpdir(), "docuzen-tools-home-"));
  tempDirs.push(home);
  await mkdir(join(home, ".docuzen"), { recursive: true });
  await writeFile(join(home, ".docuzen", "config.toml"), '[harness]\ndefault = "pi"\n');
  return home;
}

/**
 * `realConfig: true` runs the sidecar against the developer's own HOME/config instead —
 * only tools/demo wants that (it records a live agent turn).
 */
export async function launchTree(tree, { vitePort, docPath, realConfig = false }) {
  const env = { ...process.env, VITE_DOCD_PORT: "0", VITE_DOC_PATH: docPath };
  const sidecarEnv = { ...env };
  if (!realConfig) {
    delete sidecarEnv.LLM_API_KEY; // deterministic: agent harness unavailable on both sides
    delete sidecarEnv.DOCUZEN_CONFIG_DIR;
    sidecarEnv.HOME = await hermeticHome();
    // Comment cards show the author; pin it so screenshots/reports don't bake in the
    // OS username of whoever recorded them.
    sidecarEnv.DOCUZEN_AUTHOR = "reviewer";
  }

  const sidecar = spawn("npx", ["tsx", "packages/docd/src/server/main.ts", "--port", "0"],
    { cwd: tree, env: sidecarEnv, stdio: ["ignore", "pipe", "inherit"] });
  let port;
  try {
    [, port] = await waitForLine(sidecar, /DOCD_PORT=(\d+)/);
  } catch (e) {
    await terminate(sidecar); // never got to spawn vite; only the sidecar can be leaked here
    throw e;
  }

  const vite = spawn("npx", ["vite", "--port", String(vitePort), "--strictPort"],
    { cwd: join(tree, "apps/desktop"), env, stdio: ["ignore", "pipe", "inherit"] });
  try {
    await waitForHttp(`http://127.0.0.1:${vitePort}/`);
  } catch (e) {
    await Promise.all([terminate(sidecar), terminate(vite)]);
    throw e;
  }

  return {
    url: `http://127.0.0.1:${vitePort}/?docdPort=${port}`,
    stop() { return Promise.all([terminate(sidecar), terminate(vite)]); },
  };
}
