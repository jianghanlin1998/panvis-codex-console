import { LivePlanningStore } from "@codex-task-console/storage";
import { chooseProjectFolder, inspectProjectFolder } from "./project-folder.js";
import { ResultPreviews } from "./result-preview.js";
import { execFile } from "node:child_process";
import { devNull } from "node:os";
import { isAbsolute } from "node:path";
import { realpathSync, lstatSync } from "node:fs";
import {
  ConsoleScopeSchema, BigTaskExecutionAcceptanceSchema, BigTaskIdSchema, executionUsageSettled, executionTokenLimitReached, ConsoleDiscussionInputSchema,
  ConsoleProjectCreateSchema, CONSOLE_DISCUSSION_OUTPUT_SCHEMA, ProjectIdSchema, SubtaskIdSchema,
} from "@codex-task-console/domain";
import { executeConsoleDiscussionCodex } from "@codex-task-console/codex-adapter";
import { BigTaskExecutionStore, ConsoleWorkspaceStore, TaskStorageError } from "@codex-task-console/storage";
import type { TaskStorage } from "@codex-task-console/storage";
import type { LocalControlService } from "./service.js";

export interface ConsoleApplicationDependencies { readonly discuss: typeof executeConsoleDiscussionCodex; readonly previews?: ResultPreviews; readonly chooseFolder?: typeof chooseProjectFolder; }
const invalid = (): never => { throw new TaskStorageError("INVALID_INPUT", "Invalid Console request."); };
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : invalid();
const exact = (value: unknown, keys: readonly string[]) => {
  const record = object(value);
  if (Object.keys(record).some(key => !keys.includes(key))) invalid();
  return record;
};

