import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
const source = readFileSync(new URL("../web/app.js", import.meta.url), "utf8").split("root.addEventListener('submit'")[0]!;
function harness() {
  let details: { id: string; open: boolean; closest(): null; querySelector(): { textContent: string } }[] = [];
  const main = { querySelectorAll: () => details };
  const view = runInNewContext(source + "\n({ state, rememberDisclosures, restoreDisclosures, composerKeydown, runningStatus, modelOptions, effortOptions, taskProgressHtml, subtaskProgressHtml, pageHasActiveWork, executionFailureExplanation, executionRecoveryBlocker, executionProblemHtml, lifecycleHtml })", { document: { getElementById: (id: string) => id === "main" ? main : {} }, Date: class extends Date { static override now() { return Date.parse("2026-09-10T04:00:00Z"); } } });
  return { view, setDetails: (opened: boolean[]) => { details = opened.map((open, i) => ({ id: `panel-${i}`, open, closest: () => null, querySelector: () => ({ textContent: `Panel ${i}` }) })); return details; } };
}
describe("Console interaction continuity", () => {
  it("restores both nested open and closed panels after replacement, independently by route", () => {
    const { view, setDetails } = harness();
    view.state.mountedRoute = "#/draft/a"; setDetails([true, true, false]); view.rememberDisclosures();
    const replacement = setDetails([false, false, true]); view.restoreDisclosures("#/draft/a");
    expect(replacement.map(node => node.open)).toEqual([true, true, false]);
    view.state.mountedRoute = "#/task/b"; setDetails([false, true]); view.rememberDisclosures();
    const back = setDetails([false, false, true]); view.restoreDisclosures("#/draft/a");
    expect(back.map(node => node.open)).toEqual([true, true, false]);
  });
  it("sends on Enter once, leaves Shift+Enter/IME alone and prevents sending while busy", () => {
    const { view } = harness(); const requestSubmit = vi.fn();
    const event = (extra = {}) => ({ key: "Enter", preventDefault: vi.fn(), target: { value: "继续", matches: () => true, closest: () => ({ requestSubmit }) }, ...extra });
    view.composerKeydown(event()); expect(requestSubmit).toHaveBeenCalledTimes(1);
    for (const extra of [{ shiftKey: true }, { isComposing: true }, { keyCode: 229 }, { repeat: true }]) {
      const e = event(extra); view.composerKeydown(e); expect(e.preventDefault).not.toHaveBeenCalled();
    }
    view.state.pending = true; view.composerKeydown(event());
    view.state.pending = false; view.state.turns = [{ status: "RUNNING" }]; view.composerKeydown(event());
    expect(requestSubmit).toHaveBeenCalledTimes(1);
  });
  it("distinguishes recent real activity from stale or missing activity without fake percentages", () => {
    const { view } = harness(); view.state.online = true;
    expect(view.runningStatus("2026-09-10T03:55:00Z", { activity: "READING_OR_TESTING", observedAt: "2026-09-10T03:59:58Z" })).toContain("已收到模型活动");
    const stale = view.runningStatus("2026-09-10T03:55:00Z", { activity: "THINKING", observedAt: "2026-09-10T03:56:00Z" });
    expect(stale).toContain("不能确认模型仍在推进"); expect(stale).not.toContain("ctc-live-pulse");
    expect(view.runningStatus("2026-09-10T03:55:00Z")).toContain("尚无活动记录");
  });
  it("uses discovered effort options and keeps unavailable previous selection visible", () => {
    const { view } = harness(); view.state.models = { models: [{ model: "future-model", displayName: "New model", defaultEffort: "new_effort", efforts: ["low", "new_effort"] }] };
    expect(view.effortOptions("future-model")).toContain('value="new_effort" selected');
    expect(view.modelOptions("retired-model")).toContain("当前列表不可用");
  });
});


