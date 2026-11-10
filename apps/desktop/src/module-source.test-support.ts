// Test support only (never imported by the app). The chat region lives in several
// modules; the older tests assert on its source TEXT, so they read all of it as one
// string. Order follows where each piece used to sit in chat.ts, so a
// `sourceBetween(start, end)` slice still finds an `end` marker that now lives in the
// next module along.
// Prefer a behavioural test (chat-behaviour.test.ts) for anything new.
import { readFileSync } from "node:fs";

export const CHAT_MODULES = ["chat-transcript.ts", "chat-improve.ts", "chat.ts", "chat-comment-cards.ts", "chat-thread-tree.ts", "chat-doc-passes.ts", "chat-agents-panel.ts"] as const;

export const chatSource = CHAT_MODULES.map((f) => readFileSync(new URL(`./${f}`, import.meta.url), "utf8")).join("\n");

/** Same idea for the app shell: shell.ts plus the modules split out of it. */
export const SHELL_MODULES = ["shell.ts", "shell-settings.ts", "shell-versions.ts"] as const;

export const shellSource = SHELL_MODULES.map((f) => readFileSync(new URL(`./${f}`, import.meta.url), "utf8")).join("\n");

/** The document surfaces: the search panel (split out first) followed by the rest. */
export const SURFACE_MODULES = ["search-panel.ts", "selection-agent-actions.ts", "surface.ts"] as const;

export const surfaceSource = SURFACE_MODULES.map((f) => readFileSync(new URL(`./${f}`, import.meta.url), "utf8")).join("\n");
