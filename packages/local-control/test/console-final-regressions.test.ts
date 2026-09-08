import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { BigTaskIdSchema, ProviderModelReferenceSchema, ProviderRunReferenceSchema, ProviderThreadReferenceSchema, SubtaskIdSchema } from "@codex-task-console/domain";
import type { BigTaskId, ConsoleDiscussionAnswer } from "@codex-task-console/domain";
import type { executeConsoleDiscussionCodex } from "@codex-task-console/codex-adapter";
import { ConsoleApplication } from "../src/console-application.js";
import type { LocalControlService } from "../src/service.js";
import { ConsoleWorkspaceStore } from "../../storage/src/console-workspace.js";
import { makePlanningFixture } from "../../storage/test/live-planning-fixture.js";
import { makeBigTask, makeProject } from "../../storage/test/fixtures.js";

const forbidden = async (): Promise<never> => { throw new Error("No live provider or execution in Console regression tests"); };
const baseService: LocalControlService = { inspectSubtask: forbidden, provisionOwnedWorktree: forbidden, runOwnedWorktreeExecution: forbidden, releaseOwnedWorktree: forbidden };
const brief = () => ({ title: "Follow-up from this discussion", goal: "Preserve the agreed result", scopeIn: ["One bounded change"], scopeOut: ["Deployment"], successCriteria: ["The result is inspectable"] });
const answer = (actions: NonNullable<ConsoleDiscussionAnswer["actions"]>): ConsoleDiscussionAnswer => ({ reply: "Prepared the requested changes.", proposal: null, actions });
type DiscussionResult = Awaited<ReturnType<typeof executeConsoleDiscussionCodex>>;
const success = (actions: NonNullable<ConsoleDiscussionAnswer["actions"]>): DiscussionResult => ({ success: true, agentResponseText: JSON.stringify(answer(actions)), normalizedUsage: { totalTokens: 25 }, failureCode: null } as DiscussionResult);
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
const settle = async (predicate: () => boolean) => { for (let attempt = 0; attempt < 100 && !predicate(); attempt++) await Promise.resolve(); expect(predicate()).toBe(true); };
const propose = (f: ReturnType<typeof makePlanningFixture>, id: BigTaskId) => {
  const run = f.planning.claim(id);
  const providerThread = ProviderThreadReferenceSchema.parse({ providerId: "codex-app-server", providerThreadId: `regression-${id}` });
  f.planning.observe(id, run.sequence, { providerThread,
    providerRun: ProviderRunReferenceSchema.parse({ ...providerThread, providerRunId: "turn-one" }),
    model: ProviderModelReferenceSchema.parse({ providerId: "codex-app-server", providerModelId: "fixture" }), normalizedUsage: { totalTokens: 10 } });
  expect(f.planning.finish(id, run.sequence, true, JSON.stringify({ ...f.proposal, tasks: [f.proposal.tasks[0]], dependencies: [] })).phase).toBe("READY");
};

