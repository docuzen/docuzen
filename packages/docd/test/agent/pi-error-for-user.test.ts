import { describe, expect, it } from "vitest";
import { finishTurn, piErrorForUser } from "../../src/agent/pi-runner.js";

const CLI_HELP = "Use /login to log into a provider via OAuth or API key. See:\n  /x/node_modules/@earendil-works/pi-coding-agent/docs/providers.md\n  /x/docs/models.md";

describe("piErrorForUser: Pi's CLI auth errors, said for a Docuzen user", () => {
  it("a missing key names the provider and where to add it, with no /login advice or install paths", () => {
    const msg = piErrorForUser(`No API key found for litellm.\n\n${CLI_HELP}`);
    expect(msg).toMatch(/^Pi has no API key for litellm\. Add it in File ▸ Settings ▸ Manage model providers\./);
    expect(msg).toContain("$VARIABLE");
    expect(msg).not.toMatch(/\/login|node_modules/);
  });

  it("no model at all points to Settings", () => {
    expect(piErrorForUser(`No models available. ${CLI_HELP}`)).toBe("Pi has no model to use. Add one in File ▸ Settings ▸ Manage model providers.");
  });

  it("leaves every other error as it was", () => {
    expect(piErrorForUser("404 model not found")).toBe("404 model not found");
  });

  it("is what a failed turn throws", () => {
    const entry = { buf: "", proposal: undefined, findings: [], error: `No API key found for litellm.\n\n${CLI_HELP}`, aborted: false, think: "" };
    expect(() => finishTurn(entry as never)).toThrow(/^Pi has no API key for litellm/);
  });
});
