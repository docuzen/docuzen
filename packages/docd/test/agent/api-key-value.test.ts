import { describe, expect, it } from "vitest";
import { resolveApiKeyValue } from "../../src/agent/model-registry.js";

describe("resolveApiKeyValue (a models.json apiKey handed to Codex)", () => {
  const env = { LITELLM_API_KEY: "sk-live", HOST: "gw" };

  it("expands $NAME and ${NAME} like pi, and leaves a literal key alone", () => {
    expect(resolveApiKeyValue("$LITELLM_API_KEY", env)).toBe("sk-live");
    expect(resolveApiKeyValue("Bearer ${LITELLM_API_KEY}-x", env)).toBe("Bearer sk-live-x");
    expect(resolveApiKeyValue("sk-literal", env)).toBe("sk-literal");
  });

  it("reads $$ and $! as a literal $ and !", () => {
    expect(resolveApiKeyValue("a$$b$!c", env)).toBe("a$b!c");
  });

  it("names a variable that is not set instead of sending its name as the key", () => {
    expect(() => resolveApiKeyValue("$MISSING_KEY", env)).toThrow(/\$MISSING_KEY, which is not set/);
  });

  it("refuses a shell-command key rather than run it", () => {
    expect(() => resolveApiKeyValue("!security find-generic-password -w", env)).toThrow(/shell command/);
  });
});
