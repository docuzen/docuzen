import { join, relative, resolve, isAbsolute } from "node:path";
import { resolveHadDir } from "./resolve.js";

export interface HadPaths {
  dir: string;
  manifest: string;
  annotations: string;
  proposals: string;
  threadsDir: string;
  sessionsDir: string;
  versionsDir: string;
  versionsIndex: string;
  /** Images dropped into the document (see assets.ts). */
  assetsDir: string;
  stateDb: string;
  settings: string;
  threadFile: (id: string) => string;
  sessionFile: (id: string) => string;
  versionFile: (id: string) => string;
  versionAnnotationsFile: (id: string) => string;
}

// Ids reach these paths from RPC params and from files inside an imported .hadz, so they
// are checked against exactly the forms the code itself hands out:
//  - threads/sessions: annotation ids "c0001" (annotations.ts), inline directives
//    "directive-1" and the review-pass umbrella "review" (orchestrator.ts);
//  - versions: "v0001" (versions.ts).
const THREAD_ID = /^(?:c\d+|directive-\d+|review)$/;
const VERSION_ID = /^v\d+$/;

/** True for an id the code could have generated for a thread (and its session). */
export function isThreadId(id: unknown): id is string {
  return typeof id === "string" && THREAD_ID.test(id);
}

/** True for an id the code could have generated for a version. */
export function isVersionId(id: unknown): id is string {
  return typeof id === "string" && VERSION_ID.test(id);
}

/**
 * `dir/name`, refusing any name that would resolve outside `dir` (a `..` segment, a
 * separator, an absolute path). Every file the store builds from outside input goes
 * through here.
 */
export function childPath(dir: string, name: string): string {
  const path = join(dir, name);
  const rel = relative(resolve(dir), resolve(path));
  if (!rel || rel.startsWith("..") || isAbsolute(rel) || rel.includes("/") || rel.includes("\\")) {
    throw new Error(`invalid file name: ${JSON.stringify(name)}`);
  }
  return path;
}

function threadName(id: string, suffix: string): string {
  if (!isThreadId(id)) throw new Error(`invalid thread id: ${JSON.stringify(id)}`);
  return `${id}${suffix}`;
}

function versionName(id: string, suffix: string): string {
  if (!isVersionId(id)) throw new Error(`invalid version id: ${JSON.stringify(id)}`);
  return `${id}${suffix}`;
}

/** Compute the `.had` sidecar paths for a document path. */
export function hadPaths(docPath: string): HadPaths {
  const dir = resolveHadDir(docPath);
  const threadsDir = join(dir, "threads");
  const sessionsDir = join(dir, "sessions");
  const versionsDir = join(dir, "versions");
  return {
    dir,
    manifest: join(dir, "manifest.json"),
    annotations: join(dir, "annotations.json"),
    proposals: join(dir, "proposals.json"),
    threadsDir,
    sessionsDir,
    versionsDir,
    versionsIndex: join(versionsDir, "index.json"),
    assetsDir: join(dir, "assets"),
    stateDb: join(dir, "state.db"),
    settings: join(dir, "settings.json"),
    threadFile: (id) => childPath(threadsDir, threadName(id, ".md")),
    sessionFile: (id) => childPath(sessionsDir, threadName(id, ".session.jsonl")),
    versionFile: (id) => childPath(versionsDir, versionName(id, ".md")),
    versionAnnotationsFile: (id) => childPath(versionsDir, versionName(id, ".annotations.json")),
  };
}
