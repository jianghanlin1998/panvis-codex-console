import { expect, it } from "vitest";
import { BIG_TASK_ID, IntegratedOrchestrationFixture, SUBTASK_IDS } from "./integrated-orchestration-fixture.js";

it("enforces aggregate 120K pause, one exact operator +40K extension and 160K absolute ceiling", async () => {
  const f = new IntegratedOrchestrationFixture({ profiles: ["HIGH_RISK_FOUNDATION"] });
  const id = SUBTASK_IDS[0]!;
  try {
    expect(f.governed.inspectBigTask(BIG_TASK_ID).budgets[0]).toMatchObject({ status: "AVAILABLE", totalTokens: 0, extensionApplied: false });
    expect(() => f.governed.authorizeOneTimeBudgetExtension(id)).toThrow();
    await f.runRole(id, "EXECUTE", { tokens: 120_000 });
    f.reopen();
    expect(f.governed.inspectBigTask(BIG_TASK_ID).budgets[0]).toMatchObject({ status: "HARD_PAUSE", totalTokens: 120_000, allowed: false });
    const paused = f.counts();
    expect(f.governed.prepareNextRole(BIG_TASK_ID)).toMatchObject({ kind: "HUMAN_REQUIRED", reason: "BUDGET_EXTENSION_REQUIRED" });
    expect(f.counts()).toEqual(paused);
    const grant = f.governed.authorizeOneTimeBudgetExtension(id);
    expect(grant.grantedTokens).toBe(40_000);
    f.reopen();
    expect(f.governed.authorizeOneTimeBudgetExtension(id)).toEqual(grant);
    expect(f.governed.inspectBigTask(BIG_TASK_ID).budgets[0]).toMatchObject({ allowed: true, extensionApplied: true, effectiveLimitTokens: 160_000 });
    await f.runRole(id, "HARDEN", { tokens: 40_000 });
    f.reopen();
    expect(f.governed.inspectBigTask(BIG_TASK_ID).budgets[0]).toMatchObject({ status: "ABSOLUTE_CEILING", totalTokens: 160_000, allowed: false });
    const ceiling = f.counts();
    expect(f.governed.prepareNextRole(BIG_TASK_ID)).toMatchObject({ kind: "BLOCKED", reason: "BUDGET_BLOCKED" });
    expect(f.governed.authorizeOneTimeBudgetExtension(id)).toEqual(grant); // replay never grants another 40K
    expect(f.readRows("SELECT * FROM governed_budget_extensions")).toHaveLength(1);
    expect(f.counts()).toEqual(ceiling);
    expect(ceiling).toMatchObject({ governed_role_authorizations: 2, governed_role_results: 2, execution_runs: 2, governed_handoffs: 0 });
    expect(f.storage.getDurableWorkflowControlView(id)?.repairCyclesUsed).toBe(0);
  } finally { f.close(); }
}, 15_000);
