import { createHash } from "node:crypto";

import {
  hasUnambiguousJsonStructure, BigTaskIdSchema, BigTaskPlanningIntakeSchema, PlannerResponseSchema,
  PlannerReviewResponseSchema, PlanningRunRecordSchema, SubtaskIdSchema,
  TaskContractV0Schema,
} from "@codex-task-console/domain";
import type {
  BigTaskId, BigTaskPlanningIntake, NormalizedUsage, PlanningRunRecord,
  ProviderModelReference, ProviderRunReference, ProviderThreadReference,
} from "@codex-task-console/domain";
import { validatePlanCandidateGraph } from "@codex-task-console/orchestration";
import type { PlanCandidate } from "@codex-task-console/orchestration";

import { TaskStorageError } from "./errors.js";
import { getTaskStorageWorktreeAccess } from "./task-storage-internals.js";
import { TaskStorage } from "./task-storage.js";
import { TrustedRepositorySourceReader } from "./trusted-repository-source.js";

const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) =>
  item !== null && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
const digest = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
function fail(code: "CONFLICT" | "INVALID_INPUT" | "MALFORMED_STORED_DATA" = "CONFLICT"): never {
  throw new TaskStorageError(code, "The Big Task planning operation could not be completed.");
}

export interface PlanningProviderEvidence {
  readonly providerThread: ProviderThreadReference | null;
  readonly providerRun: ProviderRunReference | null;
  readonly model: ProviderModelReference | null;
  readonly normalizedUsage: NormalizedUsage | null;
}

export interface LivePlanningStatus {
  readonly bigTaskId: BigTaskId;
  readonly phase: "READY" | "RUNNING" | "APPROVED" | "HUMAN_REQUIRED";
  readonly nextRole: "PLANNER" | "REVIEWER" | null;
  readonly stopReason: PlanningRunRecord["stopReason"];
  readonly questions: readonly string[];
  readonly totalTokens: number;
  readonly usageComplete: boolean;
  readonly tokenLimit: number;
  readonly warning: boolean;
  readonly automaticRevisionsUsed: number;
  readonly reviewPhase: "AWAITING_REVIEW" | "AWAITING_REVISION" | "APPROVED" | "HUMAN_REQUIRED" | null;
  readonly runs: readonly Omit<PlanningRunRecord, "inputText">[];
}

/** Trusted coordinator operations. Provider output never receives this object. */
export class LivePlanningStore {
  readonly #storage: TaskStorage;
  readonly #access: NonNullable<ReturnType<typeof getTaskStorageWorktreeAccess>>;

  constructor(storage: TaskStorage) {
    const access = getTaskStorageWorktreeAccess(storage);
    if (!(storage instanceof TaskStorage) || access === null || access === undefined) fail("INVALID_INPUT");
    this.#storage = storage;
    this.#access = access;
  }

