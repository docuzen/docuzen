import { describe, expect, it } from "vitest";
import { codexExecArgs } from "../../src/agent/codex-runner.js";

// codex-cli 0.142.x removed the `--search` flag (search features retired;
// the CLI manages web access natively via browser_use). Passing it makes
// every exec fail with "unexpected argument '--search'". These tests pin
// the exact argv we hand the CLI.
describe("codexExecArgs", () => {
  it("builds the exec argv without the removed --search flag", () => {
    const args = codexExecArgs({ workDir: "/w", outputPath: "/tmp/out.txt" });
    expect(args).not.toContain("--search");
    expect(args).toEqual([
      "exec",
      "--json",
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
      "--cd",
      "/w",
      "--output-last-message",
      "/tmp/out.txt",
      "-",
    ]);
  });

  it("inserts --model after exec when a model is configured", () => {
    const args = codexExecArgs({ workDir: "/w", outputPath: "/tmp/out.txt", model: "o4" });
    expect(args.slice(0, 3)).toEqual(["exec", "--model", "o4"]);
    expect(args).not.toContain("--search");
  });

  it("passes Docuzen-managed provider config as codex -c overrides", () => {
    const args = codexExecArgs({
      workDir: "/w",
      outputPath: "/tmp/out.txt",
      configOverrides: {
        model: "gpt-5.5",
        model_provider: "docuzen",
        "model_providers.docuzen.name": "Docuzen model",
        "model_providers.docuzen.base_url": "https://llm.example/v1",
        "model_providers.docuzen.env_key": "LLM_API_KEY",
        model_reasoning_effort: "xhigh",
      },
    });
    expect(args.slice(0, 13)).toEqual([
      "exec",
      "-c",
      'model="gpt-5.5"',
      "-c",
      'model_provider="docuzen"',
      "-c",
      'model_providers.docuzen.name="Docuzen model"',
      "-c",
      'model_providers.docuzen.base_url="https://llm.example/v1"',
      "-c",
      'model_providers.docuzen.env_key="LLM_API_KEY"',
      "-c",
      'model_reasoning_effort="xhigh"',
    ]);
    expect(args).not.toContain("--model");
  });

  it("skips codex's git-repo trust check for documents outside git repos", () => {
    const args = codexExecArgs({ workDir: "/tmp/docs", outputPath: "/tmp/out.txt" });
    expect(args).toContain("--skip-git-repo-check");
    expect(args.indexOf("--skip-git-repo-check")).toBeGreaterThan(
      args.indexOf("read-only"),
    );
    expect(args.indexOf("--cd")).toBeGreaterThan(
      args.indexOf("--skip-git-repo-check"),
    );
  });
});
