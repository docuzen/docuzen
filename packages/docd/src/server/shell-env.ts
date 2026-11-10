// A desktop app started from Finder/Dock inherits launchd's bare environment, not the
// user's shell profile — so API keys exported in ~/.zshrc (which a harness CLI like codex,
// or a "$VAR" key reference in pi's models.json, depends on) are missing even though the
// same command works in a terminal. This asks the user's login shell for its environment
// once at startup and fills in what the process lacks.
import { execFile } from "node:child_process";
import { userInfo } from "node:os";

const MARK = "__DOCD_SHELL_ENV__";
/** Shell bookkeeping that describes the probe shell, not the user's configuration. */
const SKIP = new Set(["_", "PWD", "OLDPWD", "SHLVL", "PS1", "PROMPT", "TERM"]);

/** Extract the JSON env dump from shell output that may carry rc-file noise around it. */
export function parseShellEnvOutput(stdout: string): Record<string, string> | null {
  const start = stdout.indexOf(MARK);
  const end = stdout.lastIndexOf(MARK);
  if (start < 0 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(stdout.slice(start + MARK.length, end));
    if (!parsed || typeof parsed !== "object") return null;
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) if (typeof v === "string") env[k] = v;
    return env;
  } catch {
    return null;
  }
}

/**
 * Merge a shell environment into `target`. Values already set win (an explicit launch
 * environment is deliberate); PATH is the exception — the shell's entries go first, the
 * existing ones are kept after them, so CLIs resolve the way they do in the terminal.
 * Returns the names that were added.
 */
export function mergeShellEnv(target: NodeJS.ProcessEnv, shellEnv: Record<string, string>): string[] {
  const added: string[] = [];
  for (const [k, v] of Object.entries(shellEnv)) {
    if (SKIP.has(k)) continue;
    if (k === "PATH") {
      const parts = [...v.split(":"), ...(target.PATH ?? "").split(":")].filter(Boolean);
      target.PATH = [...new Set(parts)].join(":");
      continue;
    }
    if (target[k] === undefined || target[k] === "") {
      target[k] = v;
      added.push(k);
    }
  }
  return added;
}

/** Ask the login shell for its environment. Resolves null on any failure — never throws. */
export function readShellEnv(opts: { shell?: string; timeoutMs?: number } = {}): Promise<Record<string, string> | null> {
  let shell = opts.shell ?? process.env.SHELL;
  if (!shell) {
    try {
      shell = userInfo().shell ?? undefined;
    } catch {
      /* no passwd entry */
    }
  }
  shell ||= "/bin/zsh";
  // Interactive + login, so both profile and rc files run (keys usually live in ~/.zshrc).
  // The dump is printed by this same Node binary, so no shell-specific quoting of values.
  const dump = `'${process.execPath}' -e 'process.stdout.write("${MARK}"+JSON.stringify(process.env)+"${MARK}")'`;
  const args = /\/(t?csh)$/.test(shell) ? ["-ic", dump] : ["-ilc", dump];
  return new Promise((resolve) => {
    const child = execFile(
      shell,
      args,
      { timeout: opts.timeoutMs ?? 5000, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" },
      (err, stdout) => resolve(err && !stdout ? null : parseShellEnvOutput(stdout)),
    );
    child.stdin?.end(); // an rc file that prompts must not hang startup
  });
}

/** Load the shell environment into process.env when the launcher asks for it. */
export async function loadShellEnvIfRequested(): Promise<void> {
  if (process.env.DOCD_LOAD_SHELL_ENV !== "1") return;
  const t0 = Date.now();
  const shellEnv = await readShellEnv();
  if (!shellEnv) {
    console.error("docd: could not read the login shell environment; using the launch environment as-is");
    return;
  }
  const added = mergeShellEnv(process.env, shellEnv);
  // Names only — never values.
  console.error(`docd: loaded ${added.length} variable(s) from the login shell in ${Date.now() - t0}ms`);
}
