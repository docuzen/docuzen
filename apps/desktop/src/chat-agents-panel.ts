// The Agents button + dropdown: every agent task for the open document (running,
// failed, recent), merged with optimistic placeholders for tasks the UI just started.
// Split out of chat.ts; it reaches the chat pane only through `deps` (same rule as every
// other module here: no cross-imports between UI regions).
import type { TaskRow } from "@ai-native-doc/docd/protocol";
import type { DocdApi } from "./session.js";
import { reportError } from "./ui.js";

export interface AgentsPanelDeps {
  api: DocdApi;
  log: (line: string) => void;
  getDocPath: () => string | undefined;
  /** The quoted text of a comment thread, for a human task title; undefined for pseudo-threads. */
  commentQuoted: (threadId: string) => string | undefined;
  hasComment: (threadId: string) => boolean;
  /** Open a comment thread (with its highlight context) in the chat pane. */
  promoteToChat: (threadId: string) => Promise<void>;
  /** Open a directive/review pseudo-thread in the chat pane. */
  openThreadById: (threadId: string, title: string) => Promise<void>;
}

export interface AgentsPanelApi {
  /** Show a task as live before the backend's TaskDB row exists (autosave/model-start latency). */
  setOptimisticTask: (threadId: string, status: TaskRow["status"]) => void;
  clearOptimisticTask: (threadId: string) => void;
  refreshAgents: () => Promise<void>;
  /** Human label for a task's thread id (comment quote, or a name for pseudo-threads). */
  taskTitle: (threadId: string) => string;
  /** Instant "something started" feedback on the button; the poll reconciles the real count. */
  markStarting: () => void;
}

