import { DatabaseSync } from "node:sqlite";

import {
  AuditEventIdSchema,
  AuditEventSchema,
  BigTaskIdSchema,
  BigTaskSchema,
  ChatThreadIdSchema,
  ChatThreadSchema,
  ContextDigestIdSchema,
  ContextDigestSchema,
  ContextItemIdSchema,
  ContextItemSchema,
  ContextScopeSchema,
  ExecutionProviderIdSchema,
  ExecutionRunIdSchema,
  ExecutionRunSchema,
  JitContextPacketProfileKindSchema,
  ProjectIdSchema,
  ProjectSchema,
  ProviderModelReferenceSchema,
  ProviderRunReferenceSchema,
  ProviderThreadReferenceSchema,
  NormalizedUsageSchema,
  SubtaskImplementationCheckpointIdSchema,
  SubtaskImplementationCheckpointSchema,
  SubtaskCreateInputSchema,
  SubtaskDependencySchema,
  SubtaskIdSchema,
  SubtaskSchema,
  WorktreeOwnershipIdSchema,
  buildAllowedContextSet,
  deriveContextScope,
  evaluateSubtaskDependencyReadiness,
  validateSubtaskDependencies,
  validateSubtaskMaturityTransition,
  validateSubtaskTransition,
} from "@codex-task-console/domain";
import type {
  AuditEvent,
  AuditEventId,
  AllowedContextSet,
  BigTask,
  BigTaskId,
  ChatThread,
  ChatThreadId,
  ContextDigest,
  ContextDigestId,
  ContextItem,
  ContextItemId,
  ContextScope,
  DependencyReadinessResult,
  DependencySubtask,
  ExecutionProviderId,
  ExecutionRun,
  ExecutionRunId,
  JitContextPacketProfileKind,
  Project,
  ProjectId,
  ProviderModelReference,
  ProviderRunReference,
  ProviderThreadReference,
  NormalizedUsage,
  Subtask,
  SubtaskCreateInput,
  SubtaskDependency,
  SubtaskId,
  SubtaskImplementationCheckpoint,
  SubtaskImplementationCheckpointId,
  WorktreeOwnershipId,
} from "@codex-task-console/domain";
import type { PlanCandidate, ReviewDecision } from "@codex-task-console/orchestration";
import { and, asc, count, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-sqlite";
import type { NodeSQLiteDatabase } from "drizzle-orm/node-sqlite";

import { TaskStorageError } from "./errors.js";
import { defaultMigrationsFolder, runMigrations } from "./migrations.js";
import { DurableOrchestrationPlanningStore } from "./orchestration-planning.js";
import type { DurableOrchestrationPlanningSnapshot } from "./orchestration-planning.js";
import {
  auditEventsTable,
  bigTasksTable,
  chatThreadsTable,
  contextDigestsTable,
  contextItemsTable,
  executionRunsTable,
  projectsTable,
  subtaskImplementationCheckpointsTable,
  subtasksTable,
  taskDependenciesTable,
} from "./schema.js";
import { decodeStringArray, encodeStringArray } from "./structured-fields.js";
import { registerTaskStorageWorktreeAccess } from "./task-storage-internals.js";

export interface OpenTaskDatabaseOptions {
  readonly databasePath: string;
  readonly clock?: () => Date;
  readonly migrationsFolder?: string;
}

export interface CompleteSubtaskImplementationInput {
  readonly subtaskId: SubtaskId;
  readonly checkpoint: SubtaskImplementationCheckpoint;
}

export interface CompleteSubtaskImplementationResult {
  readonly subtask: Subtask;
  readonly checkpoint: SubtaskImplementationCheckpoint;
}

export interface CreateChatThreadInput {
  readonly id: ChatThreadId;
  readonly subtaskId: SubtaskId;
  readonly providerId: ExecutionProviderId;
}

export interface BindChatThreadProviderReferenceInput {
  readonly chatThreadId: ChatThreadId;
  readonly providerThread: ProviderThreadReference;
}

export interface CreateExecutionRunInput {
  readonly id: ExecutionRunId;
  readonly chatThreadId: ChatThreadId;
}

export interface StartExecutionRunInput {
  readonly executionRunId: ExecutionRunId;
  readonly providerRun: ProviderRunReference;
  readonly providerModel?: ProviderModelReference;
}

export interface FinishExecutionRunInput {
  readonly executionRunId: ExecutionRunId;
  readonly status: "SUCCEEDED" | "FAILED" | "INTERRUPTED";
  readonly providerModel?: ProviderModelReference;
  readonly normalizedUsage?: NormalizedUsage;
}

export interface ReservePrimaryExecutionAttemptInput {
  readonly subtaskId: SubtaskId;
  readonly worktreeOwnershipId: WorktreeOwnershipId;
  readonly chatThreadId: ChatThreadId;
  readonly executionRunId: ExecutionRunId;
  readonly providerId: ExecutionProviderId;
}

export interface ReservedPrimaryExecutionAttempt {
  readonly chatThread: ChatThread;
  readonly executionRun: ExecutionRun;
}

export type FinalizePrimaryExecutionAttemptInput = FinishExecutionRunInput;

export interface FinalizedPrimaryExecutionAttempt {
  readonly chatThread: ChatThread;
  readonly executionRun: ExecutionRun;
}

export interface BoundedDurableExecutionHistoryOptions {
  readonly maxChatThreads: number;
  readonly maxExecutionRunsPerThread: number;
}

export interface BoundedDurableExecutionHistoryThread {
  readonly chatThread: ChatThread;
  readonly executionRuns: readonly ExecutionRun[];
}

export interface BoundedDurableExecutionHistory {
  readonly chatThreadCount: number;
  readonly recentChatThreads: readonly BoundedDurableExecutionHistoryThread[];
}

const MAX_BOUNDED_DURABLE_HISTORY_LIMIT = 64;

const parseBoundedDurableHistoryLimit = (value: number): number => {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_BOUNDED_DURABLE_HISTORY_LIMIT
  ) {
    throw new TaskStorageError(
      "INVALID_INPUT",
      "The bounded durable execution history limit is invalid.",
    );
  }
  return value;
};

type ProjectContextScope = Extract<
  ContextScope,
  { readonly scopeType: "PROJECT" }
>;
type BigTaskContextScope = Extract<
  ContextScope,
  { readonly scopeType: "BIG_TASK" }
>;
type SubtaskContextScope = Extract<
  ContextScope,
  { readonly scopeType: "SUBTASK" }
>;

export interface AllowedRawContextItemBucket<Scope extends ContextScope = ContextScope> {
  readonly scope: Scope;
  readonly contextItems: readonly ContextItem[];
}

export interface AllowedRawContextItemSnapshot {
  readonly allowedContextSet: AllowedContextSet;
  readonly buckets: readonly [
    AllowedRawContextItemBucket<ProjectContextScope>,
    AllowedRawContextItemBucket<BigTaskContextScope>,
    AllowedRawContextItemBucket<SubtaskContextScope>,
  ];
}

export interface ActiveContextItemBucket<Scope extends ContextScope = ContextScope> {
  readonly scope: Scope;
  readonly contextItems: readonly ContextItem[];
}

export interface ActiveContextItemSnapshot {
  readonly allowedContextSet: AllowedContextSet;
  readonly buckets: readonly [
    ActiveContextItemBucket<ProjectContextScope>,
    ActiveContextItemBucket<BigTaskContextScope>,
    ActiveContextItemBucket<SubtaskContextScope>,
  ];
}

export type JitContextStorageSourceSnapshot =
  | Readonly<{
      profile: "STANDARD_SUBTASK_EXECUTION";
      project: Project;
      bigTask: BigTask;
      subtask: Subtask;
      allowedContextSet: AllowedContextSet;
      activeContext: Readonly<{
        project: readonly ContextItem[];
        bigTask: readonly ContextItem[];
        subtask: readonly ContextItem[];
      }>;
    }>
  | Readonly<{
      profile: "FRESH_INDEPENDENT_QA";
      project: Project;
      bigTask: BigTask;
      subtask: Subtask;
    }>
  | Readonly<{
      profile: "FOCUSED_RE_QA";
      project: Project;
      bigTask: BigTask;
      subtask: Subtask;
    }>;

interface CanonicalTaskHierarchy {
  readonly project: Project;
  readonly bigTask: BigTask;
  readonly subtask: Subtask;
}

type ProjectRow = typeof projectsTable.$inferSelect;
type BigTaskRow = typeof bigTasksTable.$inferSelect;
type SubtaskRow = typeof subtasksTable.$inferSelect;
type ChatThreadRow = typeof chatThreadsTable.$inferSelect;
type ExecutionRunRow = typeof executionRunsTable.$inferSelect;
type ContextItemRow = typeof contextItemsTable.$inferSelect;
type ContextDigestRow = typeof contextDigestsTable.$inferSelect;
type AuditEventRow = typeof auditEventsTable.$inferSelect;
type SubtaskImplementationCheckpointRow =
  typeof subtaskImplementationCheckpointsTable.$inferSelect;

const invalidInput = (entity: string): TaskStorageError =>
  new TaskStorageError("INVALID_INPUT", `${entity} input does not satisfy the domain contract.`);

const parseProjectInput = (input: Project): Project => {
  const result = ProjectSchema.safeParse(input);
  if (!result.success) {
    throw invalidInput("Project");
  }
  return result.data;
};

const parseBigTaskInput = (input: BigTask): BigTask => {
  const result = BigTaskSchema.safeParse(input);
  if (!result.success) {
    throw invalidInput("Big Task");
  }
  return result.data;
};

const parseSubtaskInput = (input: SubtaskCreateInput): SubtaskCreateInput => {
  const result = SubtaskCreateInputSchema.safeParse(input);
  if (!result.success) {
    throw invalidInput("Subtask");
  }
  return result.data;
};

const parseProjectId = (input: ProjectId): ProjectId => {
  const result = ProjectIdSchema.safeParse(input);
  if (!result.success) {
    throw invalidInput("Project ID");
  }
  return result.data;
};

const parseBigTaskId = (input: BigTaskId): BigTaskId => {
  const result = BigTaskIdSchema.safeParse(input);
  if (!result.success) {
    throw invalidInput("Big Task ID");
  }
  return result.data;
};

const parseSubtaskId = (input: SubtaskId): SubtaskId => {
  const result = SubtaskIdSchema.safeParse(input);
  if (!result.success) {
    throw invalidInput("Subtask ID");
  }
  return result.data;
};

const parseCanonicalSubtaskId = (input: SubtaskId): SubtaskId => {
  const subtaskId = parseSubtaskId(input);
  if (subtaskId !== input) {
    throw invalidInput("Subtask ID");
  }
  return subtaskId;
};

const parseChatThreadId = (input: ChatThreadId): ChatThreadId => {
  const result = ChatThreadIdSchema.safeParse(input);
  if (!result.success || result.data !== input) {
    throw invalidInput("ChatThread ID");
  }
  return result.data;
};

const parseExecutionRunId = (input: ExecutionRunId): ExecutionRunId => {
  const result = ExecutionRunIdSchema.safeParse(input);
  if (!result.success || result.data !== input) {
    throw invalidInput("ExecutionRun ID");
  }
  return result.data;
};

const parseExecutionProviderId = (
  input: ExecutionProviderId,
): ExecutionProviderId => {
  const result = ExecutionProviderIdSchema.safeParse(input);
  if (!result.success) {
    throw invalidInput("Execution provider ID");
  }
  return result.data;
};

const parseStrictInputRecord = (
  input: unknown,
  entity: string,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = [],
): Record<string, unknown> => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw invalidInput(entity);
  }
  const record = input as Record<string, unknown>;
  const keys = Object.keys(record);
  const allowedKeys = new Set([...requiredKeys, ...optionalKeys]);
  if (
    requiredKeys.some((key) => !Object.hasOwn(record, key)) ||
    keys.some((key) => !allowedKeys.has(key))
  ) {
    throw invalidInput(entity);
  }
  return record;
};

const parseCreateChatThreadInput = (
  input: CreateChatThreadInput,
): CreateChatThreadInput => {
  const record = parseStrictInputRecord(input, "ChatThread", [
    "id",
    "subtaskId",
    "providerId",
  ]);
  return {
    id: parseChatThreadId(record.id as ChatThreadId),
    subtaskId: parseCanonicalSubtaskId(record.subtaskId as SubtaskId),
    providerId: parseExecutionProviderId(record.providerId as ExecutionProviderId),
  };
};

const parseBindChatThreadProviderReferenceInput = (
  input: BindChatThreadProviderReferenceInput,
): BindChatThreadProviderReferenceInput => {
  const record = parseStrictInputRecord(input, "ChatThread provider binding", [
    "chatThreadId",
    "providerThread",
  ]);
  const providerThread = ProviderThreadReferenceSchema.safeParse(
    record.providerThread,
  );
  if (!providerThread.success) {
    throw invalidInput("Provider thread reference");
  }
  return {
    chatThreadId: parseChatThreadId(record.chatThreadId as ChatThreadId),
    providerThread: providerThread.data,
  };
};

const parseCreateExecutionRunInput = (
  input: CreateExecutionRunInput,
): CreateExecutionRunInput => {
  const record = parseStrictInputRecord(input, "ExecutionRun", [
    "id",
    "chatThreadId",
  ]);
  return {
    id: parseExecutionRunId(record.id as ExecutionRunId),
    chatThreadId: parseChatThreadId(record.chatThreadId as ChatThreadId),
  };
};

const parseStartExecutionRunInput = (
  input: StartExecutionRunInput,
): StartExecutionRunInput => {
  const record = parseStrictInputRecord(
    input,
    "ExecutionRun start",
    ["executionRunId", "providerRun"],
    ["providerModel"],
  );
  const providerRun = ProviderRunReferenceSchema.safeParse(record.providerRun);
  const providerModel =
    record.providerModel === undefined
      ? undefined
      : ProviderModelReferenceSchema.safeParse(record.providerModel);
  if (!providerRun.success || (providerModel !== undefined && !providerModel.success)) {
    throw invalidInput("ExecutionRun start");
  }
  return {
    executionRunId: parseExecutionRunId(record.executionRunId as ExecutionRunId),
    providerRun: providerRun.data,
    ...(providerModel === undefined ? {} : { providerModel: providerModel.data }),
  };
};

const parseFinishExecutionRunInput = (
  input: FinishExecutionRunInput,
): FinishExecutionRunInput => {
  const record = parseStrictInputRecord(
    input,
    "ExecutionRun finish",
    ["executionRunId", "status"],
    ["providerModel", "normalizedUsage"],
  );
  const status = record.status;
  const providerModel =
    record.providerModel === undefined
      ? undefined
      : ProviderModelReferenceSchema.safeParse(record.providerModel);
  const normalizedUsage =
    record.normalizedUsage === undefined
      ? undefined
      : NormalizedUsageSchema.safeParse(record.normalizedUsage);
  if (
    (status !== "SUCCEEDED" && status !== "FAILED" && status !== "INTERRUPTED") ||
    (providerModel !== undefined && !providerModel.success) ||
    (normalizedUsage !== undefined && !normalizedUsage.success)
  ) {
    throw invalidInput("ExecutionRun finish");
  }
  return {
    executionRunId: parseExecutionRunId(record.executionRunId as ExecutionRunId),
    status,
    ...(providerModel === undefined ? {} : { providerModel: providerModel.data }),
    ...(normalizedUsage === undefined
      ? {}
      : { normalizedUsage: normalizedUsage.data }),
  };
};

