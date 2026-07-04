// Shared UI helpers factored out of main.ts's duplicated patterns.

/**
 * Escape a string for safe interpolation into an `innerHTML` template. Added in
 * Task 2 (see task-2-report.md): the version-picker modal (moving to shell.ts)
 * and the chat pane's branch-thread `<option>` labels (staying in main.ts) both
 * call this same helper — it lives here, a leaf module both may import, rather
 * than in either region, per the plan's "modules never import each other except
 * ui.ts/session.ts" wiring rule.
 */
export function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!),
  );
}

/**
 * Create an element, assign props onto it (as plain property assignments —
 * same as `node.className = ...`, not `setAttribute`), and append children.
 * Reproduces the mechanical `document.createElement` + prop-assignment +
 * `appendChild` runs used by the proposal/comment-card/settings builders.
 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: { className?: string; textContent?: string; title?: string; [attr: string]: unknown },
  children?: (Node | string)[],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined) continue;
      (node as unknown as Record<string, unknown>)[key] = value;
    }
  }
  if (children) {
    for (const child of children) {
      node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
    }
  }
  return node;
}

/**
 * Wire a modal's backdrop-click-to-close behavior: clicking the modal element
 * itself (i.e. outside the dialog box it contains) hides it. Replaces the 5
 * near-identical `modal.addEventListener("click", (e) => { if (e.target ===
 * modal) modal.hidden = true; })` listeners.
 *
 * NOT adopted at every modal: the version-picker modal's backdrop click calls
 * `closeVersionPicker(null)`, which ALSO resolves a pending Promise — a real
 * behavioral difference from "just hide it" that this helper deliberately does
 * not support (see task-1-report.md).
 */
export function wireModal(modal: HTMLElement): void {
  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.hidden = true;
  });
}

/**
 * Log a caught error in the app's dominant `${scope} failed: ${String(e)}`
 * shape, so #log output is byte-for-byte unchanged. Only adopt this at catch
 * sites whose existing log call already matches this shape EXACTLY — sites
 * with extra interpolation or different wording stay as they are (normalizing
 * them would change the #log line, which is user-visible and parity-checked).
 */
export function reportError(scope: string, e: unknown, log: (line: string) => void): void {
  log(`${scope} failed: ${String(e)}`);
}

/**
 * Run an async call with the shared "busy while in flight, always settle"
 * shape. `run` is expected to have already flipped on whatever busy indicator
 * the site uses; `onSettled` (always, via `finally`) flips it back off.
 * `onError` reports the failure; the returned discriminated union lets the
 * call site gate its success-only continuation on `outcome.ok`, mirroring the
 * `return` inside each original `catch` block that skipped success-path setup.
 *
 * Audit note: chatSend, the Panel handler, runImprove, and runResolveDirectives
 * do NOT share a literal "chip + streaming bubble" implementation — chatSend
 * and the Panel handler key off a comment "chip" and a streamingAgentTurn
 * bubble (Panel: a Map of bubbles, one per model), runImprove drives its own
 * proposal-preview box with no bubble at all, and runResolveDirectives has
 * neither a chip nor a bubble (it drives `agentsBtn` + directive-marker
 * pulsing instead). The one shape genuinely common to all four is this
 * try/run/catch/finally-with-conditional-continuation — that's what this
 * helper extracts; the chip/bubble/box mechanics stay as call-site deltas.
 *
 * `onSuccess`, if given, is awaited INSIDE the try — before `onSettled` fires
 * and before this function returns — so a call site whose pre-refactor success
 * continuation lived inside the same try block (and could itself throw into
 * the same catch) can reproduce that exactly. Only chatSend needs this: its
 * `await reloadActiveDoc()` used to run before `finally { setChatBusy(null) }`
 * cleared busy, and moving that continuation to the (synchronous, post-await)
 * call site broke that ordering. The other three call sites don't pass
 * `onSuccess` — for them this is `await undefined`, an inert extra microtask
 * tick before the existing `finally`, since their continuations are already
 * synchronous and run after `runStreamingTurn` returns.
 */
export async function runStreamingTurn<T>(opts: {
  run: () => Promise<T>;
  onError: (e: unknown) => void;
  onSuccess?: (result: T) => void | Promise<void>;
  onSettled?: () => void;
}): Promise<{ ok: true; result: T } | { ok: false }> {
  try {
    const result = await opts.run();
    await opts.onSuccess?.(result);
    return { ok: true, result };
  } catch (e) {
    opts.onError(e);
    return { ok: false };
  } finally {
    opts.onSettled?.();
  }
}

/** IDs threaded through to the approve/reject RPCs. `docPath` is optional — omit it to let the api facade inject the active document's path; pass it to pin a specific one (openDiffPanel captures it up front so a mid-await tab switch can't retarget the action). */
export interface ProposalActionIds {
  threadId: string;
  proposalId: string;
  docPath?: string;
}

