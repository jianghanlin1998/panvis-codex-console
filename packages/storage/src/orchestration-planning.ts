import type { DatabaseSync } from "node:sqlite";

import {
  BigTaskIdSchema,
  ProjectIdSchema,
  SubtaskIdSchema,
} from "@codex-task-console/domain";
import type { BigTaskId, ProjectId } from "@codex-task-console/domain";
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
import { asc, eq } from "drizzle-orm";
import type { NodeSQLiteDatabase } from "drizzle-orm/node-sqlite";

import { TaskStorageError } from "./errors.js";
import {
  bigTasksTable,
  orchestrationMaterializationsTable,
  orchestrationPlanCandidatesTable,
  orchestrationPlanningTracksTable,
  orchestrationReviewDecisionsTable,
  projectsTable,
  subtasksTable,
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

type CandidateRow = typeof orchestrationPlanCandidatesTable.$inferSelect;
type DecisionRow = typeof orchestrationReviewDecisionsTable.$inferSelect;
type MaterializationRow = typeof orchestrationMaterializationsTable.$inferSelect;

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
    started.state.candidateBinding !== row.candidateBinding
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
      if (
        orphanedCandidate !== undefined ||
        orphanedDecision !== undefined ||
        orphanedMaterialization !== undefined
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
    const candidateRows = this.#database
      .select()
      .from(orchestrationPlanCandidatesTable)
      .where(eq(orchestrationPlanCandidatesTable.bigTaskId, bigTaskId))
      .orderBy(asc(orchestrationPlanCandidatesTable.revision))
      .all();
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
    };
  }

  #insertCandidate(candidate: PlanCandidate, binding: string, timestamp: string): void {
    this.#database
      .insert(orchestrationPlanCandidatesTable)
      .values({
        bigTaskId: candidate.bigTaskId,
        projectId: candidate.projectId,
        revision: candidate.revision,
        candidatePayload: canonicalCandidatePayload(candidate),
        candidateBinding: binding,
        createdAt: timestamp,
      })
      .run();
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
