import { describe, it, expect } from "vitest";
import { createAnchor } from "../../src/anchor/create.js";

const TEXT =
  "We will add a token-bucket limiter at the gateway. Limits will be stored in Redis with a 1-hour TTL and configured per API key.";
const EXACT = "Limits will be stored in Redis with a 1-hour TTL";

describe("createAnchor", () => {
  it("captures exact selected text", () => {
    const start = TEXT.indexOf(EXACT);
    const a = createAnchor(TEXT, start, start + EXACT.length);
    expect(a.exact).toBe(EXACT);
  });

  it("captures prefix and suffix context up to contextLen", () => {
    const start = TEXT.indexOf(EXACT);
    const a = createAnchor(TEXT, start, start + EXACT.length, { contextLen: 16 });
    expect(a.prefix).toBe("at the gateway. "); // 16 chars immediately before selection
    expect(a.prefix.length).toBe(16);
    expect(a.suffix).toBe(" and configured "); // 16 chars immediately after selection
    expect(a.suffix.length).toBe(16);
  });

  it("clamps context at document boundaries", () => {
    const a = createAnchor("hello world", 0, 5, { contextLen: 32 });
    expect(a.prefix).toBe("");
    expect(a.suffix).toBe(" world");
  });
});
