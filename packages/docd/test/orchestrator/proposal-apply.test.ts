// Applying an agent's edit to the user's document: what it touches (the body, never the
// frontmatter) and how it serializes against every other writer of that document.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProposalService } from "../../src/orchestrator/proposal-service.js";
import { addAnnotation, listProposals, readAnnotations, saveDoc } from "../../src/had/index.js";
import { withDocLock } from "../../src/had/io.js";
import { createAnchor } from "../../src/anchor/index.js";

let dir: string;
let docPath: string;
const svc = new ProposalService({ now: () => "t" });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "proposal-apply-"));
  docPath = join(dir, "plan.md");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function annotate(body: string, exact: string, from = 0, anchor?: { exact: string; prefix: string; suffix: string }) {
  const start = body.indexOf(exact, from);
  await addAnnotation(docPath, {
    id: "c0001",
    type: "comment",
    anchor: anchor ?? createAnchor(body, start, start + exact.length),
    status: "open",
    thread: "threads/c0001.md",
    session: "sessions/c0001.session.jsonl",
    createdAt: "t",
  });
}

describe("single-span apply works on the body, never the frontmatter (H12)", () => {
  it("replaces the annotated text in the body even when the frontmatter holds the same words", async () => {
    const head = "---\ntitle: Overview\n# keep: this comment\n---\n";
    const body = "Overview\n\nThe overview is short.\n";
    await writeFile(docPath, head + body, "utf8");
    // An anchor with no context (as the HTML path or an older client writes it).
    await annotate(body, "Overview", 0, { exact: "Overview", prefix: "", suffix: "" });

    const { proposal } = await svc.submitSpan(docPath, "c0001", "Summary");
    await svc.approve(docPath, "c0001", proposal.id);

    expect(await readFile(docPath, "utf8")).toBe(`${head}Summary\n\nThe overview is short.\n`);
    // The re-anchored annotation is in body coordinates: no frontmatter in its context.
    const ann = (await readAnnotations(docPath)).annotations[0];
    expect(ann.anchor.exact).toBe("Summary");
    expect(ann.anchor.prefix).toBe("");
    expect(ann.anchor.suffix.startsWith("\n\nThe overview")).toBe(true);
  });

  it("a hunk apply keeps the frontmatter byte for byte (comments and quoting included)", async () => {
    const head = "---\n# owner: me\ntitle:   \"Plan\"\n---\n";
    await writeFile(docPath, `${head}# Plan\n\nUse Redis.\n`, "utf8");
    const p = await svc.submit(docPath, "c0001", { rationale: "", hunks: [{ oldText: "Redis", newText: "Postgres" }] });
    await svc.approve(docPath, "c0001", p.proposal.id);
    expect(await readFile(docPath, "utf8")).toBe(`${head}# Plan\n\nUse Postgres.\n`);
  });

  it("writes through a symlinked document, keeping the link", async () => {
    await mkdir(join(dir, "real"));
    const target = join(dir, "real", "plan.md");
    await writeFile(target, "# Plan\n\nUse Redis.\n", "utf8");
    await symlink(join("real", "plan.md"), docPath);
    const p = await svc.submit(docPath, "c0001", { rationale: "", hunks: [{ oldText: "Redis", newText: "Postgres" }] });
    await svc.approve(docPath, "c0001", p.proposal.id);
    expect((await lstat(docPath)).isSymbolicLink()).toBe(true);
    expect(await readFile(target, "utf8")).toBe("# Plan\n\nUse Postgres.\n");
  });
});

describe("approve and reject take the document lock (H18, M7)", () => {
  it("approve and reject wait for the document lock that saveDoc also holds", async () => {
    await writeFile(docPath, "# Plan\n\nUse Redis.\n", "utf8");
    const a = await svc.submit(docPath, "c0001", { rationale: "", hunks: [{ oldText: "Redis", newText: "Postgres" }] });
    const b = await svc.submit(docPath, "c0001", { rationale: "", hunks: [{ oldText: "Plan", newText: "Draft" }] });

    let release!: () => void;
    const held = withDocLock(docPath, () => new Promise<void>((r) => (release = r)));
    const approving = svc.approve(docPath, "c0001", a.proposal.id);
    const rejecting = svc.reject(docPath, "c0001", b.proposal.id);
    await new Promise((r) => setTimeout(r, 30));
    expect(await readFile(docPath, "utf8")).toBe("# Plan\n\nUse Redis.\n");
    expect((await listProposals(docPath, "c0001")).map((p) => p.status)).toEqual(["pending", "pending"]);
    release();
    await held;
    await Promise.all([approving, rejecting]);
    expect(await readFile(docPath, "utf8")).toBe("# Plan\n\nUse Postgres.\n");
    expect((await listProposals(docPath, "c0001")).map((p) => p.status)).toEqual(["approved", "rejected"]);
  });

  it("a reject racing an approve of the same proposal loses cleanly; the record matches the document", async () => {
    await writeFile(docPath, "# Plan\n\nUse Redis.\n", "utf8");
    const { proposal } = await svc.submit(docPath, "c0001", {
      rationale: "",
      hunks: [{ oldText: "Redis", newText: "Postgres" }],
    });
    const [approved, rejected] = await Promise.allSettled([
      svc.approve(docPath, "c0001", proposal.id),
      svc.reject(docPath, "c0001", proposal.id),
    ]);
    expect(approved.status).toBe("fulfilled");
    expect(rejected.status).toBe("rejected");
    expect((rejected as PromiseRejectedResult).reason.message).toMatch(/already approved/);
    expect((await listProposals(docPath, "c0001"))[0].status).toBe("approved");
    expect(await readFile(docPath, "utf8")).toContain("Postgres");
  });

  it("a save racing an approve never leaves the manifest out of step with the document", async () => {
    const { readManifest, contentHash } = await import("../../src/had/manifest.js");
    await writeFile(docPath, "# Plan\n\nUse Redis.\n", "utf8");
    const { proposal } = await svc.submit(docPath, "c0001", {
      rationale: "",
      hunks: [{ oldText: "Redis", newText: "Postgres" }],
    });
    await Promise.all([svc.approve(docPath, "c0001", proposal.id), saveDoc(docPath, "# Plan\n\nUse Redis today.\n", "t2")]);
    const onDisk = await readFile(docPath, "utf8");
    expect((await readManifest(docPath))!.contentHash).toBe(contentHash(onDisk));
  });
});
