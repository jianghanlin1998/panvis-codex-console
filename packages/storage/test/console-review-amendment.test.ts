import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BigTaskIdSchema, ProviderModelReferenceSchema, ProviderRunReferenceSchema, ProviderThreadReferenceSchema,
} from "@codex-task-console/domain";
import type { BigTaskId, BigTaskPlanningIntake, ConsoleReviewLevel } from "@codex-task-console/domain";
import { approvedRepairCycleLimit, BigTaskExecutionStore } from "../src/big-task-execution.js";
import { ConsoleWorkspaceStore } from "../src/console-workspace.js";
import { getTaskStorageWorktreeAccess } from "../src/task-storage-internals.js";
import { createWorktreeOwnershipManagerForTesting } from "../src/worktree-ownership.js";
import { createGovernedExecutionStoreForTest } from "../src/governed-execution-public.js";
import { executeGovernedRoleCodexWithDependenciesForTest } from "../../codex-adapter/src/live-execution.js";
import { validateOwnedWorktreeHardlinkSafety } from "../../codex-adapter/src/worktree-filesystem-safety.js";
import { planningProviderFixture } from "../../codex-adapter/test/planning-provider-fixture.js";
import { makePlanningFixture } from "./live-planning-fixture.js";
import { makeExecutionFixture } from "./big-task-execution-fixture.js";
import { FIXED_TIME } from "./fixtures.js";

const fixture = (options: Partial<BigTaskPlanningIntake> = {}, clock?: () => Date) => {
  const f = makePlanningFixture(clock);
  f.git(["update-ref", "refs/remotes/origin/main", f.git(["rev-parse", "HEAD"]).toString().trim()]);
  f.git(["config", "branch.main.remote", "origin"]);
  f.git(["config", "branch.main.merge", "refs/heads/main"]);
  f.planning.accept({ ...f.intake, consoleReviewPolicy: true, ...options });
  const finish = (id: BigTaskId, output: unknown, tokens: number | null = 100) => {
    const run = f.planning.claim(id);
    const threadId = `qa-${id}-${run.sequence}`;
    f.planning.observe(id, run.sequence, {
      providerThread: ProviderThreadReferenceSchema.parse({ providerId: "codex-app-server", providerThreadId: threadId }),
      providerRun: ProviderRunReferenceSchema.parse({ providerId: "codex-app-server", providerThreadId: threadId, providerRunId: `turn-${run.sequence}` }),
      model: ProviderModelReferenceSchema.parse({ providerId: "codex-app-server", providerModelId: "deterministic-fixture" }),
      normalizedUsage: tokens === null ? null : { totalTokens: tokens },
    });
    return f.planning.finish(id, run.sequence, true, JSON.stringify(output));
  };
  const review = (id: BigTaskId, outcome: "APPROVE" | "REJECT" = "APPROVE", tokens: number | null = 100) => {
    const bundle = f.storage.getDurablePlanningReviewBundle(id)!;
    return finish(id, { outcome, planRevision: bundle.reviewState.candidate.revision,
      candidateBinding: createHash("sha256").update(bundle.candidateBinding, "utf8").digest("hex"),
      revisionRequirements: outcome === "REJECT" ? ["Clarify the task titles and retain all agreed scope."] : [], questions: [] }, tokens);
  };
  const amendment = (id: BigTaskId, requestId: string, reviewLevel: ConsoleReviewLevel = "LIGHT") => ({
    requestId, bigTaskId: id, expectedBinding: new ConsoleWorkspaceStore(f.storage).planningBinding(id),
    changes: [{ subtaskId: f.storage.getDurablePlanningReviewBundle(id)!.reviewState.candidate.subtasks[0]!.id, reviewLevel }],
  });
  const approval = (id: BigTaskId, repairCycleLimit: 1 | 2 = 2) => {
    const result = new BigTaskExecutionStore(f.storage).review(id);
    return { bigTaskId: id, planDigest: result.planDigest, repositoryHeadSha: result.repositoryHeadSha,
      limits: { durationMilliseconds: 10_800_000, totalTokenLimit: 120_000, roleCallLimit: 16, repairCycleLimit } };
  };
  return { ...f, finish, review, amendment, approval,
    get storage() { return f.storage; }, get planning() { return f.planning; },
    get ui() { return new ConsoleWorkspaceStore(f.storage); },
    get sql() { return getTaskStorageWorktreeAccess(f.storage)!.sqlite; },
  };
};

