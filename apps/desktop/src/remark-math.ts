// Self-contained remark/micromark/mdast extension for LaTeX math in Markdown.
//
// Why a dedicated extension instead of stock `remark-math`:
// 1. Single-line display blocks (`$$T_{\text{e2e}} = ...$$`) and same-line-start
//    multi-line display blocks (`$$a +\nb$$`) parse as block `math` nodes (not
//    `inlineMath` inside a paragraph) and round-trip with their original fence
//    style (`$$...$$` vs `$$\n...\n$$`).
// 2. Single-dollar inline math (`$...$`) follows Pandoc / Obsidian / GitHub
//    currency-safe boundary rules: opening `$` cannot be followed by whitespace,
//    closing `$` cannot be preceded by whitespace or followed by an ASCII digit,
//    and an invalid unescaped `$` aborts the candidate so currency like
//    `The cost is $5 and $10` or `$5-$10, where $x = 1$` never swallows prose.
// 3. Zero extra runtime dependencies beyond the remark/micromark pipeline already
//    bundled by Milkdown.

type Code = number | null;
type State = (code: Code) => State | undefined;

interface Token {
  type: string;
  start: { line: number; column: number; offset: number };
  end: { line: number; column: number; offset: number };
}

interface Effects {
  enter(type: string, fields?: Record<string, unknown>): Token;
  exit(type: string): Token;
  consume(code: Code): void;
  attempt(construct: Construct, ok: State, nok?: State): State;
  check(construct: Construct, ok: State, nok?: State): State;
}

interface TokenizeContext {
  previous: Code;
  events: [string, Token, { sliceSerialize(token: Token, expandTabs?: boolean): string }][];
  interrupt?: boolean;
  now(): { line: number; column: number; offset: number };
  parser: {
    lazy: Record<number, boolean>;
    constructs: { disable: { null?: string[] } };
  };
}

interface Construct {
  name?: string;
  concrete?: boolean;
  partial?: boolean;
  previous?: (this: TokenizeContext, code: Code) => boolean;
  tokenize: (this: TokenizeContext, effects: Effects, ok: State, nok: State) => State;
}

interface CompileContext {
  stack: Record<string, unknown>[];
  data: Record<string, unknown>;
  config: {
    enter: Record<string, (this: CompileContext, token: Token) => void>;
    exit: Record<string, (this: CompileContext, token: Token) => void>;
  };
  enter(node: Record<string, unknown>, token: Token): void;
  exit(token: Token): void;
  buffer(): void;
  resume(): string;
  sliceSerialize(token: Token): string;
}

const DOLLAR = 36; // `$`
const BACKSLASH = 92; // `\`
const BACKTICK = 96; // `` ` ``
const DIGIT_0 = 48;
const DIGIT_9 = 57;

function isAsciiAlphaNum(code: Code): boolean {
  return (
    code !== null &&
    ((code >= DIGIT_0 && code <= DIGIT_9) ||
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122))
  );
}

function isOpenDelim(code: Code): boolean {
  return code === 40 || code === 91 || code === 123; // `(`, `[`, `{`
}

function isLineEnding(code: Code): boolean {
  return code !== null && code < -2;
}

function isSpace(code: Code): boolean {
  return code === -2 || code === -1 || code === 32;
}

function isLineEndingOrSpace(code: Code): boolean {
  return code !== null && (code < 0 || code === 32);
}

function isAsciiDigit(code: Code): boolean {
  return code !== null && code >= DIGIT_0 && code <= DIGIT_9;
}

function consumeSpaces(
  effects: Effects,
  ok: State,
  type: string,
  max?: number,
): State {
  const limit = max ? max - 1 : Infinity;
  let size = 0;
  return start;

  function start(code: Code): State | undefined {
    if (isSpace(code) && size < limit) {
      effects.enter(type);
      return more(code);
    }
    return ok(code);
  }

  function more(code: Code): State | undefined {
    if (isSpace(code) && size++ < limit) {
      effects.consume(code);
      return more;
    }
    effects.exit(type);
    return ok(code);
  }
}

const nonLazyContinuation: Construct = {
  partial: true,
  tokenize(effects, ok, nok) {
    const self = this;
    return start;

    function start(code: Code): State | undefined {
      if (code === null) return nok(code);
      effects.enter("lineEnding");
      effects.consume(code);
      effects.exit("lineEnding");
      return lineStart;
    }

    function lineStart(code: Code): State | undefined {
      return self.parser.lazy[self.now().line] ? nok(code) : ok(code);
    }
  },
};

