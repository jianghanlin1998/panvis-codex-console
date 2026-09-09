import { describe, expect, it } from "vitest";
import type { ConsoleDiscussionAnswer, ConsoleScope } from "@codex-task-console/domain";
import { ConsoleWorkspaceStore } from "../src/console-workspace.js";
import { getTaskStorageWorktreeAccess } from "../src/task-storage-internals.js";
import { makePlanningFixture } from "./live-planning-fixture.js";
import { makeBigTask, makeProject, makeSubtask } from "./fixtures.js";

const brief = () => ({
  title: "Task from the discussion", goal: "Show the agreed result in the Console",
  scopeIn: ["The agreed result"], scopeOut: ["Deployment"], successCriteria: ["The result is inspectable"],
});
const createAction = (): Extract<NonNullable<ConsoleDiscussionAnswer["actions"]>[number], { kind: "CREATE_TASK" }> => ({
  kind: "CREATE_TASK", taskKind: "SMALL_TASK", brief: brief(), suggestedSubtasks: [],
  relatedBigTaskId: null, reviewLevel: "LIGHT",
});
const reply = (actions: NonNullable<ConsoleDiscussionAnswer["actions"]>): ConsoleDiscussionAnswer => ({
  reply: "The requested workspace changes have been prepared.", proposal: null, actions,
});
const fixture = () => {
  const f = makePlanningFixture();
  const project: ConsoleScope = { kind: "PROJECT", id: f.intake.bigTask.projectId };
  const big = f.storage.createBigTask(f.intake.bigTask);
  const sub = f.storage.createSubtask(makeSubtask("st_settings_child", big.id));
  return { ...f, project, big: { kind: "BIG_TASK", id: big.id } as const,
    sub: { kind: "SUBTASK", id: sub.id } as const,
    get storage() { return f.storage; },
    ui: new ConsoleWorkspaceStore(f.storage),
    sql: getTaskStorageWorktreeAccess(f.storage)!.sqlite,
  };
};