describe("Task progress visibility", () => {
  it("counts standard independent QA as the second implementation stage", () => {
    const {view} = harness();
    const html = view.subtaskProgressHtml({task:{id:"st_a"},workflow:{profile:"STANDARD",currentStage:"FRESH_QA"}});
    expect(html).toContain('max="2" value="1"'); expect(html).toContain('ctc-stage-current');
  });
  it("explains exhausted recovery and separates result errors from budget caps", () => {
    const {view} = harness();
    const execution={lastRoleFailure:{authorizationId:"retry",phase:"RESULT",failureCode:"GOVERNED_AUTHORITY_REQUIRED"},additionalRecoveries:[{authorizationId:"retry"}]};
    expect(view.executionRecoveryBlocker(execution)).toContain("调整限制并继续");
    expect(view.executionRecoveryBlocker({...execution,limitAdjustment:{values:{recoveryAttemptLimit:2}}})).toBeNull();
    const html=view.executionProblemHtml(execution);
    for(const title of ["为什么停下","错在哪一步","已保留什么","下一步"]) expect(html).toContain(title);
    expect(html).toContain("旧记录没有保留具体检查项");
    expect(view.executionFailureExplanation({lastRoleFailure:{failureCode:"RESULT_USAGE_INVALID"}})).toContain("不等于用量超限");
    expect(view.executionFailureExplanation({lastRoleFailure:{failureCode:"RESULT_CHECKPOINT_FAILED"}})).toContain("保存为任务版本");
  });
  it("allows cancelling a pending pause without disabling resume for the active role", () => {
    const { view } = harness();
    const html = view.lifecycleHtml({lifecycle: "PAUSED"}, {phase: "RUNNING", activeRoleCount: 1});
    expect(html).toContain("暂停待生效"); expect(html).toContain("取消暂停，继续执行"); expect(html).not.toContain("disabled");
    const stopped = view.lifecycleHtml({lifecycle: "PAUSED"}, {phase: "PAUSED", activeRoleCount: 0});
    expect(stopped).toContain("已暂停"); expect(stopped).not.toContain("取消暂停");
    expect(view.taskProgressHtml({})).toContain('data-action="refresh"');
  });
  it("counts integrated children and names the active task without claiming model percent", () => {
    const { view } = harness(); view.state.online = true;
    const html = view.taskProgressHtml({ contracts: [{subtaskId: "st_a", title: "Build collector"}, {subtaskId: "st_b", title: "Verify board"}], execution: { phase: "RUNNING", integratedSubtaskIds: ["st_a"], startedAt: "2026-09-10T03:00:00Z", activeRole: {subtaskId: "st_b", role: "FRESH_QA", progress: {activity: "READING_OR_TESTING", observedAt: "2026-09-10T03:59:50Z"}} } });
    expect(html).toContain('max="2" value="1"'); expect(html).toContain("Verify board · 独立 QA");
    expect(html).toContain("距首次启动（含暂停） 60 分钟"); expect(html).toContain("读取资料或使用工具");
  });
  it("does not attribute a sibling's live activity to a waiting subtask", () => {
    const { view } = harness();
    const record = {task: {id: "st_a"}, workflow: {profile: "STANDARD", currentStage: "MATERIALIZE"}, execution: {phase: "RUNNING", activeRole: {subtaskId: "st_b", role: "EXECUTE", progress: {activity: "EDITING"}}}, inspection: {dependencyReadiness: {ready: false}}};
    const html = view.subtaskProgressHtml(record);
    expect(html).toContain("等待前置任务完成"); expect(html).not.toContain("修改文件"); expect(html).not.toContain("ctc-live-pulse");
  });
  it("keeps QA incomplete during repair and distinguishes completion from parent failure", () => {
    const { view } = harness();
    const record = {task: {id: "st_a"}, workflow: {profile: "HIGH_RISK_FOUNDATION", currentStage: "REPAIR", repairCyclesUsed: 1}, execution: {phase: "HUMAN_REQUIRED", stopReason: "GOVERNED_BLOCKED"}};
    const repair = view.subtaskProgressHtml(record); expect(repair).toContain('max="3" value="2"'); expect(repair).toContain("QA 通过后才能完成");
    record.workflow.currentStage = "COMPLETE";
    const complete = view.subtaskProgressHtml(record); expect(complete).toContain('max="3" value="3"'); expect(complete).toContain("小任务工程流程已完成");
  });
  it("retries missing progress reads, polls active subtask pages and ignores stale pages", () => {
    const { view } = harness(); view.state.route = ["subtask", "st_a"];
    view.state.subtask = {progressUnavailable: true}; expect(view.pageHasActiveWork()).toBe(true);
    expect(view.subtaskProgressHtml(view.state.subtask)).toContain("不能确认任务是否仍在推进");
    view.state.subtask = {execution: {phase: "RUNNING"}}; expect(view.pageHasActiveWork()).toBe(true);
    view.state.route = ["home"]; expect(view.pageHasActiveWork()).toBe(false);
    expect(view.runningStatus(undefined, undefined)).not.toContain("NaN");
  });
  it("explains rejected QA output without blaming the budget", () => {
    const { view } = harness();
    expect(view.executionFailureExplanation({lastRoleFailure: {failureCode: "STRUCTURED_RESULT_INVALID"}})).toContain("格式未被 Console 接受");
  });
});
