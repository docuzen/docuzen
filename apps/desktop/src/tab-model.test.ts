import { describe, expect, it } from "vitest";
import { activeIndexAfterClose } from "./tab-model.js";

describe("activeIndexAfterClose", () => {
  it("closing the only tab leaves none active", () => {
    expect(activeIndexAfterClose(0, 0, 1)).toBe(-1);
  });
  it("closing the active tab activates its right neighbour (which takes its slot)", () => {
    expect(activeIndexAfterClose(1, 1, 3)).toBe(1);
  });
  it("closing the active LAST tab activates the new last tab", () => {
    expect(activeIndexAfterClose(2, 2, 3)).toBe(1);
  });
  it("closing a tab before the active one keeps the same tab active at its shifted index", () => {
    expect(activeIndexAfterClose(2, 0, 3)).toBe(1);
  });
  it("closing a tab after the active one changes nothing", () => {
    expect(activeIndexAfterClose(0, 2, 3)).toBe(0);
  });
});
