import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { TaskDB } from "../../src/state/task-db.js";

const require = createRequire(import.meta.url);

afterEach(() => {
  delete process.env.DOCD_NATIVE_BINDING;
});

describe("TaskDB DOCD_NATIVE_BINDING override", () => {
  test("loads the addon from the path in DOCD_NATIVE_BINDING", () => {
    process.env.DOCD_NATIVE_BINDING = join(
      dirname(require.resolve("better-sqlite3/package.json")),
      "build/Release/better_sqlite3.node",
    );
    const dbPath = join(mkdtempSync(join(tmpdir(), "taskdb-nb-")), "tasks.sqlite");
    expect(() => new TaskDB(dbPath)).not.toThrow();
  });

  test("a bogus DOCD_NATIVE_BINDING fails loudly (proves the option is honored)", () => {
    process.env.DOCD_NATIVE_BINDING = "/nonexistent/better_sqlite3.node";
    const dbPath = join(mkdtempSync(join(tmpdir(), "taskdb-nb-")), "tasks.sqlite");
    expect(() => new TaskDB(dbPath)).toThrow();
  });
});
