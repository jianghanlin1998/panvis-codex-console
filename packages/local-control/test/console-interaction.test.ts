import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
const source = readFileSync(new URL("../web/app.js", import.meta.url), "utf8").split("root.addEventListener('submit'")[0]!;
function harness() {
  let details: { id: string; open: boolean; closest(): null; querySelector(): { textContent: string } }[] = [];
  const main = { querySelectorAll: () => details };
  const view = runInNewContext(source + "\n({ state, rememberDisclosures, restoreDisclosures, composerKeydown, runningStatus, modelOptions, effortOptions })", { document: { getElementById: (id: string) => id === "main" ? main : {} }, Date: class extends Date { static override now() { return Date.parse("2026-09-10T04:00:00Z"); } } });
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
