import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectPath } from "../../src/had/inspect-path.js";

let dir: string;

beforeEach(async () => {
  // realpath: on macOS the temp dir itself sits behind the /var -> /private/var symlink.
  dir = await realpath(await mkdtemp(join(tmpdir(), "inspect-")));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe("inspectPath (what a document link really points at)", () => {
  it("reports a plain file and a folder as themselves", async () => {
    await writeFile(join(dir, "paper.pdf"), "%PDF");
    await mkdir(join(dir, "papers"));
    expect(await inspectPath(join(dir, "paper.pdf"))).toEqual({ realPath: join(dir, "paper.pdf"), kind: "file" });
    expect(await inspectPath(join(dir, "papers"))).toEqual({ realPath: join(dir, "papers"), kind: "directory" });
  });

  it("follows a symlink with a harmless name to the program it points at", async () => {
    await writeFile(join(dir, "run.command"), "#!/bin/sh\necho hi\n", { mode: 0o755 });
    await symlink(join(dir, "run.command"), join(dir, "notes.txt"));
    await mkdir(join(dir, "Tool.app/Contents/MacOS"), { recursive: true });
    await symlink(join(dir, "Tool.app"), join(dir, "slides.pdf"));
    expect(await inspectPath(join(dir, "notes.txt"))).toEqual({ realPath: join(dir, "run.command"), kind: "file" });
    expect(await inspectPath(join(dir, "slides.pdf"))).toEqual({ realPath: join(dir, "Tool.app"), kind: "directory" });
  });

  it("says when nothing is there, including a dangling symlink", async () => {
    await symlink(join(dir, "gone.pdf"), join(dir, "link.pdf"));
    expect(await inspectPath(join(dir, "missing.pdf"))).toEqual({ realPath: null, kind: "missing" });
    expect(await inspectPath(join(dir, "link.pdf"))).toEqual({ realPath: null, kind: "missing" });
  });

  it("refuses a relative path", async () => {
    await expect(inspectPath("notes.txt")).rejects.toThrow(/absolute/);
  });
});
