import { describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeShellEnv, parseShellEnvOutput, readShellEnv } from "../../src/server/shell-env.js";

describe("shell environment", () => {
  it("parses the dump out of rc-file noise", () => {
    const out = `Welcome back!\n__DOCD_SHELL_ENV__{"A":"1","PATH":"/x"}__DOCD_SHELL_ENV__\nbye`;
    expect(parseShellEnvOutput(out)).toEqual({ A: "1", PATH: "/x" });
    expect(parseShellEnvOutput("no markers")).toBeNull();
    expect(parseShellEnvOutput("__DOCD_SHELL_ENV__not json__DOCD_SHELL_ENV__")).toBeNull();
  });

  it("adds missing variables, keeps explicit ones, and puts the shell's PATH first", () => {
    const target: NodeJS.ProcessEnv = { PATH: "/usr/bin:/opt/homebrew/bin", KEEP: "launch", EMPTY: "" };
    const added = mergeShellEnv(target, {
      PATH: "/opt/homebrew/bin:/Users/u/.local/bin",
      KEEP: "shell",
      EMPTY: "filled",
      LLM_KEY: "secret",
      SHLVL: "3",
      PWD: "/somewhere",
    });
    expect(target.PATH).toBe("/opt/homebrew/bin:/Users/u/.local/bin:/usr/bin");
    expect(target.KEEP).toBe("launch");
    expect(target.EMPTY).toBe("filled");
    expect(target.LLM_KEY).toBe("secret");
    expect(target.SHLVL).toBeUndefined();
    expect(added.sort()).toEqual(["EMPTY", "LLM_KEY"]);
  });

  it("reads exports from a real shell, and survives a shell that fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "shell-env-"));
    const fake = join(dir, "fakesh");
    // Stands in for a login shell whose profile exports a key: ignores -ilc, runs the command.
    writeFileSync(fake, `#!/bin/sh\necho "rc noise"\nexport FROM_PROFILE=yes\nshift\nexec /bin/sh -c "$1"\n`);
    chmodSync(fake, 0o755);
    const env = await readShellEnv({ shell: fake });
    expect(env?.FROM_PROFILE).toBe("yes");
    expect(await readShellEnv({ shell: join(dir, "missing") })).toBeNull();
  });
});