const onlySpacesToEol: Construct = {
  partial: true,
  tokenize(effects, ok, nok) {
    let open = false;
    return scan;

    function scan(code: Code): State | undefined {
      if (code === null || isLineEnding(code)) {
        if (open) effects.exit("whitespace");
        return ok(code);
      }
      if (isSpace(code)) {
        if (!open) {
          effects.enter("whitespace");
          open = true;
        }
        effects.consume(code);
        return scan;
      }
      return nok(code);
    }
  },
};

const exactDoubleDollar: Construct = {
  partial: true,
  tokenize(effects, ok, nok) {
    let count = 0;
    return start;

    function start(code: Code): State | undefined {
      if (code !== DOLLAR) return nok(code);
      effects.enter("mathCheck");
      return step(code);
    }

    function step(code: Code): State | undefined {
      if (code === DOLLAR) {
        count++;
        effects.consume(code);
        return step;
      }
      if (count === 2) {
        effects.exit("mathCheck");
        return ok(code);
      }
      return nok(code);
    }
  },
};

const atLeastTwoDollars: Construct = {
  partial: true,
  tokenize(effects, ok, nok) {
    let count = 0;
    return start;

    function start(code: Code): State | undefined {
      if (code !== DOLLAR) return nok(code);
      effects.enter("mathCheck");
      return step(code);
    }

    function step(code: Code): State | undefined {
      if (code === DOLLAR) {
        count++;
        effects.consume(code);
        if (count === 2) {
          effects.exit("mathCheck");
          return ok;
        }
        return step;
      }
      return nok(code);
    }
  },
};

const mathFlowConstruct: Construct = {
  concrete: true,
  name: "mathFlow",
  tokenize: tokenizeMathFlow,
};

