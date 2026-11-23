import { constants, createReadStream } from "node:fs";
import { access, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  detectSupportedImageMimeTypeFromFile,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

// pi's built-in read/grep/ls/find resolve their `path` argument with no containment check:
// `../`, absolute paths, `~` and symlinks all reach anywhere the docd process can read. A
// session's file tools must stay inside its scope folder (the document's folder, or its
// repo), so docuzen passes pi replacements of those four tools — pi's own implementations,
// with every path checked against the scope's real path first. A same-named custom tool
// replaces the built-in one in pi's tool registry.
//
// rg and fd (behind grep and find) don't follow symlinks while walking a tree, and ls only
// lists names, so checking the folder or file a call starts from is enough for those three.

const UNICODE_SPACES = /[  -   　]/g;

/**
 * The absolute path pi's ls/grep/find tools act on for `input` — a copy of pi's
 * `resolveToCwd` (utils/paths.ts `normalizePath` + `resolvePath`), which pi doesn't export.
 * POSIX only, like docuzen: pi's Windows shell-path rewriting is not reproduced.
 */
export function resolveLikePi(input: string, cwd: string): string {
  const expand = (p: string): string => {
    if (p === "~") return homedir();
    if (p.startsWith("~/")) return join(homedir(), p.slice(2));
    if (/^file:\/\//.test(p)) return fileURLToPath(p);
    return p;
  };
  let p = input.replace(UNICODE_SPACES, " ");
  if (p.startsWith("@")) p = p.slice(1);
  p = expand(p);
  return isAbsolute(p) ? resolve(p) : resolve(expand(cwd), p);
}

/** `path` with every symlink resolved; a missing tail is appended to its deepest existing ancestor. */
async function realpathOfMaybeMissing(path: string): Promise<string> {
  const missing: string[] = [];
  let head = path;
  for (;;) {
    try {
      return join(await realpath(head), ...missing);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw e;
      const parent = dirname(head);
      if (parent === head) return path;
      missing.unshift(basename(head));
      head = parent;
    }
  }
}

export type ScopeCheck = (absolutePath: string, requested?: string) => Promise<string>;

/**
 * A check that resolves `absolutePath` through every symlink and rejects it unless it is
 * `scopeDir` or inside it. Resolves with the real path when it is allowed.
 */
export function scopeCheck(scopeDir: string): ScopeCheck {
  let root: Promise<string> | undefined;
  return async (absolutePath, requested = absolutePath) => {
    root ??= realpath(scopeDir);
    const [base, real] = await Promise.all([root, realpathOfMaybeMissing(absolutePath)]);
    const inside = real === base || real.startsWith(base.endsWith(sep) ? base : base + sep);
    if (!inside) {
      throw new Error(
        `"${requested}" is outside the folder this session may read (${scopeDir}). Only files inside it are available.`,
      );
    }
    return real;
  };
}

type AnyTool = ToolDefinition<any, any, any>;

/** `tool` with its `path` argument checked against the scope before pi's own execute runs. */
function confined<T extends AnyTool>(tool: T, cwd: string, check: ScopeCheck): T {
  return {
    ...tool,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const path = (params as { path?: unknown } | undefined)?.path;
      const requested = typeof path === "string" && path ? path : ".";
      await check(resolveLikePi(requested, ctx?.cwd || cwd), requested);
      return tool.execute(toolCallId, params, signal, onUpdate, ctx);
    },
  };
}

/**
 * pi's read, grep, ls and find tools for a session rooted at `cwd`, confined to `scopeDir`.
 * read is also checked at the file it actually opens: when the named file is missing, pi's
 * read tries spelling variants of the whole path (macOS screenshot names, NFD, curly quotes).
 */
export function scopedFileTools(cwd: string, scopeDir: string): AnyTool[] {
  const check = scopeCheck(scopeDir);
  const read = createReadToolDefinition(cwd, {
    operations: {
      access: async (p) => access(await check(p), constants.R_OK),
      readFile: async (p) => readFile(await check(p)),
      detectImageMimeType: async (p) => detectSupportedImageMimeTypeFromFile(await check(p)),
      createReadStream: (p, { signal }) =>
        (async function* () {
          yield* createReadStream(await check(p), { signal });
        })(),
    },
  });
  return [
    confined(read, cwd, check),
    confined(createGrepToolDefinition(cwd), cwd, check),
    confined(createLsToolDefinition(cwd), cwd, check),
    confined(createFindToolDefinition(cwd), cwd, check),
  ];
}
