import { describe, expect, it, vi } from "vitest";
import { ProviderThreadReferenceSchema, ProviderRunReferenceSchema, ProviderModelReferenceSchema, BigTaskIdSchema, ConsoleDiscussionAnswerSchema, ConsoleDiscussionInputSchema } from "@codex-task-console/domain";
import { ConsoleWorkspaceStore } from "../../storage/src/console-workspace.js";
import { makePlanningFixture, sizedPlanningProposal } from "../../storage/test/live-planning-fixture.js";
import { makeExecutionFixture } from "../../storage/test/big-task-execution-fixture.js";
import { ConsoleApplication } from "../src/console-application.js";
import type { LocalControlService } from "../src/service.js";
import type { executeConsoleDiscussionCodex } from "@codex-task-console/codex-adapter";

const forbidden = async (): Promise<never> => { throw new Error("No live model or unauthorized execution"); };
const base: LocalControlService = { inspectSubtask: forbidden, provisionOwnedWorktree: forbidden, runOwnedWorktreeExecution: forbidden, releaseOwnedWorktree: forbidden };
const settle = async (predicate: () => boolean) => { for (let n = 0; n < 200 && !predicate(); n++) await Promise.resolve(); expect(predicate()).toBe(true); };
const model = (scope: object, kind = "ADVANCE_TASK") => vi.fn<typeof executeConsoleDiscussionCodex>(async () => ({ success: true, agentResponseText: JSON.stringify({ reply: "处理当前任务", proposal: null, actions: [{ kind, scope }] }), normalizedUsage: { totalTokens: 1 }, failureCode: null } as Awaited<ReturnType<typeof executeConsoleDiscussionCodex>>));