function tokenizeMathFlow(
  this: TokenizeContext,
  effects: Effects,
  ok: State,
  nok: State,
): State {
  const self = this;
  let initialPrefix = 0;
  let sizeOpen = 0;
  let contentOpen = false;
  let bsCount = 0;
  let hasNonSpace = false;

  const closeFenced: Construct = {
    partial: true,
    tokenize(effects, ok, nok) {
      let size = 0;
      return startBefore;

      function startBefore(code: Code): State | undefined {
        effects.enter("lineEnding");
        effects.consume(code);
        effects.exit("lineEnding");
        return start;
      }

      function start(code: Code): State | undefined {
        effects.enter("mathFlowFenceClose");
        const maxIndent = self.parser.constructs.disable.null?.includes("codeIndented") ? undefined : 4;
        return isSpace(code) ? consumeSpaces(effects, beforeSeq, "linePrefix", maxIndent)(code) : beforeSeq(code);
      }

      function beforeSeq(code: Code): State | undefined {
        if (code !== DOLLAR) return nok(code);
        effects.enter("mathFlowFenceSequence");
        return seq(code);
      }

      function seq(code: Code): State | undefined {
        if (code === DOLLAR) {
          size++;
          effects.consume(code);
          return seq;
        }
        if (size >= sizeOpen) {
          effects.exit("mathFlowFenceSequence");
          return isSpace(code) ? consumeSpaces(effects, afterSeq, "whitespace")(code) : afterSeq(code);
        }
        return nok(code);
      }

      function afterSeq(code: Code): State | undefined {
        if (code === null || isLineEnding(code)) {
          effects.exit("mathFlowFenceClose");
          return ok(code);
        }
        return nok(code);
      }
    },
  };

  // Same-line closing fence (`$$` followed only by optional spaces + EOL/EOF).
  const closeSameLine: Construct = {
    partial: true,
    tokenize(effects, ok, nok) {
      let size = 0;
      return seqStart;

      function seqStart(code: Code): State | undefined {
        effects.enter("mathFlowFenceClose");
        effects.enter("mathFlowFenceSequence");
        return seq(code);
      }

      function seq(code: Code): State | undefined {
        if (code === DOLLAR) {
          size++;
          effects.consume(code);
          return seq;
        }
        if (size === sizeOpen) {
          effects.exit("mathFlowFenceSequence");
          return isSpace(code) ? consumeSpaces(effects, afterSeq, "whitespace")(code) : afterSeq(code);
        }
        return nok(code);
      }

      function afterSeq(code: Code): State | undefined {
        if (code === null || isLineEnding(code)) {
          effects.exit("mathFlowFenceClose");
          return ok(code);
        }
        return nok(code);
      }
    },
  };

  return start;

  function start(code: Code): State | undefined {
    const tail = self.events[self.events.length - 1];
    initialPrefix = tail && tail[1].type === "linePrefix" ? tail[2].sliceSerialize(tail[1], true).length : 0;
    effects.enter("mathFlow");
    effects.enter("mathFlowFenceOpen");
    effects.enter("mathFlowFenceSequence");
    return openSeq(code);
  }

  function openSeq(code: Code): State | undefined {
    if (code === DOLLAR) {
      sizeOpen++;
      effects.consume(code);
      return openSeq;
    }
    if (sizeOpen < 2) return nok(code);
    effects.exit("mathFlowFenceSequence");
    return effects.check(onlySpacesToEol, fencedOpenTail, sameLineStart)(code);
  }

  // --- Branch A: Fenced multi-line `$$\n...\n$$` ---

  function fencedOpenTail(code: Code): State | undefined {
    return isSpace(code) ? consumeSpaces(effects, fencedAfterOpen, "whitespace")(code) : fencedAfterOpen(code);
  }

  function fencedAfterOpen(code: Code): State | undefined {
    effects.exit("mathFlowFenceOpen");
    if (self.interrupt) {
      effects.exit("mathFlow");
      return ok(code);
    }
    return effects.check(nonLazyContinuation, fencedAtBreak, fencedFinish)(code);
  }

  function fencedAtBreak(code: Code): State | undefined {
    return effects.check(closeFenced, fencedCloseNow, fencedContentBreak)(code);
  }

  function fencedCloseNow(code: Code): State | undefined {
    if (contentOpen) {
      effects.exit("mathFlowContent");
      contentOpen = false;
    }
    return effects.attempt(closeFenced, fencedFinish, nok)(code);
  }

  function fencedContentBreak(code: Code): State | undefined {
    if (!contentOpen) {
      effects.enter("lineEnding");
      effects.consume(code);
      effects.exit("lineEnding");
      effects.enter("mathFlowContent");
      contentOpen = true;
      return fencedLineStart;
    }
    effects.enter("lineEnding");
    effects.consume(code);
    effects.exit("lineEnding");
    return fencedLineStart;
  }

  function fencedLineStart(code: Code): State | undefined {
    return initialPrefix > 0 && isSpace(code)
      ? consumeSpaces(effects, fencedBeforeChunk, "linePrefix", initialPrefix + 1)(code)
      : fencedBeforeChunk(code);
  }

  function fencedBeforeChunk(code: Code): State | undefined {
    if (code === null || isLineEnding(code)) {
      return effects.check(nonLazyContinuation, fencedAtBreak, fencedFinish)(code);
    }
    effects.enter("mathFlowValue");
    return fencedChunk(code);
  }

  function fencedChunk(code: Code): State | undefined {
    if (code === null || isLineEnding(code)) {
      effects.exit("mathFlowValue");
      return fencedBeforeChunk(code);
    }
    effects.consume(code);
    return fencedChunk;
  }

  function fencedFinish(code: Code): State | undefined {
    if (contentOpen) {
      effects.exit("mathFlowContent");
      contentOpen = false;
    }
    effects.exit("mathFlow");
    return ok(code);
  }

  // --- Branch B: Same-line-start `$$...$$` (single line or multi-line without blank lines) ---

  function sameLineStart(code: Code): State | undefined {
    if (sizeOpen !== 2) return nok(code);
    effects.exit("mathFlowFenceOpen");
    effects.enter("mathFlowSingle");
    effects.enter("mathFlowContent");
    return sameLineBeforeChunk(code);
  }

  function sameLineBeforeChunk(code: Code): State | undefined {
    if (code === null) return nok(code);

    if (isLineEnding(code)) {
      bsCount = 0;
      return effects.check(nonLazyContinuation, sameLineConsumeBreak, nok)(code);
    }

    if (code === DOLLAR) {
      if (bsCount % 2 === 1) {
        bsCount = 0;
        hasNonSpace = true;
        effects.enter("mathFlowValue");
        effects.consume(code);
        return sameLineChunk;
      }
      if (!hasNonSpace) return nok(code);
      return effects.check(closeSameLine, sameLineCloseNow, sameLineAfterFailedClose)(code);
    }

    effects.enter("mathFlowValue");
    return sameLineChunk(code);
  }

  function sameLineCloseNow(code: Code): State | undefined {
    effects.exit("mathFlowContent");
    return effects.attempt(closeSameLine, sameLineFinish, nok)(code);
  }

  function sameLineAfterFailedClose(code: Code): State | undefined {
    // If there is an unescaped `$$` with trailing non-whitespace text on the
    // same line (e.g., `$$a$$ + $$b$$` or `$$x$$ is positive`), abort flow math
    // so paragraph + inline mathText handles it instead.
    return effects.check(atLeastTwoDollars, nok, sameLineConsumeSingleDollar)(code);
  }

  function sameLineConsumeSingleDollar(code: Code): State | undefined {
    bsCount = 0;
    hasNonSpace = true;
    effects.enter("mathFlowValue");
    effects.consume(code);
    return sameLineChunk;
  }

  function sameLineConsumeBreak(code: Code): State | undefined {
    effects.enter("lineEnding");
    effects.consume(code);
    effects.exit("lineEnding");
    return sameLineAfterBreak;
  }

  function sameLineAfterBreak(code: Code): State | undefined {
    // Disallow blank lines inside same-line-start `$$...` blocks so an unclosed
    // `$$foo` cannot swallow subsequent paragraphs.
    return effects.check(onlySpacesToEol, nok, sameLineNextLineStart)(code);
  }

  function sameLineNextLineStart(code: Code): State | undefined {
    return initialPrefix > 0 && isSpace(code)
      ? consumeSpaces(effects, sameLineBeforeChunk, "linePrefix", initialPrefix + 1)(code)
      : sameLineBeforeChunk(code);
  }

  function sameLineChunk(code: Code): State | undefined {
    if (code === null || isLineEnding(code)) {
      effects.exit("mathFlowValue");
      return sameLineBeforeChunk(code);
    }
    if (code === DOLLAR && bsCount % 2 === 0) {
      effects.exit("mathFlowValue");
      return sameLineBeforeChunk(code);
    }
    if (code === BACKSLASH) {
      bsCount++;
      hasNonSpace = true;
    } else {
      bsCount = 0;
      if (!isSpace(code)) hasNonSpace = true;
    }
    effects.consume(code);
    return sameLineChunk;
  }

  function sameLineFinish(code: Code): State | undefined {
    effects.exit("mathFlowSingle");
    effects.exit("mathFlow");
    return ok(code);
  }
}

