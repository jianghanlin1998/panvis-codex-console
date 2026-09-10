import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { BigTaskExecutionStatusSchema } from "@codex-task-console/domain";
import { makeExecutionFixture } from "./big-task-execution-fixture.js";
import { BigTaskExecutionStore } from "../src/big-task-execution.js";
import { getGovernedProviderBridge } from "../src/governed-execution-public.js";
import { executionPlanIssues } from "../src/execution-plan-readiness.js";

describe("durable human execution authority", () => {
  it("binds approval to the reviewed plan, source and exact limits without target writes", () => {
    const f = makeExecutionFixture();
    try {
      const refs = f.git(["show-ref"]).toString();
      for (const patch of [{ planDigest: "a".repeat(64) }, { repositoryHeadSha: "a".repeat(40) }, { forged: true }]) {
        expect(() => f.execution.approve({ ...f.approval, ...patch })).toThrow();
      }
      const approved = f.execution.approve(f.approval);
      expect(f.execution.approve(f.approval)).toEqual(approved);
      expect(BigTaskExecutionStatusSchema.safeParse(approved).success).toBe(true);
      expect(() => f.execution.approve({ ...f.approval, limits: { ...f.approval.limits, totalTokenLimit: 2_000 } })).toThrow();
      expect(() => f.execution.accept(f.approval.bigTaskId, f.approval.repositoryHeadSha)).toThrow();
      expect(f.storage.listSubtasksByBigTask(f.approval.bigTaskId)).toEqual([]);
      expect(f.git(["show-ref"]).toString()).toBe(refs);
      f.reopen();
      expect(new BigTaskExecutionStore(f.storage).inspect(f.approval.bigTaskId)).toEqual(approved);
    } finally { f.close(); }
  });

  it("rejects impossible dependency profiles before target execution", () => {
    const f = makeExecutionFixture();
    try {
      const candidate = f.execution.review(f.approval.bigTaskId).candidate;
      expect(executionPlanIssues(candidate)).toEqual([]);
      expect(executionPlanIssues({ ...candidate, subtasks: candidate.subtasks.map(task => ({ ...task, profile: "STANDARD" })) })).toEqual([
        { code: "DEPENDENCY_PROFILE_CONFLICT", subtaskId: candidate.dependencies[0]!.upstreamSubtaskId },
      ]);
    } finally { f.close(); }
  });

  it("keeps approval and events append-only and rejects a missing integrity guard", () => {
    const f = makeExecutionFixture();
    let sqlite: DatabaseSync | undefined;
    try {
      f.execution.approve(f.approval); f.execution.start(f.approval.bigTaskId);
      sqlite = new DatabaseSync(f.databasePath);
      for (const table of ["big_task_execution_approvals", "big_task_execution_events"]) {
        expect(() => sqlite!.exec(`UPDATE ${table} SET payload = '{}'`)).toThrow();
        expect(() => sqlite!.exec(`DELETE FROM ${table}`)).toThrow();
      }
      expect(() => sqlite!.prepare("INSERT INTO big_task_execution_events VALUES (?, 3, '{}')").run(f.approval.bigTaskId)).toThrow();
      sqlite.exec("DROP TRIGGER big_task_execution_event_order");
      expect(() => new BigTaskExecutionStore(f.storage)).toThrow();
    } finally { sqlite?.close(); f.close(); }
  });

  it("resumes only safe checkpoints after restart, retaining the original deadline", () => {
    const f = makeExecutionFixture();
    try {
      f.execution.approve(f.approval); const started = f.execution.start(f.approval.bigTaskId).status;
      f.reopen();
      const execution = new BigTaskExecutionStore(f.storage);
      execution.recoverInterrupted();
      expect(execution.inspect(f.approval.bigTaskId)).toMatchObject({ phase: "PAUSED", stopReason: "CHECKPOINT_RECOVERED", roleCalls: 0 });
      const resumed = execution.start(f.approval.bigTaskId);
      expect(resumed.claimed).toBe(true);
      expect(resumed.status.expiresAt).toBe(started.expiresAt);
      expect(execution.start(f.approval.bigTaskId).claimed).toBe(false);
    } finally { f.close(); }
  });

  describe("uncertain reservation recovery", () => {
    let f: ReturnType<typeof makeExecutionFixture>;
    beforeEach(() => { f = makeExecutionFixture(); });
    afterEach(() => { f.close(); });
  it("retains an uncertain provider reservation after restart without replaying it", () => {

      f.execution.approve(f.approval); f.execution.start(f.approval.bigTaskId);
      const prepared = f.governed.prepareNextRole(f.approval.bigTaskId);
      if (prepared.kind !== "ROLE_AUTHORIZED") throw new Error("Expected role");
      getGovernedProviderBridge(f.governed).reserveRoleExecutionAttempt(prepared.authorization.authorizationId);
      expect(f.execution.inspect(f.approval.bigTaskId)).toMatchObject({ usageComplete: false, activeRoleCount: 1, knownTokens: 0 });
      f.reopen(); const execution = new BigTaskExecutionStore(f.storage); execution.recoverInterrupted();
      expect(execution.inspect(f.approval.bigTaskId)).toMatchObject({ phase: "HUMAN_REQUIRED", stopReason: "INTERRUPTED", roleCalls: 1 });
      expect(() => execution.start(f.approval.bigTaskId)).toThrow();
      expect(f.starts).toEqual([]);

  });
  });

  it("does not renew elapsed time by pausing or restarting", () => {
    let now = Date.parse("2026-09-07T00:00:00.000Z");
    const f = makeExecutionFixture(() => new Date(now++));
    try {
      f.execution.approve({ ...f.approval, limits: { ...f.approval.limits, durationMilliseconds: 1000 } });
      const started = f.execution.start(f.approval.bigTaskId).status;
      f.execution.stop(f.approval.bigTaskId, "USER_PAUSED");
      now = Date.parse(started.expiresAt!);
      expect(() => f.execution.start(f.approval.bigTaskId)).toThrow();
      expect(f.execution.inspect(f.approval.bigTaskId).roleCalls).toBe(0);
    } finally { f.close(); }
  });
});
