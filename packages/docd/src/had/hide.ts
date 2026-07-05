// Hide `.docuzen/` from every repo the user works in via their GLOBAL git
// excludes file — never by touching a repo's .git/ or a committed .gitignore.
// Idempotent, best-effort: hiding must never break document opening.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const LINE = ".docuzen/";

/** Resolve the global git excludes file path (test override > git config > default). */
function excludesFile(): string {
  const override = process.env.DOCUZEN_GIT_EXCLUDES_FILE;
  if (override) return override;
  const r = spawnSync("git", ["config", "--get", "core.excludesFile"], { encoding: "utf8" });
  const configured = r.status === 0 ? r.stdout.trim() : "";
  if (configured) return configured.replace(/^~(?=\/|$)/, homedir());
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "git", "ignore");
}

export function ensureDocuzenHidden(): void {
  try {
    const file = excludesFile();
    const current = existsSync(file) ? readFileSync(file, "utf8") : "";
    if (current.split("\n").some((l) => l.trim() === LINE)) return;
    mkdirSync(dirname(file), { recursive: true });
    const sep = current.length && !current.endsWith("\n") ? "\n" : "";
    writeFileSync(file, `${current}${sep}${LINE}\n`, "utf8");
  } catch {
    // Best-effort: if we cannot write the global ignore, opening still proceeds.
  }
}