  accept(input: unknown): LivePlanningStatus {
    const parsed = BigTaskPlanningIntakeSchema.safeParse(input);
    if (!parsed.success || canonical(input) !== canonical(parsed.data)
      || Buffer.byteLength(canonical(parsed.data), "utf8") > 24_000) fail("INVALID_INPUT");
    const intake = parsed.data;
    return this.#storage.runInTransaction(() => {
      if (this.#storage.getBigTaskById(intake.bigTask.id) !== null) fail();
      this.#storage.createBigTask(intake.bigTask);
      const project = this.#storage.getProjectById(intake.bigTask.projectId);
      const repository = new TrustedRepositorySourceReader(this.#storage)
        .readTrustedRepositorySourceSnapshotForBigTask(intake.bigTask.id);
      const payload = canonical({ intake, project, repository });
      if (Buffer.byteLength(payload, "utf8") > 40_000) fail("INVALID_INPUT");
      this.#access.sqlite.prepare("INSERT INTO live_planning_intakes (big_task_id, payload, created_at) VALUES (?, ?, ?)")
        .run(intake.bigTask.id, payload, this.#now());
      return this.inspect(intake.bigTask.id);
    });
  }

  inspect(input: BigTaskId): LivePlanningStatus {
    const { intake } = this.#intake(input);
    const runs = this.#runs(input);
    const latest = runs.at(-1);
    const planning = this.#storage.getDurablePlanningSnapshot(input);
    const review = planning?.reviewState;
    const totalTokens = runs.reduce((sum, run) => sum + (run.normalizedUsage?.totalTokens ?? 0), 0);
    const usageComplete = runs.every((run) => run.normalizedUsage?.totalTokens !== undefined);
    let phase: LivePlanningStatus["phase"] = "READY";
    let stopReason: LivePlanningStatus["stopReason"] = null;
    if (latest?.status === "RUNNING") phase = "RUNNING";
    else if (latest?.status === "HUMAN_REQUIRED") {
      phase = "HUMAN_REQUIRED";
      stopReason = latest.stopReason;
    } else if (review?.phase === "HUMAN_REQUIRED") {
      phase = "HUMAN_REQUIRED";
      stopReason = review.humanReason;
    } else if (review?.phase === "APPROVED") phase = "APPROVED";
    else if (runs.length >= 6 || totalTokens >= intake.planningTokenLimit || !usageComplete) {
      phase = "HUMAN_REQUIRED";
      stopReason = usageComplete ? "BUDGET_BLOCKED" : "USAGE_UNKNOWN";
    }
    return Object.freeze({
      bigTaskId: input, phase,
      nextRole: phase === "READY" ? (review?.phase === "AWAITING_REVIEW" ? "REVIEWER" : "PLANNER") : null,
      stopReason, questions: latest?.questions ?? [], totalTokens, usageComplete,
      tokenLimit: intake.planningTokenLimit,
      warning: totalTokens >= Math.min(80_000, intake.planningTokenLimit),
      automaticRevisionsUsed: review?.automaticRevisionsUsed ?? 0,
      reviewPhase: review?.phase ?? null,
      runs: runs.map(({ inputText, ...run }) => { void inputText; return run; }),
    });
  }

  claim(input: BigTaskId): PlanningRunRecord {
    return this.#storage.runInTransaction(() => {
      const status = this.inspect(input);
      if (status.phase !== "READY" || status.nextRole === null) fail();
      const source = this.#intake(input);
      const contextMatches = this.#contextMatches(input, source);
      const bundle = this.#storage.getDurablePlanningReviewBundle(input);
      const role = status.nextRole;
      // Only the current proposal enters fresh review. No transcripts, old runs or private notes.
      const packet = {
        format: "CTC_BIG_TASK_PLANNING_V0", role,
        instruction: role === "PLANNER"
          ? "Propose a complete bounded task graph and precise contracts for the approved goal. Respect scope and repository rules. No tools, edits, execution, self-approval or invented evidence. Ask product questions when intent is ambiguous. Dependencies must use task keys. Revision must satisfy the supplied review requirements."
          : "Independently review goal coverage, scope, testable acceptance, dependencies and risk profiles. Review only; do not rewrite tasks or approve your own plan. APPROVE only a complete executable plan consistent with the approved goal. REJECT with concrete engineering revisions; ESCALATE product decisions. No tools or edits. Echo the exact candidate binding and revision.",
        approvedIntent: source.intake,
        project: source.project,
        repository: source.repository,
        proposal: bundle === null ? null : {
          candidate: bundle.reviewState.candidate,
          candidateBinding: bundle.candidateBinding,
          taskContracts: bundle.taskContracts,
        },
        ...(role === "PLANNER" && bundle?.reviewState.phase === "AWAITING_REVISION"
          ? { revisionRequirements: bundle.reviewState.revisionRequirements } : {}),
      };
      const packetText = canonical(packet);
      const stopReason = !contextMatches ? "CONTEXT_CHANGED" : Buffer.byteLength(packetText, "utf8") > 64_000 ? "CONTEXT_LIMIT" : null;
      const inputText = stopReason === null ? packetText : canonical({ role, stopReason, attemptedInputBinding: digest(packetText) });
      const timestamp = this.#now();
      const run = PlanningRunRecordSchema.parse({
        sequence: status.runs.length + 1, role, status: stopReason === null ? "RUNNING" : "HUMAN_REQUIRED",
        inputBinding: digest(inputText), inputText, startedAt: timestamp, endedAt: stopReason === null ? null : timestamp,
        providerThread: null, providerRun: null, model: null, normalizedUsage: null,
        stopReason, questions: [],
      });
      this.#access.sqlite.prepare("INSERT INTO live_planning_runs (big_task_id, sequence, payload) VALUES (?, ?, ?)")
        .run(input, run.sequence, canonical(run));
      return run;
    });
  }

  observe(input: BigTaskId, sequence: number, evidence: PlanningProviderEvidence): void {
    this.#storage.runInTransaction(() => {
      const run = this.#running(input, sequence);
      const next = PlanningRunRecordSchema.parse({ ...run, ...evidence });
      if (next.providerThread !== null && this.#runs(input).some((prior) => prior.sequence !== sequence
        && prior.providerThread?.providerThreadId === next.providerThread?.providerThreadId)) fail();
      if (next.providerRun !== null && next.providerRun.providerThreadId !== next.providerThread?.providerThreadId) fail();
      if ((run.providerThread !== null && canonical(run.providerThread) !== canonical(next.providerThread))
        || (run.providerRun !== null && canonical(run.providerRun) !== canonical(next.providerRun))
        || (run.model !== null && canonical(run.model) !== canonical(next.model))
        || (next.normalizedUsage?.totalTokens ?? 0) < (run.normalizedUsage?.totalTokens ?? 0)) fail();
      this.#write(input, next);
    });
  }

  finish(input: BigTaskId, sequence: number, success: boolean, output: string | null): LivePlanningStatus {
    return this.#storage.runInTransaction(() => {
      const run = this.#running(input, sequence);
      let stopReason: PlanningRunRecord["stopReason"] = null;
      let questions: string[] = [];
      const before = this.inspect(input);
      const bundle = this.#storage.getDurablePlanningReviewBundle(input);
      const currentProposal = bundle === null ? null : { candidate: bundle.reviewState.candidate, candidateBinding: bundle.candidateBinding, taskContracts: bundle.taskContracts };
      const captured = JSON.parse(run.inputText) as { proposal?: unknown };
      if (!this.#contextMatches(input, this.#intake(input)) || canonical(currentProposal) !== canonical(captured.proposal)) stopReason = "CONTEXT_CHANGED";
      else if (before.totalTokens >= before.tokenLimit) stopReason = "BUDGET_BLOCKED";
      else if (!success) stopReason = "PROVIDER_FAILED";
      else if (!before.usageComplete) stopReason = "USAGE_UNKNOWN";
      else if (run.providerThread === null || run.providerRun === null || run.model === null) stopReason = "PROVIDER_FAILED";
      else {
        try {
          if (output === null || Buffer.byteLength(output, "utf8") > 16_384) fail("INVALID_INPUT");
          if (!hasUnambiguousJsonStructure(output)) fail("INVALID_INPUT");
          const value: unknown = JSON.parse(output);
          if (run.role === "PLANNER") {
            const proposal = PlannerResponseSchema.parse(value);
            if (proposal.outcome === "HUMAN_REQUIRED") {
              stopReason = "PRODUCT_QUESTION";
              questions = proposal.questions;
            } else {
              const { intake } = this.#intake(input);
              const current = this.#storage.getDurablePlanningSnapshot(input);
              const revision = (current?.reviewState.candidate.revision ?? 0) + 1;
              const ids = new Map(proposal.tasks.map((task) => [task.key,
                SubtaskIdSchema.parse(`st_${digest(`${input}:${task.key}`).slice(0, 32)}`)]));
              if (ids.size !== proposal.tasks.length) fail("INVALID_INPUT");
              const contracts = proposal.tasks.map((task) => TaskContractV0Schema.parse({
                taskContractRef: `plan:${digest(`${input}:${revision}:${task.key}`)}`,
                projectId: intake.bigTask.projectId, bigTaskId: input, subtaskId: ids.get(task.key),
                title: task.title, goal: task.goal, scopeIn: task.scopeIn, scopeOut: task.scopeOut,
                acceptanceCriteria: task.acceptanceCriteria, untouchedAreas: task.untouchedAreas,
                promptSeed: task.promptSeed, startPolicy: "WHEN_READY", delegationPolicy: "NONE",
                recommendedReasoningLevel: "HIGH",
              }));
              const candidate: PlanCandidate = {
                kind: "PLAN_CANDIDATE", projectId: intake.bigTask.projectId, bigTaskId: input, revision,
                subtasks: proposal.tasks.map((task, index) => ({
                  id: contracts[index]!.subtaskId, bigTaskId: input, profile: task.profile,
                  taskContractRef: contracts[index]!.taskContractRef, writeEnabled: task.writeEnabled,
                })),
                dependencies: proposal.dependencies.map((edge) => {
                  const upstreamSubtaskId = ids.get(edge.upstreamKey);
                  const downstreamSubtaskId = ids.get(edge.downstreamKey);
                  if (upstreamSubtaskId === undefined || downstreamSubtaskId === undefined) fail("INVALID_INPUT");
                  return { upstreamSubtaskId, downstreamSubtaskId, dependencyType: "BLOCKING", requiredGate: edge.requiredGate, reason: edge.reason };
                }),
              };
              if (!validatePlanCandidateGraph(candidate).valid) fail("INVALID_INPUT");
              if (current === null) this.#storage.beginDurablePlanningBundle(candidate, contracts);
              else this.#storage.submitDurablePlannerRevisionBundle(candidate, contracts);
            }
          } else {
            const review = PlannerReviewResponseSchema.parse(value);
            const common = { outcome: review.outcome, planRevision: review.planRevision, candidateBinding: review.candidateBinding };
            this.#storage.recordDurableReviewerDecision(input, review.outcome === "REJECT"
              ? { ...common, outcome: "REJECT", revisionRequirements: review.revisionRequirements }
              : { ...common, outcome: review.outcome });
            if (review.outcome === "ESCALATE") { stopReason = "REVIEW_ESCALATED"; questions = review.questions; }
          }
        } catch { stopReason = "INVALID_OUTPUT"; }
      }
      this.#write(input, PlanningRunRecordSchema.parse({ ...run,
        status: stopReason === null ? "COMPLETED" : "HUMAN_REQUIRED",
        endedAt: this.#now(), stopReason, questions,
      }));
      return this.inspect(input);
    });
  }

  /** Called only after the daemon's exclusive process lock is acquired. Never retries uncertain turns. */
  recoverInterrupted(): void {
    this.#storage.runInTransaction(() => {
      const rows = this.#access.sqlite.prepare("SELECT big_task_id FROM live_planning_intakes").all();
      for (const row of rows) {
        const id = BigTaskIdSchema.parse(row.big_task_id);
        const run = this.#runs(id).at(-1);
        if (run?.status === "RUNNING") this.#write(id, PlanningRunRecordSchema.parse({
          ...run, status: "HUMAN_REQUIRED", stopReason: "INTERRUPTED", endedAt: this.#now(),
        }));
      }
    });
  }

  #contextMatches(input: BigTaskId, source: ReturnType<LivePlanningStore["readIntake"]>): boolean {
    try { return canonical(this.#storage.getBigTaskById(input)) === canonical(source.intake.bigTask)
      && canonical(this.#storage.getProjectById(source.intake.bigTask.projectId)) === canonical(source.project)
      && canonical(new TrustedRepositorySourceReader(this.#storage).readTrustedRepositorySourceSnapshotForBigTask(input)) === canonical(source.repository);
    } catch { return false; }
  }

  readIntake(input: BigTaskId): { intake: BigTaskPlanningIntake; project: unknown; repository: unknown } {
    return this.#intake(input);
  }

  #intake(input: BigTaskId): { intake: BigTaskPlanningIntake; project: unknown; repository: unknown } {
    if (!this.#access.isOpen()) fail();
    const id = BigTaskIdSchema.safeParse(input);
    if (!id.success || id.data !== input) fail("INVALID_INPUT");
    const row = this.#access.sqlite.prepare("SELECT payload FROM live_planning_intakes WHERE big_task_id = ?").get(input);
    if (row === undefined) fail();
    try {
      const value = JSON.parse(String(row.payload)) as { intake: unknown; project: unknown; repository: unknown };
      const intake = BigTaskPlanningIntakeSchema.parse(value.intake);
      if (Object.keys(value).sort().join(",") !== "intake,project,repository"
        || intake.bigTask.id !== input || canonical({ ...value, intake }) !== row.payload) fail("MALFORMED_STORED_DATA");
      return { intake, project: value.project, repository: value.repository };
    } catch { return fail("MALFORMED_STORED_DATA"); }
  }

  #runs(input: BigTaskId): PlanningRunRecord[] {
    const rows = this.#access.sqlite.prepare("SELECT sequence, payload FROM live_planning_runs WHERE big_task_id = ? ORDER BY sequence").all(input);
    try {
      return rows.map((row, index) => {
        const run = PlanningRunRecordSchema.parse(JSON.parse(String(row.payload)));
        if (row.sequence !== index + 1 || run.sequence !== row.sequence || canonical(run) !== row.payload
          || digest(run.inputText) !== run.inputBinding || Buffer.byteLength(run.inputText, "utf8") > 64_000
          || (index < rows.length - 1 && run.status !== "COMPLETED")) fail("MALFORMED_STORED_DATA");
        return run;
      });
    } catch { return fail("MALFORMED_STORED_DATA"); }
  }

  #running(input: BigTaskId, sequence: number): PlanningRunRecord {
    const run = this.#runs(input).at(-1);
    if (run?.status !== "RUNNING" || run.sequence !== sequence) fail();
    return run;
  }

  #write(input: BigTaskId, run: PlanningRunRecord): void {
    this.#access.sqlite.prepare("UPDATE live_planning_runs SET payload = ? WHERE big_task_id = ? AND sequence = ?")
      .run(canonical(run), input, run.sequence);
  }

  #now(): string { return this.#access.clock().toISOString(); }
}