const executionFixture = (reviewIntensity: ConsoleReviewLevel) => {
  let instant = Date.parse(FIXED_TIME);
  const f = fixture({ reviewIntensity }, () => new Date(instant++));
  const id = f.intake.bigTask.id;
  f.finish(id, f.proposal); f.review(id);
  const execution = new BigTaskExecutionStore(f.storage);
  execution.approve(f.approval(id)); execution.start(id);
  let worktreeSequence = 0;
  const manager = createWorktreeOwnershipManagerForTesting(f.storage, {
    worktreeRoot: join(f.root, "worktrees"), idGenerator: () => `wt_${(++worktreeSequence).toString(16).padStart(32, "0")}`,
  });
  const governed = createGovernedExecutionStoreForTest(f.storage, manager);
  const provider = planningProviderFixture(() => f.proposal);
  const execute = async (authorizationId: string, scenario?: string) => {
    const authorization = governed.getRoleAuthorization(authorizationId)!;
    return executeGovernedRoleCodexWithDependenciesForTest(governed, authorizationId, {
      ...provider.dependencies, checkCompatibility: () => true, validateWorktreeFilesystem: validateOwnedWorktreeHardlinkSafety,
      generateChatThreadId: () => { throw new Error("Governed storage owns identifiers"); },
      generateExecutionRunId: () => { throw new Error("Governed storage owns identifiers"); },
      resolveOwnedWorktree: () => { throw new Error("Governed storage owns worktrees"); },
      createWorkspace: () => { const path = mkdtempSync(join(realpathSync(tmpdir()), "ctc-console-policy-mock-")); chmodSync(path, 0o700); return path; },
      removeWorkspace: path => rmSync(path, { recursive: true, force: true }),
      spawnAppServer: (_file, _args, options) => spawn(process.execPath,
        [fileURLToPath(new URL("../../../fixtures/mock-governed-app-server.ts", import.meta.url)), `--role=${authorization.role}`,
          `--occurrence=${authorizationId}`, "--write-candidate", ...(scenario ? [`--scenario=${scenario}`] : []),
          ...(authorization.writeEnabled ? [] : ["--readonly-role"])], options),
    });
  };
  return { ...f, execute, governed, execution, get storage() { return f.storage; } };
};

