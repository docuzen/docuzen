/** W3C Web Annotation TextQuoteSelector-style anchor. */
export interface TextQuoteAnchor {
  exact: string;
  prefix: string;
  suffix: string;
}

/** A resolved half-open character range [start, end) in a document. */
export interface ResolvedRange {
  start: number;
  end: number;
}
