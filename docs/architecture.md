# Docuzen Architecture

Docuzen is a document-review desktop app: a **Tauri/WKWebView frontend** (also runs in a plain browser during development) talking over one WebSocket to a **Node sidecar (`docd`)** that owns all document state, agent orchestration, and LLM harnesses. Review state lives in a hidden `.docuzen/` directory at the repo root (`.docuzen/<relpath>.had/`; next to the document when it isn't in a git repo) — the document itself is never written except by explicit edit actions, and `.docuzen/` stays out of `git status` via the user's global git excludes file. Portable bundles use `.hadz`.

## System overview

```mermaid
flowchart TB
  subgraph desktop["apps/desktop — frontend (Vite, Tauri WKWebView or browser)"]
    main["main.ts<br/>composition root — builds the session store,<br/>wires every module via deps (no cross-imports)"]
    session["session.ts<br/>DocSession store + DocdApi facade<br/>(typed from RpcSchema, docPath auto-bound)"]
    rpcC["rpc.ts<br/>WebSocket client<br/>auto-reconnect, call queue, status"]
    ui["ui.ts<br/>shared helpers: el, wireModal,<br/>proposalActions, runStreamingTurn, reportError"]
    editor["editor.ts<br/>Milkdown/ProseMirror (commonmark + GFM)<br/>plugins: annotations, proposal overlay, search,<br/>directive chips, meta-click jump, mermaid"]
    chat["chat.ts — the chat pane: opening threads, sending<br/>(queue, exclusive turns, Panel), edit-to-fork<br/>+ chat-transcript, chat-comment-cards, chat-thread-tree,<br/>chat-improve, chat-doc-passes (Review, Resolve [[ ]]),<br/>chat-agents-panel, send-queue (pure)"]
    surface["surface.ts — selection popover, annotating either<br/>surface, annotation menu, HTML iframe overlays<br/>+ search-panel (in-doc search),<br/>selection-agent-actions (Brainstorm, Visualize)"]
    proposals["proposals.ts<br/>proposal widgets, diff panel<br/>(uses docd diffToHunks)"]
    shell["shell.ts — tabs + session restore, file actions,<br/>menu, layout toggles, window title<br/>+ shell-settings (settings, model manager, badge),<br/>shell-versions (preview + picker), tab-model (pure)"]
    leaves["leaf modules<br/>anchor-map, click-jump, doc-search,<br/>proposal-locate, version-picker-tree,<br/>html-projection / html-surface / html-snippet-preview"]
  end

  subgraph docd["packages/docd — sidecar (Node)"]
    ws["server/ws-server + main.ts<br/>WebSocket RPC server, harness registration"]
    handler["rpc/handler.ts<br/>one typed handler per wire method<br/>(RpcHandlers mapped from RpcSchema:<br/>params AND results compiler-checked)"]
    protocol["protocol/<br/>RpcSchema (34 methods) + domain-type re-exports<br/>— the ONE wire contract both sides compile against"]
    orch["orchestrator/<br/>orchestrator.ts: turn engine (runTurn / runAgentStep),<br/>flows (review, directives, improve, branch), reconcile<br/>context.ts: what an agent is told (buildAgentContext)<br/>proposal-service.ts: submit → approve | reject,<br/>both edit modes on ONE apply path<br/>turn-status.ts: transition() status writer"]
    had["had/<br/>on-disk .docuzen review store: doc-store, annotations,<br/>thread, versions, proposals, settings, manifest,<br/>resolve, hide, bundle (.hadz), comment, doc-format<br/>io.ts: atomic replace + per-file serialized<br/>read-modify-write under every one of them"]
    taskdb["state/task-db.ts<br/>SQLite task rows<br/>(status + errorText)"]
    agent["agent/<br/>harness-registry, runner-base, prompt-sections,<br/>tool-policy, mcp + mcp-bridge,<br/>html-validation, web-search, model-registry"]
    pi["pi-runner<br/>in-process SDK sessions;<br/>tools: propose_edit, add_review_finding,<br/>validate_html, web_search, mcp proxy"]
    codex["codex-runner<br/>spawns codex CLI, streams NDJSON<br/>(tokens / thinking / tool markers),<br/>fenced-json edit contract → proposals"]
    fake["fake-runner<br/>scripted test double"]
  end

  subgraph external["external"]
    llm["LLM API<br/>(pi via litellm etc.)"]
    codexcli["codex CLI<br/>(subprocess)"]
    disk["document + .docuzen/ review store<br/>(annotations, threads, versions,<br/>proposals, settings, state.db)"]
  end

  cli["packages/cli — docuzen launcher<br/>(spawns the server)"]

  main --> session & ui & editor & chat & surface & proposals & shell
  editor & chat & surface & proposals & shell -.-|"deps only"| ui
  session --> rpcC
  editor & surface --> leaves
  rpcC <-->|"one WebSocket<br/>requests + streamed events<br/>(token, thinking, finding, proposal)"| ws
  ws --> handler
  handler --> orch
  handler --> had
  protocol -.-|"import type (compile-time contract)"| session
  protocol -.- handler
  orch --> had & taskdb & agent
  agent --> pi & codex & fake
  pi --> llm
  codex --> codexcli
  had --> disk
  taskdb --> disk
  cli --> ws
```

## Agent turn lifecycle

Every agent interaction flows through one engine; the six entry points differ only in the spec they build. Conversation turns (discuss/reply/panel) never carry edit capability; explicit actions (Improve, Resolve `[[ ]]`, Review) do.

```mermaid
flowchart LR
  entry["discuss / reply / panel<br/>(conversation-only)<br/>improve / resolveDirectives<br/>(edit-capable)<br/>branch (fork)"] --> runTurn
  runTurn["runTurn<br/>thread init → you-turn →<br/>transition(running)"] --> step["runAgentStep<br/>buildContext → invoke runner<br/>→ append agent turn"]
  step --> settle["transition(responded | error)<br/>errorText persisted"]
  settle --> persist["persistProposal<br/>(edit-capable turns only)<br/>→ 'proposal' event → inline widget"]
  review["review<br/>(bespoke: umbrella thread seeded post-invoke,<br/>findings materialize as annotations+threads)"] --> settle
```

Key invariants the code enforces:

- **One wire contract.** `protocol/rpc.ts` types both the handler's dispatch and the desktop facade; adding a field on one side is a compile error until both agree.
- **One status writer.** `transition()` is the only code that writes turn status to the TaskDB and thread frontmatter; `reconcile()` (run on every document open) repairs rows orphaned by a crash, and one bad row can never block a document from opening.
- **One apply path.** `approveProposal` handles hunks, full rewrites, and legacy single-span proposals (converted at approve time); approve/reject are idempotent — re-resolving an already-resolved proposal reports its status instead of corrupting it.
- **Two edit modes, one write path.** Per document, agent edits are either *Suggesting* (`agentEdit: "propose"`, default — each edit is a pending proposal) or *Editing* (`"direct"` — edits from Improve / Resolve `[[ ]]` / Review apply as they arrive). Editing is "submit, then approve on the spot" inside `ProposalService`, not a second path: the agent never has write tools, every applied edit is a recorded proposal with a pre-apply backup version, HTML is validated, and an edit whose text is gone stays pending instead of being misapplied.
- **Crash- and race-safe storage.** Every review-state file is replaced atomically (temp file + rename) and every read-modify-write runs under a per-file lock (`had/io.ts`); sequential ids (annotations, proposals, versions) are allocated inside that lock.
- **Conversation ≠ edit.** Tool policy, prompt contracts, and the Codex reply parser all key off the same context predicate.

## Future work

- **A purpose-built harness on an agent SDK.** `pi` (any provider via `models.json`, multi-model Panel) and `codex` (CLI subprocess, edits via a fenced-JSON reply contract, no review findings) are the two harnesses today. The intended third is a custom harness written directly against an agent SDK, exposing `propose_edit` / `add_review_finding` as real tools with permission hooks rather than adapting a general-purpose coding CLI. The `"claude-code"` harness id is reserved for it across `HarnessId`, `HadSettings.harness` and the thread frontmatter, and the Settings UI already has a "harness-managed models" branch for a harness that brings its own model config. `HarnessRegistry` + `HarnessCapabilities` are the seam: register one more `AgentHarness`, and extend `selectRunner`'s usable-default order.
- **Remaining desktop consolidation.** The three former monoliths are split by responsibility (`chat*.ts`, `shell*.ts`, `surface.ts` + `search-panel.ts` + `selection-agent-actions.ts`), each split preceded by behavioural tests against the real DOM (`chat-behaviour`, `shell-behaviour`, `tabs-lifecycle`, `selection-agent-actions`). Still to do, in the same order (behavioural test first, then move): `chat.ts`'s edit-to-fork and Panel fan-out, `surface.ts`'s HTML-overlay rendering, and retiring the older tests that assert on source text (they read whole regions through `module-source.test-support.ts`) as behavioural tests replace them.

## Verification tooling

| Tool | What it proves | Run |
|---|---|---|
| Unit/integration suites (docd 475, desktop 401, cli 2) | module behavior; orchestration via injected `FakePiRunner`; storage atomicity + concurrency (`had/io`); both edit modes (`edit-modes`); real pi turns through the SDK against a mock model server (`pi-runner-e2e`); the desktop UI driven through index.html's real DOM with a scripted sidecar (`chat-behaviour`, `shell-behaviour`, `tabs-lifecycle`, `selection-agent-actions`) | `npm test` |
| `tools/version.mjs`, `tools/demo/check-docs.mjs` | every manifest carries the same version; docs don't describe the old storage model | `npm run test:tools` (part of `npm test`) |
| `tools/parity/` | branch behaves identically to `main` across scripted browser flows (boot, render, search, annotate, persistence, panels) | `node tools/parity/run.mjs --main <tree> --candidate <tree>` |
| `tools/parity/reconnect-drill.mjs` | live kill/restart of the sidecar under a running app self-heals without reload | `npm run drill:reconnect` |
| `tools/live/run.mjs` | every agent flow against a REAL model through the real sidecar RPC: discuss/reply, Improve → approve, directives, review, Editing mode, built-in + MCP tool use. Structural assertions only. Needs a keyed pi model; costs tokens; not in `npm test` | `npm run live` (`-- --model provider/id`, `-- --only discuss,direct`) |
| `tools/live/ui.mjs` | the real frontend + real sidecar + a real model in a browser: comment → Ask agent → a message queued mid-turn → reply → Improve → Apply | `npm run live:ui` |
| `tools/visual/` | 14 baseline screenshots (7 key states × light/dark OS scheme) pixel-match | `npm run visual` (`--update` to accept changes). Hermetic: the sidecar runs with a throwaway HOME, so results don't depend on the developer's config |
