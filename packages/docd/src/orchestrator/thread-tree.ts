import { readAnnotations, readThread } from "../had/index.js";

/** Max length of a derived thread title. */
const TITLE_MAX = 60;

/**
 * One discussion thread's lineage + display metadata, flat (no nesting). The UI
 * builds the branch tree by joining `id`/`parent`, and computes siblings by
 * grouping on `parent` — so it needs every thread in one round-trip, not N.
 */
export interface ThreadNode {
  id: string;
  parent?: string;
  branchFromTurn?: number;
  baseVersion?: string;
  baseDoc?: "latest" | "at-turn";
  anchorExact: string;
  /** First "you" turn body, whitespace-collapsed + capped; falls back to anchorExact. */
  title: string;
  turnCount: number;
  status: string;
  createdAt: string;
}

/** Collapse runs of whitespace/newlines to single spaces, trim, and cap length. */
function deriveTitle(raw: string, max = TITLE_MAX): string {
  const collapsed = raw.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? collapsed.slice(0, max) : collapsed;
}

/**
 * List every discussion thread for a doc with its lineage. Annotations that have
 * no thread file yet (a comment never discussed) are skipped, and a single bad
 * thread file is skipped rather than aborting the whole listing. Order follows
 * annotation order; the UI does any nesting.
 */
export async function listThreadTree(docPath: string): Promise<ThreadNode[]> {
  const anns = (await readAnnotations(docPath)).annotations;
  const nodes: ThreadNode[] = [];
  for (const ann of anns) {
    try {
      const thread = await readThread(docPath, ann.id);
      const fm = thread.frontmatter;
      const anchorExact = fm.anchorExact ?? ann.anchor.exact;
      const youBody = thread.turns.find((t) => t.role === "you")?.body;
      const title = youBody ? deriveTitle(youBody) : anchorExact;
      const node: ThreadNode = {
        id: ann.id,
        anchorExact,
        title,
        turnCount: thread.turns.length,
        status: fm.status,
        createdAt: ann.createdAt,
      };
      if (fm.parent !== undefined) node.parent = fm.parent;
      if (fm.branchFromTurn !== undefined) node.branchFromTurn = fm.branchFromTurn;
      if (fm.baseVersion !== undefined) node.baseVersion = fm.baseVersion;
      if (fm.baseDoc !== undefined) node.baseDoc = fm.baseDoc;
      nodes.push(node);
    } catch {
      // Annotation with no thread file yet (never discussed), or an unreadable
      // thread file — skip it so one bad entry doesn't abort the rest.
    }
  }
  return nodes;
}
