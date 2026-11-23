// The sidecar entrypoint's launch-token contract, against the real process:
// - with DOCD_TOKEN set (the app shell), that token is required and never printed;
// - without it (dev tools), docd makes one and prints `DOCD_TOKEN=` before `DOCD_PORT=`.
import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const tsx = resolve(pkgDir, "..", "..", "node_modules", "tsx", "dist", "cli.mjs");
let child: ChildProcess | undefined;

afterEach(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((r) => child!.once("exit", r));
    child.kill("SIGTERM");
    await exited;
  }
  child = undefined;
});

/** Start docd and resolve its stdout up to and including the DOCD_PORT line. */
function startDocd(env: Record<string, string | undefined>): Promise<{ out: string; port: number }> {
  const home = mkdtempSync(join(tmpdir(), "docd-main-home-"));
  const config = mkdtempSync(join(tmpdir(), "docd-main-config-"));
  writeFileSync(join(config, "config.toml"), '[harness]\ndefault = "pi"\n');
  const base: Record<string, string | undefined> = {
    ...process.env,
    HOME: home,
    DOCUZEN_CONFIG_DIR: config,
    CODEX_BIN: join(home, "no-codex"),
    LLM_API_KEY: undefined,
    DOCD_LOAD_SHELL_ENV: undefined,
    DOCD_TOKEN: undefined,
    ...env,
  };
  const p = spawn(process.execPath, [tsx, join(pkgDir, "src", "server", "main.ts"), "--port", "0"], {
    env: Object.fromEntries(Object.entries(base).filter(([, v]) => v !== undefined)) as NodeJS.ProcessEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child = p;
  return new Promise((res, rej) => {
    let out = "";
    let err = "";
    p.stderr!.on("data", (d) => (err += d));
    p.stdout!.on("data", (d) => {
      out += d;
      const m = /^DOCD_PORT=(\d+)\r?\n/m.exec(out);
      if (m) res({ out, port: Number(m[1]) });
    });
    p.on("exit", (code) => rej(new Error(`docd exited ${code}\n${out}\n${err}`)));
  });
}

function upgrade(port: number, token?: string): Promise<"open" | number> {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${token === undefined ? "" : `/?token=${token}`}`);
    ws.on("open", () => {
      ws.close();
      res("open");
    });
    ws.on("unexpected-response", (_q, r) => {
      r.resume();
      res(r.statusCode ?? 0);
    });
    ws.on("error", rej);
  });
}

describe("docd entrypoint", () => {
  it("uses the token it is given, and never prints it", async () => {
    const token = "a".repeat(64);
    const { out, port } = await startDocd({ DOCD_TOKEN: token });
    expect(out).not.toContain("DOCD_TOKEN=");
    expect(out).not.toContain(token);
    expect(await upgrade(port)).toBe(401);
    expect(await upgrade(port, "b".repeat(64))).toBe(401);
    expect(await upgrade(port, token)).toBe("open");
  }, 30_000);

  it("without one, makes a 256-bit token and prints it before the port", async () => {
    const { out, port } = await startDocd({});
    const lines = out.split(/\r?\n/);
    const tokenLine = lines.findIndex((l) => l.startsWith("DOCD_TOKEN="));
    const portLine = lines.findIndex((l) => l.startsWith("DOCD_PORT="));
    expect(tokenLine).toBeGreaterThanOrEqual(0);
    expect(tokenLine).toBeLessThan(portLine);
    const token = lines[tokenLine].slice("DOCD_TOKEN=".length);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(await upgrade(port)).toBe(401);
    expect(await upgrade(port, token)).toBe("open");
  }, 30_000);
});
