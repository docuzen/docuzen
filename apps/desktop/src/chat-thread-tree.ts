// The discussion-thread navigator for the chat pane: the (hidden) thread <select>, the
// branch tree scoped to the active thread's family, and the ‹ k / n › pager under a
// forked turn. Owns the cached `listThreads` result. Split out of chat.ts; reaches the
// chat pane only through `deps`.
import type { ThreadNode } from "@ai-native-doc/docd/protocol";
import type { DocdApi } from "./session.js";
import { escapeHtml, reportError } from "./ui.js";

export interface ThreadTreeDeps {
  api: DocdApi;
  log: (line: string) => void;
  getDocPath: () => string | undefined;
  truncTitle: (s: string, max?: number) => string;
  /** shell.ts's version-preview modal opener, for the 📄 chip. */
  openVersionPreview: (versionId: string) => Promise<void>;
  getActiveChatId: () => string | null;
  /** Every comment thread currently in the rail, in rail order. */
  comments: () => Iterable<{ id: string; quoted: string; parent?: string }>;
  promoteToChat: (id: string) => Promise<void>;
  /** Append an element at the end of the transcript (the pager sits under its turn). */
  appendToTurns: (el: HTMLElement) => void;
  /** Called with every fresh (non-stale) thread listing — the rail restores card state from it. */
  onNodes: (nodes: ThreadNode[]) => void;
}

export interface ThreadTreeApi {
  /** Rebuild the thread <select> from the rail and (coalesced) re-fetch the tree. */
  refreshThreadSelect: () => void;
  refreshThreadTree: () => Promise<void>;
  /** Re-render the cached tree (e.g. after the active thread changed). */
  renderThreadTree: () => void;
  siblingsAt: (displayedId: string, i: number) => ThreadNode[];
  renderVersionPager: (sibs: ThreadNode[], currentId: string) => void;
  getThreadNodes: () => ThreadNode[];
  /** Mark `id` as the selected thread in the <select>. */
  select: (id: string) => void;
  /** Drop the cached tree and empty the navigator synchronously (document switch). */
  clear: () => void;
}

