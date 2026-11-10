// The chat pane's transcript: rendering persisted turns, and the live "working" bubble an
// in-flight agent turn streams into (reasoning, tool activity, reply). Pure DOM over the
// #chatTurns list — no RPCs, no thread state. Split out of chat.ts; everything it needs
// from the pane arrives through `deps`.
import type { RpcEvent, ThreadTurn } from "@ai-native-doc/docd/protocol";
import type { HtmlSnippetPreviewContext } from "./html-snippet-preview.js";
import { renderMarkdownReply } from "./markdown-reply.js";
import { WAIT_PHASE, phaseForEvent, startWaitStatus } from "./wait-status.js";

export interface TranscriptDeps {
  /** HTML-preview-aware text rendering for agent text (main.ts-owned). */
  renderPreviewText: (into: HTMLElement, text: string, context?: HtmlSnippetPreviewContext | null) => void;
  /** Open the edit-to-fork editor on a persisted "you" turn (✎ / double-click). */
  onEditTurn: (turnEl: HTMLDivElement, original: string, turnIndex: number) => void;
  /** Display name for a model key. */
  modelName: (key: string) => string;
  /** The footer model picker's current value ("" = default). */
  getFooterModelId: () => string;
}

/** A live agent turn's handle: feed it stream events, then settle it exactly once. */
export interface StreamingTurn {
  onEvent: (e: RpcEvent) => void;
  /**
   * `finalText`, when given, is the persisted reply — the source of truth, which can
   * differ from the raw stream (e.g. Codex's trailing fenced-json edit block is stripped
   * server-side into turn.proposal).
   */
  done: (finalText?: string) => void;
  fail: (msg: string) => void;
}

export interface TranscriptApi {
  renderTurnText: (into: HTMLElement, role: ThreadTurn["role"], text: string) => void;
  /** Append a persisted turn; returns its `.tbody` element. */
  chatTurn: (
    role: ThreadTurn["role"],
    text: string,
    meta?: string,
    thinking?: string,
    turnIndex?: number,
  ) => HTMLDivElement;
  chatTurnWithAction: (label: string, onClick: () => void) => void;
  streamingAgentTurn: (meta?: string, modelId?: string) => StreamingTurn;
}

