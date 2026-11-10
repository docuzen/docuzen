// Trace one agent turn at the wire: runs the sidecar with pi pointed at a local recording
// proxy in front of the real gateway, and prints every model request the turn makes —
// when it was sent, how big it was, what it asked for, and when bytes came back.
//
//   set -a; . ~/.secrets; set +a; node tools/perf/trace-turn.mjs [--model litellm/aws/claude-opus-5-5]
import { spawn } from "node:child_process";
import { createServer } from "node:http";
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
const real = JSON.parse(await readFile(join(homedir(), ".pi", "agent", "models.json"), "utf8")).providers[provider];
const apiKey = real.apiKey?.startsWith("$") ? process.env[real.apiKey.slice(1)] : real.apiKey;
if (!apiKey) throw new Error("no API key: export the variable models.json refers to (e.g. `set -a; . ~/.secrets; set +a`)");

let T0 = performance.now();
const at = () => `${((performance.now() - T0) / 1000).toFixed(2).padStart(6)}s`;
const log = [];
const proxy = createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", async () => {
    const n = log.length + 1;
    let j = {};
    try { j = JSON.parse(body); } catch { /* not json */ }
    const sys = (j.messages ?? []).filter((m) => m.role === "system" || m.role === "developer").map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("");
    const entry = {
      n, sent: at(), path: req.url, bytes: body.length, stream: j.stream, messages: (j.messages ?? []).length,
      systemChars: sys.length, tools: (j.tools ?? []).length, toolsChars: JSON.stringify(j.tools ?? []).length,
      extra: Object.fromEntries(Object.entries(j).filter(([k]) => !["messages", "tools", "model", "stream"].includes(k)).map(([k, v]) => [k, typeof v === "object" ? JSON.stringify(v).slice(0, 80) : v])),
    };
    log.push(entry);
    const up = await fetch(real.baseUrl + req.url.replace(/^\/v1/, ""), { method: req.method, headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` }, body: req.method === "POST" ? body : undefined });
    entry.status = up.status;
    entry.headersAt = at();
    res.writeHead(up.status, { "content-type": up.headers.get("content-type") ?? "application/json" });
    const reader = up.body.getReader();
    const dec = new TextDecoder();
    let chunks = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const s = dec.decode(value);
      chunks++;
      if (!entry.firstByteAt) entry.firstByteAt = at();
      if (!entry.firstContentAt && /"content":"[^"]/.test(s)) entry.firstContentAt = at();
      if (!entry.firstReasoningAt && /reasoning|thinking/.test(s)) entry.firstReasoningAt = at();
      res.write(value);
    }
    entry.doneAt = at();
    entry.chunks = chunks;
    res.end();
  });
});
await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
const proxyPort = proxy.address().port;

const work = await mkdtemp(join(tmpdir(), "docuzen-trace-"));
await mkdir(join(work, ".pi", "agent"), { recursive: true });
await mkdir(join(work, ".docuzen"), { recursive: true });
await writeFile(join(work, ".pi", "agent", "models.json"), JSON.stringify({ providers: { [provider]: { ...real, baseUrl: `http://127.0.0.1:${proxyPort}/v1`, apiKey: "via-proxy", models: real.models.filter((m) => m.id === modelId) } } }));
await writeFile(join(work, ".docuzen", "config.toml"), `[harness]\ndefault = "pi"\n\n[pi]\nmodel = "${MODEL}"\n`);
const DOC = "# Plan\n\nLimits are stored in Redis with a TTL.\n\n" + "Filler paragraph about rollout and monitoring. ".repeat(40) + "\n";
await mkdir(join(work, "doc"));
const docPath = join(work, "doc", "plan.md");
await writeFile(docPath, DOC);

const env = { ...process.env, HOME: work, DOCUZEN_GIT_EXCLUDES_FILE: join(work, "ignore") };
delete env.LLM_API_KEY; delete env.DOCUZEN_CONFIG_DIR; delete env.PI_CODING_AGENT_DIR;
const sidecar = spawn(process.execPath, [join(repoRoot, "node_modules/tsx/dist/cli.mjs"), "packages/docd/src/server/main.ts", "--port", "0"], { cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
let slog = "";
sidecar.stderr.on("data", (d) => (slog += d));
const port = await new Promise((res, rej) => {
  sidecar.stdout.on("data", (d) => {
    slog += d;
    const m = slog.match(/DOCD_PORT=(\d+)/);
    if (m) res(Number(m[1]));
  });
  setTimeout(() => rej(new Error("sidecar start timeout\n" + slog)), 30_000);
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
    msg.ok ? p.res({ result: msg.result, events: p.events }) : p.rej(new Error(msg.error));
  } else p.events.push({ at: at(), event: msg.event, len: String(msg.data).length });
});
const call = (method, params = {}) => new Promise((res, rej) => { const id = `r${++seq}`; pending.set(id, { res, rej, events: [] }); ws.send(JSON.stringify({ id, method, params })); });

function report(label, r, from) {
  const mine = log.slice(from);
  const firstTok = r.events.find((e) => e.event === "token");
  console.log(`\n=== ${label}: done at ${at()}; UI saw first token at ${firstTok?.at ?? "never"}, ${r.events.filter((e) => e.event === "token").length} token events, ${r.events.filter((e) => e.event === "thinking").length} thinking events`);
  for (const e of mine) {
    console.log(`  request ${e.n} ${e.path}: sent ${e.sent}, ${(e.bytes / 1024).toFixed(1)} KB (system ${(e.systemChars / 1024).toFixed(1)} KB, ${e.tools} tools ${(e.toolsChars / 1024).toFixed(1)} KB, ${e.messages} msgs), stream=${e.stream}`);
    console.log(`      → ${e.status}; first byte ${e.firstByteAt}, first reasoning ${e.firstReasoningAt ?? "-"}, first content ${e.firstContentAt ?? "-"}, done ${e.doneAt} (${e.chunks} chunks)`);
    console.log(`      params: ${JSON.stringify(e.extra)}`);
  }
}
try {
  await call("openDoc", { docPath });
  const exact = "Limits are stored in Redis with a TTL.";
  const i = DOC.indexOf(exact);
  const { result: ann } = await call("createAnnotation", { docPath, kind: "comment", anchor: { exact, prefix: DOC.slice(i - 8, i), suffix: DOC.slice(i + exact.length, i + exact.length + 8) } });
  console.log(`model ${MODEL}; times are seconds since each turn started`);
  T0 = performance.now();
  let from = log.length;
  const first = await call("discuss", { docPath, threadId: ann.id, annotationId: ann.id, stance: "none", comment: "Is Redis the right store here? Answer in one short sentence." });
  report("first message (discuss)", first, from);
  T0 = performance.now();
  from = log.length;
  const follow = await call("reply", { docPath, threadId: ann.id, message: "And in one more short sentence, why?" });
  report("follow-up (reply)", follow, from);
} finally {
  ws.close();
  proxy.close();
  try { process.kill(-sidecar.pid, "SIGTERM"); } catch { /* gone */ }
  await rm(work, { recursive: true, force: true });
}
