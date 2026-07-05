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
    chat["chat.ts<br/>discussion pane, threads, send queue,<br/>agents panel, comment cards,<br/>review/directive drivers, edit-to-fork"]
    surface["surface.ts<br/>HTML iframe surface, in-doc search,<br/>selection popover + quick actions"]
    proposals["proposals.ts<br/>proposal widgets, diff panel<br/>(uses docd diffToHunks)"]
    shell["shell.ts<br/>tabs + session restore, window title,<br/>settings, versions, menu, layout toggles,<br/>harness/model badge"]
    leaves["leaf modules<br/>anchor-map, click-jump, doc-search,<br/>proposal-locate, version-picker-tree,<br/>html-projection / html-surface / html-snippet-preview"]
  end

  subgraph docd["packages/docd — sidecar (Node)"]
    ws["server/ws-server + main.ts<br/>WebSocket RPC server, harness registration"]
    handler["rpc/handler.ts<br/>pure dispatch: paramsFor + tokenSink,<br/>typed case-by-case from RpcSchema"]
    protocol["protocol/<br/>RpcSchema (32 methods) + domain-type re-exports<br/>— the ONE wire contract both sides compile against"]
    orch["orchestrator/<br/>Orchestrator: runTurn / runAgentStep engine,<br/>buildContext, transition() status writer,<br/>withEditSnapshot, proposal persist/approve (idempotent),<br/>reconcile-on-open, diffToHunks, thread-tree"]
    had["had/<br/>on-disk .docuzen review store: doc-store, annotations,<br/>thread, versions, proposals, settings, manifest,<br/>resolve, hide, bundle (.hadz), comment, doc-format"]
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
- **Conversation ≠ edit.** Tool policy, prompt contracts, and the Codex reply parser all key off the same context predicate.

## Verification tooling

| Tool | What it proves | Run |
|---|---|---|
| Unit/integration suites (docd 376, desktop 238) | module behavior; orchestration via injected `FakePiRunner` | `npm test` |
| `tools/parity/` | branch behaves identically to `main` across scripted browser flows (boot, render, search, annotate, persistence, panels) | `node tools/parity/run.mjs --main <tree> --candidate <tree>` |
| `tools/parity/reconnect-drill.mjs` | live kill/restart of the sidecar under a running app self-heals without reload | `node tools/parity/reconnect-drill.mjs` |
| `tools/visual/` | 12 baseline screenshots (key states × light/dark OS scheme) pixel-match | `npm run visual` (`--update` to accept changes) |
