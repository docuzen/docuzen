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
