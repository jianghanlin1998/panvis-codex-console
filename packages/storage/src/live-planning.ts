import type { ExecutionProgress, ConsoleModelSelection } from "@codex-task-console/domain";
import { createHash } from "node:crypto";

import {
  BIG_TASK_PLANNING_LIMITS,
  hasUnambiguousJsonStructure, BigTaskIdSchema, BigTaskPlanningIntakeSchema, PlannerResponseSchema,
  PlannerReviewResponseSchema, PlanningRunRecordSchema, PlanningProviderDiagnosticsSchema, SubtaskIdSchema,
  TaskContractV0Schema,
} from "@codex-task-console/domain";
import type {
  BigTaskId, BigTaskPlanningIntake, NormalizedUsage, PlanningRunRecord,
  ProviderModelReference, ProviderRunReference, ProviderThreadReference,
} from "@codex-task-console/domain";
import { validatePlanCandidateGraph } from "@codex-task-console/orchestration";
import type { PlanCandidate } from "@codex-task-console/orchestration";

import { ConsoleWorkspaceStore } from "./console-workspace.js";
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
  readonly budgetException?: NonNullable<BigTaskPlanningIntake["budgetException"]>;
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

  accept(input: unknown): LivePlanningStatus { return this.#accept(input, false); }

  /** Trusted UI coordinator joins its direction-confirmation transaction atomically. */
  acceptInConsoleDirectionTransaction(input: unknown): LivePlanningStatus {
    if (!this.#access.sqlite.isTransaction) fail("INVALID_INPUT");
    return this.#accept(input, true);
  }

  #accept(input: unknown, inDirectionTransaction: boolean): LivePlanningStatus {
    const parsed = BigTaskPlanningIntakeSchema.safeParse(input);
    if (!parsed.success || canonical(input) !== canonical(parsed.data)
      || Buffer.byteLength(canonical(parsed.data), "utf8") > BIG_TASK_PLANNING_LIMITS.maxIntakeBytes) fail("INVALID_INPUT");
    const intake = parsed.data;
    if (intake.productDirection === undefined) {
      throw new TaskStorageError("INVALID_INPUT", "Confirm the product direction, success examples and scope before planning; tool permission is not product approval.");
    }
    if (intake.budgetException !== undefined) {
      const remaining = Date.parse(intake.budgetException.expiresAt) - Date.parse(this.#now());
      if (remaining <= 0 || remaining > 3 * 60 * 60_000) fail("INVALID_INPUT");
    }
    const persist = () => {
      if (this.#storage.getBigTaskById(intake.bigTask.id) !== null) fail();
      this.#storage.createBigTask(intake.bigTask);
      const project = this.#storage.getProjectById(intake.bigTask.projectId);
      const repository = new TrustedRepositorySourceReader(this.#storage)
        .readTrustedRepositorySourceSnapshotForBigTask(intake.bigTask.id);
      const payload = canonical({ intake, project, repository });
      if (Buffer.byteLength(payload, "utf8") > BIG_TASK_PLANNING_LIMITS.maxStoredIntakeBytes) fail("INVALID_INPUT");
      this.#access.sqlite.prepare("INSERT INTO live_planning_intakes (big_task_id, payload, created_at) VALUES (?, ?, ?)")
        .run(intake.bigTask.id, payload, this.#now());
      return this.inspect(intake.bigTask.id);
    };
    return inDirectionTransaction ? persist() : this.#storage.runInTransaction(persist);
  }

  inspect(input: BigTaskId): LivePlanningStatus {
    const { intake } = this.#intake(input);
    const runs = this.#runs(input);
    const latest = runs.at(-1);
    const planning = this.#storage.getDurablePlanningSnapshot(input);
    const review = planning?.reviewState;
    const accountedRuns = this.#familyRuns(input);
    const totalTokens = accountedRuns.reduce((sum, run) => sum + (run.normalizedUsage?.totalTokens ?? 0), 0);
    const usageComplete = accountedRuns.every((run) => run.normalizedUsage?.totalTokens !== undefined);
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
    else if (this.remainingTimeMs(input) === 0) {
      phase = "HUMAN_REQUIRED";
      stopReason = "TIME_LIMIT_REACHED";
    } else if ((intake.consoleWorkflow === undefined && accountedRuns.length >= 6) || (intake.consoleWorkflow?.budgetMode !== "MEASURE" && (intake.budgetException === undefined && totalTokens >= intake.planningTokenLimit || !usageComplete))) {
      phase = "HUMAN_REQUIRED";
      stopReason = usageComplete ? "BUDGET_BLOCKED" : "USAGE_UNKNOWN";
    }
    return Object.freeze({
      bigTaskId: input, phase,
      nextRole: phase === "READY" ? (review?.phase === "AWAITING_REVIEW" ? "REVIEWER" : "PLANNER") : null,
      stopReason, questions: latest?.questions ?? [], totalTokens, usageComplete,
      tokenLimit: intake.planningTokenLimit,
      ...(intake.budgetException === undefined ? {} : { budgetException: intake.budgetException }),
      warning: totalTokens >= Math.min(80_000, intake.planningTokenLimit),
      automaticRevisionsUsed: review?.automaticRevisionsUsed ?? 0,
      reviewPhase: review?.phase ?? null,
      runs: runs.map(({ inputText, ...run }) => { void inputText; return run; }),
    });
  }

  /** Uses the injected storage clock; zero prevents another provider turn. */
  remainingTimeMs(input: BigTaskId): number | null {
    const source = this.#intake(input);
    const exception = source.intake.budgetException;
    if (!exception && source.intake.consoleWorkflow) {
      const row = this.#access.sqlite.prepare("SELECT created_at FROM live_planning_intakes WHERE big_task_id = ?").get(input)!;
      return Math.max(0, Date.parse(String(row.created_at)) + source.intake.consoleWorkflow.durationMinutes * 60_000 - Date.parse(this.#now()));
    }
    return exception === undefined ? null : Math.max(0, Date.parse(exception.expiresAt) - Date.parse(this.#now()));
  }

  claim(input: BigTaskId): PlanningRunRecord {
    return this.#storage.runInTransaction(() => {
      const status = this.inspect(input);
      if (status.phase !== "READY" || status.nextRole === null || this.successor(input)) fail();
      const source = this.#intake(input);
      const contextMatches = this.#contextMatches(input, source);
      const paused = new ConsoleWorkspaceStore(this.#storage).lifecycle({ kind: "BIG_TASK", id: input }) !== "ACTIVE";
      const bundle = this.#storage.getDurablePlanningReviewBundle(input);
      const role = status.nextRole;
      // Only the current proposal enters fresh review. No transcripts, old runs or private notes.
      const packet = {
        format: "CTC_BIG_TASK_PLANNING_V0", role,
        instruction: (role === "PLANNER"
          ? "Propose a complete bounded task graph and precise contracts for the approved goal. Respect scope and repository rules. No tools, edits, execution, self-approval or invented evidence. Ask product questions when intent is ambiguous. Dependencies must use task keys. Revision must satisfy the supplied review requirements."
          : "Independently review goal coverage, scope, testable acceptance, dependencies and risk profiles. Review only; do not rewrite tasks or approve your own plan. APPROVE only a complete executable plan consistent with the approved goal. REJECT with concrete engineering revisions; ESCALATE product decisions. No tools or edits. Echo the exact candidate binding and revision.")
          + (source.intake.productDirection === undefined
            ? " Historical workflow capabilities: LOW and STANDARD use execution plus verification and finish IMPLEMENTED. Only HIGH_RISK_FOUNDATION adds hardening, fresh QA and bounded repairs to reach ACCEPTED. Preserve this pinned historical contract."
            : " Workflow capabilities for this confirmed product brief: LOW uses execution plus verification and finishes IMPLEMENTED. STANDARD uses execution plus fresh independent QA and can reach ACCEPTED and perform bounded repair/re-QA without a separate hardening sweep. HIGH_RISK_FOUNDATION adds comprehensive hardening before fresh QA. Use STANDARD for ordinary reviewed work, HIGH_RISK_FOUNDATION when deeper invariant testing is warranted, and LOW only where IMPLEMENTED suffices. Both reviewed paths support bounded repairs when writeEnabled=true.")
          + " Models do not commit: the Console saves and integrates their candidate files. Execution roles have no network access; never claim that synthetic tests prove live fetching. Any required live acceptance needs an explicit coordinator or human verification step."
          + ` Return compact JSON without indentation or formatting whitespace. The entire response has a hard limit of ${BIG_TASK_PLANNING_LIMITS.maxResponseBytes} UTF-8 bytes (1 MiB); this is a ceiling, not a target. Every text field must be a trimmed single-line string of at most 1,000 characters, with no control characters. Be concise and do not repeat shared intent or repository rules inside every contract. Use only the tasks needed for complete, independently verifiable delivery. Preserve all goal coverage and acceptance criteria.`
          + (role === "PLANNER"
            ? " If a complete plan cannot fit, return HUMAN_REQUIRED with a concise scope question instead of truncating or omitting required work."
            : " If a complete review cannot fit, use ESCALATE with a concise question instead of truncating or omitting blocking findings."),
        approvedIntent: source.intake,
        ...(source.intake.consoleWorkflow ? { humanContext: new ConsoleWorkspaceStore(this.#storage).roleContext({ kind: "BIG_TASK", id: input }, { includeSubtasks: true }) } : {}),
        ...(source.intake.taskSize === "SMALL" ? { taskSizeInstruction: "This is a direct small-task intake. Propose exactly one bounded task and no dependencies. If the goal cannot fit one task, ask a product question rather than silently expanding it." } : {}),
        reviewPolicy: source.intake.consoleReviewPolicy ? "Owner-selected review levels are binding: LIGHT maps to LOW and basic verification; STANDARD maps to independent QA with at most two failed QA attempts; THOROUGH maps to hardening plus QA with at most three failed QA attempts. Apply consoleTaskReviewLevels by exact task title, otherwise reviewIntensity. Preserve each listed title exactly once during engineering revision; renaming or dropping a human-selected task requires a product question. Do not silently alter selected levels; ask if a genuine requirement conflicts. A LIGHT upstream uses VERIFIED dependency gate: implementation alone never satisfies it, trusted completion of VERIFY is required. UI tasks under STANDARD/THOROUGH require real visual evidence; unavailable visual verification is a blocker, never an invented PASS." : null,
        productAuthority: "The confirmed product direction defines what to build. A tool, feed, vendor or implementation choice is not a substitute for product alignment. Do not silently narrow the audience, coverage, content-selection criteria or meaning of success. Ask a product question when any such decision is unresolved; engineering choices within the confirmed direction need no additional human tool approval. Treat reviewIntensity as the owner's preferred review depth; use the lightest sufficient per-task review and explain material deviations in a product question.",
        project: source.project,
        repository: source.repository,
        proposal: bundle === null ? null : {
          candidate: bundle.reviewState.candidate,
          candidateBinding: digest(bundle.candidateBinding),
          taskContracts: bundle.taskContracts,
        },
        ...(role === "PLANNER" && bundle?.reviewState.phase === "AWAITING_REVISION"
          ? { revisionRequirements: bundle.reviewState.revisionRequirements } : {}),
      };
      if (source.intake.consoleWorkflow) {
        packet.instruction = packet.instruction.replace("No tools, edits, execution, self-approval or invented evidence.", "Use console_read, read-only shell commands, public web search/page reading and image viewing to investigate the actual repository, retained delivery, task context and available capabilities before writing the plan. No edits, task execution or invented evidence. Engineering investigation is your job and does not require another owner approval.")
          .replace("No tools or edits.", "Use console_read when evidence is missing; no edits.")
          + " Check that each selected QA level agrees with all acceptance prose. Under SELF review, include a complete self-checked plan for owner approval; no independent plan review will be claimed. Do not put prerequisite read-only investigation inside a task that requires this plan to be approved first. If capabilities are missing, describe the engineering work to connect and validate them; only ask the owner for consequential product choices.";
      }
      const packetText = canonical(packet);
      const stopReason = paused ? "USER_PAUSED" : !contextMatches ? "CONTEXT_CHANGED" : Buffer.byteLength(packetText, "utf8") > BIG_TASK_PLANNING_LIMITS.maxInputBytes ? "CONTEXT_LIMIT" : null;
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

  recordProgress(input: BigTaskId, sequence: number, update: { progress?: ExecutionProgress; modelSelection?: ConsoleModelSelection | null }): void {
    const run = this.#running(input, sequence);
    this.#write(input, PlanningRunRecordSchema.parse({ ...run, ...update }));
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

  finish(input: BigTaskId, sequence: number, success: boolean, output: string | null,
    diagnostics?: NonNullable<PlanningRunRecord["providerDiagnostics"]>): LivePlanningStatus {
    return this.#storage.runInTransaction(() => {
      const run = this.#running(input, sequence);
      const providerDiagnostics = diagnostics === undefined ? undefined : PlanningProviderDiagnosticsSchema.parse(diagnostics);
      let stopReason: PlanningRunRecord["stopReason"] = null;
      let questions: string[] = [];
      const before = this.inspect(input);
      const bundle = this.#storage.getDurablePlanningReviewBundle(input);
      const currentProposal = bundle === null ? null : { candidate: bundle.reviewState.candidate, candidateBinding: digest(bundle.candidateBinding), taskContracts: bundle.taskContracts };
      const captured = JSON.parse(run.inputText) as { proposal?: unknown };
      if (!this.#contextMatches(input, this.#intake(input)) || canonical(currentProposal) !== canonical(captured.proposal)) stopReason = "CONTEXT_CHANGED";
      else if (this.remainingTimeMs(input) === 0) stopReason = "TIME_LIMIT_REACHED";
      else if (this.#intake(input).intake.consoleWorkflow?.budgetMode !== "MEASURE" && before.budgetException === undefined && before.totalTokens >= before.tokenLimit) stopReason = "BUDGET_BLOCKED";
      else if (!success) stopReason = "PROVIDER_FAILED";
      else if (!before.usageComplete && this.#intake(input).intake.consoleWorkflow?.budgetMode !== "MEASURE") stopReason = "USAGE_UNKNOWN";
      else if (run.providerThread === null || run.providerRun === null || run.model === null) stopReason = "PROVIDER_FAILED";
      else {
        try {
          if (output === null || Buffer.byteLength(output, "utf8") > BIG_TASK_PLANNING_LIMITS.maxResponseBytes) fail("INVALID_INPUT");
          if (!hasUnambiguousJsonStructure(output)) fail("INVALID_INPUT");
          const value: unknown = JSON.parse(output);
          if (run.role === "PLANNER") {
            const proposal = PlannerResponseSchema.parse(value);
            if (proposal.outcome === "HUMAN_REQUIRED") {
              stopReason = "PRODUCT_QUESTION";
              questions = proposal.questions;
            } else {
              const { intake } = this.#intake(input);
              if (intake.taskSize === "SMALL" && (proposal.tasks.length !== 1 || proposal.dependencies.length !== 0)) fail("INVALID_INPUT");
              if (intake.consoleTaskReviewLevels?.some(level => proposal.tasks.filter(task => task.title === level.title).length !== 1)) fail("INVALID_INPUT");
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
                  id: contracts[index]!.subtaskId, bigTaskId: input, profile: intake.consoleReviewPolicy ? ({ LIGHT: "LOW", STANDARD: "STANDARD", THOROUGH: "HIGH_RISK_FOUNDATION" } as const)[intake.consoleTaskReviewLevels?.find(item => item.title === task.title)?.reviewLevel ?? intake.reviewIntensity ?? "STANDARD"] : task.profile,
                  taskContractRef: contracts[index]!.taskContractRef, writeEnabled: task.writeEnabled,
                })),
                dependencies: proposal.dependencies.map((edge) => {
                  const upstreamSubtaskId = ids.get(edge.upstreamKey);
                  const downstreamSubtaskId = ids.get(edge.downstreamKey);
                  if (upstreamSubtaskId === undefined || downstreamSubtaskId === undefined) fail("INVALID_INPUT");
                  return { upstreamSubtaskId, downstreamSubtaskId, dependencyType: "BLOCKING", requiredGate: intake.consoleReviewPolicy && (intake.consoleTaskReviewLevels?.find(item => item.title === proposal.tasks.find(task => task.key === edge.upstreamKey)?.title)?.reviewLevel ?? intake.reviewIntensity) === "LIGHT" ? "VERIFIED" : edge.requiredGate, reason: edge.reason };
                }),
              };
              if (!validatePlanCandidateGraph(candidate).valid) fail("INVALID_INPUT");
              if (current === null) this.#storage.beginDurablePlanningBundle(candidate, contracts);
              else this.#storage.submitDurablePlannerRevisionBundle(candidate, contracts);
              if (intake.consoleWorkflow?.planReview === "SELF") {
                const saved = this.#storage.getDurablePlanningReviewBundle(input)!;
                this.#storage.recordDurableReviewerDecision(input, { outcome: "APPROVE", planRevision: candidate.revision, candidateBinding: saved.candidateBinding });
                new ConsoleWorkspaceStore(this.#storage).entries.put(intake.bigTask.projectId, { kind: "BIG_TASK", id: input }, `plan_check_${input}_${candidate.revision}`, "NOTE", { title: "计划自检", body: "规划者已提交自检计划，等待所有者确认实施。没有运行独立计划审核。", authority: "SYSTEM", planReview: "SELF" });
              }
            }
          } else {
            const review = PlannerReviewResponseSchema.parse(value);
            if (bundle === null || review.candidateBinding !== digest(bundle.candidateBinding)) fail("INVALID_INPUT");
            const common = { outcome: review.outcome, planRevision: review.planRevision, candidateBinding: bundle.candidateBinding };
            this.#storage.recordDurableReviewerDecision(input, review.outcome === "REJECT"
              ? { ...common, outcome: "REJECT", revisionRequirements: review.revisionRequirements }
              : { ...common, outcome: review.outcome });
            if (review.outcome === "ESCALATE") { stopReason = "REVIEW_ESCALATED"; questions = review.questions; }
          }
        } catch { stopReason = "INVALID_OUTPUT"; }
      }
      this.#write(input, PlanningRunRecordSchema.parse({ ...run,
        ...(providerDiagnostics === undefined ? {} : { providerDiagnostics }),
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
    const row = this.#access.sqlite.prepare("SELECT payload, created_at FROM live_planning_intakes WHERE big_task_id = ?").get(input);
    if (row === undefined) fail();
    try {
      const value = JSON.parse(String(row.payload)) as { intake: unknown; project: unknown; repository: unknown };
      const intake = BigTaskPlanningIntakeSchema.parse(value.intake);
      if (intake.budgetException !== undefined) {
        const duration = Date.parse(intake.budgetException.expiresAt) - Date.parse(String(row.created_at));
        if (!Number.isFinite(duration) || duration <= 0 || duration > 3 * 60 * 60_000) fail("MALFORMED_STORED_DATA");
      }
      if (Object.keys(value).sort().join(",") !== "intake,project,repository"
        || intake.bigTask.id !== input || canonical({ ...value, intake }) !== row.payload) fail("MALFORMED_STORED_DATA");
      return { intake, project: value.project, repository: value.repository };
    } catch { return fail("MALFORMED_STORED_DATA"); }
  }

  successor(input: BigTaskId): BigTaskId | null {
    const row = this.#access.sqlite.prepare("SELECT big_task_id FROM live_planning_intakes WHERE json_extract(payload, '$.intake.planningRevisionOf') = ?").get(input);
    return row ? BigTaskIdSchema.parse(row.big_task_id) : null;
  }
  #familyRuns(input: BigTaskId): PlanningRunRecord[] {
    const runs: PlanningRunRecord[] = [];
    const seen = new Set<BigTaskId>();
    let id: BigTaskId | undefined = input;
    while (id) {
      if (seen.has(id) || seen.size >= 200) fail("MALFORMED_STORED_DATA");
      seen.add(id); runs.unshift(...this.#runs(id));
      id = this.#intake(id).intake.planningRevisionOf;
    }
    return runs;
  }

  #runs(input: BigTaskId): PlanningRunRecord[] {
    const rows = this.#access.sqlite.prepare("SELECT sequence, payload FROM live_planning_runs WHERE big_task_id = ? ORDER BY sequence").all(input);
    try {
      return rows.map((row, index) => {
        const run = PlanningRunRecordSchema.parse(JSON.parse(String(row.payload)));
        if (row.sequence !== index + 1 || run.sequence !== row.sequence || canonical(run) !== row.payload
          || digest(run.inputText) !== run.inputBinding || Buffer.byteLength(run.inputText, "utf8") > BIG_TASK_PLANNING_LIMITS.maxInputBytes
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