describe("Console frozen review policies and human planning amendments", () => {
  it.each([
    ["LIGHT", "LOW", "VERIFIED", 1],
    ["STANDARD", "STANDARD", "ACCEPTED", 1],
    ["THOROUGH", "HIGH_RISK_FOUNDATION", "ACCEPTED", 2],
  ] as const)("freezes %s independently of model choice and later mutable settings", (level, profile, gate, repairs) => {
    const f = fixture({ reviewIntensity: level });
    try {
      const id = f.intake.bigTask.id;
      const proposal = { ...f.proposal, tasks: f.proposal.tasks.map(task => ({ ...task, profile: "STANDARD" })) };
      expect(f.finish(id, proposal).phase).toBe("READY");
      const frozen = f.storage.getDurablePlanningReviewBundle(id)!;
      expect(frozen.reviewState.candidate.subtasks.map(task => task.profile)).toEqual([profile, profile]);
      expect(frozen.reviewState.candidate.dependencies[0]!.requiredGate).toBe(gate);
      f.ui.changeSettings({ requestId: "late-project-default", scope: { kind: "PROJECT", id: f.intake.bigTask.projectId }, expectedRevision: 0, reviewLevel: level === "LIGHT" ? "THOROUGH" : "LIGHT" });
      expect(f.review(id).phase).toBe("APPROVED");
      const execution = new BigTaskExecutionStore(f.storage);
      expect(execution.review(id).executionIssues).toEqual([]);
      execution.approve(f.approval(id));
      for (const task of frozen.reviewState.candidate.subtasks) expect(approvedRepairCycleLimit(f.storage, id, task.id)).toBe(repairs);
      f.reopen();
      expect(f.storage.getDurablePlanningReviewBundle(id)!.candidateBinding).toBe(frozen.candidateBinding);
      for (const task of frozen.reviewState.candidate.subtasks) expect(approvedRepairCycleLimit(f.storage, id, task.id)).toBe(repairs);
    } finally { f.close(); }
  });

  it("preserves historical model profiles and dependency gates without the console marker", () => {
    const f = makePlanningFixture();
    try {
      f.planning.accept({ ...f.intake, reviewIntensity: "LIGHT" });
      const run = f.planning.claim(f.intake.bigTask.id);
      const providerThread = ProviderThreadReferenceSchema.parse({ providerId: "codex-app-server", providerThreadId: "legacy-profile-fixture" });
      f.planning.observe(f.intake.bigTask.id, run.sequence, { providerThread,
        providerRun: ProviderRunReferenceSchema.parse({ ...providerThread, providerRunId: "legacy-profile-run" }),
        model: ProviderModelReferenceSchema.parse({ providerId: "codex-app-server", providerModelId: "fixture" }), normalizedUsage: { totalTokens: 100 } });
      expect(f.planning.finish(f.intake.bigTask.id, run.sequence, true, JSON.stringify(f.proposal)).phase).toBe("READY");
      const plan = f.storage.getDurablePlanningReviewBundle(f.intake.bigTask.id)!.reviewState.candidate;
      expect(plan.subtasks.map(task => task.profile)).toEqual(["STANDARD", "STANDARD"]);
      expect(plan.dependencies[0]!.requiredGate).toBe("ACCEPTED");
    } finally { f.close(); }
  });

  it("retains a historical STANDARD task's explicitly approved two repairs after settings change and reopen", () => {
    const f = makeExecutionFixture(undefined, undefined, "STANDARD");
    try {
      const id = f.intake.bigTask.id;
      f.execution.approve({ ...f.approval, limits: { ...f.approval.limits, repairCycleLimit: 2 } });
      const task = f.storage.getDurablePlanningReviewBundle(id)!.reviewState.candidate.subtasks[0]!;
      new ConsoleWorkspaceStore(f.storage).changeSettings({ requestId: "legacy-new-default", scope: { kind: "BIG_TASK", id }, expectedRevision: 0, reviewLevel: "LIGHT" });
      expect(approvedRepairCycleLimit(f.storage, id, task.id)).toBe(2);
      f.reopen();
      expect(approvedRepairCycleLimit(f.storage, id, task.id)).toBe(2);
      expect(f.storage.getDurablePlanningReviewBundle(id)!.reviewState.candidate.subtasks[0]!.profile).toBe("STANDARD");
    } finally { f.close(); }
  });

  it("rebinds the entire candidate and contracts, requires fresh review, and rejects retained old approvals", () => {
    const f = fixture();
    try {
      const id = f.intake.bigTask.id;
      f.finish(id, f.proposal); f.review(id);
      const old = f.storage.getDurablePlanningReviewBundle(id)!;
      const oldApproval = f.approval(id);
      f.ui.setPresentation({ bigTaskId: id, title: "One business task", source: "qa:owner-title" });
      const request = f.amendment(id, "amend-reviewed-plan");
      const result = f.ui.amendPlanReview(request);
      const nextId = BigTaskIdSchema.parse(result.bigTaskId);
      const next = f.storage.getDurablePlanningReviewBundle(nextId)!;
      expect(nextId).not.toBe(id);
      expect(next.candidateBinding).not.toBe(old.candidateBinding);
      expect(next.reviewState).toMatchObject({ phase: "AWAITING_REVIEW", automaticRevisionsUsed: 0, candidate: { revision: 1 } });
      expect(next.reviewState.candidate.subtasks.map(task => task.profile)).toEqual(["LOW", "STANDARD"]);
      next.reviewState.candidate.subtasks.forEach((task, index) => {
        expect(task.id).not.toBe(old.reviewState.candidate.subtasks[index]!.id);
        expect(task.bigTaskId).toBe(nextId);
        expect(next.taskContracts[index]).toEqual({ ...old.taskContracts[index], bigTaskId: nextId, subtaskId: task.id, taskContractRef: task.taskContractRef });
        expect(task.taskContractRef).not.toBe(old.taskContracts[index]!.taskContractRef);
      });
      expect(next.reviewState.candidate.dependencies).toEqual([{ ...old.reviewState.candidate.dependencies[0],
        upstreamSubtaskId: next.reviewState.candidate.subtasks[0]!.id, downstreamSubtaskId: next.reviewState.candidate.subtasks[1]!.id, requiredGate: "VERIFIED" }]);
      expect(f.storage.getDurablePlanningReviewBundle(id)).toEqual(old);
      expect(f.planning.inspect(nextId)).toMatchObject({ phase: "READY", nextRole: "REVIEWER", totalTokens: 200, runs: [] });
      expect(f.ui.presentation(id).historyOf).toBe(nextId);
      expect(f.ui.presentation(nextId)).toMatchObject({ title: "One business task" });
      expect(f.sql.prepare("SELECT count(*) AS n FROM big_task_execution_approvals").get()?.n).toBe(0);
      expect(() => f.planning.claim(id)).toThrow();
      expect(() => new BigTaskExecutionStore(f.storage).approve(oldApproval)).toThrow();
      expect(() => new BigTaskExecutionStore(f.storage).review(nextId)).toThrow();
      expect(f.review(nextId).phase).toBe("APPROVED");
      expect(new BigTaskExecutionStore(f.storage).approve(f.approval(nextId)).phase).toBe("APPROVED");
      f.reopen();
      expect(f.ui.amendPlanReview(request)).toEqual(result);
      expect(f.storage.getDurablePlanningReviewBundle(id)).toEqual(old);
      expect(f.storage.listBigTasksByProject(f.intake.bigTask.projectId)).toHaveLength(2);
    } finally { f.close(); }
  });

  it("rejects stale bindings, duplicate targets, foreign subtasks and competing successor requests atomically", () => {
    const f = fixture();
    try {
      const id = f.intake.bigTask.id;
      f.finish(id, f.proposal);
      const request = f.amendment(id, "amend-identity-check");
      for (const invalid of [
        { ...request, expectedBinding: "0".repeat(32) },
        { ...request, changes: [...request.changes, ...request.changes] },
        { ...request, changes: [{ subtaskId: "st_foreign_candidate", reviewLevel: "LIGHT" }] },
      ]) expect(() => f.ui.amendPlanReview(invalid)).toThrow();
      expect(f.storage.listBigTasksByProject(f.intake.bigTask.projectId)).toHaveLength(1);
      expect(f.planning.successor(id)).toBeNull();
      const result = f.ui.amendPlanReview(request);
      expect(f.ui.amendPlanReview(structuredClone(request))).toEqual(result);
      expect(() => f.ui.amendPlanReview({ ...request, changes: [{ ...request.changes[0], reviewLevel: "THOROUGH" }] })).toThrow();
      expect(() => f.ui.amendPlanReview({ ...request, requestId: "amend-second-branch" })).toThrow();
      expect(f.storage.listBigTasksByProject(f.intake.bigTask.projectId)).toHaveLength(2);
    } finally { f.close(); }
  });

  it.each(["RUNNING_REVIEW", "EXECUTION_APPROVED"] as const)("rejects profile mutation while %s", state => {
    const f = fixture();
    try {
      const id = f.intake.bigTask.id;
      f.finish(id, f.proposal);
      if (state === "RUNNING_REVIEW") f.planning.claim(id);
      else { f.review(id); new BigTaskExecutionStore(f.storage).approve(f.approval(id)); }
      const before = f.storage.getDurablePlanningReviewBundle(id);
      expect(() => f.ui.amendPlanReview(f.amendment(id, "amend-active-authority"))).toThrow();
      expect(f.storage.getDurablePlanningReviewBundle(id)).toEqual(before);
      expect(f.planning.successor(id)).toBeNull();
      expect(f.storage.listBigTasksByProject(f.intake.bigTask.projectId)).toHaveLength(1);
    } finally { f.close(); }
  });

  it("rolls back new intake, candidate, contracts and presentation on a late persistence failure", () => {
    const f = fixture();
    try {
      const id = f.intake.bigTask.id;
      f.finish(id, f.proposal);
      const before = f.storage.getDurablePlanningReviewBundle(id);
      const request = f.amendment(id, "amend-atomic-write");
      f.sql.exec("CREATE TEMP TRIGGER qa_fail_presentation BEFORE INSERT ON console_task_presentation BEGIN SELECT RAISE(ABORT, 'Synthetic presentation failure'); END");
      expect(() => f.ui.amendPlanReview(request)).toThrow();
      expect(f.storage.getDurablePlanningReviewBundle(id)).toEqual(before);
      expect(f.planning.successor(id)).toBeNull();
      expect(f.storage.listBigTasksByProject(f.intake.bigTask.projectId)).toHaveLength(1);
      for (const table of ["live_planning_intakes", "orchestration_plan_candidates"]) expect(f.sql.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n).toBe(1);
      for (const table of ["console_task_presentation", "console_settings_changes"]) expect(f.sql.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n).toBe(0);
      f.sql.exec("DROP TRIGGER qa_fail_presentation");
      expect(f.ui.amendPlanReview(request)).toMatchObject({ previousBigTaskId: id });
    } finally { f.close(); }
  });

  it("accumulates planning usage across successive versions without spending automatic repair attempts", () => {
    const f = fixture({ planningTokenLimit: 350 });
    try {
      const first = f.intake.bigTask.id;
      f.finish(first, f.proposal); f.review(first);
      const second = BigTaskIdSchema.parse(f.ui.amendPlanReview(f.amendment(first, "amend-budget-second")).bigTaskId);
      expect(f.review(second).phase).toBe("APPROVED");
      const third = BigTaskIdSchema.parse(f.ui.amendPlanReview(f.amendment(second, "amend-budget-third", "THOROUGH")).bigTaskId);
      expect(f.planning.inspect(third)).toMatchObject({ totalTokens: 300, automaticRevisionsUsed: 0, runs: [], nextRole: "REVIEWER" });
      expect(f.review(third, "APPROVE", 60)).toMatchObject({ phase: "HUMAN_REQUIRED", stopReason: "BUDGET_BLOCKED", totalTokens: 360 });
      expect(() => f.planning.claim(third)).toThrow();
      expect(f.ui.presentation(first).historyOf).toBe(third);
      expect(f.ui.presentation(second).historyOf).toBe(third);
      f.reopen();
      expect(f.planning.inspect(third)).toMatchObject({ totalTokens: 360, stopReason: "BUDGET_BLOCKED" });
    } finally { f.close(); }
  });

  it("retains unknown predecessor usage and the original exception deadline after a new version", () => {
    let now = Date.parse(FIXED_TIME);
    const expiresAt = new Date(now + 60_000).toISOString();
    const f = fixture({ budgetException: { approved: true, mode: "MEASURE_ONLY", reason: "Fixed owner-authorized window", expiresAt } }, () => new Date(now));
    try {
      const id = f.intake.bigTask.id;
      f.finish(id, f.proposal);
      expect(f.review(id, "APPROVE", null)).toMatchObject({ stopReason: "USAGE_UNKNOWN" });
      now += 20_000;
      const next = BigTaskIdSchema.parse(f.ui.amendPlanReview(f.amendment(id, "amend-unknown-usage")).bigTaskId);
      expect(f.planning.inspect(next)).toMatchObject({ phase: "HUMAN_REQUIRED", stopReason: "USAGE_UNKNOWN", totalTokens: 100, usageComplete: false, budgetException: { expiresAt } });
      expect(f.planning.remainingTimeMs(next)).toBe(40_000);
      expect(() => f.planning.claim(next)).toThrow();
      now += 40_000;
      expect(f.planning.remainingTimeMs(next)).toBe(0);
      expect(() => f.ui.amendPlanReview(f.amendment(next, "amend-expired-window"))).toThrow();
      expect(f.planning.successor(next)).toBeNull();
    } finally { f.close(); }
  });

  it("does not silently drop an owner's selected task profile when a reviewer-requested revision changes its title", () => {
    const f = fixture();
    try {
      const id = f.intake.bigTask.id;
      f.finish(id, f.proposal);
      const next = BigTaskIdSchema.parse(f.ui.amendPlanReview(f.amendment(id, "amend-title-revision")).bigTaskId);
      expect(f.review(next, "REJECT").nextRole).toBe("PLANNER");
      const revised = { ...f.proposal, tasks: f.proposal.tasks.map((task, index) => index === 0 ? { ...task, title: "Collect source articles" } : task) };
      const status = f.finish(next, revised);
      // Rejecting an unbindable revision is safe; a silently downgraded accepted candidate is not.
      const candidate = f.storage.getDurablePlanningReviewBundle(next)!.reviewState.candidate;
      if (status.phase === "HUMAN_REQUIRED") expect(candidate.revision).toBe(1);
      else {
        expect(candidate.revision).toBe(2);
        expect(candidate.subtasks[0]!.profile).toBe("LOW");
        expect(candidate.dependencies[0]!.requiredGate).toBe("VERIFIED");
      }
    } finally { f.close(); }
  });

  it("blocks a LIGHT dependent after implementation and releases it only after trusted VERIFY completion", async () => {
    const f = executionFixture("LIGHT");
    try {
      const id = f.intake.bigTask.id;
      const tasks = f.storage.getDurablePlanningReviewBundle(id)!.reviewState.candidate.subtasks;
      for (const role of ["EXECUTE", "VERIFY"] as const) {
        const prepared = f.governed.prepareNextRole(id);
        expect(prepared).toMatchObject({ kind: "ROLE_AUTHORIZED", authorization: { role, subtaskId: tasks[0]!.id } });
        if (prepared.kind !== "ROLE_AUTHORIZED") throw new Error("Expected LIGHT role");
        expect(f.storage.evaluateStoredSubtaskDependencyReadiness(tasks[1]!.id).ready).toBe(false);
        expect((await f.execute(prepared.authorization.authorizationId)).success).toBe(true);
        expect(f.storage.getSubtaskById(tasks[0]!.id)?.maturity).toBe("IMPLEMENTED");
        expect(f.storage.evaluateStoredSubtaskDependencyReadiness(tasks[1]!.id).ready).toBe(role === "VERIFY");
      }
      expect(f.storage.getDurableWorkflowControlView(tasks[0]!.id)?.currentStage).toBe("COMPLETE");
      const downstream = f.governed.prepareNextRole(id);
      expect(downstream).toMatchObject({ kind: "ROLE_AUTHORIZED", authorization: { role: "EXECUTE", subtaskId: tasks[1]!.id } });
      expect(f.execution.inspect(id).integratedSubtaskIds).toEqual([tasks[0]!.id]);
    } finally { f.close(); }
  }, 60_000);

  it.each([
    ["STANDARD", ["EXECUTE", "FRESH_QA", "REPAIR", "FOCUSED_RE_QA"], 1],
    ["THOROUGH", ["EXECUTE", "HARDEN", "FRESH_QA", "REPAIR", "FOCUSED_RE_QA", "REPAIR", "FOCUSED_RE_QA"], 2],
  ] as const)("enforces the actual %s QA failure cap in governed execution and after reopen", async (level, roles, repairs) => {
    const f = executionFixture(level);
    try {
      const id = f.intake.bigTask.id;
      const first = f.storage.getDurablePlanningReviewBundle(id)!.reviewState.candidate.subtasks[0]!.id;
      const seen: string[] = [];
      for (const role of roles) {
        const prepared = f.governed.prepareNextRole(id);
        expect(prepared).toMatchObject({ kind: "ROLE_AUTHORIZED", authorization: { role, subtaskId: first } });
        if (prepared.kind !== "ROLE_AUTHORIZED") throw new Error("Expected reviewed role");
        seen.push(prepared.authorization.role);
        expect((await f.execute(prepared.authorization.authorizationId, role === "FRESH_QA" || role === "FOCUSED_RE_QA" ? "two-blockers" : undefined)).success).toBe(true);
        const observation = f.sql.prepare("SELECT payload FROM governed_provider_input_observations WHERE authorization_id = ?").get(prepared.authorization.authorizationId)!;
        expect(JSON.parse(String(observation.payload)).text).toContain("report concrete visual evidence");
      }
      expect(seen).toEqual(roles);
      expect(f.storage.getDurableWorkflowControlView(first)).toMatchObject({ currentStage: "FOCUSED_RE_QA", repairCyclesUsed: repairs,
        unresolvedHumanRequired: { reason: "REPAIR_REQA_EXHAUSTED" } });
      expect(f.governed.prepareNextRole(id)).toMatchObject({ kind: "HUMAN_REQUIRED", reason: "REPAIR_REQA_EXHAUSTED", subtaskId: first });
      expect(f.execution.inspect(id).roleCalls).toBe(roles.length);
      f.reopen();
      expect(f.storage.getDurableWorkflowControlView(first)).toMatchObject({ currentStage: "FOCUSED_RE_QA", repairCyclesUsed: repairs,
        unresolvedHumanRequired: { reason: "REPAIR_REQA_EXHAUSTED" } });
      expect(approvedRepairCycleLimit(f.storage, id, first)).toBe(repairs);
      expect(new BigTaskExecutionStore(f.storage).inspect(id).roleCalls).toBe(roles.length);
    } finally { f.close(); }
  }, 60_000);
});