describe("Console final QA regression boundaries", () => {
  it("retains original small-task draft, relationship and direction discussion across two immutable amendments and reopen", () => {
    const f = makePlanningFixture();
    try {
      const store = new ConsoleWorkspaceStore(f.storage);
      const parent = f.storage.createBigTask(f.intake.bigTask);
      const draft = store.createDraft({ requestId: "final-source-draft", projectId: parent.projectId, relatedBigTaskId: parent.id, kind: "SMALL_TASK", title: brief().title, goal: brief().goal });
      const confirmed = store.confirmDirection({ draftId: draft.id, revision: 0, brief: brief(), reviewIntensity: "STANDARD", planningTokenLimit: 120_000 });
      const original = confirmed.confirmedBigTaskId!;
      propose(f, original);
      let current = original;
      for (const requestId of ["final-source-second", "final-source-third"]) {
        current = BigTaskIdSchema.parse(store.amendPlanReview({ requestId, bigTaskId: current, expectedBinding: store.planningBinding(current),
          changes: [{ subtaskId: f.storage.getDurablePlanningReviewBundle(current)!.reviewState.candidate.subtasks[0]!.id, reviewLevel: "LIGHT" }] }).bigTaskId);
        expect(store.sourceDraft(current)).toEqual(confirmed);
        expect(store.navigation(parent.projectId).find(task => task.id === current)).toMatchObject({ taskKind: "SMALL_TASK", relatedBigTaskId: parent.id });
      }
      expect(store.getDraft(draft.id)?.confirmedBigTaskId).toBe(original);
      f.reopen();
      expect(new ConsoleWorkspaceStore(f.storage).sourceDraft(current)).toEqual(confirmed);
    } finally { f.close(); }
  });

  it("offers project-level review settings without a global control that cannot affect new work", () => {
    const source = readFileSync(new URL("../web/app.js", import.meta.url), "utf8").split("root.addEventListener('submit'")[0]!;
    const ui = runInNewContext(source + "\n({ settings })", { document: { getElementById: () => ({}) }, localStorage: { getItem: () => "THOROUGH" } }) as { settings(): string };
    const html = ui.settings();
    expect(html).toContain("项目总览设置默认值");
    expect(html).not.toContain('name="reviewIntensity"');
    expect(html).toContain('name="theme"');
  });

  it("starts every saved review amendment after a full discussion slot drains, with no duplicate queued run", async () => {
    const f = makePlanningFixture();
    const holds = new Map<BigTaskId, ReturnType<typeof deferred<void>>>();
    let active = 0; let maximum = 0;
    const runPlanning = vi.fn(async (id: BigTaskId) => {
      active++; maximum = Math.max(maximum, active);
      const hold = deferred<void>(); holds.set(id, hold);
      await hold.promise; active--;
      return f.planning.inspect(id);
    });
    const discussion = deferred<DiscussionResult>();
    const discuss = vi.fn<typeof executeConsoleDiscussionCodex>(() => discussion.promise);
    const ui = new ConsoleApplication(f.storage, { ...baseService, inspectPlanning: async id => f.planning.inspect(id), runPlanning }, { discuss });
    try {
      const occupied = [0, 1, 2].map(index => BigTaskIdSchema.parse(`bt_final_occupied_${index}`));
      const targets = [0, 1].map(index => BigTaskIdSchema.parse(`bt_final_amend_${index}`));
      for (const id of [...occupied, ...targets]) f.planning.accept({ ...f.intake, bigTask: makeBigTask(id, f.intake.bigTask.projectId), consoleReviewPolicy: true });
      for (const id of targets) propose(f, id);
      for (const id of occupied) await ui.request("planning-start", { bigTaskId: id });
      const scope = { kind: "PROJECT" as const, id: f.intake.bigTask.projectId };
      await ui.request("discuss", { requestId: "final-full-slot-chat", scope, message: "Change review levels on both pending plans" });
      expect(runPlanning).toHaveBeenCalledTimes(3); expect(discuss).toHaveBeenCalledOnce();
      discussion.resolve(success(targets.map(id => ({ kind: "AMEND_PLAN_REVIEW", bigTaskId: id, expectedBinding: ui.store.planningBinding(id)!,
        changes: [{ subtaskId: f.storage.getDurablePlanningReviewBundle(id)!.reviewState.candidate.subtasks[0]!.id, reviewLevel: "LIGHT" }] }))));
      await settle(() => runPlanning.mock.calls.length === 4);
      const turn = ui.store.turns(scope).turns[0]!;
      expect(turn).toMatchObject({ status: "SUCCEEDED", failureCode: null, usage: { totalTokens: 25 } });
      const next = turn.effects!.map(effect => BigTaskIdSchema.parse(effect.targetId));
      expect(next).toHaveLength(2);
      expect(runPlanning.mock.calls[3]![0]).toBe(next[0]);
      expect(await ui.request("task", { bigTaskId: next[1] })).toMatchObject({ planningActive: true, planning: { phase: "READY", nextRole: "REVIEWER" } });
      await ui.request("planning-start", { bigTaskId: next[1] });
      expect(runPlanning).toHaveBeenCalledTimes(4);
      holds.get(next[0]!)!.resolve();
      await settle(() => runPlanning.mock.calls.length === 5);
      expect(runPlanning.mock.calls.map(call => call[0])).toEqual([...occupied, ...next]);
      expect(maximum).toBe(4);
      expect(ui.store.turns(scope).turns[0]).toEqual(turn);
    } finally {
      for (const hold of holds.values()) hold.resolve();
      await ui.stop(); f.close();
    }
  });

  it("keeps bootstrap below the HTTP envelope when retained draft bodies exceed one MiB", async () => {
    const f = makePlanningFixture();
    const ui = new ConsoleApplication(f.storage, baseService, { discuss: forbidden });
    try {
      const body = "BODY_ONLY_" + "x".repeat(980);
      const large = { ...brief(), scopeIn: Array(12).fill(body), scopeOut: Array(12).fill(body), successCriteria: Array(12).fill(body) };
      for (let index = 0; index < 12; index++) ui.store.createDraft({ requestId: `final-large-draft-${index}`, projectId: f.intake.bigTask.projectId,
        kind: "BIG_TASK", title: `Draft ${index}`, goal: large.goal, suggestedBrief: large, suggestedSubtasks: [large, large] });
      expect(Buffer.byteLength(JSON.stringify(ui.store.listDrafts(f.intake.bigTask.projectId)), "utf8")).toBeGreaterThan(1024 * 1024);
      const result = await ui.request("workspace", {});
      expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThan(850_100);
      expect(JSON.stringify(result)).not.toContain("BODY_ONLY_");
      expect(result).toMatchObject({ projects: [{ drafts: expect.arrayContaining([expect.objectContaining({ title: "Draft 11" })]), directoryTruncated: false }] });
      expect(ui.store.listDrafts(f.intake.bigTask.projectId)).toHaveLength(12);
    } finally { await ui.stop(); f.close(); }
  });

  it("bounds a large navigation directory and preserves an explicit route to omitted tasks", async () => {
    const f = makePlanningFixture();
    const ui = new ConsoleApplication(f.storage, baseService, { discuss: forbidden });
    try {
      f.planning.accept({ ...f.intake, consoleReviewPolicy: true }); propose(f, f.intake.bigTask.id);
      const template = ui.store.navigation(f.intake.bigTask.projectId)[0]!;
      const inventory = Array.from({ length: 200 }, (_, task) => ({ ...template, id: BigTaskIdSchema.parse(`bt_final_directory_${task}`),
        subtasks: Array.from({ length: 24 }, (_, subtask) => ({ ...template.subtasks[0]!, id: SubtaskIdSchema.parse(`st_final_directory_${task}_${subtask}`), title: "任".repeat(200) })) }));
      vi.spyOn(ui.store, "navigation").mockReturnValue(inventory);
      const result = await ui.request("workspace", {}) as { projects: Array<{ id: string; tasks: unknown[]; directoryTruncated: boolean }> };
      expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThan(850_100);
      expect(result.projects[0]).toMatchObject({ id: f.intake.bigTask.projectId, directoryTruncated: true });
      expect(result.projects[0]!.tasks.length).toBeGreaterThan(0);
      expect(result.projects[0]!.tasks.length).toBeLessThan(inventory.length);
    } finally { await ui.stop(); f.close(); }
  });

  it("supplies real draft IDs, revisions and saved effects to subsequent discussion without crossing projects", () => {
    const f = makePlanningFixture();
    try {
      const store = new ConsoleWorkspaceStore(f.storage);
      const projectId = f.intake.bigTask.projectId;
      const scope = { kind: "PROJECT" as const, id: projectId };
      const foreign = f.storage.createProject(makeProject("prj_final_foreign", "final-foreign"));
      store.createDraft({ requestId: "final-foreign-draft", projectId: foreign.id, kind: "SMALL_TASK", title: "FOREIGN_DRAFT_CANARY", goal: "Excluded" });
      for (let index = 0; index < 41; index++) store.createDraft({ requestId: `final-older-draft-${index}`, projectId, kind: "SMALL_TASK", title: `Older ${index}`, goal: "Older work" });
      const created = store.claimDiscussion({ requestId: "final-create-from-chat", scope, message: "Create a LIGHT task" }).turn;
      const completed = store.finishDiscussion(created.id, answer([{ kind: "CREATE_TASK", taskKind: "SMALL_TASK", brief: brief(), suggestedSubtasks: [], relatedBigTaskId: null, reviewLevel: "LIGHT" }]), { totalTokens: 25 }, null);
      const draftId = completed.effects![0]!.targetId;
      const next = store.claimDiscussion({ requestId: "final-change-from-chat", scope, message: "Make the draft just created THOROUGH" });
      const packet = JSON.parse(next.inputText) as { drafts: Array<{ id: string; settings: { revision: number; effectiveReviewLevel: string } }>; history: Array<{ effects: unknown[] }> };
      expect(packet.drafts).toHaveLength(40);
      const target = packet.drafts.find(draft => draft.id === draftId)!;
      expect(target).toMatchObject({ id: draftId, settings: { revision: 0, effectiveReviewLevel: "LIGHT" } });
      expect(packet.history[0]!.effects).toEqual(completed.effects);
      expect(next.inputText).not.toContain("FOREIGN_DRAFT_CANARY");
      store.finishDiscussion(next.turn.id, answer([{ kind: "SET_REVIEW_LEVEL", scope: { kind: "DRAFT", id: target.id }, expectedRevision: target.settings.revision, reviewLevel: "THOROUGH" }]), { totalTokens: 20 }, null);
      f.reopen();
      const reopened = new ConsoleWorkspaceStore(f.storage);
      expect(reopened.settings({ kind: "DRAFT", id: draftId })).toMatchObject({ revision: 1, effectiveReviewLevel: "THOROUGH" });
      expect(reopened.turns(scope).turns[0]!.effects).toEqual(completed.effects);
    } finally { f.close(); }
  });
});
