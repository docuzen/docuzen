// CodexRunner process lifecycle, driven through start()/cancel() with fake `codex`
// scripts: an early child exit must not crash docd, and cancel/timeout must leave
// nothing behind (no stray registrations, timers, processes or temp dirs).
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CodexRunner } from "../../src/agent/codex-runner.js";
import type { AgentContext, AgentEvent } from "../../src/agent/types.js";

const baseCtx: AgentContext = {
  docText: "# Doc",
  anchorExact: "Doc",
  surrounding: "# Doc",
  comment: "hi",
  stancePrompt: "Be brief.",
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await sleep(5);
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function message(text: string): string {
  return `echo '{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"${text}"}}'`;
}

let dir: string;
const pids: number[] = [];

function script(name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

function readPid(file: string): number {
  const pid = Number(readFileSync(file, "utf8").trim());
  pids.push(pid);
  return pid;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "docuzen-codex-life-"));
});

afterEach(() => {
  for (const pid of pids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("CodexRunner process lifecycle", () => {
  it("reports the failure when codex exits before reading a large prompt, instead of crashing docd", async () => {
    // A bad config or auth error makes codex exit at once; the prompt (here 8 MB, far
    // more than a pipe buffer) is still being written to its stdin, which then fails
    // with EPIPE. That stream error must not escape as an uncaught exception.
    const command = script("fake-codex-exit", "echo 'codex: bad config' >&2\nexit 2");
    const runner = new CodexRunner({ command });
    await expect(
      runner.start({ ...baseCtx, scopeDir: dir, docText: "x".repeat(8 * 1024 * 1024) }),
    ).rejects.toThrow(/Codex failed[\s\S]*bad config/);
  });

  it("a cancelled run that exits late does not unregister a retry using the same cancel key", async () => {
    // First launch ignores SIGTERM and exits a little later on its own; the retry
    // (same cancel key) runs long. Cancelling the retry must still work after the
    // first child's exit is processed.
    const firstPid = join(dir, "first.pid");
    const command = script(
      "fake-codex-retry",
      [
        `if [ ! -e ${JSON.stringify(firstPid)} ]; then`,
        `  echo $$ > ${JSON.stringify(firstPid)}`,
        "  trap '' TERM",
        "  cat > /dev/null",
        `  ${message("first")}`,
        "  sleep 0.3",
        "  exit 0",
        "fi",
        "cat > /dev/null",
        message("retry"),
        "exec sleep 3",
      ].join("\n"),
    );
    const runner = new CodexRunner({ command });

    const first: AgentEvent[] = [];
    const run1 = runner.start({ ...baseCtx, scopeDir: dir, cancelKey: "k" }, (e) => first.push(e));
    await waitFor(() => first.length > 0);
    const pid1 = readPid(firstPid);
    await runner.cancel("k");
    await expect(run1).rejects.toThrow(/cancelled/i);

    const retry: AgentEvent[] = [];
    const run2 = runner.start({ ...baseCtx, scopeDir: dir, cancelKey: "k" }, (e) => retry.push(e));
    run2.catch(() => {});
    await waitFor(() => retry.length > 0);
    await waitFor(() => !alive(pid1)); // the first child has now exited
    await sleep(100); // and its close event has been handled

    await runner.cancel("k");
    await expect(run2).rejects.toThrow(/cancelled/i);
  });

  it("kills a child that ignores SIGTERM once the grace period has passed", async () => {
    const pidFile = join(dir, "child.pid");
    const command = script(
      "fake-codex-stubborn",
      [`echo $$ > ${JSON.stringify(pidFile)}`, "trap '' TERM", "cat > /dev/null", message("working"), "exec sleep 30"].join(
        "\n",
      ),
    );
    const runner = new CodexRunner({ command, killGraceMs: 100 });
    const events: AgentEvent[] = [];
    const run = runner.start({ ...baseCtx, scopeDir: dir, cancelKey: "k" }, (e) => events.push(e));
    await waitFor(() => events.length > 0);
    const pid = readPid(pidFile);

    await runner.cancel("k");
    await expect(run).rejects.toThrow(/cancelled/i);
    expect(alive(pid)).toBe(true); // SIGTERM alone does not stop it
    await waitFor(() => !alive(pid), 2_000);
  });

  it("a cancelled run's timeout no longer fires: the child gets one SIGTERM, not a second", async () => {
    const pidFile = join(dir, "child.pid");
    const terms = join(dir, "terms.log");
    const command = script(
      "fake-codex-counts-terms",
      [
        `echo $$ > ${JSON.stringify(pidFile)}`,
        `trap 'echo term >> ${JSON.stringify(terms)}' TERM`,
        "cat > /dev/null",
        message("working"),
        "while :; do sleep 0.02; done",
      ].join("\n"),
    );
    const runner = new CodexRunner({ command, timeoutMs: 400, killGraceMs: 5_000 });
    const events: AgentEvent[] = [];
    const run = runner.start({ ...baseCtx, scopeDir: dir, cancelKey: "k" }, (e) => events.push(e));
    await waitFor(() => events.length > 0);
    readPid(pidFile);

    await runner.cancel("k");
    await expect(run).rejects.toThrow(/cancelled/i);
    await sleep(700); // well past timeoutMs
    expect(existsSync(terms) ? readFileSync(terms, "utf8").trim().split("\n") : []).toEqual(["term"]);
  });

  it("leaves no temp dir behind when the launch config cannot be resolved", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "docuzen-codex-tmp-"));
    const prev = process.env.TMPDIR;
    process.env.TMPDIR = tmp;
    try {
      const runner = new CodexRunner({ command: join(dir, "never-run") });
      await expect(runner.start({ ...baseCtx, scopeDir: dir, modelId: "docuzen/gpt" })).rejects.toThrow(
        /no model registry path/,
      );
      expect(readdirSync(tmp)).toEqual([]);
    } finally {
      if (prev === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = prev;
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
