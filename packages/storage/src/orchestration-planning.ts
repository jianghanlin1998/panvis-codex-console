import type { DatabaseSync } from "node:sqlite";

import {
  BigTaskIdSchema,
  ProjectIdSchema,
  SubtaskIdSchema,
  TaskContractV0Schema,
} from "@codex-task-console/domain";
import type {
  BigTaskId,
  ProjectId,
  TaskContractV0,
} from "@codex-task-console/domain";
import {
  applyReviewerDecision,
  beginPlanReview,
  materializeApprovedPlan,
  submitPlannerRevision,
} from "@codex-task-console/orchestration";
import type {
  MaterializedGraph,
  PlanCandidate,
  PlanReviewState,
  ReviewDecision,
} from "@codex-task-console/orchestration";
import { and, asc, eq } from "drizzle-orm";
import type { NodeSQLiteDatabase } from "drizzle-orm/node-sqlite";

import { TaskStorageError } from "./errors.js";
import {
  bigTasksTable,
  candidateTaskContractBindingsTable,
  orchestrationMaterializationsTable,
  orchestrationPlanCandidatesTable,
  orchestrationPlanningTracksTable,
  orchestrationReviewDecisionsTable,
  projectsTable,
  subtasksTable,
  taskContractsTable,
} from "./schema.js";

export interface DurablePlanCandidateArtifact {
  readonly candidate: PlanCandidate;
  readonly candidateBinding: string;
}

export interface DurableReviewDecisionArtifact {
  readonly decision: ReviewDecision;
}

export interface DurableOrchestrationPlanningSnapshot {
  readonly projectId: ProjectId;
  readonly bigTaskId: BigTaskId;
  readonly reviewState: PlanReviewState;
  readonly candidateHistory: readonly DurablePlanCandidateArtifact[];
  readonly reviewDecisions: readonly DurableReviewDecisionArtifact[];
  readonly materializedGraph: MaterializedGraph | null;
}

export const TASK_CONTRACT_AUTHORITY_READINESS = Object.freeze([
  "TASK_CONTRACT_AUTHORITY_READY",
  "TASK_CONTRACT_AUTHORITY_NOT_READY",
] as const);

export type TaskContractAuthorityReadiness =
  (typeof TASK_CONTRACT_AUTHORITY_READINESS)[number];

export interface DurablePlanningReviewBundle {
  readonly projectId: ProjectId;
  readonly bigTaskId: BigTaskId;
  readonly reviewState: PlanReviewState;
  readonly candidateBinding: string;
  readonly taskContractAuthorityReadiness: TaskContractAuthorityReadiness;
  readonly taskContracts: readonly TaskContractV0[];
}

export type ApprovedTaskContractAuthority =
  | Readonly<{
      taskContractAuthorityReadiness: "TASK_CONTRACT_AUTHORITY_NOT_READY";
      projectId: ProjectId;
      bigTaskId: BigTaskId;
      planRevision: number;
      candidateBinding: string;
      reviewPhase: PlanReviewState["phase"];
      materialized: boolean;
    }>
  | Readonly<{
      taskContractAuthorityReadiness: "TASK_CONTRACT_AUTHORITY_READY";
      projectId: ProjectId;
      bigTaskId: BigTaskId;
      planRevision: number;
      candidateBinding: string;
      reviewPhase: "APPROVED";
      materialized: boolean;
      taskContracts: readonly TaskContractV0[];
    }>;

type CandidateRow = typeof orchestrationPlanCandidatesTable.$inferSelect;
type DecisionRow = typeof orchestrationReviewDecisionsTable.$inferSelect;
type MaterializationRow = typeof orchestrationMaterializationsTable.$inferSelect;
type TaskContractRow = typeof taskContractsTable.$inferSelect;
type TaskContractBindingRow =
  typeof candidateTaskContractBindingsTable.$inferSelect;

const malformedStoredData = (): TaskStorageError =>
  new TaskStorageError("MALFORMED_STORED_DATA", "Stored task data is malformed.");

const invalidPlanningInput = (): TaskStorageError =>
  new TaskStorageError(
    "INVALID_INPUT",
    "Orchestration planning input does not satisfy the durable contract.",
  );

const planningConflict = (): TaskStorageError =>
  new TaskStorageError("CONFLICT", "The durable orchestration planning authority conflicts.");

const isCanonicalTimestamp = (value: unknown): value is string => {
  if (typeof value !== "string") {
    return false;
  }
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
};

const isDurableText = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit <= 0x1f || (unit >= 0x7f && unit <= 0x9f)) {
      return false;
    }
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff) {
        return false;
      }
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
};

const candidateHasDurableText = (candidate: PlanCandidate): boolean =>
  candidate.subtasks.every(({ taskContractRef }) => isDurableText(taskContractRef)) &&
  candidate.dependencies.every(({ reason }) => isDurableText(reason));

const decisionHasDurableText = (decision: ReviewDecision): boolean =>
  decision.outcome !== "REJECT" ||
  decision.revisionRequirements.every(isDurableText);

const parseCanonicalBigTaskId = (input: BigTaskId): BigTaskId => {
  const result = BigTaskIdSchema.safeParse(input);
  if (!result.success || result.data !== input) {
    throw invalidPlanningInput();
  }
  return result.data;
};

const deepFreeze = <T>(value: T): T => {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const nestedValue of Object.values(value)) {
    deepFreeze(nestedValue);
  }
  return Object.freeze(value);
};

const canonicalCandidatePayload = (candidate: PlanCandidate): string =>
  JSON.stringify(candidate);

const canonicalTaskContractPayload = (contract: TaskContractV0): string =>
  JSON.stringify(contract);

const parseTaskContractInput = (input: unknown): TaskContractV0 => {
  const parsed = TaskContractV0Schema.safeParse(input);
  if (!parsed.success) {
    throw invalidPlanningInput();
  }
  return parsed.data;
};

