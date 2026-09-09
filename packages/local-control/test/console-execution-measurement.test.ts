import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeExecutionFixture } from "../../storage/test/big-task-execution-fixture.js";
import { BigTaskExecutionStore } from "../../storage/src/big-task-execution.js";
import { createGovernedExecutionStoreForTest } from "../../storage/src/governed-execution-public.js";
import { createWorktreeOwnershipManagerForTesting } from "../../storage/src/worktree-ownership.js";
import { createLocalControlServiceForTesting } from "../src/service.js";
import type { LocalControlService } from "../src/service.js";

type ExecutionStatus = Awaited<ReturnType<NonNullable<LocalControlService["inspectExecution"]>>>;
const forbidden = async (): Promise<never> => { throw new Error("No standalone or planning provider calls"); };
const cases = [
  { label: "MEASURE exceeds its reference budget", mode: "MEASURE", scenario: "budget-exceeded", succeeds: true },
  { label: "MEASURE retains successful results with unknown usage", mode: "MEASURE", scenario: "missing-usage", succeeds: true },
  { label: "HARD stops at its token budget", mode: "HARD", scenario: "budget-exceeded", succeeds: false },
  { label: "HARD stops when usage is unknown", mode: "HARD", scenario: "missing-usage", succeeds: false },
  { label: "historical approval stops at its token budget", mode: undefined, scenario: "budget-exceeded", succeeds: false },
  { label: "historical approval stops when usage is unknown", mode: undefined, scenario: "missing-usage", succeeds: false },
  { label: "MEASURE preserves an actual provider failure", mode: "MEASURE", scenario: "connection-failed", succeeds: false },
] as const;

describe("Console execution measurement and historical limits", () => {
  it.each(cases)("$label", async testcase => {
    const f = makeExecutionFixture(undefined, () => testcase.scenario, "HIGH_RISK_FOUNDATION", testcase.mode === undefined ? {} : {
      consoleWorkflow: { planReview: "INDEPENDENT", budgetMode: testcase.mode, planningTokenLimit: 120_000,
        executionTokenLimit: 1_000, durationMinutes: 180 },
    });
    let observing = true;
    let drained = false;
    let reportProgress = (): void => {};
    const executeObserved: typeof f.execute = async (...args) => {
      try { return await f.execute(...args); } finally { reportProgress(); }
    };
    const service = createLocalControlServiceForTesting(f.storage, f.manager, forbidden, executeObserved, forbidden, f.governed);
    try {
      const completion = new Promise<ExecutionStatus>((resolve, reject) => {
        // Inspect after a provider completion and the coordinator's continuation,
        // instead of continuously reading SQLite while its child is running.
        reportProgress = () => { setImmediate(() => setImmediate(() => {
          if (!observing) return;
          void service.inspectExecution!(f.approval.bigTaskId).then(state => {
            if (state.phase !== "RUNNING") { observing = false; resolve(state); }
          }, reject);
        })); };
      });
      await service.approveExecution!({ ...f.approval, limits: { ...f.approval.limits, totalTokenLimit: 1_000,
        ...(testcase.mode === undefined ? {} : { budgetMode: testcase.mode }) } });
      await service.startExecution!(f.approval.bigTaskId);
      reportProgress();
      const state = await completion;
      expect(state.phase).toBe(testcase.succeeds ? "AWAITING_ACCEPTANCE" : "HUMAN_REQUIRED");
      expect(state.roleCalls).toBe(testcase.succeeds ? 6 : 1);
      expect(f.starts).toHaveLength(testcase.succeeds ? 6 : 1);
      expect(new Set(f.starts).size).toBe(f.starts.length);
      if (testcase.succeeds) {
        expect(f.outcomes.every(outcome => outcome.success)).toBe(true);
        expect(state.integratedSubtaskIds).toHaveLength(2);
        if (testcase.scenario === "missing-usage") {
          expect(state).toMatchObject({ knownTokens: 0, unknownCompletedUsage: true,
            unacknowledgedUnknownUsage: false, usageComplete: false });
        } else {
          expect(state.knownTokens).toBeGreaterThan(state.limits.totalTokenLimit);
        }
      } else {
        expect(state.integratedSubtaskIds).toHaveLength(0);
        expect(f.outcomes[0]?.success).toBe(false);
        if (testcase.scenario === "missing-usage") expect(state.stopReason).toBe("USAGE_UNKNOWN");
        else if (testcase.scenario === "budget-exceeded") expect(state.stopReason).toBe("TOKEN_LIMIT_REACHED");
        else {
          expect(state.stopReason).toBe("GOVERNED_BLOCKED");
          expect(f.outcomes[0]).toEqual({ success: false, code: "TURN_FAILED" });
        }
      }
      await service.stopAndDrain!();
      drained = true;
      f.reopen();
      expect(new BigTaskExecutionStore(f.storage).inspect(f.approval.bigTaskId)).toEqual(state);
      const manager = createWorktreeOwnershipManagerForTesting(f.storage, {
        worktreeRoot: join(f.root, "worktrees"), idGenerator: () => `wt_${"f".repeat(32)}`,
      });
      const replay = createGovernedExecutionStoreForTest(f.storage, manager);
      expect(() => replay.inspectBigTask(f.approval.bigTaskId)).not.toThrow();
    } finally {
      observing = false;
      try { if (!drained) await service.stopAndDrain!(); } finally { f.close(); }
    }
    // Real temporary Git plus six mock processes; all business time uses the fixture clock.
  }, 60_000);
});