const mathTextConstruct: Construct = {
  name: "mathText",
  previous(code) {
    return code !== DOLLAR || this.events[this.events.length - 1]?.[1].type === "characterEscape";
  },
  tokenize: tokenizeMathText,
};

function tokenizeMathText(
  this: TokenizeContext,
  effects: Effects,
  ok: State,
  nok: State,
): State {
  let sizeOpen = 0;
  let bsCount = 0;
  let hasNonSpace = false;
  let prevWasSpace = false;
  let prevCode: Code = null;
  let closeDollars = 0;

  return start;

  function start(code: Code): State | undefined {
    effects.enter("mathText");
    effects.enter("mathTextSequence");
    return openSeq(code);
  }

  function openSeq(code: Code): State | undefined {
    if (code === DOLLAR) {
      sizeOpen++;
      if (sizeOpen > 2) return nok(code);
      effects.consume(code);
      return openSeq;
    }
    effects.exit("mathTextSequence");

    if (sizeOpen === 1) {
      // Pandoc / GitHub / Obsidian rule: opening `$` cannot be followed by whitespace.
      if (code === null || isLineEndingOrSpace(code)) return nok(code);
      effects.enter("mathTextContent");
      return singleBetween(code);
    }

    // Double-dollar inline math (`$$...$$`) inside a paragraph or table cell.
    if (code === null) return nok(code);
    effects.enter("mathTextDouble");
    effects.enter("mathTextContent");
    return doubleBetween(code);
  }

  // --- Single-dollar inline `$...$` ---
  function singleBetween(code: Code): State | undefined {
    if (code === null || code === BACKTICK) return nok(code);

    if (isLineEnding(code)) {
      prevWasSpace = true;
      prevCode = code;
      bsCount = 0;
      effects.enter("lineEnding");
      effects.consume(code);
      effects.exit("lineEnding");
      return singleBetween;
    }

    if (code === DOLLAR) {
      if (bsCount % 2 === 1) {
        bsCount = 0;
        prevWasSpace = false;
        prevCode = code;
        hasNonSpace = true;
        effects.enter("mathTextData");
        effects.consume(code);
        return singleData;
      }
      // Unescaped `$`: either a valid closer, or this opener was currency (e.g. `$5 and $x$`).
      if (!hasNonSpace || prevWasSpace) return nok(code);
      effects.exit("mathTextContent");
      effects.enter("mathTextSequence");
      effects.consume(code);
      effects.exit("mathTextSequence");
      return singleAfterClose;
    }

    effects.enter("mathTextData");
    return singleData(code);
  }

  function singleData(code: Code): State | undefined {
    if (code === null || code === BACKTICK || isLineEnding(code)) {
      effects.exit("mathTextData");
      return singleBetween(code);
    }
    if (code === DOLLAR && bsCount % 2 === 0) {
      effects.exit("mathTextData");
      return singleBetween(code);
    }
    if (code === BACKSLASH) {
      bsCount++;
      prevWasSpace = false;
      hasNonSpace = true;
    } else if (isSpace(code)) {
      bsCount = 0;
      prevWasSpace = true;
    } else {
      bsCount = 0;
      prevWasSpace = false;
      hasNonSpace = true;
    }
    prevCode = code;
    effects.consume(code);
    return singleData;
  }

  function singleAfterClose(code: Code): State | undefined {
    // Pandoc rule: closing `$` cannot be followed by an ASCII digit (`$5-$10`) or another `$`.
    // Also reject `($` before an alphanumeric (e.g., `costs $10 ($x$)` — that `$` opens `$x$`).
    if (code === DOLLAR || isAsciiDigit(code) || (isOpenDelim(prevCode) && isAsciiAlphaNum(code))) {
      return nok(code);
    }
    effects.exit("mathText");
    return ok(code);
  }

  // --- Double-dollar inline `$$...$$` ---

  function doubleBetween(code: Code): State | undefined {
    if (code === null) return nok(code);

    if (isLineEnding(code)) {
      bsCount = 0;
      effects.enter("lineEnding");
      effects.consume(code);
      effects.exit("lineEnding");
      return doubleBetween;
    }

    if (code === DOLLAR) {
      if (bsCount % 2 === 1) {
        bsCount = 0;
        hasNonSpace = true;
        effects.enter("mathTextData");
        effects.consume(code);
        return doubleData;
      }
      if (hasNonSpace) {
        return effects.check(exactDoubleDollar, doubleDoClose, doubleRejectOrSingle)(code);
      }
      return doubleRejectOrSingle(code);
    }

    effects.enter("mathTextData");
    return doubleData(code);
  }

  function doubleDoClose(code: Code): State | undefined {
    effects.exit("mathTextContent");
    effects.enter("mathTextSequence");
    closeDollars = 0;
    return doubleCloseSeq(code);
  }

  function doubleCloseSeq(code: Code): State | undefined {
    if (code === DOLLAR && closeDollars < 2) {
      closeDollars++;
      effects.consume(code);
      return doubleCloseSeq;
    }
    effects.exit("mathTextSequence");
    effects.exit("mathTextDouble");
    effects.exit("mathText");
    return ok(code);
  }

  function doubleRejectOrSingle(code: Code): State | undefined {
    // Reject `$$$` or empty `$$$$` inside inline double-dollar math; allow a single literal `$`.
    return effects.check(atLeastTwoDollars, nok, doubleConsumeSingleDollar)(code);
  }

  function doubleConsumeSingleDollar(code: Code): State | undefined {
    bsCount = 0;
    hasNonSpace = true;
    effects.enter("mathTextData");
    effects.consume(code);
    return doubleData;
  }

  function doubleData(code: Code): State | undefined {
    if (code === null || isLineEnding(code)) {
      effects.exit("mathTextData");
      return doubleBetween(code);
    }
    if (code === DOLLAR && bsCount % 2 === 0) {
      effects.exit("mathTextData");
      return doubleBetween(code);
    }
    if (code === BACKSLASH) {
      bsCount++;
      hasNonSpace = true;
    } else {
      bsCount = 0;
      if (!isSpace(code)) hasNonSpace = true;
    }
    effects.consume(code);
    return doubleData;
  }
}

