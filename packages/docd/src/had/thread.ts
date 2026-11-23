import { readFile } from "node:fs/promises";
import type {
  ThreadFile,
  ThreadFrontmatter,
  ThreadTurn,
  ThreadTurnRole,
} from "./types.js";
import { hadPaths } from "./paths.js";
import { withFileLock, writeFileAtomic } from "./io.js";
import { splitFrontmatter, stringifyFrontmatter } from "./frontmatter.js";

// Turn header. The optional trailing " ::vNNNN" tag records the doc version active
// at this turn; it's digits-only so it can't collide with the colons in an ISO timestamp.
const TURN_RE = /^## (you|agent|system)(?: \((.*?)\))? — (.+?)(?: ::(v\d+))?$/;
const THINK_OPEN = "<!--think";
const THINK_CLOSE = "-->";

function headerFor(turn: ThreadTurn): string {
  const metaPart = turn.meta ? ` (${turn.meta})` : "";
  const versionPart = turn.docVersion ? ` ::${turn.docVersion}` : "";
  return `## ${turn.role}${metaPart} — ${turn.timestamp}${versionPart}`;
}

// Reasoning is stored inside an HTML comment, so it must never contain the comment's
// closing "-->". Every "--" + backslashes + ">" gains one backslash on the way out and
// loses it on the way back, which is reversible for any text.
const escapeThinking = (s: string): string => s.replace(/--(\\*)>/g, "--$1\\>");
const unescapeThinking = (s: string): string => s.replace(/--(\\*)\\>/g, "--$1>");

// A line inside a turn that reads like a turn header would start a new turn on the way
// back. Every line that begins with backslashes + "## you|agent|system" gains one
// backslash on the way out and loses it on the way back, which is reversible for any text.
const HEADERISH_RE = /^(\\*)## (?:you|agent|system)\b/;
const ESCAPED_HEADERISH_RE = /^\\+## (?:you|agent|system)\b/;
const escapeHeaderLines = (s: string): string =>
  s.split("\n").map((l) => (HEADERISH_RE.test(l) ? `\\${l}` : l)).join("\n");
const unescapeHeaderLines = (s: string): string =>
  s.split("\n").map((l) => (ESCAPED_HEADERISH_RE.test(l) ? l.slice(1) : l)).join("\n");

/**
 * Split a turn's accumulated lines into its persisted reasoning + reply body. Reasoning
 * is only ever written as the turn's first block, so a `<!--think` line anywhere else is
 * part of the reply.
 */
function extractThinking(lines: string[]): { thinking?: string; body: string } {
  const start = lines.findIndex((l) => l.trim() !== "");
  if (start === -1 || lines[start].trim() !== THINK_OPEN) return { body: lines.join("\n") };
  let end = start + 1;
  while (end < lines.length && lines[end].trim() !== THINK_CLOSE) end++;
  const thinking = unescapeHeaderLines(unescapeThinking(lines.slice(start + 1, end).join("\n").trim()));
  const body = [...lines.slice(0, start), ...lines.slice(end + 1)].join("\n");
  return { thinking, body };
}

export function serializeThread(t: ThreadFile): string {
  const body = t.turns
    .map((turn) => {
      const think = turn.thinking
        ? `${THINK_OPEN}\n${escapeHeaderLines(escapeThinking(turn.thinking.trim()))}\n${THINK_CLOSE}\n\n`
        : "";
      return `${headerFor(turn)}\n\n${think}${escapeHeaderLines(turn.body.trim())}\n`;
    })
    .join("\n");
  const fm = t.frontmatter;
  const data: Record<string, unknown> = {
    id: fm.id,
    anchorExact: fm.anchorExact,
    stance: fm.stance,
    status: fm.status,
    piSession: fm.piSession,
  };
  if (fm.model !== undefined) data.model = fm.model;
  if (fm.harness !== undefined) data.harness = fm.harness;
  if (fm.parent !== undefined) data.parent = fm.parent;
  if (fm.branchFromTurn !== undefined) data.branchFromTurn = fm.branchFromTurn;
  if (fm.baseVersion !== undefined) data.baseVersion = fm.baseVersion;
  if (fm.baseDoc !== undefined) data.baseDoc = fm.baseDoc;
  return stringifyFrontmatter(data, body);
}

