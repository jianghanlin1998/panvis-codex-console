import { describe, expect, it, vi } from "vitest";
import { BigTaskIdSchema } from "@codex-task-console/domain";
import { LivePlanningStore } from "../src/live-planning.js";
import { getTaskStorageWorktreeAccess } from "../src/task-storage-internals.js";
import { ConsoleWorkspaceStore } from "../src/console-workspace.js";
import { makePlanningFixture } from "./live-planning-fixture.js";
import { makeBigTask, makeProject, makeSubtask } from "./fixtures.js";

const brief = { title: "Complete Console", goal: "Discuss and deliver tasks in the UI", scopeIn: ["Full task flow"], scopeOut: ["Deployment"], successCriteria: ["A user can inspect and approve real results"] };
const answer = { reply: "Confirm the product direction before implementation.", proposal: brief };

describe("persistent Console discussions and human direction", () => {
  it("creates only a draft before confirmation, confirms exactly once, and survives reopen", () => {
    const f = makePlanningFixture();
    try {
      let ui = new ConsoleWorkspaceStore(f.storage);
      const input = { requestId: "draft-request-1", projectId: f.intake.bigTask.projectId, kind: "BIG_TASK", title: "Console", goal: "Complete task UI" };
      const draft = ui.createDraft(input);
      expect(ui.createDraft(input)).toEqual(draft);
      expect(() => ui.createDraft({ ...input, goal: "Different product" })).toThrow();
      expect(f.storage.listBigTasksByProject(input.projectId)).toEqual([]);
      const confirmation = { draftId: draft.id, revision: 0, brief, reviewIntensity: "THOROUGH", planningTokenLimit: 120000 };
      expect(() => ui.confirmDirection({ ...confirmation, revision: 1 })).toThrow();
      expect(f.storage.listBigTasksByProject(input.projectId)).toEqual([]);
      const confirmed = ui.confirmDirection(confirmation);
      expect(confirmed.confirmedBigTaskId).not.toBeNull();
      expect(ui.confirmDirection(confirmation)).toEqual(confirmed);
      expect(() => ui.confirmDirection({ ...confirmation, brief: { ...brief, goal: "Changed" } })).toThrow();
      expect(f.storage.listSubtasksByBigTask(confirmed.confirmedBigTaskId!)).toEqual([]);
      expect(f.planning.inspect(confirmed.confirmedBigTaskId!).runs).toEqual([]);
      f.reopen(); ui = new ConsoleWorkspaceStore(f.storage);
      expect(ui.getDraft(draft.id)).toEqual(confirmed);
      expect(f.planning.readIntake(confirmed.confirmedBigTaskId!).intake).toMatchObject({ reviewIntensity: "THOROUGH", productDirection: { confirmed: true, summary: brief.goal } });
    } finally { f.close(); }
  });
  it("rolls back the draft and canonical intake together when confirmation cannot finish", () => {
    const f = makePlanningFixture();
    const original = LivePlanningStore.prototype.acceptInConsoleDirectionTransaction;
    const spy = vi.spyOn(LivePlanningStore.prototype, "acceptInConsoleDirectionTransaction").mockImplementation(function (this: LivePlanningStore, input) { original.call(this, input); throw new Error("Synthetic interrupted confirmation"); });
    try {
      const ui = new ConsoleWorkspaceStore(f.storage);
      const draft = ui.createDraft({ requestId: "atomic-direction", projectId: f.intake.bigTask.projectId, kind: "BIG_TASK", title: "Atomic", goal: "Atomic confirmation" });
      expect(() => ui.confirmDirection({ draftId: draft.id, revision: 0, brief, reviewIntensity: "STANDARD", planningTokenLimit: 120000 })).toThrow();
      expect(ui.getDraft(draft.id)).toEqual(draft);
      expect(f.storage.listBigTasksByProject(f.intake.bigTask.projectId)).toEqual([]);
      expect(getTaskStorageWorktreeAccess(f.storage)!.sqlite.prepare("SELECT count(*) AS count FROM live_planning_intakes").get()?.count).toBe(0);
    } finally { spy.mockRestore(); f.close(); }
  });
  it("freezes confirmed project conclusions into planning while excluding raw discussions and later changes", () => {
    const f = makePlanningFixture();
    try {
      const ui = new ConsoleWorkspaceStore(f.storage); const scope = { kind: "PROJECT", id: f.intake.bigTask.projectId };
      ui.confirmContext({ requestId: "project-data-rule", scope, title: "Data boundary", body: "Keep customer data local.\nDo not publish it." });
      const turn = ui.claimDiscussion({ requestId: "project-raw-chat", scope, message: "UNCONFIRMED_RAW_SENTINEL" });
      ui.finishDiscussion(turn.turn.id, answer, { totalTokens: 1 }, null);
      const draft = ui.createDraft({ requestId: "context-direction", projectId: scope.id, kind: "SMALL_TASK", title: "Task", goal: "Goal" });
      const confirmed = ui.confirmDirection({ draftId: draft.id, revision: 0, brief, reviewIntensity: "STANDARD", planningTokenLimit: 120000 });
      ui.confirmContext({ requestId: "later-project-rule", scope, title: "Later rule", body: "LATER_RULE_SENTINEL" });
      const packet = f.planning.claim(confirmed.confirmedBigTaskId!).inputText;
      expect(packet).toContain("Keep customer data local."); expect(packet).not.toContain("UNCONFIRMED_RAW_SENTINEL"); expect(packet).not.toContain("LATER_RULE_SENTINEL");
      expect(f.planning.readIntake(confirmed.confirmedBigTaskId!).intake.confirmedContextItems).toHaveLength(1);
    } finally { f.close(); }
  });
  it("rejects a stored discussion whose payload changes scope or disagrees with its saved status", () => {
    const f = makePlanningFixture();
    try {
      const ui = new ConsoleWorkspaceStore(f.storage); const scope = { kind: "PROJECT", id: f.intake.bigTask.projectId };
      const turn = ui.claimDiscussion({ requestId: "corrupted-status", scope, message: "Discuss" }).turn;
      getTaskStorageWorktreeAccess(f.storage)!.sqlite.prepare("UPDATE console_discussion_turns SET status='FAILED' WHERE id=?").run(turn.id);
      expect(() => ui.turns(scope)).toThrow();
      expect(() => ui.claimDiscussion({ requestId: "corrupted-status", scope, message: "Discuss" })).toThrow();
    } finally { f.close(); }
  });
  it("pins direct small-task intent and records a per-task measurement window only when chosen", () => {
    const f = makePlanningFixture();
    try {
      const ui = new ConsoleWorkspaceStore(f.storage);
      const draft = ui.createDraft({ requestId: "small-request-1", projectId: f.intake.bigTask.projectId, kind: "SMALL_TASK", title: "Button", goal: "Fix one button" });
      const confirmed = ui.confirmDirection({ draftId: draft.id, revision: 0, brief, reviewIntensity: "STANDARD", planningTokenLimit: 10000, planningMeasureOnlyMinutes: 30 });
      const intake = f.planning.readIntake(confirmed.confirmedBigTaskId!).intake;
      expect(intake.taskSize).toBe("SMALL");
      expect(intake.budgetException).toMatchObject({ mode: "MEASURE_ONLY", approved: true });
      expect(Date.parse(intake.budgetException!.expiresAt) - Date.parse(draft.createdAt)).toBe(30 * 60_000);
      expect(JSON.parse(f.planning.claim(confirmed.confirmedBigTaskId!).inputText).taskSizeInstruction).toContain("exactly one bounded task");
    } finally { f.close(); }
  });
  it("isolates raw transcripts across scopes while including only explicitly confirmed parent conclusions", () => {
    const f = makePlanningFixture();
    try {
      const ui = new ConsoleWorkspaceStore(f.storage); const project = { kind: "PROJECT" as const, id: f.intake.bigTask.projectId };
      f.storage.createBigTask(f.intake.bigTask);
      const one = f.storage.createSubtask(makeSubtask("st_ui_one", f.intake.bigTask.id));
      const two = f.storage.createSubtask(makeSubtask("st_ui_two", f.intake.bigTask.id));
      const sibling = ui.claimDiscussion({ requestId: "sibling-message", scope: { kind: "SUBTASK", id: one.id }, message: "SIBLING_RAW_SENTINEL" });
      ui.finishDiscussion(sibling.turn.id, answer, { totalTokens: 20 }, null);
      const parent = ui.claimDiscussion({ requestId: "parent-message", scope: project, message: "PARENT_RAW_SENTINEL" });
      ui.finishDiscussion(parent.turn.id, answer, { totalTokens: 20 }, null);
      ui.confirmContext({ requestId: "confirmed-parent", scope: project, title: "Product first", body: "PARENT_CONFIRMED_CONCLUSION" });
      const own = ui.claimDiscussion({ requestId: "own-message-one", scope: { kind: "SUBTASK", id: two.id }, message: "Help with this task" });
      expect(own.inputText).toContain("PARENT_CONFIRMED_CONCLUSION");
      expect(own.inputText).not.toContain("SIBLING_RAW_SENTINEL");
      expect(own.inputText).not.toContain("PARENT_RAW_SENTINEL");
      expect(() => ui.claimDiscussion({ requestId: "own-message-two", scope: { kind: "SUBTASK", id: two.id }, message: "Another message" })).toThrow();
      expect(ui.claimDiscussion({ requestId: "own-message-one", scope: { kind: "SUBTASK", id: two.id }, message: "Help with this task" }).claimed).toBe(false);
      expect(() => ui.claimDiscussion({ requestId: "own-message-one", scope: { kind: "SUBTASK", id: one.id }, message: "Help with this task" })).toThrow();
      expect(f.storage.listSubtasksByBigTask(f.intake.bigTask.id).every(task => task.maturity === "NOT_STARTED")).toBe(true);
    } finally { f.close(); }
  });
  it("retains interrupted/failed history and unknown usage without replaying or fabricating success", () => {
    const f = makePlanningFixture();
    try {
      const ui = new ConsoleWorkspaceStore(f.storage); const scope = { kind: "PROJECT", id: f.intake.bigTask.projectId };
      ui.claimDiscussion({ requestId: "interrupted-turn", scope, message: "Discuss a direction" });
      f.reopen(); const reopened = new ConsoleWorkspaceStore(f.storage); reopened.recoverInterrupted();
      expect(reopened.turns(scope).turns[0]).toMatchObject({ status: "INTERRUPTED", answer: null, usage: null });
      expect(reopened.claimDiscussion({ requestId: "interrupted-turn", scope, message: "Discuss a direction" }).claimed).toBe(false);
      const next = reopened.claimDiscussion({ requestId: "failed-output-turn", scope, message: "Try the next question" });
      expect(reopened.finishDiscussion(next.turn.id, { approved: true }, { totalTokens: 123 }, null)).toMatchObject({ status: "FAILED", failureCode: "INVALID_OUTPUT", usage: { totalTokens: 123 } });
      expect(f.storage.listBigTasksByProject(f.intake.bigTask.projectId)).toEqual([]);
    } finally { f.close(); }
  });
  it("pages all history and starts at recent messages; the compiled context stays bounded", () => {
    const f = makePlanningFixture();
    try {
      const ui = new ConsoleWorkspaceStore(f.storage); const scope = { kind: "PROJECT", id: f.intake.bigTask.projectId };
      for (let index = 0; index < 19; index++) {
        const turn = ui.claimDiscussion({ requestId: `paged-turn-${index}`, scope, message: "Discuss this product " + "中".repeat(3000) });
        expect(Buffer.byteLength(turn.inputText, "utf8")).toBeLessThanOrEqual(100000);
        ui.finishDiscussion(turn.turn.id, answer, { totalTokens: 1 }, null);
      }
      const recent = ui.turns(scope);
      expect(recent.turns.map(turn => turn.sequence)).toEqual([12, 13, 14, 15, 16, 17, 18, 19]);
      expect(recent.hasPrevious).toBe(true);
      const sequences: number[] = []; let after = 0;
      for (;;) { const page = ui.turns(scope, after); sequences.push(...page.turns.map(turn => turn.sequence)); after = page.nextAfter; if (!page.hasMore) break; }
      expect(sequences).toEqual(Array.from({ length: 19 }, (_, index) => index + 1));
    } finally { f.close(); }
  });
  it("rejects cross-project task associations and unknown scopes", () => {
    const f = makePlanningFixture();
    try {
      const ui = new ConsoleWorkspaceStore(f.storage);
      const other = f.storage.createProject(makeProject("prj_other_ui", "other-ui"));
      const big = f.storage.createBigTask(makeBigTask("bt_other_ui", other.id));
      expect(() => ui.createDraft({ requestId: "cross-project-draft", projectId: f.intake.bigTask.projectId, kind: "SMALL_TASK", title: "x", goal: "x", relatedBigTaskId: big.id })).toThrow();
      expect(() => ui.resolveScope({ kind: "BIG_TASK", id: BigTaskIdSchema.parse("bt_missing_ui") })).toThrow();
    } finally { f.close(); }
  });
});
