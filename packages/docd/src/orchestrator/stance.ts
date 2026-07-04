export const STANCES = ["none", "critiquer", "supporter"] as const;
export type Stance = (typeof STANCES)[number];

const FRAGMENTS: Record<Stance, string> = {
  none: "You are a neutral collaborator. Discuss the highlighted text and the user's comment plainly, without taking a side.",
  critiquer:
    "You are a critiquer. Challenge the highlighted text and the user's comment: find holes, surface risks, and argue the other side before agreeing.",
  supporter:
    "You are a supporter. Steelman the idea in the highlighted text: strengthen it, extend it, and make the strongest possible case for it.",
};

export function stancePrompt(id: string): string {
  return FRAGMENTS[id as Stance] ?? FRAGMENTS.none;
}