describe("Task chat and retry share actual workflow operations", () => {
  it("prepares a plan with retained contracts above the old 24 KB limit and deduplicates repeat clicks", async () => {
    const f = makePlanningFixture();
    const runPlanning = vi.fn(async (id: Parameters<NonNullable<LocalControlService["runPlanning"]>>[0]) => { f.planning.claim(id); return f.planning.inspect(id); });
    const ui = new ConsoleApplication(f.storage, { ...base, runPlanning }, { discuss: forbidden });
    try {
      f.planning.accept(f.intake);
      const claim = f.planning.claim(f.intake.bigTask.id);
      f.planning.observe(f.intake.bigTask.id, claim.sequence, { providerThread: ProviderThreadReferenceSchema.parse({ providerId: "codex-app-server", providerThreadId: "retry-fixture" }), providerRun: ProviderRunReferenceSchema.parse({ providerId: "codex-app-server", providerThreadId: "retry-fixture", providerRunId: "retry-turn" }), model: ProviderModelReferenceSchema.parse({ providerId: "codex-app-server", providerModelId: "fixture" }), normalizedUsage: { totalTokens: 1 } });
      f.planning.finish(f.intake.bigTask.id, claim.sequence, true, JSON.stringify(sizedPlanningProposal(102400)));
      const before = f.storage.getDurablePlanningReviewBundle(f.intake.bigTask.id)!;
      const result = await ui.request("planning-retry", { bigTaskId: f.intake.bigTask.id, requestId: "retry-large-plan" }) as { bigTaskId: string };
      expect(await ui.request("planning-retry", { bigTaskId: f.intake.bigTask.id, requestId: "retry-second-click" })).toEqual(result);
      expect(f.planning.readIntake(BigTaskIdSchema.parse(result.bigTaskId)).intake.suggestedSubtasks?.map(task => task.goal)).toEqual(before.taskContracts.map(task => task.goal));
      expect(f.storage.listBigTasksByProject(f.intake.bigTask.projectId)).toHaveLength(2);
      expect(runPlanning).toHaveBeenCalledTimes(1);
    } finally { await ui.stop(); f.close(); }
  });
  it("starts planning from big-task chat and saves an actionable result without starting implementation", async () => {
    const f = makePlanningFixture();
    const scope = { kind: "BIG_TASK", id: f.intake.bigTask.id } as const;
    const runPlanning = vi.fn(async () => f.planning.inspect(f.intake.bigTask.id));
    const approveExecution = vi.fn(forbidden), startExecution = vi.fn(forbidden);
    const ui = new ConsoleApplication(f.storage, { ...base, inspectPlanning: async id => f.planning.inspect(id), runPlanning, approveExecution, startExecution }, { discuss: model(scope) });
    try {
      f.planning.accept(f.intake);
      await ui.request("discuss", { requestId: "advance-from-chat", scope, message: "继续推进这个任务" });
      await settle(() => ui.store.turns(scope).turns[0]?.effects?.[0]?.kind === "TASK_ADVANCED");
      expect(runPlanning).toHaveBeenCalledTimes(1);
      expect(startExecution).not.toHaveBeenCalled(); expect(approveExecution).not.toHaveBeenCalled();
      expect(ui.store.listDrafts(f.intake.bigTask.projectId)).toHaveLength(0);
    } finally { await ui.stop(); f.close(); }
  });
  it("gives candidate-subtask chat a current plan confirmation entry and preserves its context", async () => {
    const f = makeExecutionFixture();
    const store = new ConsoleWorkspaceStore(f.storage);
    const child = f.storage.getDurablePlanningReviewBundle(f.approval.bigTaskId)!.taskContracts[0]!;
    const scope = { kind: "SUBTASK", id: child.subtaskId } as const;
    const ui = new ConsoleApplication(f.storage, { ...base, inspectPlanning: async id => f.planning.inspect(id) }, { discuss: model(scope) });
    try {
      await ui.request("discuss", { requestId: "advance-candidate", scope, message: "开始这个小任务" });
      await settle(() => store.turns(scope).turns[0]?.effects?.[0]?.kind === "EXECUTION_CONFIRMATION_REQUIRED");
      expect(store.turns(scope).turns[0]?.effects?.[0]?.targetId).toBe(f.approval.bigTaskId);
      expect(store.taskPresence(f.approval.bigTaskId).execution).toBe(false);
      expect(store.turns(scope).turns[0]?.message).toBe("开始这个小任务");
    } finally { await ui.stop(); f.close(); }
  });
  it("pauses from chat without reopening an ended task and reports a failed action honestly", async () => {
    const f = makePlanningFixture();
    const scope = { kind: "BIG_TASK", id: f.intake.bigTask.id } as const;
    const ui = new ConsoleApplication(f.storage, base, { discuss: model(scope, "PAUSE_TASK") });
    try {
      f.planning.accept(f.intake);
      await ui.request("discuss", { requestId: "pause-from-chat", scope, message: "暂停这个任务" });
      await settle(() => ui.store.turns(scope).turns[0]?.effects?.[0]?.kind === "TASK_PAUSED");
      expect(ui.store.lifecycle(scope)).toBe("PAUSED");
      ui.store.changeSettings({ requestId: "end-this-task", scope, expectedRevision: 1, lifecycle: "ENDED" });
      await ui.request("discuss", { requestId: "pause-ended-chat", scope, message: "暂停" });
      await settle(() => ui.store.turns(scope).turns.at(-1)?.effects?.[0]?.kind === "TASK_ACTION_FAILED");
      expect(ui.store.lifecycle(scope)).toBe("ENDED");
    } finally { await ui.stop(); f.close(); }
  });
  it("rejects a child chat trying to advance its sibling", () => {
    const f = makeExecutionFixture();
    try {
      const store = new ConsoleWorkspaceStore(f.storage), children = f.storage.getDurablePlanningReviewBundle(f.approval.bigTaskId)!.taskContracts;
      const scope = { kind: "SUBTASK", id: children[0]!.subtaskId } as const;
      const claim = store.claimDiscussion({ requestId: "wrong-child-target", scope, message: "继续我的任务" });
      const result = store.finishDiscussion(claim.turn.id, { reply: "Continue", proposal: null, actions: [{ kind: "ADVANCE_TASK", scope: { kind: "BIG_TASK", id: f.approval.bigTaskId } }] }, { totalTokens: 1 }, null);
      expect(result).toMatchObject({ status: "FAILED", failureCode: "ACTION_CONFLICT", effects: [] });
    } finally { f.close(); }
  });
  it("accepts large discussion/context text and retains it after reopen", () => {
    const f = makePlanningFixture();
    const scope = { kind: "PROJECT", id: f.intake.bigTask.projectId } as const;
    try {
      const message = "x".repeat(1024 * 1024);
      expect(ConsoleDiscussionInputSchema.safeParse({ requestId: "over-text-input", scope, message: message + "x" }).success).toBe(false);
      expect(ConsoleDiscussionInputSchema.safeParse({ requestId: "unicode-text-input", scope, message: "中".repeat(349526) }).success).toBe(false);
      expect(ConsoleDiscussionInputSchema.safeParse({ requestId: "large-text-input", scope, message }).success).toBe(true);
      const store = new ConsoleWorkspaceStore(f.storage);
      const claim = store.claimDiscussion({ requestId: "large-text-input", scope, message });
      const answer = { reply: "x".repeat(100000), proposal: null, actions: [] };
      expect(ConsoleDiscussionAnswerSchema.safeParse(answer).success).toBe(true);
      store.finishDiscussion(claim.turn.id, answer, { totalTokens: 1 }, null);
      store.confirmContext({ requestId: "large-human-note", scope, title: "Long requirement", body: message });
      f.reopen();
      const reopened = new ConsoleWorkspaceStore(f.storage);
      expect(reopened.turns(scope).turns[0]?.message).toBe(message);
      expect(reopened.context(scope).notes).toContainEqual(expect.objectContaining({ body: message }));
    } finally { f.close(); }
  });
});
