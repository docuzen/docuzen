// Agent latency probe: where does the wait go on an agent turn? Times the same short
// question three ways against the same model:
//   1. straight to the model gateway (the floor: nothing docuzen can do about this);
//   2. a first message on a thread through the sidecar (discuss: new pi session);
//   3. a follow-up on the same thread (reply: live session).
// and reports time-to-first-token (TTFT) and total for each, plus prompt size.
//
//   node tools/perf/agent-latency.mjs [--model litellm/aws/claude-opus-5-5]
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const mi = process.argv.indexOf("--model");
const MODEL = mi >= 0 ? process.argv[mi + 1] : "litellm/aws/claude-opus-5-5";
const [provider, ...rest] = MODEL.split("/");
const modelId = rest.join("/");
const QUESTION = "Is Redis the right store here? Answer in one short sentence.";

const models = JSON.parse(await readFile(join(homedir(), ".pi", "agent", "models.json"), "utf8"));
const prov = models.providers[provider];
// pi resolves a "$VAR" apiKey from the environment; do the same for the direct call.
const apiKey = prov.apiKey?.startsWith("$") ? process.env[prov.apiKey.slice(1)] : prov.apiKey;

async function direct() {
  const t0 = performance.now();
  const res = await fetch(`${prov.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: modelId, stream: true, messages: [{ role: "user", content: QUESTION }] }),
  });
  let ttft = null;
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (ttft === null && /"content":"[^"]/.test(dec.decode(value))) ttft = performance.now() - t0;
  }
  return { ttft, total: performance.now() - t0 };
}

const work = await mkdtemp(join(tmpdir(), "docuzen-latency-"));
const cfg = join(work, "config");
await mkdir(cfg, { recursive: true });
await writeFile(join(cfg, "config.toml"), `[harness]\ndefault = "pi"\n\n[pi]\nmodel = "${MODEL}"\n`);
const DOC = "# Plan\n\nLimits are stored in Redis with a TTL.\n\n" + "Filler paragraph about rollout and monitoring. ".repeat(40) + "\n";
const docPath = join(work, "plan.md");
await writeFile(docPath, DOC);

const env = { ...process.env, DOCUZEN_CONFIG_DIR: cfg, DOCUZEN_GIT_EXCLUDES_FILE: join(work, "ignore") };
delete env.LLM_API_KEY;
const sidecar = spawn("npx", ["tsx", "packages/docd/src/server/main.ts", "--port", "0"], { cwd: repoRoot, env, stdio: ["ignore", "pipe", "ignore"], detached: true });
const port = await new Promise((res, rej) => {
  let buf = "";
  sidecar.stdout.on("data", (d) => {
    buf += d;
    const m = buf.match(/DOCD_PORT=(\d+)/);
    if (m) res(Number(m[1]));
  });
  setTimeout(() => rej(new Error("sidecar start timeout")), 30_000);
});
const ws = new WebSocket(`ws://127.0.0.1:${port}`);
await new Promise((r) => ws.on("open", r));
let seq = 0;
const pending = new Map();
ws.on("message", (data) => {
  const msg = JSON.parse(String(data));
  const p = pending.get(msg.id);
  if (!p) return;
  if ("ok" in msg) {
    pending.delete(msg.id);
    msg.ok ? p.res({ result: msg.result, ...p.t, total: performance.now() - p.t0, tools: p.tools }) : p.rej(new Error(msg.error));
  } else {
    if (msg.event === "tool") p.tools.push(msg.data);
    if ((msg.event === "thinking" || msg.event === "token") && p.t.firstEvent === undefined) p.t.firstEvent = performance.now() - p.t0;
    if (msg.event === "token" && p.t.ttft === undefined) p.t.ttft = performance.now() - p.t0;
  }
});
const call = (method, params = {}) =>
  new Promise((res, rej) => {
    const id = `r${++seq}`;
    pending.set(id, { res, rej, t0: performance.now(), t: {}, tools: [] });
    ws.send(JSON.stringify({ id, method, params }));
  });

const fmt = (n) => (n == null ? "   n/a" : `${(n / 1000).toFixed(2).padStart(6)} s`);
try {
  const open = await call("openDoc", { docPath });
  const exact = "Limits are stored in Redis with a TTL.";
  const at = DOC.indexOf(exact);
  const { result: ann } = await call("createAnnotation", { docPath, kind: "comment", anchor: { exact, prefix: DOC.slice(at - 8, at), suffix: DOC.slice(at + exact.length, at + exact.length + 8) } });

  const d = await direct();
  const first = await call("discuss", { docPath, threadId: ann.id, annotationId: ann.id, stance: "none", comment: QUESTION });
  const follow = await call("reply", { docPath, threadId: ann.id, message: "And in one more short sentence, why?" });
  const d2 = await direct();

  console.log(`model ${MODEL}   (openDoc ${open.total.toFixed(0)} ms)\n`);
  console.log(`                              first token      total`);
  console.log(`direct to gateway (floor)       ${fmt(d.ttft)}   ${fmt(d.total)}`);
  console.log(`direct to gateway (repeat)      ${fmt(d2.ttft)}   ${fmt(d2.total)}`);
  console.log(`docuzen first message (discuss) ${fmt(first.ttft)}   ${fmt(first.total)}   tools: ${first.tools.join(", ") || "none"}   first stream event ${fmt(first.firstEvent)}`);
  console.log(`docuzen follow-up (reply)       ${fmt(follow.ttft)}   ${fmt(follow.total)}   tools: ${follow.tools.join(", ") || "none"}`);
} finally {
  ws.close();
  try { process.kill(-sidecar.pid, "SIGTERM"); } catch { /* gone */ }
  await rm(work, { recursive: true, force: true });
}