const parseStoredTaskContract = (row: TaskContractRow): TaskContractV0 => {
  let input: unknown;
  try {
    input = JSON.parse(row.contractPayload) as unknown;
  } catch {
    throw malformedStoredData();
  }
  const parsed = TaskContractV0Schema.safeParse(input);
  if (
    !parsed.success ||
    !isCanonicalTimestamp(row.createdAt) ||
    canonicalTaskContractPayload(parsed.data) !== row.contractPayload ||
    parsed.data.projectId !== row.projectId ||
    parsed.data.bigTaskId !== row.bigTaskId ||
    parsed.data.subtaskId !== row.subtaskId ||
    parsed.data.taskContractRef !== row.taskContractRef
  ) {
    throw malformedStoredData();
  }
  return parsed.data;
};

const validateStoredTaskContractBinding = (
  row: TaskContractBindingRow,
): void => {
  const projectId = ProjectIdSchema.safeParse(row.projectId);
  const bigTaskId = BigTaskIdSchema.safeParse(row.bigTaskId);
  const subtaskId = SubtaskIdSchema.safeParse(row.subtaskId);
  if (
    !projectId.success ||
    projectId.data !== row.projectId ||
    !bigTaskId.success ||
    bigTaskId.data !== row.bigTaskId ||
    !subtaskId.success ||
    subtaskId.data !== row.subtaskId ||
    !Number.isSafeInteger(row.planRevision) ||
    row.planRevision < 1 ||
    row.candidateBinding.length === 0 ||
    !isDurableText(row.candidateBinding) ||
    row.taskContractRef.length === 0 ||
    row.taskContractRef.length > 1_000 ||
    row.taskContractRef.trim() !== row.taskContractRef ||
    !isDurableText(row.taskContractRef) ||
    !isCanonicalTimestamp(row.createdAt)
  ) {
    throw malformedStoredData();
  }
};

const parseStoredCandidate = (row: CandidateRow): DurablePlanCandidateArtifact => {
  let input: unknown;
  try {
    input = JSON.parse(row.candidatePayload) as unknown;
  } catch {
    throw malformedStoredData();
  }
  const started = beginPlanReview(input as PlanCandidate);
  if (started.kind !== "REVIEW_STATE") {
    throw malformedStoredData();
  }
  const candidate = started.state.candidate;
  if (
    !candidateHasDurableText(candidate) ||
    !isCanonicalTimestamp(row.createdAt) ||
    canonicalCandidatePayload(candidate) !== row.candidatePayload ||
    candidate.projectId !== row.projectId ||
    candidate.bigTaskId !== row.bigTaskId ||
    candidate.revision !== row.revision ||
    started.state.candidateBinding !== row.candidateBinding ||
    (row.taskContractCount !== null &&
      (!Number.isSafeInteger(row.taskContractCount) || row.taskContractCount < 1))
  ) {
    throw malformedStoredData();
  }
  return deepFreeze({
    candidate,
    candidateBinding: started.state.candidateBinding,
  });
};

const parseStoredStringArray = (input: string): readonly string[] => {
  let value: unknown;
  try {
    value = JSON.parse(input) as unknown;
  } catch {
    throw malformedStoredData();
  }
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some(
      (item) =>
        typeof item !== "string" ||
        item.length === 0 ||
        item.length > 1_000 ||
        item.trim() !== item ||
        !isDurableText(item),
    ) ||
    new Set(value).size !== value.length ||
    JSON.stringify(value) !== input
  ) {
    throw malformedStoredData();
  }
  return Object.freeze([...value]);
};

const parseStoredDecision = (row: DecisionRow): DurableReviewDecisionArtifact => {
  if (!isCanonicalTimestamp(row.createdAt)) {
    throw malformedStoredData();
  }
  let decision: ReviewDecision;
  if (row.outcome === "APPROVE" || row.outcome === "ESCALATE") {
    if (row.revisionRequirements !== null) {
      throw malformedStoredData();
    }
    decision = {
      outcome: row.outcome,
      planRevision: row.planRevision,
      candidateBinding: row.candidateBinding,
    };
  } else if (row.outcome === "REJECT" && row.revisionRequirements !== null) {
    decision = {
      outcome: "REJECT",
      planRevision: row.planRevision,
      candidateBinding: row.candidateBinding,
      revisionRequirements: parseStoredStringArray(row.revisionRequirements),
    };
  } else {
    throw malformedStoredData();
  }
  if (!decisionHasDurableText(decision)) {
    throw malformedStoredData();
  }
  return deepFreeze({ decision });
};

interface ReplayedPlanning {
  readonly snapshot: DurableOrchestrationPlanningSnapshot;
  readonly materializationRow: MaterializationRow | null;
  readonly lastArtifactAt: string;
  readonly taskContractsByRevision: ReadonlyMap<number, readonly TaskContractV0[]>;
}

export class DurableOrchestrationPlanningStore {
  readonly #sqlite: DatabaseSync;
  readonly #database: NodeSQLiteDatabase;
  readonly #clock: () => Date;

  constructor(sqlite: DatabaseSync, database: NodeSQLiteDatabase, clock: () => Date) {
    this.#sqlite = sqlite;
    this.#database = database;
    this.#clock = clock;
  }

