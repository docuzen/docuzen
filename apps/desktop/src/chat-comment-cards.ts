// The review rail's comment cards and the registry behind them: one `CommentEntry` per
// comment thread in the open document (plus hidden entries for branch threads, which have
// no card of their own). Owns the card DOM and its status chip / Ask-agent button state.
//
// It does NOT run agent turns: clicking "Ask agent" hands the request to the chat pane
// through `deps` (`onAskAgent` for a first message, `onResend` for a thread that already
// has a conversation). Split out of chat.ts; reaches the pane only through `deps`.
import { excerpt } from "./excerpt.js";
import type { ThreadNode } from "@ai-native-doc/docd/protocol";
import type { DocdApi } from "./session.js";
import { confirmAction, el } from "./ui.js";

export type CardStatus = "idle" | "running" | "responded" | "error";

/** One comment thread in the registry. */
export interface CommentEntry {
  id: string;
  quoted: string;
  card: HTMLDivElement;
  chip: HTMLSpanElement;
  discussBtn: HTMLButtonElement;
  stanceSel: HTMLSelectElement;
  commentInput: HTMLTextAreaElement;
  /** True once the thread has an agent reply — the next message is a reply, not a first ask. */
  discussed: boolean;
  resolved: boolean;
  parent?: string; // set for branch threads forked from another thread
  /** The persisted thread state has been applied once; later listings must not override live state. */
  hydrated?: boolean;
}

/** What the card's Ask-agent button submits for a thread's first message. */
export interface CardAsk {
  comment: string;
  stance: string;
  modelId?: string;
}

export interface CommentCardsDeps {
  api: DocdApi;
  log: (line: string) => void;
  getDocPath: () => string | undefined;
  /** Full annotation removal (backend delete + in-document decoration); main.ts-owned. */
  removeAnnotationById: (id: string) => Promise<void>;
  /** Fill a model <select> with the configured models, defaulting to the doc's model. */
  fillModelPicker: (sel: HTMLSelectElement) => void;
  /** The set of threads changed (card added, branch registered, entry removed). */
  onRegistryChanged: () => void;
  /** Open this thread in the chat pane (card body click). */
  onOpen: (id: string) => void;
  /** Send the thread's FIRST message to the agent, streaming into the chat pane. */
  onAskAgent: (entry: CommentEntry, ask: CardAsk) => Promise<void>;
  /** The thread already has a conversation: open it and get the footer ready to resend. */
  onResend: (entry: CommentEntry) => Promise<void>;
}

export interface CommentCardsApi {
  /** The live registry. Insertion order is rail order (oldest first). */
  comments: Map<string, CommentEntry>;
  addCommentCard: (
    id: string,
    quoted: string,
    body?: string,
    num?: number,
    author?: string,
    resolved?: boolean,
    reviewMeta?: { origin?: string; severity?: string; kind?: string },
  ) => void;
  registerBranchEntry: (branchId: string, quoted: string, parentId: string) => void;
  /** Drop a thread's entry, its card, and its branch children. False if it wasn't registered. */
  removeEntry: (id: string) => boolean;
  setChip: (id: string, status: CardStatus) => void;
  /** Chip + Ask-agent button label/enabled state for one card. */
  setCommentActionState: (entry: CommentEntry, status: CardStatus) => void;
  /**
   * Restore each not-yet-hydrated card's persisted state (error / already discussed, and
   * the last message for a resend) from ONE thread listing — instead of one getThread
   * round-trip per card on every document load.
   */
  applyThreadNodes: (nodes: ThreadNode[]) => void;
  /** Empty the registry and the rail (document switch). */
  clear: () => void;
}

function chipText(s: string): string {
  return s === "running" ? "running" : s === "responded" ? "responded" : s === "error" ? "error" : "";
}

