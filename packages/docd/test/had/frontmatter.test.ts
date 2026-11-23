import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AdmZip from "adm-zip";
import { openDoc, saveDoc } from "../../src/had/doc-store.js";
import { hadPaths } from "../../src/had/paths.js";
import { readThread, serializeThread, parseThread } from "../../src/had/thread.js";
import { importHadz } from "../../src/had/bundle.js";
import { splitFrontmatter, documentBody } from "../../src/had/frontmatter.js";
import { buildAgentContext } from "../../src/orchestrator/context.js";

declare global {
  // eslint-disable-next-line no-var
  var __docuzenFrontmatterRan: string[] | undefined;
}

let dir: string;
let docPath: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "frontmatter-"));
  docPath = join(dir, "plan.md");
  globalThis.__docuzenFrontmatterRan = undefined;
});
afterEach(async () => {
  globalThis.__docuzenFrontmatterRan = undefined;
  await rm(dir, { recursive: true, force: true });
});

/** A frontmatter block in a non-YAML language whose evaluation records that it ran. */
function hostile(lang: string): string {
  const js = `{ pwned: (globalThis.__docuzenFrontmatterRan = (globalThis.__docuzenFrontmatterRan || []).concat("${lang}")) }`;
  // CoffeeScript is a superset-ish here; the expression is valid JS either way.
  return `---${lang}\n${js}\n---\n# Plan\n\nBody text.\n`;
}

const LANGS = ["js", "javascript", "coffee"];

describe("frontmatter never runs code (C3)", () => {
  for (const lang of LANGS) {
    it(`opening and saving a document with a ---${lang} block runs nothing and keeps the block as text`, async () => {
      const raw = hostile(lang);
      await writeFile(docPath, raw, "utf8");
      const res = await openDoc(docPath);
      expect(globalThis.__docuzenFrontmatterRan).toBeUndefined();
      // Not YAML frontmatter → the whole file is body, shown and saved as written.
      expect(res.text).toBe(raw);
      await saveDoc(docPath, res.text, "t1");
      expect(globalThis.__docuzenFrontmatterRan).toBeUndefined();
      expect(await readFile(docPath, "utf8")).toBe(raw);
    });

    it(`reading a thread file with a ---${lang} block runs nothing`, async () => {
      const file = hadPaths(docPath).threadFile("c0001");
      await mkdir(hadPaths(docPath).threadsDir, { recursive: true });
      await writeFile(docPath, "# Plan\n", "utf8");
      await writeFile(file, `${hostile(lang)}\n## you — t1\n\nhello\n`, "utf8");
      await readThread(docPath, "c0001").catch(() => undefined);
      expect(globalThis.__docuzenFrontmatterRan).toBeUndefined();
    });

    it(`importing and opening a .hadz whose doc and thread carry ---${lang} blocks runs nothing`, async () => {
      const zip = new AdmZip();
      zip.addFile("plan.md", Buffer.from(hostile(lang), "utf8"));
      zip.addFile(
        "plan.md.had/annotations.json",
        Buffer.from(
          JSON.stringify({
            version: 1,
            annotations: [
              {
                id: "c0001",
                type: "comment",
                anchor: { exact: "Body", prefix: "", suffix: "" },
                status: "open",
                thread: "threads/c0001.md",
                session: "sessions/c0001.session.jsonl",
                createdAt: "t0",
              },
            ],
          }),
          "utf8",
        ),
      );
      zip.addFile("plan.md.had/threads/c0001.md", Buffer.from(`${hostile(lang)}\n## you — t1\n\nhi\n`, "utf8"));
      const hadz = join(dir, "evil.hadz");
      zip.writeZip(hadz);

      const { docPath: imported } = await importHadz(hadz, join(dir, "out"));
      await openDoc(imported);
      await buildAgentContext({ docPath: imported, threadId: "review", reviewMode: true, comment: "", stance: "none" });
      expect(globalThis.__docuzenFrontmatterRan).toBeUndefined();
    });
  }

  it("YAML tags that construct code (!!js/function, !!js/regexp) are refused, not built", () => {
    const raw = "---\nx: !!js/function 'function () { globalThis.__docuzenFrontmatterRan = [\"tag\"] }'\n---\n# Body\n";
    const split = splitFrontmatter(raw);
    expect(split.hasFrontmatter).toBe(false);
    expect(split.body).toBe(raw);
    expect(globalThis.__docuzenFrontmatterRan).toBeUndefined();
  });

  it("HTML documents never get frontmatter treatment", async () => {
    const htmlPath = join(dir, "page.html");
    const html = "---\ntitle: x\n---\n<p>hi</p>\n";
    await writeFile(htmlPath, html, "utf8");
    expect((await openDoc(htmlPath)).text).toBe(html);
    expect(documentBody(html, htmlPath)).toBe(html);
    const ctx = await buildAgentContext({ docPath: htmlPath, threadId: "review", reviewMode: true, comment: "", stance: "none" });
    expect(ctx.docText).toBe(html);
  });
});

