import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { makeExecutionFixture } from "../../storage/test/big-task-execution-fixture.js";
import { createLocalControlServiceForTesting } from "../src/service.js";

// Render actual service responses without a browser, provider or fabricated API shape.
// Browser interactions and layout are separately verified in the local UI fixture.
function views(call: (action: string, input: unknown) => Promise<object>) {
  const source = readFileSync(new URL("../web/app.js", import.meta.url), "utf8").split("root.addEventListener('submit'")[0]!;
  const modal = { open: false, close() { this.open = false; }, showModal() { this.open = true; } };
  const context = { document: { getElementById: (id: string) => id === "modal" ? modal : ({ textContent: "", classList: { toggle() {} } }) }, localStorage: { getItem: () => null },
    fetch: async (_url: string, options: { body: string }) => { const request = JSON.parse(options.body); return { ok: true, json: () => call(request.action, request.input) }; },
    AbortController, setTimeout, clearTimeout, structuredClone,
  };
  return runInNewContext(source + "\n({ taskPage, subtaskPage, messagesHtml, briefForm, state, openModal, confirmModal, act })", context) as {
    taskPage(id: string, tab: string): Promise<string>; subtaskPage(id: string, tab: string): Promise<string>;
    messagesHtml(turns: unknown[]): string;
    briefForm(brief: object, draft: { id: string }): string;
    act(action: string): Promise<void>;
    state: { task?: object; generation: number; drafts: Map<string, object>; scope: object; modalContext: { scope: object } };
    openModal(title: string, body: string, action: string): void;
    confirmModal(): Promise<void>;
  };
}
const forbidden = async (): Promise<never> => { throw new Error("No provider in render contracts"); };
describe("Console render contracts", () => {
  it("renders the real reviewed candidate, dependency profiles, task overview and canonical subtask inspection", async () => {
    const f = makeExecutionFixture(undefined, undefined, "STANDARD");
    const service = createLocalControlServiceForTesting(f.storage, f.manager, forbidden, forbidden, forbidden, f.governed);
    try {
      const ui = views((action, input) => service.consoleRequest!(action, input));
      const plan = await ui.taskPage(f.approval.bigTaskId, "plan");
      expect(plan).toContain("具体实施计划"); expect(plan).toContain("检查深度：标准");
      expect(plan).toContain("核对计划并批准实施"); expect(plan).toContain("Verify collect");
      await service.approveExecution!(f.approval);
      const overview = await ui.taskPage(f.approval.bigTaskId, "overview"); expect(overview).toContain("开始执行");
      f.execution.start(f.approval.bigTaskId);
      expect(f.governed.prepareNextRole(f.approval.bigTaskId).kind).toBe("ROLE_AUTHORIZED");
      const tasks = f.storage.listSubtasksByBigTask(f.approval.bigTaskId); expect(tasks).toHaveLength(2);
      const own = await ui.subtaskPage(tasks[0]!.id, "overview"); expect(own).toContain("执行历史");
      expect(own).toContain("未实施"); expect(own).not.toContain("undefined");
    } finally { await service.stopAndDrain!(); f.close(); }
  }, 15_000); // Includes isolated Git/worktree provisioning, not just HTML rendering.
  it.each(["TIME_LIMIT_REACHED", "USER_PAUSED", "DAEMON_STOPPING"] as const)("offers continuation after a %s task window is renewed", async reason => {
    let instant = Date.parse("2026-09-07T00:00:00.000Z");
    const f = makeExecutionFixture(() => new Date(instant), undefined, "STANDARD");
    const service = createLocalControlServiceForTesting(f.storage, f.manager, forbidden, forbidden, forbidden, f.governed);
    try {
      const ui = views((action, input) => service.consoleRequest!(action, input));
      f.execution.approve(f.approval); f.execution.start(f.approval.bigTaskId);
      instant += f.approval.limits.durationMilliseconds + 1;
      const stopped = f.execution.stop(f.approval.bigTaskId, reason);
      const expired = await ui.taskPage(f.approval.bigTaskId, "overview");
      expect(expired).not.toContain('data-action="start"'); expect(expired).toContain('data-action="renew-dialog"');
      f.execution.renewWindow({ bigTaskId: f.approval.bigTaskId, planDigest: stopped.planDigest, previousExpiresAt: stopped.expiresAt, durationMilliseconds: 60000 });
      const html = await ui.taskPage(f.approval.bigTaskId, "overview");
      expect(html).toContain('data-action="start"'); expect(html).toContain("继续执行");
      expect(html).not.toContain('data-action="renew-dialog"');
    } finally { await service.stopAndDrain!(); f.close(); }
  });
  it("invalidates confirmation when its original task scope has changed", async () => {
    let calls = 0;
    const ui = views(async () => { calls += 1; return {}; });
    const scope = { kind: "PROJECT", id: "prj_original" };
    ui.state.scope = scope; ui.state.task = { task: { id: "bt_original" }, execution: { resultHeadSha: "a".repeat(40) } };
    // Exercise the real button dispatcher before invalidating the open confirmation.
    await ui.act("accept-dialog");
    ui.state.scope = { kind: "PROJECT", id: "prj_other" }; ui.state.generation += 1;
    expect(ui.state.modalContext.scope).toEqual(scope);
    await expect(ui.confirmModal()).rejects.toMatchObject({ code: "STALE_VIEW" }); expect(calls).toBe(0);
  });
  it("preserves chosen planning limits and the explicit exception when a draft is redrawn", () => {
    const ui = views(forbidden);
    ui.state.drafts.set("brief:draft_budget", { title: "Task", goal: "Result", planningTokenLimit: "5000", measureOnly: "on", planningMinutes: "20" });
    const html = ui.briefForm({}, { id: "draft_budget" });
    expect(html).toContain('name="planningTokenLimit" value="5000"');
    expect(html).toContain('name="measureOnly" checked'); expect(html).toContain('name="planningMinutes" value="20"');
  });
  it("renders user and model text as text, including markup-looking content", () => {
    const ui = views(forbidden);
    const output = ui.messagesHtml([{ id: "turn-one", sequence: 1, message: '<img src=x onerror="alert(1)">', status: "SUCCEEDED", createdAt: "2026-09-01T00:00:00.000Z", answer: { reply: "<script>model text</script>", proposal: null }, usage: null }]);
    expect(output).toContain("&lt;img"); expect(output).toContain("&lt;script&gt;");
    expect(output).not.toContain("<script>"); expect(output).not.toContain("<img");
  });
});
