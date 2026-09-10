import { describe, expect, it } from "vitest";
import { CONSOLE_DISCUSSION_OUTPUT_SCHEMA } from "@codex-task-console/domain";
import type { JsonValue } from "../src/protocol.js";
import { ConsoleWorkspaceStore } from "@codex-task-console/storage";
import { makePlanningFixture } from "../../storage/test/live-planning-fixture.js";
import { planningProviderFixture } from "./planning-provider-fixture.js";
import { readConsoleModelCatalogForTest, executeConsoleDiscussionCodexForTest, executeBigTaskPlanningCodexForTest } from "../src/live-execution.js";
const entry = (model: string) => ({ model, displayName: model, supportedReasoningEfforts: [{ reasoningEffort: "high" }, { reasoningEffort: "future_effort" }], defaultReasoningEffort: "high", isDefault: true });
describe("Console model discovery and activity", () => {
  it("discovers paginated future models and efforts without starting a model turn or returning config secrets", async () => {
    const peer = planningProviderFixture(() => { throw new Error("No model turn"); }, { configReadResult: { config: { model: "test-model", model_reasoning_effort: "high", secret: "must-not-return" } }, modelsResult: cursor => ({ data: [entry(cursor ? "future-model" : "test-model")], nextCursor: cursor ? null : "next" }) });
    const result = await readConsoleModelCatalogForTest(peer.dependencies);
    expect(result.current).toEqual({ model: "test-model", reasoningEffort: "high" });
    expect(result.models.map(model => model.model)).toEqual(["test-model", "future-model"]);
    expect(result.models[1]?.efforts).toContain("future_effort");
    expect(JSON.stringify(result)).not.toContain("must-not-return");
    expect(peer.requests.filter(request => request.method === "model/list")).toHaveLength(2);
    expect(peer.requests.some(request => ["thread/start", "turn/start"].includes(request.method))).toBe(false);
  });
  it("rejects malformed catalogues and cleans up without generating", async () => {
    const peer = planningProviderFixture(() => null, { modelsResult: () => ({ data: [entry("bad\nmodel")], nextCursor: null }) });
    await expect(readConsoleModelCatalogForTest(peer.dependencies)).rejects.toThrow();
    expect(peer.requests.some(request => request.method === "turn/start")).toBe(false);
  });
  it("inherits project model, overrides and resets task selection, and records actual chat activity", async () => {
    const f = makePlanningFixture();
    try {
      const store = new ConsoleWorkspaceStore(f.storage), project = { kind: "PROJECT", id: f.intake.bigTask.projectId } as const;
      const scope = { kind: "BIG_TASK", id: f.intake.bigTask.id } as const;
      f.planning.accept(f.intake);
      store.changeSettings({ requestId: "project-model", scope: project, expectedRevision: 0, modelSelection: { model: "future-model", reasoningEffort: "future_effort" } });
      expect(store.settings(scope).effectiveModelSelection?.model).toBe("future-model");
      store.changeSettings({ requestId: "task-model", scope, expectedRevision: 0, modelSelection: { model: "task-model", reasoningEffort: "high" } });
      expect(store.settings(scope).effectiveModelSelection?.model).toBe("task-model");
      store.changeSettings({ requestId: "reset-model", scope, expectedRevision: 1, modelSelection: null });
      const claim = store.claimDiscussion({ requestId: "model-discussion", scope, message: "Investigate" });
      const peer = planningProviderFixture(() => ({ reply: "Investigated", proposal: null, contextSummary: "Checked project" }), { researchTools: true });
      const result = await executeConsoleDiscussionCodexForTest(f.storage, claim.inputText, CONSOLE_DISCUSSION_OUTPUT_SCHEMA as JsonValue, () => 300000, peer.dependencies);
      expect(result.success).toBe(true);
      expect(peer.requests.find(request => request.method === "thread/start")?.params).toMatchObject({ model: "future-model", config: { model_reasoning_effort: "future_effort" } });
      expect(peer.requests.find(request => request.method === "turn/start")?.params).toMatchObject({ model: "future-model", effort: "future_effort" });
      const turn = store.turns(scope).turns[0]!;
      expect(turn).toMatchObject({ actualModel: "future-model", modelSelection: { model: "future-model", reasoningEffort: "future_effort" }, progress: { observedAt: expect.any(String), activity: expect.any(String), notifications: expect.any(Number) } });
      store.finishDiscussion(turn.id, JSON.parse(result.agentResponseText!), result.normalizedUsage, null);
      const finished = store.turns(scope).turns[0]!;
      store.recordDiscussionActivity(turn.id, { actualModel: "must-not-change-finished" });
      expect(store.turns(scope).turns[0]).toEqual(finished);
    } finally { f.close(); }
  });
  it("records planner activity and pins its selected model for that run", async () => {
    const f = makePlanningFixture();
    try {
      f.planning.accept(f.intake);
      new ConsoleWorkspaceStore(f.storage).changeSettings({ requestId: "planning-model", scope: { kind: "PROJECT", id: f.intake.bigTask.projectId }, expectedRevision: 0, modelSelection: { model: "planning-model", reasoningEffort: "high" } });
      const peer = planningProviderFixture(() => ({ kind: "PRODUCT_QUESTION", questions: ["Confirm direction"] }));
      await executeBigTaskPlanningCodexForTest(f.storage, f.intake.bigTask.id, peer.dependencies);
      const run = f.planning.inspect(f.intake.bigTask.id).runs[0]!;
      expect(run.modelSelection).toEqual({ model: "planning-model", reasoningEffort: "high" });
      expect(run.progress?.observedAt).toBeDefined();
      expect(peer.requests.find(request => request.method === "turn/start")?.params.effort).toBe("high");
      const store = new ConsoleWorkspaceStore(f.storage);
      store.changeSettings({ requestId: "override-retry-model", scope: { kind: "BIG_TASK", id: f.intake.bigTask.id }, expectedRevision: 0, modelSelection: { model: "retry-model", reasoningEffort: "high" } });
      const next = store.prepareAgain(f.intake.bigTask.id, "model-retry-request");
      expect(store.settings({ kind: "BIG_TASK", id: next.bigTaskId }).effectiveModelSelection?.model).toBe("retry-model");
    } finally { f.close(); }
  });
});
