import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ProviderModelReferenceSchema, ProviderRunReferenceSchema, ProviderThreadReferenceSchema } from "@codex-task-console/domain";
import { makeExecutionFixture } from "../../storage/test/big-task-execution-fixture.js";
import { ConsoleWorkspaceStore } from "../../storage/src/console-workspace.js";
import { ConsoleApplication } from "../src/console-application.js";
import { createLocalControlServiceForTesting } from "../src/service.js";
import type { LocalControlService } from "../src/service.js";

type ExecutionStatus = Awaited<ReturnType<NonNullable<LocalControlService["inspectExecution"]>>>;
const forbidden = async (): Promise<never> => { throw new Error("No unexpected provider"); };
const nextCoordinatorTurn = () => new Promise<void>(resolve => setImmediate(() => setImmediate(resolve)));

describe("Console lifecycle and candidate context continuity", () => {
  it("saves an active role at its pause boundary and resumes without repeating the role", async () => {
    let gate!: string;
    let started!: () => void;
    const providerStarted = new Promise<void>(resolve => { started = resolve; });
    const f = makeExecutionFixture(undefined, undefined, "HIGH_RISK_FOUNDATION", {
      firstRoleGate: root => gate = join(root, "release-provider"),
      onProviderRunStarted: () => started(),
    });
    let reportProgress = (): void => {};
    let observing = true;
    let signal: AbortSignal | undefined;
    const executeObserved: typeof f.execute = async (...args) => {
      signal = args[2];
      try { return await f.execute(...args); } finally { reportProgress(); }
    };
    const service = createLocalControlServiceForTesting(f.storage, f.manager, forbidden, executeObserved, forbidden, f.governed);
    const ui = new ConsoleApplication(f.storage, service, { discuss: forbidden });
    const scope = { kind: "BIG_TASK", id: f.approval.bigTaskId } as const;
    const untilStopped = () => new Promise<ExecutionStatus>((resolve, reject) => {
      reportProgress = () => { setImmediate(() => setImmediate(() => {
        if (!observing) return;
        void service.inspectExecution!(scope.id).then(state => { if (state.phase !== "RUNNING") resolve(state); }, reject);
      })); };
    });
    try {
      await service.approveExecution!(f.approval);
      const firstStop = untilStopped();
      const original = await service.startExecution!(scope.id);
      await providerStarted;
      await ui.request("lifecycle-change", { requestId: "pause-live-role", scope, expectedRevision: 0, lifecycle: "PAUSED" });
      expect(await service.inspectExecution!(scope.id)).toMatchObject({ phase: "RUNNING", activeRoleCount: 1, roleCalls: 1 });
      expect(ui.store.lifecycle(scope)).toBe("PAUSED");
      expect(signal?.aborted).toBe(false);
      expect(f.starts).toHaveLength(1);
      expect(f.outcomes).toHaveLength(0);
      // Cancel a pending pause while the same provider is still running; never start a duplicate.
      await ui.request("lifecycle-change", { requestId: "cancel-pending-pause", scope, expectedRevision: 1, lifecycle: "ACTIVE" });
      expect(ui.store.lifecycle(scope)).toBe("ACTIVE");
      expect(await service.inspectExecution!(scope.id)).toMatchObject({ phase: "RUNNING", activeRoleCount: 1, roleCalls: 1 });
      expect(signal?.aborted).toBe(false); expect(f.starts).toHaveLength(1);
      await ui.request("lifecycle-change", { requestId: "pause-again", scope, expectedRevision: 2, lifecycle: "PAUSED" });
      // The real mock process waits after turn/start until this explicit release.
      writeFileSync(gate, "continue", { encoding: "utf8" });
      expect(await firstStop).toMatchObject({ phase: "PAUSED", stopReason: "USER_PAUSED", activeRoleCount: 0, knownTokens: 18, roleCalls: 1 });
      expect(f.starts).toHaveLength(1);
      expect(f.outcomes).toEqual([{ code: null, success: true }]);
      const completed = untilStopped();
      await ui.request("lifecycle-change", { requestId: "resume-live-role", scope, expectedRevision: 3, lifecycle: "ACTIVE" });
      reportProgress();
      expect(await completed).toMatchObject({ phase: "AWAITING_ACCEPTANCE", roleCalls: 6, knownTokens: 108, expiresAt: original.expiresAt });
      expect(f.starts).toHaveLength(6);
      expect(new Set(f.starts).size).toBe(6);
    } finally {
      observing = false;
      writeFileSync(gate, "cleanup", { encoding: "utf8" });
      try { await service.stopAndDrain!(); await ui.stop(); } finally { f.close(); }
    }
  }, 60_000);

  it("resumes a paused candidate upstream without calling providers while the graph is paused", async () => {
    const f = makeExecutionFixture();
    const service = createLocalControlServiceForTesting(f.storage, f.manager, forbidden, f.execute, forbidden, f.governed);
    const ui = new ConsoleApplication(f.storage, service, { discuss: forbidden });
    try {
      const first = f.storage.getDurablePlanningReviewBundle(f.approval.bigTaskId)!.reviewState.candidate.subtasks[0]!;
      const scope = { kind: "SUBTASK", id: first.id } as const;
      expect(f.storage.getSubtaskById(first.id)).toBeNull();
      await ui.request("lifecycle-change", { requestId: "pause-candidate-qa", scope, expectedRevision: 0, lifecycle: "PAUSED" });
      await service.approveExecution!(f.approval);
      await service.startExecution!(f.approval.bigTaskId);
      await nextCoordinatorTurn();
      expect(await service.inspectExecution!(f.approval.bigTaskId)).toMatchObject({ phase: "PAUSED", stopReason: "USER_PAUSED", roleCalls: 0 });
      expect(f.starts).toHaveLength(0);
      await ui.request("lifecycle-change", { requestId: "resume-candidate-qa", scope, expectedRevision: 1, lifecycle: "ACTIVE" });
      await nextCoordinatorTurn();
      expect((await service.inspectExecution!(f.approval.bigTaskId)).phase).toBe("RUNNING");
      expect(f.starts).toHaveLength(1);
    } finally {
      try { await service.stopAndDrain!(); await ui.stop(); } finally { f.close(); }
    }
  }, 20_000);

  it("retains the original candidate chat through two new planning versions", () => {
    const f = makeExecutionFixture();
    const store = new ConsoleWorkspaceStore(f.storage);
    try {
      const original = f.storage.getDurablePlanningReviewBundle(f.approval.bigTaskId)!.taskContracts[0]!;
      const originalScope = { kind: "SUBTASK", id: original.subtaskId } as const;
      const message = "Keep the original candidate instruction.";
      const claim = store.claimDiscussion({ requestId: "original-child-chat", scope: originalScope, message });
      store.finishDiscussion(claim.turn.id, { reply: "Recorded", proposal: null, actions: [] }, { totalTokens: 1 }, null);
      let current = f.approval.bigTaskId;
      let currentChild = original.subtaskId;
      for (let revision = 1; revision <= 2; revision++) {
        current = store.prepareAgain(current, `repeat-planning-${revision}`).bigTaskId;
        const run = f.planning.claim(current);
        const threadId = `lineage-thread-${revision}`;
        f.planning.observe(current, run.sequence, {
          providerThread: ProviderThreadReferenceSchema.parse({ providerId: "codex-app-server", providerThreadId: threadId }),
          providerRun: ProviderRunReferenceSchema.parse({ providerId: "codex-app-server", providerThreadId: threadId, providerRunId: `lineage-turn-${revision}` }),
          model: ProviderModelReferenceSchema.parse({ providerId: "codex-app-server", providerModelId: "fixture" }), normalizedUsage: { totalTokens: 100 },
        });
        expect(f.planning.finish(current, run.sequence, true, JSON.stringify(f.proposal)).phase).toBe("APPROVED");
        currentChild = f.storage.getDurablePlanningReviewBundle(current)!.taskContracts.find(task => task.title === original.title)!.subtaskId;
        expect(store.relatedScopes({ kind: "SUBTASK", id: currentChild })).toContainEqual(originalScope);
      }
      expect(JSON.stringify(store.roleContext({ kind: "SUBTASK", id: currentChild }))).toContain(message);
      expect(store.turns(originalScope).turns[0]?.message).toBe(message);
    } finally { f.close(); }
  }, 15_000);
});
