import { mkdir, readFile, writeFile } from "node:fs/promises";
import { hadPaths } from "./paths.js";
import type { EditHunk } from "../agent/types.js";

export type ProposalStatus = "pending" | "approved" | "rejected";

/** An agent's structured edit proposal, persisted per thread so the UI can surface it. */
export interface Proposal {
  id: string;
  threadId: string;
  /** Normalized display/apply hunks (targeted edits, or the diff of a full rewrite). */
  edits: EditHunk[];
  /** Rewrite mode → the exact new body to write on apply. */
  fullText?: string;
  /**
   * SHA-256 of the (frontmatter-stripped) doc body when the proposal was made. Approval
   * compares it to the current body and refuses to apply if the doc drifted — so a stale
   * full rewrite can't silently clobber intervening edits, and hunks can't apply against
   * a body the agent never saw. Absent on legacy proposals (guard skipped for those).
   */
  baseHash?: string;
  rationale: string;
  status: ProposalStatus;
  /** Reviewer/validator feedback to deliver to the agent on the next turn. */
  feedback?: string;
  /** Whether a rejected proposal's feedback has already ridden along with a reply. */
  delivered: boolean;
  at: string; // ISO timestamp
  /** Legacy single-span proposals (back-compat reads only). */
  newText?: string;
}

export interface ProposalsFile {
  version: number;
  proposals: Proposal[];
}

const EMPTY: ProposalsFile = { version: 1, proposals: [] };

export async function readProposals(docPath: string): Promise<ProposalsFile> {
  const p = hadPaths(docPath);
  try {
    const raw = await readFile(p.proposals, "utf8");
    return JSON.parse(raw) as ProposalsFile;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT")
      return { version: EMPTY.version, proposals: [] };
    throw err;
  }
}

export async function writeProposals(
  docPath: string,
  f: ProposalsFile,
): Promise<void> {
  const p = hadPaths(docPath);
  await mkdir(p.dir, { recursive: true });
  await writeFile(p.proposals, JSON.stringify(f, null, 2) + "\n", "utf8");
}

/** All proposals, optionally filtered to one thread. */
export async function listProposals(
  docPath: string,
  threadId?: string,
): Promise<Proposal[]> {
  const f = await readProposals(docPath);
  return threadId
    ? f.proposals.filter((p) => p.threadId === threadId)
    : f.proposals;
}

export async function addProposal(docPath: string, p: Proposal): Promise<void> {
  const f = await readProposals(docPath);
  f.proposals.push(p);
  await writeProposals(docPath, f);
}

export async function updateProposal(
  docPath: string,
  id: string,
  patch: Partial<Omit<Proposal, "id">>,
): Promise<void> {
  const f = await readProposals(docPath);
  const idx = f.proposals.findIndex((p) => p.id === id);
  if (idx === -1) throw new Error(`proposal not found: ${id}`);
  f.proposals[idx] = { ...f.proposals[idx], ...patch };
  await writeProposals(docPath, f);
}
