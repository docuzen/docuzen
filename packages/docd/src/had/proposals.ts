import { hadPaths } from "./paths.js";
import { readJsonFile, updateJsonFile, withFileLock, writeJsonFile } from "./io.js";
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

const empty = (): ProposalsFile => ({ version: 1, proposals: [] });

export async function readProposals(docPath: string): Promise<ProposalsFile> {
  return readJsonFile(hadPaths(docPath).proposals, empty);
}

/** Replace the whole proposals file (atomic, serialized with every other writer). */
export async function writeProposals(docPath: string, f: ProposalsFile): Promise<void> {
  const path = hadPaths(docPath).proposals;
  await withFileLock(path, () => writeJsonFile(path, f));
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
  await updateJsonFile(hadPaths(docPath).proposals, empty, (f) => {
    f.proposals.push(p);
    return { next: f, result: undefined };
  });
}

/**
 * Allocate the next per-thread proposal id (`<threadId>#p<N>`) and append the proposal
 * `build` makes for it, as ONE locked step — parallel directive/review agents finishing
 * together can neither collide on an id nor drop each other's proposal.
 */
export async function appendProposal(
  docPath: string,
  threadId: string,
  build: (id: string) => Proposal,
): Promise<Proposal> {
  return updateJsonFile(hadPaths(docPath).proposals, empty, (f) => {
    const n = f.proposals.filter((p) => p.threadId === threadId).length + 1;
    const proposal = build(`${threadId}#p${n}`);
    f.proposals.push(proposal);
    return { next: f, result: proposal };
  });
}

export async function updateProposal(
  docPath: string,
  id: string,
  patch: Partial<Omit<Proposal, "id">>,
): Promise<void> {
  await updateJsonFile(hadPaths(docPath).proposals, empty, (f) => {
    const idx = f.proposals.findIndex((p) => p.id === id);
    if (idx === -1) throw new Error(`proposal not found: ${id}`);
    f.proposals[idx] = { ...f.proposals[idx], ...patch };
    return { next: f, result: undefined };
  });
}
