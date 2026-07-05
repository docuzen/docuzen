import { describe, expect, test } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDoc, saveDoc } from "../../src/had/doc-store.js";

function tmpDoc(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "noinject-"));
  const doc = join(dir, "plan.md");
  writeFileSync(doc, body, "utf8");
  return doc;
}

describe("openDoc never injects had: frontmatter", () => {
  test("a clean markdown doc is byte-identical after open", async () => {
    const body = "# Plan\n\nRedis with a TTL.\n";
    const doc = tmpDoc(body);
    await openDoc(doc);
    expect(readFileSync(doc, "utf8")).toBe(body);
  });

  test("a doc with the user's own frontmatter is untouched", async () => {
    const body = "---\ntitle: My Plan\n---\n# Plan\n";
    const doc = tmpDoc(body);
    await openDoc(doc);
    expect(readFileSync(doc, "utf8")).toBe(body);
  });

  test("open then save a clean doc does not add had:", async () => {
    const doc = tmpDoc("# Plan\n\nbody\n");
    await openDoc(doc);
    await saveDoc(doc, "# Plan\n\nedited body\n", "2020-01-01T00:00:00.000Z");
    expect(readFileSync(doc, "utf8")).not.toContain("had:");
  });
});