describe("Console review settings and discussion effects", () => {
  it("resolves project, Big Task and Subtask inheritance without changing canonical task records", () => {
    const f = fixture();
    try {
      const originalProject = f.storage.getProjectById(f.intake.bigTask.projectId);
      const originalBig = f.storage.getBigTaskById(f.big.id);
      const originalSub = f.storage.getSubtaskById(f.sub.id);
      expect(f.ui.settings(f.sub)).toMatchObject({ revision: 0, reviewLevel: null, effectiveReviewLevel: "STANDARD" });
      f.ui.changeSettings({ requestId: "settings-project", scope: f.project, expectedRevision: 0, reviewLevel: "THOROUGH" });
      expect(f.ui.settings(f.big)).toMatchObject({ reviewLevel: null, effectiveReviewLevel: "THOROUGH", inheritedFrom: f.project });
      f.ui.changeSettings({ requestId: "settings-big-task", scope: f.big, expectedRevision: 0, reviewLevel: "LIGHT" });
      expect(f.ui.settings(f.sub)).toMatchObject({ reviewLevel: null, effectiveReviewLevel: "LIGHT", inheritedFrom: f.big });
      f.ui.changeSettings({ requestId: "settings-small-task", scope: f.sub, expectedRevision: 0, reviewLevel: "STANDARD" });
      expect(f.ui.settings(f.sub)).toMatchObject({ revision: 1, reviewLevel: "STANDARD", effectiveReviewLevel: "STANDARD", inheritedFrom: null });
      f.ui.changeSettings({ requestId: "settings-reset-child", scope: f.sub, expectedRevision: 1, reviewLevel: null });
      expect(f.ui.settings(f.sub)).toMatchObject({ revision: 2, reviewLevel: null, effectiveReviewLevel: "LIGHT", inheritedFrom: f.big });
      f.ui.changeSettings({ requestId: "settings-reset-big", scope: f.big, expectedRevision: 1, reviewLevel: null });
      expect(f.ui.settings(f.sub).effectiveReviewLevel).toBe("THOROUGH");
      expect(f.storage.getProjectById(f.intake.bigTask.projectId)).toEqual(originalProject);
      expect(f.storage.getBigTaskById(f.big.id)).toEqual(originalBig);
      expect(f.storage.getSubtaskById(f.sub.id)).toEqual(originalSub);
    } finally { f.close(); }
  });

  it("inherits a related Big Task's review level for a draft and preserves settings across reopen", () => {
    const f = fixture();
    try {
      f.ui.changeSettings({ requestId: "draft-parent-level", scope: f.big, expectedRevision: 0, reviewLevel: "THOROUGH" });
      const draft = f.ui.createDraft({ requestId: "inherited-draft", projectId: f.intake.bigTask.projectId,
        kind: "SMALL_TASK", title: "Follow-up", goal: "Improve the previous result", relatedBigTaskId: f.big.id });
      const scope: ConsoleScope = { kind: "DRAFT", id: draft.id };
      expect(f.ui.settings(scope)).toMatchObject({ reviewLevel: null, effectiveReviewLevel: "THOROUGH", inheritedFrom: f.big });
      f.ui.changeSettings({ requestId: "draft-own-level", scope, expectedRevision: 0, reviewLevel: "LIGHT" });
      const stored = f.ui.settings(scope);
      f.reopen();
      const reopened = new ConsoleWorkspaceStore(f.storage);
      expect(reopened.settings(scope)).toEqual(stored);
    } finally { f.close(); }
  });

  it("checks revisions and global request identity before applying a settings change", () => {
    const f = fixture();
    try {
      const input = { requestId: "settings-global-id", scope: f.project, expectedRevision: 0, reviewLevel: "LIGHT" };
      const saved = f.ui.changeSettings(input);
      expect(f.ui.changeSettings(structuredClone(input))).toEqual(saved);
      expect(() => f.ui.changeSettings({ ...input, requestId: "settings-stale-id", reviewLevel: "THOROUGH" })).toThrow(expect.objectContaining({ code: "CONFLICT" }));
      expect(() => f.ui.changeSettings({ ...input, scope: f.big })).toThrow(expect.objectContaining({ code: "CONFLICT" }));
      expect(() => f.ui.changeSettings({ ...input, reviewLevel: "STANDARD" })).toThrow(expect.objectContaining({ code: "CONFLICT" }));
      const other = f.storage.createProject(makeProject("prj_request_other", "request-other"));
      const foreign: ConsoleScope = { kind: "PROJECT", id: other.id };
      expect(() => f.ui.changeSettings({ ...input, scope: foreign })).toThrow(expect.objectContaining({ code: "CONFLICT" }));
      expect(f.ui.settings(f.project)).toMatchObject({ revision: 1, reviewLevel: "LIGHT" });
      expect(f.ui.settings(f.big)).toMatchObject({ revision: 0, reviewLevel: null });
      expect(f.ui.settings(foreign)).toMatchObject({ revision: 0, reviewLevel: null });
      expect(f.sql.prepare("SELECT count(*) AS count FROM console_settings_changes").get()?.count).toBe(1);
    } finally { f.close(); }
  });

  it("clears a draft's creation-time review override when the owner selects inheritance", () => {
    const f = fixture();
    try {
      f.ui.changeSettings({ requestId: "draft-reset-parent", scope: f.project, expectedRevision: 0, reviewLevel: "THOROUGH" });
      const draft = f.ui.createDraft({ requestId: "draft-created-light", projectId: f.intake.bigTask.projectId,
        kind: "SMALL_TASK", title: "A small task", goal: "Use the selected review policy", reviewLevel: "LIGHT" });
      const scope: ConsoleScope = { kind: "DRAFT", id: draft.id };
      expect(f.ui.settings(scope).effectiveReviewLevel).toBe("LIGHT");
      f.ui.changeSettings({ requestId: "draft-reset-own", scope, expectedRevision: 0, reviewLevel: null });
      expect(f.ui.settings(scope)).toMatchObject({ reviewLevel: null, effectiveReviewLevel: "THOROUGH", inheritedFrom: f.project });
    } finally { f.close(); }
  });

  it("makes draft creation idempotent for structured suggestions and rejects a foreign source turn", () => {
    const f = fixture();
    try {
      const source = f.ui.claimDiscussion({ requestId: "draft-source-own", scope: f.project, message: "Prepare a task" }).turn;
      const input = { requestId: "structured-draft", projectId: f.intake.bigTask.projectId, kind: "BIG_TASK",
        title: "Structured task", goal: "Preserve the proposal", sourceTurnId: source.id,
        suggestedBrief: brief(), suggestedSubtasks: [brief()], reviewLevel: "THOROUGH" };
      const draft = f.ui.createDraft(input);
      expect(f.ui.createDraft(structuredClone(input))).toEqual(draft);
      expect(() => f.ui.createDraft({ ...input, suggestedBrief: { ...brief(), goal: "Different proposal" } })).toThrow(expect.objectContaining({ code: "CONFLICT" }));
      expect(() => f.ui.createDraft({ requestId: input.requestId, projectId: input.projectId, kind: input.kind,
        title: input.title, goal: input.goal })).toThrow(expect.objectContaining({ code: "CONFLICT" }));
      const other = f.storage.createProject(makeProject("prj_settings_other", "settings-other"));
      const foreign = f.ui.claimDiscussion({ requestId: "draft-source-other", scope: { kind: "PROJECT", id: other.id }, message: "Another project" }).turn;
      expect(() => f.ui.createDraft({ ...input, requestId: "foreign-source-draft", sourceTurnId: foreign.id })).toThrow();
      const drafts = f.ui.listDrafts(f.intake.bigTask.projectId);
      expect(drafts.filter(item => !item.parentDraftId)).toEqual([draft]);
      expect(drafts.filter(item => item.parentDraftId === draft.id)).toEqual(f.ui.childDrafts(draft));
      expect(f.ui.childDrafts(draft)).toHaveLength(1);
      expect(f.ui.listDrafts(other.id)).toEqual([]);
    } finally { f.close(); }
  });

  it("persists actual CREATE_TASK and same-project SET_REVIEW_LEVEL effects without starting planning", () => {
    const f = fixture();
    try {
      const request = { requestId: "effects-create-set", scope: f.project, message: "Create a small task and use thorough review for the existing child" };
      const turn = f.ui.claimDiscussion(request).turn;
      const answer = reply([createAction(), { kind: "SET_REVIEW_LEVEL", scope: f.sub, expectedRevision: 0, reviewLevel: "THOROUGH" }]);
      const result = f.ui.finishDiscussion(turn.id, answer, { totalTokens: 45 }, null);
      expect(result).toMatchObject({ status: "SUCCEEDED", answer, usage: { totalTokens: 45 } });
      expect(result.effects).toHaveLength(2);
      const created = result.effects!.find(effect => effect.kind === "TASK_CREATED")!;
      const draft = f.ui.getDraft(created.targetId);
      expect(draft).toMatchObject({ projectId: f.intake.bigTask.projectId, kind: "SMALL_TASK", sourceTurnId: turn.id,
        suggestedBrief: brief(), reviewLevel: "LIGHT", confirmedBigTaskId: null, confirmation: null });
      expect(result.effects).toContainEqual(expect.objectContaining({ kind: "REVIEW_LEVEL_CHANGED", targetId: f.sub.id }));
      expect(f.ui.settings(f.sub)).toMatchObject({ revision: 1, reviewLevel: "THOROUGH" });
      expect(f.storage.listBigTasksByProject(f.intake.bigTask.projectId)).toHaveLength(1);
      expect(f.sql.prepare("SELECT count(*) AS count FROM live_planning_intakes").get()?.count).toBe(0);
      expect(f.sql.prepare("SELECT count(*) AS count FROM big_task_execution_approvals").get()?.count).toBe(0);
      expect(f.ui.claimDiscussion(request)).toMatchObject({ claimed: false, turn: result });
      expect(f.ui.finishDiscussion(turn.id, structuredClone(answer), { totalTokens: 45 }, null)).toEqual(result);
      expect(() => f.ui.finishDiscussion(turn.id, { ...answer, reply: "A different answer" }, { totalTokens: 45 }, null)).toThrow(expect.objectContaining({ code: "CONFLICT" }));
      expect(f.ui.listDrafts(f.intake.bigTask.projectId)).toHaveLength(1);
      expect(f.sql.prepare("SELECT count(*) AS count FROM console_settings_changes").get()?.count).toBe(1);
      f.reopen();
      const reopened = new ConsoleWorkspaceStore(f.storage);
      expect(reopened.turns(f.project).turns).toEqual([result]);
      expect(reopened.finishDiscussion(turn.id, structuredClone(answer), { totalTokens: 45 }, null)).toEqual(result);
      expect(reopened.listDrafts(f.intake.bigTask.projectId)).toHaveLength(1);
      expect(reopened.settings(f.sub)).toMatchObject({ revision: 1, reviewLevel: "THOROUGH" });
    } finally { f.close(); }
  });

  it.each(["settings", "related-task"] as const)("rejects a foreign-project %s action and rolls back preceding effects", kind => {
    const f = fixture();
    try {
      const other = f.storage.createProject(makeProject("prj_actions_other", "actions-other"));
      const foreignBig = f.storage.createBigTask(makeBigTask("bt_actions_other", other.id));
      const foreign: ConsoleScope = { kind: "BIG_TASK", id: foreignBig.id };
      const turn = f.ui.claimDiscussion({ requestId: `foreign-actions-${kind}`, scope: f.project, message: "Keep changes in this project" }).turn;
      const forbidden = kind === "settings"
        ? { kind: "SET_REVIEW_LEVEL" as const, scope: foreign, expectedRevision: 0, reviewLevel: "LIGHT" as const }
        : { ...createAction(), kind: "CREATE_TASK" as const, taskKind: "SMALL_TASK" as const, brief: brief(), suggestedSubtasks: [], relatedBigTaskId: foreignBig.id, reviewLevel: null };
      const result = f.ui.finishDiscussion(turn.id, reply([createAction(), forbidden]), { totalTokens: 27 }, null);
      expect(result).toMatchObject({ status: "FAILED", usage: { totalTokens: 27 } });
      expect(result.failureCode).not.toBeNull();
      expect(result.effects ?? []).toEqual([]);
      expect(f.ui.listDrafts(f.intake.bigTask.projectId)).toEqual([]);
      expect(f.ui.listDrafts(other.id)).toEqual([]);
      expect(f.ui.settings(foreign)).toMatchObject({ revision: 0, reviewLevel: null });
      expect(f.sql.prepare("SELECT count(*) AS count FROM console_settings_changes").get()?.count).toBe(0);
    } finally { f.close(); }
  });

  it("rolls back a preceding task creation when another action has a stale settings revision", () => {
    const f = fixture();
    try {
      f.ui.changeSettings({ requestId: "atomic-existing-level", scope: f.big, expectedRevision: 0, reviewLevel: "STANDARD" });
      const before = f.ui.settings(f.big);
      const turn = f.ui.claimDiscussion({ requestId: "atomic-stale-actions", scope: f.project, message: "Apply the requested changes together" }).turn;
      const answer = reply([createAction(), { kind: "SET_REVIEW_LEVEL", scope: f.big, expectedRevision: 0, reviewLevel: "THOROUGH" }]);
      const result = f.ui.finishDiscussion(turn.id, answer, { totalTokens: 31 }, null);
      expect(result).toMatchObject({ status: "FAILED", usage: { totalTokens: 31 } });
      expect(result.effects ?? []).toEqual([]);
      expect(f.ui.listDrafts(f.intake.bigTask.projectId)).toEqual([]);
      expect(f.ui.settings(f.big)).toEqual(before);
      expect(f.sql.prepare("SELECT count(*) AS count FROM console_settings_changes").get()?.count).toBe(1);
      expect(f.ui.finishDiscussion(turn.id, structuredClone(answer), { totalTokens: 31 }, null)).toEqual(result);
      expect(f.ui.listDrafts(f.intake.bigTask.projectId)).toEqual([]);
    } finally { f.close(); }
  });

  it("rolls back an earlier settings effect when draft persistence fails, and retains the failed turn's usage", () => {
    const f = fixture();
    try {
      f.sql.exec("CREATE TEMP TRIGGER qa_fail_draft_insert BEFORE INSERT ON console_drafts BEGIN SELECT RAISE(ABORT, 'Synthetic draft write failure'); END");
      const turn = f.ui.claimDiscussion({ requestId: "atomic-storage-fault", scope: f.project, message: "Change review and create a task" }).turn;
      const answer = reply([{ kind: "SET_REVIEW_LEVEL", scope: f.big, expectedRevision: 0, reviewLevel: "LIGHT" }, createAction()]);
      const result = f.ui.finishDiscussion(turn.id, answer, { totalTokens: 39 }, null);
      expect(result).toMatchObject({ status: "FAILED", usage: { totalTokens: 39 } });
      expect(result.effects ?? []).toEqual([]);
      expect(f.ui.settings(f.big)).toMatchObject({ revision: 0, reviewLevel: null });
      expect(f.ui.listDrafts(f.intake.bigTask.projectId)).toEqual([]);
      expect(f.sql.prepare("SELECT count(*) AS count FROM console_settings_changes").get()?.count).toBe(0);
      f.sql.exec("DROP TRIGGER qa_fail_draft_insert");
      expect(f.ui.finishDiscussion(turn.id, structuredClone(answer), { totalTokens: 39 }, null)).toEqual(result);
      expect(f.ui.listDrafts(f.intake.bigTask.projectId)).toEqual([]);
    } finally { f.close(); }
  });

  it("does not apply model actions from provider failure or malformed output", () => {
    const f = fixture();
    try {
      const first = f.ui.claimDiscussion({ requestId: "failed-provider-effects", scope: f.project, message: "Prepare a task" }).turn;
      const failed = f.ui.finishDiscussion(first.id, reply([createAction()]), null, "PROVIDER_FAILED");
      expect(failed).toMatchObject({ status: "FAILED", usage: null, failureCode: "PROVIDER_FAILED" });
      expect(failed.effects ?? []).toEqual([]);
      const second = f.ui.claimDiscussion({ requestId: "invalid-output-effects", scope: f.project, message: "Try a new discussion" }).turn;
      const malformed = f.ui.finishDiscussion(second.id, { ...reply([createAction()]), actions: [createAction(), { kind: "EXECUTE_NOW" }] }, { totalTokens: 17 }, null);
      expect(malformed).toMatchObject({ status: "FAILED", usage: { totalTokens: 17 }, failureCode: "INVALID_OUTPUT" });
      expect(malformed.effects ?? []).toEqual([]);
      expect(f.ui.listDrafts(f.intake.bigTask.projectId)).toEqual([]);
      expect(f.sql.prepare("SELECT count(*) AS count FROM console_settings_changes").get()?.count).toBe(0);
      expect(f.sql.prepare("SELECT count(*) AS count FROM big_task_execution_approvals").get()?.count).toBe(0);
    } finally { f.close(); }
  });
});
