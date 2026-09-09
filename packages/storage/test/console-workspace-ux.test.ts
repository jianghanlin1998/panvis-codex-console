import { BigTaskIdSchema } from "@codex-task-console/domain";
import { crc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import { ConsoleWorkspaceStore } from "../src/console-workspace.js";
import { makePlanningFixture } from "./live-planning-fixture.js";
import { executeBigTaskPlanningCodexForTest } from "../../codex-adapter/src/live-execution.js";
import { planningProviderFixture } from "../../codex-adapter/test/planning-provider-fixture.js";
import { BigTaskExecutionStore } from "../src/big-task-execution.js";
import { makeProject } from "./fixtures.js";
import { makeExecutionFixture } from "./big-task-execution-fixture.js";
import { getGovernedProviderBridge } from "../src/governed-execution-public.js";

const workflow = { planReview: "SELF", budgetMode: "MEASURE", planningTokenLimit: 1000, executionTokenLimit: 1000, durationMinutes: 180 } as const;
const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
// A valid ancillary PNG text chunk makes each stored image distinct without random data.
function distinctPng(index: number): string {
  const original = Buffer.from(png.split(",")[1]!, "base64");
  const text = Buffer.from(`Fixture\0${index}`, "utf8");
  const chunk = Buffer.concat([Buffer.from("tEXt", "ascii"), text]);
  const length = Buffer.alloc(4), checksum = Buffer.alloc(4);
  length.writeUInt32BE(text.length); checksum.writeUInt32BE(crc32(chunk));
  return `data:image/png;base64,${Buffer.concat([original.subarray(0, -12), length, chunk, checksum, original.subarray(-12)]).toString("base64")}`;
}

describe("Console task continuity and lighter preparation", () => {
  it("prepares one self-checked plan with unknown usage; candidate chat and screenshots survive plan changes and materialization", async () => {
    const f = makePlanningFixture();
    try {
      const ui = new ConsoleWorkspaceStore(f.storage);
      f.planning.accept({ ...f.intake, consoleWorkflow: workflow, consoleReviewPolicy: true });
      const peer = planningProviderFixture(() => f.proposal, { omitUsage: true });
      const planned = await executeBigTaskPlanningCodexForTest(f.storage, f.intake.bigTask.id, peer.dependencies);
      expect(planned).toMatchObject({ phase: "APPROVED", usageComplete: false, totalTokens: 0 });
      expect(planned.runs.map(run => run.role)).toEqual(["PLANNER"]);
      expect(f.storage.listSubtasksByBigTask(f.intake.bigTask.id)).toHaveLength(0);
      const candidate = ui.navigation(f.intake.bigTask.projectId)[0]!.subtasks[0]!;
      const scope = { kind: "SUBTASK", id: candidate.id } as const;
      expect(ui.subtaskRecord(candidate.id)?.materialized).toBe(false);
      const asset = ui.entries.saveAsset(f.intake.bigTask.projectId, scope, "example.png", png);
      ui.claimDiscussion({ requestId: "candidate-chat", scope, message: "Keep this task's original context", attachments: [asset] });
      ui.finishDiscussion("candidate-chat", { reply: "Understood", proposal: null }, null, null);
      ui.confirmContext({ requestId: "candidate-note", scope, title: "Layout", body: "Use the screenshot as visual reference." });
      const amended = ui.amendPlanReview({ requestId: "candidate-profile", bigTaskId: f.intake.bigTask.id, expectedBinding: ui.planningBinding(f.intake.bigTask.id), changes: [{ subtaskId: candidate.id, reviewLevel: "THOROUGH" }] });
      expect(f.planning.inspect(BigTaskIdSchema.parse(amended.bigTaskId)).phase).toBe("APPROVED");
      expect(f.planning.inspect(BigTaskIdSchema.parse(amended.bigTaskId)).runs).toHaveLength(0);
      const next = ui.navigation(f.intake.bigTask.projectId).find(task => task.id === amended.bigTaskId)!.subtasks[0]!;
      const nextScope = { kind: "SUBTASK", id: next.id } as const;
      expect(ui.context(nextScope).notes).toContainEqual(expect.objectContaining({ title: "Layout" }));
      expect(ui.roleContext(nextScope).turns).toContainEqual(expect.objectContaining({ id: "candidate-chat", attachments: [asset] }));
      const execution = new BigTaskExecutionStore(f.storage);
      const review = execution.review(BigTaskIdSchema.parse(amended.bigTaskId));
      execution.approve({ bigTaskId: amended.bigTaskId, planDigest: review.planDigest, repositoryHeadSha: review.repositoryHeadSha, limits: { durationMilliseconds: 60000, totalTokenLimit: 1000, roleCallLimit: 30, repairCycleLimit: 2, budgetMode: "MEASURE" } });
      execution.start(BigTaskIdSchema.parse(amended.bigTaskId));
      f.storage.materializeApprovedCanonicalTasks(BigTaskIdSchema.parse(amended.bigTaskId));
      expect(ui.subtaskRecord(next.id)?.materialized).toBe(true);
      expect(ui.context(nextScope).notes).toContainEqual(expect.objectContaining({ title: "Layout" }));
      f.reopen();
      const reopened = new ConsoleWorkspaceStore(f.storage);
      expect(reopened.entries.asset(f.intake.bigTask.projectId, asset.id).dataUrl).toBe(png);
      expect(reopened.turns(scope).turns[0]?.attachments).toEqual([asset]);
      expect(reopened.roleContext(nextScope).turns.some(turn => turn.id === "candidate-chat")).toBe(true);
    } finally { f.close(); }
  });
  it("keeps independent plan review when selected and keeps image ownership within a project", async () => {
    const f = makePlanningFixture();
    try {
      const ui = new ConsoleWorkspaceStore(f.storage), scope = { kind: "PROJECT", id: f.intake.bigTask.projectId } as const;
      const asset = ui.entries.saveAsset(scope.id, scope, "shot.png", png);
      expect(() => ui.entries.saveAsset(scope.id, scope, "spoof.png", "data:image/png;base64,YWJjZA==")).toThrow();
      f.storage.createProject(makeProject("prj_elsewhere", "elsewhere"));
      expect(() => ui.entries.asset("prj_elsewhere", asset.id)).toThrow();
      expect(() => ui.claimDiscussion({ requestId: "wrong-project", scope: { kind: "PROJECT", id: "prj_elsewhere" }, message: "See image", attachments: [asset] })).toThrow();
      f.planning.accept({ ...f.intake, consoleWorkflow: { ...workflow, planReview: "INDEPENDENT" } });
      const peer = planningProviderFixture(packet => packet.role === "PLANNER" ? f.proposal : { outcome: "APPROVE", questions: [], revisionRequirements: [], candidateBinding: packet.proposal!.candidateBinding, planRevision: packet.proposal!.candidate.revision });
      await executeBigTaskPlanningCodexForTest(f.storage, f.intake.bigTask.id, peer.dependencies);
      expect(f.planning.inspect(f.intake.bigTask.id)).toMatchObject({ phase: "READY", nextRole: "REVIEWER" });
      await executeBigTaskPlanningCodexForTest(f.storage, f.intake.bigTask.id, peer.dependencies);
      expect(f.planning.inspect(f.intake.bigTask.id).runs.map(run => run.role)).toEqual(["PLANNER", "REVIEWER"]);
      expect(f.planning.inspect(f.intake.bigTask.id).phase).toBe("APPROVED");
    } finally { f.close(); }
  });
  it("keeps child draft discussions separate and ends work without claiming QA acceptance", () => {
    const f = makePlanningFixture();
    try {
      const ui = new ConsoleWorkspaceStore(f.storage);
      const draft = ui.createDraft({ requestId: "children", projectId: f.intake.bigTask.projectId, kind: "BIG_TASK", title: "Board", goal: "Build board", suggestedSubtasks: [{ title: "Layout", goal: "Render board", scopeIn: ["UI"], scopeOut: [], successCriteria: ["Works"] }] });
      const child = ui.listDrafts(f.intake.bigTask.projectId).find(item => item.parentDraftId === draft.id)!;
      expect(child.kind).toBe("SMALL_TASK");
      const scope = { kind: "DRAFT", id: child.id } as const;
      ui.claimDiscussion({ requestId: "child-message", scope, message: "Card layout" });
      ui.finishDiscussion("child-message", { reply: "Discussed", proposal: null }, null, null);
      ui.changeSettings({ requestId: "end-child", scope, expectedRevision: 0, lifecycle: "ENDED", endOutcome: "STOPPED" });
      expect(ui.lifecycle(scope)).toBe("ENDED");
      expect(ui.turns({ kind: "DRAFT", id: draft.id }).turns).toHaveLength(0);
      expect(ui.turns(scope).turns[0]?.message).toBe("Card layout");
      expect(f.storage.listBigTasksByProject(f.intake.bigTask.projectId)).toHaveLength(0);
      ui.changeSettings({ requestId: "reopen-child", scope, expectedRevision: 1, lifecycle: "ACTIVE" });
      expect(ui.lifecycle(scope)).toBe("ACTIVE");
      expect(ui.turns(scope).turns).toHaveLength(1);
    } finally { f.close(); }
  });

  it("sends original candidate chat, screenshots and human notes to the actual replanning turn", async () => {
    const f = makePlanningFixture();
    try {
      const ui = new ConsoleWorkspaceStore(f.storage);
      f.planning.accept({ ...f.intake, consoleWorkflow: workflow, consoleReviewPolicy: true });
      const peer = planningProviderFixture(() => f.proposal);
      await executeBigTaskPlanningCodexForTest(f.storage, f.intake.bigTask.id, peer.dependencies);
      const projectScope = { kind: "PROJECT", id: f.intake.bigTask.projectId } as const;
      const oldImages = Array.from({ length: 6 }, (_, index) => distinctPng(index));
      const oldAssets = oldImages.map((image, index) => ui.entries.saveAsset(projectScope.id, projectScope, `old-${index}.png`, image));
      ui.claimDiscussion({ requestId: "replan-old-images", scope: projectScope, message: "Older project references", attachments: oldAssets });
      ui.finishDiscussion("replan-old-images", { reply: "Recorded", proposal: null }, null, null);
      const original = f.storage.getDurablePlanningReviewBundle(f.intake.bigTask.id)!.taskContracts[0]!;
      const scope = { kind: "SUBTASK", id: original.subtaskId } as const;
      const currentImage = distinctPng(6);
      const asset = ui.entries.saveAsset(projectScope.id, scope, "current-layout.png", currentImage);
      const message = "Replan this candidate around the newly supplied compact layout.";
      ui.claimDiscussion({ requestId: "replan-child-material", scope, message, attachments: [asset] });
      ui.finishDiscussion("replan-child-material", { reply: "ADVISORY_REPLY_NOT_ROLE_AUTHORITY", proposal: null }, null, null);
      ui.confirmContext({ requestId: "replan-child-note", scope, title: "Compact layout", body: "Keep the current screenshot's two-column layout." });
      const revised = ui.prepareAgain(f.intake.bigTask.id, "replan-retains-child-material");
      const planned = await executeBigTaskPlanningCodexForTest(f.storage, revised.bigTaskId, peer.dependencies);
      expect(planned.phase).toBe("APPROVED");
      expect(planned.runs.map(run => run.role)).toEqual(["PLANNER"]);
      const turns = peer.requests.filter(request => request.method === "turn/start");
      expect(turns).toHaveLength(2);
      const inputs = turns[1]!.params.input as Array<{ type: string; text?: string; url?: string }>;
      const packet = JSON.parse(inputs[0]!.text!) as { humanContext: ReturnType<ConsoleWorkspaceStore["roleContext"]> };
      expect(packet.humanContext.turns).toContainEqual(expect.objectContaining({ scope, id: "replan-child-material", message, attachments: [asset] }));
      expect(packet.humanContext.notes).toContainEqual(expect.objectContaining({ authority: "HUMAN", title: "Compact layout", body: "Keep the current screenshot's two-column layout." }));
      expect(JSON.stringify(packet.humanContext)).not.toContain("ADVISORY_REPLY_NOT_ROLE_AUTHORITY");
      const images = inputs.filter(input => input.type === "image").map(input => input.url);
      expect(images).toEqual([currentImage, ...oldImages.slice(0, 5)]);
      expect(ui.turns(scope).turns[0]?.attachments).toEqual([asset]);
    } finally { f.close(); }
  });

  it("keeps a current subtask screenshot ahead of six older project images in governed provider input", () => {
    const f = makeExecutionFixture(undefined, undefined, "STANDARD", { consoleWorkflow: workflow });
    try {
      const ui = new ConsoleWorkspaceStore(f.storage);
      const projectScope = { kind: "PROJECT", id: f.intake.bigTask.projectId } as const;
      const oldImages = Array.from({ length: 6 }, (_, index) => distinctPng(index));
      const oldAssets = oldImages.map((image, index) => ui.entries.saveAsset(projectScope.id, projectScope, `old-${index}.png`, image));
      ui.claimDiscussion({ requestId: "governed-old-images", scope: projectScope, message: "Older project references", attachments: oldAssets });
      ui.finishDiscussion("governed-old-images", { reply: "Recorded", proposal: null }, null, null);
      const candidate = f.storage.getDurablePlanningReviewBundle(f.intake.bigTask.id)!.taskContracts[0]!;
      const scope = { kind: "SUBTASK", id: candidate.subtaskId } as const;
      const currentImage = distinctPng(6);
      const asset = ui.entries.saveAsset(projectScope.id, scope, "latest-task.png", currentImage);
      expect(new Set([...oldAssets, asset].map(item => item.id)).size).toBe(7);
      ui.claimDiscussion({ requestId: "governed-current-image", scope, message: "Use this current task screenshot", attachments: [asset] });
      ui.finishDiscussion("governed-current-image", { reply: "Recorded", proposal: null }, null, null);
      f.execution.approve(f.approval); f.execution.start(f.approval.bigTaskId);
      const prepared = f.governed.prepareNextRole(f.approval.bigTaskId);
      if (prepared.kind !== "ROLE_AUTHORIZED") throw new Error("Expected the first governed role to be authorized");
      expect(prepared.authorization.subtaskId).toBe(scope.id);
      const bridge = getGovernedProviderBridge(f.governed);
      bridge.reserveRoleExecutionAttempt(prepared.authorization.authorizationId);
      const input = bridge.resolveRoleExecutionInput(prepared.authorization.authorizationId);
      expect(input.images).toEqual([currentImage, ...oldImages.slice(0, 5)]);
      expect(input.preflight.text).toContain("Use this current task screenshot");
      expect(f.starts).toHaveLength(0);
    } finally { f.close(); }
    // Real temporary Git/worktree preparation; business time remains fixture-controlled.
  }, 15_000);

  it("describes a SELF chat amendment without promising an independent reviewer", async () => {
    const f = makePlanningFixture();
    try {
      const ui = new ConsoleWorkspaceStore(f.storage);
      f.planning.accept({ ...f.intake, consoleWorkflow: workflow, consoleReviewPolicy: true });
      const peer = planningProviderFixture(() => f.proposal);
      await executeBigTaskPlanningCodexForTest(f.storage, f.intake.bigTask.id, peer.dependencies);
      const scope = { kind: "BIG_TASK", id: f.intake.bigTask.id } as const;
      const original = f.storage.getDurablePlanningReviewBundle(scope.id)!.reviewState.candidate.subtasks[0]!;
      ui.claimDiscussion({ requestId: "self-review-chat", scope, message: "Change the first candidate to basic verification." });
      const turn = ui.finishDiscussion("self-review-chat", { reply: "The requested review depth is ready to save.", proposal: null,
        actions: [{ kind: "AMEND_PLAN_REVIEW", bigTaskId: scope.id, expectedBinding: ui.planningBinding(scope.id), changes: [{ subtaskId: original.id, reviewLevel: "LIGHT" }] }] }, { totalTokens: 10 }, null);
      expect(turn.status).toBe("SUCCEEDED");
      expect(turn.effects).toHaveLength(1);
      const effect = turn.effects![0]!;
      expect(effect.kind).toBe("PLAN_REVIEW_CHANGED");
      expect(effect.description).not.toMatch(/等待.*独立/);
      const id = BigTaskIdSchema.parse(effect.targetId);
      expect(f.planning.inspect(id)).toMatchObject({ phase: "APPROVED", runs: [], nextRole: null });
      expect(f.planning.readIntake(id).intake.consoleWorkflow?.planReview).toBe("SELF");
      expect(f.storage.getDurablePlanningReviewBundle(id)!.reviewState.candidate.subtasks[0]!.profile).toBe("LOW");
      expect(f.storage.getDurablePlanningReviewBundle(scope.id)!.reviewState.candidate.subtasks[0]!.profile).toBe("STANDARD");
      expect(peer.launches).toHaveLength(1);
    } finally { f.close(); }
  });
});
