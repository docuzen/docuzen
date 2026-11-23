// The one place a document's (or thread file's) YAML frontmatter is read and written.
// Everything in had/ and orchestrator/ goes through here; nothing calls gray-matter's
// `matter()` / `matter.stringify()` directly any more, for three reasons:
//
//  1. Code execution. `matter()` picks its parser from the text after the opening
//     delimiter, so a file that starts with `---js` (or `---javascript`) has its
//     frontmatter `eval`ed — opening a shared document or .hadz ran its code. Here the
//     opening line must be a bare `---`, and the block only ever reaches the YAML
//     parser below. That parser is js-yaml's `safeLoad` (DEFAULT_SAFE_SCHEMA): tags
//     such as `!!js/function`, `!!js/regexp` and `!!python/…` are unknown to it and
//     throw, so no tag can construct code; a block that throws is simply not
//     frontmatter.
//
//  2. Misreading a body that starts with a horizontal rule. `matter()` treats any
//     leading `---` as frontmatter — with no closing delimiter it swallows the whole
//     file, and with a second rule further down it strips everything in between.
//     Here a block counts only when a closing `---` line exists AND the block parses
//     to a plain mapping; otherwise the whole file is body.
//
//  3. Rewriting the user's bytes. `matter.stringify(text, data)` re-parses `text`
//     (so a body starting with `---` was mangled on every save) and re-dumps the
//     YAML (losing comments, quoting and key order). Documents never change their
//     frontmatter here, so saving re-attaches the original bytes untouched.
//
// HTML documents never get frontmatter treatment: their text is always all body.
import matter from "gray-matter";
import { isHtmlDoc } from "./doc-format.js";

interface YamlEngine {
  parse(text: string): unknown;
  stringify(data: object): string;
}

// gray-matter's YAML engine is js-yaml's safeLoad/safeDump. Only this engine is ever
// used — never gray-matter's own parse pipeline, which is what dispatches to the
// JavaScript/CoffeeScript engines.
const yaml = (matter as unknown as { engines: { yaml: YamlEngine } }).engines.yaml;

const BOM = "﻿";
const OPEN = /^---[ \t]*\r?\n/;
// A closing delimiter line: `---` (trailing blanks allowed), then a line break or EOF.
const CLOSE = /^---[ \t]*(?:\r?\n|(?![\s\S]))/m;

export interface SplitDocument {
  /**
   * Everything before the body, byte for byte: a UTF-8 BOM if the file has one, then
   * the frontmatter block (both delimiter lines included). "" when there is neither.
   */
  head: string;
  /** The parsed frontmatter; `{}` when there is none. */
  data: Record<string, unknown>;
  /** Whether `head` holds a frontmatter block. */
  hasFrontmatter: boolean;
  /** The rest of the file. */
  body: string;
}

function isPlainMapping(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** Parse a YAML frontmatter block; `undefined` when it is not a mapping (or not YAML). */
function parseBlock(block: string): Record<string, unknown> | undefined {
  let value: unknown;
  try {
    value = yaml.parse(block);
  } catch {
    return undefined;
  }
  // An empty (or comments-only) block is an empty mapping: `---\n---\n` is frontmatter.
  if (value === undefined || value === null) return {};
  return isPlainMapping(value) ? value : undefined;
}

/** Split markdown (or a thread file) into its frontmatter head and body. */
export function splitFrontmatter(raw: string): SplitDocument {
  const bom = raw.startsWith(BOM) ? BOM : "";
  const text = raw.slice(bom.length);
  const none: SplitDocument = { head: bom, data: {}, hasFrontmatter: false, body: text };
  const open = OPEN.exec(text);
  if (!open) return none;
  const rest = text.slice(open[0].length);
  const close = CLOSE.exec(rest);
  if (!close) return none;
  const data = parseBlock(rest.slice(0, close.index));
  if (!data) return none;
  const headLen = open[0].length + close.index + close[0].length;
  return { head: bom + text.slice(0, headLen), data, hasFrontmatter: true, body: text.slice(headLen) };
}

/** Split a document: HTML is all body; markdown per `splitFrontmatter`. */
export function splitDocument(raw: string, docPath: string): SplitDocument {
  if (isHtmlDoc(docPath)) return { head: "", data: {}, hasFrontmatter: false, body: raw };
  return splitFrontmatter(raw);
}

/** The document body the editor and agents see: frontmatter-stripped markdown, or raw HTML. */
export function documentBody(raw: string, docPath: string): string {
  return splitDocument(raw, docPath).body;
}

/**
 * Replace a document's body, keeping whatever precedes it (BOM, frontmatter) byte for
 * byte. `raw` is the document as it is on disk now; for HTML the result is `body`.
 */
export function replaceBody(raw: string, docPath: string, body: string): string {
  return splitDocument(raw, docPath).head + body;
}

/**
 * Serialize `data` as a YAML frontmatter block followed by `body` (a trailing newline is
 * added when missing) — the thread-file format. `body` is written as given, never parsed.
 */
export function stringifyFrontmatter(data: Record<string, unknown>, body: string): string {
  const withNewline = body.endsWith("\n") ? body : `${body}\n`;
  if (Object.keys(data).length === 0) return withNewline;
  return `---\n${yaml.stringify(data).trim()}\n---\n${withNewline}`;
}