/** Micromark syntax extension for display (`$$...$$`) and inline (`$...$`) LaTeX math. */
export function mathSyntax() {
  return {
    flow: { [DOLLAR]: mathFlowConstruct },
    text: { [DOLLAR]: mathTextConstruct },
  };
}

/** mdast-util-from-markdown extension creating `math` and `inlineMath` nodes. */
export function mathFromMarkdown() {
  return {
    enter: {
      mathFlow(this: CompileContext, token: Token) {
        this.data.mathFlowSingle = false;
        this.enter({ type: "math", value: "", data: { multiline: true } }, token);
      },
      mathFlowSingle(this: CompileContext) {
        this.data.mathFlowSingle = true;
      },
      mathFlowContent(this: CompileContext) {
        this.buffer();
      },
      mathFlowValue(this: CompileContext, token: Token) {
        this.config.enter.data.call(this, token);
      },
      mathText(this: CompileContext, token: Token) {
        this.data.mathTextDouble = false;
        this.enter({ type: "inlineMath", value: "" }, token);
      },
      mathTextDouble(this: CompileContext) {
        this.data.mathTextDouble = true;
      },
      mathTextContent(this: CompileContext) {
        this.buffer();
      },
      mathTextData(this: CompileContext, token: Token) {
        this.config.enter.data.call(this, token);
      },
    },
    exit: {
      mathFlowValue(this: CompileContext, token: Token) {
        this.config.exit.data.call(this, token);
      },
      mathFlowContent(this: CompileContext) {
        const raw = this.resume();
        const node = this.stack[this.stack.length - 1];
        const singleStart = Boolean(this.data.mathFlowSingle);
        const value = singleStart ? raw.trim() : raw;
        node.value = value;
        node.data = { multiline: !singleStart || value.includes("\n") };
      },
      mathFlow(this: CompileContext, token: Token) {
        this.data.mathFlowSingle = undefined;
        this.exit(token);
      },
      mathTextData(this: CompileContext, token: Token) {
        this.config.exit.data.call(this, token);
      },
      mathTextContent(this: CompileContext) {
        const raw = this.resume();
        const node = this.stack[this.stack.length - 1];
        const doubleDollar = Boolean(this.data.mathTextDouble);
        node.value = doubleDollar ? raw.trim() : raw;
        if (doubleDollar) node.data = { doubleDollar: true };
      },
      mathText(this: CompileContext, token: Token) {
        this.data.mathTextDouble = undefined;
        this.exit(token);
      },
    },
  };
}