export function initCommentCards(deps: CommentCardsDeps): CommentCardsApi {
  const commentsEl = document.querySelector<HTMLDivElement>("#comments")!;
  const comments = new Map<string, CommentEntry>();

  function setChip(id: string, status: CardStatus): void {
    const e = comments.get(id);
    if (!e) return;
    e.chip.className = `chip ${status}`;
    e.chip.textContent = chipText(status);
  }

  function setCommentActionState(e: CommentEntry, status: CardStatus): void {
    setChip(e.id, status);
    const discussBtn = e.discussBtn;
    if (status === "running") {
      discussBtn.textContent = "Asking...";
      discussBtn.disabled = true;
    } else if (status === "error") {
      discussBtn.textContent = "Retry";
      discussBtn.disabled = false;
    } else {
      discussBtn.textContent = "Ask agent";
      discussBtn.disabled = status === "responded";
    }
  }

  /** A compact margin comment: number + author + text + stance + actions. */
  function addCommentCard(
    id: string,
    quoted: string,
    body = "",
    num = 0,
    author?: string,
    resolved = false,
    reviewMeta?: { origin?: string; severity?: string; kind?: string },
  ): void {
    const card = document.createElement("div");
    card.className = "comment-card";
    card.dataset.anno = id;
    card.innerHTML = `
      <div class="chead"><span class="cnum"></span><span class="quoted"></span></div>
      <div class="cmeta"><span class="cauthor"></span><span class="cresolved">✓ resolved</span></div>
      <textarea class="cinput" rows="2" placeholder="Comment…"></textarea>
      <div class="crow">
        <select class="stance" title="Agent stance">
          <option value="none">🗣 none</option>
          <option value="critiquer">🔍 critiquer</option>
          <option value="supporter">🤝 supporter</option>
        </select>
        <select class="cmodel" title="Model"></select>
        <button class="discuss">Ask agent</button>
        <span class="chip idle"></span>
        <button class="delete" title="Delete comment">Delete</button>
      </div>`;
    card.querySelector<HTMLSpanElement>(".cnum")!.textContent = String(num);
    card.querySelector<HTMLSpanElement>(".quoted")!.textContent = `“${excerpt(quoted)}”`;
    // Agent-authored review findings are visually distinct: an "Agent review" author
    // and a severity/kind chip so the reviewer can triage at a glance.
    const isAgent = reviewMeta?.origin === "agent";
    card.querySelector<HTMLSpanElement>(".cauthor")!.textContent = isAgent
      ? "Agent review"
      : `${author ?? "you"}`;
    if (isAgent) {
      card.classList.add("agent");
      const sev = reviewMeta?.severity;
      const label = [sev, reviewMeta?.kind].filter(Boolean).join(" · ");
      if (label) {
        card.querySelector<HTMLDivElement>(".cmeta")!.prepend(
          el("span", { className: `revchip sev-${sev ?? "info"}`, textContent: label }),
        );
      }
    }
    if (resolved) card.classList.add("resolved");
    const input = card.querySelector<HTMLTextAreaElement>(".cinput")!;
    const stanceSel = card.querySelector<HTMLSelectElement>(".stance")!;
    const modelSel = card.querySelector<HTMLSelectElement>(".cmodel")!;
    deps.fillModelPicker(modelSel);
    const discussBtn = card.querySelector<HTMLButtonElement>(".discuss")!;
    const chip = card.querySelector<HTMLSpanElement>(".chip")!;
    input.value = body;

    const entry: CommentEntry = {
      id,
      quoted,
      card,
      chip,
      discussBtn,
      stanceSel,
      commentInput: input,
      discussed: false,
      resolved,
    };
    // Mirror `discussed` onto the card as a class, wherever it is set: once a thread has a
    // conversation AND is open in the chat pane, the card drops its duplicate controls (CSS).
    let discussed = false;
    Object.defineProperty(entry, "discussed", {
      enumerable: true,
      get: () => discussed,
      set: (v: boolean) => {
        discussed = v;
        card.classList.toggle("discussed", v);
      },
    });
    comments.set(id, entry);
    // Also what restores this card's persisted state: the listing this triggers is fed
    // back through applyThreadNodes (one fetch for the whole rail, coalesced).
    deps.onRegistryChanged();

    // Keep the field you're typing in visible: when the textarea gains focus, scroll
    // its card into view within the rail (the rail doesn't auto-follow focus on its own).
    input.addEventListener("focus", () => {
      card.scrollIntoView({ block: "nearest" });
    });

    input.addEventListener("blur", () => {
      if (deps.getDocPath() && !entry.discussed) {
        void deps.api.saveComment({ id, anchorExact: quoted, body: input.value }).catch(() => {});
      }
    });

    // Ask agent promotes this thread into the chat pane and streams the agent's reasoning
    // + reply there live, so you always see the response (not just a chip).
    const runCardAskAgent = async (): Promise<void> => {
      if (entry.discussed) return deps.onResend(entry);
      const comment = input.value.trim();
      if (!comment || !deps.getDocPath()) return;
      await deps.onAskAgent(entry, { comment, stance: stanceSel.value, modelId: modelSel.value || undefined });
    };
    discussBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      void runCardAskAgent();
    });
    const delBtn = card.querySelector<HTMLButtonElement>(".delete")!;
    delBtn.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      if (!deps.getDocPath()) return;
      if (!(await confirmAction("Delete this comment and its discussion?"))) return;
      await deps.removeAnnotationById(id);
      deps.log(`deleted ${id}`);
    });
    card.addEventListener("click", (ev) => {
      const target = ev.target as HTMLElement | null;
      if (target?.closest("button, textarea, select, input, label")) return;
      deps.onOpen(id);
    });
    commentsEl.prepend(card);
  }

  /**
   * Register a branch thread in the comment registry so it shows in the thread
   * selector and can be promoted into the chat pane — WITHOUT a doc highlight or a
   * numbered right-pane card (the parent's highlight already marks the text).
   * The card it builds is a detached, hidden element kept only so the existing
   * CommentEntry reads (the pane's active-card toggle, setChip) keep working unchanged.
   */
  function registerBranchEntry(branchId: string, quoted: string, parentId: string): void {
    if (comments.has(branchId)) return;
    const card = document.createElement("div");
    card.className = "comment-card branch-entry";
    card.dataset.anno = branchId;
    card.hidden = true; // never shown in the right margin
    const chip = document.createElement("span");
    chip.className = "chip idle";
    const entry: CommentEntry = {
      id: branchId,
      quoted,
      card,
      chip,
      discussBtn: document.createElement("button"),
      stanceSel: document.createElement("select"),
      commentInput: document.createElement("textarea"),
      discussed: true, // a branch is born with a seeded conversation
      resolved: false,
      parent: parentId,
      hydrated: true,
    };
    comments.set(branchId, entry);
    deps.onRegistryChanged();
  }

  function removeEntry(id: string): boolean {
    const entry = comments.get(id);
    if (!entry) return false;
    entry.card.remove();
    comments.delete(id);
    // Drop registry-only branch entries forked from this thread (no card/decoration).
    for (const [bid, e] of comments) if (e.parent === id) comments.delete(bid);
    deps.onRegistryChanged();
    return true;
  }

  function applyThreadNodes(nodes: ThreadNode[]): void {
    for (const node of nodes) {
      const entry = comments.get(node.id);
      if (!entry || entry.hydrated) continue;
      entry.hydrated = true;
      // A turn that started in this session already owns the card's state.
      if (!entry.chip.classList.contains("idle")) continue;
      // Reload the comment text (persisted in the thread) if the field is empty.
      if (node.lastYouBody && !entry.commentInput.value.trim()) entry.commentInput.value = node.lastYouBody;
      // Restore the persisted action state: a failed turn offers Retry (with the failed
      // message kept), and a thread that has an agent reply is already discussed.
      if (node.status === "error" && node.lastYouBody) {
        entry.discussed = node.hasAgentTurn;
        setCommentActionState(entry, "error");
      } else if (node.hasAgentTurn) {
        entry.discussed = true;
        setCommentActionState(entry, "responded");
      }
    }
  }

  function clear(): void {
    commentsEl.innerHTML = "";
    comments.clear();
  }

  return {
    comments,
    addCommentCard,
    registerBranchEntry,
    removeEntry,
    setChip,
    setCommentActionState,
    applyThreadNodes,
    clear,
  };
}
