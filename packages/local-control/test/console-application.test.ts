import { describe, expect, it, vi } from "vitest";
import { ConsoleApplication } from "../src/console-application.js";
import type { LocalControlService } from "../src/service.js";
import type { executeConsoleDiscussionCodex } from "@codex-task-console/codex-adapter";
import { makePlanningFixture } from "../../storage/test/live-planning-fixture.js";

const forbidden = async (): Promise<never> => { throw new Error("Unexpected execution"); };
const service: LocalControlService = { inspectSubtask: forbidden, provisionOwnedWorktree: forbidden, runOwnedWorktreeExecution: forbidden, releaseOwnedWorktree: forbidden };
describe("Console discussion orchestration", () => {
  it("persists before calling once, returns without waiting, and treats model suggestions as non-authoritative", async () => {
    const f = makePlanningFixture();
    let complete!: (value: Awaited<ReturnType<typeof executeConsoleDiscussionCodex>>) => void;
    const discuss = vi.fn<typeof executeConsoleDiscussionCodex>(() => new Promise(resolve => { complete = resolve; }));
    const ui = new ConsoleApplication(f.storage, service, { discuss });
    try {
      const request = { requestId: "discussion-request-1", scope: { kind: "PROJECT", id: f.intake.bigTask.projectId }, message: "Discuss the product" };
      const first = await ui.request("discuss", request);
      expect(first).toMatchObject({ status: "RUNNING", usage: null });
      expect(await ui.request("discuss", request)).toEqual(first);
      expect(discuss).toHaveBeenCalledTimes(1);
      expect(discuss.mock.calls[0]![1]).toContain("CONSOLE_PRODUCT_DISCUSSION");
      complete({ success: true, agentResponseText: JSON.stringify({ reply: "Here is a proposed direction.", proposal: null }), normalizedUsage: { totalTokens: 50 }, failureCode: null } as Awaited<ReturnType<typeof executeConsoleDiscussionCodex>>);
      await ui.stop();
      expect(ui.store.turns(request.scope).turns[0]).toMatchObject({ status: "SUCCEEDED", answer: { reply: "Here is a proposed direction." }, usage: { totalTokens: 50 } });
      expect(f.storage.listBigTasksByProject(f.intake.bigTask.projectId)).toEqual([]);
      expect(await ui.request("discussion", { scope: request.scope })).toMatchObject({ turns: [expect.objectContaining({ status: "SUCCEEDED" })] });
    } finally { await ui.stop(); f.close(); }
  });
  it("does not store raw provider exceptions or invent missing usage", async () => {
    const f = makePlanningFixture();
    const ui = new ConsoleApplication(f.storage, service, { discuss: async () => { throw new Error("PRIVATE_PROVIDER_ERROR_SENTINEL"); } });
    try {
      const scope = { kind: "PROJECT", id: f.intake.bigTask.projectId };
      await ui.request("discuss", { requestId: "failed-discussion", scope, message: "Discuss" }); await ui.stop();
      const result = ui.store.turns(scope);
      expect(result.turns[0]).toMatchObject({ status: "FAILED", failureCode: "PROVIDER_FAILED", usage: null, answer: null });
      expect(JSON.stringify(result)).not.toContain("PRIVATE_PROVIDER_ERROR_SENTINEL");
    } finally { await ui.stop(); f.close(); }
  });
});
