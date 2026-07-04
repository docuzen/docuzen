import { extname } from "node:path";

/**
 * True if `docPath`'s extension marks it as an HTML document (`.html` or `.htm`,
 * case-insensitively). HTML docs skip the `had:` frontmatter pointer (no YAML in
 * HTML) and are treated as raw source everywhere else in `had`/orchestrator/agent.
 */
export function isHtmlDoc(docPath: string): boolean {
  const ext = extname(docPath).toLowerCase();
  return ext === ".html" || ext === ".htm";
}
