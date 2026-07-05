// Hide `.docuzen/` from every repo the user works in via their GLOBAL git
// excludes file — never by touching a repo's .git/ or a committed .gitignore.
// Idempotent, best-effort: hiding must never break document opening.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const LINE = ".docuzen/";

let cachedConfigured: string | undefined; // undefined = not queried yet this process

function gitExcludesFromConfig(): string {
  if (cachedConfigured !== undefined) return cachedConfigured;
  // Prefer the user's GLOBAL setting (the design's "global ignore"); fall back
  // to merged config (honors a system-level setting) — never a repo-local one
  // that would silently leave .docuzen/ visible in every other repo.
  const global = spawnSync("git", ["config", "--global", "--get", "core.excludesFile"], { encoding: "utf8" });
  let v = global.status === 0 ? global.stdout.trim() : "";
  if (!v) {
    const merged = spawnSync("git", ["config", "--get", "core.excludesFile"], { encoding: "utf8" });
    v = merged.status === 0 ? merged.stdout.trim() : "";
  }
  cachedConfigured = v;
  return v;
}

/** Resolve the global git excludes file path (test override > git config > default). */
function excludesFile(): string {
  const override = process.env.DOCUZEN_GIT_EXCLUDES_FILE;
  if (override) return override;
  const configured = gitExcludesFromConfig();
  if (configured) return configured.replace(/^~(?=\/|$)/, homedir());
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "git", "ignore");
}

const ensured = new Set<string>();
export function ensureDocuzenHidden(): void {
  try {
    const file = excludesFile();
    if (ensured.has(file)) return;
    const current = existsSync(file) ? readFileSync(file, "utf8") : "";
    if (!current.split("\n").some((l) => l.trim() === LINE)) {
      mkdirSync(dirname(file), { recursive: true });
      const sep = current.length && !current.endsWith("\n") ? "\n" : "";
      writeFileSync(file, `${current}${sep}${LINE}\n`, "utf8");
    }
    ensured.add(file);
  } catch {
    // Best-effort: if we cannot write the global ignore, opening still proceeds.
  }
}
