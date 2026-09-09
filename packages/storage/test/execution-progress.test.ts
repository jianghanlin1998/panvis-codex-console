import { expect, it } from "vitest";
import { makeExecutionFixture } from "./big-task-execution-fixture.js";
import { getGovernedProviderBridge } from "../src/governed-execution-public.js";
import { recordExecutionProgress, readExecutionProgress } from "../src/execution-progress.js";
import { DatabaseSync } from "node:sqlite";
import { BigTaskExecutionStore } from "../src/big-task-execution.js";

it("keeps partial activity separate from settled cost, throttles unchanged updates and reopens it", () => {
  let now = Date.parse("2026-09-07T00:00:00.000Z");
  const f = makeExecutionFixture(() => new Date(now));
  try {
    f.execution.approve(f.approval); f.execution.start(f.approval.bigTaskId);
    const prepared = f.governed.prepareNextRole(f.approval.bigTaskId);
    if (prepared.kind !== "ROLE_AUTHORIZED") throw new Error("Missing test authority");
    const attempt = getGovernedProviderBridge(f.governed).reserveRoleExecutionAttempt(prepared.authorization.authorizationId);
    const progress = { activity: "READING_OR_TESTING" as const, toolActions: 1, notifications: 3,
      usage: { inputTokens: 100, cachedInputTokens: 80, outputTokens: 10, reasoningTokens: 4, totalTokens: 110 } };
    recordExecutionProgress(f.storage, attempt.executionRunId, progress);
    expect(f.execution.inspect(f.approval.bigTaskId)).toMatchObject({ knownTokens: 0, activeRoleCount: 1,
      unknownCompletedUsage: false, activeRole: { usageState: "IN_PROGRESS", progress }, usageBreakdown: { completedRuns: 0 } });
    const first = readExecutionProgress(f.storage, attempt.executionRunId);
    now += 1_000;
    recordExecutionProgress(f.storage, attempt.executionRunId, { ...progress, notifications: 4 });
    expect(readExecutionProgress(f.storage, attempt.executionRunId)).toEqual(first);
    now += 5_000;
    recordExecutionProgress(f.storage, attempt.executionRunId, { ...progress, notifications: 5 });
    const latest = readExecutionProgress(f.storage, attempt.executionRunId);
    expect(latest?.observedAt).toBe(new Date(now).toISOString());
    expect(() => recordExecutionProgress(f.storage, attempt.executionRunId, { ...progress, toolActions: 0 })).toThrow();
    expect(() => recordExecutionProgress(f.storage, attempt.executionRunId, { ...progress, rawCommand: "private-command-fixture" } as never)).toThrow();
    now -= 7_000;
    expect(() => recordExecutionProgress(f.storage, attempt.executionRunId, progress)).toThrow();
    f.reopen();
    expect(readExecutionProgress(f.storage, attempt.executionRunId)).toEqual(latest);
    const sql = new DatabaseSync(f.databasePath);
    try { sql.prepare("UPDATE execution_run_progress SET payload=? WHERE execution_run_id=?").run("malformed-display-fixture", attempt.executionRunId); }
    finally { sql.close(); }
    expect(() => readExecutionProgress(f.storage, attempt.executionRunId)).toThrow();
    expect(new BigTaskExecutionStore(f.storage).inspect(f.approval.bigTaskId)).toMatchObject({ knownTokens: 0, activeRoleCount: 1,
      unknownCompletedUsage: false, activeRole: { progress: null, usageState: "IN_PROGRESS" } });
  } finally { f.close(); }
}, 15_000); // Includes real Git fixture setup; progress timing remains injected above.
