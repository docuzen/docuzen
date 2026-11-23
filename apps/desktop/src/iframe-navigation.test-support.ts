// Test support only (never imported by the app).
//
// A real browser navigates an iframe asynchronously: a new iframe starts on an empty
// about:blank document, and after `srcdoc` is set, `contentDocument` is still that document
// (or the previous page) until the new one commits; `load` fires after that. happy-dom swaps
// the document synchronously and starts with none, which hides exactly the window in which the
// HTML surface used to read the wrong document. This models the browser: frames appended to
// `host` start on an empty document, and every srcdoc navigation waits until the test commits
// it. Only a frame's latest navigation commits, as when a newer navigation cancels an older one.

const raf = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

export interface DeferredNavigation {
  /** Commit each frame's latest pending navigation and let its `load` event fire. */
  commit(): Promise<void>;
  /** Frames with a navigation still pending. */
  pendingCount(): number;
  restore(): void;
}

export function deferIframeNavigation(host: HTMLElement): DeferredNavigation {
  const proto = window.HTMLIFrameElement.prototype;
  const original = Object.getOwnPropertyDescriptor(proto, "srcdoc")!;
  const pending = new Map<HTMLIFrameElement, string>();
  Object.defineProperty(proto, "srcdoc", {
    configurable: true,
    get(this: HTMLIFrameElement) {
      return original.get!.call(this);
    },
    set(this: HTMLIFrameElement, value: string) {
      pending.set(this, value);
    },
  });
  const append = host.appendChild.bind(host);
  host.appendChild = <T extends Node>(node: T): T => {
    // The initial about:blank document every new iframe has before its first navigation.
    if (node instanceof window.HTMLIFrameElement && !node.hasAttribute("srcdoc")) original.set!.call(node, "");
    return append(node);
  };
  return {
    async commit() {
      const batch = [...pending];
      pending.clear();
      for (const [frame, value] of batch) {
        // A browser re-navigates even to an identical srcdoc; happy-dom would skip it.
        if (original.get!.call(frame) === value) original.set!.call(frame, `${value} `);
        original.set!.call(frame, value);
      }
      await raf(); // happy-dom dispatches the iframe's `load` on the next animation frame
      await raf();
    },
    pendingCount: () => pending.size,
    restore() {
      Object.defineProperty(proto, "srcdoc", original);
    },
  };
}
