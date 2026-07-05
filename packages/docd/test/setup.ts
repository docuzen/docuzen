// Point the global-git-excludes writer at a throwaway file so the suite never
// mutates the developer's real ~/.config/git/ignore.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DOCUZEN_GIT_EXCLUDES_FILE = join(
  mkdtempSync(join(tmpdir(), "docd-excludes-")),
  "ignore",
);
