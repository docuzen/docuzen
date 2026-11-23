// Ids become file names inside the `.had` folder. They arrive from RPC params and from
// files inside a shared .hadz, so only the forms the store itself hands out may build a
// path — never one that climbs out of its folder.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AdmZip from "adm-zip";
import { hadPaths } from "../../src/had/paths.js";
import { readThread } from "../../src/had/thread.js";
import { deleteAnnotation } from "../../src/had/annotations.js";
import { saveComment } from "../../src/had/comment.js";
import { readVersion } from "../../src/had/versions.js";
import { restoreVersion } from "../../src/had/doc-store.js";
import { importHadz } from "../../src/had/bundle.js";

let dir: string;
let docPath: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ids-"));
  docPath = join(dir, "docs", "plan.md");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(join(dir, "docs")));
  await writeFile(docPath, "# Plan\n", "utf8");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const BAD = ["../../../../victim", "c0001/../../x", "/etc/passwd", "", "c0001.md", "note", "v0001", ".."];

describe("ids that build paths (H13)", () => {
  it("accepts exactly the ids the store generates", () => {
    const p = hadPaths(docPath);
    for (const id of ["c0001", "c12345", "directive-3", "review"]) {
      expect(p.threadFile(id)).toBe(join(p.threadsDir, `${id}.md`));
      expect(p.sessionFile(id)).toBe(join(p.sessionsDir, `${id}.session.jsonl`));
    }
    expect(p.versionFile("v0012")).toBe(join(p.versionsDir, "v0012.md"));
    expect(p.versionAnnotationsFile("v0012")).toBe(join(p.versionsDir, "v0012.annotations.json"));
  });

  it("refuses anything else for threads, sessions and versions", () => {
    const p = hadPaths(docPath);
    for (const id of BAD) {
      expect(() => p.threadFile(id)).toThrow(/invalid thread id/);
      expect(() => p.sessionFile(id)).toThrow(/invalid thread id/);
    }
    for (const id of [...BAD.filter((b) => b !== "v0001"), "c0001", "../v0001"]) {
      expect(() => p.versionFile(id)).toThrow(/invalid version id/);
      expect(() => p.versionAnnotationsFile(id)).toThrow(/invalid version id/);
    }
  });

  it("getThread / saveComment / deleteAnnotation cannot reach a file outside the store", async () => {
    // .had lives at <dir>/docs/.docuzen/plan.md.had → threads/../../../../victim.md is <dir>/victim.md
    const victim = join(dir, "victim.md");
    await writeFile(victim, "---\nid: secret\n---\n## you — t\n\nsecret text\n", "utf8");
    const climb = "../../../../victim";

    await expect(readThread(docPath, climb)).rejects.toThrow(/invalid thread id/);
    await expect(saveComment(docPath, { id: climb, body: "overwrite" }, "t")).rejects.toThrow(/invalid thread id/);
    await expect(deleteAnnotation(docPath, climb)).rejects.toThrow(/invalid thread id/);
    expect(await readFile(victim, "utf8")).toContain("secret text");
  });

  it("readVersion / restoreVersion cannot reach a file outside the store", async () => {
    const victim = join(dir, "victim.md");
    await writeFile(victim, "secret\n", "utf8");
    await expect(readVersion(docPath, "../../../../victim")).rejects.toThrow(/invalid version id/);
    await expect(restoreVersion(docPath, "../../../../victim", "t")).rejects.toThrow(/invalid version id/);
    expect(await readFile(docPath, "utf8")).toBe("# Plan\n");
  });
});

describe("importing a .hadz with bad ids (H13)", () => {
  function bundle(files: Record<string, unknown>): string {
    const zip = new AdmZip();
    zip.addFile("plan.md", Buffer.from("# Plan\n", "utf8"));
    for (const [name, value] of Object.entries(files)) {
      zip.addFile(`plan.md.had/${name}`, Buffer.from(typeof value === "string" ? value : JSON.stringify(value), "utf8"));
    }
    const out = join(dir, "shared.hadz");
    zip.writeZip(out);
    return out;
  }

  it("refuses an annotations.json id that is not a store id, writing nothing", async () => {
    const hadz = bundle({
      "annotations.json": {
        version: 1,
        annotations: [{ id: "../../../../target", type: "comment", anchor: { exact: "", prefix: "", suffix: "" } }],
      },
    });
    const dest = join(dir, "out");
    await expect(importHadz(hadz, dest)).rejects.toThrow(/invalid thread id/);
    expect(existsSync(dest)).toBe(false);
  });

  it("refuses a versions/index.json id that is not a store id, writing nothing", async () => {
    const hadz = bundle({ "versions/index.json": { version: 1, entries: [{ id: "../../x", timestamp: "t", cause: "manual-save" }] } });
    const dest = join(dir, "out");
    await expect(importHadz(hadz, dest)).rejects.toThrow(/invalid version id/);
    expect(existsSync(dest)).toBe(false);
  });

  it("refuses unreadable review files rather than importing them half-checked", async () => {
    const hadz = bundle({ "annotations.json": "{not json" });
    await expect(importHadz(hadz, join(dir, "out"))).rejects.toThrow(/annotations\.json/);
  });

  it("still imports a bundle whose ids are all store ids", async () => {
    const hadz = bundle({
      "annotations.json": { version: 1, annotations: [{ id: "c0001" }, { id: "directive-1" }] },
      "versions/index.json": { version: 1, entries: [{ id: "v0001", timestamp: "t", cause: "manual-save" }] },
    });
    const { docPath: imported } = await importHadz(hadz, join(dir, "out"));
    expect(await readFile(imported, "utf8")).toBe("# Plan\n");
  });
});
