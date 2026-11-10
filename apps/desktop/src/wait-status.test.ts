// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WAIT_PHASE, phaseForEvent, startWaitStatus } from "./wait-status.js";

describe("wait status", () => {
  let el: HTMLElement;
  beforeEach(() => {
    vi.useFakeTimers();
    el = document.createElement("span");
    document.body.appendChild(el);
  });
  afterEach(() => {
    vi.useRealTimers();
    el.remove();
  });

  it("shows the phase at once and adds elapsed seconds as the wait grows", () => {
    startWaitStatus(el, WAIT_PHASE.waiting);
    expect(el.textContent).toBe("waiting for the model…");
    vi.advanceTimersByTime(3000);
    expect(el.textContent).toBe("waiting for the model… 3s");
  });

  it("changes phase without restarting the clock", () => {
    const s = startWaitStatus(el, WAIT_PHASE.waiting);
    vi.advanceTimersByTime(4000);
    s.set(WAIT_PHASE.thinking);
    expect(el.textContent).toBe("thinking… 4s");
  });

  it("stops ticking on stop(), and ignores later phase changes", () => {
    const s = startWaitStatus(el, WAIT_PHASE.waiting);
    vi.advanceTimersByTime(2000);
    s.stop();
    el.textContent = "done";
    s.set(WAIT_PHASE.writing);
    vi.advanceTimersByTime(5000);
    expect(el.textContent).toBe("done");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops by itself when its element leaves the document", () => {
    startWaitStatus(el, WAIT_PHASE.waiting);
    el.remove();
    vi.advanceTimersByTime(1000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("maps stream events to phases", () => {
    expect(phaseForEvent("thinking")).toBe(WAIT_PHASE.thinking);
    expect(phaseForEvent("tool")).toBe(WAIT_PHASE.tool);
    expect(phaseForEvent("token")).toBe(WAIT_PHASE.writing);
    expect(phaseForEvent("proposal")).toBeUndefined();
  });
});