export interface ProposalActionDeps {
  approveBtn: HTMLButtonElement;
  rejectBtn: HTMLButtonElement;
  approveProposal: (ids: ProposalActionIds) => Promise<unknown>;
  rejectProposal: (ids: ProposalActionIds) => Promise<unknown>;
  log: (line: string) => void;
  /** Runs on success, in place of the original inline body — owns its own log() call (see below). */
  onApproved: () => void | Promise<void>;
  onRejected: () => void | Promise<void>;
  /** Buttons disabled while the approve RPC is in flight, re-enabled on failure. Default: both buttons. */
  disableOnApprove?: HTMLButtonElement[];
  /** Buttons disabled while the reject RPC is in flight, re-enabled on failure. Default: both buttons. */
  disableOnReject?: HTMLButtonElement[];
  /** Return false to no-op the click (e.g. the `!DOC_PATH` guard some sites need). Runs after `onClick`. */
  guard?: () => boolean;
  /** Fires first, before `guard` — e.g. a contentEditable host's `preventDefault`/`stopPropagation`. */
  onClick?: (e: MouseEvent) => void;
}

/**
 * Detect the orchestrator's distinguishable "already resolved" guard
 * (`proposal already approved` / `proposal already rejected` — see
 * orchestrator.ts's approveProposal/rejectProposal) and report which side it
 * resolved to, or `null` for an ordinary failure.
 *
 * A lost RESPONSE after the server durably applied an approve/reject (dropped
 * connection, sidecar restart) is the classic trigger: the card or diff panel
 * survives client-side with nothing to tell it the action already succeeded,
 * so the user's retry click is the only way the proposal ever resolves for
 * them — and that retry now hits this guard instead of a generic failure (or,
 * for approve-on-approved specifically, the orchestrator's baseHash staleness
 * check, since the doc legitimately changed — because this same proposal
 * already applied it). `proposalActions` uses this to treat that retry as
 * success-shaped cleanup instead of "just try again forever".
 */
export function alreadyResolvedStatus(err: unknown): "approved" | "rejected" | null {
  const msg = err instanceof Error ? err.message : String(err);
  const m = /proposal already (approved|rejected)/i.exec(msg);
  return m ? (m[1].toLowerCase() as "approved" | "rejected") : null;
}

/**
 * Wire an approve/reject button pair: disable-in-flight, call the RPC, run
 * `onApproved`/`onRejected` on success, re-enable + reportError("approve"/
 * "reject", …) on failure. Reproduces the 4x copy in buildProposalWidget,
 * buildProposalFallbackWidget, buildHtmlProposalCard, and openDiffPanel — see
 * task-1-report.md for the per-site deltas (which buttons get disabled
 * together, the docPath capture, the contentEditable
 * preventDefault/stopPropagation quirk on buildProposalWidget).
 *
 * The success log line is NOT automated here: 3 of the 4 sites log AFTER their
 * cleanup/reload, but buildHtmlProposalCard logs BEFORE reloading — a real
 * ordering difference (observable if the reload throws), not incidental
 * copy-paste drift — so `onApproved`/`onRejected` own their own `log(...)`
 * call at whatever point reproduces the original site's order.
 *
 * A failure that turns out to be `alreadyResolvedStatus` (see above) skips the
 * normal re-enable + reportError path: buttons stay disabled and instead of
 * "try again" we drive the SAME cleanup a normal success would (`onApproved`
 * for "already approved" so the doc reloads and picks up the applied change,
 * `onRejected` for "already rejected", regardless of which button the user
 * actually clicked — the server's real status wins) — no infinite dead card.
 *
 * Always assigns `.onclick` rather than `addEventListener`: for the three
 * sites that build a fresh button per call, that's a no-op difference (wired
 * once, never reused); for openDiffPanel's fixed, reused buttons, assignment
 * is required so re-opening the panel replaces the previous handler instead of
 * stacking a new listener on top of it.
 */
export function proposalActions(deps: ProposalActionDeps, ids: ProposalActionIds): void {
  const disableApprove = deps.disableOnApprove ?? [deps.approveBtn, deps.rejectBtn];
  const disableReject = deps.disableOnReject ?? [deps.approveBtn, deps.rejectBtn];

  async function cleanUpAlreadyResolved(resolved: "approved" | "rejected"): Promise<void> {
    deps.log(`proposal already ${resolved} — removing the stale card`);
    if (resolved === "approved") await deps.onApproved();
    else await deps.onRejected();
  }

  deps.approveBtn.onclick = async (e) => {
    deps.onClick?.(e);
    if (deps.guard && !deps.guard()) return;
    for (const b of disableApprove) b.disabled = true;
    try {
      await deps.approveProposal(ids);
      await deps.onApproved();
    } catch (err) {
      const resolved = alreadyResolvedStatus(err);
      if (resolved) {
        await cleanUpAlreadyResolved(resolved);
        return;
      }
      for (const b of disableApprove) b.disabled = false;
      reportError("approve", err, deps.log);
    }
  };

  deps.rejectBtn.onclick = async (e) => {
    deps.onClick?.(e);
    if (deps.guard && !deps.guard()) return;
    for (const b of disableReject) b.disabled = true;
    try {
      await deps.rejectProposal(ids);
      await deps.onRejected();
    } catch (err) {
      const resolved = alreadyResolvedStatus(err);
      if (resolved) {
        await cleanUpAlreadyResolved(resolved);
        return;
      }
      for (const b of disableReject) b.disabled = false;
      reportError("reject", err, deps.log);
    }
  };
}
