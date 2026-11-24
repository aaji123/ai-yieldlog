import { DatabaseSync } from "node:sqlite";
import type { Call, Outcome, Status, Workflow } from "./metrics.ts";
import type { Cost, Usage } from "./pricing.ts";

/** Prompts and answers are never stored: only counts, costs and a short label. */
const SCHEMA = `
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS workflows (
    name TEXT PRIMARY KEY,
    createdAt INTEGER NOT NULL,
    valuePerOutcome REAL,
    hourlyRate REAL,
    fixedMonthly REAL NOT NULL DEFAULT 0
  ) STRICT;
  CREATE TABLE IF NOT EXISTS outcomes (
    id TEXT PRIMARY KEY,
    workflow TEXT NOT NULL REFERENCES workflows(name),
    createdAt INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'accepted', 'reworked', 'rejected')),
    reviewMinutes REAL NOT NULL DEFAULT 0,
    reworkMinutes REAL NOT NULL DEFAULT 0,
    ref TEXT
  ) STRICT;
  CREATE INDEX IF NOT EXISTS outcomes_by_time ON outcomes(createdAt);
  CREATE TABLE IF NOT EXISTS calls (
    id TEXT PRIMARY KEY,
    outcomeId TEXT NOT NULL REFERENCES outcomes(id),
    createdAt INTEGER NOT NULL,
    step TEXT,
    model TEXT NOT NULL,
    input INTEGER NOT NULL,
    cachedInput INTEGER NOT NULL,
    cacheWrite INTEGER NOT NULL,
    output INTEGER NOT NULL,
    costUsd REAL,
    costSource TEXT NOT NULL,
    latencyMs INTEGER,
    ok INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS calls_by_outcome ON calls(outcomeId);
`;

export class ConflictError extends Error {}

export type NewCall = {
  id: string;
  step: string | null;
  model: string;
  usage: Usage | null;
  cost: Cost;
  latencyMs: number | null;
  ok: boolean;
};

export type OutcomeRow = Outcome & { calls: number; modelCost: number; unpriced: number };

export class Store {
  #db: DatabaseSync;

  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    this.#db.exec("PRAGMA journal_mode = WAL");
    this.#db.exec(SCHEMA);
  }

  close() {
    this.#db.close();
  }

  transaction<T>(work: () => T): T {
    this.#db.exec("BEGIN");
    try {
      const result = work();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  ensureWorkflow(name: string, at: number) {
    this.#db
      .prepare("INSERT OR IGNORE INTO workflows (name, createdAt) VALUES (?, ?)")
      .run(name, at);
  }

  setWorkflow(
    name: string,
    v: { valuePerOutcome: number | null; hourlyRate: number | null; fixedMonthly: number },
  ): boolean {
    return (
      this.#db
        .prepare(
          "UPDATE workflows SET valuePerOutcome = ?, hourlyRate = ?, fixedMonthly = ? WHERE name = ?",
        )
        .run(v.valuePerOutcome, v.hourlyRate, v.fixedMonthly, name).changes === 1
    );
  }

  /** Safe to repeat: an outcome or call id that already exists is left alone. */
  log(
    outcome: { id: string; workflow: string; ref: string | null },
    call: NewCall | null,
    at: number,
  ) {
    this.transaction(() => {
      this.ensureWorkflow(outcome.workflow, at);
      this.#db
        .prepare("INSERT OR IGNORE INTO outcomes (id, workflow, createdAt, ref) VALUES (?, ?, ?, ?)")
        .run(outcome.id, outcome.workflow, at, outcome.ref);
      const existing = this.#db
        .prepare("SELECT workflow FROM outcomes WHERE id = ?")
        .get(outcome.id) as { workflow: string };
      if (existing.workflow !== outcome.workflow) {
        throw new ConflictError(`Outcome ${outcome.id} belongs to another workflow.`);
      }
      if (!call) return;
      const u = call.usage;
      this.#db
        .prepare(
          `INSERT OR IGNORE INTO calls (id, outcomeId, createdAt, step, model, input, cachedInput,
             cacheWrite, output, costUsd, costSource, latencyMs, ok)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          call.id,
          outcome.id,
          at,
          call.step,
          call.model,
          u?.input ?? 0,
          u?.cachedInput ?? 0,
          (u?.cacheWrite ?? 0) + (u?.cacheWrite1h ?? 0),
          u?.output ?? 0,
          call.cost.usd,
          call.cost.source,
          call.latencyMs,
          call.ok ? 1 : 0,
        );
    });
  }

  review(id: string, r: { status: Status; reviewMinutes: number; reworkMinutes: number }): boolean {
    return (
      this.#db
        .prepare("UPDATE outcomes SET status = ?, reviewMinutes = ?, reworkMinutes = ? WHERE id = ?")
        .run(r.status, r.reviewMinutes, r.reworkMinutes, id).changes === 1
    );
  }

  workflows(): Workflow[] {
    return this.#db.prepare("SELECT * FROM workflows ORDER BY name").all() as unknown as Workflow[];
  }

  outcomes(from: number, to: number, workflow: string | null): Outcome[] {
    return this.#db
      .prepare(
        `SELECT * FROM outcomes
         WHERE createdAt >= ? AND createdAt <= ? AND (? IS NULL OR workflow = ?)`,
      )
      .all(from, to, workflow, workflow) as unknown as Outcome[];
  }

  calls(from: number, to: number, workflow: string | null): Call[] {
    return this.#db
      .prepare(
        `SELECT c.outcomeId, c.model, c.costUsd FROM calls c JOIN outcomes o ON o.id = c.outcomeId
         WHERE o.createdAt >= ? AND o.createdAt <= ? AND (? IS NULL OR o.workflow = ?)`,
      )
      .all(from, to, workflow, workflow) as unknown as Call[];
  }

  /** Waiting outcomes first (oldest first), then the most recently created. */
  list(from: number, to: number, workflow: string | null, limit: number): OutcomeRow[] {
    return this.#db
      .prepare(
        `SELECT o.*, COUNT(c.id) AS calls, COALESCE(SUM(c.costUsd), 0) AS modelCost,
                COUNT(c.id) - COUNT(c.costUsd) AS unpriced
         FROM outcomes o LEFT JOIN calls c ON c.outcomeId = o.id
         WHERE o.createdAt >= ? AND o.createdAt <= ? AND (? IS NULL OR o.workflow = ?)
         GROUP BY o.id
         ORDER BY o.status <> 'pending',
                  CASE WHEN o.status = 'pending' THEN o.createdAt ELSE -o.createdAt END
         LIMIT ?`,
      )
      .all(from, to, workflow, workflow, limit) as unknown as OutcomeRow[];
  }
}