describe("a leading horizontal rule is body, not frontmatter (H15)", () => {
  it("a document that starts with --- and has no closing delimiter opens and saves whole", async () => {
    const raw = "---\n\n# Title\n\nProse that follows a rule.\n";
    await writeFile(docPath, raw, "utf8");
    const res = await openDoc(docPath);
    expect(res.text).toBe(raw);
    await saveDoc(docPath, raw, "t1");
    expect(await readFile(docPath, "utf8")).toBe(raw);
  });

  it("two rules with prose between them stay in the body", async () => {
    const raw = "---\nAn opening aside, set off by rules.\n---\n\n# Title\n";
    await writeFile(docPath, raw, "utf8");
    expect((await openDoc(docPath)).text).toBe(raw);
    await saveDoc(docPath, raw, "t1");
    expect(await readFile(docPath, "utf8")).toBe(raw);
  });

  it("saving a body that starts with a rule into a doc with frontmatter keeps both", async () => {
    await writeFile(docPath, "---\ntitle: Plan\n---\n# Old\n", "utf8");
    const body = "---\n\n# New\n\n---\n\nMore.\n";
    await saveDoc(docPath, body, "t1");
    expect(await readFile(docPath, "utf8")).toBe(`---\ntitle: Plan\n---\n${body}`);
    expect((await openDoc(docPath)).text).toBe(body);
  });

  it("a YAML list between rules is not frontmatter", () => {
    const raw = "---\n- one\n- two\n---\nrest\n";
    expect(splitFrontmatter(raw)).toMatchObject({ hasFrontmatter: false, body: raw });
  });

  it("keeps the user's frontmatter bytes exactly (comments, quoting, key order)", async () => {
    const head = "---\n# owner: me\ntitle:   \"My Plan\"\nzeta: 1\nalpha: [a, b]\n---\n";
    await writeFile(docPath, `${head}# Old\n`, "utf8");
    await saveDoc(docPath, "# New\n", "t1");
    expect(await readFile(docPath, "utf8")).toBe(`${head}# New\n`);
  });

  it("accepts CRLF frontmatter and keeps it byte for byte", async () => {
    const head = "---\r\ntitle: Plan\r\n---\r\n";
    await writeFile(docPath, `${head}# Old\r\n`, "utf8");
    expect((await openDoc(docPath)).text).toBe("# Old\r\n");
    await saveDoc(docPath, "# New\r\n", "t1");
    expect(await readFile(docPath, "utf8")).toBe(`${head}# New\r\n`);
  });

  it("an empty block is (empty) frontmatter; a BOM is kept and never shown", () => {
    expect(splitFrontmatter("---\n---\nbody\n")).toMatchObject({ head: "---\n---\n", data: {}, body: "body\n" });
    expect(splitFrontmatter("﻿---\na: 1\n---\nbody\n")).toMatchObject({
      head: "﻿---\na: 1\n---\n",
      data: { a: 1 },
      body: "body\n",
    });
    expect(splitFrontmatter("﻿# T\n")).toMatchObject({ head: "﻿", body: "# T\n" });
  });

  it("only a bare --- line opens a block", () => {
    for (const raw of ["--- title\na: 1\n---\nx\n", "----\na: 1\n----\nx\n", "---yaml\na: 1\n---\nx\n"]) {
      expect(splitFrontmatter(raw).body).toBe(raw);
    }
  });
});

describe("thread files", () => {
  it("serializes without re-parsing the turn text, even when a turn starts with ---", () => {
    const t = {
      frontmatter: { id: "c0001", anchorExact: "x", stance: "none", status: "open", piSession: "s" },
      turns: [{ role: "you" as const, timestamp: "t1", body: "---\nnot: yaml\n---\nkept" }],
    };
    const back = parseThread(serializeThread(t));
    expect(back.frontmatter.id).toBe("c0001");
    expect(back.turns[0].body).toBe("---\nnot: yaml\n---\nkept");
  });
});
