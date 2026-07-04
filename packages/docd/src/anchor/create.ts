import type { TextQuoteAnchor } from "./types.js";

export interface CreateAnchorOptions {
  /** How many characters of surrounding context to capture. Default 32. */
  contextLen?: number;
}

/** Build a text-quote anchor from a selection range [start, end) in `text`. */
export function createAnchor(
  text: string,
  start: number,
  end: number,
  opts: CreateAnchorOptions = {},
): TextQuoteAnchor {
  const contextLen = opts.contextLen ?? 32;
  return {
    exact: text.slice(start, end),
    prefix: text.slice(Math.max(0, start - contextLen), start),
    suffix: text.slice(end, end + contextLen),
  };
}
