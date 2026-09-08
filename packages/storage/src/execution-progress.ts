import { ExecutionProgressSchema, type ExecutionProgress, ExecutionRunIdSchema } from "@codex-task-console/domain";
import { getTaskStorageWorktreeAccess } from "./task-storage-internals.js";
import type { TaskStorage } from "./task-storage.js";
import { TaskStorageError } from "./errors.js";

/** Separate from settled usage: partial updates never debit the execution budget twice. */
export function recordExecutionProgress(storage: TaskStorage, runId: string, input: Omit<ExecutionProgress, "observedAt">): void {
  const access = getTaskStorageWorktreeAccess(storage);
  if (!access) throw new TaskStorageError("DATABASE_CLOSED", "Execution activity is unavailable.");
  const id = ExecutionRunIdSchema.parse(runId);
  const progress = ExecutionProgressSchema.parse({ ...input, observedAt: access.clock().toISOString() });
  storage.runInTransaction(() => {
    const run = storage.getExecutionRunById(id);
    if (run === null || !["CREATED", "RUNNING"].includes(run.status)) {
      throw new TaskStorageError("CONFLICT", "Only an active execution can report activity.");
    }
    const previous = readExecutionProgress(storage, id);
    if (previous && (progress.observedAt < previous.observedAt || progress.toolActions < previous.toolActions || progress.notifications < previous.notifications)) {
      throw new TaskStorageError("CONFLICT", "Execution activity cannot move backwards.");
    }
    if (previous && progress.activity === previous.activity && progress.toolActions === previous.toolActions &&
      JSON.stringify(progress.usage) === JSON.stringify(previous.usage) &&
      Date.parse(progress.observedAt) - Date.parse(previous.observedAt) < 5_000) return;
    access.sqlite.prepare(`INSERT INTO execution_run_progress (execution_run_id, payload) VALUES (?, ?)
      ON CONFLICT(execution_run_id) DO UPDATE SET payload=excluded.payload`).run(id, JSON.stringify(progress));
  });
}

export function readExecutionProgress(storage: TaskStorage, runId: string): ExecutionProgress | null {
  const access = getTaskStorageWorktreeAccess(storage);
  if (!access) throw new TaskStorageError("DATABASE_CLOSED", "Execution activity is unavailable.");
  const row = access.sqlite.prepare("SELECT payload FROM execution_run_progress WHERE execution_run_id=?").get(ExecutionRunIdSchema.parse(runId));
  if (!row) return null;
  try { return ExecutionProgressSchema.parse(JSON.parse(String(row.payload))); }
  catch { throw new TaskStorageError("MALFORMED_STORED_DATA", "Stored execution activity is malformed."); }
}
