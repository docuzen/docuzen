import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export interface ModelChoice { key: string; name: string }

/** Query the same account-aware model list Codex exposes to its app clients. */
export function listCodexModels(command: string, cwd: string): Promise<ModelChoice[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, ["app-server", "--listen", "stdio://"], { cwd, stdio: ["pipe", "pipe", "ignore"] });
    const lines = createInterface({ input: child.stdout });
    const choices = new Map<string, ModelChoice>();
    const cursors = new Set<string>();
    let id = 1;
    let done = false;
    const timer = setTimeout(() => finish(new Error("Codex did not return its model list in 15 seconds.")), 15_000);
    function finish(error?: Error) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      lines.close();
      child.stdin.end();
      child.kill();
      if (error) reject(error);
      else resolve([...choices.values()]);
    }
    function send(message: object) { child.stdin.write(JSON.stringify(message) + "\n"); }
    function list(cursor?: string) {
      send({ id: ++id, method: "model/list", params: { includeHidden: false, limit: 100, cursor } });
    }
    child.on("error", finish);
    child.stdin.on("error", finish);
    child.on("close", () => finish(new Error("Codex closed before returning its model list.")));
    lines.on("line", line => {
      if (done) return;
      try {
        const msg = JSON.parse(line);
        if (msg.id !== id) return;
        if (msg.error) throw new Error(msg.error.message ?? "Codex could not list models.");
        if (id === 1) {
          send({ method: "initialized" });
          list();
          return;
        }
        if (!Array.isArray(msg.result?.data)) throw new Error("Unexpected model list from Codex.");
        for (const row of msg.result.data) {
          if (typeof row.model !== "string" || !row.model || row.hidden) continue;
          choices.set(row.model, { key: "codex:" + row.model, name: row.displayName || row.model });
        }
        const cursor = msg.result.nextCursor;
        if (!cursor) return finish();
        if (typeof cursor !== "string" || cursors.has(cursor)) throw new Error("Invalid Codex model list cursor.");
        cursors.add(cursor);
        list(cursor);
      } catch (e) { finish(e instanceof Error ? e : new Error(String(e))); }
    });
    send({ id, method: "initialize", params: { clientInfo: { name: "docuzen", version: "1" } } });
  });
}
