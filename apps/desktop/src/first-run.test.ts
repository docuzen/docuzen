// Pure decision logic only — modal DOM behavior is covered by the manual E2E
// in Task 10 (repo convention: no jsdom in this package's vitest setup).
import { expect, test } from "vitest";
import { shouldShowFirstRun } from "./first-run.js";

test("shows only when no harness is configured", () => {
  expect(shouldShowFirstRun({ harness: null })).toBe(true);
  expect(shouldShowFirstRun({ harness: { default: "pi" }, pi: { model: "litellm/gpt-5.5" } })).toBe(false);
  expect(shouldShowFirstRun({ harness: { default: "codex" } })).toBe(false);
});