function longestDollarFence(raw: string): number {
  let max = 0;
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s*(\$+)\s*$/.exec(line);
    if (m && m[1].length > max) max = m[1].length;
  }
  return max;
}

interface MathMdastNode {
  type: "math" | "inlineMath";
  value?: string;
  data?: { multiline?: boolean; doubleDollar?: boolean };
}

function handleMath(node: MathMdastNode): string {
  const raw = node.value ?? "";
  const multiline = Boolean(node.data?.multiline) || raw.includes("\n") || raw.length === 0;
  if (!multiline && !raw.includes("$$")) {
    return `$$${raw}$$`;
  }
  const fence = "$".repeat(Math.max(2, longestDollarFence(raw) + 1));
  return raw ? `${fence}\n${raw}\n${fence}` : `${fence}\n${fence}`;
}

function handleInlineMath(node: MathMdastNode): string {
  const raw = node.value ?? "";
  if (node.data?.doubleDollar) return `$$${raw}$$`;
  return `$${raw}$`;
}
handleInlineMath.peek = () => "$";

/**
 * mdast-util-to-markdown extension serializing `math` and `inlineMath` nodes.
 * `unsafe` rules only escape literal `$` sequences that would otherwise re-parse
 * as math (`$$` or currency-free `$...$`), leaving prose like `$5 and $10` unescaped.
 */
export function mathToMarkdown() {
  return {
    unsafe: [
      { character: "$", atBreak: true, after: "\\$" },
      { character: "$", inConstruct: "phrasing", after: "\\$" },
      {
        character: "$",
        inConstruct: "phrasing",
        after: "(?:[^\\s$`\\\\]|\\\\\\$)(?:(?:[^$`\\n]|\\\\\\$)*?(?:[^\\s$`([{\\\\]|\\\\\\$))?\\$(?![0-9$])",
      },
    ],
    handlers: {
      math: handleMath,
      inlineMath: handleInlineMath,
    },
  };
}

/** Unified/remark plugin enabling LaTeX math parsing and lossless serialization. */
export function remarkMath(this: { data(): object }): void {
  const data = this.data() as Record<string, unknown[]>;
  const micromarkExtensions = data.micromarkExtensions || (data.micromarkExtensions = []);
  const fromMarkdownExtensions = data.fromMarkdownExtensions || (data.fromMarkdownExtensions = []);
  const toMarkdownExtensions = data.toMarkdownExtensions || (data.toMarkdownExtensions = []);

  micromarkExtensions.push(mathSyntax());
  fromMarkdownExtensions.push(mathFromMarkdown());
  toMarkdownExtensions.push(mathToMarkdown());
}
