// Live agent check: drives the real docd sidecar with a REAL model through every agent
// flow over the same WebSocket RPC the desktop uses, against a throwaway copy of a
// fixture doc. Needs a pi model with a stored key in ~/.pi/agent/models.json.
//
//   node tools/live/run.mjs                              # default model below
//   node tools/live/run.mjs --model litellm/aws/claude-haiku-4-5
//   node tools/live/run.mjs --only discuss,improve
//
// Not part of `npm test` (costs tokens, needs a key, non-deterministic wording). Every
// assertion is structural — a reply exists, a proposal was persisted, the file changed —
// never about what the model said.
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const argOf = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const MODEL = argOf("model", "litellm/aws/claude-opus-5-5");
const ONLY = argOf("only", "")?.split(",").filter(Boolean) ?? [];

const DOC = `# Rate limiting plan

We will basically just add some rate limiting to the API so that it does not get overloaded by too many requests from clients.

Limits are stored in Redis with a TTL. [[ add one sentence on what happens when Redis is unavailable ]]

## Rollout

Ship to 5% of traffic, then everyone.
`;

let failures = 0;
const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  const work = await mkdtemp(join(tmpdir(), "docuzen-live-"));
  const cfg = join(work, "config");
  await mkdir(cfg, { recursive: true });
  await writeFile(join(cfg, "config.toml"), `[harness]\ndefault = "pi"\n\n[pi]\nmodel = "${MODEL}"\n`);

  const env = { ...process.env, DOCUZEN_CONFIG_DIR: cfg, DOCUZEN_AUTHOR: "reviewer", DOCUZEN_GIT_EXCLUDES_FILE: join(work, "git-ignore") };
  delete env.LLM_API_KEY;
  const sidecar = spawn("npx", ["tsx", "packages/docd/src/server/main.ts", "--port", "0"], {
    cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe"], detached: true,
  });
  let log = "";
  sidecar.stderr.on("data", (d) => (log += d));
  const port = await new Promise((res, rej) => {
    sidecar.stdout.on("data", (d) => {
      log += d;
      const m = log.match(/DOCD_PORT=(\d+)/);
      if (m) res(Number(m[1]));
    });
    sidecar.on("exit", (c) => rej(new Error(`sidecar exited ${c}\n${log}`)));
    setTimeout(() => rej(new Error(`sidecar start timeout\n${log}`)), 30_000);
  });

  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });
  let seq = 0;
  const pending = new Map();
  ws.on("message", (data) => {
    const msg = JSON.parse(String(data));
    const p = pending.get(msg.id);
    if (!p) return;
    if ("ok" in msg) {
      pending.delete(msg.id);
      msg.ok ? p.res({ result: msg.result, events: p.events }) : p.rej(new Error(msg.error));
    } else p.events.push(msg);
  });
  const call = (method, params = {}) =>
    new Promise((res, rej) => {
      const id = `r${++seq}`;
      pending.set(id, { res, rej, events: [] });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const tokens = (events) => events.filter((e) => e.event === "token").map((e) => e.data).join("");
  const tools = (events) => events.filter((e) => e.event === "tool").map((e) => e.data);

  /** A fresh copy of the fixture per scenario, so scenarios can't affect each other. */
  let n = 0;
  async function freshDoc(settings) {
    const dir = join(work, `doc${++n}`);
    await mkdir(dir, { recursive: true });
    const docPath = join(dir, "plan.md");
    await writeFile(docPath, DOC);
    await call("openDoc", { docPath });
    if (settings) await call("setSettings", { docPath, settings: { scope: "folder", ...settings } });
    return docPath;
  }
  async function comment(docPath, exact) {
    const at = DOC.indexOf(exact);
    const { result } = await call("createAnnotation", {
      docPath, kind: "comment",
      anchor: { exact, prefix: DOC.slice(Math.max(0, at - 32), at), suffix: DOC.slice(at + exact.length, at + exact.length + 32) },
    });
    return result.id;
  }
  const want = (name) => ONLY.length === 0 || ONLY.includes(name);
  const WORDY = "We will basically just add some rate limiting to the API so that it does not get overloaded by too many requests from clients.";

  try {
    const { result: harnesses } = await call("listHarnesses");
    const pi = harnesses.find((h) => h.id === "pi");
    check("pi harness is live", !!pi?.available, pi?.unavailableReason ?? MODEL);
    if (!pi?.available) throw new Error("pi is offline — nothing else can run");

    if (want("discuss")) {
      console.log("\n[discuss + reply]");
      const docPath = await freshDoc();
      const id = await comment(docPath, "Limits are stored in Redis with a TTL.");
      const d = await call("discuss", { docPath, threadId: id, annotationId: id, stance: "critiquer", comment: "Is Redis the right store here? Answer in two sentences." });
      const thread1 = (await call("getThread", { docPath, threadId: id })).result;
      const agent1 = thread1.turns.filter((t) => t.role === "agent").at(-1);
      check("discuss streamed tokens", tokens(d.events).length > 0);
      check("discuss persisted an agent turn equal to the stream", !!agent1?.body && agent1.body.trim() === tokens(d.events).trim());
      check("conversation turn produced no proposal", !d.events.some((e) => e.event === "proposal"));
      const r = await call("reply", { docPath, threadId: id, message: "What would you use instead? One sentence." });
      const thread2 = (await call("getThread", { docPath, threadId: id })).result;
      check("reply continued the live session (4 turns: you/agent/you/agent)", thread2.turns.filter((t) => t.role !== "system").length === 4 && tokens(r.events).length > 0);
      check("document untouched by conversation", (await readFile(docPath, "utf8")) === DOC);
      const tasks = (await call("listTasks", { docPath })).result;
      check("task row settled as responded", tasks.find((t) => t.threadId === id)?.status === "responded");
    }

    if (want("improve")) {
      console.log("\n[improve → approve] (suggesting mode)");
      const docPath = await freshDoc();
      const id = await comment(docPath, WORDY);
      const imp = await call("improve", { docPath, threadId: id });
      check("improve returned a rewrite + proposal id", !!imp.result.newText && !!imp.result.proposalId);
      check("suggesting mode leaves the document untouched until approval", (await readFile(docPath, "utf8")) === DOC);
      await call("approveProposal", { docPath, threadId: id, proposalId: imp.result.proposalId });
      const after = await readFile(docPath, "utf8");
      check("approve wrote the rewrite into the document", after !== DOC && after.includes(imp.result.newText) && !after.includes(WORDY));
      const versions = (await call("listVersions", { docPath })).result;
      check("approve snapshotted backup + agent-edit versions", versions.some((v) => v.cause === "pre-apply-backup") && versions.some((v) => v.cause === "agent-edit"));
    }

    if (want("directives")) {
      console.log("\n[resolve [[ ]] directives] (suggesting mode)");
      const docPath = await freshDoc();
      const res = await call("resolveDirectives", { docPath });
      const proposals = (await call("listProposals", { docPath })).result;
      check("found the directive", res.result.count === 1);
      check("agent called propose_edit (proposal persisted, pending)", res.result.proposed && proposals.length === 1 && proposals[0].status === "pending", res.result.reply.slice(0, 120));
      if (proposals[0]) {
        await call("approveProposal", { docPath, threadId: proposals[0].threadId, proposalId: proposals[0].id });
        const after = await readFile(docPath, "utf8");
        check("approved directive edit removed the [[ ]] marker", !after.includes("[["), after.slice(0, 0));
      }
    }

    if (want("review")) {
      console.log("\n[review pass]");
      const docPath = await freshDoc();
      const rev = await call("reviewDocument", { docPath, stance: "critiquer", rubric: "Find at most three concrete problems. Include an edit for at least one." });
      const anns = (await call("listAnnotations", { docPath })).result;
      check("review filed findings as agent annotations", rev.result.findings.length > 0 && anns.filter((a) => a.origin === "agent").length === rev.result.findings.length, `${rev.result.findings.length} findings`);
      check("findings anchored to real text", rev.result.findings.some((f) => f.status === "open"));
      check("live 'finding' events streamed", rev.events.some((e) => e.event === "finding"));
    }

    if (want("direct")) {
      console.log("\n[editing mode: agent edits apply directly]");
      const docPath = await freshDoc({ agentEdit: "direct" });
      const id = await comment(docPath, WORDY);
      const imp = await call("improve", { docPath, threadId: id });
      const after = await readFile(docPath, "utf8");
      check("improve applied the rewrite without an approval step", after !== DOC && !after.includes(WORDY));
      const props = (await call("listProposals", { docPath, threadId: id })).result;
      check("the edit is still recorded as an (approved) proposal", props.length === 1 && props[0].status === "approved");
      check("an 'applied' event told the UI to reload", imp.events.some((e) => e.event === "applied"));
      const versions = (await call("listVersions", { docPath })).result;
      check("direct edits are versioned and restorable", versions.some((v) => v.cause === "pre-apply-backup") && versions.some((v) => v.cause === "agent-edit"));
      const backup = versions.find((v) => v.cause === "pre-apply-backup");
      await call("restoreVersion", { docPath, versionId: backup.id });
      check("restoring the backup version undoes the direct edit", (await readFile(docPath, "utf8")) === DOC);
    }

    if (want("tools")) {
      console.log("\n[tool use: built-in read + MCP document tools]");
      const docPath = await freshDoc();
      await writeFile(join(dirname(docPath), "notes.txt"), "The on-call rotation codename is HERON-42.\n");
      const id = await comment(docPath, "Ship to 5% of traffic, then everyone.");
      const d = await call("discuss", { docPath, threadId: id, annotationId: id, stance: "none", comment: "There is a file notes.txt next to this document. Read it and tell me the on-call rotation codename." });
      check("agent read a sibling file through its scoped tools", tokens(d.events).includes("HERON-42"), `tools used: ${tools(d.events).join(", ") || "none"}`);
      // A legitimate draft request: preview a change as a diff, writing nothing. (That the
      // bridge pins dryRun even when a model passes false is unit-tested in mcp-bridge.test.ts;
      // a well-behaved model refuses to try, so it can't be exercised live.)
      const m = await call("reply", { docPath, threadId: id, message: "Use the mcp tool to DRAFT (preview only, do not write) a change to this document, plan.md: with edit_file, replace \"then everyone\" with \"then 50%, then everyone\". Then paste the diff the tool returned, verbatim." });
      // The diff text alone proves nothing (a model can make one up) — the tool event is
      // what shows the MCP proxy was really invoked.
      check("agent invoked the mcp proxy tool", tools(m.events).includes("mcp"), `tools used: ${tools(m.events).join(", ") || "none"}`);
      check("MCP edit_file returned a real diff", /@@|Index:/.test(tokens(m.events)) && /then 50%/.test(tokens(m.events)), tokens(m.events).replace(/\s+/g, " ").slice(0, 200));
      check("the MCP draft wrote nothing to the document", (await readFile(docPath, "utf8")) === DOC);
    }
  } finally {
    ws.close();
    try { process.kill(-sidecar.pid, "SIGTERM"); } catch { /* gone */ }
    await rm(work, { recursive: true, force: true });
  }

  console.log(`\n${results.length - failures}/${results.length} checks passed (model ${MODEL})`);
  if (failures) {
    if (process.argv.includes("--log")) console.log(log);
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