export function initAgentsPanel(deps: AgentsPanelDeps): AgentsPanelApi {
  const agentsBtn = document.querySelector<HTMLButtonElement>("#agentsBtn")!;
  const agentsPanel = document.querySelector<HTMLDivElement>("#agentsPanel")!;
  let agentsPoll: number | null = null;

  // Tasks started from the UI before the backend's TaskDB poll catches up. This keeps the
  // dropdown honest during autosave/model-start latency instead of showing only old rows.
  const optimisticTasks = new Map<string, TaskRow>();

  function setOptimisticTask(threadId: string, status: TaskRow["status"]): void {
    // piSessionId is unknown until the backend's TaskDB row exists; null is the
    // canonical "no session yet" value (matches the real row's shape once it lands).
    optimisticTasks.set(threadId, { threadId, status, piSessionId: null, updatedAt: new Date().toISOString() });
    void refreshAgents();
  }

  function clearOptimisticTask(threadId: string): void {
    optimisticTasks.delete(threadId);
    void refreshAgents();
  }

  /** Human label for a task's thread id (comment quote, or a name for pseudo-threads). */
  function taskTitle(threadId: string): string {
    if (threadId === "directives") return "Inline directives";
    if (/^directive-\d+$/.test(threadId)) return `Inline directive ${threadId.slice("directive-".length)}`;
    if (threadId === "review") return "Review pass";
    const q = deps.commentQuoted(threadId);
    if (q) return q.length > 40 ? q.slice(0, 40) + "…" : q;
    return threadId;
  }

  /** Drop an optimistic placeholder after this long even if its RPC never settled — a
   * safety net behind the try/finally clearOptimisticTask calls at each call site (e.g. a
   * hung backend that never closes the socket, so the promise never resolves OR rejects). */
  const OPTIMISTIC_TASK_TTL_MS = 5 * 60 * 1000;

  /**
   * The ONE source of truth for the task list: server rows merged with any live
   * optimistic placeholder (a real server row always wins over a same-id placeholder).
   * Both `refreshAgents` (the panel) and `refreshAgentsBadge` (the always-on poll) render
   * from this SAME list, so the badge count and the panel's row count can never disagree
   * — they used to be computed two different ways (badge from raw server rows, panel from
   * the merge), which is exactly how the badge and panel fell out of sync in practice.
   */
  async function mergedTasks(): Promise<TaskRow[]> {
    const tasks = await deps.api.listTasks({});
    const byId = new Map(tasks.map((t) => [t.threadId, t]));
    const now = Date.now();
    for (const [id, t] of optimisticTasks) {
      if (now - Date.parse(t.updatedAt) > OPTIMISTIC_TASK_TTL_MS) {
        optimisticTasks.delete(id); // stale placeholder — its RPC never settled
        continue;
      }
      // If the real backend task exists, it wins; otherwise show the optimistic task.
      if (!byId.has(id)) byId.set(id, t);
    }
    return [...byId.values()].sort(
      (a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "") || a.threadId.localeCompare(b.threadId),
    );
  }

  async function refreshAgents(): Promise<void> {
    if (!deps.getDocPath()) {
      agentsPanel.replaceChildren();
      const empty = document.createElement("div");
      empty.className = "agentsempty";
      empty.textContent = "No document open.";
      agentsPanel.appendChild(empty);
      return;
    }
    let tasks: TaskRow[];
    try {
      tasks = await mergedTasks();
    } catch (e) {
      reportError("agents load", e, deps.log);
      return;
    }
    agentsPanel.replaceChildren();
    updateAgentsBadge(tasks);

    // Pin the doc-wide pseudo-tasks (directives, review) ahead of per-comment threads so
    // they're never buried under the capped Recent list.
    const pseudoFirst = (rows: TaskRow[]): TaskRow[] => {
      const isPseudo = (t: TaskRow) =>
        t.threadId === "directives" || t.threadId === "review" || /^directive-\d+$/.test(t.threadId);
      return [...rows.filter(isPseudo), ...rows.filter((t) => !isPseudo(t))];
    };
    const active = pseudoFirst(tasks.filter((t) => t.status === "running"));
    const errored = pseudoFirst(tasks.filter((t) => t.status === "error"));
    const done = pseudoFirst(tasks.filter((t) => t.status === "responded"));

    const renderGroup = (label: string, rows: TaskRow[], cap?: number): void => {
      if (rows.length === 0) return;
      const head = document.createElement("div");
      head.className = "agentshead";
      head.textContent = label;
      agentsPanel.appendChild(head);
      const shown = cap ? rows.slice(0, cap) : rows;
      for (const t of shown) {
        const row = document.createElement("div");
        row.className = "agentrow";
        const title = document.createElement("span");
        title.className = "agenttitle";
        const chip = document.createElement("span");
        chip.className = `chip ${t.status}`;
        chip.textContent = t.status;
        const label = taskTitle(t.threadId);
        if (t.status === "error" && t.errorText) {
          // Compact first line inline; the full message (title + errorText) is reachable
          // via the native tooltip on both the row and the chip (the Attention popover's
          // error indicator).
          title.textContent = `${label} — ${t.errorText.split("\n")[0]}`;
          const tooltip = `${label}\n${t.errorText}`;
          row.title = tooltip;
          chip.title = tooltip;
        } else {
          title.textContent = label;
        }
        row.append(title, chip);
        // Optimistic placeholder rows (set by setOptimisticTask, not yet reconciled with a
        // real backend TaskRow — see mergedTasks) have no thread to open yet: getThread
        // would 404. Referential identity against the live `optimisticTasks` entry tells
        // us THIS row object is the placeholder rather than a same-id real row that already
        // won the merge (a real row always wins — mergedTasks never overwrites one with its
        // optimistic counterpart), so real rows stay clickable throughout their lifecycle.
        if (optimisticTasks.get(t.threadId) === t) {
          row.title = "Starting…";
        } else {
          row.classList.add("clickable");
          row.addEventListener("click", () => {
            agentsPanel.hidden = true;
            stopAgentsPoll();
            // Comment threads promote with their highlight context; directive/review
            // threads open as plain conversations (replyable since Phase 8).
            if (deps.hasComment(t.threadId)) void deps.promoteToChat(t.threadId);
            else void deps.openThreadById(t.threadId, taskTitle(t.threadId));
          });
        }
        agentsPanel.appendChild(row);
      }
      if (cap && rows.length > cap) {
        const more = document.createElement("div");
        more.className = "agentsempty";
        more.textContent = `+${rows.length - cap} more`;
        agentsPanel.appendChild(more);
      }
    };

    if (tasks.length === 0) {
      const empty = document.createElement("div");
      empty.className = "agentsempty";
      empty.textContent = "No agent tasks yet. Discuss a comment, run a Review, or Resolve [[ ]].";
      agentsPanel.appendChild(empty);
      return;
    }
    renderGroup("Active", active);
    renderGroup("Attention", errored);
    renderGroup("Recent", done, 10);
  }

  /** Update just the Agents button's running-count badge from a task list. */
  function updateAgentsBadge(tasks: TaskRow[]): void {
    const running = tasks.filter((t) => t.status === "running").length;
    agentsBtn.textContent = running > 0 ? `Agents (${running})` : "Agents";
    agentsBtn.classList.toggle("busy", running > 0);
  }

  /** Lightweight always-on poll so the button shows live activity even when the panel is closed. */
  async function refreshAgentsBadge(): Promise<void> {
    // The open panel's own (faster) poll already updates the badge, and nobody can see
    // it while the window is hidden — skip the duplicate listTasks round-trip.
    if (agentsPoll !== null || document.hidden) return;
    if (!deps.getDocPath()) {
      agentsBtn.textContent = "Agents";
      agentsBtn.classList.remove("busy");
      return;
    }
    try {
      updateAgentsBadge(await mergedTasks());
    } catch {
      /* ignore transient poll errors */
    }
  }
  setInterval(() => void refreshAgentsBadge(), 2000);

  function positionAgentsPanel(): void {
    const r = agentsBtn.getBoundingClientRect();
    agentsPanel.style.top = `${r.bottom + 6}px`;
    agentsPanel.style.right = `${Math.max(8, window.innerWidth - r.right)}px`;
  }
  function stopAgentsPoll(): void {
    if (agentsPoll !== null) {
      clearInterval(agentsPoll);
      agentsPoll = null;
    }
  }
  agentsBtn.addEventListener("click", () => {
    agentsPanel.hidden = !agentsPanel.hidden;
    if (agentsPanel.hidden) {
      stopAgentsPoll();
      return;
    }
    positionAgentsPanel();
    void refreshAgents();
    // Poll while open so running → responded transitions show live (no global timers otherwise).
    agentsPoll = setInterval(() => void refreshAgents(), 1500) as unknown as number;
  });
  document.addEventListener("mousedown", (e) => {
    if (agentsPanel.hidden) return;
    if (e.target === agentsBtn || agentsPanel.contains(e.target as Node)) return;
    agentsPanel.hidden = true;
    stopAgentsPoll();
  });

  function markStarting(): void {
    agentsBtn.textContent = "Agents (…)";
    agentsBtn.classList.add("busy");
  }

  return { setOptimisticTask, clearOptimisticTask, refreshAgents, taskTitle, markStarting };
}