const parseReservePrimaryExecutionAttemptInput = (
  input: ReservePrimaryExecutionAttemptInput,
): ReservePrimaryExecutionAttemptInput => {
  const record = parseStrictInputRecord(input, "Primary execution attempt reservation", [
    "subtaskId",
    "worktreeOwnershipId",
    "chatThreadId",
    "executionRunId",
    "providerId",
  ]);
  const ownershipId = WorktreeOwnershipIdSchema.safeParse(
    record.worktreeOwnershipId,
  );
  if (!ownershipId.success) {
    throw invalidInput("Primary execution attempt reservation");
  }
  return {
    subtaskId: parseCanonicalSubtaskId(record.subtaskId as SubtaskId),
    worktreeOwnershipId: ownershipId.data,
    chatThreadId: parseChatThreadId(record.chatThreadId as ChatThreadId),
    executionRunId: parseExecutionRunId(record.executionRunId as ExecutionRunId),
    providerId: parseExecutionProviderId(record.providerId as ExecutionProviderId),
  };
};

const parseJitContextPacketProfileKind = (
  input: JitContextPacketProfileKind,
): JitContextPacketProfileKind => {
  const result = JitContextPacketProfileKindSchema.safeParse(input);
  if (!result.success) {
    throw invalidInput("JIT Context Packet profile");
  }
  return result.data;
};

const freezeJitContextStorageSourceSnapshot = (
  snapshot: JitContextStorageSourceSnapshot,
): JitContextStorageSourceSnapshot => {
  const freezeRecursively = (value: unknown): void => {
    if (typeof value !== "object" || value === null) {
      return;
    }
    for (const nestedValue of Object.values(value)) {
      freezeRecursively(nestedValue);
    }
    Object.freeze(value);
  };

  freezeRecursively(snapshot);
  return snapshot;
};

const parseContextItemId = (input: ContextItemId): ContextItemId => {
  const result = ContextItemIdSchema.safeParse(input);
  if (!result.success) {
    throw invalidInput("Context Item ID");
  }
  return result.data;
};

const parseContextItemInput = (input: ContextItem): ContextItem => {
  const result = ContextItemSchema.safeParse(input);
  if (!result.success) {
    throw invalidInput("Context Item");
  }
  return result.data;
};

const parseContextDigestId = (input: ContextDigestId): ContextDigestId => {
  const result = ContextDigestIdSchema.safeParse(input);
  if (!result.success) {
    throw invalidInput("Context Digest ID");
  }
  return result.data;
};

const parseContextDigestInput = (input: ContextDigest): ContextDigest => {
  const result = ContextDigestSchema.safeParse(input);
  if (!result.success) {
    throw invalidInput("Context Digest");
  }
  return result.data;
};

const parseAuditEventId = (input: AuditEventId): AuditEventId => {
  const result = AuditEventIdSchema.safeParse(input);
  if (!result.success) {
    throw invalidInput("Audit Event ID");
  }
  return result.data;
};

const parseAuditEventInput = (input: AuditEvent): AuditEvent => {
  const result = AuditEventSchema.safeParse(input);
  if (!result.success) {
    throw invalidInput("Audit Event");
  }
  return result.data;
};

const parseSubtaskImplementationCheckpointId = (
  input: SubtaskImplementationCheckpointId,
): SubtaskImplementationCheckpointId => {
  const result = SubtaskImplementationCheckpointIdSchema.safeParse(input);
  if (!result.success || result.data !== input) {
    throw invalidInput("Subtask Implementation Checkpoint ID");
  }
  return result.data;
};

const parseCompleteSubtaskImplementationInput = (
  input: CompleteSubtaskImplementationInput,
): CompleteSubtaskImplementationInput => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw invalidInput("Subtask implementation completion");
  }
  const inputRecord = input as unknown as Record<string, unknown>;
  const keys = Object.keys(inputRecord).sort();
  if (keys.length !== 2 || keys[0] !== "checkpoint" || keys[1] !== "subtaskId") {
    throw invalidInput("Subtask implementation completion");
  }

  const subtaskId = parseCanonicalSubtaskId(inputRecord.subtaskId as SubtaskId);
  const checkpointResult = SubtaskImplementationCheckpointSchema.safeParse(
    inputRecord.checkpoint,
  );
  if (!checkpointResult.success) {
    throw invalidInput("Subtask Implementation Checkpoint");
  }
  const checkpointInput = inputRecord.checkpoint as Record<string, unknown>;
  if (
    checkpointResult.data.id !== checkpointInput.id ||
    checkpointResult.data.subtaskId !== checkpointInput.subtaskId
  ) {
    throw invalidInput("Subtask Implementation Checkpoint");
  }
  return { subtaskId, checkpoint: checkpointResult.data };
};

const parseContextScope = (input: ContextScope): ContextScope => {
  const result = ContextScopeSchema.safeParse(input);
  if (!result.success) {
    throw invalidInput("Context Scope");
  }
  return result.data;
};

const parseDependencyInput = (input: SubtaskDependency): SubtaskDependency => {
  const result = SubtaskDependencySchema.safeParse(input);
  if (!result.success) {
    throw invalidInput("Subtask dependency");
  }
  return result.data;
};

const malformedStoredData = (): TaskStorageError =>
  new TaskStorageError("MALFORMED_STORED_DATA", "Stored task data is malformed.");

const EXECUTION_RUN_UNSAFE_USAGE_INTEGER_PREDICATE = `
  (typeof(input_tokens) = 'integer'
    and (input_tokens < -9007199254740991 or input_tokens > 9007199254740991))
  or (typeof(cached_input_tokens) = 'integer'
    and (cached_input_tokens < -9007199254740991 or cached_input_tokens > 9007199254740991))
  or (typeof(output_tokens) = 'integer'
    and (output_tokens < -9007199254740991 or output_tokens > 9007199254740991))
  or (typeof(reasoning_tokens) = 'integer'
    and (reasoning_tokens < -9007199254740991 or reasoning_tokens > 9007199254740991))
  or (typeof(total_tokens) = 'integer'
    and (total_tokens < -9007199254740991 or total_tokens > 9007199254740991))
  or (typeof(tool_call_count) = 'integer'
    and (tool_call_count < -9007199254740991 or tool_call_count > 9007199254740991))`;

const projectFromRow = (row: ProjectRow): Project => {
  const repository =
    row.repositoryKind === "PATH"
      ? { kind: "PATH", path: row.repositoryValue }
      : { kind: row.repositoryKind, reference: row.repositoryValue };
  const result = ProjectSchema.safeParse({
    recordType: "PROJECT",
    id: row.id,
    name: row.name,
    slug: row.slug,
    repository,
    defaultBranch: row.defaultBranch,
    maxActiveCodingSubtasks: row.maxActiveCodingSubtasks,
  });
  if (!result.success) {
    throw malformedStoredData();
  }
  const project = result.data;
  if (
    project.id !== row.id ||
    project.name !== row.name ||
    project.slug !== row.slug ||
    project.repository.kind !== row.repositoryKind ||
    (project.repository.kind === "PATH"
      ? project.repository.path
      : project.repository.reference) !== row.repositoryValue ||
    project.defaultBranch !== row.defaultBranch ||
    project.maxActiveCodingSubtasks !== row.maxActiveCodingSubtasks
  ) {
    throw malformedStoredData();
  }
  return project;
};

const bigTaskFromRow = (row: BigTaskRow): BigTask => {
  const result = BigTaskSchema.safeParse({
    recordType: "BIG_TASK",
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    goal: row.goal,
    rationale: row.rationale,
    scopeIn: decodeStringArray(row.scopeIn),
    scopeOut: decodeStringArray(row.scopeOut),
    acceptanceCriteria: decodeStringArray(row.acceptanceCriteria),
    status: row.status,
  });
  if (!result.success) {
    throw malformedStoredData();
  }
  const bigTask = result.data;
  if (
    bigTask.id !== row.id ||
    bigTask.projectId !== row.projectId ||
    bigTask.title !== row.title ||
    bigTask.goal !== row.goal ||
    bigTask.rationale !== row.rationale ||
    encodeStringArray(bigTask.scopeIn) !== row.scopeIn ||
    encodeStringArray(bigTask.scopeOut) !== row.scopeOut ||
    encodeStringArray(bigTask.acceptanceCriteria) !== row.acceptanceCriteria ||
    bigTask.status !== row.status
  ) {
    throw malformedStoredData();
  }
  return bigTask;
};

const subtaskFromRow = (row: SubtaskRow): Subtask => {
  const result = SubtaskSchema.safeParse({
    recordType: "SUBTASK",
    id: row.id,
    bigTaskId: row.bigTaskId,
    title: row.title,
    goal: row.goal,
    scopeIn: decodeStringArray(row.scopeIn),
    scopeOut: decodeStringArray(row.scopeOut),
    acceptanceCriteria: decodeStringArray(row.acceptanceCriteria),
    untouchedAreas: decodeStringArray(row.untouchedAreas),
    status: row.status,
    maturity: row.maturity,
    startPolicy: row.startPolicy,
    delegationPolicy: row.delegationPolicy,
    recommendedReasoningLevel: row.recommendedReasoningLevel,
    promptSeed: row.promptSeed,
  });
  if (!result.success) {
    throw malformedStoredData();
  }
  const subtask = result.data;
  if (
    subtask.id !== row.id ||
    subtask.bigTaskId !== row.bigTaskId ||
    subtask.title !== row.title ||
    subtask.goal !== row.goal ||
    encodeStringArray(subtask.scopeIn) !== row.scopeIn ||
    encodeStringArray(subtask.scopeOut) !== row.scopeOut ||
    encodeStringArray(subtask.acceptanceCriteria) !== row.acceptanceCriteria ||
    encodeStringArray(subtask.untouchedAreas) !== row.untouchedAreas ||
    subtask.status !== row.status ||
    subtask.maturity !== row.maturity ||
    subtask.startPolicy !== row.startPolicy ||
    subtask.delegationPolicy !== row.delegationPolicy ||
    subtask.recommendedReasoningLevel !== row.recommendedReasoningLevel ||
    subtask.promptSeed !== row.promptSeed
  ) {
    throw malformedStoredData();
  }
  return subtask;
};

const chatThreadFromRow = (row: ChatThreadRow): ChatThread => {
  if (
    !isCanonicalUtcTimestamp(row.createdAt) ||
    !isCanonicalUtcTimestamp(row.updatedAt) ||
    (row.closedAt !== null && !isCanonicalUtcTimestamp(row.closedAt))
  ) {
    throw malformedStoredData();
  }
  const providerThread =
    row.providerThreadId === null
      ? null
      : {
          providerId: row.providerId,
          providerThreadId: row.providerThreadId,
        };
  const result = ChatThreadSchema.safeParse({
    id: row.id,
    subtaskId: row.subtaskId,
    providerId: row.providerId,
    providerThread,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    closedAt: row.closedAt,
  });
  if (
    !result.success ||
    result.data.id !== row.id ||
    result.data.subtaskId !== row.subtaskId ||
    result.data.providerId !== row.providerId ||
    result.data.providerThread?.providerThreadId !==
      (row.providerThreadId ?? undefined)
  ) {
    throw malformedStoredData();
  }
  return result.data;
};

const executionRunFromRow = (
  row: ExecutionRunRow,
  owningThread: ChatThread,
): ExecutionRun => {
  if (
    !isCanonicalUtcTimestamp(row.createdAt) ||
    !isCanonicalUtcTimestamp(row.updatedAt) ||
    (row.startedAt !== null && !isCanonicalUtcTimestamp(row.startedAt)) ||
    (row.endedAt !== null && !isCanonicalUtcTimestamp(row.endedAt)) ||
    (row.providerThreadId === null) !== (row.providerRunId === null)
  ) {
    throw malformedStoredData();
  }
  const usageValues = [
    row.inputTokens,
    row.cachedInputTokens,
    row.outputTokens,
    row.reasoningTokens,
    row.totalTokens,
    row.runtimeSeconds,
    row.toolCallCount,
  ];
  if (
    (row.usagePresent !== 0 && row.usagePresent !== 1) ||
    (row.usagePresent === 0 && usageValues.some((value) => value !== null))
  ) {
    throw malformedStoredData();
  }
  const normalizedUsage =
    row.usagePresent === 0
      ? null
      : {
          ...(row.inputTokens === null ? {} : { inputTokens: row.inputTokens }),
          ...(row.cachedInputTokens === null
            ? {}
            : { cachedInputTokens: row.cachedInputTokens }),
          ...(row.outputTokens === null ? {} : { outputTokens: row.outputTokens }),
          ...(row.reasoningTokens === null
            ? {}
            : { reasoningTokens: row.reasoningTokens }),
          ...(row.totalTokens === null ? {} : { totalTokens: row.totalTokens }),
          ...(row.runtimeSeconds === null
            ? {}
            : { runtimeSeconds: row.runtimeSeconds }),
          ...(row.toolCallCount === null
            ? {}
            : { toolCallCount: row.toolCallCount }),
        };
  const providerRun =
    row.providerThreadId === null || row.providerRunId === null
      ? null
      : {
          providerId: owningThread.providerId,
          providerThreadId: row.providerThreadId,
          providerRunId: row.providerRunId,
        };
  const providerModel =
    row.providerModelId === null
      ? null
      : {
          providerId: owningThread.providerId,
          providerModelId: row.providerModelId,
        };
  if (
    providerRun !== null &&
    (owningThread.providerThread === null ||
      providerRun.providerThreadId !== owningThread.providerThread.providerThreadId)
  ) {
    throw malformedStoredData();
  }
  const result = ExecutionRunSchema.safeParse({
    id: row.id,
    chatThreadId: row.chatThreadId,
    status: row.status,
    providerRun,
    providerModel,
    normalizedUsage,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
  });
  if (
    !result.success ||
    result.data.id !== row.id ||
    result.data.chatThreadId !== row.chatThreadId ||
    result.data.providerRun?.providerThreadId !==
      (row.providerThreadId ?? undefined) ||
    result.data.providerRun?.providerRunId !== (row.providerRunId ?? undefined) ||
    result.data.providerModel?.providerModelId !==
      (row.providerModelId ?? undefined)
  ) {
    throw malformedStoredData();
  }
  return result.data;
};

const dependencyFromRow = (row: {
  readonly upstreamSubtaskId: string;
  readonly downstreamSubtaskId: string;
  readonly dependencyType: string;
  readonly requiredGate: string;
  readonly reason: string;
}): SubtaskDependency => {
  const result = SubtaskDependencySchema.safeParse(row);
  if (
    !result.success ||
    result.data.upstreamSubtaskId !== row.upstreamSubtaskId ||
    result.data.downstreamSubtaskId !== row.downstreamSubtaskId ||
    result.data.dependencyType !== row.dependencyType ||
    result.data.requiredGate !== row.requiredGate ||
    result.data.reason !== row.reason
  ) {
    throw malformedStoredData();
  }
  return result.data;
};

const isCanonicalUtcTimestamp = (value: string): boolean => {
  const timestamp = new Date(value);
  return !Number.isNaN(timestamp.getTime()) && timestamp.toISOString() === value;
};

const contextItemFromRow = (row: ContextItemRow): ContextItem => {
  if (!isCanonicalUtcTimestamp(row.createdAt) || !isCanonicalUtcTimestamp(row.updatedAt)) {
    throw malformedStoredData();
  }

  const result = ContextItemSchema.safeParse({
    id: row.id,
    projectId: row.projectId,
    ...(row.bigTaskId === null ? {} : { bigTaskId: row.bigTaskId }),
    ...(row.subtaskId === null ? {} : { subtaskId: row.subtaskId }),
    kind: row.kind,
    status: row.status,
    authority: row.authority,
    title: row.title,
    body: row.body,
    provenance: {
      sourceType: row.sourceType,
      sourceReference: row.sourceReference,
      effectiveAt: row.effectiveAt,
      ...(row.supersedesContextItemId === null
        ? {}
        : { supersedesContextItemId: row.supersedesContextItemId }),
    },
  });
  if (!result.success) {
    throw malformedStoredData();
  }

  const contextItem = result.data;
  if (
    contextItem.id !== row.id ||
    contextItem.projectId !== row.projectId ||
    ("bigTaskId" in contextItem ? contextItem.bigTaskId : null) !== row.bigTaskId ||
    ("subtaskId" in contextItem ? contextItem.subtaskId : null) !== row.subtaskId ||
    contextItem.kind !== row.kind ||
    contextItem.status !== row.status ||
    contextItem.authority !== row.authority ||
    contextItem.title !== row.title ||
    contextItem.body !== row.body ||
    contextItem.provenance.sourceType !== row.sourceType ||
    contextItem.provenance.sourceReference !== row.sourceReference ||
    contextItem.provenance.effectiveAt !== row.effectiveAt ||
    (contextItem.provenance.supersedesContextItemId ?? null) !==
      row.supersedesContextItemId
  ) {
    throw malformedStoredData();
  }
  return contextItem;
};