export function initThreadTree(deps: ThreadTreeDeps): ThreadTreeApi {
  const chatThreadSelectEl = document.querySelector<HTMLSelectElement>("#chatThreadSelect")!;
  const threadTreeEl = document.querySelector<HTMLDivElement>("#threadTree")!;

  // One discussion thread's lineage + display metadata, flat (no nesting). Mirrors
  // the docd `listThreads` RPC shape; the UI joins id/parent to build the tree.
  // Cached server tree; also consumed by the version pager.
  let threadNodes: ThreadNode[] = [];
  // Monotonically-increasing generation counter for refreshThreadTree(): every call
  // captures the current value and checks it after the async listThreads RPC; if a
  // newer call has since started (treeGen > gen), the stale result is discarded. This
  // prevents a prior tab's in-flight listThreads from overwriting the newly-active
  // tab's thread tree (the root cause of the left-pane stale-content bug on tab switch).
  let treeGen = 0;
  // refreshThreadSelect is called once per comment card while a document loads; the tree
  // fetch behind it is coalesced to one listThreads per burst (see scheduleThreadTreeRefresh).
  let treeRefreshQueued = false;

  chatThreadSelectEl.addEventListener("change", () => {
    if (chatThreadSelectEl.value) void deps.promoteToChat(chatThreadSelectEl.value);
  });

  function refreshThreadSelect(): void {
    const opts = ['<option value="">— no discussion —</option>'];
    for (const e of deps.comments()) {
      const label = e.quoted.length > 30 ? e.quoted.slice(0, 30) + "…" : e.quoted;
      // Branch threads (forked from a parent) read as lineage under their source.
      // Escape: comment text is user-derived and interpolated into innerHTML.
      opts.push(`<option value="${escapeHtml(e.id)}">${e.parent ? "↳ " : ""}${escapeHtml(label)}</option>`);
    }
    chatThreadSelectEl.innerHTML = opts.join("");
    chatThreadSelectEl.value = deps.getActiveChatId() ?? "";
    // The select is hidden; the branch tree is the real navigator. Refresh it from
    // the server on every call site that refreshes the select, so they stay in sync.
    scheduleThreadTreeRefresh();
  }

  /**
   * Coalesce tree refreshes: a document with N comments calls refreshThreadSelect N times
   * in one synchronous loop (one per addCommentCard), which used to fire N listThreads
   * RPCs of which only the last result was kept. One microtask later, one fetch.
   */
  function scheduleThreadTreeRefresh(): void {
    if (treeRefreshQueued) return;
    treeRefreshQueued = true;
    queueMicrotask(() => {
      treeRefreshQueued = false;
      void refreshThreadTree();
    });
  }

  /**
   * Fetch the discussion-thread lineage from the server and render it as a nested
   * branch tree into `#threadTree`. Roots are nodes with no parent (or whose parent
   * isn't in the set); children indent by depth. Each row promotes its thread into
   * the chat pane on click; the 📄 chip opens the version preview.
   */
  async function refreshThreadTree(): Promise<void> {
    const gen = ++treeGen;
    if (!deps.getDocPath()) {
      threadNodes = [];
      threadTreeEl.innerHTML = "";
      return;
    }
    let nodes: ThreadNode[];
    try {
      nodes = await deps.api.listThreads({});
    } catch (e) {
      if (gen !== treeGen) return; // stale: a newer call took over, discard
      reportError("thread tree load", e, deps.log);
      return;
    }
    if (gen !== treeGen) return; // stale: a newer call took over, discard
    threadNodes = nodes;
    deps.onNodes(nodes);
    renderThreadTree();
  }

  /** Render the (cached) thread tree, scoped to the active thread's branch family. */
  function renderThreadTree(): void {
    const activeChatId = deps.getActiveChatId();
    const byId = new Map(threadNodes.map((n) => [n.id, n]));
    const children = new Map<string, ThreadNode[]>();
    for (const n of threadNodes) {
      if (n.parent && byId.has(n.parent)) {
        const arr = children.get(n.parent) ?? [];
        arr.push(n);
        children.set(n.parent, arr);
      }
    }

    threadTreeEl.innerHTML = "";
    const renderNode = (node: ThreadNode, depth: number): void => {
      const kids = children.get(node.id) ?? [];
      const row = document.createElement("div");
      row.className = "tnode";
      row.dataset.thread = node.id;
      row.style.paddingLeft = `${0.4 + depth * 0.85}rem`;
      if (node.id === activeChatId) row.classList.add("active");

      const fork = document.createElement("span");
      fork.className = "tfork";
      fork.textContent = kids.length ? "⑂" : "";
      row.appendChild(fork);

      const title = document.createElement("span");
      title.className = "ttitle";
      title.textContent = deps.truncTitle(node.title);
      title.title = node.title;
      row.appendChild(title);

      const count = document.createElement("span");
      count.className = "tcount";
      count.textContent = String(node.turnCount);
      count.title = `${node.turnCount} turn(s)`;
      row.appendChild(count);

      if (node.baseVersion) {
        const chip = document.createElement("span");
        chip.className = "tverchip";
        chip.textContent = `📄 ${node.baseVersion}`;
        chip.title = `Pinned to version ${node.baseVersion}`;
        chip.addEventListener("click", (ev) => {
          ev.stopPropagation();
          void deps.openVersionPreview(node.baseVersion!);
        });
        row.appendChild(chip);
      }

      row.addEventListener("click", () => void deps.promoteToChat(node.id));
      threadTreeEl.appendChild(row);
      for (const kid of kids) renderNode(kid, depth + 1);
    };

    // Focus the tree on the ACTIVE thread's family only (its root + descendants),
    // not every comment in the doc — otherwise it reads as an unrelated jumble.
    // A lone thread (no branches) shows no tree; the chat just shows its conversation.
    if (!activeChatId || !byId.has(activeChatId)) return;
    let rootId = activeChatId;
    for (let hop = 0; hop < threadNodes.length; hop++) {
      const node = byId.get(rootId);
      if (node?.parent && byId.has(node.parent)) rootId = node.parent;
      else break;
    }
    const familySize = (function size(id: string): number {
      return 1 + (children.get(id) ?? []).reduce((s, k) => s + size(k.id), 0);
    })(rootId);
    if (familySize <= 1) return; // single thread → nothing to navigate
    renderNode(byId.get(rootId)!, 0);
  }

  /** Threads that are alternatives to `displayedId` at turn index `i` (a fork point). Original first, then branches by createdAt. */
  function siblingsAt(displayedId: string, i: number): ThreadNode[] {
    const displayed = threadNodes.find((n) => n.id === displayedId);
    if (!displayed) return [];
    const byCreated = (a: ThreadNode, b: ThreadNode) =>
      a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
    // Case A: `displayed` is the original; branches fork off it at index i.
    const children = threadNodes.filter((n) => n.parent === displayedId && n.branchFromTurn === i);
    if (children.length > 0) return [displayed, ...children.sort(byCreated)];
    // Case B: `displayed` is itself a branch forked at index i; siblings = parent (original) + co-branches.
    if (displayed.parent && displayed.branchFromTurn === i) {
      const parent = threadNodes.find((n) => n.id === displayed.parent);
      const co = threadNodes
        .filter((n) => n.parent === displayed.parent && n.branchFromTurn === i)
        .sort(byCreated);
      const group = parent ? [parent, ...co] : [...co];
      return group;
    }
    return [];
  }

  /**
   * A ChatGPT-style version pager rendered under a forked "you" turn: `‹ k / n › ⑂`.
   * Flipping the arrows promotes the previous/next sibling thread into the chat pane
   * (which re-renders and recomputes the pager, keeping it in sync).
   */
  function renderVersionPager(sibs: ThreadNode[], currentId: string): void {
    const k = sibs.findIndex((n) => n.id === currentId); // 0-based
    const row = document.createElement("div");
    row.className = "verpager";
    const prev = document.createElement("button");
    prev.className = "vp-arrow";
    prev.textContent = "‹";
    prev.disabled = k <= 0;
    prev.title = "Previous branch at this point";
    const next = document.createElement("button");
    next.className = "vp-arrow";
    next.textContent = "›";
    next.disabled = k >= sibs.length - 1;
    next.title = "Next branch at this point";
    const label = document.createElement("span");
    label.className = "vp-label";
    label.textContent = ` ${k + 1} / ${sibs.length}  ⑂`;
    prev.addEventListener("click", () => {
      if (k > 0) void deps.promoteToChat(sibs[k - 1].id);
    });
    next.addEventListener("click", () => {
      if (k < sibs.length - 1) void deps.promoteToChat(sibs[k + 1].id);
    });
    row.append(prev, label, next);
    deps.appendToTurns(row); // sits right under the just-rendered turn
  }

  function clear(): void {
    // Bump the generation so an in-flight fetch for the previous document is discarded.
    treeGen++;
    threadTreeEl.innerHTML = "";
    threadNodes = [];
  }

  return {
    refreshThreadSelect,
    refreshThreadTree,
    renderThreadTree,
    siblingsAt,
    renderVersionPager,
    getThreadNodes: () => threadNodes,
    select: (id) => {
      chatThreadSelectEl.value = id;
    },
    clear,
  };
}
