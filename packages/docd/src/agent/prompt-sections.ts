import type { AgentContext } from "./types.js";

/**
 * Shared prompt-fragment builders for the pi/codex prompt overlap. pi's
 * firstPrompt/reviewPrompt and codex's buildCodexPrompt both format a
 * "conversation so far" section and a "standing instructions" block from the same
 * AgentContext fields, but with small, deliberate textual differences (heading text,
 * role-label casing, whether the instructions body is trimmed). Each divergence is a
 * parameter here, not a behavior change — every caller's exact current output is
 * preserved byte-for-byte (see the capture tests in test/agent/pi-runner-prompt-capture
 * .test.ts and test/agent/codex-runner-prompt.test.ts, written against the pre-refactor
 * code).
 *
 * The mode/edit-policy narration (pi's editPolicy/taskIntro vs codex's `mode` array) is
 * NOT extracted here: both are driven by different context flags (pi: replacementOnly +
 * improveMode + allowEdit, coupled with a taskIntro sentence; codex: replacementOnly +
 * reviewMode + allowEdit, as independent filtered bullets) and share no reusable
 * sentence beyond incidental word overlap. Forcing a shared builder would either change
 * wording or produce a builder with no real body — see the Task 1 report.
 */

/** Role labels used to format one history line; the two callers differ only in casing. */
export interface HistoryRoleLabels {
  agent: string;
  reviewer: string;
}

/**
 * Builds the "conversation so far" section from `history`, or `[]` when there is none
 * to replay. Both callers use the shape `${label}: ${body}`, one line per turn, under a
 * heading — they differ in the heading text and role-label casing:
 *  - pi:    "## Conversation so far (continue it)", labels {agent: "agent", reviewer: "reviewer"}
 *  - codex: "## Conversation so far",                labels {agent: "Agent", reviewer: "Reviewer"}
 */
export function historySection(
  history: AgentContext["history"],
  heading: string,
  labels: HistoryRoleLabels,
): string[] {
  if (!history || !history.length) return [];
  return [
    "",
    heading,
    ...history.map((h) => `${h.role === "agent" ? labels.agent : labels.reviewer}: ${h.body}`),
  ];
}

/**
 * Builds the standing-instructions block from `instructions`, or `[]` when there are
 * none (after trimming, for the presence check only). The two callers differ in the
 * heading and in whether the inserted body is trimmed:
 *  - pi:    "## Standing instructions (always apply)", body inserted AS-AUTHORED (untrimmed)
 *  - codex: "## Standing instructions",                 body inserted TRIMMED
 */
export function standingInstructionsSection(
  instructions: string | undefined,
  heading: string,
  trimBody: boolean,
): string[] {
  if (!instructions?.trim()) return [];
  return ["", heading, trimBody ? instructions.trim() : instructions];
}
