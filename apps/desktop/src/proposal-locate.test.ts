import { describe, expect, it } from "vitest";
import {
  markdownEscapesToProjectionText,
  markdownHunkToProjectionText,
  projectionNeedlesForHunk,
} from "./proposal-locate.js";

describe("proposal hunk projection candidates", () => {
  it("converts a markdown heading hunk to rendered editor projection text", () => {
    const oldText = "## Rollout\n\nWe enable all tenants.";

    expect(markdownHunkToProjectionText(oldText)).toBe("Rollout\nWe enable all tenants.");
  });

  it("keeps exact source and rendered candidates for robust lookup", () => {
    const needles = projectionNeedlesForHunk("## Rollout\n\nWe enable all tenants.");

    expect(needles).toContain("## Rollout\n\nWe enable all tenants.");
    expect(needles).toContain("Rollout\nWe enable all tenants.");
  });

  it("normalizes common markdown list and quote prefixes", () => {
    expect(markdownHunkToProjectionText("> Note\n- first\n1. second")).toBe(
      "Note\nfirst\nsecond",
    );
  });

  it("adds a rendered candidate for escaped inline directives", () => {
    const source =
      "we distinguish quota-exceeded from suspected-abuse responses in both the body and metrics.  \\[\\[cite blogs from fortune 500 describing best practices for api gateway design]]";

    expect(markdownEscapesToProjectionText(source)).toContain(
      "[[cite blogs from fortune 500 describing best practices for api gateway design]]",
    );
    expect(projectionNeedlesForHunk(source)).toContain(
      "we distinguish quota-exceeded from suspected-abuse responses in both the body and metrics.  [[cite blogs from fortune 500 describing best practices for api gateway design]]",
    );
  });
});