export class ConsoleApplication {
  readonly store: ConsoleWorkspaceStore;
  readonly #previews: ResultPreviews;
  readonly #jobs = new Map<string, Promise<unknown>>();
  readonly #queued = new Map<string, () => Promise<unknown>>();
  #stopping = false;
  constructor(private readonly storage: TaskStorage, private readonly service: LocalControlService,
    private readonly dependencies: ConsoleApplicationDependencies = { discuss: executeConsoleDiscussionCodex }) {
    this.store = new ConsoleWorkspaceStore(storage);
    this.#previews = dependencies.previews ?? new ResultPreviews();
  }
  async stop(): Promise<void> { this.#stopping = true; this.#queued.clear(); await Promise.allSettled(this.#jobs.values()); await this.#previews.stopAll(); }
  #schedule(id: string, job: () => Promise<unknown>) {
    if (this.#jobs.has(id) || this.#queued.has(id)) return;
    if (this.#stopping) throw new TaskStorageError("CONFLICT", "Console is stopping.");
    this.#queued.set(id, job); this.#drain();
  }
  #drain() {
    while (!this.#stopping && this.#jobs.size < 4 && this.#queued.size) {
      const [id, job] = this.#queued.entries().next().value!;
      this.#queued.delete(id);
      const promise = Promise.resolve().then(job).finally(() => { this.#jobs.delete(id); this.#drain(); });
      this.#jobs.set(id, promise);
      void promise.catch(() => undefined);
    }
  }
  async #advanceTask(input: unknown, requestId: string) {
    const { scope } = this.store.resolveScope(input);
    if (scope.kind !== "BIG_TASK" && scope.kind !== "SUBTASK") invalid();
    const id = BigTaskIdSchema.parse(scope.kind === "BIG_TASK" ? scope.id : this.store.subtaskRecord(scope.id)!.task.bigTaskId);
    const own = this.store.settings(scope);
    if (own.lifecycle === "ENDED") throw new TaskStorageError("CONFLICT", "Reopen the ended task before continuing.");
    if (own.lifecycle === "PAUSED") await this.request("lifecycle-change", { scope, requestId, expectedRevision: own.revision, lifecycle: "ACTIVE" });
    if (this.store.lifecycle(scope) !== "ACTIVE") throw new TaskStorageError("CONFLICT", "The parent task or project is paused or ended.");
    const presence = this.store.taskPresence(id);
    if (presence.execution) {
      const state = await this.service.inspectExecution!(id);
      if (["APPROVED", "PAUSED"].includes(state.phase)) await this.request("execution-start", { bigTaskId: id });
      else if (state.phase !== "RUNNING") throw new TaskStorageError("CONFLICT", "This execution needs its current recovery or acceptance action.");
      return { kind: "TASK_ADVANCED" as const, targetId: scope.id, description: scope.kind === "SUBTASK" ? "已继续此小任务；按原计划的依赖和检查安排执行。" : "已继续已获批准的任务。" };
    }
    if (!presence.planning) invalid();
    const planning = await this.service.inspectPlanning!(id);
    if (planning.phase === "APPROVED") return { kind: "EXECUTION_CONFIRMATION_REQUIRED" as const, targetId: id, description: "计划已准备好。查看并确认计划后开始实施 →" };
    if (planning.phase === "HUMAN_REQUIRED") {
      const result = this.store.prepareAgain(id, requestId);
      if (new LivePlanningStore(this.storage).inspect(result.bigTaskId).phase === "READY") this.#schedule(`planning:${result.bigTaskId}`, () => this.service.runPlanning!(result.bigTaskId));
      return { kind: "TASK_ADVANCED" as const, targetId: result.bigTaskId, description: "已沿用现有要求和小任务重新准备计划；原讨论保留，实施尚未开始。" };
    }
    await this.request("planning-start", { bigTaskId: id });
    return { kind: "TASK_ADVANCED" as const, targetId: id, description: "计划准备已在进行；完成后会展示待确认的执行计划。" };
  }
  async request(action: string, input: unknown): Promise<object> {
    const data = object(input);
    if (action === "workspace") {
      exact(input, []);
      const projects = this.storage.listProjects();
      const directory = projects.slice(0, 200).map(project => ({ ...project, settings: this.store.settings({ kind: "PROJECT", id: project.id }),
        tasks: this.store.navigation(project.id).map(task => ({ id: task.id, title: task.title.slice(0, 200), status: task.status, lifecycle: task.lifecycle, closed: task.closed, taskKind: task.taskKind, presentation: task.presentation,
          subtasks: task.subtasks.map(subtask => ({ id: subtask.id, title: subtask.title.slice(0, 200), status: subtask.status, lifecycle: subtask.lifecycle, stage: subtask.stage, materialized: subtask.materialized })) })),
        drafts: this.store.listDrafts(project.id).filter(draft => !draft.confirmedBigTaskId && !draft.parentDraftId).map(draft => ({ id: draft.id, title: draft.title, confirmedBigTaskId: null, children: this.store.childDrafts(draft).map(child => ({ id: child.id, title: child.title })) })), directoryTruncated: false }));
      // The bootstrap directory never includes task bodies or provider/planning transcripts.
      while (Buffer.byteLength(JSON.stringify(directory), "utf8") > 850_000) {
        const largest = [...directory].sort((a, b) => b.tasks.length + b.drafts.length - a.tasks.length - a.drafts.length)[0];
        if (!largest || !largest.tasks.length && !largest.drafts.length) break;
        if (largest.tasks.length >= largest.drafts.length) largest.tasks.pop(); else largest.drafts.pop();
        largest.directoryTruncated = true;
      }
      return { projects: directory, hasMore: projects.length > 200 };
    }
    if (action === "project") {
      exact(input, ["projectId"]);
      const id = ProjectIdSchema.parse(data.projectId);
      const project = this.storage.getProjectById(id);
      if (!project) throw new TaskStorageError("PARENT_NOT_FOUND", "Project unavailable.");
      return { project, drafts: this.store.listDrafts(id).filter(draft => !draft.parentDraftId).map(draft => ({ ...draft, settings: this.store.settings({ kind: "DRAFT", id: draft.id }), children: this.store.childDrafts(draft).map(child => ({ id: child.id, title: child.title })) })), settings: this.store.settings({ kind: "PROJECT", id }), bigTasks: this.store.navigation(id).slice(0, 200) };
    }
    if (action === "folder-choose") {
      exact(input, []);
      const path = await (this.dependencies.chooseFolder ?? chooseProjectFolder)();
      return path ? inspectProjectFolder(path) : { cancelled: true };
    }
    if (action === "folder-inspect") {
      exact(input, ["path"]); if (typeof data.path !== "string") invalid();
      return inspectProjectFolder(String(data.path));
    }
    if (action === "asset-save" || action === "asset-get") {
      exact(input, action === "asset-save" ? ["scope", "name", "dataUrl"] : ["scope", "id"]);
      const { scope, projectId } = this.store.resolveScope(data.scope);
      if (action === "asset-get") { if (typeof data.id !== "string") invalid(); return this.store.entries.asset(projectId, String(data.id)); }
      if (typeof data.name !== "string" || typeof data.dataUrl !== "string") invalid();
      return this.store.entries.saveAsset(projectId, scope, String(data.name), String(data.dataUrl));
    }
    if (action === "lifecycle-change") {
      exact(input, ["requestId", "scope", "expectedRevision", "lifecycle", "endOutcome"]);
      const result = this.store.changeSettings(input);
      const { scope, projectId } = this.store.resolveScope(data.scope);
      const affected = scope.kind === "PROJECT" ? this.store.navigation(projectId).map(task => task.id)
        : scope.kind === "BIG_TASK" ? [BigTaskIdSchema.parse(scope.id)] : scope.kind === "SUBTASK" ? [this.store.subtaskRecord(scope.id)!.task.bigTaskId] : [];
      if (data.lifecycle !== "ACTIVE") for (const id of affected) {
        this.#queued.delete(`planning:${id}`);
        if (this.store.taskPresence(id).execution) {
          const running = await this.service.inspectExecution!(id);
          if (running.phase === "RUNNING" && (scope.kind !== "SUBTASK" || !running.activeRole || running.activeRole.subtaskId === scope.id)) await this.service.pauseExecution!(id);
        }
      }
      if (data.lifecycle === "ACTIVE" && scope.kind !== "PROJECT" && this.store.lifecycle(scope) === "ACTIVE") {
        for (const id of affected) {
          if (this.store.taskPresence(id).execution) {
            const current = await this.service.inspectExecution!(id);
            if (current.activeRoleCount === 0 && ["APPROVED", "PAUSED"].includes(current.phase) && (current.expiresAt === null || Date.parse(current.expiresAt) > Date.parse(this.store.now())) && executionUsageSettled(current) && !executionTokenLimitReached(current)) await this.service.startExecution!(id);
          } else if (this.store.taskPresence(id).planning) {
            const current = await this.service.inspectPlanning!(id);
            if (current.phase === "READY") this.#schedule(`planning:${id}`, () => this.service.runPlanning!(id));
          }
        }
      }
      return result;
    }
    if (action === "task-advance") {
      exact(input, ["scope", "requestId"]);
      if (typeof data.requestId !== "string") invalid();
      return this.#advanceTask(ConsoleScopeSchema.parse(data.scope), String(data.requestId));
    }
    if (action === "planning-retry") {
      exact(input, ["bigTaskId", "requestId"]);
      if (typeof data.bigTaskId !== "string" || typeof data.requestId !== "string") invalid();
      const result = this.store.prepareAgain(String(data.bigTaskId), String(data.requestId));
      if (new LivePlanningStore(this.storage).inspect(result.bigTaskId).phase === "READY") this.#schedule(`planning:${result.bigTaskId}`, () => this.service.runPlanning!(result.bigTaskId));
      return result;
    }
    if (action === "project-create") {
      const parsed = ConsoleProjectCreateSchema.parse(input);
      if (!isAbsolute(parsed.repositoryPath)) invalid();
      const path = realpathSync(parsed.repositoryPath);
      if (!lstatSync(path).isDirectory() || path !== parsed.repositoryPath) invalid();
      const git = (args: string[]) => new Promise<string>((resolve, reject) => {
        execFile("git", ["-C", path, "-c", "core.fsmonitor=false", "-c", `core.hooksPath=${devNull}`, ...args],
          { timeout: 5000, maxBuffer: 8000, encoding: "utf8", shell: false, env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: devNull, GIT_TERMINAL_PROMPT: "0" } },
          (error, stdout) => error ? reject(new TaskStorageError("INVALID_INPUT", "Choose a Git repository root and an existing local branch.")) : resolve(stdout.trim()));
      });
      if (await git(["rev-parse", "--show-toplevel"]) !== path) invalid();
      await git(["check-ref-format", `refs/heads/${parsed.defaultBranch}`]);
      await git(["rev-parse", "--verify", "--end-of-options", `refs/heads/${parsed.defaultBranch}^{commit}`]);
      return this.store.createProject(parsed);
    }
    if (action === "draft-create") return this.store.createDraft(input);
    if (action === "draft") {
      exact(input, ["draftId"]);
      if (typeof data.draftId !== "string") return invalid();
      const draft = this.store.getDraft(data.draftId);
      if (!draft) throw new TaskStorageError("PARENT_NOT_FOUND", "Draft unavailable.");
      return { ...draft, children: this.store.childDrafts(draft), settings: this.store.settings({ kind: "DRAFT", id: draft.id }) };
    }
    if (action === "plan-review-change") {
      const result = this.store.amendPlanReview(input);
      this.#schedule(`planning:${result.bigTaskId}`, () => this.service.runPlanning!(BigTaskIdSchema.parse(result.bigTaskId)));
      return result;
    }
    if (action === "scope-settings") { exact(input, ["scope"]); return this.store.settings(data.scope); }
    if (action === "settings-change") return this.store.changeSettings(input);
    if (action === "direction-confirm") return this.store.confirmDirection(input);
    if (action === "context") { exact(input, ["scope"]); return this.store.context(data.scope); }
    if (action === "context-confirm") return this.store.confirmContext(input);
    if (action === "discussion") {
      exact(input, ["scope", "after"]);
      if (data.after !== undefined && typeof data.after !== "number") return invalid();
      return this.store.turns(data.scope, data.after);
    }
    if (action === "discuss") {
      const parsed = ConsoleDiscussionInputSchema.parse(input);
      if (this.#stopping || this.#jobs.size >= 4) throw new TaskStorageError("CONFLICT", "Console is busy.");
      const claim = this.store.claimDiscussion(parsed);
      if (claim.claimed) this.#schedule(`discussion:${claim.turn.id}`, async () => {
        try {
          const remaining = () => this.#stopping ? 0 : Math.max(0, 1_200_000 - (Date.parse(this.store.now()) - Date.parse(claim.turn.createdAt)));
          const result = await this.dependencies.discuss(this.storage, claim.inputText, CONSOLE_DISCUSSION_OUTPUT_SCHEMA as Parameters<typeof executeConsoleDiscussionCodex>[2], remaining);
          let answer: unknown = null;
          if (result.success && result.agentResponseText) { try { answer = JSON.parse(result.agentResponseText); } catch { /* Persist invalid output. */ } }
          const failureCode = result.failureCode === "TURN_FAILED" ? result.diagnostics?.providerFailureCode ?? result.failureCode : result.failureCode;
          const finished = this.store.finishDiscussion(claim.turn.id, answer, result.normalizedUsage, failureCode);
          for (const effect of finished.effects ?? []) if (effect.kind === "PLAN_REVIEW_CHANGED") {
            const id = BigTaskIdSchema.parse(effect.targetId);
            this.#schedule(`planning:${id}`, () => this.service.runPlanning!(id));
          }
          for (const [index, effect] of (finished.effects ?? []).entries()) {
            if (effect.kind !== "TASK_ADVANCE_REQUESTED" && effect.kind !== "TASK_PAUSE_REQUESTED") continue;
            const scope = BigTaskIdSchema.safeParse(effect.targetId).success
              ? { kind: "BIG_TASK" as const, id: effect.targetId } : { kind: "SUBTASK" as const, id: effect.targetId };
            try {
              if (effect.kind === "TASK_ADVANCE_REQUESTED") this.store.completeTaskAction(finished.id, index, await this.#advanceTask(scope, `chat_advance_${finished.id}_${index}`));
              else {
                const settings = this.store.settings(scope);
                if (settings.lifecycle === "ENDED") throw new TaskStorageError("CONFLICT", "This task has ended.");
                await this.request("lifecycle-change", { scope, requestId: `chat_pause_${finished.id}_${index}`, expectedRevision: settings.revision, lifecycle: "PAUSED" });
                this.store.completeTaskAction(finished.id, index, { kind: "TASK_PAUSED", targetId: scope.id, description: "已请求暂停；正在执行的步骤会在安全边界保存后停止。" });
              }
            } catch {
              this.store.completeTaskAction(finished.id, index, { kind: "TASK_ACTION_FAILED", targetId: scope.id, description: "此次推进或暂停未完成。请查看任务当前状态；已结束任务需要先重新打开，父任务暂停或执行中断需要先处理。原消息和任务均保留。" });
            }
          }
        } catch { this.store.finishDiscussion(claim.turn.id, null, null, "PROVIDER_FAILED"); }
      });
      return claim.turn;
    }
    if (action === "subtask") {
      exact(input, ["subtaskId"]);
      const id = SubtaskIdSchema.parse(data.subtaskId);
      const record = this.store.subtaskRecord(id);
      const task = record?.task;
      if (!task) throw new TaskStorageError("PARENT_NOT_FOUND", "Task unavailable.");
      const parentPlan = this.storage.getDurablePlanningReviewBundle(task.bigTaskId);
      return { task, planningBinding: this.store.planningBinding(task.bigTaskId), plannedProfile: parentPlan?.reviewState.candidate.subtasks.find(item => item.id === id)?.profile ?? null,
        canAmendPlan: !this.store.taskPresence(task.bigTaskId).execution && !this.store.presentation(task.bigTaskId).historyOf && this.store.taskPresence(task.bigTaskId).planning && new LivePlanningStore(this.storage).inspect(task.bigTaskId).phase !== "RUNNING",
        materialized: record!.materialized, parent: this.storage.getBigTaskById(task.bigTaskId), context: this.store.context({ kind: "SUBTASK", id }), settings: this.store.settings({ kind: "SUBTASK", id }), inspection: record!.materialized ? await this.service.inspectSubtask(id) : null, workflow: record!.materialized ? this.storage.getDurableWorkflowControlView(id) : null,
        checkpoints: record!.materialized ? this.storage.listSubtaskImplementationCheckpoints(id).slice(-20) : [] };
    }
    if (action === "execution-approve") return this.service.approveExecution!(input);
    if (action === "execution-recover") return this.service.recoverExecution!(input);
    if (action === "execution-recover-qa") return this.service.recoverQaExecution!(input);
    if (action === "execution-renew-window") return this.service.renewExecutionWindow!(input);
    if (action === "execution-close") return this.service.closeExecution!(input);
    if (action === "execution-accept") {
      const request = BigTaskExecutionAcceptanceSchema.parse(input);
      return this.service.acceptExecution!(request.bigTaskId, request.headSha);
    }
    const bigActions = ["task", "planning-start", "execution-review", "execution-start", "execution-pause", "execution-recovery-review", "execution-qa-recovery-review", "delivery", "preview-start", "preview-status", "preview-stop"];
    if (!bigActions.includes(action)) invalid();
    exact(input, ["bigTaskId"]);
    const id = BigTaskIdSchema.parse(data.bigTaskId);
    const task = this.storage.getBigTaskById(id);
    if (!task) throw new TaskStorageError("PARENT_NOT_FOUND", "Task unavailable.");
    if (action === "task") {
      const presence = this.store.taskPresence(id);
      const planning = presence.planning ? await this.service.inspectPlanning!(id) : null;
      const execution = presence.execution ? await this.service.inspectExecution!(id) : null;
      const windowExpired = execution?.expiresAt !== null && execution?.expiresAt !== undefined && Date.parse(execution.expiresAt) <= Date.parse(this.store.now());
      const canResume = execution !== null && execution.activeRoleCount === 0 && this.store.lifecycle({ kind: "BIG_TASK", id }) === "ACTIVE" && !windowExpired && (["APPROVED", "PAUSED"].includes(execution.phase)
        || execution.phase === "HUMAN_REQUIRED" && execution.stopReason === "TIME_LIMIT_REACHED");
      const canRenewWindow = execution !== null && windowExpired && ["PAUSED", "HUMAN_REQUIRED"].includes(execution.phase)
        && executionUsageSettled(execution) && !executionTokenLimitReached(execution)
        && execution.roleCalls < execution.limits.roleCallLimit && execution.pendingIntegration === null;
      return { task, planningBinding: this.store.planningBinding(id), presentation: this.store.presentation(id), settings: this.store.settings({ kind: "BIG_TASK", id }), navigation: this.store.navigation(task.projectId).find(item => item.id === id), sourceDraft: this.store.sourceDraft(id), planning, execution, canResume, canRenewWindow,
        subtasks: this.storage.listSubtasksByBigTask(id), plan: this.storage.getDurablePlanningSnapshot(id),
        contracts: this.storage.getDurablePlanningReviewBundle(id)?.taskContracts ?? [],
        planReviewMode: presence.planning ? new LivePlanningStore(this.storage).readIntake(id).intake.consoleWorkflow?.planReview ?? "INDEPENDENT" : null,
        planningActive: this.#jobs.has(`planning:${id}`) || this.#queued.has(`planning:${id}`) };
    }
    if (action === "planning-start") {
      if (this.store.lifecycle({ kind: "BIG_TASK", id }) !== "ACTIVE") throw new TaskStorageError("CONFLICT", "This task is paused or ended.");
      const before = await this.service.inspectPlanning!(id);
      if (before.phase !== "READY" || this.#jobs.has(`planning:${id}`)) return before;
      this.#schedule(`planning:${id}`, () => this.service.runPlanning!(id));
      return { ...before, planningActive: true };
    }
    if (action === "execution-review") return this.service.reviewExecution!(id);
    if (action === "execution-start") { if (this.store.lifecycle({ kind: "BIG_TASK", id }) !== "ACTIVE") throw new TaskStorageError("CONFLICT", "This task is paused or ended."); return this.service.startExecution!(id); }
    if (action === "execution-pause") return this.service.pauseExecution!(id);
    if (action === "execution-recovery-review") return this.service.reviewExecutionRecovery!(id);
    if (action === "execution-qa-recovery-review") return this.service.reviewQaExecutionRecovery!(id);
    if (action.startsWith("preview-")) {
      const source = new BigTaskExecutionStore(this.storage).resolveDeliveredRepository(id);
      if (action === "preview-start") return this.#previews.start(id, source.repository, source.headSha);
      if (action === "preview-stop") await this.#previews.stop(id);
      return this.#previews.status(id, source.headSha);
    }
    if (action === "delivery") return new BigTaskExecutionStore(this.storage).readDelivery(id);
    return invalid();
  }
}

export const parseConsoleEnvelope = (input: unknown): { action: string; input: object } => {
  const data = exact(input, ["action", "input"]);
  if (typeof data.action !== "string" || !/^[a-z-]{1,40}$/.test(data.action)) return invalid();
  return { action: data.action, input: object(data.input) };
};