const scopeMatchesStoredValues = (
  scope: ContextScope,
  projectId: string,
  bigTaskId: string | null,
  subtaskId: string | null,
): boolean =>
  scope.projectId === projectId &&
  (scope.scopeType === "PROJECT" ? null : scope.bigTaskId) === bigTaskId &&
  (scope.scopeType === "SUBTASK" ? scope.subtaskId : null) === subtaskId;

const scopeFromStoredValues = (
  projectId: string,
  bigTaskId: string | null,
  subtaskId: string | null,
): ContextScope => {
  if (bigTaskId === null && subtaskId !== null) {
    throw malformedStoredData();
  }
  const result = ContextScopeSchema.safeParse(
    bigTaskId === null
      ? { scopeType: "PROJECT", projectId }
      : subtaskId === null
        ? { scopeType: "BIG_TASK", projectId, bigTaskId }
        : { scopeType: "SUBTASK", projectId, bigTaskId, subtaskId },
  );
  if (
    !result.success ||
    !scopeMatchesStoredValues(result.data, projectId, bigTaskId, subtaskId)
  ) {
    throw malformedStoredData();
  }
  return result.data;
};

const contextDigestFromRow = (row: ContextDigestRow): ContextDigest => {
  if (
    !isCanonicalUtcTimestamp(row.createdAt) ||
    !isCanonicalUtcTimestamp(row.updatedAt)
  ) {
    throw malformedStoredData();
  }
  const scope = scopeFromStoredValues(row.projectId, row.bigTaskId, row.subtaskId);
  const result = ContextDigestSchema.safeParse({
    id: row.id,
    scope,
    body: row.body,
    provenance: {
      sourceType: row.sourceType,
      sourceReference: row.sourceReference,
      effectiveAt: row.effectiveAt,
    },
  });
  if (!result.success) {
    throw malformedStoredData();
  }
  const contextDigest = result.data;
  if (
    contextDigest.id !== row.id ||
    !scopeMatchesStoredValues(
      contextDigest.scope,
      row.projectId,
      row.bigTaskId,
      row.subtaskId,
    ) ||
    contextDigest.body !== row.body ||
    contextDigest.provenance.sourceType !== row.sourceType ||
    contextDigest.provenance.sourceReference !== row.sourceReference ||
    contextDigest.provenance.effectiveAt !== row.effectiveAt
  ) {
    throw malformedStoredData();
  }
  return contextDigest;
};

const auditEventFromRow = (row: AuditEventRow): AuditEvent => {
  if (!isCanonicalUtcTimestamp(row.createdAt)) {
    throw malformedStoredData();
  }
  const scope = scopeFromStoredValues(row.projectId, row.bigTaskId, row.subtaskId);
  const result = AuditEventSchema.safeParse({
    id: row.id,
    scope,
    eventType: row.eventType,
    actorType: row.actorType,
    ...(row.actorReference === null ? {} : { actorReference: row.actorReference }),
    summary: row.summary,
    ...(row.subjectReference === null
      ? {}
      : { subjectReference: row.subjectReference }),
    occurredAt: row.occurredAt,
  });
  if (!result.success) {
    throw malformedStoredData();
  }
  const auditEvent = result.data;
  if (
    auditEvent.id !== row.id ||
    !scopeMatchesStoredValues(
      auditEvent.scope,
      row.projectId,
      row.bigTaskId,
      row.subtaskId,
    ) ||
    auditEvent.eventType !== row.eventType ||
    auditEvent.actorType !== row.actorType ||
    (auditEvent.actorReference ?? null) !== row.actorReference ||
    auditEvent.summary !== row.summary ||
    (auditEvent.subjectReference ?? null) !== row.subjectReference ||
    auditEvent.occurredAt !== row.occurredAt
  ) {
    throw malformedStoredData();
  }
  return auditEvent;
};

const subtaskImplementationCheckpointFromRow = (
  row: SubtaskImplementationCheckpointRow,
): SubtaskImplementationCheckpoint => {
  if (
    !isCanonicalUtcTimestamp(row.occurredAt) ||
    !isCanonicalUtcTimestamp(row.createdAt)
  ) {
    throw malformedStoredData();
  }
  const result = SubtaskImplementationCheckpointSchema.safeParse({
    id: row.id,
    subtaskId: row.subtaskId,
    repositoryCommitSha: row.repositoryCommitSha,
    actorType: row.actorType,
    ...(row.actorReference === null ? {} : { actorReference: row.actorReference }),
    sourceReference: row.sourceReference,
    summary: row.summary,
    occurredAt: row.occurredAt,
  });
  if (!result.success) {
    throw malformedStoredData();
  }
  const checkpoint = result.data;
  if (
    checkpoint.id !== row.id ||
    checkpoint.subtaskId !== row.subtaskId ||
    checkpoint.repositoryCommitSha !== row.repositoryCommitSha ||
    checkpoint.actorType !== row.actorType ||
    (checkpoint.actorReference ?? null) !== row.actorReference ||
    checkpoint.sourceReference !== row.sourceReference ||
    checkpoint.summary !== row.summary ||
    checkpoint.occurredAt !== row.occurredAt
  ) {
    throw malformedStoredData();
  }
  return checkpoint;
};

const contextScopesEqual = (left: ContextScope, right: ContextScope): boolean => {
  switch (left.scopeType) {
    case "PROJECT":
      return right.scopeType === "PROJECT" && left.projectId === right.projectId;
    case "BIG_TASK":
      return (
        right.scopeType === "BIG_TASK" &&
        left.projectId === right.projectId &&
        left.bigTaskId === right.bigTaskId
      );
    case "SUBTASK":
      return (
        right.scopeType === "SUBTASK" &&
        left.projectId === right.projectId &&
        left.bigTaskId === right.bigTaskId &&
        left.subtaskId === right.subtaskId
      );
  }
};

const JAVASCRIPT_TRIM_CHARACTERS =
  "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";

const canonicalStoredIdentifierPredicate = (
  column:
    | typeof contextItemsTable.projectId
    | typeof contextItemsTable.bigTaskId
    | typeof contextItemsTable.subtaskId
    | typeof contextItemsTable.supersedesContextItemId,
  canonicalId: string,
) =>
  eq(
    sql<string>`trim(${column}, ${JAVASCRIPT_TRIM_CHARACTERS})`,
    canonicalId,
  );

const noncanonicalContextScopeAliasPredicate = (scope: ContextScope) => {
  const canonicalProject = canonicalStoredIdentifierPredicate(
    contextItemsTable.projectId,
    scope.projectId,
  );
  switch (scope.scopeType) {
    case "PROJECT":
      return and(
        canonicalProject,
        ne(contextItemsTable.projectId, scope.projectId),
        isNull(contextItemsTable.bigTaskId),
        isNull(contextItemsTable.subtaskId),
      );
    case "BIG_TASK":
      return and(
        canonicalProject,
        canonicalStoredIdentifierPredicate(
          contextItemsTable.bigTaskId,
          scope.bigTaskId,
        ),
        or(
          ne(contextItemsTable.projectId, scope.projectId),
          ne(contextItemsTable.bigTaskId, scope.bigTaskId),
        ),
        isNull(contextItemsTable.subtaskId),
      );
    case "SUBTASK":
      return and(
        canonicalProject,
        canonicalStoredIdentifierPredicate(
          contextItemsTable.bigTaskId,
          scope.bigTaskId,
        ),
        canonicalStoredIdentifierPredicate(
          contextItemsTable.subtaskId,
          scope.subtaskId,
        ),
        or(
          ne(contextItemsTable.projectId, scope.projectId),
          ne(contextItemsTable.bigTaskId, scope.bigTaskId),
          ne(contextItemsTable.subtaskId, scope.subtaskId),
        ),
      );
  }
};

const contextScopePredicate = (scope: ContextScope) => {
  switch (scope.scopeType) {
    case "PROJECT":
      return and(
        eq(contextItemsTable.projectId, scope.projectId),
        isNull(contextItemsTable.bigTaskId),
        isNull(contextItemsTable.subtaskId),
      );
    case "BIG_TASK":
      return and(
        eq(contextItemsTable.projectId, scope.projectId),
        eq(contextItemsTable.bigTaskId, scope.bigTaskId),
        isNull(contextItemsTable.subtaskId),
      );
    case "SUBTASK":
      return and(
        eq(contextItemsTable.projectId, scope.projectId),
        eq(contextItemsTable.bigTaskId, scope.bigTaskId),
        eq(contextItemsTable.subtaskId, scope.subtaskId),
      );
  }
};

const contextDigestScopePredicate = (scope: ContextScope) => {
  switch (scope.scopeType) {
    case "PROJECT":
      return and(
        eq(contextDigestsTable.projectId, scope.projectId),
        isNull(contextDigestsTable.bigTaskId),
        isNull(contextDigestsTable.subtaskId),
      );
    case "BIG_TASK":
      return and(
        eq(contextDigestsTable.projectId, scope.projectId),
        eq(contextDigestsTable.bigTaskId, scope.bigTaskId),
        isNull(contextDigestsTable.subtaskId),
      );
    case "SUBTASK":
      return and(
        eq(contextDigestsTable.projectId, scope.projectId),
        eq(contextDigestsTable.bigTaskId, scope.bigTaskId),
        eq(contextDigestsTable.subtaskId, scope.subtaskId),
      );
  }
};

const auditEventScopePredicate = (scope: ContextScope) => {
  switch (scope.scopeType) {
    case "PROJECT":
      return and(
        eq(auditEventsTable.projectId, scope.projectId),
        isNull(auditEventsTable.bigTaskId),
        isNull(auditEventsTable.subtaskId),
      );
    case "BIG_TASK":
      return and(
        eq(auditEventsTable.projectId, scope.projectId),
        eq(auditEventsTable.bigTaskId, scope.bigTaskId),
        isNull(auditEventsTable.subtaskId),
      );
    case "SUBTASK":
      return and(
        eq(auditEventsTable.projectId, scope.projectId),
        eq(auditEventsTable.bigTaskId, scope.bigTaskId),
        eq(auditEventsTable.subtaskId, scope.subtaskId),
      );
  }
};

export class TaskStorage {
  readonly #sqlite: DatabaseSync;
  readonly #database: NodeSQLiteDatabase;
  readonly #clock: () => Date;
  readonly #orchestrationPlanning: DurableOrchestrationPlanningStore;
  #closed = false;