  begin(candidateInput: PlanCandidate): DurableOrchestrationPlanningSnapshot {
    const candidate = this.#validateCandidateInput(candidateInput);
    return this.#atomic(() => {
      if (this.#getTrack(candidate.bigTaskId) !== undefined) {
        throw planningConflict();
      }
      this.#validateMutationEligibility(candidate);
      const started = beginPlanReview(candidate);
      if (started.kind !== "REVIEW_STATE") {
        throw invalidPlanningInput();
      }
      const timestamp = this.#timestamp();
      this.#database
        .insert(orchestrationPlanningTracksTable)
        .values({
          bigTaskId: candidate.bigTaskId,
          projectId: candidate.projectId,
          createdAt: timestamp,
        })
        .run();
      this.#insertCandidate(candidate, started.state.candidateBinding, timestamp);
      return this.#requireReplay(candidate.bigTaskId).snapshot;
    });
  }

  beginBundle(
    candidateInput: PlanCandidate,
    taskContractInputs: readonly TaskContractV0[],
  ): DurablePlanningReviewBundle {
    const candidate = this.#validateCandidateInput(candidateInput);
    const taskContracts = this.#validateBundleInput(candidate, taskContractInputs);
    return this.#atomic(() => {
      if (this.#getTrack(candidate.bigTaskId) !== undefined) {
        throw planningConflict();
      }
      this.#validateMutationEligibility(candidate);
      this.#validateNoCanonicalSubtaskCollision(candidate);
      const started = beginPlanReview(candidate);
      if (started.kind !== "REVIEW_STATE") {
        throw invalidPlanningInput();
      }
      const timestamp = this.#timestamp();
      this.#database
        .insert(orchestrationPlanningTracksTable)
        .values({
          bigTaskId: candidate.bigTaskId,
          projectId: candidate.projectId,
          createdAt: timestamp,
        })
        .run();
      this.#insertCandidate(
        candidate,
        started.state.candidateBinding,
        timestamp,
        taskContracts.length,
      );
      this.#insertTaskContractBundle(
        candidate,
        started.state.candidateBinding,
        taskContracts,
        timestamp,
      );
      const replayed = this.#requireReplay(candidate.bigTaskId);
      const reviewBundle = this.#reviewBundleFromReplay(replayed);
      if (
        reviewBundle.taskContractAuthorityReadiness !==
        "TASK_CONTRACT_AUTHORITY_READY"
      ) {
        throw new TaskStorageError(
          "STORAGE_OPERATION_FAILED",
          "The durable Task Contract bundle was not persisted exactly.",
        );
      }
      return reviewBundle;
    });
  }

  recordReviewerDecision(
    bigTaskIdInput: BigTaskId,
    decisionInput: ReviewDecision,
  ): DurableOrchestrationPlanningSnapshot {
    const bigTaskId = parseCanonicalBigTaskId(bigTaskIdInput);
    return this.#atomic(() => {
      const replayed = this.#requireReplay(bigTaskId);
      if (replayed.materializationRow !== null) {
        throw planningConflict();
      }
      this.#validateMutationEligibility(replayed.snapshot.reviewState.candidate);
      const result = applyReviewerDecision(replayed.snapshot.reviewState, decisionInput);
      if (result.kind !== "REVIEW_STATE" || !decisionHasDurableText(decisionInput)) {
        throw invalidPlanningInput();
      }
      const decision = decisionInput;
      this.#database
        .insert(orchestrationReviewDecisionsTable)
        .values({
          bigTaskId,
          planRevision: decision.planRevision,
          outcome: decision.outcome,
          candidateBinding: decision.candidateBinding,
          revisionRequirements:
            decision.outcome === "REJECT"
              ? JSON.stringify(decision.revisionRequirements)
              : null,
          createdAt: this.#timestampAtOrAfter(replayed.lastArtifactAt),
        })
        .run();
      const next = this.#requireReplay(bigTaskId).snapshot;
      if (JSON.stringify(next.reviewState) !== JSON.stringify(result.state)) {
        throw new TaskStorageError(
          "STORAGE_OPERATION_FAILED",
          "The durable Reviewer Decision was not persisted exactly.",
        );
      }
      return next;
    });
  }

  submitRevision(candidateInput: PlanCandidate): DurableOrchestrationPlanningSnapshot {
    const candidate = this.#validateCandidateInput(candidateInput);
    return this.#atomic(() => {
      const replayed = this.#requireReplay(candidate.bigTaskId);
      if (replayed.materializationRow !== null) {
        throw planningConflict();
      }
      this.#validateMutationEligibility(candidate);
      const result = submitPlannerRevision(replayed.snapshot.reviewState, candidate);
      if (result.kind !== "REVIEW_STATE") {
        throw invalidPlanningInput();
      }
      this.#insertCandidate(
        candidate,
        result.state.candidateBinding,
        this.#timestampAtOrAfter(replayed.lastArtifactAt),
      );
      const next = this.#requireReplay(candidate.bigTaskId).snapshot;
      if (JSON.stringify(next.reviewState) !== JSON.stringify(result.state)) {
        throw new TaskStorageError(
          "STORAGE_OPERATION_FAILED",
          "The durable Planner Revision was not persisted exactly.",
        );
      }
      return next;
    });
  }

  submitRevisionBundle(
    candidateInput: PlanCandidate,
    taskContractInputs: readonly TaskContractV0[],
  ): DurablePlanningReviewBundle {
    const candidate = this.#validateCandidateInput(candidateInput);
    const taskContracts = this.#validateBundleInput(candidate, taskContractInputs);
    return this.#atomic(() => {
      const replayed = this.#requireReplay(candidate.bigTaskId);
      if (replayed.materializationRow !== null) {
        throw planningConflict();
      }
      this.#validateMutationEligibility(candidate);
      this.#validateNoCanonicalSubtaskCollision(candidate);
      const result = submitPlannerRevision(replayed.snapshot.reviewState, candidate);
      if (result.kind !== "REVIEW_STATE") {
        throw invalidPlanningInput();
      }
      const timestamp = this.#timestampAtOrAfter(replayed.lastArtifactAt);
      this.#insertCandidate(
        candidate,
        result.state.candidateBinding,
        timestamp,
        taskContracts.length,
      );
      this.#insertTaskContractBundle(
        candidate,
        result.state.candidateBinding,
        taskContracts,
        timestamp,
      );
      const next = this.#requireReplay(candidate.bigTaskId);
      if (JSON.stringify(next.snapshot.reviewState) !== JSON.stringify(result.state)) {
        throw new TaskStorageError(
          "STORAGE_OPERATION_FAILED",
          "The durable Planner Revision bundle was not persisted exactly.",
        );
      }
      const reviewBundle = this.#reviewBundleFromReplay(next);
      if (
        reviewBundle.taskContractAuthorityReadiness !==
        "TASK_CONTRACT_AUTHORITY_READY"
      ) {
        throw new TaskStorageError(
          "STORAGE_OPERATION_FAILED",
          "The durable Task Contract bundle was not persisted exactly.",
        );
      }
      return reviewBundle;
    });
  }

  materialize(bigTaskIdInput: BigTaskId): DurableOrchestrationPlanningSnapshot {
    const bigTaskId = parseCanonicalBigTaskId(bigTaskIdInput);
    return this.#atomic(() => {
      const replayed = this.#requireReplay(bigTaskId);
      if (replayed.materializationRow !== null) {
        return replayed.snapshot;
      }
      this.#validateMutationEligibility(replayed.snapshot.reviewState.candidate);
      const result = materializeApprovedPlan(replayed.snapshot.reviewState);
      if (result.kind === "GRAPH_INVALID") {
        throw new TaskStorageError(
          "DEPENDENCY_VALIDATION_FAILED",
          "The approved plan graph is invalid.",
          result.validation.errors.map(({ code }) => code),
        );
      }
      if (result.kind !== "MATERIALIZED") {
        throw invalidPlanningInput();
      }
      this.#database
        .insert(orchestrationMaterializationsTable)
        .values({
          bigTaskId,
          projectId: result.graph.projectId,
          planRevision: result.graph.planRevision,
          candidateBinding: result.graph.candidateBinding,
          materializedAt: this.#timestampAtOrAfter(replayed.lastArtifactAt),
        })
        .run();
      return this.#requireReplay(bigTaskId).snapshot;
    });
  }

  getSnapshot(bigTaskIdInput: BigTaskId): DurableOrchestrationPlanningSnapshot | null {
    const bigTaskId = parseCanonicalBigTaskId(bigTaskIdInput);
    return this.#readSnapshot(() => this.#replay(bigTaskId)?.snapshot ?? null);
  }

  getReviewBundle(bigTaskIdInput: BigTaskId): DurablePlanningReviewBundle | null {
    const bigTaskId = parseCanonicalBigTaskId(bigTaskIdInput);
    return this.#readSnapshot(() => {
      const replayed = this.#replay(bigTaskId);
      return replayed === null ? null : this.#reviewBundleFromReplay(replayed);
    });
  }

  getApprovedTaskContractAuthority(
    bigTaskIdInput: BigTaskId,
  ): ApprovedTaskContractAuthority | null {
    const bigTaskId = parseCanonicalBigTaskId(bigTaskIdInput);
    return this.#readSnapshot(() => {
      const replayed = this.#replay(bigTaskId);
      if (replayed === null) {
        return null;
      }
      const { reviewState } = replayed.snapshot;
      const taskContracts =
        replayed.taskContractsByRevision.get(reviewState.candidate.revision) ?? [];
      const base = {
        projectId: replayed.snapshot.projectId,
        bigTaskId: replayed.snapshot.bigTaskId,
        planRevision: reviewState.candidate.revision,
        candidateBinding: reviewState.candidateBinding,
        reviewPhase: reviewState.phase,
        materialized: replayed.materializationRow !== null,
      } as const;
      if (
        reviewState.phase !== "APPROVED" ||
        taskContracts.length !== reviewState.candidate.subtasks.length
      ) {
        return deepFreeze({
          ...base,
          taskContractAuthorityReadiness:
            "TASK_CONTRACT_AUTHORITY_NOT_READY" as const,
        });
      }
      return deepFreeze({
        ...base,
        reviewPhase: "APPROVED" as const,
        taskContractAuthorityReadiness: "TASK_CONTRACT_AUTHORITY_READY" as const,
        taskContracts,
      });
    });
  }

  #validateCandidateInput(candidateInput: PlanCandidate): PlanCandidate {
    const started = beginPlanReview(candidateInput);
    if (
      started.kind !== "REVIEW_STATE" ||
      !candidateHasDurableText(started.state.candidate)
    ) {
      throw invalidPlanningInput();
    }
    return started.state.candidate;
  }

  #validateBundleInput(
    candidate: PlanCandidate,
    taskContractInputs: readonly TaskContractV0[],
  ): readonly TaskContractV0[] {
    if (!Array.isArray(taskContractInputs)) {
      throw invalidPlanningInput();
    }
    const bySubtaskId = new Map<string, TaskContractV0>();
    const seenReferences = new Set<string>();
    for (const input of taskContractInputs) {
      const contract = parseTaskContractInput(input);
      if (
        bySubtaskId.has(contract.subtaskId) ||
        seenReferences.has(contract.taskContractRef)
      ) {
        throw invalidPlanningInput();
      }
      bySubtaskId.set(contract.subtaskId, contract);
      seenReferences.add(contract.taskContractRef);
    }
    if (bySubtaskId.size !== candidate.subtasks.length) {
      throw invalidPlanningInput();
    }
    const ordered: TaskContractV0[] = [];
    for (const subtask of candidate.subtasks) {
      const contract = bySubtaskId.get(subtask.id);
      if (
        contract === undefined ||
        contract.projectId !== candidate.projectId ||
        contract.bigTaskId !== candidate.bigTaskId ||
        contract.subtaskId !== subtask.id ||
        contract.taskContractRef !== subtask.taskContractRef
      ) {
        throw invalidPlanningInput();
      }
      ordered.push(contract);
    }
    return Object.freeze(ordered);
  }

  #validateNoCanonicalSubtaskCollision(candidate: PlanCandidate): void {
    for (const proposedSubtask of candidate.subtasks) {
      const existing = this.#database
        .select({ id: subtasksTable.id })
        .from(subtasksTable)
        .where(eq(subtasksTable.id, proposedSubtask.id))
        .get();
      if (existing !== undefined) {
        throw planningConflict();
      }
    }
  }

  #reviewBundleFromReplay(
    replayed: ReplayedPlanning,
  ): DurablePlanningReviewBundle {
    const { reviewState } = replayed.snapshot;
    const taskContracts =
      replayed.taskContractsByRevision.get(reviewState.candidate.revision) ?? [];
    return deepFreeze({
      projectId: replayed.snapshot.projectId,
      bigTaskId: replayed.snapshot.bigTaskId,
      reviewState,
      candidateBinding: reviewState.candidateBinding,
      taskContractAuthorityReadiness:
        taskContracts.length === reviewState.candidate.subtasks.length
          ? "TASK_CONTRACT_AUTHORITY_READY"
          : "TASK_CONTRACT_AUTHORITY_NOT_READY",
      taskContracts,
    });
  }

  #validateHistoricalHierarchy(candidate: PlanCandidate): void {
    const project = this.#database
      .select({ id: projectsTable.id })
      .from(projectsTable)
      .where(eq(projectsTable.id, candidate.projectId))
      .get();
    const bigTask = this.#database
      .select({
        id: bigTasksTable.id,
        projectId: bigTasksTable.projectId,
        status: bigTasksTable.status,
      })
      .from(bigTasksTable)
      .where(eq(bigTasksTable.id, candidate.bigTaskId))
      .get();
    const parsedProjectId = ProjectIdSchema.safeParse(project?.id);
    const parsedBigTaskId = BigTaskIdSchema.safeParse(bigTask?.id);
    if (
      project !== undefined &&
      bigTask !== undefined &&
      parsedProjectId.success &&
      parsedProjectId.data === project.id &&
      parsedBigTaskId.success &&
      parsedBigTaskId.data === bigTask.id &&
      bigTask.projectId === candidate.projectId
    ) {
      return;
    }
    throw malformedStoredData();
  }

  #validateMutationEligibility(candidate: PlanCandidate): void {
    const project = this.#database
      .select({ id: projectsTable.id })
      .from(projectsTable)
      .where(eq(projectsTable.id, candidate.projectId))
      .get();
    const bigTask = this.#database
      .select({
        id: bigTasksTable.id,
        projectId: bigTasksTable.projectId,
        status: bigTasksTable.status,
      })
      .from(bigTasksTable)
      .where(eq(bigTasksTable.id, candidate.bigTaskId))
      .get();
    const parsedProjectId = ProjectIdSchema.safeParse(project?.id);
    const parsedBigTaskId = BigTaskIdSchema.safeParse(bigTask?.id);
    if (
      project === undefined ||
      bigTask === undefined ||
      !parsedProjectId.success ||
      parsedProjectId.data !== project.id ||
      !parsedBigTaskId.success ||
      parsedBigTaskId.data !== bigTask.id ||
      bigTask.projectId !== candidate.projectId ||
      bigTask.status !== "IN_PROGRESS"
    ) {
      throw new TaskStorageError(
        "PARENT_NOT_FOUND",
        "The eligible Project and Big Task hierarchy does not exist.",
      );
    }

    for (const proposedSubtask of candidate.subtasks) {
      const parsedId = SubtaskIdSchema.safeParse(proposedSubtask.id);
      if (!parsedId.success || parsedId.data !== proposedSubtask.id) {
        throw invalidPlanningInput();
      }
      const existing = this.#database
        .select({ bigTaskId: subtasksTable.bigTaskId })
        .from(subtasksTable)
        .where(eq(subtasksTable.id, proposedSubtask.id))
        .get();
      if (existing !== undefined && existing.bigTaskId !== candidate.bigTaskId) {
        throw planningConflict();
      }
    }
  }

  #getTrack(bigTaskId: BigTaskId) {
    return this.#database
      .select()
      .from(orchestrationPlanningTracksTable)
      .where(eq(orchestrationPlanningTracksTable.bigTaskId, bigTaskId))
      .get();
  }

  #requireReplay(bigTaskId: BigTaskId): ReplayedPlanning {
    const replayed = this.#replay(bigTaskId);
    if (replayed === null) {
      throw new TaskStorageError("PARENT_NOT_FOUND", "The planning track does not exist.");
    }
    return replayed;
  }

  #replay(bigTaskId: BigTaskId): ReplayedPlanning | null {
    const track = this.#getTrack(bigTaskId);
    if (track === undefined) {
      const orphanedCandidate = this.#database
        .select({ bigTaskId: orchestrationPlanCandidatesTable.bigTaskId })
        .from(orchestrationPlanCandidatesTable)
        .where(eq(orchestrationPlanCandidatesTable.bigTaskId, bigTaskId))
        .get();
      const orphanedDecision = this.#database
        .select({ bigTaskId: orchestrationReviewDecisionsTable.bigTaskId })
        .from(orchestrationReviewDecisionsTable)
        .where(eq(orchestrationReviewDecisionsTable.bigTaskId, bigTaskId))
        .get();
      const orphanedMaterialization = this.#database
        .select({ bigTaskId: orchestrationMaterializationsTable.bigTaskId })
        .from(orchestrationMaterializationsTable)
        .where(eq(orchestrationMaterializationsTable.bigTaskId, bigTaskId))
        .get();
      const orphanedTaskContract = this.#hasTable("task_contracts")
        ? this.#database
            .select({ bigTaskId: taskContractsTable.bigTaskId })
            .from(taskContractsTable)
            .where(eq(taskContractsTable.bigTaskId, bigTaskId))
            .get()
        : undefined;
      const orphanedTaskContractBinding = this.#hasTable(
        "candidate_task_contract_bindings",
      )
        ? this.#database
            .select({ bigTaskId: candidateTaskContractBindingsTable.bigTaskId })
            .from(candidateTaskContractBindingsTable)
            .where(eq(candidateTaskContractBindingsTable.bigTaskId, bigTaskId))
            .get()
        : undefined;
      if (
        orphanedCandidate !== undefined ||
        orphanedDecision !== undefined ||
        orphanedMaterialization !== undefined ||
        orphanedTaskContract !== undefined ||
        orphanedTaskContractBinding !== undefined
      ) {
        throw malformedStoredData();
      }
      return null;
    }
    const parsedBigTaskId = BigTaskIdSchema.safeParse(track.bigTaskId);
    const parsedProjectId = ProjectIdSchema.safeParse(track.projectId);
    if (
      !parsedBigTaskId.success ||
      parsedBigTaskId.data !== track.bigTaskId ||
      !parsedProjectId.success ||
      parsedProjectId.data !== track.projectId
    ) {
      throw malformedStoredData();
    }
    if (!isCanonicalTimestamp(track.createdAt)) {
      throw malformedStoredData();
    }
    const candidateRows = this.#selectCandidateRows(bigTaskId);
    const decisionRows = this.#database
      .select()
      .from(orchestrationReviewDecisionsTable)
      .where(eq(orchestrationReviewDecisionsTable.bigTaskId, bigTaskId))
      .orderBy(asc(orchestrationReviewDecisionsTable.planRevision))
      .all();
    if (candidateRows.length === 0 || candidateRows.length > 3) {
      throw malformedStoredData();
    }
    const candidateHistory = candidateRows.map(parseStoredCandidate);
    const reviewDecisions = decisionRows.map(parseStoredDecision);
    const first = candidateHistory[0]!;
    if (first.candidate.projectId !== track.projectId || first.candidate.bigTaskId !== track.bigTaskId) {
      throw malformedStoredData();
    }
    this.#validateHistoricalHierarchy(first.candidate);
    const started = beginPlanReview(first.candidate);
    if (started.kind !== "REVIEW_STATE") {
      throw malformedStoredData();
    }
    let state = started.state;
    let decisionIndex = 0;
    let lastArtifactAt = track.createdAt;
    for (let candidateIndex = 0; candidateIndex < candidateHistory.length; candidateIndex += 1) {
      const artifact = candidateHistory[candidateIndex]!;
      const candidateRow = candidateRows[candidateIndex]!;
      if (
        artifact.candidate.projectId !== track.projectId ||
        artifact.candidate.bigTaskId !== track.bigTaskId ||
        artifact.candidate.revision !== first.candidate.revision + candidateIndex ||
        new Date(candidateRow.createdAt).getTime() < new Date(lastArtifactAt).getTime()
      ) {
        throw malformedStoredData();
      }
      lastArtifactAt = candidateRow.createdAt;
      this.#validateHistoricalHierarchy(artifact.candidate);
      if (candidateIndex > 0) {
        const revised = submitPlannerRevision(state, artifact.candidate);
        if (revised.kind !== "REVIEW_STATE") {
          throw malformedStoredData();
        }
        state = revised.state;
      }
      const decisionArtifact = reviewDecisions[decisionIndex];
      if (decisionArtifact?.decision.planRevision === artifact.candidate.revision) {
        const decisionRow = decisionRows[decisionIndex]!;
        if (
          new Date(decisionRow.createdAt).getTime() <
          new Date(lastArtifactAt).getTime()
        ) {
          throw malformedStoredData();
        }
        const decided = applyReviewerDecision(state, decisionArtifact.decision);
        if (decided.kind !== "REVIEW_STATE") {
          throw malformedStoredData();
        }
        state = decided.state;
        lastArtifactAt = decisionRow.createdAt;
        decisionIndex += 1;
      }
    }
    if (decisionIndex !== reviewDecisions.length) {
      throw malformedStoredData();
    }

    const taskContractsByRevision = this.#replayTaskContractHistory(
      track.projectId,
      track.bigTaskId,
      candidateRows,
      candidateHistory,
      decisionRows,
    );

    const materializationRow = this.#database
      .select()
      .from(orchestrationMaterializationsTable)
      .where(eq(orchestrationMaterializationsTable.bigTaskId, bigTaskId))
      .get() ?? null;
    let materializedGraph: MaterializedGraph | null = null;
    if (materializationRow !== null) {
      const materialized = materializeApprovedPlan(state);
      if (
        !isCanonicalTimestamp(materializationRow.materializedAt) ||
        materialized.kind !== "MATERIALIZED" ||
        materializationRow.bigTaskId !== track.bigTaskId ||
        materializationRow.projectId !== track.projectId ||
        materializationRow.planRevision !== materialized.graph.planRevision ||
        materializationRow.candidateBinding !== materialized.graph.candidateBinding ||
        new Date(materializationRow.materializedAt).getTime() <
          new Date(lastArtifactAt).getTime()
      ) {
        throw malformedStoredData();
      }
      materializedGraph = materialized.graph;
      lastArtifactAt = materializationRow.materializedAt;
    }

    return {
      snapshot: deepFreeze({
        projectId: first.candidate.projectId,
        bigTaskId: first.candidate.bigTaskId,
        reviewState: state,
        candidateHistory,
        reviewDecisions,
        materializedGraph,
      }),
      materializationRow,
      lastArtifactAt,
      taskContractsByRevision,
    };
  }

  #replayTaskContractHistory(
    projectId: string,
    bigTaskId: string,
    candidateRows: readonly CandidateRow[],
    candidateHistory: readonly DurablePlanCandidateArtifact[],
    decisionRows: readonly DecisionRow[],
  ): ReadonlyMap<number, readonly TaskContractV0[]> {
    const hasBundleMarker = this.#hasColumn(
      "orchestration_plan_candidates",
      "task_contract_count",
    );
    if (!hasBundleMarker) {
      return new Map(
        candidateHistory.map(({ candidate }) => [
          candidate.revision,
          Object.freeze([]) as readonly TaskContractV0[],
        ]),
      );
    }
    if (
      !this.#hasTable("task_contracts") ||
      !this.#hasTable("candidate_task_contract_bindings")
    ) {
      throw malformedStoredData();
    }
    const bindingRows = this.#database
      .select()
      .from(candidateTaskContractBindingsTable)
      .where(eq(candidateTaskContractBindingsTable.bigTaskId, bigTaskId))
      .orderBy(
        asc(candidateTaskContractBindingsTable.planRevision),
        asc(candidateTaskContractBindingsTable.subtaskId),
      )
      .all();
    const contractsByRevision = new Map<number, readonly TaskContractV0[]>();
    const referencedArtifactKeys = new Set<string>();
    let processedBindings = 0;

    for (let index = 0; index < candidateHistory.length; index += 1) {
      const candidateArtifact = candidateHistory[index]!;
      const candidate = candidateArtifact.candidate;
      const candidateRow = candidateRows[index]!;
      const currentBindingRows = bindingRows.filter(
        (row) => row.planRevision === candidate.revision,
      );
      if (candidateRow.taskContractCount === null) {
        if (currentBindingRows.length !== 0) {
          throw malformedStoredData();
        }
        contractsByRevision.set(candidate.revision, Object.freeze([]));
        continue;
      }
      if (
        candidateRow.taskContractCount !== candidate.subtasks.length ||
        currentBindingRows.length !== candidateRow.taskContractCount
      ) {
        throw malformedStoredData();
      }

      const approvingOrRejectingDecision = decisionRows.find(
        (row) => row.planRevision === candidate.revision,
      );
      const orderedContracts: TaskContractV0[] = [];
      for (const proposedSubtask of candidate.subtasks) {
        const matchingRows = currentBindingRows.filter(
          (row) => row.subtaskId === proposedSubtask.id,
        );
        if (matchingRows.length !== 1) {
          throw malformedStoredData();
        }
        const bindingRow = matchingRows[0]!;
        validateStoredTaskContractBinding(bindingRow);
        if (
          bindingRow.projectId !== projectId ||
          bindingRow.bigTaskId !== bigTaskId ||
          bindingRow.planRevision !== candidate.revision ||
          bindingRow.candidateBinding !== candidateArtifact.candidateBinding ||
          bindingRow.subtaskId !== proposedSubtask.id ||
          bindingRow.taskContractRef !== proposedSubtask.taskContractRef ||
          bindingRow.createdAt !== candidateRow.createdAt ||
          (approvingOrRejectingDecision !== undefined &&
            new Date(bindingRow.createdAt).getTime() >
              new Date(approvingOrRejectingDecision.createdAt).getTime())
        ) {
          throw malformedStoredData();
        }

        const contractRow = this.#database
          .select()
          .from(taskContractsTable)
          .where(
            and(
              eq(taskContractsTable.projectId, bindingRow.projectId),
              eq(taskContractsTable.taskContractRef, bindingRow.taskContractRef),
            ),
          )
          .get();
        if (contractRow === undefined) {
          throw malformedStoredData();
        }
        const contract = parseStoredTaskContract(contractRow);
        if (
          contract.projectId !== candidate.projectId ||
          contract.bigTaskId !== candidate.bigTaskId ||
          contract.subtaskId !== proposedSubtask.id ||
          contract.taskContractRef !== proposedSubtask.taskContractRef ||
          new Date(contractRow.createdAt).getTime() >
            new Date(bindingRow.createdAt).getTime()
        ) {
          throw malformedStoredData();
        }
        referencedArtifactKeys.add(
          JSON.stringify([contract.projectId, contract.taskContractRef]),
        );
        orderedContracts.push(contract);
        processedBindings += 1;
      }
      contractsByRevision.set(candidate.revision, Object.freeze(orderedContracts));
    }

    if (processedBindings !== bindingRows.length) {
      throw malformedStoredData();
    }
    const artifactRows = this.#database
      .select()
      .from(taskContractsTable)
      .where(eq(taskContractsTable.bigTaskId, bigTaskId))
      .all();
    for (const artifactRow of artifactRows) {
      const contract = parseStoredTaskContract(artifactRow);
      if (
        contract.projectId !== projectId ||
        contract.bigTaskId !== bigTaskId ||
        !referencedArtifactKeys.has(
          JSON.stringify([contract.projectId, contract.taskContractRef]),
        )
      ) {
        throw malformedStoredData();
      }
    }
    return contractsByRevision;
  }

  #hasTable(tableName: string): boolean {
    return (
      this.#sqlite
        .prepare(
          "SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = ?",
        )
        .get(tableName) !== undefined
    );
  }

  #hasColumn(tableName: string, columnName: string): boolean {
    const columns = this.#sqlite.prepare(`PRAGMA table_info(${tableName})`).all() as unknown as readonly {
      readonly name: string;
    }[];
    return columns.some(({ name }) => name === columnName);
  }

  #selectCandidateRows(bigTaskId: BigTaskId): readonly CandidateRow[] {
    const taskContractCount = this.#hasColumn(
      "orchestration_plan_candidates",
      "task_contract_count",
    )
      ? "task_contract_count"
      : "NULL";
    return this.#sqlite
      .prepare(
        `SELECT big_task_id AS "bigTaskId",
                project_id AS "projectId",
                revision,
                candidate_payload AS "candidatePayload",
                candidate_binding AS "candidateBinding",
                ${taskContractCount} AS "taskContractCount",
                created_at AS "createdAt"
           FROM orchestration_plan_candidates
          WHERE big_task_id = ?
          ORDER BY revision`,
      )
      .all(bigTaskId) as unknown as readonly CandidateRow[];
  }

  #insertCandidate(
    candidate: PlanCandidate,
    binding: string,
    timestamp: string,
    taskContractCount: number | null = null,
  ): void {
    if (
      taskContractCount === null &&
      !this.#hasColumn("orchestration_plan_candidates", "task_contract_count")
    ) {
      this.#sqlite
        .prepare(
          `INSERT INTO orchestration_plan_candidates
             (big_task_id, project_id, revision, candidate_payload, candidate_binding, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          candidate.bigTaskId,
          candidate.projectId,
          candidate.revision,
          canonicalCandidatePayload(candidate),
          binding,
          timestamp,
        );
      return;
    }
    this.#database
      .insert(orchestrationPlanCandidatesTable)
      .values({
        bigTaskId: candidate.bigTaskId,
        projectId: candidate.projectId,
        revision: candidate.revision,
        candidatePayload: canonicalCandidatePayload(candidate),
        candidateBinding: binding,
        ...(taskContractCount === null ? {} : { taskContractCount }),
        createdAt: timestamp,
      })
      .run();
  }

  #insertTaskContractBundle(
    candidate: PlanCandidate,
    candidateBinding: string,
    taskContracts: readonly TaskContractV0[],
    timestamp: string,
  ): void {
    for (const contract of taskContracts) {
      const existing = this.#database
        .select()
        .from(taskContractsTable)
        .where(
          and(
            eq(taskContractsTable.projectId, contract.projectId),
            eq(taskContractsTable.taskContractRef, contract.taskContractRef),
          ),
        )
        .get();
      if (existing === undefined) {
        this.#database
          .insert(taskContractsTable)
          .values({
            projectId: contract.projectId,
            taskContractRef: contract.taskContractRef,
            bigTaskId: contract.bigTaskId,
            subtaskId: contract.subtaskId,
            contractPayload: canonicalTaskContractPayload(contract),
            createdAt: timestamp,
          })
          .run();
      } else {
        const stored = parseStoredTaskContract(existing);
        if (
          canonicalTaskContractPayload(stored) !==
          canonicalTaskContractPayload(contract)
        ) {
          throw planningConflict();
        }
        if (new Date(existing.createdAt).getTime() > new Date(timestamp).getTime()) {
          throw new TaskStorageError(
            "STORAGE_OPERATION_FAILED",
            "The storage clock cannot precede immutable Task Contract authority.",
          );
        }
      }
    }
    for (const contract of taskContracts) {
      this.#database
        .insert(candidateTaskContractBindingsTable)
        .values({
          projectId: candidate.projectId,
          bigTaskId: candidate.bigTaskId,
          planRevision: candidate.revision,
          candidateBinding,
          subtaskId: contract.subtaskId,
          taskContractRef: contract.taskContractRef,
          createdAt: timestamp,
        })
        .run();
    }
  }

  #timestamp(): string {
    const timestamp = this.#clock();
    if (!(timestamp instanceof Date) || Number.isNaN(timestamp.getTime())) {
      throw new TaskStorageError("STORAGE_OPERATION_FAILED", "The storage clock is invalid.");
    }
    return timestamp.toISOString();
  }

  #timestampAtOrAfter(previousTimestamp: string): string {
    const timestamp = this.#timestamp();
    if (new Date(timestamp).getTime() < new Date(previousTimestamp).getTime()) {
      throw new TaskStorageError(
        "STORAGE_OPERATION_FAILED",
        "The storage clock cannot precede durable orchestration state.",
      );
    }
    return timestamp;
  }

  #atomic<T>(operation: () => T): T {
    const ownsTransaction = !this.#sqlite.isTransaction;
    const savepoint = "durable_orchestration_planning_operation";
    if (ownsTransaction) {
      try {
        this.#sqlite.exec("BEGIN IMMEDIATE");
      } catch {
        throw new TaskStorageError("TRANSACTION_FAILED", "The transaction could not start.");
      }
    } else {
      try {
        this.#sqlite.exec(`SAVEPOINT ${savepoint}`);
      } catch {
        throw new TaskStorageError(
          "TRANSACTION_FAILED",
          "The durable orchestration transaction could not start.",
        );
      }
    }
    try {
      const result = operation();
      if (ownsTransaction) {
        this.#sqlite.exec("COMMIT");
      } else {
        this.#sqlite.exec(`RELEASE ${savepoint}`);
      }
      return result;
    } catch (error) {
      if (ownsTransaction && this.#sqlite.isTransaction) {
        try {
          this.#sqlite.exec("ROLLBACK");
        } catch {
          throw new TaskStorageError("TRANSACTION_FAILED", "The transaction rollback failed.");
        }
      } else if (this.#sqlite.isTransaction) {
        try {
          this.#sqlite.exec(`ROLLBACK TO ${savepoint}`);
          this.#sqlite.exec(`RELEASE ${savepoint}`);
        } catch {
          throw new TaskStorageError(
            "TRANSACTION_FAILED",
            "The durable orchestration transaction rollback failed.",
          );
        }
      }
      if (error instanceof TaskStorageError) {
        throw error;
      }
      throw new TaskStorageError("TRANSACTION_FAILED", "The transaction failed and was rolled back.");
    }
  }

  #readSnapshot<T>(operation: () => T): T {
    const ownsTransaction = !this.#sqlite.isTransaction;
    if (ownsTransaction) {
      try {
        this.#sqlite.exec("BEGIN");
      } catch {
        throw new TaskStorageError("TRANSACTION_FAILED", "The read transaction could not start.");
      }
    }
    try {
      const result = operation();
      if (ownsTransaction) {
        this.#sqlite.exec("COMMIT");
      }
      return result;
    } catch (error) {
      if (ownsTransaction && this.#sqlite.isTransaction) {
        try {
          this.#sqlite.exec("ROLLBACK");
        } catch {
          throw new TaskStorageError("TRANSACTION_FAILED", "The read transaction rollback failed.");
        }
      }
      if (error instanceof TaskStorageError) {
        throw error;
      }
      throw new TaskStorageError("TRANSACTION_FAILED", "The read transaction failed and was rolled back.");
    }
  }
}
