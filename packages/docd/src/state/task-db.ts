import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

export type TaskStatus = "queued" | "running" | "responded" | "error";

export interface TaskRow {
  threadId: string;
  status: TaskStatus;
  piSessionId: string | null;
  updatedAt: string;
  /** First line of the error that produced an "error" status (≤300 chars); null otherwise. */
  errorText?: string | null;
}

interface RawRow {
  thread_id: string;
  status: TaskStatus;
  pi_session_id: string | null;
  updated_at: string;
  error_text: string | null;
}

function toRow(r: RawRow): TaskRow {
  return {
    threadId: r.thread_id,
    status: r.status,
    piSessionId: r.pi_session_id,
    updatedAt: r.updated_at,
    errorText: r.error_text,
  };
}

/** Per-doc ephemeral task-liveness store. Rebuildable; never holds durable content. */
export class TaskDB {
  private db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    // Packaged app: the native addon sits next to the sidecar bundle, not in
    // a node_modules tree. DOCD_NATIVE_BINDING is set by the Rust shell.
    const nativeBinding = process.env.DOCD_NATIVE_BINDING;
    this.db = nativeBinding ? new Database(dbPath, { nativeBinding }) : new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        thread_id TEXT PRIMARY KEY,
        status TEXT NOT NULL CHECK(status IN ('queued','running','responded','error')),
        pi_session_id TEXT,
        updated_at TEXT NOT NULL
      );
    `);
    this.migrateErrorTextColumn();
  }

  /**
   * `error_text` was added after `tasks` shipped, so a DB created by an older build won't
   * have it. Detect via PRAGMA table_info (works whether the table was just created above
   * or already existed on disk) and ALTER it in — a fresh CREATE TABLE never includes the
   * column directly, so this single path handles both fresh and pre-existing DBs alike.
   */
  private migrateErrorTextColumn(): void {
    const cols = this.db.prepare(`PRAGMA table_info(tasks)`).all() as { name: string }[];
    if (!cols.some((c) => c.name === "error_text")) {
      this.db.exec(`ALTER TABLE tasks ADD COLUMN error_text TEXT`);
    }
  }

  upsert(t: {
    threadId: string;
    status: TaskStatus;
    piSessionId: string | null;
    /** Omit (or pass null) to clear any previously recorded error on this row. */
    errorText?: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO tasks (thread_id, status, pi_session_id, error_text, updated_at)
         VALUES (@threadId, @status, @piSessionId, @errorText, @updatedAt)
         ON CONFLICT(thread_id) DO UPDATE SET
           status = excluded.status,
           pi_session_id = excluded.pi_session_id,
           error_text = excluded.error_text,
           updated_at = excluded.updated_at`,
      )
      .run({ ...t, errorText: t.errorText ?? null, updatedAt: new Date().toISOString() });
  }

  get(threadId: string): TaskRow | null {
    const r = this.db
      .prepare(`SELECT * FROM tasks WHERE thread_id = ?`)
      .get(threadId) as RawRow | undefined;
    return r ? toRow(r) : null;
  }

  list(): TaskRow[] {
    return (this.db.prepare(`SELECT * FROM tasks ORDER BY updated_at DESC`).all() as RawRow[]).map(toRow);
  }

  listByStatus(status: TaskStatus): TaskRow[] {
    return (
      this.db.prepare(`SELECT * FROM tasks WHERE status = ?`).all(status) as RawRow[]
    ).map(toRow);
  }

  close(): void {
    this.db.close();
  }
}