  constructor(sqlite: DatabaseSync, database: NodeSQLiteDatabase, clock: () => Date) {
    this.#sqlite = sqlite;
    this.#database = database;
    this.#clock = clock;
    this.#orchestrationPlanning = new DurableOrchestrationPlanningStore(
      sqlite,
      database,
      clock,
    );
    registerTaskStorageWorktreeAccess(this, {
      sqlite,
      clock,
      isOpen: () => this.isOpen,
    });
  }

  get isOpen(): boolean {
    return !this.#closed && this.#sqlite.isOpen;
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    try {
      this.#sqlite.close();
      this.#closed = true;
    } catch {
      throw new TaskStorageError("DATABASE_CLOSE_FAILED", "The task database could not be closed.");
    }
  }

  isForeignKeyEnforcementEnabled(): boolean {
    return this.#operation(() => {
      const row = this.#sqlite.prepare("PRAGMA foreign_keys").get() as
        | { readonly foreign_keys: number }
        | undefined;
      return row?.foreign_keys === 1;
    });
  }

  createProject(input: Project): Project {
    const project = parseProjectInput(input);
    return this.#operation(() => {
      const existing = this.#database
        .select({ id: projectsTable.id })
        .from(projectsTable)
        .where(or(eq(projectsTable.id, project.id), eq(projectsTable.slug, project.slug)))
        .get();
      if (existing !== undefined) {
        throw new TaskStorageError("CONFLICT", "A Project with this ID or slug already exists.");
      }

      const timestamp = this.#timestamp();
      this.#database
        .insert(projectsTable)
        .values({
          id: project.id,
          name: project.name,
          slug: project.slug,
          repositoryKind: project.repository.kind,
          repositoryValue:
            project.repository.kind === "PATH"
              ? project.repository.path
              : project.repository.reference,
          defaultBranch: project.defaultBranch,
          maxActiveCodingSubtasks: project.maxActiveCodingSubtasks,
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        .run();
      const stored = this.#getProject(project.id);
      if (stored === null) {
        throw new TaskStorageError("STORAGE_OPERATION_FAILED", "The Project was not persisted.");
      }
      return stored;
    });
  }

  getProjectById(input: ProjectId): Project | null {
    const projectId = parseProjectId(input);
    return this.#operation(() => this.#getProject(projectId));
  }

  getProjectBySlug(slug: string): Project | null {
    if (typeof slug !== "string" || slug.trim().length === 0) {
      throw invalidInput("Project slug");
    }
    return this.#operation(() => {
      const row = this.#database
        .select()
        .from(projectsTable)
        .where(eq(projectsTable.slug, slug))
        .get();
      return row === undefined ? null : projectFromRow(row);
    });
  }

  listProjects(): readonly Project[] {
    return this.#operation(() =>
      this.#database
        .select()
        .from(projectsTable)
        .orderBy(asc(projectsTable.createdAt), asc(projectsTable.id))
        .all()
        .map(projectFromRow),
    );
  }

  createBigTask(input: BigTask): BigTask {
    const bigTask = parseBigTaskInput(input);
    return this.#operation(() => {
      if (this.#getProject(bigTask.projectId) === null) {
        throw new TaskStorageError("PARENT_NOT_FOUND", "The parent Project does not exist.");
      }
      if (this.#getBigTask(bigTask.id) !== null) {
        throw new TaskStorageError("CONFLICT", "A Big Task with this ID already exists.");
      }

      const timestamp = this.#timestamp();
      this.#database
        .insert(bigTasksTable)
        .values({
          id: bigTask.id,
          projectId: bigTask.projectId,
          title: bigTask.title,
          goal: bigTask.goal,
          rationale: bigTask.rationale,
          scopeIn: encodeStringArray(bigTask.scopeIn),
          scopeOut: encodeStringArray(bigTask.scopeOut),
          acceptanceCriteria: encodeStringArray(bigTask.acceptanceCriteria),
          status: bigTask.status,
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        .run();
      const stored = this.#getBigTask(bigTask.id);
      if (stored === null) {
        throw new TaskStorageError("STORAGE_OPERATION_FAILED", "The Big Task was not persisted.");
      }
      return stored;
    });
  }

  getBigTaskById(input: BigTaskId): BigTask | null {
    const bigTaskId = parseBigTaskId(input);
    return this.#operation(() => this.#getBigTask(bigTaskId));
  }

  listBigTasksByProject(input: ProjectId): readonly BigTask[] {
    const projectId = parseProjectId(input);
    return this.#operation(() =>
      this.#database
        .select()
        .from(bigTasksTable)
        .where(eq(bigTasksTable.projectId, projectId))
        .orderBy(asc(bigTasksTable.createdAt), asc(bigTasksTable.id))
        .all()
        .map(bigTaskFromRow),
    );
  }

  createSubtask(input: SubtaskCreateInput): Subtask {
    const subtask = parseSubtaskInput(input);
    return this.#operation(() => {
      if (this.#getBigTask(subtask.bigTaskId) === null) {
        throw new TaskStorageError("PARENT_NOT_FOUND", "The parent Big Task does not exist.");
      }
      if (this.#getSubtask(subtask.id) !== null) {
        throw new TaskStorageError("CONFLICT", "A Subtask with this ID already exists.");
      }

      const timestamp = this.#timestamp();
      this.#database
        .insert(subtasksTable)
        .values({
          id: subtask.id,
          bigTaskId: subtask.bigTaskId,
          title: subtask.title,
          goal: subtask.goal,
          scopeIn: encodeStringArray(subtask.scopeIn),
          scopeOut: encodeStringArray(subtask.scopeOut),
          acceptanceCriteria: encodeStringArray(subtask.acceptanceCriteria),
          untouchedAreas: encodeStringArray(subtask.untouchedAreas),
          status: subtask.status,
          maturity: subtask.maturity,
          startPolicy: subtask.startPolicy,
          delegationPolicy: subtask.delegationPolicy,
          recommendedReasoningLevel: subtask.recommendedReasoningLevel,
          promptSeed: subtask.promptSeed,
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        .run();
      const stored = this.#getSubtask(subtask.id);
      if (stored === null) {
        throw new TaskStorageError("STORAGE_OPERATION_FAILED", "The Subtask was not persisted.");
      }
      return stored;
    });
  }

  getSubtaskById(input: SubtaskId): Subtask | null {
    const subtaskId = parseSubtaskId(input);
    return this.#operation(() => this.#getSubtask(subtaskId));
  }

  listSubtasksByBigTask(input: BigTaskId): readonly Subtask[] {
    const bigTaskId = parseBigTaskId(input);
    return this.#operation(() =>
      this.#database
        .select()
        .from(subtasksTable)
        .where(eq(subtasksTable.bigTaskId, bigTaskId))
        .orderBy(asc(subtasksTable.createdAt), asc(subtasksTable.id))
        .all()
        .map(subtaskFromRow),
    );
  }

  beginDurablePlanning(candidate: PlanCandidate): DurableOrchestrationPlanningSnapshot {
    return this.#operation(() => this.#orchestrationPlanning.begin(candidate));
  }

  recordDurableReviewerDecision(
    bigTaskId: BigTaskId,
    decision: ReviewDecision,
  ): DurableOrchestrationPlanningSnapshot {
    return this.#operation(() =>
      this.#orchestrationPlanning.recordReviewerDecision(bigTaskId, decision),
    );
  }

  submitDurablePlannerRevision(
    candidate: PlanCandidate,
  ): DurableOrchestrationPlanningSnapshot {
    return this.#operation(() => this.#orchestrationPlanning.submitRevision(candidate));
  }

  materializeDurablePlan(bigTaskId: BigTaskId): DurableOrchestrationPlanningSnapshot {
    return this.#operation(() => this.#orchestrationPlanning.materialize(bigTaskId));
  }

  getDurablePlanningSnapshot(
    bigTaskId: BigTaskId,
  ): DurableOrchestrationPlanningSnapshot | null {
    return this.#operation(() => this.#orchestrationPlanning.getSnapshot(bigTaskId));
  }

  reservePrimaryExecutionAttempt(
    input: ReservePrimaryExecutionAttemptInput,
  ): ReservedPrimaryExecutionAttempt {
    const reservation = parseReservePrimaryExecutionAttemptInput(input);
    return this.#operation(() =>
      this.#atomic(() => {
        const subtask = this.#getSubtask(reservation.subtaskId);
        if (subtask === null) {
          throw new TaskStorageError(
            "PARENT_NOT_FOUND",
            "The parent Subtask does not exist.",
          );
        }
        if (subtask.status !== "IN_PROGRESS") {
          throw new TaskStorageError(
            "CONFLICT",
            "The primary execution attempt requires an execution-eligible Subtask.",
          );
        }
        const readiness = this.evaluateStoredSubtaskDependencyReadiness(
          reservation.subtaskId,
        );
        if (!readiness.valid || !readiness.ready) {
          throw new TaskStorageError(
            "CONFLICT",
            "The primary execution attempt requires ready stored dependencies.",
          );
        }
        const activeOwnership = this.#sqlite
          .prepare(
            `SELECT id
               FROM worktree_ownerships
              WHERE id = ? AND subtask_id = ? AND status = 'ACTIVE'`,
          )
          .get(
            reservation.worktreeOwnershipId,
            reservation.subtaskId,
          ) as { readonly id: string } | undefined;
        if (activeOwnership?.id !== reservation.worktreeOwnershipId) {
          throw new TaskStorageError(
            "CONFLICT",
            "The primary execution attempt requires exact ACTIVE worktree authority.",
          );
        }
        const activeAttempt = this.#sqlite
          .prepare(
            `SELECT er.id
               FROM execution_runs er
               JOIN chat_threads ct ON ct.id = er.chat_thread_id
              WHERE ct.subtask_id = ?
                AND er.status IN ('CREATED', 'RUNNING')
              LIMIT 1`,
          )
          .get(reservation.subtaskId) as { readonly id: string } | undefined;
        if (activeAttempt !== undefined) {
          throw new TaskStorageError(
            "CONFLICT",
            "The Subtask already has an active primary execution attempt.",
          );
        }
        if (
          this.#getChatThread(reservation.chatThreadId) !== null ||
          this.#getExecutionRun(reservation.executionRunId) !== null
        ) {
          throw new TaskStorageError(
            "CONFLICT",
            "The primary execution attempt identity already exists.",
          );
        }

        const timestamp = this.#timestamp();
        this.#database
          .insert(chatThreadsTable)
          .values({
            id: reservation.chatThreadId,
            subtaskId: reservation.subtaskId,
            providerId: reservation.providerId,
            providerThreadId: null,
            status: "OPEN",
            createdAt: timestamp,
            updatedAt: timestamp,
            closedAt: null,
          })
          .run();
        this.#database
          .insert(executionRunsTable)
          .values({
            id: reservation.executionRunId,
            chatThreadId: reservation.chatThreadId,
            status: "CREATED",
            providerThreadId: null,
            providerRunId: null,
            providerModelId: null,
            usagePresent: 0,
            inputTokens: null,
            cachedInputTokens: null,
            outputTokens: null,
            reasoningTokens: null,
            totalTokens: null,
            runtimeSeconds: null,
            toolCallCount: null,
            createdAt: timestamp,
            updatedAt: timestamp,
            startedAt: null,
            endedAt: null,
          })
          .run();
        const chatThread = this.#getChatThread(reservation.chatThreadId);
        const executionRun = this.#getExecutionRun(reservation.executionRunId);
        if (chatThread === null || executionRun === null) {
          throw new TaskStorageError(
            "STORAGE_OPERATION_FAILED",
            "The primary execution attempt was not persisted.",
          );
        }
        return Object.freeze({ chatThread, executionRun });
      }),
    );
  }

  createChatThread(input: CreateChatThreadInput): ChatThread {
    const threadInput = parseCreateChatThreadInput(input);
    return this.#operation(() =>
      this.#atomic(() => {
        if (this.#getSubtask(threadInput.subtaskId) === null) {
          throw new TaskStorageError(
            "PARENT_NOT_FOUND",
            "The parent Subtask does not exist.",
          );
        }
        if (this.#getChatThread(threadInput.id) !== null) {
          throw new TaskStorageError(
            "CONFLICT",
            "A ChatThread with this ID already exists.",
          );
        }
        const timestamp = this.#timestamp();
        this.#database
          .insert(chatThreadsTable)
          .values({
            id: threadInput.id,
            subtaskId: threadInput.subtaskId,
            providerId: threadInput.providerId,
            providerThreadId: null,
            status: "OPEN",
            createdAt: timestamp,
            updatedAt: timestamp,
            closedAt: null,
          })
          .run();
        const stored = this.#getChatThread(threadInput.id);
        if (stored === null) {
          throw new TaskStorageError(
            "STORAGE_OPERATION_FAILED",
            "The ChatThread was not persisted.",
          );
        }
        return stored;
      }),
    );
  }

  getChatThreadById(input: ChatThreadId): ChatThread | null {
    const chatThreadId = parseChatThreadId(input);
    return this.#operation(() => this.#getChatThread(chatThreadId));
  }

  listChatThreadsForSubtask(input: SubtaskId): readonly ChatThread[] {
    const subtaskId = parseCanonicalSubtaskId(input);
    return this.#operation(() =>
      this.#database
        .select()
        .from(chatThreadsTable)
        .where(eq(chatThreadsTable.subtaskId, subtaskId))
        .orderBy(asc(chatThreadsTable.createdAt), asc(chatThreadsTable.id))
        .all()
        .map((row) => this.#chatThreadFromRow(row)),
    );
  }

  readBoundedDurableExecutionHistoryForSubtask(
    input: SubtaskId,
    options: BoundedDurableExecutionHistoryOptions,
  ): BoundedDurableExecutionHistory {
    const subtaskId = parseCanonicalSubtaskId(input);
    const parsedOptions = parseStrictInputRecord(
      options,
      "Bounded durable execution history",
      ["maxChatThreads", "maxExecutionRunsPerThread"],
    );
    const maxChatThreads = parseBoundedDurableHistoryLimit(
      parsedOptions.maxChatThreads as number,
    );
    const maxExecutionRunsPerThread = parseBoundedDurableHistoryLimit(
      parsedOptions.maxExecutionRunsPerThread as number,
    );
    return this.#operation(() =>
      this.#readSnapshot(() => {
        const countRow = this.#database
          .select({ value: count() })
          .from(chatThreadsTable)
          .where(eq(chatThreadsTable.subtaskId, subtaskId))
          .get();
        if (
          countRow === undefined ||
          !Number.isSafeInteger(countRow.value) ||
          countRow.value < 0
        ) {
          throw malformedStoredData();
        }
        const recentRows = this.#database
          .select()
          .from(chatThreadsTable)
          .where(eq(chatThreadsTable.subtaskId, subtaskId))
          .orderBy(desc(chatThreadsTable.createdAt), desc(chatThreadsTable.id))
          .limit(maxChatThreads)
          .all()
          .reverse();
        const recentChatThreads = recentRows.map((row) => {
          const chatThread = this.#chatThreadFromRow(row);
          this.#assertExecutionRunUsageIntegersAreDecodable(
            "chat_thread_id",
            chatThread.id,
          );
          const executionRuns = this.#database
            .select()
            .from(executionRunsTable)
            .where(eq(executionRunsTable.chatThreadId, chatThread.id))
            .orderBy(
              desc(executionRunsTable.createdAt),
              desc(executionRunsTable.id),
            )
            .limit(maxExecutionRunsPerThread)
            .all()
            .reverse()
            .map((runRow) => this.#executionRunFromRow(runRow));
          return Object.freeze({
            chatThread,
            executionRuns: Object.freeze(executionRuns),
          });
        });
        return Object.freeze({
          chatThreadCount: countRow.value,
          recentChatThreads: Object.freeze(recentChatThreads),
        });
      }),
    );
  }

  bindChatThreadProviderReference(
    input: BindChatThreadProviderReferenceInput,
  ): ChatThread {
    const { chatThreadId, providerThread } =
      parseBindChatThreadProviderReferenceInput(input);
    return this.#operation(() =>
      this.#atomic(() => {
        const row = this.#database
          .select()
          .from(chatThreadsTable)
          .where(eq(chatThreadsTable.id, chatThreadId))
          .get();
        if (row === undefined) {
          throw new TaskStorageError("PARENT_NOT_FOUND", "The ChatThread does not exist.");
        }
        const thread = this.#chatThreadFromRow(row);
        if (providerThread.providerId !== thread.providerId) {
          throw new TaskStorageError(
            "CONFLICT",
            "The provider thread reference does not match the ChatThread provider.",
          );
        }
        if (thread.providerThread !== null) {
          if (
            thread.providerThread.providerId === providerThread.providerId &&
            thread.providerThread.providerThreadId === providerThread.providerThreadId
          ) {
            return thread;
          }
          throw new TaskStorageError(
            "CONFLICT",
            "The ChatThread provider reference is immutable.",
          );
        }
        if (thread.status !== "OPEN") {
          throw new TaskStorageError(
            "CONFLICT",
            "A closed ChatThread cannot acquire a provider reference.",
          );
        }
        const owner = this.#database
          .select({ id: chatThreadsTable.id })
          .from(chatThreadsTable)
          .where(
            and(
              eq(chatThreadsTable.providerId, providerThread.providerId),
              eq(chatThreadsTable.providerThreadId, providerThread.providerThreadId),
            ),
          )
          .get();
        if (owner !== undefined && owner.id !== thread.id) {
          throw new TaskStorageError(
            "CONFLICT",
            "The provider thread reference already belongs to another ChatThread.",
          );
        }
        const timestamp = this.#durableTimestampAtOrAfter(thread.updatedAt);
        const update = this.#database
          .update(chatThreadsTable)
          .set({
            providerThreadId: providerThread.providerThreadId,
            updatedAt: timestamp,
          })
          .where(
            and(
              eq(chatThreadsTable.id, thread.id),
              eq(chatThreadsTable.status, "OPEN"),
              isNull(chatThreadsTable.providerThreadId),
              eq(chatThreadsTable.updatedAt, thread.updatedAt),
            ),
          )
          .run();
        if (update.changes !== 1) {
          throw new TaskStorageError(
            "CONFLICT",
            "The ChatThread provider reference could not be persisted.",
          );
        }
        const stored = this.#getChatThread(thread.id);
        if (stored?.providerThread?.providerThreadId !== providerThread.providerThreadId) {
          throw new TaskStorageError(
            "STORAGE_OPERATION_FAILED",
            "The ChatThread provider reference was not persisted.",
          );
        }
        return stored;
      }),
    );
  }

  closeChatThread(input: ChatThreadId): ChatThread {
    const chatThreadId = parseChatThreadId(input);
    return this.#operation(() =>
      this.#atomic(() => {
        const row = this.#database
          .select()
          .from(chatThreadsTable)
          .where(eq(chatThreadsTable.id, chatThreadId))
          .get();
        if (row === undefined) {
          throw new TaskStorageError("PARENT_NOT_FOUND", "The ChatThread does not exist.");
        }
        const thread = this.#chatThreadFromRow(row);
        if (thread.status !== "OPEN") {
          throw new TaskStorageError(
            "CONFLICT",
            "The ChatThread is already closed.",
          );
        }
        const activeRun = this.#database
          .select({ id: executionRunsTable.id })
          .from(executionRunsTable)
          .where(
            and(
              eq(executionRunsTable.chatThreadId, thread.id),
              inArray(executionRunsTable.status, ["CREATED", "RUNNING"]),
            ),
          )
          .get();
        if (activeRun !== undefined) {
          throw new TaskStorageError(
            "CONFLICT",
            "A ChatThread with a non-terminal ExecutionRun cannot be closed.",
          );
        }
        const timestamp = this.#durableTimestampAtOrAfter(thread.updatedAt);
        const update = this.#database
          .update(chatThreadsTable)
          .set({ status: "CLOSED", updatedAt: timestamp, closedAt: timestamp })
          .where(
            and(
              eq(chatThreadsTable.id, thread.id),
              eq(chatThreadsTable.status, "OPEN"),
              eq(chatThreadsTable.updatedAt, thread.updatedAt),
            ),
          )
          .run();
        if (update.changes !== 1) {
          throw new TaskStorageError(
            "CONFLICT",
            "The ChatThread close transition could not be persisted.",
          );
        }
        const stored = this.#getChatThread(thread.id);
        if (stored?.status !== "CLOSED") {
          throw new TaskStorageError(
            "STORAGE_OPERATION_FAILED",
            "The ChatThread close transition was not persisted.",
          );
        }
        return stored;
      }),
    );
  }

  createExecutionRun(input: CreateExecutionRunInput): ExecutionRun {
    const runInput = parseCreateExecutionRunInput(input);
    return this.#operation(() =>
      this.#atomic(() => {
        const thread = this.#getChatThread(runInput.chatThreadId);
        if (thread === null) {
          throw new TaskStorageError(
            "PARENT_NOT_FOUND",
            "The parent ChatThread does not exist.",
          );
        }
        if (thread.status !== "OPEN") {
          throw new TaskStorageError(
            "CONFLICT",
            "A closed ChatThread cannot receive an ExecutionRun.",
          );
        }
        if (this.#getExecutionRun(runInput.id) !== null) {
          throw new TaskStorageError(
            "CONFLICT",
            "An ExecutionRun with this ID already exists.",
          );
        }
        const timestamp = this.#timestamp();
        this.#database
          .insert(executionRunsTable)
          .values({
            id: runInput.id,
            chatThreadId: runInput.chatThreadId,
            status: "CREATED",
            providerThreadId: null,
            providerRunId: null,
            providerModelId: null,
            usagePresent: 0,
            inputTokens: null,
            cachedInputTokens: null,
            outputTokens: null,
            reasoningTokens: null,
            totalTokens: null,
            runtimeSeconds: null,
            toolCallCount: null,
            createdAt: timestamp,
            updatedAt: timestamp,
            startedAt: null,
            endedAt: null,
          })
          .run();
        const stored = this.#getExecutionRun(runInput.id);
        if (stored === null) {
          throw new TaskStorageError(
            "STORAGE_OPERATION_FAILED",
            "The ExecutionRun was not persisted.",
          );
        }
        return stored;
      }),
    );
  }

  getExecutionRunById(input: ExecutionRunId): ExecutionRun | null {
    const executionRunId = parseExecutionRunId(input);
    return this.#operation(() => this.#getExecutionRun(executionRunId));
  }

  listExecutionRunsForChatThread(input: ChatThreadId): readonly ExecutionRun[] {
    const chatThreadId = parseChatThreadId(input);
    return this.#operation(() => {
      this.#assertExecutionRunUsageIntegersAreDecodable(
        "chat_thread_id",
        chatThreadId,
      );
      return this.#database
        .select()
        .from(executionRunsTable)
        .where(eq(executionRunsTable.chatThreadId, chatThreadId))
        .orderBy(asc(executionRunsTable.createdAt), asc(executionRunsTable.id))
        .all()
        .map((row) => this.#executionRunFromRow(row));
    });
  }

  startExecutionRun(input: StartExecutionRunInput): ExecutionRun {
    const { executionRunId, providerRun, providerModel } =
      parseStartExecutionRunInput(input);
    return this.#operation(() =>
      this.#atomic(() => {
        const row = this.#database
          .select()
          .from(executionRunsTable)
          .where(eq(executionRunsTable.id, executionRunId))
          .get();
        if (row === undefined) {
          throw new TaskStorageError("PARENT_NOT_FOUND", "The ExecutionRun does not exist.");
        }
        const run = this.#executionRunFromRow(row);
        const thread = this.#getChatThread(run.chatThreadId);
        if (thread === null) {
          throw malformedStoredData();
        }
        if (run.status !== "CREATED") {
          throw new TaskStorageError(
            "CONFLICT",
            "Only a created ExecutionRun can be started.",
          );
        }
        if (thread.status !== "OPEN") {
          throw new TaskStorageError(
            "CONFLICT",
            "An ExecutionRun cannot start on a closed ChatThread.",
          );
        }
        if (
          thread.providerThread === null ||
          providerRun.providerId !== thread.providerId ||
          providerRun.providerThreadId !== thread.providerThread.providerThreadId
        ) {
          throw new TaskStorageError(
            "CONFLICT",
            "The provider run reference does not match the owning ChatThread.",
          );
        }
        if (providerModel !== undefined && providerModel.providerId !== thread.providerId) {
          throw new TaskStorageError(
            "CONFLICT",
            "The provider model reference does not match the owning ChatThread.",
          );
        }
        const providerRunOwner = this.#database
          .select({ id: executionRunsTable.id })
          .from(executionRunsTable)
          .where(
            and(
              eq(executionRunsTable.chatThreadId, run.chatThreadId),
              eq(executionRunsTable.providerRunId, providerRun.providerRunId),
            ),
          )
          .get();
        if (providerRunOwner !== undefined && providerRunOwner.id !== run.id) {
          throw new TaskStorageError(
            "CONFLICT",
            "The provider run reference already belongs to another ExecutionRun.",
          );
        }
        const timestamp = this.#durableTimestampAtOrAfter(run.updatedAt);
        const update = this.#database
          .update(executionRunsTable)
          .set({
            status: "RUNNING",
            providerThreadId: providerRun.providerThreadId,
            providerRunId: providerRun.providerRunId,
            providerModelId: providerModel?.providerModelId ?? null,
            updatedAt: timestamp,
            startedAt: timestamp,
          })
          .where(
            and(
              eq(executionRunsTable.id, run.id),
              eq(executionRunsTable.status, "CREATED"),
              eq(executionRunsTable.updatedAt, run.updatedAt),
            ),
          )
          .run();
        if (update.changes !== 1) {
          throw new TaskStorageError(
            "CONFLICT",
            "The ExecutionRun start transition could not be persisted.",
          );
        }
        const stored = this.#getExecutionRun(run.id);
        if (stored?.status !== "RUNNING") {
          throw new TaskStorageError(
            "STORAGE_OPERATION_FAILED",
            "The ExecutionRun start transition was not persisted.",
          );
        }
        return stored;
      }),
    );
  }

  failExecutionRunBeforeStart(input: ExecutionRunId): ExecutionRun {
    const executionRunId = parseExecutionRunId(input);
    return this.#operation(() =>
      this.#atomic(() => {
        const row = this.#database
          .select()
          .from(executionRunsTable)
          .where(eq(executionRunsTable.id, executionRunId))
          .get();
        if (row === undefined) {
          throw new TaskStorageError("PARENT_NOT_FOUND", "The ExecutionRun does not exist.");
        }
        const run = this.#executionRunFromRow(row);
        if (run.status !== "CREATED") {
          throw new TaskStorageError(
            "CONFLICT",
            "Only a created ExecutionRun can fail before start.",
          );
        }
        const timestamp = this.#durableTimestampAtOrAfter(run.updatedAt);
        const update = this.#database
          .update(executionRunsTable)
          .set({ status: "FAILED", updatedAt: timestamp, endedAt: timestamp })
          .where(
            and(
              eq(executionRunsTable.id, run.id),
              eq(executionRunsTable.status, "CREATED"),
              eq(executionRunsTable.updatedAt, run.updatedAt),
            ),
          )
          .run();
        if (update.changes !== 1) {
          throw new TaskStorageError(
            "CONFLICT",
            "The pre-start failure transition could not be persisted.",
          );
        }
        const stored = this.#getExecutionRun(run.id);
        if (stored?.status !== "FAILED" || stored.startedAt !== null) {
          throw new TaskStorageError(
            "STORAGE_OPERATION_FAILED",
            "The pre-start failure transition was not persisted.",
          );
        }
        return stored;
      }),
    );
  }

  finishExecutionRun(input: FinishExecutionRunInput): ExecutionRun {
    const { executionRunId, status, providerModel, normalizedUsage } =
      parseFinishExecutionRunInput(input);
    return this.#operation(() =>
      this.#atomic(() => {
        const row = this.#database
          .select()
          .from(executionRunsTable)
          .where(eq(executionRunsTable.id, executionRunId))
          .get();
        if (row === undefined) {
          throw new TaskStorageError("PARENT_NOT_FOUND", "The ExecutionRun does not exist.");
        }
        const run = this.#executionRunFromRow(row);
        const thread = this.#getChatThread(run.chatThreadId);
        if (thread === null) {
          throw malformedStoredData();
        }
        if (run.status !== "RUNNING") {
          throw new TaskStorageError(
            "CONFLICT",
            "Only a running ExecutionRun can enter a terminal state.",
          );
        }
        if (providerModel !== undefined && providerModel.providerId !== thread.providerId) {
          throw new TaskStorageError(
            "CONFLICT",
            "The provider model reference does not match the owning ChatThread.",
          );
        }
        if (
          run.providerModel !== null &&
          providerModel !== undefined &&
          (run.providerModel.providerId !== providerModel.providerId ||
            run.providerModel.providerModelId !== providerModel.providerModelId)
        ) {
          throw new TaskStorageError(
            "CONFLICT",
            "The ExecutionRun provider model reference is immutable.",
          );
        }
        const finalProviderModel = providerModel ?? run.providerModel;
        const timestamp = this.#durableTimestampAtOrAfter(run.updatedAt);
        const update = this.#database
          .update(executionRunsTable)
          .set({
            status,
            providerModelId: finalProviderModel?.providerModelId ?? null,
            usagePresent: normalizedUsage === undefined ? 0 : 1,
            inputTokens: normalizedUsage?.inputTokens ?? null,
            cachedInputTokens: normalizedUsage?.cachedInputTokens ?? null,
            outputTokens: normalizedUsage?.outputTokens ?? null,
            reasoningTokens: normalizedUsage?.reasoningTokens ?? null,
            totalTokens: normalizedUsage?.totalTokens ?? null,
            runtimeSeconds: normalizedUsage?.runtimeSeconds ?? null,
            toolCallCount: normalizedUsage?.toolCallCount ?? null,
            updatedAt: timestamp,
            endedAt: timestamp,
          })
          .where(
            and(
              eq(executionRunsTable.id, run.id),
              eq(executionRunsTable.status, "RUNNING"),
              eq(executionRunsTable.updatedAt, run.updatedAt),
            ),
          )
          .run();
        if (update.changes !== 1) {
          throw new TaskStorageError(
            "CONFLICT",
            "The ExecutionRun terminal transition could not be persisted.",
          );
        }
        const stored = this.#getExecutionRun(run.id);
        if (stored?.status !== status) {
          throw new TaskStorageError(
            "STORAGE_OPERATION_FAILED",
            "The ExecutionRun terminal transition was not persisted.",
          );
        }
        return stored;
      }),
    );
  }

  finalizePrimaryExecutionAttempt(
    input: FinalizePrimaryExecutionAttemptInput,
  ): FinalizedPrimaryExecutionAttempt {
    const finalization = parseFinishExecutionRunInput(input);
    return this.#operation(() =>
      this.#atomic(() => {
        const executionRun = this.#getExecutionRun(
          finalization.executionRunId,
        );
        if (executionRun === null) {
          throw new TaskStorageError(
            "PARENT_NOT_FOUND",
            "The ExecutionRun does not exist.",
          );
        }
        const chatThread = this.#getChatThread(executionRun.chatThreadId);
        if (chatThread === null) {
          throw malformedStoredData();
        }
        const runCount = this.#sqlite
          .prepare(
            "SELECT count(*) AS count FROM execution_runs WHERE chat_thread_id = ?",
          )
          .get(chatThread.id) as { readonly count: number };
        if (chatThread.status !== "OPEN" || runCount.count !== 1) {
          throw new TaskStorageError(
            "CONFLICT",
            "The primary execution attempt is not an open one-attempt thread.",
          );
        }

        const finalizedRun =
          executionRun.status === "CREATED"
            ? (() => {
                if (
                  finalization.status !== "FAILED" ||
                  finalization.providerModel !== undefined ||
                  finalization.normalizedUsage !== undefined
                ) {
                  throw new TaskStorageError(
                    "CONFLICT",
                    "A created primary execution attempt can only fail before start.",
                  );
                }
                return this.failExecutionRunBeforeStart(executionRun.id);
              })()
            : this.finishExecutionRun(finalization);
        const finalizedThread = this.closeChatThread(chatThread.id);
        return Object.freeze({
          chatThread: finalizedThread,
          executionRun: finalizedRun,
        });
      }),
    );
  }

  completeSubtaskImplementation(
    input: CompleteSubtaskImplementationInput,
  ): CompleteSubtaskImplementationResult {
    const { subtaskId, checkpoint } =
      parseCompleteSubtaskImplementationInput(input);
    return this.#operation(() =>
      this.#atomicImplementationCompletion(() => {
        const targetRow = this.#database
          .select()
          .from(subtasksTable)
          .where(eq(subtasksTable.id, subtaskId))
          .get();
        if (targetRow === undefined) {
          throw new TaskStorageError(
            "PARENT_NOT_FOUND",
            "The Subtask does not exist.",
          );
        }
        const target = subtaskFromRow(targetRow);
        if (
          !isCanonicalUtcTimestamp(targetRow.createdAt) ||
          !isCanonicalUtcTimestamp(targetRow.updatedAt)
        ) {
          throw malformedStoredData();
        }
        this.#validateStoredSubtaskHierarchy(target);

        if (target.status !== "IN_PROGRESS") {
          throw new TaskStorageError(
            "CONFLICT",
            "The Subtask is not in the required implementation stage.",
          );
        }
        if (target.maturity !== "NOT_STARTED") {
          throw new TaskStorageError(
            "CONFLICT",
            "The Subtask is not at the required initial maturity.",
          );
        }

        const statusTransition = validateSubtaskTransition(
          "IN_PROGRESS",
          "QA_DEBUG",
          { implementationCheckpointPresent: true },
        );
        if (!statusTransition.allowed) {
          throw new TaskStorageError(
            "CONFLICT",
            "The Subtask implementation transition is not allowed.",
            statusTransition.errorCodes,
          );
        }
        const maturityTransition = validateSubtaskMaturityTransition(
          "NOT_STARTED",
          "IMPLEMENTED",
        );
        if (!maturityTransition.allowed) {
          throw new TaskStorageError(
            "CONFLICT",
            "The Subtask maturity transition is not allowed.",
            maturityTransition.errorCodes,
          );
        }
        if (checkpoint.subtaskId !== target.id) {
          throw new TaskStorageError(
            "CONFLICT",
            "The Implementation Checkpoint does not belong to the target Subtask.",
          );
        }
        this.#assertNoNoncanonicalCheckpointSubtaskAliases(target.id);
        const existingTargetCheckpoint = this.#database
          .select({ id: subtaskImplementationCheckpointsTable.id })
          .from(subtaskImplementationCheckpointsTable)
          .where(eq(subtaskImplementationCheckpointsTable.subtaskId, target.id))
          .get();
        if (existingTargetCheckpoint !== undefined) {
          throw malformedStoredData();
        }
        const existingCheckpointId = this.#database
          .select({ id: subtaskImplementationCheckpointsTable.id })
          .from(subtaskImplementationCheckpointsTable)
          .where(eq(subtaskImplementationCheckpointsTable.id, checkpoint.id))
          .get();
        if (existingCheckpointId !== undefined) {
          throw new TaskStorageError(
            "CONFLICT",
            "A Subtask Implementation Checkpoint with this ID already exists.",
          );
        }

        this.#database
          .insert(subtaskImplementationCheckpointsTable)
          .values({
            id: checkpoint.id,
            subtaskId: checkpoint.subtaskId,
            repositoryCommitSha: checkpoint.repositoryCommitSha,
            actorType: checkpoint.actorType,
            actorReference: checkpoint.actorReference ?? null,
            sourceReference: checkpoint.sourceReference,
            summary: checkpoint.summary,
            occurredAt: checkpoint.occurredAt,
            createdAt: this.#timestamp(),
          })
          .run();

        const update = this.#database
          .update(subtasksTable)
          .set({
            status: "QA_DEBUG",
            maturity: "IMPLEMENTED",
            updatedAt: this.#monotonicTimestampAfter(targetRow.updatedAt),
          })
          .where(
            and(
              eq(subtasksTable.id, target.id),
              eq(subtasksTable.status, "IN_PROGRESS"),
              eq(subtasksTable.maturity, "NOT_STARTED"),
              eq(subtasksTable.updatedAt, targetRow.updatedAt),
            ),
          )
          .run();
        if (update.changes !== 1) {
          throw new TaskStorageError(
            "CONFLICT",
            "The Subtask implementation completion could not be persisted.",
          );
        }

        const storedSubtask = this.#getSubtask(target.id);
        const storedCheckpoint = this.#getSubtaskImplementationCheckpoint(
          checkpoint.id,
        );
        if (
          storedSubtask === null ||
          storedSubtask.status !== "QA_DEBUG" ||
          storedSubtask.maturity !== "IMPLEMENTED" ||
          storedCheckpoint === null
        ) {
          throw new TaskStorageError(
            "STORAGE_OPERATION_FAILED",
            "The Subtask implementation completion was not persisted.",
          );
        }
        return { subtask: storedSubtask, checkpoint: storedCheckpoint };
      }),
    );
  }

  getSubtaskImplementationCheckpointById(
    input: SubtaskImplementationCheckpointId,
  ): SubtaskImplementationCheckpoint | null {
    const checkpointId = parseSubtaskImplementationCheckpointId(input);
    return this.#operation(() =>
      this.#readSnapshot(() =>
        this.#getSubtaskImplementationCheckpoint(checkpointId),
      ),
    );
  }

  listSubtaskImplementationCheckpoints(
    input: SubtaskId,
  ): readonly SubtaskImplementationCheckpoint[] {
    const subtaskId = parseCanonicalSubtaskId(input);
    return this.#operation(() =>
      this.#readSnapshot(() => {
        const subtask = this.#getSubtask(subtaskId);
        if (subtask === null) {
          throw new TaskStorageError(
            "PARENT_NOT_FOUND",
            "The Subtask does not exist.",
          );
        }
        this.#validateStoredSubtaskHierarchy(subtask);
        this.#assertNoNoncanonicalCheckpointSubtaskAliases(subtaskId);
        return this.#database
          .select()
          .from(subtaskImplementationCheckpointsTable)
          .where(eq(subtaskImplementationCheckpointsTable.subtaskId, subtaskId))
          .orderBy(
            asc(subtaskImplementationCheckpointsTable.occurredAt),
            asc(subtaskImplementationCheckpointsTable.id),
          )
          .all()
          .map((row) => this.#subtaskImplementationCheckpointFromRow(row));
      }),
    );
  }

  replaceDependenciesForBigTask(
    input: BigTaskId,
    dependencyInputs: readonly SubtaskDependency[],
  ): readonly SubtaskDependency[] {
    const bigTaskId = parseBigTaskId(input);
    const dependencies = dependencyInputs.map(parseDependencyInput);
    return this.#operation(() => {
      if (this.#getBigTask(bigTaskId) === null) {
        throw new TaskStorageError("PARENT_NOT_FOUND", "The Big Task does not exist.");
      }

      const allSubtasks = this.#allDependencySubtasks();
      const validation = validateSubtaskDependencies(allSubtasks, dependencies);
      if (!validation.valid) {
        throw new TaskStorageError(
          "DEPENDENCY_VALIDATION_FAILED",
          "The dependency set is invalid.",
          validation.errors.map(({ code }) => code),
        );
      }

      const subtasksById = new Map(allSubtasks.map((subtask) => [subtask.id, subtask]));
      const outsideRequestedBigTask = dependencies.some(
        (dependency) =>
          subtasksById.get(dependency.upstreamSubtaskId)?.bigTaskId !== bigTaskId ||
          subtasksById.get(dependency.downstreamSubtaskId)?.bigTaskId !== bigTaskId,
      );
      if (outsideRequestedBigTask) {
        throw new TaskStorageError(
          "DEPENDENCY_VALIDATION_FAILED",
          "The dependency set is invalid.",
          ["DEPENDENCY_BIG_TASK_MISMATCH"],
        );
      }

      return this.#atomic(() => {
        const targetSubtaskIds = allSubtasks
          .filter((subtask) => subtask.bigTaskId === bigTaskId)
          .map(({ id }) => id);
        if (targetSubtaskIds.length > 0) {
          this.#database
            .delete(taskDependenciesTable)
            .where(inArray(taskDependenciesTable.downstreamSubtaskId, targetSubtaskIds))
            .run();
        }

        if (dependencies.length > 0) {
          const timestamp = this.#timestamp();
          this.#database
            .insert(taskDependenciesTable)
            .values(
              dependencies.map((dependency) => ({
                upstreamSubtaskId: dependency.upstreamSubtaskId,
                downstreamSubtaskId: dependency.downstreamSubtaskId,
                dependencyType: dependency.dependencyType,
                requiredGate: dependency.requiredGate,
                reason: dependency.reason,
                createdAt: timestamp,
              })),
            )
            .run();
        }
        return this.#listDependencies(bigTaskId);
      });
    });
  }

  listDependenciesForBigTask(input: BigTaskId): readonly SubtaskDependency[] {
    const bigTaskId = parseBigTaskId(input);
    return this.#operation(() => this.#listDependencies(bigTaskId));
  }

  evaluateStoredSubtaskDependencyReadiness(
    input: SubtaskId,
  ): DependencyReadinessResult {
    const subtaskId = parseCanonicalSubtaskId(input);
    return this.#operation(() =>
      this.#readSnapshot(() => {
        const target = this.#getSubtask(subtaskId);
        if (target === null) {
          throw new TaskStorageError(
            "PARENT_NOT_FOUND",
            "The Subtask does not exist.",
          );
        }

        const bigTask = this.#getBigTask(target.bigTaskId);
        if (
          bigTask === null ||
          this.#getProject(bigTask.projectId) === null
        ) {
          throw malformedStoredData();
        }

        const targetSubtaskIds = this.#database
          .select({ id: subtasksTable.id })
          .from(subtasksTable)
          .where(eq(subtasksTable.bigTaskId, target.bigTaskId));
        const dependencyRows = this.#database
          .select({
            upstreamSubtaskId: taskDependenciesTable.upstreamSubtaskId,
            downstreamSubtaskId: taskDependenciesTable.downstreamSubtaskId,
            dependencyType: taskDependenciesTable.dependencyType,
            requiredGate: taskDependenciesTable.requiredGate,
            reason: taskDependenciesTable.reason,
          })
          .from(taskDependenciesTable)
          .where(
            or(
              inArray(
                taskDependenciesTable.upstreamSubtaskId,
                targetSubtaskIds,
              ),
              inArray(
                taskDependenciesTable.downstreamSubtaskId,
                targetSubtaskIds,
              ),
            ),
          )
          .orderBy(
            asc(taskDependenciesTable.upstreamSubtaskId),
            asc(taskDependenciesTable.downstreamSubtaskId),
            asc(taskDependenciesTable.dependencyType),
          )
          .all();
        const dependencies = dependencyRows.map(dependencyFromRow);
        const relevantDependencyPredicate = or(
          inArray(
            taskDependenciesTable.upstreamSubtaskId,
            targetSubtaskIds,
          ),
          inArray(
            taskDependenciesTable.downstreamSubtaskId,
            targetSubtaskIds,
          ),
        );
        const referencedUpstreamSubtaskIds = this.#database
          .select({ id: taskDependenciesTable.upstreamSubtaskId })
          .from(taskDependenciesTable)
          .where(relevantDependencyPredicate);
        const referencedDownstreamSubtaskIds = this.#database
          .select({ id: taskDependenciesTable.downstreamSubtaskId })
          .from(taskDependenciesTable)
          .where(relevantDependencyPredicate);
        const subtasks = this.#database
          .select()
          .from(subtasksTable)
          .where(
            or(
              eq(subtasksTable.bigTaskId, target.bigTaskId),
              inArray(subtasksTable.id, referencedUpstreamSubtaskIds),
              inArray(subtasksTable.id, referencedDownstreamSubtaskIds),
            ),
          )
          .orderBy(asc(subtasksTable.createdAt), asc(subtasksTable.id))
          .all()
          .map(subtaskFromRow);

        const result = evaluateSubtaskDependencyReadiness(
          subtasks.map(({ id, bigTaskId, maturity }) => ({
            id,
            bigTaskId,
            maturity,
          })),
          dependencies,
          subtaskId,
        );
        if (!result.valid) {
          throw malformedStoredData();
        }
        return result;
      }),
    );
  }

  createContextItem(input: ContextItem): ContextItem {
    const contextItem = parseContextItemInput(input);
    if (contextItem.provenance.supersedesContextItemId !== undefined) {
      throw invalidInput("Context Item");
    }

    return this.#operation(() => {
      this.#validateExactScopeHierarchy(deriveContextScope(contextItem), "Context Item");
      if (this.#getContextItem(contextItem.id) !== null) {
        throw new TaskStorageError("CONFLICT", "A Context Item with this ID already exists.");
      }

      const timestamp = this.#timestamp();
      this.#insertContextItem(contextItem, timestamp);
      const stored = this.#getContextItem(contextItem.id);
      if (stored === null) {
        throw new TaskStorageError(
          "STORAGE_OPERATION_FAILED",
          "The Context Item was not persisted.",
        );
      }
      return stored;
    });
  }

  getContextItemById(input: ContextItemId): ContextItem | null {
    const contextItemId = parseContextItemId(input);
    return this.#operation(() => this.#getContextItem(contextItemId));
  }

  listContextItemsByScope(input: ContextScope): readonly ContextItem[] {
    const scope = parseContextScope(input);
    return this.#operation(() => {
      this.#validateExactScopeHierarchy(scope, "Context Item");
      return this.#listContextItemsAtExactScope(scope);
    });
  }

  readAllowedRawContextItemsForSubtask(
    input: SubtaskId,
  ): AllowedRawContextItemSnapshot {
    const subtaskId = parseCanonicalSubtaskId(input);
    return this.#operation(() =>
      this.#readSnapshot(() =>
        this.#readAllowedRawContextItemsForSubtask(subtaskId),
      ),
    );
  }

  readActiveContextItemsForSubtask(input: SubtaskId): ActiveContextItemSnapshot {
    const subtaskId = parseCanonicalSubtaskId(input);
    return this.#operation(() =>
      this.#readSnapshot(() => {
        const rawSnapshot = this.#readAllowedRawContextItemsForSubtask(subtaskId);
        const [projectBucket, bigTaskBucket, subtaskBucket] = rawSnapshot.buckets;
        return {
          allowedContextSet: rawSnapshot.allowedContextSet,
          buckets: [
            {
              scope: projectBucket.scope,
              contextItems: projectBucket.contextItems.filter(
                ({ status }) => status === "ACTIVE",
              ),
            },
            {
              scope: bigTaskBucket.scope,
              contextItems: bigTaskBucket.contextItems.filter(
                ({ status }) => status === "ACTIVE",
              ),
            },
            {
              scope: subtaskBucket.scope,
              contextItems: subtaskBucket.contextItems.filter(
                ({ status }) => status === "ACTIVE",
              ),
            },
          ],
        };
      }),
    );
  }

  /**
   * Returns a direct, immutable storage-origin snapshot for future trusted JIT
   * assembly. Its data shape alone does not prove storage origin or authorize
   * packet injection, and the supplied profile is selected by the caller.
   */
  readJitContextSourceSnapshotForSubtask(
    input: SubtaskId,
    inputProfile: JitContextPacketProfileKind,
  ): JitContextStorageSourceSnapshot {
    let subtaskId: SubtaskId;
    let profile: JitContextPacketProfileKind;
    try {
      subtaskId = parseCanonicalSubtaskId(input);
      profile = parseJitContextPacketProfileKind(inputProfile);
    } catch (error) {
      if (error instanceof TaskStorageError) {
        throw error;
      }
      throw invalidInput("JIT Context storage source snapshot");
    }
    return this.#operation(() =>
      this.#readSnapshot(() => {
        const hierarchy = this.#readCanonicalTaskHierarchyForSubtask(subtaskId);
        if (profile !== "STANDARD_SUBTASK_EXECUTION") {
          return freezeJitContextStorageSourceSnapshot({
            profile,
            ...hierarchy,
          });
        }

        const rawSnapshot = this.#readAllowedRawContextItemsForSubtask(subtaskId);
        const [projectBucket, bigTaskBucket, subtaskBucket] = rawSnapshot.buckets;
        return freezeJitContextStorageSourceSnapshot({
          profile,
          ...hierarchy,
          allowedContextSet: rawSnapshot.allowedContextSet,
          activeContext: {
            project: projectBucket.contextItems.filter(
              ({ status }) => status === "ACTIVE",
            ),
            bigTask: bigTaskBucket.contextItems.filter(
              ({ status }) => status === "ACTIVE",
            ),
            subtask: subtaskBucket.contextItems.filter(
              ({ status }) => status === "ACTIVE",
            ),
          },
        });
      }),
    );
  }

  supersedeContextItem(input: ContextItem): ContextItem {
    const replacement = parseContextItemInput(input);
    const priorContextItemId = replacement.provenance.supersedesContextItemId;
    if (
      replacement.status !== "ACTIVE" ||
      priorContextItemId === undefined ||
      priorContextItemId === replacement.id
    ) {
      throw invalidInput("Context Item supersession");
    }

    return this.#operation(() =>
      this.#atomic(() => {
        const prior = this.#getContextItem(priorContextItemId);
        if (prior === null) {
          throw new TaskStorageError(
            "PARENT_NOT_FOUND",
            "The superseded Context Item does not exist.",
          );
        }
        if (prior.status !== "ACTIVE") {
          throw new TaskStorageError(
            "CONFLICT",
            "Only an active Context Item can be superseded.",
          );
        }

        const priorScope = deriveContextScope(prior);
        const replacementScope = deriveContextScope(replacement);
        if (!contextScopesEqual(priorScope, replacementScope)) {
          throw invalidInput("Context Item supersession scope");
        }
        this.#validateExactScopeHierarchy(replacementScope, "Context Item");

        if (this.#getContextItem(replacement.id) !== null) {
          throw new TaskStorageError("CONFLICT", "A Context Item with this ID already exists.");
        }
        const existingReplacement = this.#database
          .select({ id: contextItemsTable.id })
          .from(contextItemsTable)
          .where(eq(contextItemsTable.supersedesContextItemId, prior.id))
          .get();
        if (existingReplacement !== undefined) {
          throw new TaskStorageError(
            "CONFLICT",
            "The Context Item has already been superseded.",
          );
        }

        const timestamp = this.#timestamp();
        this.#insertContextItem(replacement, timestamp);
        const update = this.#database
          .update(contextItemsTable)
          .set({ status: "SUPERSEDED", updatedAt: timestamp })
          .where(
            and(
              eq(contextItemsTable.id, prior.id),
              eq(contextItemsTable.status, "ACTIVE"),
            ),
          )
          .run();
        if (update.changes !== 1) {
          throw new TaskStorageError(
            "CONFLICT",
            "The Context Item could not be superseded.",
          );
        }

        const stored = this.#getContextItem(replacement.id);
        if (stored === null) {
          throw new TaskStorageError(
            "STORAGE_OPERATION_FAILED",
            "The replacement Context Item was not persisted.",
          );
        }
        return stored;
      }),
    );
  }

  createContextDigest(input: ContextDigest): ContextDigest {
    const contextDigest = parseContextDigestInput(input);
    return this.#operation(() => {
      this.#validateExactScopeHierarchy(contextDigest.scope, "Context Digest");
      if (this.#getContextDigest(contextDigest.id) !== null) {
        throw new TaskStorageError(
          "CONFLICT",
          "A Context Digest with this ID already exists.",
        );
      }
      if (this.#getContextDigestByScope(contextDigest.scope) !== null) {
        throw new TaskStorageError(
          "CONFLICT",
          "A Context Digest already exists at this exact scope.",
        );
      }

      const timestamp = this.#timestamp();
      this.#database
        .insert(contextDigestsTable)
        .values({
          id: contextDigest.id,
          projectId: contextDigest.scope.projectId,
          bigTaskId:
            contextDigest.scope.scopeType === "PROJECT"
              ? null
              : contextDigest.scope.bigTaskId,
          subtaskId:
            contextDigest.scope.scopeType === "SUBTASK"
              ? contextDigest.scope.subtaskId
              : null,
          body: contextDigest.body,
          sourceType: contextDigest.provenance.sourceType,
          sourceReference: contextDigest.provenance.sourceReference,
          effectiveAt: contextDigest.provenance.effectiveAt,
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        .run();
      const stored = this.#getContextDigest(contextDigest.id);
      if (stored === null) {
        throw new TaskStorageError(
          "STORAGE_OPERATION_FAILED",
          "The Context Digest was not persisted.",
        );
      }
      return stored;
    });
  }

  getContextDigestById(input: ContextDigestId): ContextDigest | null {
    const contextDigestId = parseContextDigestId(input);
    return this.#operation(() => this.#getContextDigest(contextDigestId));
  }

  getContextDigestByScope(input: ContextScope): ContextDigest | null {
    const scope = parseContextScope(input);
    return this.#operation(() => {
      this.#validateExactScopeHierarchy(scope, "Context Digest");
      return this.#getContextDigestByScope(scope);
    });
  }

  replaceContextDigest(input: ContextDigest): ContextDigest {
    const replacement = parseContextDigestInput(input);
    return this.#operation(() =>
      this.#atomic(() => {
        const existing = this.#getContextDigest(replacement.id);
        if (existing === null) {
          throw new TaskStorageError(
            "PARENT_NOT_FOUND",
            "The Context Digest does not exist.",
          );
        }
        if (!contextScopesEqual(existing.scope, replacement.scope)) {
          throw invalidInput("Context Digest replacement scope");
        }
        this.#validateExactScopeHierarchy(replacement.scope, "Context Digest");
        const currentAtScope = this.#getContextDigestByScope(replacement.scope);
        if (currentAtScope === null || currentAtScope.id !== existing.id) {
          throw malformedStoredData();
        }
        const currentTimestampRow = this.#database
          .select({ updatedAt: contextDigestsTable.updatedAt })
          .from(contextDigestsTable)
          .where(eq(contextDigestsTable.id, replacement.id))
          .get();
        if (
          currentTimestampRow === undefined ||
          !isCanonicalUtcTimestamp(currentTimestampRow.updatedAt)
        ) {
          throw malformedStoredData();
        }

        const update = this.#database
          .update(contextDigestsTable)
          .set({
            body: replacement.body,
            sourceType: replacement.provenance.sourceType,
            sourceReference: replacement.provenance.sourceReference,
            effectiveAt: replacement.provenance.effectiveAt,
            updatedAt: this.#monotonicTimestampAfter(
              currentTimestampRow.updatedAt,
            ),
          })
          .where(eq(contextDigestsTable.id, replacement.id))
          .run();
        if (update.changes !== 1) {
          throw new TaskStorageError(
            "CONFLICT",
            "The Context Digest could not be replaced.",
          );
        }

        const stored = this.#getContextDigest(replacement.id);
        if (stored === null) {
          throw new TaskStorageError(
            "STORAGE_OPERATION_FAILED",
            "The replacement Context Digest was not persisted.",
          );
        }
        return stored;
      }),
    );
  }

  appendAuditEvent(input: AuditEvent): AuditEvent {
    const auditEvent = parseAuditEventInput(input);
    return this.#operation(() => {
      this.#validateExactScopeHierarchy(auditEvent.scope, "Audit Event");
      if (this.#getAuditEvent(auditEvent.id) !== null) {
        throw new TaskStorageError(
          "CONFLICT",
          "An Audit Event with this ID already exists.",
        );
      }

      this.#database
        .insert(auditEventsTable)
        .values({
          id: auditEvent.id,
          projectId: auditEvent.scope.projectId,
          bigTaskId:
            auditEvent.scope.scopeType === "PROJECT"
              ? null
              : auditEvent.scope.bigTaskId,
          subtaskId:
            auditEvent.scope.scopeType === "SUBTASK"
              ? auditEvent.scope.subtaskId
              : null,
          eventType: auditEvent.eventType,
          actorType: auditEvent.actorType,
          actorReference: auditEvent.actorReference ?? null,
          summary: auditEvent.summary,
          subjectReference: auditEvent.subjectReference ?? null,
          occurredAt: auditEvent.occurredAt,
          createdAt: this.#timestamp(),
        })
        .run();
      const stored = this.#getAuditEvent(auditEvent.id);
      if (stored === null) {
        throw new TaskStorageError(
          "STORAGE_OPERATION_FAILED",
          "The Audit Event was not persisted.",
        );
      }
      return stored;
    });
  }

  getAuditEventById(input: AuditEventId): AuditEvent | null {
    const auditEventId = parseAuditEventId(input);
    return this.#operation(() => this.#getAuditEvent(auditEventId));
  }

  listAuditEventsByScope(input: ContextScope): readonly AuditEvent[] {
    const scope = parseContextScope(input);
    return this.#operation(() => {
      this.#validateExactScopeHierarchy(scope, "Audit Event");
      return this.#database
        .select()
        .from(auditEventsTable)
        .where(auditEventScopePredicate(scope))
        .orderBy(asc(auditEventsTable.occurredAt), asc(auditEventsTable.id))
        .all()
        .map((row) => this.#auditEventFromRow(row));
    });
  }

  runInTransaction<T>(operation: (storage: TaskStorage) => T): T {
    this.#ensureOpen();
    if (this.#sqlite.isTransaction) {
      throw new TaskStorageError("TRANSACTION_FAILED", "Nested transactions are not supported.");
    }
    return this.#atomic(() => operation(this));
  }

  #getProject(projectId: ProjectId): Project | null {
    const row = this.#database
      .select()
      .from(projectsTable)
      .where(eq(projectsTable.id, projectId))
      .get();
    return row === undefined ? null : projectFromRow(row);
  }

  #readCanonicalTaskHierarchyForSubtask(
    subtaskId: SubtaskId,
  ): CanonicalTaskHierarchy {
    const subtask = this.#getSubtask(subtaskId);
    if (subtask === null) {
      throw new TaskStorageError(
        "PARENT_NOT_FOUND",
        "The Subtask does not exist.",
      );
    }
    this.#validateStoredSubtaskHierarchy(subtask);

    const bigTask = this.#getBigTask(subtask.bigTaskId);
    const project = bigTask === null ? null : this.#getProject(bigTask.projectId);
    if (bigTask === null || project === null) {
      throw malformedStoredData();
    }
    return { project, bigTask, subtask };
  }

  #readAllowedRawContextItemsForSubtask(
    subtaskId: SubtaskId,
  ): AllowedRawContextItemSnapshot {
    const subtask = this.#getSubtask(subtaskId);
    if (subtask === null) {
      throw new TaskStorageError(
        "PARENT_NOT_FOUND",
        "The Subtask does not exist.",
      );
    }
    this.#validateStoredSubtaskHierarchy(subtask);

    const bigTask = this.#getBigTask(subtask.bigTaskId);
    const project = bigTask === null ? null : this.#getProject(bigTask.projectId);
    if (bigTask === null || project === null) {
      throw malformedStoredData();
    }

    const allowedContextSetResult = buildAllowedContextSet(
      project,
      bigTask,
      subtask,
    );
    if (!allowedContextSetResult.valid) {
      throw malformedStoredData();
    }

    // The accepted ACL is complete before any Context Item query is issued.
    const { allowedContextSet } = allowedContextSetResult;
    const [projectScope, bigTaskScope, subtaskScope] =
      allowedContextSet.allowedRawScopes;
    return {
      allowedContextSet,
      buckets: [
        {
          scope: projectScope,
          contextItems: this.#listContextItemsAtExactScope(projectScope),
        },
        {
          scope: bigTaskScope,
          contextItems: this.#listContextItemsAtExactScope(bigTaskScope),
        },
        {
          scope: subtaskScope,
          contextItems: this.#listContextItemsAtExactScope(subtaskScope),
        },
      ],
    };
  }

  #getBigTask(bigTaskId: BigTaskId): BigTask | null {
    const row = this.#database
      .select()
      .from(bigTasksTable)
      .where(eq(bigTasksTable.id, bigTaskId))
      .get();
    return row === undefined ? null : bigTaskFromRow(row);
  }

  #getSubtask(subtaskId: SubtaskId): Subtask | null {
    const row = this.#database
      .select()
      .from(subtasksTable)
      .where(eq(subtasksTable.id, subtaskId))
      .get();
    return row === undefined ? null : subtaskFromRow(row);
  }

  #chatThreadFromRow(row: ChatThreadRow): ChatThread {
    const thread = chatThreadFromRow(row);
    if (this.#getSubtask(thread.subtaskId) === null) {
      throw malformedStoredData();
    }
    return thread;
  }

  #getChatThread(chatThreadId: ChatThreadId): ChatThread | null {
    const row = this.#database
      .select()
      .from(chatThreadsTable)
      .where(eq(chatThreadsTable.id, chatThreadId))
      .get();
    return row === undefined ? null : this.#chatThreadFromRow(row);
  }

  #executionRunFromRow(row: ExecutionRunRow): ExecutionRun {
    const threadId = ChatThreadIdSchema.safeParse(row.chatThreadId);
    if (!threadId.success || threadId.data !== row.chatThreadId) {
      throw malformedStoredData();
    }
    const owningThread = this.#getChatThread(threadId.data);
    if (owningThread === null) {
      throw malformedStoredData();
    }
    return executionRunFromRow(row, owningThread);
  }

  #getExecutionRun(executionRunId: ExecutionRunId): ExecutionRun | null {
    this.#assertExecutionRunUsageIntegersAreDecodable("id", executionRunId);
    const row = this.#database
      .select()
      .from(executionRunsTable)
      .where(eq(executionRunsTable.id, executionRunId))
      .get();
    return row === undefined ? null : this.#executionRunFromRow(row);
  }

  #assertExecutionRunUsageIntegersAreDecodable(
    scopeColumn: "id" | "chat_thread_id",
    scopeValue: string,
  ): void {
    const unsafeRow = this.#sqlite
      .prepare(
        `select 1 as unsafe_usage_integer
         from execution_runs
         where "${scopeColumn}" = ?
           and (${EXECUTION_RUN_UNSAFE_USAGE_INTEGER_PREDICATE})
         limit 1`,
      )
      .get(scopeValue);
    if (unsafeRow !== undefined) {
      throw malformedStoredData();
    }
  }

  #getSubtaskImplementationCheckpoint(
    checkpointId: SubtaskImplementationCheckpointId,
  ): SubtaskImplementationCheckpoint | null {
    const row = this.#database
      .select()
      .from(subtaskImplementationCheckpointsTable)
      .where(eq(subtaskImplementationCheckpointsTable.id, checkpointId))
      .get();
    return row === undefined
      ? null
      : this.#subtaskImplementationCheckpointFromRow(row);
  }

  #assertNoNoncanonicalCheckpointSubtaskAliases(subtaskId: SubtaskId): void {
    const storedSubtaskIds = this.#database
      .select({ subtaskId: subtaskImplementationCheckpointsTable.subtaskId })
      .from(subtaskImplementationCheckpointsTable)
      .all();
    for (const { subtaskId: storedSubtaskId } of storedSubtaskIds) {
      const result = SubtaskIdSchema.safeParse(storedSubtaskId);
      if (
        result.success &&
        result.data === subtaskId &&
        storedSubtaskId !== subtaskId
      ) {
        throw malformedStoredData();
      }
    }
  }

  #subtaskImplementationCheckpointFromRow(
    row: SubtaskImplementationCheckpointRow,
  ): SubtaskImplementationCheckpoint {
    const checkpoint = subtaskImplementationCheckpointFromRow(row);
    const subtask = this.#getSubtask(checkpoint.subtaskId);
    if (subtask === null || subtask.maturity === "NOT_STARTED") {
      throw malformedStoredData();
    }
    this.#validateStoredSubtaskHierarchy(subtask);
    return checkpoint;
  }

  #validateStoredSubtaskHierarchy(subtask: Subtask): void {
    const subtaskRow = this.#database
      .select()
      .from(subtasksTable)
      .where(eq(subtasksTable.id, subtask.id))
      .get();
    if (
      subtaskRow === undefined ||
      subtaskRow.bigTaskId !== subtask.bigTaskId ||
      !isCanonicalUtcTimestamp(subtaskRow.createdAt) ||
      !isCanonicalUtcTimestamp(subtaskRow.updatedAt)
    ) {
      throw malformedStoredData();
    }

    const bigTaskRow = this.#database
      .select()
      .from(bigTasksTable)
      .where(eq(bigTasksTable.id, subtask.bigTaskId))
      .get();
    if (
      bigTaskRow === undefined ||
      !isCanonicalUtcTimestamp(bigTaskRow.createdAt) ||
      !isCanonicalUtcTimestamp(bigTaskRow.updatedAt)
    ) {
      throw malformedStoredData();
    }
    const bigTask = bigTaskFromRow(bigTaskRow);

    const projectRow = this.#database
      .select()
      .from(projectsTable)
      .where(eq(projectsTable.id, bigTask.projectId))
      .get();
    if (
      projectRow === undefined ||
      !isCanonicalUtcTimestamp(projectRow.createdAt) ||
      !isCanonicalUtcTimestamp(projectRow.updatedAt)
    ) {
      throw malformedStoredData();
    }
    projectFromRow(projectRow);
  }

  #getContextItem(contextItemId: ContextItemId): ContextItem | null {
    const row = this.#database
      .select()
      .from(contextItemsTable)
      .where(eq(contextItemsTable.id, contextItemId))
      .get();
    return row === undefined ? null : this.#contextItemFromRow(row);
  }

  #listContextItemsAtExactScope(scope: ContextScope): readonly ContextItem[] {
    const noncanonicalAlias = this.#database
      .select({ id: contextItemsTable.id })
      .from(contextItemsTable)
      .where(noncanonicalContextScopeAliasPredicate(scope))
      .limit(1)
      .get();
    if (noncanonicalAlias !== undefined) {
      throw malformedStoredData();
    }

    return this.#database
      .select()
      .from(contextItemsTable)
      .where(contextScopePredicate(scope))
      .orderBy(asc(contextItemsTable.effectiveAt), asc(contextItemsTable.id))
      .all()
      .map((row) => this.#contextItemFromRow(row));
  }

  #getContextDigest(contextDigestId: ContextDigestId): ContextDigest | null {
    const row = this.#database
      .select()
      .from(contextDigestsTable)
      .where(eq(contextDigestsTable.id, contextDigestId))
      .get();
    if (row === undefined) {
      return null;
    }

    const contextDigest = this.#contextDigestFromRow(row);
    const scopeRows = this.#database
      .select({ id: contextDigestsTable.id })
      .from(contextDigestsTable)
      .where(contextDigestScopePredicate(contextDigest.scope))
      .all();
    if (scopeRows.length !== 1 || scopeRows[0]?.id !== row.id) {
      throw malformedStoredData();
    }
    return contextDigest;
  }

  #getContextDigestByScope(scope: ContextScope): ContextDigest | null {
    const rows = this.#database
      .select()
      .from(contextDigestsTable)
      .where(contextDigestScopePredicate(scope))
      .all();
    if (rows.length > 1) {
      throw malformedStoredData();
    }
    return rows[0] === undefined ? null : this.#contextDigestFromRow(rows[0]);
  }

  #getAuditEvent(auditEventId: AuditEventId): AuditEvent | null {
    const row = this.#database
      .select()
      .from(auditEventsTable)
      .where(eq(auditEventsTable.id, auditEventId))
      .get();
    return row === undefined ? null : this.#auditEventFromRow(row);
  }

  #validateExactScopeHierarchy(
    scope: ContextScope,
    entity: "Context Item" | "Context Digest" | "Audit Event",
  ): void {
    const invalidRelationship = this.#invalidExactScopeHierarchyRelationship(scope);
    if (invalidRelationship === "PROJECT") {
      throw new TaskStorageError(
        "PARENT_NOT_FOUND",
        `The ${entity} Project does not exist.`,
      );
    }
    if (invalidRelationship === "BIG_TASK") {
      throw new TaskStorageError(
        "PARENT_NOT_FOUND",
        `The ${entity} Big Task hierarchy does not exist.`,
      );
    }
    if (invalidRelationship === "SUBTASK") {
      throw new TaskStorageError(
        "PARENT_NOT_FOUND",
        `The ${entity} Subtask hierarchy does not exist.`,
      );
    }
  }

  #contextDigestFromRow(row: ContextDigestRow): ContextDigest {
    const contextDigest = contextDigestFromRow(row);
    if (
      this.#invalidExactScopeHierarchyRelationship(contextDigest.scope) !== null
    ) {
      throw malformedStoredData();
    }
    return contextDigest;
  }

  #auditEventFromRow(row: AuditEventRow): AuditEvent {
    const auditEvent = auditEventFromRow(row);
    if (this.#invalidExactScopeHierarchyRelationship(auditEvent.scope) !== null) {
      throw malformedStoredData();
    }
    return auditEvent;
  }

  #contextItemFromRow(row: ContextItemRow): ContextItem {
    const contextItem = this.#contextItemWithoutSupersessionValidation(row);
    this.#validateContextSupersessionIntegrity(contextItem);
    return contextItem;
  }

  #contextItemWithoutSupersessionValidation(row: ContextItemRow): ContextItem {
    const contextItem = contextItemFromRow(row);
    if (
      this.#invalidExactScopeHierarchyRelationship(deriveContextScope(contextItem)) !== null
    ) {
      throw malformedStoredData();
    }
    return contextItem;
  }

  #validateContextSupersessionIntegrity(startingContextItem: ContextItem): void {
    const predecessorIds = new Set<string>([startingContextItem.id]);
    let isLinked =
      startingContextItem.provenance.supersedesContextItemId !== undefined;
    let current = startingContextItem;

    while (current.provenance.supersedesContextItemId !== undefined) {
      const priorRow = this.#database
        .select()
        .from(contextItemsTable)
        .where(eq(contextItemsTable.id, current.provenance.supersedesContextItemId))
        .get();
      if (priorRow === undefined) {
        throw malformedStoredData();
      }

      const prior = this.#contextItemWithoutSupersessionValidation(priorRow);
      if (predecessorIds.has(prior.id)) {
        throw malformedStoredData();
      }
      this.#validateContextPredecessorSuccessorIdentity(current, prior);
      this.#validateContextSupersessionEdge(current, prior);
      predecessorIds.add(prior.id);
      current = prior;
    }

    const successorIds = new Set<string>([startingContextItem.id]);
    current = startingContextItem;

    while (true) {
      const successorRows = this.#listCanonicalContextSuccessorRows(current.id);
      if (successorRows.length === 0) {
        if (isLinked && current.status !== "ACTIVE") {
          throw malformedStoredData();
        }
        return;
      }
      if (successorRows.length !== 1) {
        throw malformedStoredData();
      }

      isLinked = true;
      const successor = this.#contextItemWithoutSupersessionValidation(
        successorRows[0]!,
      );
      if (successorIds.has(successor.id)) {
        throw malformedStoredData();
      }
      this.#validateContextSupersessionEdge(successor, current);
      successorIds.add(successor.id);
      current = successor;
    }
  }

  #validateContextSupersessionEdge(
    successor: ContextItem,
    prior: ContextItem,
  ): void {
    if (
      prior.status !== "SUPERSEDED" ||
      (successor.status !== "ACTIVE" && successor.status !== "SUPERSEDED") ||
      !contextScopesEqual(
        deriveContextScope(successor),
        deriveContextScope(prior),
      )
    ) {
      throw malformedStoredData();
    }
  }

  #validateContextPredecessorSuccessorIdentity(
    current: ContextItem,
    prior: ContextItem,
  ): void {
    const directSuccessors = this.#listCanonicalContextSuccessorRows(prior.id);
    if (
      directSuccessors.length !== 1 ||
      directSuccessors[0]?.id !== current.id
    ) {
      throw malformedStoredData();
    }
  }

  #listCanonicalContextSuccessorRows(
    contextItemId: ContextItemId,
  ): readonly ContextItemRow[] {
    return this.#database
      .select()
      .from(contextItemsTable)
      .where(
        canonicalStoredIdentifierPredicate(
          contextItemsTable.supersedesContextItemId,
          contextItemId,
        ),
      )
      .all();
  }

  #invalidExactScopeHierarchyRelationship(
    scope: ContextScope,
  ): "PROJECT" | "BIG_TASK" | "SUBTASK" | null {
    if (this.#getProject(scope.projectId) === null) {
      return "PROJECT";
    }
    if (scope.scopeType === "PROJECT") {
      return null;
    }

    const bigTask = this.#getBigTask(scope.bigTaskId);
    if (bigTask === null || bigTask.projectId !== scope.projectId) {
      return "BIG_TASK";
    }
    if (scope.scopeType === "BIG_TASK") {
      return null;
    }

    const subtask = this.#getSubtask(scope.subtaskId);
    return subtask === null || subtask.bigTaskId !== scope.bigTaskId
      ? "SUBTASK"
      : null;
  }

  #insertContextItem(contextItem: ContextItem, timestamp: string): void {
    this.#database
      .insert(contextItemsTable)
      .values({
        id: contextItem.id,
        projectId: contextItem.projectId,
        bigTaskId: "bigTaskId" in contextItem ? contextItem.bigTaskId : null,
        subtaskId: "subtaskId" in contextItem ? contextItem.subtaskId : null,
        kind: contextItem.kind,
        status: contextItem.status,
        authority: contextItem.authority,
        title: contextItem.title,
        body: contextItem.body,
        sourceType: contextItem.provenance.sourceType,
        sourceReference: contextItem.provenance.sourceReference,
        effectiveAt: contextItem.provenance.effectiveAt,
        supersedesContextItemId:
          contextItem.provenance.supersedesContextItemId ?? null,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .run();
  }

  #allDependencySubtasks(): readonly DependencySubtask[] {
    const bigTaskIds = new Set(
      this.#database
        .select({ id: bigTasksTable.id })
        .from(bigTasksTable)
        .all()
        .map(({ id }) => id),
    );
    return this.#database
      .select({ id: subtasksTable.id, bigTaskId: subtasksTable.bigTaskId })
      .from(subtasksTable)
      .all()
      .map((row) => {
        const id = SubtaskIdSchema.safeParse(row.id);
        const bigTaskId = BigTaskIdSchema.safeParse(row.bigTaskId);
        if (
          !id.success ||
          !bigTaskId.success ||
          id.data !== row.id ||
          bigTaskId.data !== row.bigTaskId ||
          !bigTaskIds.has(row.bigTaskId)
        ) {
          throw malformedStoredData();
        }
        return { id: id.data, bigTaskId: bigTaskId.data };
      });
  }

  #listDependencies(bigTaskId: BigTaskId): readonly SubtaskDependency[] {
    const bigTaskIds = new Set(
      this.#database
        .select({ id: bigTasksTable.id })
        .from(bigTasksTable)
        .all()
        .map(({ id }) => id),
    );
    const rawSubtasks = this.#database
      .select({ id: subtasksTable.id, bigTaskId: subtasksTable.bigTaskId })
      .from(subtasksTable)
      .all();
    const parseDependencySubtask = (row: {
      readonly id: string;
      readonly bigTaskId: string;
    }): DependencySubtask => {
      const id = SubtaskIdSchema.safeParse(row.id);
      const parsedBigTaskId = BigTaskIdSchema.safeParse(row.bigTaskId);
      if (
        !id.success ||
        !parsedBigTaskId.success ||
        id.data !== row.id ||
        parsedBigTaskId.data !== row.bigTaskId ||
        !bigTaskIds.has(row.bigTaskId)
      ) {
        throw malformedStoredData();
      }
      return { id: id.data, bigTaskId: parsedBigTaskId.data };
    };
    const targetSubtasks = rawSubtasks
      .filter((subtask) => subtask.bigTaskId === bigTaskId)
      .map(parseDependencySubtask);
    const targetSubtaskIds = new Set(targetSubtasks.map(({ id }) => id));
    const rawDependencies = this.#database
      .select({
        upstreamSubtaskId: taskDependenciesTable.upstreamSubtaskId,
        downstreamSubtaskId: taskDependenciesTable.downstreamSubtaskId,
        dependencyType: taskDependenciesTable.dependencyType,
        requiredGate: taskDependenciesTable.requiredGate,
        reason: taskDependenciesTable.reason,
      })
      .from(taskDependenciesTable)
      .orderBy(
        asc(taskDependenciesTable.upstreamSubtaskId),
        asc(taskDependenciesTable.downstreamSubtaskId),
        asc(taskDependenciesTable.dependencyType),
      )
      .all();
    const relevantRows = rawDependencies.filter(
      (dependency) =>
        targetSubtaskIds.has(dependency.upstreamSubtaskId as SubtaskId) ||
        targetSubtaskIds.has(dependency.downstreamSubtaskId as SubtaskId),
    );
    const referencedSubtaskIds = new Set(
      relevantRows.flatMap((dependency) => [
        dependency.upstreamSubtaskId,
        dependency.downstreamSubtaskId,
      ]),
    );
    const subtasksById = new Map<SubtaskId, DependencySubtask>(
      targetSubtasks.map((subtask) => [subtask.id, subtask]),
    );
    for (const row of rawSubtasks) {
      if (referencedSubtaskIds.has(row.id)) {
        const subtask = parseDependencySubtask(row);
        subtasksById.set(subtask.id, subtask);
      }
    }
    const subtasks = [...subtasksById.values()];
    const dependencies = relevantRows.map(dependencyFromRow);
    const validation = validateSubtaskDependencies(subtasks, dependencies);
    if (!validation.valid) {
      throw malformedStoredData();
    }
    return dependencies.filter(
      (dependency) =>
        subtasksById.get(dependency.upstreamSubtaskId)?.bigTaskId === bigTaskId &&
        subtasksById.get(dependency.downstreamSubtaskId)?.bigTaskId === bigTaskId,
    );
  }

  #timestamp(): string {
    const timestamp = this.#clock();
    if (!(timestamp instanceof Date) || Number.isNaN(timestamp.getTime())) {
      throw new TaskStorageError("STORAGE_OPERATION_FAILED", "The storage clock is invalid.");
    }
    return timestamp.toISOString();
  }

  #monotonicTimestampAfter(previousUpdatedAt: string): string {
    const currentTimestamp = this.#timestamp();
    const previousTime = new Date(previousUpdatedAt).getTime();
    const currentTime = new Date(currentTimestamp).getTime();
    return currentTime > previousTime
      ? currentTimestamp
      : new Date(previousTime + 1).toISOString();
  }

  #durableTimestampAtOrAfter(previousUpdatedAt: string): string {
    const currentTimestamp = this.#timestamp();
    if (new Date(currentTimestamp).getTime() < new Date(previousUpdatedAt).getTime()) {
      throw new TaskStorageError(
        "STORAGE_OPERATION_FAILED",
        "The storage clock cannot precede durable execution state.",
      );
    }
    return currentTimestamp;
  }

  #ensureOpen(): void {
    if (!this.isOpen) {
      throw new TaskStorageError("DATABASE_CLOSED", "The task database is closed.");
    }
  }

  #operation<T>(operation: () => T): T {
    this.#ensureOpen();
    try {
      return operation();
    } catch (error) {
      if (error instanceof TaskStorageError) {
        throw error;
      }
      throw new TaskStorageError(
        "STORAGE_OPERATION_FAILED",
        "The task storage operation failed.",
      );
    }
  }

  #atomic<T>(operation: () => T): T {
    const ownsTransaction = !this.#sqlite.isTransaction;
    if (ownsTransaction) {
      try {
        this.#sqlite.exec("BEGIN IMMEDIATE");
      } catch {
        throw new TaskStorageError("TRANSACTION_FAILED", "The transaction could not start.");
      }
    }

    try {
      const result = operation();
      if (
        typeof result === "object" &&
        result !== null &&
        "then" in result &&
        typeof result.then === "function"
      ) {
        throw new TaskStorageError(
          "TRANSACTION_FAILED",
          "Asynchronous transaction callbacks are not supported.",
        );
      }
      if (ownsTransaction) {
        this.#sqlite.exec("COMMIT");
      }
      return result;
    } catch (error) {
      if (ownsTransaction && this.#sqlite.isTransaction) {
        try {
          this.#sqlite.exec("ROLLBACK");
        } catch {
          throw new TaskStorageError("TRANSACTION_FAILED", "The transaction rollback failed.");
        }
      }
      if (error instanceof TaskStorageError) {
        throw error;
      }
      throw new TaskStorageError("TRANSACTION_FAILED", "The transaction failed and was rolled back.");
    }
  }

  #atomicImplementationCompletion<T>(operation: () => T): T {
    if (!this.#sqlite.isTransaction) {
      return this.#atomic(operation);
    }

    const savepoint = "subtask_implementation_completion";
    try {
      this.#sqlite.exec(`SAVEPOINT ${savepoint}`);
    } catch {
      throw new TaskStorageError(
        "TRANSACTION_FAILED",
        "The implementation completion transaction could not start.",
      );
    }

    try {
      const result = operation();
      this.#sqlite.exec(`RELEASE ${savepoint}`);
      return result;
    } catch (error) {
      try {
        this.#sqlite.exec(`ROLLBACK TO ${savepoint}`);
        this.#sqlite.exec(`RELEASE ${savepoint}`);
      } catch {
        throw new TaskStorageError(
          "TRANSACTION_FAILED",
          "The implementation completion transaction rollback failed.",
        );
      }
      if (error instanceof TaskStorageError) {
        throw error;
      }
      throw new TaskStorageError(
        "TRANSACTION_FAILED",
        "The implementation completion transaction failed and was rolled back.",
      );
    }
  }

  #readSnapshot<T>(operation: () => T): T {
    const ownsTransaction = !this.#sqlite.isTransaction;
    if (ownsTransaction) {
      try {
        this.#sqlite.exec("BEGIN");
      } catch {
        throw new TaskStorageError(
          "TRANSACTION_FAILED",
          "The read transaction could not start.",
        );
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
          throw new TaskStorageError(
            "TRANSACTION_FAILED",
            "The read transaction rollback failed.",
          );
        }
      }
      if (error instanceof TaskStorageError) {
        throw error;
      }
      throw new TaskStorageError(
        "TRANSACTION_FAILED",
        "The read transaction failed and was rolled back.",
      );
    }
  }
}

export const openTaskDatabase = (options: OpenTaskDatabaseOptions): TaskStorage => {
  if (typeof options.databasePath !== "string" || options.databasePath.trim().length === 0) {
    throw new TaskStorageError("DATABASE_OPEN_FAILED", "The task database path is invalid.");
  }

  let sqlite: DatabaseSync | undefined;
  try {
    sqlite = new DatabaseSync(options.databasePath, { timeout: 5_000 });
    sqlite.exec("PRAGMA foreign_keys = ON");
  } catch {
    try {
      sqlite?.close();
    } catch {
      // The sanitized open error remains the public failure contract.
    }
    throw new TaskStorageError("DATABASE_OPEN_FAILED", "The task database could not be opened.");
  }

  const database = drizzle({ client: sqlite });
  try {
    runMigrations(database, options.migrationsFolder ?? defaultMigrationsFolder);
  } catch {
    try {
      sqlite.close();
    } catch {
      // The migration error remains the public failure contract.
    }
    throw new TaskStorageError("MIGRATION_FAILED", "Task database migration failed.");
  }

  return new TaskStorage(sqlite, database, options.clock ?? (() => new Date()));
};
