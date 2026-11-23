import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createDoc, saveImage, readImage, newDocContent, imageMimeType } from "../../src/had/assets.js";
import { hadPaths } from "../../src/had/paths.js";
import { exportHadz, importHadz } from "../../src/had/bundle.js";
import { openDoc } from "../../src/had/doc-store.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
let dir: string;
let docPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "assets-"));
  docPath = join(dir, "my plan.md");
  await writeFile(docPath, "# Plan\n", "utf8");
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe("saveImage", () => {
  it("stores the bytes in the doc's .had/assets and returns a link relative to the doc", async () => {
    const r = await saveImage(docPath, { name: "Screen Shot 1.PNG", dataBase64: PNG.toString("base64") });
    expect(r.path).toBe(join(hadPaths(docPath).assetsDir, "Screen-Shot-1.png"));
    expect(await readFile(r.path)).toEqual(PNG);
    // The link resolves from the document's own directory, with the space in the folder name encoded.
    expect(r.relPath).toBe(".docuzen/my%20plan.md.had/assets/Screen-Shot-1.png");
    expect(resolve(dirname(docPath), decodeURIComponent(r.relPath))).toBe(r.path);
  });

  it("reuses the file for identical bytes and numbers a different image with the same name", async () => {
    const a = await saveImage(docPath, { name: "image.png", dataBase64: PNG.toString("base64") });
    const again = await saveImage(docPath, { name: "image.png", dataBase64: PNG.toString("base64") });
    const other = await saveImage(docPath, { name: "image.png", dataBase64: Buffer.concat([PNG, Buffer.from([0])]).toString("base64") });
    expect(again.name).toBe(a.name);
    expect(other.name).toBe("image-2.png");
    expect((await readdir(hadPaths(docPath).assetsDir)).sort()).toEqual(["image-2.png", "image.png"]);
  });

  it("copies from a source path", async () => {
    const src = join(dir, "photo.jpg");
    await writeFile(src, PNG);
    const r = await saveImage(docPath, { name: "photo.jpg", sourcePath: src });
    expect(await readFile(r.path)).toEqual(PNG);
  });

  it("links upward when the review state sits at a repo root", async () => {
    await mkdir(join(dir, ".git"));
    await mkdir(join(dir, "docs"));
    const nested = join(dir, "docs", "plan.md");
    await writeFile(nested, "# Plan\n", "utf8");
    const r = await saveImage(nested, { name: "a.png", dataBase64: PNG.toString("base64") });
    expect(r.relPath).toBe("../.docuzen/docs/plan.md.had/assets/a.png");
  });

  it("rejects non-images, empty data and path tricks in the name", async () => {
    await expect(saveImage(docPath, { name: "notes.txt", dataBase64: "aGk=" })).rejects.toThrow(/not an image/);
    await expect(saveImage(docPath, { name: "a.png", dataBase64: "" })).rejects.toThrow(/empty/);
    const r = await saveImage(docPath, { name: "../../evil.png", dataBase64: PNG.toString("base64") });
    expect(dirname(r.path)).toBe(hadPaths(docPath).assetsDir);
  });

  it("travels with an exported bundle", async () => {
    await openDoc(docPath);
    const saved = await saveImage(docPath, { name: "a.png", dataBase64: PNG.toString("base64") });
    const { path } = await exportHadz(docPath, { outPath: join(dir, "out.hadz") });
    const { docPath: imported } = await importHadz(path, join(dir, "unpacked"));
    expect(await readFile(resolve(dirname(imported), decodeURIComponent(saved.relPath)))).toEqual(PNG);
  });

  it("keeps image links working when the bundle is opened at a different folder depth (M18)", async () => {
    const { saveDoc } = await import("../../src/had/doc-store.js");
    const { listVersions, readVersion } = await import("../../src/had/versions.js");
    // In a repo, one folder down: the link climbs to the repo root's .docuzen.
    const repo = join(dir, "repo");
    await mkdir(join(repo, ".git"), { recursive: true });
    await mkdir(join(repo, "docs"));
    const inRepo = join(repo, "docs", "my plan.md");
    await writeFile(inRepo, "# Plan\n", "utf8");
    const saved = await saveImage(inRepo, { name: "shot.png", dataBase64: PNG.toString("base64") });
    expect(saved.relPath).toBe("../.docuzen/docs/my%20plan.md.had/assets/shot.png");
    const md = `# Plan\n\n![shot](${saved.relPath})\n\n<img src="${saved.relPath}">\n\nSee docs/x/assets/ too.\n`;
    await saveDoc(inRepo, md, "t1");

    const { path } = await exportHadz(inRepo, { outPath: join(dir, "out.hadz") });
    const { docPath: imported } = await importHadz(path, join(dir, "elsewhere"));

    const text = await readFile(imported, "utf8");
    const links = [...text.matchAll(/\]\(([^)]+)\)|src="([^"]+)"/g)].map((m) => m[1] ?? m[2]);
    expect(links).toHaveLength(2);
    for (const link of links) {
      expect(await readFile(resolve(dirname(imported), decodeURIComponent(link)))).toEqual(PNG);
    }
    expect(text).toContain("See docs/x/assets/ too."); // unrelated text untouched
    // A restored version carries working links too.
    const versions = await listVersions(imported);
    expect(await readVersion(imported, versions[versions.length - 1].id)).toBe(text);
  });
});