export function parseThread(text: string): ThreadFile {
  const parsed = splitFrontmatter(text);
  const fm = parsed.data;
  const frontmatter: ThreadFrontmatter = {
    id: fm.id as string,
    anchorExact: fm.anchorExact as string,
    stance: fm.stance as string,
    status: fm.status as string,
    piSession: fm.piSession as string,
  };
  if (fm.model !== undefined) frontmatter.model = fm.model as string;
  if (fm.harness !== undefined) frontmatter.harness = fm.harness as "pi" | "codex" | "claude-code";
  if (fm.parent !== undefined) frontmatter.parent = fm.parent as string;
  if (fm.branchFromTurn !== undefined) frontmatter.branchFromTurn = Number(fm.branchFromTurn);
  if (fm.baseVersion !== undefined) frontmatter.baseVersion = fm.baseVersion as string;
  if (fm.baseDoc !== undefined) frontmatter.baseDoc = fm.baseDoc as "latest" | "at-turn";

  const turns: ThreadTurn[] = [];
  const lines = parsed.body.split("\n");
  let current: ThreadTurn | null = null;
  let buf: string[] = [];
  const flush = () => {
    if (current) {
      const { thinking, body } = extractThinking(buf);
      current.body = unescapeHeaderLines(body.trim());
      if (thinking !== undefined) current.thinking = thinking;
      turns.push(current);
    }
    buf = [];
  };
  for (const line of lines) {
    const m = TURN_RE.exec(line);
    if (m) {
      flush();
      current = {
        role: m[1] as ThreadTurnRole,
        meta: m[2] || undefined,
        timestamp: m[3].trim(),
        body: "",
      };
      if (m[4]) current.docVersion = m[4];
    } else if (current) {
      buf.push(line);
    }
  }
  flush();
  return { frontmatter, turns };
}

/** Write (overwrite) a complete thread file, creating the threads dir if needed. */
export async function writeThread(docPath: string, t: ThreadFile): Promise<void> {
  const file = hadPaths(docPath).threadFile(t.frontmatter.id);
  await withFileLock(file, () => writeFileAtomic(file, serializeThread(t)));
}

export async function initThread(
  docPath: string,
  frontmatter: ThreadFrontmatter,
): Promise<void> {
  await writeThread(docPath, { frontmatter, turns: [] });
}

export async function readThread(docPath: string, id: string): Promise<ThreadFile> {
  const p = hadPaths(docPath);
  const text = await readFile(p.threadFile(id), "utf8");
  return parseThread(text);
}

export async function appendTurn(
  docPath: string,
  id: string,
  turn: ThreadTurn,
): Promise<void> {
  // Locked read-modify-write: a status transition (updateThreadFrontmatter) racing an
  // appended turn must not write back a copy of the file that predates the other's change.
  const file = hadPaths(docPath).threadFile(id);
  await withFileLock(file, async () => {
    const t = parseThread(await readFile(file, "utf8"));
    t.turns.push(turn);
    await writeFileAtomic(file, serializeThread(t));
  });
}

/** Patch a thread's frontmatter fields in place, leaving turns untouched. */
export async function updateThreadFrontmatter(
  docPath: string,
  id: string,
  patch: Partial<Omit<ThreadFrontmatter, "id">>,
): Promise<void> {
  const file = hadPaths(docPath).threadFile(id);
  await withFileLock(file, async () => {
    const t = parseThread(await readFile(file, "utf8"));
    t.frontmatter = { ...t.frontmatter, ...patch };
    await writeFileAtomic(file, serializeThread(t));
  });
}
