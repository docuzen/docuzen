// A live "what is the agent doing, and for how long" line. A model can take several seconds
// before its first byte arrives (reasoning happens server-side before anything streams), so
// a bare spinner reads as a hang. This shows the current phase plus elapsed seconds, and the
// callers move the phase forward as stream events arrive.

export interface WaitStatus {
  /** Change the phase label; the elapsed counter keeps running from the start. */
  set(label: string): void;
  /** Stop ticking. The element's text is left as-is for the caller to replace or remove. */
  stop(): void;
}

export const WAIT_PHASE = {
  waiting: "waiting for the model…",
  thinking: "thinking…",
  tool: "using a tool…",
  writing: "writing…",
} as const;

/** Phase a stream event moves the turn into, or undefined when it doesn't change it. */
export function phaseForEvent(event: string): string | undefined {
  if (event === "thinking") return WAIT_PHASE.thinking;
  if (event === "tool") return WAIT_PHASE.tool;
  if (event === "token") return WAIT_PHASE.writing;
  return undefined;
}

export function startWaitStatus(el: HTMLElement, initial: string): WaitStatus {
  let label = initial;
  const t0 = Date.now();
  let timer: ReturnType<typeof setInterval> | null = null;
  const stop = (): void => {
    if (timer !== null) clearInterval(timer);
    timer = null;
  };
  const render = (): void => {
    const s = Math.floor((Date.now() - t0) / 1000);
    // No "0s": the counter appears once the wait is long enough to wonder about.
    el.textContent = s >= 1 ? `${label} ${s}s` : label;
  };
  render();
  timer = setInterval(() => {
    // The element was dropped without stop() (pane re-rendered, tab closed): don't leak.
    if (!el.isConnected) return stop();
    render();
  }, 1000);
  return {
    set(next) {
      if (timer === null || next === label) return;
      label = next;
      render();
    },
    stop,
  };
}