export function initTranscript(deps: TranscriptDeps): TranscriptApi {
  const chatTurnsEl = document.querySelector<HTMLDivElement>("#chatTurns")!;
  const chatEmptyEl = document.querySelector<HTMLDivElement>("#chatEmpty")!;

  function renderTurnText(into: HTMLElement, role: ThreadTurn["role"], text: string): void {
    into.classList.remove("md");
    if (role === "agent") {
      deps.renderPreviewText(into, text);
      // Not an HTML snippet (those get a rendered preview frame): the reply is markdown.
      if (!into.classList.contains("html-snippet-host")) renderMarkdownReply(into, text);
    } else {
      delete into.dataset.rawText;
      into.classList.remove("html-snippet-host");
      into.textContent = text;
    }
  }

  function renderTurn(
    into: HTMLElement,
    role: ThreadTurn["role"],
    text: string,
    meta?: string,
    thinking?: string,
    turnIndex?: number,
  ): HTMLDivElement {
    const t = document.createElement("div");
    t.className = `turn turn-${role}`;
    const head = document.createElement("div");
    head.className = "trole";
    head.textContent =
      role === "agent" ? `Agent · ${meta ?? "default"}` : role === "you" ? `You${meta ? ` · ${meta}` : ""}` : "System";
    t.appendChild(head);
    // Persisted "you" turns can be edited to fork a new branch from that point.
    // Live/streaming turns (no index) and agent/system turns get no ✎.
    if (role === "you" && turnIndex != null) {
      // Marks this bubble as the double-click-to-fork
      // target (Cursor-style) — refreshEditLocks() below queries this exact class to
      // keep the ✎ button + bubble's disabled/tooltip state in sync with busy state.
      t.classList.add("turn-editable");
      const editBtn = document.createElement("button");
      editBtn.className = "turnedit";
      editBtn.title = "Edit & branch from here";
      editBtn.textContent = "✎";
      editBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        deps.onEditTurn(t, text, turnIndex);
      });
      head.appendChild(editBtn);
      // Double-click anywhere on the bubble opens the same inline editor as ✎ —
      // beginEditBranch is the single source of truth for both triggers (including
      // its own busy-thread refusal), so this is a thin alias, not a forked flow.
      // Bubbling into an already-open .turnedit-box (e.g. double-clicking to select
      // a word while editing) re-enters beginEditBranch, which no-ops harmlessly
      // (see its own "already editing this turn?" guard) without touching the
      // browser's native double-click-to-select-word behavior in the textarea.
      t.addEventListener("dblclick", (ev) => {
        ev.stopPropagation();
        deps.onEditTurn(t, text, turnIndex);
      });
    }
    // Persisted reasoning: collapsible, collapsed by default.
    if (thinking) {
      const d = document.createElement("details");
      d.className = "think saved";
      const sm = document.createElement("summary");
      sm.textContent = "💭 reasoning";
      d.appendChild(sm);
      const tb = document.createElement("div");
      tb.className = "thinkbody";
      tb.textContent = thinking;
      d.appendChild(tb);
      t.appendChild(d);
    }
    const b = document.createElement("div");
    b.className = "tbody";
    renderTurnText(b, role, text);
    t.appendChild(b);
    into.appendChild(t);
    into.scrollTop = into.scrollHeight;
    return b;
  }
  function chatTurn(
    role: ThreadTurn["role"],
    text: string,
    meta?: string,
    thinking?: string,
    turnIndex?: number,
  ): HTMLDivElement {
    chatEmptyEl.hidden = true;
    return renderTurn(chatTurnsEl, role, text, meta, thinking, turnIndex);
  }
  /**
   * A system chat line with a trailing clickable "[review]" affordance. Used when a
   * reopened doc has a pending full rewrite: we don't slam the modal in the user's
   * face on load — they click to open it. Label text goes via textContent (XSS-safe).
   */
  function chatTurnWithAction(label: string, onClick: () => void): void {
    const body = chatTurn("system", label); // chatTurn returns the .tbody element
    body.appendChild(document.createTextNode(" "));
    const btn = document.createElement("button");
    btn.className = "reviewlink";
    btn.textContent = "[review]";
    btn.addEventListener("click", onClick);
    body.appendChild(btn);
  }

  // Demoted secondary line shown under BOTH a genuine thrown error and the rare honest
  // "no response" fallback below — generic troubleshooting context, not the headline (see
  // renderFailBody's doc comment).
  const AGENT_FAIL_HINT =
    "Check the model in File ▸ Settings: a wrong/forbidden model id, an unreachable" +
    " gateway, or rate-limiting all look like this.";

  /**
   * A live agent turn that shows a working spinner, streamed 💭 reasoning, 🔧 tool
   * activity, and the reply — until done() clears the working state.
   *
   * `modelId` names the model actually driving THIS bubble, used only to compute the
   * "who" in the empty-reply/fail text below — deliberately never `meta`: for discuss/
   * reply/branch, `meta` carries the STANCE (e.g. "none"), not a model id, so reusing it
   * there produced bubbles reading "No response from none". `meta` still drives the
   * visible `Agent · <meta>` header unchanged (stance IS the right label there; for a
   * panel run, `meta` is already the model name, which is also a fine "who" — see the
   * panel call site, which passes the same value for both).
   */
  function streamingAgentTurn(meta?: string, modelId?: string): {
    onEvent: (e: RpcEvent) => void;
    done: (finalText?: string) => void;
    fail: (msg: string) => void;
  } {
    chatEmptyEl.hidden = true;
    const t = document.createElement("div");
    t.className = "turn turn-agent working";
    // Structure via innerHTML, but the role label (meta) is user-derived (model
    // display names) — set it via textContent to avoid HTML injection.
    t.innerHTML = `
      <div class="trole"><span class="rolename"></span> <span class="spin"></span></div>
      <div class="think" hidden><div class="thinkhdr">💭 reasoning</div><div class="thinkbody"></div></div>
      <div class="tools" hidden></div>
      <div class="tbody"></div>`;
    t.querySelector<HTMLSpanElement>(".rolename")!.textContent = `Agent · ${meta ?? "default"}`;
    const thinkWrap = t.querySelector<HTMLDivElement>(".think")!;
    const thinkBody = t.querySelector<HTMLDivElement>(".thinkbody")!;
    const toolsEl = t.querySelector<HTMLDivElement>(".tools")!;
    const body = t.querySelector<HTMLDivElement>(".tbody")!;
    chatTurnsEl.appendChild(t);
    chatTurnsEl.scrollTop = chatTurnsEl.scrollHeight;
    // Phase + elapsed seconds, so the silent stretch before the first byte isn't a bare spinner.
    const status = startWaitStatus(t.querySelector<HTMLSpanElement>(".spin")!, WAIT_PHASE.waiting);
    const scroll = () => (chatTurnsEl.scrollTop = chatTurnsEl.scrollHeight);
    let replyText = "";
    // While streaming, tokens are appended to one text node — O(token), not a re-render
    // of the whole reply. The HTML-aware preview (regex scans + a sandboxed iframe per
    // call) is built once in done(), not once per token.
    let streamNode: Text | null = null;
    /**
     * Render an error bubble body as a prominent headline (the actual detail) plus a
     * smaller, demoted secondary line of generic troubleshooting hints — useful context,
     * but not the first thing a reviewer's eye should land on. Shared by fail() (a real
     * thrown error) and done()'s empty-reply fallback (no error was ever reported).
     */
    const renderFailBody = (headline: string): void => {
      body.textContent = "";
      const head = document.createElement("div");
      head.className = "tbody-fail-headline";
      head.textContent = `⚠ ${headline}`;
      const hint = document.createElement("div");
      hint.className = "tbody-fail-hint";
      hint.textContent = AGENT_FAIL_HINT;
      body.append(head, hint);
    };
    return {
      onEvent: (e) => {
        const d = String(e.data);
        const phase = phaseForEvent(e.event);
        if (phase) status.set(phase);
        if (e.event === "token") {
          replyText += d;
          if (!streamNode) {
            body.textContent = "";
            streamNode = document.createTextNode("");
            body.appendChild(streamNode);
          }
          streamNode.appendData(d);
        } else if (e.event === "thinking") {
          thinkWrap.hidden = false;
          thinkBody.textContent += d;
        } else if (e.event === "tool") {
          toolsEl.hidden = false;
          const l = document.createElement("div");
          l.className = "toolline";
          l.textContent = `Tool · ${d}`;
          toolsEl.appendChild(l);
        }
        scroll();
      },
      done: (finalText) => {
        status.stop();
        t.classList.remove("working");
        t.querySelector(".spin")?.remove();
        // A resolved-but-empty reply now only happens when the turn was stopped before
        // anything streamed, or (rare) the agent produced no reply/proposal/findings and
        // nothing failed either — pi-runner throws instead of resolving silently whenever
        // it captured a real error (see pi-runner.ts's finishTurn), so this is an honest
        // "nothing to show", not a hidden failure.
        if (!replyText) {
          body.className = "tbody empty-reply";
          const who = deps.modelName(modelId || deps.getFooterModelId()) || "the agent";
          renderFailBody(`No response from ${who} — it returned no content.`);
        } else {
          // One full render at the end: the persisted reply when it is known (it can differ
          // from the raw stream — e.g. Codex's trailing fenced-json edit block is stripped
          // server-side into turn.proposal, see Phase-8 T1 — and must replace it so the raw
          // JSON never stays visible), else the accumulated stream.
          renderTurnText(body, "agent", finalText ?? replyText);
        }
      },
      fail: (msg) => {
        body.className = "tbody agent-fail";
        renderFailBody(msg);
        status.stop();
        t.classList.remove("working");
        t.querySelector(".spin")?.remove();
      },
    };
  }

  return { renderTurnText, chatTurn, chatTurnWithAction, streamingAgentTurn };
}
