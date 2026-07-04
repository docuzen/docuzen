# Visual regression suite

Screenshots the app in a fixed set of states, in both light and dark browser
color schemes, and pixel-diffs each one against a committed baseline. Built
after the dark-mode table bug (near-black GFM table cells with dark text,
because `@milkdown/theme-nord`'s CSS keys several rules off
`prefers-color-scheme: dark` while the rest of the app is hard-coded light)
slipped through review with nobody looking at a screenshot in dark mode.

## Run

```
npm run visual
```

Boots a fresh docd sidecar + Vite dev server per color scheme (same
launcher as `tools/parity`, see `support.mjs`), drives Playwright through
every state in `states.mjs`, and compares each screenshot in
`tools/visual/current/<scheme>/` against `tools/visual/baseline/<scheme>/`
using pixelmatch. Exits non-zero and lists every failing `scheme/state` if
anything differs beyond the per-image threshold (see `compare.mjs`); diff
images (baseline vs. current, mismatched pixels highlighted) land in
`tools/visual/diff/<scheme>/`.

## Update the baseline

```
node tools/visual/run.mjs --update
```

Regenerates `tools/visual/baseline/**/*.png` instead of comparing. **Always
eyeball every regenerated PNG before committing** — this suite only proves a
screenshot stopped changing, not that it looks right. Nothing enforces the
eyeball step; that's on you.

## What's covered

Every state is captured against `tools/visual/fixtures/table-doc.md` (a GFM
table + a fenced code block with box-drawing ASCII art + bold/inline-code + a
```mermaid``` flowchart — committed, not regenerated):

1. **`01-table-doc`** — the doc on load: table rendered as an actual grid,
   fenced code block intact.
2. **`02-annotated`** — after creating an annotation + comment card through
   the real selection-popover UI (triple-click a paragraph → Comment).
3. **`03-chat-turn`** — the chat pane with a real `.turn-you` bubble, after
   typing into the new comment card and clicking "Ask agent". The agent side
   settles to a deterministic `⚠ agent harness unavailable: pi …` error
   bubble rather than a live reply — this suite's sidecar always runs
   without `LLM_API_KEY` (see `tools/parity/launch.mjs`), and
   `orchestrator.ts`'s `discuss()` resolves the harness and throws
   synchronously as its first statement, before any network I/O. That makes
   this a real, deterministic discussion turn rather than a faked one; it's
   the only way to get one on screen without wiring up a live LLM or a
   scripted fake-runner sidecar.
4. **`04-search-open`** — the search panel open with matches, including one
   inside a table cell (not just top-level prose).
5. **`05-left-collapsed`** — the Agent discussion pane hidden via the topbar's
   left-pane toggle (Phase 11 T1); the document canvas expands to fill the
   freed space.
6. **`06-both-collapsed`** — both the Agent discussion pane and the Review
   rail hidden, the document canvas at its widest.
7. **`07-diagram-lightbox`** — the mermaid diagram lightbox (mermaid-lightbox.ts)
   open, after hovering the fixture's rendered "Annotation lifecycle" flowchart
   to reveal its hover-only "expand" button and clicking it. Covers the
   full-viewport pan/zoom overlay's initial (100%, centered) state.

**Skipped, on purpose:** the diff panel / proposal card (a full-rewrite
review or an applied edit proposal). Every path that produces one requires a
harness that actually completes a turn (an LLM reply, or Codex's fenced-json
edit output) — unlike state 3 above, there's no way to reach it through a
guaranteed-fast local failure, only by either running a live model or adding
a scripted fake-agent sidecar. Out of scope for this pass; if this ever gets
built, wire a `FakePiRunner` (already exists in
`packages/docd/src/agent/fake-runner.ts`, used by that package's own tests)
into `support.mjs`'s launcher instead of relying on the real `docd` binary.

## Why both light AND dark, every state

The bug this suite exists to catch was invisible unless you actually looked
at the app in dark mode: the table rendered fine in light mode, and nothing
in the app's own (light-only) CSS or test suite ever exercised
`prefers-color-scheme: dark`. Capturing every state once per color scheme is
the direct fix for that blind spot — a regression that only shows up in one
scheme fails loudly here instead of shipping unnoticed again.
