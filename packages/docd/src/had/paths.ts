import { dirname, basename, join } from "node:path";

export interface HadPaths {
  dir: string;
  manifest: string;
  annotations: string;
  proposals: string;
  threadsDir: string;
  sessionsDir: string;
  versionsDir: string;
  versionsIndex: string;
  stateDb: string;
  settings: string;
  threadFile: (id: string) => string;
  sessionFile: (id: string) => string;
  versionFile: (id: string) => string;
  versionAnnotationsFile: (id: string) => string;
}

/** Compute the `.had` sidecar paths for a document path. */
export function hadPaths(docPath: string): HadPaths {
  const dir = join(dirname(docPath), `.${basename(docPath)}.had`);
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
    stateDb: join(dir, "state.db"),
    settings: join(dir, "settings.json"),
    threadFile: (id) => join(threadsDir, `${id}.md`),
    sessionFile: (id) => join(sessionsDir, `${id}.session.jsonl`),
    versionFile: (id) => join(versionsDir, `${id}.md`),
    versionAnnotationsFile: (id) => join(versionsDir, `${id}.annotations.json`),
  };
}
