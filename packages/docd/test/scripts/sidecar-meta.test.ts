import { describe, expect, test } from "vitest";
import { writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  cacheDirFor,
  downloadsFor,
  loadSidecarMeta,
  sha256File,
} from "../../scripts/lib/sidecar-meta.mjs";

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("sidecar-meta", () => {
  test("loadSidecarMeta merges sidecar.json with the addon version", () => {
    const meta = loadSidecarMeta(pkgDir);
    expect(meta.nodeVersion).toBe("22.17.0");
    expect(meta.abi).toBe("127");
    expect(meta.addonVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(Object.keys(meta.checksums)).toContain("node-darwin-arm64");
  });

  test("cacheDirFor keys the cache by node AND addon version", () => {
    const meta = { nodeVersion: "22.17.0", abi: "127", addonVersion: "12.10.0", checksums: {} };
    const dir = cacheDirFor("/repo/packages/docd", meta, "arm64");
    expect(dir).toBe("/repo/packages/docd/.sidecar-cache/darwin-arm64/22.17.0-12.10.0");
  });

  test("downloadsFor builds pinned URLs, members, and hashes", () => {
    const meta = loadSidecarMeta(pkgDir);
    const dl = downloadsFor(meta, "x64");
    expect(dl.node.url).toBe("https://nodejs.org/dist/v22.17.0/node-v22.17.0-darwin-x64.tar.gz");
    expect(dl.node.tarMember).toBe("node-v22.17.0-darwin-x64/bin/node");
    expect(dl.node.sha256).toBe(meta.checksums["node-darwin-x64"]);
    expect(dl.addon.url).toContain(`v${meta.addonVersion}-node-v127-darwin-x64.tar.gz`);
    expect(dl.addon.tarMember).toBe("build/Release/better_sqlite3.node");
  });

  test("downloadsFor throws on a missing checksum", () => {
    const meta = { nodeVersion: "22.17.0", abi: "127", addonVersion: "12.10.0", checksums: {} };
    expect(() => downloadsFor(meta, "arm64")).toThrow(/missing checksum/);
  });

  test("sha256File hashes file contents", async () => {
    const f = join(mkdtempSync(join(tmpdir(), "sha-")), "x");
    writeFileSync(f, "hello\n");
    await expect(sha256File(f)).resolves.toBe(
      "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03",
    );
  });
});