describe("createDoc", () => {
  it("writes a markdown starter titled from the file name", async () => {
    const p = join(dir, "sub", "release-notes.md");
    await createDoc(p);
    expect(await readFile(p, "utf8")).toBe("# release notes\n\n");
    expect((await openDoc(p)).format).toBe("markdown");
  });

  it("writes a complete HTML page for .html", async () => {
    const p = join(dir, "A <b>.html");
    await createDoc(p);
    const html = await readFile(p, "utf8");
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain("<h1>A &lt;b&gt;</h1>");
    expect((await openDoc(p)).format).toBe("html");
  });

  it("refuses other extensions and relative paths", async () => {
    await expect(createDoc(join(dir, "x.txt"))).rejects.toThrow(/\.md or \.html/);
    await expect(createDoc("x.md")).rejects.toThrow(/absolute/);
  });
});

describe("readImage", () => {
  it("returns an image's bytes and type, and refuses anything that is not an image", async () => {
    const saved = await saveImage(docPath, { name: "a.png", dataBase64: PNG.toString("base64") });
    expect(await readImage(saved.path)).toEqual({ mime: "image/png", dataBase64: PNG.toString("base64") });
    await expect(readImage(docPath)).rejects.toThrow(/not an image/);
    await expect(readImage("a.png")).rejects.toThrow(/not an image/);
  });
});

describe("helpers", () => {
  it("knows image types by extension only", () => {
    expect(imageMimeType("/a/b.JPG")).toBe("image/jpeg");
    expect(imageMimeType("/etc/passwd")).toBeUndefined();
    expect(newDocContent("/x/Untitled.md")).toBe("# Untitled\n\n");
  });
});

describe("only real image files are read or copied (H14)", () => {
  async function secretFile(): Promise<string> {
    const p = join(dir, "models.json");
    await writeFile(p, '{"providers":{"x":{"apiKey":"sk-secret"}}}', "utf8");
    return p;
  }
  const assets = async () => readdir(hadPaths(docPath).assetsDir).catch(() => [] as string[]);

  it("saveImage refuses a source that is not an image, whatever the name says", async () => {
    const secret = await secretFile();
    await expect(saveImage(docPath, { name: "leak.png", sourcePath: secret })).rejects.toThrow(/not an image/);
    expect(await assets()).toEqual([]);
  });

  it("saveImage and readImage refuse an image-named link to a non-image file", async () => {
    const { symlink } = await import("node:fs/promises");
    const link = join(dir, "innocent.png");
    await symlink(await secretFile(), link);
    await expect(saveImage(docPath, { name: "innocent.png", sourcePath: link })).rejects.toThrow(/not an image/);
    await expect(readImage(link)).rejects.toThrow(/not an image/);
    expect(await assets()).toEqual([]);
  });

  it("saveImage and readImage refuse a FIFO or folder named like an image instead of hanging", async () => {
    const { execFileSync } = await import("node:child_process");
    const fifo = join(dir, "pipe.png");
    execFileSync("mkfifo", [fifo]);
    const folder = join(dir, "folder.png");
    await mkdir(folder);
    for (const p of [fifo, folder]) {
      await expect(saveImage(docPath, { name: "x.png", sourcePath: p })).rejects.toThrow(/not an image file/);
      await expect(readImage(p)).rejects.toThrow(/not an image file/);
    }
  }, 2000);

  it("still copies a real image reached through a link", async () => {
    const { symlink } = await import("node:fs/promises");
    const real = join(dir, "real.png");
    await writeFile(real, PNG);
    const link = join(dir, "alias.png");
    await symlink(real, link);
    const r = await saveImage(docPath, { name: "alias.png", sourcePath: link });
    expect(await readFile(r.path)).toEqual(PNG);
    expect((await readImage(link)).mime).toBe("image/png");
  });
});
