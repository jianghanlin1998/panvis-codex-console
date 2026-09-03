import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

import {
  ChatThreadIdSchema,
  DEFAULT_V1_BUDGET_POLICY,
  ExecutionProviderIdSchema,
  ExecutionRunIdSchema,
  SubtaskImplementationCheckpointIdSchema,
  SubtaskIdSchema,
  validateSubtaskTransition,
} from "@codex-task-console/domain";
import type {
  BigTaskId,
  ChatThreadId,
  ExecutionRunId,
  NormalizedUsage,
  ProviderModelReference,
  ProviderRunReference,
  ProviderThreadReference,
  RepositoryCommitSha,
  SubtaskId,
  WorktreeOwnershipId,
} from "@codex-task-console/domain";
import { evaluateBigTaskCompletion } from "@codex-task-console/orchestration";
import type {
  WorkflowProfile,
  WorkflowStage,
} from "@codex-task-console/orchestration";

import { TaskStorageError } from "./errors.js";
import { ExecutionInputPreflight } from "./execution-input-preflight.js";
import { TaskStorage } from "./task-storage.js";
import { getTaskStorageWorktreeAccess } from "./task-storage-internals.js";
import {
  createWorktreeOwnershipManager,
  type ResolvedActiveOwnedWorktree,
  type WorktreeOwnershipManager,
} from "./worktree-ownership.js";
import type {
  DurableWorkflowControlView,
  DurableWorkflowEvidence,
  DurableWorkflowEvidenceAuthoritySourceType,
  DurableWorkflowEvidenceKind,
  DurableWorkflowEvidenceOutcome,
  DurableWorkflowEvidenceProducer,
} from "./workflow-control.js";

export const GOVERNED_SUBTASK_ROLES = Object.freeze([
  "EXECUTE",
  "VERIFY",
  "HARDEN",
  "FRESH_QA",
  "REPAIR",
  "FOCUSED_RE_QA",
] as const);

export type GovernedSubtaskRole = (typeof GOVERNED_SUBTASK_ROLES)[number];

export type GovernedRoleContextProfile =
  | "STANDARD_SUBTASK_EXECUTION"
  | "FRESH_INDEPENDENT_QA"
  | "FOCUSED_RE_QA";

export type GovernedDispatchStatus =
  | "RESERVED"
  | "ACTIVE"
  | "COMPLETED"
  | "HUMAN_REQUIRED";

export interface GovernedManualStartAuthority {
  readonly authorityId: string;
  readonly projectId: string;
  readonly bigTaskId: string;
  readonly planRevision: number;
  readonly candidateBinding: string;
  readonly subtaskId: SubtaskId;
  readonly workflowSequence: number;
  readonly authorizedAt: string;
}

export interface GovernedBudgetExtensionAuthority {
  readonly authorityId: string;
  readonly projectId: string;
  readonly bigTaskId: string;
  readonly planRevision: number;
  readonly candidateBinding: string;
  readonly subtaskId: SubtaskId;
  readonly grantedTokens: 40_000;
  readonly authorizedAt: string;
}

export interface AggregateSubtaskUsageBudget {
  readonly status:
    | "AVAILABLE"
    | "AVAILABLE_WARNING"
    | "HARD_PAUSE"
    | "ABSOLUTE_CEILING"
    | "UNKNOWN_USAGE";
  readonly allowed: boolean;
  readonly totalTokens: number | null;
  readonly warning: boolean;
  readonly extensionApplied: boolean;
  readonly effectiveLimitTokens: 120_000 | 160_000;
}

export interface GovernedDispatchReceipt {
  readonly receiptId: string;
  readonly operationId: string;
  readonly projectId: string;
  readonly bigTaskId: string;
  readonly planRevision: number;
  readonly candidateBinding: string;
  readonly subtaskId: SubtaskId;
  readonly workflowSequence: number;
  readonly profile: WorkflowProfile;
  readonly writeEnabled: boolean;
  readonly startPolicy: "MANUAL" | "WHEN_READY";
  readonly manualStartAuthorityId: string | null;
  readonly worktreeOwnershipId: WorktreeOwnershipId;
  readonly gateEvidenceReferences: readonly string[];
  readonly status: GovernedDispatchStatus;
  readonly reservedAt: string;
  readonly updatedAt: string;
  readonly terminalAt: string | null;
}

export interface GovernedRoleAuthorization {
  readonly authorizationId: string;
  readonly dispatchReceiptId: string;
  readonly projectId: string;
  readonly bigTaskId: string;
  readonly planRevision: number;
  readonly candidateBinding: string;
  readonly subtaskId: SubtaskId;
  readonly workflowSequence: number;
  readonly workflowStage: Exclude<
    WorkflowStage,
    "PLAN" | "REVIEW" | "MATERIALIZE" | "COMPLETE"
  >;
  readonly repairCyclesUsed: 0 | 1;
  readonly role: GovernedSubtaskRole;
  readonly contextProfile: GovernedRoleContextProfile;
  readonly writeEnabled: boolean;
  readonly worktreeOwnershipId: WorktreeOwnershipId;
  readonly candidateSha: RepositoryCommitSha;
  readonly authorizedAt: string;
}

export interface GovernedRoleExecutionAttempt {
  readonly authorization: GovernedRoleAuthorization;
  readonly chatThreadId: ChatThreadId;
  readonly executionRunId: ExecutionRunId;
}

export interface GovernedRoleExecutionInput {
  readonly authorization: GovernedRoleAuthorization;
  readonly attempt: GovernedRoleExecutionAttempt;
  readonly worktree: ResolvedActiveOwnedWorktree;
  readonly preflight: Readonly<{
    status: "WITHIN_TARGET" | "ABOVE_TARGET";
    utf8Bytes: number;
    normalTargetBytes: 40_000;
    absoluteCapBytes: 64_000;
    contextProfile: GovernedRoleContextProfile;
    text: string;
  }>;
}

export interface GovernedRoleResult {
  readonly resultId: string;
  readonly authorizationId: string;
  readonly executionRunId: ExecutionRunId;
  readonly role: GovernedSubtaskRole;
  readonly outcome: "READY" | "BLOCKED" | "PASS" | "BLOCKING_FAIL";
  readonly summary: string;
  readonly candidateSha: RepositoryCommitSha;
  readonly occurredAt: string;
}

export type GovernedPreparationResult =
  | Readonly<{
      kind: "ROLE_AUTHORIZED";
      authorization: GovernedRoleAuthorization;
      receipt: GovernedDispatchReceipt;
      budget: AggregateSubtaskUsageBudget;
    }>
  | Readonly<{
      kind: "ROLE_IN_PROGRESS";
      authorization: GovernedRoleAuthorization;
      receipt: GovernedDispatchReceipt;
      executionRunId: ExecutionRunId;
      runStatus: "CREATED" | "RUNNING";
    }>
  | Readonly<{
      kind: "BLOCKED";
      reason:
        | "PLANNING_AUTHORITY_NOT_READY"
        | "DEPENDENCY_BLOCKED"
        | "REPOSITORY_PREFLIGHT_BLOCKED"
        | "CONTEXT_PREFLIGHT_BLOCKED"
        | "BUDGET_BLOCKED"
        | "CONCURRENCY_BLOCKED"
        | "WORKTREE_BLOCKED"
        | "PROVIDER_ROLE_FAILED"
        | "ROLE_RESULT_BLOCKED"
        | "NO_ELIGIBLE_ACTION";
      subtaskId: SubtaskId | null;
    }>
  | Readonly<{
      kind: "HUMAN_REQUIRED";
      reason:
        | "MANUAL_START_REQUIRED"
        | "BUDGET_EXTENSION_REQUIRED"
        | "REPAIR_REQA_EXHAUSTED"
        | "AUTHORITY_BLOCKED"
        | "REPLAN_REQUIRED";
      subtaskId: SubtaskId | null;
    }>
  | Readonly<{
      kind: "BIG_TASK_COMPLETE";
      bigTaskId: BigTaskId;
      completionReceiptId: string;
    }>;

export type GovernedRoleReconciliationResult =
  | Readonly<{
      kind: "TRANSITION_RECORDED" | "HUMAN_REQUIRED";
      result: GovernedRoleResult;
      currentStage: WorkflowStage;
    }>
  | Readonly<{
      kind: "ROLE_RESULT_BLOCKED";
      result: GovernedRoleResult;
      currentStage: WorkflowStage;
    }>;

interface GovernedRoleFindingInput {
  readonly findingId: string;
  readonly blocking: boolean;
  readonly violatedInvariant: string;
  readonly affectedContract: string;
  readonly reproduction: string;
}

interface ParsedGovernedRoleResult {
  readonly outcome: GovernedRoleResult["outcome"];
  readonly summary: string;
  readonly findings: readonly GovernedRoleFindingInput[];
}

interface ManualStartRow {
  readonly authority_id: string;
  readonly project_id: string;
  readonly big_task_id: string;
  readonly plan_revision: number;
  readonly candidate_binding: string;
  readonly subtask_id: string;
  readonly workflow_sequence: number;
  readonly authorized_at: string;
}

interface BudgetExtensionRow {
  readonly authority_id: string;
  readonly project_id: string;
  readonly big_task_id: string;
  readonly plan_revision: number;
  readonly candidate_binding: string;
  readonly subtask_id: string;
  readonly granted_tokens: number;
  readonly authorized_at: string;
}

interface DispatchRow {
  readonly receipt_id: string;
  readonly operation_id: string;
  readonly project_id: string;
  readonly big_task_id: string;
  readonly plan_revision: number;
  readonly candidate_binding: string;
  readonly subtask_id: string;
  readonly workflow_sequence: number;
  readonly profile: string;
  readonly write_enabled: number;
  readonly start_policy: string;
  readonly manual_start_authority_id: string | null;
  readonly worktree_ownership_id: string;
  readonly gate_evidence_references: string;
  readonly status: string;
  readonly reserved_at: string;
  readonly updated_at: string;
  readonly terminal_at: string | null;
}

interface RoleAuthorizationRow {
  readonly authorization_id: string;
  readonly dispatch_receipt_id: string;
  readonly project_id: string;
  readonly big_task_id: string;
  readonly plan_revision: number;
  readonly candidate_binding: string;
  readonly subtask_id: string;
  readonly workflow_sequence: number;
  readonly workflow_stage: string;
  readonly repair_cycles_used: number;
  readonly role: string;
  readonly context_profile: string;
  readonly write_enabled: number;
  readonly worktree_ownership_id: string;
  readonly candidate_sha: string;
  readonly authorized_at: string;
}

interface RoleLinkRow {
  readonly authorization_id: string;
  readonly chat_thread_id: string;
  readonly execution_run_id: string;
  readonly linked_at: string;
}

interface RoleResultRow {
  readonly result_id: string;
  readonly authorization_id: string;
  readonly execution_run_id: string;
  readonly role: string;
  readonly outcome: string;
  readonly summary: string;
  readonly candidate_sha: string;
  readonly occurred_at: string;
}

interface FindingRow {
  readonly finding_id: string;
  readonly result_id: string;
  readonly subtask_id: string;
  readonly ordinal: number;
  readonly provider_finding_key: string;
  readonly blocking: number;
  readonly violated_invariant: string;
  readonly affected_contract: string;
  readonly reproduction: string;
  readonly created_at: string;
}

const ROLE_INPUT_MARKER = "CODEX_TASK_CONSOLE_GOVERNED_ROLE_V0\n";
const MAX_ROLE_RESULT_BYTES = 16 * 1024;
const SAFE_GIT_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

const invalid = (message: string): TaskStorageError =>
  new TaskStorageError("INVALID_INPUT", message);

const conflict = (message: string): TaskStorageError =>
  new TaskStorageError("CONFLICT", message);

const malformed = (): TaskStorageError =>
  new TaskStorageError(
    "MALFORMED_STORED_DATA",
    "Stored governed execution authority is malformed.",
  );

const stableId = (prefix: string, ...parts: readonly unknown[]): string =>
  `${prefix}_${createHash("sha256")
    .update(JSON.stringify(parts), "utf8")
    .digest("hex")
    .slice(0, 48)}`;

const isCanonicalTimestamp = (value: unknown): value is string => {
  if (typeof value !== "string") {
    return false;
  }
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
};

const isCommitSha = (value: unknown): value is RepositoryCommitSha =>
  typeof value === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value);

const hasExactKeys = (
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): boolean => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseBoundedText = (
  value: unknown,
  maximum: number,
): string | null =>
  typeof value === "string" &&
  value.trim() === value &&
  value.length >= 1 &&
  value.length <= maximum
    ? value
    : null;

const roleForStage = (
  stage: WorkflowStage,
): GovernedSubtaskRole | null =>
  GOVERNED_SUBTASK_ROLES.find((role) => role === stage) ?? null;

const contextProfileForRole = (
  role: GovernedSubtaskRole,
): GovernedRoleContextProfile => {
  if (role === "FRESH_QA") {
    return "FRESH_INDEPENDENT_QA";
  }
  if (role === "FOCUSED_RE_QA") {
    return "FOCUSED_RE_QA";
  }
  return "STANDARD_SUBTASK_EXECUTION";
};

const roleWrites = (
  role: GovernedSubtaskRole,
  subtaskWriteEnabled: boolean,
): boolean =>
  subtaskWriteEnabled &&
  (role === "EXECUTE" || role === "HARDEN" || role === "REPAIR");

const roleInstruction = (role: GovernedSubtaskRole): string => {
  switch (role) {
    case "EXECUTE":
      return "Implement exactly the durable Task Contract in the owned candidate worktree. Leave a clean committed candidate. Return only the governed JSON result contract.";
    case "VERIFY":
      return "Inspect the exact candidate read-only against its acceptance criteria. Do not modify files. Return only the governed JSON result contract.";
    case "HARDEN":
      return "Harden the implemented candidate within the approved scope. Leave a clean committed candidate. Do not claim final acceptance. Return only the governed JSON result contract.";
    case "FRESH_QA":
      return "Perform fresh independent no-write QA against canonical evidence only. Exclude builder and hardener reasoning. Return only the governed JSON result contract.";
    case "REPAIR":
      return "Repair only the supplied bounded blocking invariant in the owned candidate. Leave a clean committed candidate. Return only the governed JSON result contract.";
    case "FOCUSED_RE_QA":
      return "Perform fresh read-only retesting of only the supplied bounded target plus required canonical evidence. Exclude repair reasoning. Return only the governed JSON result contract.";
  }
};

const roleResultContract = (role: GovernedSubtaskRole): Readonly<object> =>
  role === "EXECUTE" || role === "REPAIR"
    ? freeze({
        exactKeys: ["schemaVersion", "outcome", "summary", "findings"],
        schemaVersion: 1,
        outcome: ["READY", "BLOCKED"],
        summary: "non-empty trimmed string, maximum 1000 characters",
        findings: "must be []",
      })
    : freeze({
        exactKeys: ["schemaVersion", "outcome", "summary", "findings"],
        schemaVersion: 1,
        outcome: ["PASS", "BLOCKING_FAIL"],
        summary: "non-empty trimmed string, maximum 1000 characters",
        findings:
          "PASS requires no blocking finding; BLOCKING_FAIL requires exactly one blocking finding",
        findingExactKeys: [
          "findingId",
          "blocking",
          "violatedInvariant",
          "affectedContract",
          "reproduction",
        ],
      });

const parseGovernedRoleResult = (
  role: GovernedSubtaskRole,
  text: string,
): ParsedGovernedRoleResult => {
  if (
    typeof text !== "string" ||
    Buffer.byteLength(text, "utf8") > MAX_ROLE_RESULT_BYTES
  ) {
    throw invalid("The governed role result is invalid.");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(text) as unknown;
  } catch {
    throw invalid("The governed role result is invalid.");
  }
  if (!isRecord(decoded)) {
    throw invalid("The governed role result is invalid.");
  }
  const resultKeys = ["schemaVersion", "outcome", "summary", "findings"];
  if (
    !hasExactKeys(decoded, resultKeys) ||
    decoded.schemaVersion !== 1 ||
    !Array.isArray(decoded.findings) ||
    decoded.findings.length > 16
  ) {
    throw invalid("The governed role result is invalid.");
  }
  const summary = parseBoundedText(decoded.summary, 1_000);
  const writeOutcome = decoded.outcome === "READY" || decoded.outcome === "BLOCKED";
  const assessmentOutcome =
    decoded.outcome === "PASS" || decoded.outcome === "BLOCKING_FAIL";
  if (
    summary === null ||
    ((role === "EXECUTE" || role === "REPAIR")
      ? !writeOutcome
      : !assessmentOutcome)
  ) {
    throw invalid("The governed role result is invalid.");
  }
  const findings = decoded.findings.map((value) => {
    if (
      !isRecord(value) ||
      !hasExactKeys(value, [
        "affectedContract",
        "blocking",
        "findingId",
        "reproduction",
        "violatedInvariant",
      ]) ||
      typeof value.blocking !== "boolean"
    ) {
      throw invalid("The governed role result is invalid.");
    }
    const findingId = parseBoundedText(value.findingId, 128);
    const violatedInvariant = parseBoundedText(value.violatedInvariant, 1_000);
    const affectedContract = parseBoundedText(value.affectedContract, 256);
    const reproduction = parseBoundedText(value.reproduction, 1_000);
    if (
      findingId === null ||
      violatedInvariant === null ||
      affectedContract === null ||
      reproduction === null
    ) {
      throw invalid("The governed role result is invalid.");
    }
    return Object.freeze({
      findingId,
      blocking: value.blocking,
      violatedInvariant,
      affectedContract,
      reproduction,
    });
  });
  if (new Set(findings.map(({ findingId }) => findingId)).size !== findings.length) {
    throw invalid("The governed role result is invalid.");
  }
  const blockingCount = findings.filter(({ blocking }) => blocking).length;
  if (
    (decoded.outcome === "BLOCKING_FAIL" &&
      (blockingCount !== 1 || findings.length !== 1)) ||
    ((decoded.outcome === "PASS" || decoded.outcome === "READY") &&
      findings.length !== 0) ||
    ((role === "EXECUTE" || role === "REPAIR") && findings.length !== 0)
  ) {
    throw invalid("The governed role result is invalid.");
  }
  return Object.freeze({
    outcome: decoded.outcome as GovernedRoleResult["outcome"],
    summary,
    findings: Object.freeze(findings),
  });
};

const freeze = <Value>(value: Value): Value => {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value)) {
    freeze(nested);
  }
  return Object.freeze(value);
};

const parseStringArray = (encoded: string): readonly string[] => {
  let value: unknown;
  try {
    value = JSON.parse(encoded) as unknown;
  } catch {
    throw malformed();
  }
  if (
    !Array.isArray(value) ||
    value.length > 32 ||
    value.some(
      (item) =>
        typeof item !== "string" ||
        item.trim() !== item ||
        item.length < 1 ||
        item.length > 2_048,
    ) ||
    new Set(value).size !== value.length ||
    JSON.stringify([...value].sort()) !== encoded
  ) {
    throw malformed();
  }
  return Object.freeze(value as string[]);
};

const parseDispatchRow = (row: DispatchRow): GovernedDispatchReceipt => {
  const subtaskId = SubtaskIdSchema.safeParse(row.subtask_id);
  const ownershipId = /^wt_[0-9a-f]{32}$/u.test(row.worktree_ownership_id);
  const profile = ["LOW", "STANDARD", "HIGH_RISK_FOUNDATION"].find(
    (value) => value === row.profile,
  );
  const status = ["RESERVED", "ACTIVE", "COMPLETED", "HUMAN_REQUIRED"].find(
    (value) => value === row.status,
  );
  if (
    !/^gdr_[0-9a-f]{48}$/u.test(row.receipt_id) ||
    !/^gdo_[0-9a-f]{48}$/u.test(row.operation_id) ||
    !subtaskId.success ||
    subtaskId.data !== row.subtask_id ||
    !Number.isSafeInteger(row.plan_revision) ||
    row.plan_revision < 1 ||
    row.candidate_binding.length < 1 ||
    !Number.isSafeInteger(row.workflow_sequence) ||
    row.workflow_sequence < 1 ||
    profile === undefined ||
    (row.write_enabled !== 0 && row.write_enabled !== 1) ||
    (row.start_policy !== "MANUAL" && row.start_policy !== "WHEN_READY") ||
    (row.start_policy === "MANUAL") !==
      (row.manual_start_authority_id !== null) ||
    !ownershipId ||
    status === undefined ||
    !isCanonicalTimestamp(row.reserved_at) ||
    !isCanonicalTimestamp(row.updated_at) ||
    new Date(row.updated_at).getTime() < new Date(row.reserved_at).getTime() ||
    ((status === "COMPLETED" || status === "HUMAN_REQUIRED") !==
      (row.terminal_at !== null)) ||
    (row.terminal_at !== null &&
      (!isCanonicalTimestamp(row.terminal_at) ||
        row.terminal_at !== row.updated_at))
  ) {
    throw malformed();
  }
  return freeze({
    receiptId: row.receipt_id,
    operationId: row.operation_id,
    projectId: row.project_id,
    bigTaskId: row.big_task_id,
    planRevision: row.plan_revision,
    candidateBinding: row.candidate_binding,
    subtaskId: subtaskId.data,
    workflowSequence: row.workflow_sequence,
    profile: profile as WorkflowProfile,
    writeEnabled: row.write_enabled === 1,
    startPolicy: row.start_policy,
    manualStartAuthorityId: row.manual_start_authority_id,
    worktreeOwnershipId: row.worktree_ownership_id as WorktreeOwnershipId,
    gateEvidenceReferences: parseStringArray(row.gate_evidence_references),
    status: status as GovernedDispatchStatus,
    reservedAt: row.reserved_at,
    updatedAt: row.updated_at,
    terminalAt: row.terminal_at,
  });
};

const parseRoleAuthorizationRow = (
  row: RoleAuthorizationRow,
): GovernedRoleAuthorization => {
  const subtaskId = SubtaskIdSchema.safeParse(row.subtask_id);
  const role = GOVERNED_SUBTASK_ROLES.find((value) => value === row.role);
  const expectedRole = roleForStage(row.workflow_stage as WorkflowStage);
  const profile = [
    "STANDARD_SUBTASK_EXECUTION",
    "FRESH_INDEPENDENT_QA",
    "FOCUSED_RE_QA",
  ].find((value) => value === row.context_profile);
  if (
    !/^gra_[0-9a-f]{48}$/u.test(row.authorization_id) ||
    !/^gdr_[0-9a-f]{48}$/u.test(row.dispatch_receipt_id) ||
    !subtaskId.success ||
    subtaskId.data !== row.subtask_id ||
    role === undefined ||
    expectedRole !== role ||
    profile !== contextProfileForRole(role) ||
    !Number.isSafeInteger(row.plan_revision) ||
    row.plan_revision < 1 ||
    !Number.isSafeInteger(row.workflow_sequence) ||
    row.workflow_sequence < 1 ||
    (row.repair_cycles_used !== 0 && row.repair_cycles_used !== 1) ||
    (row.write_enabled !== 0 && row.write_enabled !== 1) ||
    !/^wt_[0-9a-f]{32}$/u.test(row.worktree_ownership_id) ||
    !isCommitSha(row.candidate_sha) ||
    !isCanonicalTimestamp(row.authorized_at)
  ) {
    throw malformed();
  }
  return freeze({
    authorizationId: row.authorization_id,
    dispatchReceiptId: row.dispatch_receipt_id,
    projectId: row.project_id,
    bigTaskId: row.big_task_id,
    planRevision: row.plan_revision,
    candidateBinding: row.candidate_binding,
    subtaskId: subtaskId.data,
    workflowSequence: row.workflow_sequence,
    workflowStage: row.workflow_stage as GovernedRoleAuthorization["workflowStage"],
    repairCyclesUsed: row.repair_cycles_used as 0 | 1,
    role,
    contextProfile: profile as GovernedRoleContextProfile,
    writeEnabled: row.write_enabled === 1,
    worktreeOwnershipId: row.worktree_ownership_id as WorktreeOwnershipId,
    candidateSha: row.candidate_sha,
    authorizedAt: row.authorized_at,
  });
};

const parseRoleResultRow = (row: RoleResultRow): GovernedRoleResult => {
  const runId = ExecutionRunIdSchema.safeParse(row.execution_run_id);
  const role = GOVERNED_SUBTASK_ROLES.find((value) => value === row.role);
  if (
    !/^grr_[0-9a-f]{48}$/u.test(row.result_id) ||
    !/^gra_[0-9a-f]{48}$/u.test(row.authorization_id) ||
    !runId.success ||
    runId.data !== row.execution_run_id ||
    role === undefined ||
    !["READY", "BLOCKED", "PASS", "BLOCKING_FAIL"].includes(row.outcome) ||
    parseBoundedText(row.summary, 1_000) === null ||
    !isCommitSha(row.candidate_sha) ||
    !isCanonicalTimestamp(row.occurred_at)
  ) {
    throw malformed();
  }
  return freeze({
    resultId: row.result_id,
    authorizationId: row.authorization_id,
    executionRunId: runId.data,
    role,
    outcome: row.outcome as GovernedRoleResult["outcome"],
    summary: row.summary,
    candidateSha: row.candidate_sha,
    occurredAt: row.occurred_at,
  });
};

const gitEnvironment = (): NodeJS.ProcessEnv => ({
  PATH: SAFE_GIT_PATH,
  HOME: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_PAGER: "cat",
  LC_ALL: "C",
});

const candidateIsClean = (path: string): boolean => {
  const result = spawnSync(
    "git",
    [
      "-C",
      path,
      "-c",
      "core.hooksPath=/dev/null",
      "status",
      "--porcelain=v2",
      "--untracked-files=all",
      "--ignore-submodules=none",
      "-z",
    ],
    {
      encoding: null,
      env: gitEnvironment(),
      maxBuffer: 4 * 1024 * 1024,
      shell: false,
      timeout: 15_000,
      windowsHide: true,
    },
  );
  return result.status === 0 && Buffer.from(result.stdout ?? []).length === 0;
};

const evidenceProducerForSource = (
  sourceType: DurableWorkflowEvidenceAuthoritySourceType,
): Readonly<{
  kind: DurableWorkflowEvidenceKind;
  producer: DurableWorkflowEvidenceProducer;
}> => {
  switch (sourceType) {
    case "REPOSITORY_PREFLIGHT":
      return { kind: "REPOSITORY_PREFLIGHT_PASSED", producer: "OPERATIONAL_GATE" };
    case "CONTEXT_PREFLIGHT":
      return { kind: "CONTEXT_PREFLIGHT_PASSED", producer: "OPERATIONAL_GATE" };
    case "BUDGET_GATE":
      return { kind: "BUDGET_AVAILABLE", producer: "OPERATIONAL_GATE" };
    case "CONCURRENCY_GATE":
      return { kind: "CONCURRENCY_AVAILABLE", producer: "OPERATIONAL_GATE" };
    case "WORKTREE_OWNERSHIP":
      return { kind: "WORKTREE_OWNERSHIP_AVAILABLE", producer: "OPERATIONAL_GATE" };
    case "HUMAN_APPROVAL":
      return { kind: "HUMAN_APPROVAL_SATISFIED", producer: "HUMAN_AUTHORITY" };
    case "VERIFICATION_ROLE":
      return { kind: "VERIFICATION_EVIDENCE_PASSED", producer: "WORKFLOW_ROLE" };
    case "HARDENING_ROLE":
      return { kind: "HARDENING_EVIDENCE_PASSED", producer: "WORKFLOW_ROLE" };
    case "FRESH_INDEPENDENT_QA":
      return { kind: "FRESH_QA_OUTCOME_RECORDED", producer: "WORKFLOW_ROLE" };
    case "REPAIR_ROLE":
      return { kind: "REPAIR_EVIDENCE_PASSED", producer: "WORKFLOW_ROLE" };
    case "FOCUSED_RE_QA":
      return { kind: "FOCUSED_RE_QA_OUTCOME_RECORDED", producer: "WORKFLOW_ROLE" };
    case "BLOCKING_FINDING_CONTROL":
      return { kind: "NO_UNRESOLVED_BLOCKING_FINDING", producer: "DELIVERY_CONTROL" };
    case "HANDOFF_CONTROL":
      return { kind: "HANDOFF_PRESENT", producer: "DELIVERY_CONTROL" };
    case "PROMOTED_CONTEXT_DISPOSITION":
      return {
        kind: "PROMOTED_CONTEXT_DISPOSITION_RECORDED",
        producer: "DELIVERY_CONTROL",
      };
  }
};

export class GovernedExecutionStore {
  readonly #storage: TaskStorage;
  readonly #worktrees: WorktreeOwnershipManager;

  constructor(storage: TaskStorage, worktrees?: WorktreeOwnershipManager) {
    if (!(storage instanceof TaskStorage)) {
      throw invalid("The governed execution store is invalid.");
    }
    this.#storage = storage;
    this.#worktrees = worktrees ?? createWorktreeOwnershipManager(storage);
    this.#access();
  }

  inspectBigTask(bigTaskId: BigTaskId): Readonly<{
    bigTaskId: BigTaskId;
    status: "IN_PROGRESS" | "DONE";
    candidateBinding: string | null;
    workflows: readonly DurableWorkflowControlView[];
    budgets: readonly AggregateSubtaskUsageBudget[];
    dispatchReceipts: readonly GovernedDispatchReceipt[];
  }> {
    const bigTask = this.#storage.getBigTaskById(bigTaskId);
    if (bigTask === null) {
      throw new TaskStorageError("PARENT_NOT_FOUND", "The Big Task does not exist.");
    }
    const materialization = this.#storage.getCanonicalTaskMaterialization(bigTaskId);
    const workflows =
      materialization === null
        ? []
        : materialization.subtasks.map(({ subtaskId }) => {
            const view = this.#storage.getDurableWorkflowControlView(subtaskId);
            if (view === null) {
              throw malformed();
            }
            return view;
          });
    const rows = this.#access().sqlite
      .prepare(
        "SELECT * FROM governed_dispatch_receipts WHERE big_task_id = ? ORDER BY receipt_id",
      )
      .all(bigTaskId) as unknown as readonly DispatchRow[];
    const receipts = rows.map(parseDispatchRow);
    for (const receipt of receipts) {
      const view = workflows.find(({ subtaskId }) => subtaskId === receipt.subtaskId);
      if (view === undefined) {
        throw malformed();
      }
      this.#assertDispatchAuthority(receipt, view);
    }
    return freeze({
      bigTaskId,
      status: bigTask.status,
      candidateBinding: materialization?.candidateBinding ?? null,
      workflows: Object.freeze(workflows),
      budgets: Object.freeze(
        workflows.map(({ subtaskId }) =>
          this.#deriveAggregateBudget(subtaskId, true),
        ),
      ),
      dispatchReceipts: Object.freeze(receipts),
    });
  }

  authorizeManualStart(subtaskId: SubtaskId): GovernedManualStartAuthority {
    const canonical = this.#canonicalSubtaskId(subtaskId);
    return this.#storage.runInTransaction(() => {
      const view = this.#requiredWorkflowView(canonical);
      const access = this.#access();
      const existing = access.sqlite
        .prepare(
          "SELECT * FROM governed_manual_start_authorities WHERE subtask_id = ?",
        )
        .get(canonical) as ManualStartRow | undefined;
      if (existing !== undefined) {
        return this.#manualStartFromRow(existing, view, false);
      }
      if (
        view.currentStage !== "EXECUTE" ||
        view.boardStatus !== "TODO" ||
        view.unresolvedHumanRequired !== null
      ) {
        throw conflict("The Subtask is not awaiting a manual governed start.");
      }
      const subtask = this.#storage.getSubtaskById(canonical);
      if (subtask?.startPolicy !== "MANUAL") {
        throw conflict("The Subtask does not require manual start authority.");
      }
      const authorityId = stableId(
        "gms",
        view.projectId,
        view.bigTaskId,
        view.planRevision,
        view.candidateBinding,
        view.subtaskId,
        view.transitionCount + 1,
      );
      const authorizedAt = this.#timestampAtOrAfter(view.initializedAt);
      access.sqlite
        .prepare(
          `INSERT INTO governed_manual_start_authorities (
             authority_id, project_id, big_task_id, plan_revision,
             candidate_binding, subtask_id, workflow_sequence, authorized_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          authorityId,
          view.projectId,
          view.bigTaskId,
          view.planRevision,
          view.candidateBinding,
          view.subtaskId,
          view.transitionCount + 1,
          authorizedAt,
        );
      const row = access.sqlite
        .prepare("SELECT * FROM governed_manual_start_authorities WHERE authority_id = ?")
        .get(authorityId) as ManualStartRow | undefined;
      if (row === undefined) {
        throw new TaskStorageError(
          "STORAGE_OPERATION_FAILED",
          "Manual start authority was not persisted.",
        );
      }
      return this.#manualStartFromRow(row, view);
    });
  }

  authorizeOneTimeBudgetExtension(
    subtaskId: SubtaskId,
  ): GovernedBudgetExtensionAuthority {
    const canonical = this.#canonicalSubtaskId(subtaskId);
    return this.#storage.runInTransaction(() => {
      const view = this.#requiredWorkflowView(canonical);
      const access = this.#access();
      const existing = access.sqlite
        .prepare("SELECT * FROM governed_budget_extensions WHERE subtask_id = ?")
        .get(canonical) as BudgetExtensionRow | undefined;
      if (existing !== undefined) {
        return this.#budgetExtensionFromRow(existing, view);
      }
      if (view.currentStage === "COMPLETE" || view.unresolvedHumanRequired !== null) {
        throw conflict("The Subtask cannot receive budget extension authority.");
      }
      const budget = this.#deriveAggregateBudget(canonical, false);
      if (
        budget.status !== "HARD_PAUSE" ||
        budget.totalTokens === null ||
        budget.totalTokens >= 160_000
      ) {
        throw conflict("The locked one-time budget extension is not applicable.");
      }
      const authorityId = stableId(
        "gbe",
        view.projectId,
        view.bigTaskId,
        view.planRevision,
        view.candidateBinding,
        view.subtaskId,
      );
      const authorizedAt = this.#timestampAtOrAfter(view.initializedAt);
      access.sqlite
        .prepare(
          `INSERT INTO governed_budget_extensions (
             authority_id, project_id, big_task_id, plan_revision,
             candidate_binding, subtask_id, granted_tokens, authorized_at
           ) VALUES (?, ?, ?, ?, ?, ?, 40000, ?)`,
        )
        .run(
          authorityId,
          view.projectId,
          view.bigTaskId,
          view.planRevision,
          view.candidateBinding,
          view.subtaskId,
          authorizedAt,
        );
      const row = access.sqlite
        .prepare("SELECT * FROM governed_budget_extensions WHERE authority_id = ?")
        .get(authorityId) as BudgetExtensionRow | undefined;
      if (row === undefined) {
        throw new TaskStorageError(
          "STORAGE_OPERATION_FAILED",
          "Budget extension authority was not persisted.",
        );
      }
      return this.#budgetExtensionFromRow(row, view);
    });
  }

  prepareNextRole(bigTaskId: BigTaskId): GovernedPreparationResult {
    let materialization = this.#storage.getCanonicalTaskMaterialization(bigTaskId);
    if (materialization === null) {
      const planning = this.#storage.getDurablePlanningSnapshot(bigTaskId);
      if (planning === null || planning.materializedGraph === null) {
        return freeze({
          kind: "BLOCKED",
          reason: "PLANNING_AUTHORITY_NOT_READY",
          subtaskId: null,
        });
      }
      this.#storage.materializeApprovedCanonicalTasks(bigTaskId);
      materialization = this.#storage.getCanonicalTaskMaterialization(bigTaskId);
    }
    if (materialization === null) {
      throw malformed();
    }
    if (this.#storage.getDurableSubtaskWorkflowInitialization(bigTaskId) === null) {
      this.#storage.initializeDurableSubtaskWorkflows(bigTaskId);
    }

    this.#reconcileDispatchStatuses(bigTaskId);
    const completed = this.#tryCompleteBigTask(bigTaskId);
    if (completed !== null) {
      return completed;
    }

    const views = materialization.subtasks.map(({ subtaskId }) =>
      this.#requiredWorkflowView(subtaskId),
    );
    const human = views.find(({ unresolvedHumanRequired }) =>
      unresolvedHumanRequired !== null,
    );
    if (human !== undefined) {
      return freeze({
        kind: "HUMAN_REQUIRED",
        reason:
          human.unresolvedHumanRequired?.reason ?? "AUTHORITY_BLOCKED",
        subtaskId: human.subtaskId,
      });
    }

    let inProgress: Extract<
      GovernedPreparationResult,
      { readonly kind: "ROLE_IN_PROGRESS" }
    > | null = null;
    for (const view of views) {
      if (view.currentStage === "COMPLETE") {
        continue;
      }
      const readiness = this.#storage.evaluateStoredSubtaskDependencyReadiness(
        view.subtaskId,
      );
      if (!readiness.valid) {
        throw malformed();
      }
      if (!readiness.ready) {
        continue;
      }
      try {
        const prepared = this.#prepareView(view);
        if (prepared.kind === "ROLE_IN_PROGRESS") {
          inProgress ??= prepared;
          continue;
        }
        return prepared;
      } catch (error) {
        if (error instanceof GovernedPreparationBlock) {
          return error.result;
        }
        throw error;
      }
    }
    return inProgress ?? freeze({
      kind: "BLOCKED",
      reason: views.some(({ currentStage }) => currentStage !== "COMPLETE")
        ? "DEPENDENCY_BLOCKED"
        : "NO_ELIGIBLE_ACTION",
      subtaskId: null,
    });
  }

  reserveRoleExecutionAttempt(
    authorizationId: string,
  ): GovernedRoleExecutionAttempt {
    const authorization = this.getRoleAuthorization(authorizationId);
    if (authorization === null) {
      throw new TaskStorageError(
        "PARENT_NOT_FOUND",
        "The governed role authorization does not exist.",
      );
    }
    return this.#storage.runInTransaction(() => {
      this.#assertRoleAuthorizationCurrent(authorization);
      const access = this.#access();
      const existing = access.sqlite
        .prepare(
          "SELECT * FROM governed_role_execution_links WHERE authorization_id = ?",
        )
        .get(authorization.authorizationId) as RoleLinkRow | undefined;
      if (existing !== undefined) {
        const attempt = this.#attemptFromLink(existing, authorization);
        const run = this.#storage.getExecutionRunById(attempt.executionRunId);
        if (run === null) {
          throw malformed();
        }
        if (run.status !== "CREATED") {
          throw conflict("The governed role already has a started execution attempt.");
        }
        const thread = this.#storage.getChatThreadById(attempt.chatThreadId);
        if (thread === null || thread.providerThread !== null) {
          throw conflict("The governed role pre-start attempt cannot be resumed safely.");
        }
        return attempt;
      }
      const active = access.sqlite
        .prepare(
          `SELECT er.id
             FROM execution_runs er
             JOIN chat_threads ct ON ct.id = er.chat_thread_id
            WHERE ct.subtask_id = ? AND er.status IN ('CREATED', 'RUNNING')
            LIMIT 1`,
        )
        .get(authorization.subtaskId) as { readonly id: string } | undefined;
      if (active !== undefined) {
        throw conflict("The Subtask already has an active primary execution.");
      }
      const chatThreadId = ChatThreadIdSchema.parse(
        stableId("thr", authorization.authorizationId),
      );
      const executionRunId = ExecutionRunIdSchema.parse(
        stableId("run", authorization.authorizationId),
      );
      this.#storage.createChatThread({
        id: chatThreadId,
        subtaskId: authorization.subtaskId,
        providerId: ExecutionProviderIdSchema.parse("codex-app-server"),
      });
      this.#storage.createExecutionRun({
        id: executionRunId,
        chatThreadId,
      });
      const linkedAt = this.#timestampAtOrAfter(authorization.authorizedAt);
      access.sqlite
        .prepare(
          `INSERT INTO governed_role_execution_links (
             authorization_id, chat_thread_id, execution_run_id, linked_at
           ) VALUES (?, ?, ?, ?)`,
        )
        .run(
          authorization.authorizationId,
          chatThreadId,
          executionRunId,
          linkedAt,
        );
      const row = access.sqlite
        .prepare(
          "SELECT * FROM governed_role_execution_links WHERE authorization_id = ?",
        )
        .get(authorization.authorizationId) as RoleLinkRow | undefined;
      if (row === undefined) {
        throw new TaskStorageError(
          "STORAGE_OPERATION_FAILED",
          "The governed role execution link was not persisted.",
        );
      }
      return this.#attemptFromLink(row, authorization);
    });
  }

  resolveRoleExecutionInput(
    authorizationId: string,
  ): GovernedRoleExecutionInput {
    const authorization = this.getRoleAuthorization(authorizationId);
    if (authorization === null) {
      throw new TaskStorageError(
        "PARENT_NOT_FOUND",
        "The governed role authorization does not exist.",
      );
    }
    this.#assertRoleAuthorizationCurrent(authorization);
    const link = this.#access().sqlite
      .prepare(
        "SELECT * FROM governed_role_execution_links WHERE authorization_id = ?",
      )
      .get(authorization.authorizationId) as RoleLinkRow | undefined;
    if (link === undefined) {
      throw conflict("The governed role execution attempt is not reserved.");
    }
    const attempt = this.#attemptFromLink(link, authorization);
    const run = this.#storage.getExecutionRunById(attempt.executionRunId);
    const thread = this.#storage.getChatThreadById(attempt.chatThreadId);
    if (
      run === null ||
      thread === null ||
      run.status !== "CREATED" ||
      thread.status !== "OPEN" ||
      thread.providerThread !== null
    ) {
      throw conflict("The governed role execution attempt cannot start.");
    }
    const budget = this.#deriveAggregateBudget(authorization.subtaskId, true);
    if (!budget.allowed) {
      throw conflict("The governed role usage budget is unavailable.");
    }
    const worktree = this.#worktrees.resolveActiveOwnedWorktreeForSubtask(
      authorization.subtaskId,
    );
    if (
      worktree.ownership.id !== authorization.worktreeOwnershipId ||
      worktree.currentHeadSha !== authorization.candidateSha ||
      !candidateIsClean(worktree.ownership.worktreePath)
    ) {
      throw conflict("The governed candidate worktree authority drifted.");
    }
    const preflight = this.#compileRoleInput(authorization);
    if (!preflight.allowed) {
      throw conflict("The governed role context exceeds the hard cap.");
    }
    return freeze({
      authorization,
      attempt,
      worktree,
      preflight,
    });
  }

  revalidateRoleCandidate(
    authorizationId: string,
  ): ResolvedActiveOwnedWorktree {
    const authorization = this.getRoleAuthorization(authorizationId);
    if (authorization === null) {
      throw new TaskStorageError(
        "PARENT_NOT_FOUND",
        "The governed role authorization does not exist.",
      );
    }
    this.#assertRoleAuthorizationCurrent(authorization);
    const link = this.#requiredRoleLink(authorization.authorizationId);
    const run = this.#storage.getExecutionRunById(
      ExecutionRunIdSchema.parse(link.execution_run_id),
    );
    if (
      run === null ||
      (run.status !== "CREATED" && run.status !== "RUNNING")
    ) {
      throw conflict("The governed role execution is not active.");
    }
    const worktree = this.#worktrees.resolveActiveOwnedWorktreeForSubtask(
      authorization.subtaskId,
    );
    if (
      worktree.ownership.id !== authorization.worktreeOwnershipId ||
      !candidateIsClean(worktree.ownership.worktreePath) ||
      (!authorization.writeEnabled &&
        worktree.currentHeadSha !== authorization.candidateSha)
    ) {
      throw conflict("The governed candidate worktree authority drifted.");
    }
    return worktree;
  }

  bindRoleProviderThread(
    authorizationId: string,
    providerThread: ProviderThreadReference,
  ): void {
    const authorization = this.getRoleAuthorization(authorizationId);
    if (authorization === null) {
      throw new TaskStorageError(
        "PARENT_NOT_FOUND",
        "The governed role authorization does not exist.",
      );
    }
    this.#assertRoleAuthorizationCurrent(authorization);
    const link = this.#requiredRoleLink(authorization.authorizationId);
    this.#storage.bindChatThreadProviderReference({
      chatThreadId: ChatThreadIdSchema.parse(link.chat_thread_id),
      providerThread,
    });
  }

  startRoleProviderRun(
    authorizationId: string,
    providerRun: ProviderRunReference,
    providerModel?: ProviderModelReference,
  ): void {
    const authorization = this.getRoleAuthorization(authorizationId);
    if (authorization === null) {
      throw new TaskStorageError(
        "PARENT_NOT_FOUND",
        "The governed role authorization does not exist.",
      );
    }
    this.#assertRoleAuthorizationCurrent(authorization);
    const link = this.#requiredRoleLink(authorization.authorizationId);
    this.#storage.startExecutionRun({
      executionRunId: ExecutionRunIdSchema.parse(link.execution_run_id),
      providerRun,
      ...(providerModel === undefined ? {} : { providerModel }),
    });
  }

  getRoleAuthorization(
    authorizationId: string,
  ): GovernedRoleAuthorization | null {
    if (!/^gra_[0-9a-f]{48}$/u.test(authorizationId)) {
      throw invalid("The governed role authorization ID is invalid.");
    }
    const row = this.#access().sqlite
      .prepare("SELECT * FROM governed_role_authorizations WHERE authorization_id = ?")
      .get(authorizationId) as RoleAuthorizationRow | undefined;
    return row === undefined ? null : parseRoleAuthorizationRow(row);
  }

  persistSuccessfulRoleResult(
    authorizationId: string,
    responseText: string,
    providerModel?: ProviderModelReference,
    normalizedUsage?: NormalizedUsage,
  ): GovernedRoleResult {
    const authorization = this.getRoleAuthorization(authorizationId);
    if (authorization === null) {
      throw new TaskStorageError(
        "PARENT_NOT_FOUND",
        "The governed role authorization does not exist.",
      );
    }
    const parsed = parseGovernedRoleResult(authorization.role, responseText);
    return this.#storage.runInTransaction(() => {
      const focusedFailureTarget =
        authorization.role === "FOCUSED_RE_QA" &&
        parsed.outcome === "BLOCKING_FAIL"
          ? this.#requiredBlockingFinding(authorization.subtaskId)
          : null;
      if (focusedFailureTarget !== null) {
        const [reported] = parsed.findings;
        if (
          reported === undefined ||
          reported.findingId !== focusedFailureTarget.provider_finding_key ||
          reported.violatedInvariant !== focusedFailureTarget.violated_invariant ||
          reported.affectedContract !== focusedFailureTarget.affected_contract ||
          reported.reproduction !== focusedFailureTarget.reproduction
        ) {
          throw conflict("Focused Re-QA must report the exact bounded finding.");
        }
      }
      const findingsToPersist =
        focusedFailureTarget === null ? parsed.findings : Object.freeze([]);
      const existing = this.#getRoleResult(authorization.authorizationId);
      if (existing !== null) {
        const findings = this.#recordRoleFindingRows(existing.resultId);
        if (
          existing.role !== authorization.role ||
          existing.outcome !== parsed.outcome ||
          existing.summary !== parsed.summary ||
          findings.length !== findingsToPersist.length ||
          findings.some((finding, index) => {
            const expected = findingsToPersist[index];
            return (
              expected === undefined ||
              finding.ordinal !== index ||
              finding.provider_finding_key !== expected.findingId ||
              finding.blocking !== (expected.blocking ? 1 : 0) ||
              finding.violated_invariant !== expected.violatedInvariant ||
              finding.affected_contract !== expected.affectedContract ||
              finding.reproduction !== expected.reproduction
            );
          })
        ) {
          throw conflict("The governed role result conflicts with prior history.");
        }
        return existing;
      }
      this.#assertRoleAuthorizationCurrent(authorization);
      const link = this.#requiredRoleLink(authorization.authorizationId);
      const runId = ExecutionRunIdSchema.parse(link.execution_run_id);
      const run = this.#storage.getExecutionRunById(runId);
      if (run?.status !== "RUNNING") {
        throw conflict("Only the exact running governed role may report a result.");
      }
      const worktree = this.#worktrees.resolveActiveOwnedWorktreeForSubtask(
        authorization.subtaskId,
      );
      if (
        worktree.ownership.id !== authorization.worktreeOwnershipId ||
        !candidateIsClean(worktree.ownership.worktreePath) ||
        (!authorization.writeEnabled &&
          worktree.currentHeadSha !== authorization.candidateSha)
      ) {
        throw conflict("The governed candidate state is not trustworthy.");
      }
      const resultId = stableId("grr", authorization.authorizationId);
      const occurredAt = this.#timestampAtOrAfter(authorization.authorizedAt);
      const access = this.#access();
      access.sqlite
        .prepare(
          `INSERT INTO governed_role_results (
             result_id, authorization_id, execution_run_id, role, outcome,
             summary, candidate_sha, occurred_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          resultId,
          authorization.authorizationId,
          runId,
          authorization.role,
          parsed.outcome,
          parsed.summary,
          worktree.currentHeadSha,
          occurredAt,
        );
      findingsToPersist.forEach((finding, ordinal) => {
        access.sqlite
          .prepare(
            `INSERT INTO governed_findings (
               finding_id, result_id, subtask_id, ordinal,
               provider_finding_key, blocking, violated_invariant,
               affected_contract, reproduction, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            stableId("gfd", resultId, ordinal),
            resultId,
            authorization.subtaskId,
            ordinal,
            finding.findingId,
            finding.blocking ? 1 : 0,
            finding.violatedInvariant,
            finding.affectedContract,
            finding.reproduction,
            occurredAt,
          );
      });
      this.#storage.finalizePrimaryExecutionAttempt({
        executionRunId: runId,
        status: "SUCCEEDED",
        ...(providerModel === undefined ? {} : { providerModel }),
        ...(normalizedUsage === undefined ? {} : { normalizedUsage }),
      });
      const result = this.#getRoleResult(authorization.authorizationId);
      if (result === null) {
        throw new TaskStorageError(
          "STORAGE_OPERATION_FAILED",
          "The governed role result was not persisted.",
        );
      }
      return result;
    });
  }

  finalizeFailedRoleAttempt(
    authorizationId: string,
    status: "FAILED" | "INTERRUPTED",
    providerModel?: ProviderModelReference,
    normalizedUsage?: NormalizedUsage,
  ): void {
    const authorization = this.getRoleAuthorization(authorizationId);
    if (authorization === null) {
      throw new TaskStorageError(
        "PARENT_NOT_FOUND",
        "The governed role authorization does not exist.",
      );
    }
    const link = this.#requiredRoleLink(authorization.authorizationId);
    const runId = ExecutionRunIdSchema.parse(link.execution_run_id);
    const run = this.#storage.getExecutionRunById(runId);
    if (run === null) {
      throw malformed();
    }
    if (run.status === "CREATED") {
      if (status !== "FAILED") {
        throw conflict("A pre-start governed role can only fail.");
      }
      this.#storage.finalizePrimaryExecutionAttempt({
        executionRunId: runId,
        status: "FAILED",
      });
      return;
    }
    if (run.status !== "RUNNING") {
      throw conflict("The governed role execution is already terminal.");
    }
    this.#storage.finalizePrimaryExecutionAttempt({
      executionRunId: runId,
      status,
      ...(providerModel === undefined ? {} : { providerModel }),
      ...(normalizedUsage === undefined ? {} : { normalizedUsage }),
    });
  }

  reconcileRoleResult(
    authorizationId: string,
  ): GovernedRoleReconciliationResult {
    const authorization = this.getRoleAuthorization(authorizationId);
    if (authorization === null) {
      throw new TaskStorageError(
        "PARENT_NOT_FOUND",
        "The governed role authorization does not exist.",
      );
    }
    const result = this.#getRoleResult(authorization.authorizationId);
    if (result === null) {
      throw conflict("The governed role has no structured result to reconcile.");
    }
    const run = this.#storage.getExecutionRunById(result.executionRunId);
    if (run?.status !== "SUCCEEDED") {
      throw malformed();
    }
    return this.#storage.runInTransaction(() =>
      this.#reconcilePersistedRoleResult(authorization, result),
    );
  }

  #prepareView(viewInput: DurableWorkflowControlView): GovernedPreparationResult {
    let view = viewInput;
    if (view.currentStage === "MATERIALIZE") {
      const worktree = this.#ensureOwnedWorktree(view.subtaskId);
      const derived = this.#deriveDispatchGates(view, worktree);
      if (!derived.budget.allowed) {
        throw this.#budgetBlock(view.subtaskId, derived.budget);
      }
      const evidence = this.#storage.runInTransaction(() => {
        const current = this.#requiredWorkflowView(view.subtaskId);
        if (
          current.currentStage !== "MATERIALIZE" ||
          current.transitionCount !== view.transitionCount
        ) {
          throw conflict("The workflow changed before dispatch gate commitment.");
        }
        const refreshedWorktree = this.#worktrees.resolveActiveOwnedWorktreeForSubtask(
          current.subtaskId,
        );
        const refreshed = this.#deriveDispatchGates(current, refreshedWorktree);
        if (!refreshed.budget.allowed) {
          throw this.#budgetBlock(current.subtaskId, refreshed.budget);
        }
        return this.#recordDispatchGateEvidence(current, refreshed);
      });
      const transition = this.#storage.advanceDurableWorkflow({
        operationId: stableId("wop", view.subtaskId, view.transitionCount + 1, "EXECUTE"),
        projectId: view.projectId as never,
        bigTaskId: view.bigTaskId as never,
        candidateBinding: view.candidateBinding,
        subtaskId: view.subtaskId,
        requestedNextStage: "EXECUTE",
        evidenceReferences: evidence.map(({ evidenceId }) => ({
          sourceType: "WORKFLOW_EVIDENCE" as const,
          sourceReference: evidenceId,
        })),
      });
      if (transition.kind !== "TRANSITION_RECORDED") {
        throw conflict("The durable workflow did not enter execution.");
      }
      view = transition.view;
    }
    if (view.currentStage === "COMPLETE") {
      throw new GovernedPreparationBlock(
        freeze({
          kind: "BLOCKED",
          reason: "NO_ELIGIBLE_ACTION",
          subtaskId: view.subtaskId,
        }),
      );
    }

    let receipt = this.#getDispatchReceiptForSubtask(view.subtaskId);
    let budget = this.#deriveAggregateBudget(view.subtaskId, true);
    if (receipt === null) {
      if (view.currentStage !== "EXECUTE" || view.boardStatus !== "TODO") {
        throw malformed();
      }
      const subtask = this.#storage.getSubtaskById(view.subtaskId);
      if (subtask === null) {
        throw malformed();
      }
      if (subtask.startPolicy === "MANUAL") {
        const manual = this.#getManualStart(view.subtaskId);
        if (manual === null) {
          throw new GovernedPreparationBlock(
            freeze({
              kind: "HUMAN_REQUIRED",
              reason: "MANUAL_START_REQUIRED",
              subtaskId: view.subtaskId,
            }),
          );
        }
      }
      const worktree = this.#ensureOwnedWorktree(view.subtaskId);
      const gates = this.#deriveDispatchGates(view, worktree);
      budget = gates.budget;
      if (!budget.allowed) {
        throw this.#budgetBlock(view.subtaskId, budget);
      }
      receipt = this.#reserveDispatch(view, worktree, gates);
      view = this.#requiredWorkflowView(view.subtaskId);
    }
    if (receipt.status === "COMPLETED" || receipt.status === "HUMAN_REQUIRED") {
      throw malformed();
    }
    this.#assertDispatchAuthority(receipt, view);

    const currentAuthorization = this.#getRoleAuthorizationForSequence(
      view.subtaskId,
      view.transitionCount + 1,
    );
    if (currentAuthorization !== null) {
      const result = this.#getRoleResult(currentAuthorization.authorizationId);
      if (result !== null) {
        return this.#afterReconciliation(
          receipt,
          this.reconcileRoleResult(currentAuthorization.authorizationId),
        );
      }
      const link = this.#getRoleLink(currentAuthorization.authorizationId);
      if (link !== null) {
        const runId = ExecutionRunIdSchema.parse(link.execution_run_id);
        const run = this.#storage.getExecutionRunById(runId);
        if (run === null) {
          throw malformed();
        }
        const thread = this.#storage.getChatThreadById(
          ChatThreadIdSchema.parse(link.chat_thread_id),
        );
        if (thread === null) {
          throw malformed();
        }
        if (run.status === "CREATED" && thread.providerThread === null) {
          return freeze({
            kind: "ROLE_AUTHORIZED",
            authorization: currentAuthorization,
            receipt,
            budget,
          });
        }
        if (run.status === "RUNNING") {
          const activeBudget = this.#deriveAggregateBudget(view.subtaskId, true);
          if (!activeBudget.allowed) {
            throw this.#budgetBlock(view.subtaskId, activeBudget);
          }
          return freeze({
            kind: "ROLE_IN_PROGRESS",
            authorization: currentAuthorization,
            receipt,
            executionRunId: run.id,
            runStatus: run.status,
          });
        }
        throw new GovernedPreparationBlock(
          freeze({
            kind: "BLOCKED",
            reason: "PROVIDER_ROLE_FAILED",
            subtaskId: view.subtaskId,
          }),
        );
      }
      return freeze({
        kind: "ROLE_AUTHORIZED",
        authorization: currentAuthorization,
        receipt,
        budget,
      });
    }

    budget = this.#deriveAggregateBudget(view.subtaskId, true);
    if (!budget.allowed) {
      throw this.#budgetBlock(view.subtaskId, budget);
    }
    const authorization = this.#authorizeCurrentRole(view, receipt);
    const activeReceipt = this.#getDispatchReceiptForSubtask(view.subtaskId);
    if (activeReceipt === null) {
      throw malformed();
    }
    return freeze({
      kind: "ROLE_AUTHORIZED",
      authorization,
      receipt: activeReceipt,
      budget,
    });
  }

  #afterReconciliation(
    receipt: GovernedDispatchReceipt,
    reconciled: GovernedRoleReconciliationResult,
  ): GovernedPreparationResult {
    if (reconciled.kind === "ROLE_RESULT_BLOCKED") {
      return freeze({
        kind: "BLOCKED",
        reason: "ROLE_RESULT_BLOCKED",
        subtaskId: receipt.subtaskId,
      });
    }
    if (reconciled.kind === "HUMAN_REQUIRED") {
      return freeze({
        kind: "HUMAN_REQUIRED",
        reason: "REPAIR_REQA_EXHAUSTED",
        subtaskId: receipt.subtaskId,
      });
    }
    const view = this.#requiredWorkflowView(receipt.subtaskId);
    if (view.currentStage === "COMPLETE") {
      const complete = this.#tryCompleteBigTask(view.bigTaskId as BigTaskId);
      if (complete !== null) {
        return complete;
      }
    }
    return this.#prepareView(view);
  }

  #reserveDispatch(
    view: DurableWorkflowControlView,
    worktree: ResolvedActiveOwnedWorktree,
    gates: Readonly<{
      budget: AggregateSubtaskUsageBudget;
      references: readonly string[];
    }>,
  ): GovernedDispatchReceipt {
    return this.#storage.runInTransaction(() => {
      const current = this.#requiredWorkflowView(view.subtaskId);
      const existing = this.#getDispatchReceiptForSubtask(current.subtaskId);
      if (existing !== null) {
        return existing;
      }
      if (
        current.currentStage !== "EXECUTE" ||
        current.boardStatus !== "TODO" ||
        current.transitionCount !== view.transitionCount ||
        current.unresolvedHumanRequired !== null
      ) {
        throw conflict("The governed dispatch reservation is stale.");
      }
      const refreshedWorktree = this.#worktrees.resolveActiveOwnedWorktreeForSubtask(
        current.subtaskId,
      );
      if (refreshedWorktree.ownership.id !== worktree.ownership.id) {
        throw conflict("The governed worktree authority changed.");
      }
      const refreshed = this.#deriveDispatchGates(current, refreshedWorktree);
      if (
        refreshed.references.length !== gates.references.length ||
        refreshed.references.some(
          (reference, index) => reference !== gates.references[index],
        )
      ) {
        throw conflict("The governed dispatch gates changed before reservation.");
      }
      if (!refreshed.budget.allowed) {
        throw this.#budgetBlock(current.subtaskId, refreshed.budget);
      }
      const subtask = this.#storage.getSubtaskById(current.subtaskId);
      if (subtask === null) {
        throw malformed();
      }
      const manual =
        subtask.startPolicy === "MANUAL" ? this.#getManualStart(current.subtaskId) : null;
      if (subtask.startPolicy === "MANUAL" && manual === null) {
        throw conflict("Manual governed start authority is required.");
      }
      const transition = validateSubtaskTransition("TODO", "IN_PROGRESS", {
        dependenciesReady: true,
        repositoryPreflightPassed: true,
        contextPreflightPassed: true,
        concurrencyAvailable: true,
      });
      if (!transition.allowed) {
        throw conflict("The governed Subtask start transition is not allowed.");
      }
      const access = this.#access();
      const activeWrite = access.sqlite
        .prepare(
          `SELECT receipt_id
             FROM governed_dispatch_receipts
            WHERE project_id = ? AND write_enabled = 1
              AND status IN ('RESERVED', 'ACTIVE')
            LIMIT 1`,
        )
        .get(current.projectId) as { readonly receipt_id: string } | undefined;
      if (current.writeEnabled && activeWrite !== undefined) {
        throw new GovernedPreparationBlock(
          freeze({
            kind: "BLOCKED",
            reason: "CONCURRENCY_BLOCKED",
            subtaskId: current.subtaskId,
          }),
        );
      }
      const sequence = current.transitionCount + 1;
      const operationId = stableId("gdo", current.subtaskId, sequence);
      const receiptId = stableId("gdr", operationId);
      const reservedAt = this.#timestampAtOrAfter(
        current.transitions.at(-1)?.occurredAt ?? current.initializedAt,
      );
      access.sqlite
        .prepare(
          `INSERT INTO governed_dispatch_receipts (
             receipt_id, operation_id, project_id, big_task_id, plan_revision,
             candidate_binding, subtask_id, workflow_sequence, profile,
             write_enabled, start_policy, manual_start_authority_id,
             worktree_ownership_id, gate_evidence_references, status,
             reserved_at, updated_at, terminal_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'RESERVED', ?, ?, NULL)`,
        )
        .run(
          receiptId,
          operationId,
          current.projectId,
          current.bigTaskId,
          current.planRevision,
          current.candidateBinding,
          current.subtaskId,
          sequence,
          current.profile,
          current.writeEnabled ? 1 : 0,
          subtask.startPolicy,
          manual?.authorityId ?? null,
          refreshedWorktree.ownership.id,
          JSON.stringify([...refreshed.references].sort()),
          reservedAt,
          reservedAt,
        );
      const receipt = this.#getDispatchReceiptForSubtask(current.subtaskId);
      if (receipt === null || receipt.receiptId !== receiptId) {
        throw new TaskStorageError(
          "STORAGE_OPERATION_FAILED",
          "The governed dispatch receipt was not persisted.",
        );
      }
      const started = this.#storage.getSubtaskById(current.subtaskId);
      if (started?.status !== "IN_PROGRESS") {
        throw new TaskStorageError(
          "STORAGE_OPERATION_FAILED",
          "The governed dispatch did not own the Subtask start transition.",
        );
      }
      return receipt;
    });
  }

  #authorizeCurrentRole(
    view: DurableWorkflowControlView,
    receipt: GovernedDispatchReceipt,
  ): GovernedRoleAuthorization {
    return this.#storage.runInTransaction(() => {
      const current = this.#requiredWorkflowView(view.subtaskId);
      const role = roleForStage(current.currentStage);
      if (
        role === null ||
        (role === "EXECUTE" &&
          current.transitionCount + 1 !== receipt.workflowSequence) ||
        receipt.projectId !== current.projectId ||
        receipt.bigTaskId !== current.bigTaskId ||
        receipt.candidateBinding !== current.candidateBinding ||
        receipt.subtaskId !== current.subtaskId ||
        current.unresolvedHumanRequired !== null
      ) {
        throw conflict("The governed role authorization is stale.");
      }
      const sequence = current.transitionCount + 1;
      const existing = this.#getRoleAuthorizationForSequence(
        current.subtaskId,
        sequence,
      );
      if (existing !== null) {
        return existing;
      }
      const active = this.#access().sqlite
        .prepare(
          `SELECT er.id
             FROM execution_runs er
             JOIN chat_threads ct ON ct.id = er.chat_thread_id
            WHERE ct.subtask_id = ? AND er.status IN ('CREATED', 'RUNNING')
            LIMIT 1`,
        )
        .get(current.subtaskId) as { readonly id: string } | undefined;
      if (active !== undefined) {
        throw conflict("The Subtask already has an active primary execution.");
      }
      const budget = this.#deriveAggregateBudget(current.subtaskId, true);
      if (!budget.allowed) {
        throw this.#budgetBlock(current.subtaskId, budget);
      }
      const worktree = this.#worktrees.resolveActiveOwnedWorktreeForSubtask(
        current.subtaskId,
      );
      if (
        worktree.ownership.id !== receipt.worktreeOwnershipId ||
        !candidateIsClean(worktree.ownership.worktreePath)
      ) {
        throw conflict("The exact candidate worktree is unavailable or dirty.");
      }
      if (role === "REPAIR" || role === "FOCUSED_RE_QA") {
        this.#requiredBlockingFinding(current.subtaskId);
      }
      const authorizationId = stableId(
        "gra",
        current.projectId,
        current.bigTaskId,
        current.planRevision,
        current.candidateBinding,
        current.subtaskId,
        sequence,
        current.repairCyclesUsed,
        role,
      );
      const authorizedAt = this.#timestampAtOrAfter(
        current.transitions.at(-1)?.occurredAt ?? current.initializedAt,
      );
      const writeEnabled = roleWrites(role, current.writeEnabled);
      const access = this.#access();
      access.sqlite
        .prepare(
          `INSERT INTO governed_role_authorizations (
             authorization_id, dispatch_receipt_id, project_id, big_task_id,
             plan_revision, candidate_binding, subtask_id, workflow_sequence,
             workflow_stage, repair_cycles_used, role, context_profile,
             write_enabled, worktree_ownership_id, candidate_sha, authorized_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          authorizationId,
          receipt.receiptId,
          current.projectId,
          current.bigTaskId,
          current.planRevision,
          current.candidateBinding,
          current.subtaskId,
          sequence,
          current.currentStage,
          current.repairCyclesUsed,
          role,
          contextProfileForRole(role),
          writeEnabled ? 1 : 0,
          receipt.worktreeOwnershipId,
          worktree.currentHeadSha,
          authorizedAt,
        );
      if (receipt.status === "RESERVED") {
        access.sqlite
          .prepare(
            `UPDATE governed_dispatch_receipts
                SET status = 'ACTIVE', updated_at = ?
              WHERE receipt_id = ? AND status = 'RESERVED'`,
          )
          .run(authorizedAt, receipt.receiptId);
      }
      const row = access.sqlite
        .prepare("SELECT * FROM governed_role_authorizations WHERE authorization_id = ?")
        .get(authorizationId) as RoleAuthorizationRow | undefined;
      if (row === undefined) {
        throw new TaskStorageError(
          "STORAGE_OPERATION_FAILED",
          "The governed role authorization was not persisted.",
        );
      }
      const authorization = parseRoleAuthorizationRow(row);
      const preflight = this.#compileRoleInput(authorization);
      if (!preflight.allowed) {
        throw new GovernedPreparationBlock(
          freeze({
            kind: "BLOCKED",
            reason: "CONTEXT_PREFLIGHT_BLOCKED",
            subtaskId: current.subtaskId,
          }),
        );
      }
      return authorization;
    });
  }

  #reconcilePersistedRoleResult(
    authorization: GovernedRoleAuthorization,
    result: GovernedRoleResult,
  ): GovernedRoleReconciliationResult {
    let view = this.#requiredWorkflowView(authorization.subtaskId);
    if (
      view.currentStage !== authorization.workflowStage ||
      view.transitionCount + 1 !== authorization.workflowSequence
    ) {
      const priorTransition = view.transitions[authorization.workflowSequence - 1];
      if (priorTransition === undefined) {
        throw malformed();
      }
      return freeze({
        kind: "TRANSITION_RECORDED",
        result,
        currentStage: view.currentStage,
      });
    }
    if (result.outcome === "BLOCKED" || result.outcome === "BLOCKING_FAIL" &&
      result.role !== "FRESH_QA" && result.role !== "FOCUSED_RE_QA") {
      return freeze({
        kind: "ROLE_RESULT_BLOCKED",
        result,
        currentStage: view.currentStage,
      });
    }

    const references: Array<{
      sourceType: "WORKFLOW_EVIDENCE" | "IMPLEMENTATION_CHECKPOINT";
      sourceReference: string;
    }> = [];
    let nextStage: WorkflowStage;
    if (authorization.role === "EXECUTE") {
      if (result.outcome !== "READY") {
        return freeze({
          kind: "ROLE_RESULT_BLOCKED",
          result,
          currentStage: view.currentStage,
        });
      }
      const checkpointId = SubtaskImplementationCheckpointIdSchema.parse(
        stableId("icp", result.resultId),
      );
      const checkpoint = this.#storage.getSubtaskImplementationCheckpointById(
        checkpointId,
      );
      if (checkpoint === null) {
        this.#storage.completeSubtaskImplementation({
          subtaskId: authorization.subtaskId,
          checkpoint: {
            id: checkpointId,
            subtaskId: authorization.subtaskId,
            repositoryCommitSha: result.candidateSha,
            actorType: "CODEX",
            actorReference: authorization.authorizationId,
            sourceReference: result.resultId,
            summary: result.summary,
            occurredAt: result.occurredAt,
          },
        });
      } else if (
        checkpoint.subtaskId !== authorization.subtaskId ||
        checkpoint.repositoryCommitSha !== result.candidateSha ||
        checkpoint.sourceReference !== result.resultId
      ) {
        throw malformed();
      }
      references.push({
        sourceType: "IMPLEMENTATION_CHECKPOINT",
        sourceReference: checkpointId,
      });
      nextStage = view.profile === "HIGH_RISK_FOUNDATION" ? "HARDEN" : "VERIFY";
    } else if (authorization.role === "VERIFY") {
      if (result.outcome !== "PASS") {
        return freeze({
          kind: "ROLE_RESULT_BLOCKED",
          result,
          currentStage: view.currentStage,
        });
      }
      references.push(
        ...this.#recordCompletionEvidence(view, result, "VERIFICATION_ROLE"),
      );
      nextStage = "COMPLETE";
    } else if (authorization.role === "HARDEN") {
      if (result.outcome !== "PASS") {
        return freeze({
          kind: "ROLE_RESULT_BLOCKED",
          result,
          currentStage: view.currentStage,
        });
      }
      references.push({
        sourceType: "WORKFLOW_EVIDENCE",
        sourceReference: this.#recordEvidence(
          view,
          "HARDENING_ROLE",
          "PASS",
          result.resultId,
          result.occurredAt,
        ).evidenceId,
      });
      nextStage = "FRESH_QA";
    } else if (authorization.role === "FRESH_QA") {
      references.push({
        sourceType: "WORKFLOW_EVIDENCE",
        sourceReference: this.#recordEvidence(
          view,
          "FRESH_INDEPENDENT_QA",
          result.outcome === "PASS" ? "PASS" : "BLOCKING_FAIL",
          result.resultId,
          result.occurredAt,
        ).evidenceId,
      });
      if (result.outcome === "PASS") {
        references.push(...this.#recordDeliveryEvidence(view, result));
        nextStage = "COMPLETE";
      } else {
        nextStage = "REPAIR";
      }
    } else if (authorization.role === "REPAIR") {
      if (result.outcome !== "READY") {
        return freeze({
          kind: "ROLE_RESULT_BLOCKED",
          result,
          currentStage: view.currentStage,
        });
      }
      references.push({
        sourceType: "WORKFLOW_EVIDENCE",
        sourceReference: this.#recordEvidence(
          view,
          "REPAIR_ROLE",
          "PASS",
          result.resultId,
          result.occurredAt,
        ).evidenceId,
      });
      nextStage = "FOCUSED_RE_QA";
    } else {
      references.push({
        sourceType: "WORKFLOW_EVIDENCE",
        sourceReference: this.#recordEvidence(
          view,
          "FOCUSED_RE_QA",
          result.outcome === "PASS" ? "PASS" : "BLOCKING_FAIL",
          result.resultId,
          result.occurredAt,
        ).evidenceId,
      });
      if (result.outcome === "PASS") {
        this.#resolveBlockingFinding(authorization.subtaskId, result);
        references.push(...this.#recordDeliveryEvidence(view, result));
      }
      nextStage = "COMPLETE";
    }

    const transition = this.#storage.advanceDurableWorkflow({
      operationId: stableId(
        "wop",
        authorization.authorizationId,
        nextStage,
      ),
      projectId: view.projectId as never,
      bigTaskId: view.bigTaskId as never,
      candidateBinding: view.candidateBinding,
      subtaskId: view.subtaskId,
      requestedNextStage: nextStage,
      evidenceReferences: references as never,
    });
    if (transition.kind === "BLOCKED") {
      return freeze({
        kind: "ROLE_RESULT_BLOCKED",
        result,
        currentStage: transition.view.currentStage,
      });
    }
    view = transition.view;
    if (transition.kind === "HUMAN_REQUIRED") {
      this.#terminalizeDispatch(authorization.dispatchReceiptId, "HUMAN_REQUIRED");
      return freeze({
        kind: "HUMAN_REQUIRED",
        result,
        currentStage: view.currentStage,
      });
    }
    if (view.currentStage === "COMPLETE") {
      this.#terminalizeDispatch(authorization.dispatchReceiptId, "COMPLETED");
    }
    return freeze({
      kind: "TRANSITION_RECORDED",
      result,
      currentStage: view.currentStage,
    });
  }

  #recordCompletionEvidence(
    view: DurableWorkflowControlView,
    result: GovernedRoleResult,
    roleSource: "VERIFICATION_ROLE",
  ): readonly {
    sourceType: "WORKFLOW_EVIDENCE";
    sourceReference: string;
  }[] {
    const role = this.#recordEvidence(
      view,
      roleSource,
      "PASS",
      result.resultId,
      result.occurredAt,
    );
    return [
      {
        sourceType: "WORKFLOW_EVIDENCE" as const,
        sourceReference: role.evidenceId,
      },
      ...this.#recordDeliveryEvidence(view, result),
    ];
  }

  #recordDeliveryEvidence(
    view: DurableWorkflowControlView,
    result: GovernedRoleResult,
  ): readonly {
    sourceType: "WORKFLOW_EVIDENCE";
    sourceReference: string;
  }[] {
    const access = this.#access();
    const unresolved = access.sqlite
      .prepare(
        `SELECT count(*) AS count
           FROM governed_findings f
           LEFT JOIN governed_finding_resolutions r ON r.finding_id = f.finding_id
          WHERE f.subtask_id = ? AND f.blocking = 1 AND r.finding_id IS NULL`,
      )
      .get(view.subtaskId) as { readonly count: number };
    if (unresolved.count !== 0) {
      throw conflict("A blocking governed finding remains unresolved.");
    }
    const handoffId = stableId("gho", result.resultId);
    const existingHandoff = access.sqlite
      .prepare("SELECT * FROM governed_handoffs WHERE handoff_id = ?")
      .get(handoffId) as
      | {
          readonly handoff_id: string;
          readonly subtask_id: string;
          readonly role_result_id: string;
          readonly candidate_sha: string;
          readonly summary: string;
          readonly verification_disposition: string;
          readonly remaining_blocker_count: number;
          readonly scope_confirmation: string;
          readonly created_at: string;
        }
      | undefined;
    if (existingHandoff === undefined) {
      access.sqlite
        .prepare(
          `INSERT INTO governed_handoffs (
           handoff_id, subtask_id, role_result_id, candidate_sha, summary,
           verification_disposition, remaining_blocker_count,
           scope_confirmation, created_at
         ) VALUES (?, ?, ?, ?, ?, 'PASS', 0, 'TASK_CONTRACT_SCOPE_CONFIRMED', ?)`,
        )
        .run(
          handoffId,
          view.subtaskId,
          result.resultId,
          result.candidateSha,
          result.summary,
          result.occurredAt,
        );
    } else if (
      existingHandoff.subtask_id !== view.subtaskId ||
      existingHandoff.role_result_id !== result.resultId ||
      existingHandoff.candidate_sha !== result.candidateSha ||
      existingHandoff.summary !== result.summary ||
      existingHandoff.verification_disposition !== "PASS" ||
      existingHandoff.remaining_blocker_count !== 0 ||
      existingHandoff.scope_confirmation !== "TASK_CONTRACT_SCOPE_CONFIRMED" ||
      existingHandoff.created_at !== result.occurredAt
    ) {
      throw malformed();
    }
    const dispositionId = stableId("gpc", result.resultId);
    const existingDisposition = access.sqlite
      .prepare(
        "SELECT * FROM governed_promoted_context_dispositions WHERE disposition_id = ?",
      )
      .get(dispositionId) as
      | {
          readonly disposition_id: string;
          readonly subtask_id: string;
          readonly role_result_id: string;
          readonly decision: string;
          readonly created_at: string;
        }
      | undefined;
    if (existingDisposition === undefined) {
      access.sqlite
        .prepare(
          `INSERT INTO governed_promoted_context_dispositions (
           disposition_id, subtask_id, role_result_id, decision, created_at
         ) VALUES (?, ?, ?, 'NO_PROMOTION_CANDIDATE', ?)`,
        )
        .run(dispositionId, view.subtaskId, result.resultId, result.occurredAt);
    } else if (
      existingDisposition.subtask_id !== view.subtaskId ||
      existingDisposition.role_result_id !== result.resultId ||
      existingDisposition.decision !== "NO_PROMOTION_CANDIDATE" ||
      existingDisposition.created_at !== result.occurredAt
    ) {
      throw malformed();
    }
    const entries = [
      ["BLOCKING_FINDING_CONTROL", `findings:${result.resultId}`],
      ["HANDOFF_CONTROL", handoffId],
      ["PROMOTED_CONTEXT_DISPOSITION", dispositionId],
    ] as const;
    return entries.map(([sourceType, sourceReference]) => ({
      sourceType: "WORKFLOW_EVIDENCE" as const,
      sourceReference: this.#recordEvidence(
        view,
        sourceType,
        "PASS",
        sourceReference,
        result.occurredAt,
      ).evidenceId,
    }));
  }

  #recordEvidence(
    view: DurableWorkflowControlView,
    sourceType: DurableWorkflowEvidenceAuthoritySourceType,
    outcome: DurableWorkflowEvidenceOutcome,
    sourceReference: string,
    occurredAt: string,
  ): DurableWorkflowEvidence {
    const mapping = evidenceProducerForSource(sourceType);
    const sequence = view.transitionCount + 1;
    const authorityId = stableId(
      "wfa",
      view.subtaskId,
      sequence,
      mapping.kind,
      sourceReference,
    );
    const evidenceId = stableId("wfe", authorityId);
    const existing = this.#storage.getDurableWorkflowEvidence(evidenceId);
    if (existing !== null) {
      if (
        existing.subtaskId !== view.subtaskId ||
        existing.expectedSequence !== sequence ||
        existing.kind !== mapping.kind ||
        existing.outcome !== outcome ||
        existing.sourceReference !== sourceReference
      ) {
        throw malformed();
      }
      return existing;
    }
    const recordedAt = this.#timestampAtOrAfter(occurredAt);
    const access = this.#access();
    const values = [
      view.projectId,
      view.bigTaskId,
      view.planRevision,
      view.candidateBinding,
      view.subtaskId,
      sequence,
      view.currentStage,
      view.repairCyclesUsed,
      mapping.kind,
      outcome,
      mapping.producer,
      sourceReference,
      occurredAt,
    ] as const;
    access.sqlite
      .prepare(
        `INSERT INTO durable_workflow_evidence_authorities (
           authority_id, project_id, big_task_id, plan_revision,
           candidate_binding, subtask_id, expected_sequence, observed_stage,
           observed_repair_cycles_used, source_type, evidence_kind, outcome,
           producer, source_reference, occurred_at, recorded_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(authorityId, ...values.slice(0, 8), sourceType, ...values.slice(8), recordedAt);
    access.sqlite
      .prepare(
        `INSERT INTO durable_workflow_evidence (
           evidence_id, authority_id, project_id, big_task_id, plan_revision,
           candidate_binding, subtask_id, expected_sequence, observed_stage,
           observed_repair_cycles_used, evidence_kind, outcome, producer,
           source_reference, occurred_at, accepted_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(evidenceId, authorityId, ...values, recordedAt);
    const evidence = this.#storage.getDurableWorkflowEvidence(evidenceId);
    if (evidence === null) {
      throw new TaskStorageError(
        "STORAGE_OPERATION_FAILED",
        "Trusted workflow evidence was not persisted.",
      );
    }
    return evidence;
  }

  #recordDispatchGateEvidence(
    view: DurableWorkflowControlView,
    gates: Readonly<{
      budget: AggregateSubtaskUsageBudget;
      references: readonly string[];
    }>,
  ): readonly DurableWorkflowEvidence[] {
    const sourceTypes = [
      "REPOSITORY_PREFLIGHT",
      "CONTEXT_PREFLIGHT",
      "BUDGET_GATE",
      "CONCURRENCY_GATE",
      "WORKTREE_OWNERSHIP",
      "HUMAN_APPROVAL",
    ] as const;
    return Object.freeze(
      sourceTypes.map((sourceType, index) =>
        this.#recordEvidence(
          view,
          sourceType,
          "PASS",
          gates.references[index + 1]!,
          this.#timestampAtOrAfter(
            view.transitions.at(-1)?.occurredAt ?? view.initializedAt,
          ),
        ),
      ),
    );
  }

  #deriveDispatchGates(
    view: DurableWorkflowControlView,
    worktree: ResolvedActiveOwnedWorktree,
  ): Readonly<{
    budget: AggregateSubtaskUsageBudget;
    references: readonly string[];
  }> {
    const readiness = this.#storage.evaluateStoredSubtaskDependencyReadiness(
      view.subtaskId,
    );
    if (!readiness.valid) {
      throw malformed();
    }
    if (!readiness.ready) {
      throw new GovernedPreparationBlock(
        freeze({
          kind: "BLOCKED",
          reason: "DEPENDENCY_BLOCKED",
          subtaskId: view.subtaskId,
        }),
      );
    }
    if (
      worktree.ownership.subtaskId !== view.subtaskId ||
      worktree.ownership.projectId !== view.projectId ||
      worktree.ownership.status !== "ACTIVE" ||
      !candidateIsClean(worktree.ownership.worktreePath)
    ) {
      throw new GovernedPreparationBlock(
        freeze({
          kind: "BLOCKED",
          reason: "WORKTREE_BLOCKED",
          subtaskId: view.subtaskId,
        }),
      );
    }
    const authorizationId = stableId(
      "gra",
      view.projectId,
      view.bigTaskId,
      view.planRevision,
      view.candidateBinding,
      view.subtaskId,
      view.transitionCount + 1,
      view.repairCyclesUsed,
      "EXECUTE",
    );
    const syntheticAuthorization = freeze({
      authorizationId,
      dispatchReceiptId: stableId("gdr", stableId("gdo", view.subtaskId, view.transitionCount + 1)),
      projectId: view.projectId,
      bigTaskId: view.bigTaskId,
      planRevision: view.planRevision,
      candidateBinding: view.candidateBinding,
      subtaskId: view.subtaskId,
      workflowSequence: view.transitionCount + 1,
      workflowStage: "EXECUTE" as const,
      repairCyclesUsed: view.repairCyclesUsed,
      role: "EXECUTE" as const,
      contextProfile: "STANDARD_SUBTASK_EXECUTION" as const,
      writeEnabled: view.writeEnabled,
      worktreeOwnershipId: worktree.ownership.id,
      candidateSha: worktree.currentHeadSha,
      authorizedAt: view.transitions.at(-1)?.occurredAt ?? view.initializedAt,
    });
    let preflight;
    try {
      preflight = this.#compileRoleInput(syntheticAuthorization);
    } catch {
      throw new GovernedPreparationBlock(
        freeze({
          kind: "BLOCKED",
          reason: "REPOSITORY_PREFLIGHT_BLOCKED",
          subtaskId: view.subtaskId,
        }),
      );
    }
    if (!preflight.allowed) {
      throw new GovernedPreparationBlock(
        freeze({
          kind: "BLOCKED",
          reason: "CONTEXT_PREFLIGHT_BLOCKED",
          subtaskId: view.subtaskId,
        }),
      );
    }
    const budget = this.#deriveAggregateBudget(view.subtaskId, true);
    const access = this.#access();
    const activeWrite = access.sqlite
      .prepare(
        `SELECT count(*) AS count
           FROM governed_dispatch_receipts
          WHERE project_id = ? AND write_enabled = 1
            AND status IN ('RESERVED', 'ACTIVE')`,
      )
      .get(view.projectId) as { readonly count: number };
    const activeCoding = access.sqlite
      .prepare(
        `SELECT count(*) AS count
           FROM governed_dispatch_receipts
          WHERE project_id = ? AND status IN ('RESERVED', 'ACTIVE')`,
      )
      .get(view.projectId) as { readonly count: number };
    if (activeCoding.count >= 2 || (view.writeEnabled && activeWrite.count !== 0)) {
      throw new GovernedPreparationBlock(
        freeze({
          kind: "BLOCKED",
          reason: "CONCURRENCY_BLOCKED",
          subtaskId: view.subtaskId,
        }),
      );
    }
    const extension = this.#getBudgetExtension(view.subtaskId);
    const contextHash = createHash("sha256")
      .update(preflight.allowed ? preflight.text : "", "utf8")
      .digest("hex");
    return freeze({
      budget,
      references: Object.freeze([
        `dependency:${view.subtaskId}:${view.transitionCount + 1}`,
        `repository:${worktree.ownership.id}:${worktree.currentHeadSha}`,
        `context:${authorizationId}:${contextHash}:${preflight.utf8Bytes}`,
        `budget:${view.subtaskId}:${budget.totalTokens ?? "unknown"}:${budget.effectiveLimitTokens}:${extension?.authorityId ?? "none"}`,
        `concurrency:${view.projectId}:${activeCoding.count}:${activeWrite.count}`,
        `worktree:${worktree.ownership.id}:${worktree.currentHeadSha}`,
        `human-policy:${view.subtaskId}:routine-not-required`,
      ]),
    });
  }

  #deriveAggregateBudget(
    subtaskId: SubtaskId,
    includeExtension: boolean,
  ): AggregateSubtaskUsageBudget {
    const rows = this.#access().sqlite
      .prepare(
        `SELECT er.status, er.started_at, er.usage_present, er.total_tokens
           FROM execution_runs er
           JOIN chat_threads ct ON ct.id = er.chat_thread_id
          WHERE ct.subtask_id = ?`,
      )
      .all(subtaskId) as unknown as readonly {
        readonly status: string;
        readonly started_at: string | null;
        readonly usage_present: number;
        readonly total_tokens: number | null;
      }[];
    let total = 0;
    for (const row of rows) {
      if (
        (row.status === "RUNNING" || row.started_at !== null) &&
        (row.usage_present !== 1 ||
          row.total_tokens === null ||
          !Number.isSafeInteger(row.total_tokens) ||
          row.total_tokens < 0)
      ) {
        return freeze({
          status: "UNKNOWN_USAGE",
          allowed: false,
          totalTokens: null,
          warning: false,
          extensionApplied: false,
          effectiveLimitTokens: 120_000,
        });
      }
      if (row.usage_present === 1 && row.total_tokens !== null) {
        if (!Number.isSafeInteger(total + row.total_tokens)) {
          throw malformed();
        }
        total += row.total_tokens;
      }
    }
    const extension = includeExtension ? this.#getBudgetExtension(subtaskId) : null;
    const effectiveLimit = extension === null ? 120_000 : 160_000;
    const allowed = total < effectiveLimit;
    const status =
      total >= 160_000
        ? "ABSOLUTE_CEILING"
        : !allowed
          ? "HARD_PAUSE"
          : total >= DEFAULT_V1_BUDGET_POLICY.subtask.warningTokens
            ? "AVAILABLE_WARNING"
            : "AVAILABLE";
    return freeze({
      status,
      allowed,
      totalTokens: total,
      warning: total >= 80_000,
      extensionApplied: extension !== null,
      effectiveLimitTokens: effectiveLimit,
    });
  }

  #compileRoleInput(
    authorization: GovernedRoleAuthorization,
  ):
    | Readonly<{
        status: "WITHIN_TARGET" | "ABOVE_TARGET";
        allowed: true;
        utf8Bytes: number;
        normalTargetBytes: 40_000;
        absoluteCapBytes: 64_000;
        contextProfile: GovernedRoleContextProfile;
        text: string;
      }>
    | Readonly<{
        status: "HARD_CAP_EXCEEDED";
        allowed: false;
        utf8Bytes: number;
        normalTargetBytes: 40_000;
        absoluteCapBytes: 64_000;
        contextProfile: GovernedRoleContextProfile;
      }> {
    const baseProfile =
      authorization.contextProfile === "STANDARD_SUBTASK_EXECUTION"
        ? "STANDARD_SUBTASK_EXECUTION"
        : "FRESH_INDEPENDENT_QA";
    const base = new ExecutionInputPreflight(
      this.#storage,
    ).prepareExecutionInputForSubtask(authorization.subtaskId, baseProfile);
    const boundedFinding =
      authorization.role === "REPAIR" || authorization.role === "FOCUSED_RE_QA"
        ? this.#requiredBlockingFinding(authorization.subtaskId)
        : null;
    const payload = base.allowed
      ? JSON.stringify({
          schemaVersion: 1,
          authorizationId: authorization.authorizationId,
          role: authorization.role,
          contextProfile: authorization.contextProfile,
          writeEnabled: authorization.writeEnabled,
          instruction: roleInstruction(authorization.role),
          resultContract: roleResultContract(authorization.role),
          ...(boundedFinding === null
            ? {}
            : {
                boundedFinding: {
                  findingId: boundedFinding.finding_id,
                  violatedInvariant: boundedFinding.violated_invariant,
                  affectedContract: boundedFinding.affected_contract,
                  reproduction: boundedFinding.reproduction,
                  repairedSha: authorization.candidateSha,
                },
              }),
          canonicalContext: base.text,
        })
      : null;
    const text = payload === null ? null : ROLE_INPUT_MARKER + payload;
    const utf8Bytes =
      text === null ? base.utf8Bytes : Buffer.byteLength(text, "utf8");
    if (text === null || utf8Bytes > 64_000) {
      return freeze({
        status: "HARD_CAP_EXCEEDED",
        allowed: false,
        utf8Bytes,
        normalTargetBytes: 40_000,
        absoluteCapBytes: 64_000,
        contextProfile: authorization.contextProfile,
      });
    }
    return freeze({
      status: utf8Bytes <= 40_000 ? "WITHIN_TARGET" : "ABOVE_TARGET",
      allowed: true,
      utf8Bytes,
      normalTargetBytes: 40_000,
      absoluteCapBytes: 64_000,
      contextProfile: authorization.contextProfile,
      text,
    });
  }

  #ensureOwnedWorktree(subtaskId: SubtaskId): ResolvedActiveOwnedWorktree {
    try {
      return this.#worktrees.resolveActiveOwnedWorktreeForSubtask(subtaskId);
    } catch {
      const history = this.#worktrees.listWorktreeOwnershipHistoryForSubtask(
        subtaskId,
      );
      const latest = history.at(-1);
      try {
        if (latest?.status === "PROVISIONING" || latest?.status === "RELEASING") {
          this.#worktrees.reconcileWorktreeOwnershipForSubtask(subtaskId);
          return this.#worktrees.resolveActiveOwnedWorktreeForSubtask(subtaskId);
        }
        this.#worktrees.provisionOwnedWorktreeForSubtask(subtaskId);
        return this.#worktrees.resolveActiveOwnedWorktreeForSubtask(subtaskId);
      } catch {
        throw new GovernedPreparationBlock(
          freeze({
            kind: "BLOCKED",
            reason: "WORKTREE_BLOCKED",
            subtaskId,
          }),
        );
      }
    }
  }

  #recordRoleFindingRows(resultId: string): readonly FindingRow[] {
    return this.#access().sqlite
      .prepare(
        "SELECT * FROM governed_findings WHERE result_id = ? ORDER BY ordinal",
      )
      .all(resultId) as unknown as readonly FindingRow[];
  }

  #requiredBlockingFinding(subtaskId: SubtaskId): FindingRow {
    const rows = this.#access().sqlite
      .prepare(
        `SELECT f.*
           FROM governed_findings f
           JOIN governed_role_results rr ON rr.result_id = f.result_id
           LEFT JOIN governed_finding_resolutions r ON r.finding_id = f.finding_id
          WHERE f.subtask_id = ? AND f.blocking = 1 AND r.finding_id IS NULL
            AND rr.role = 'FRESH_QA'
          ORDER BY f.created_at, f.finding_id`,
      )
      .all(subtaskId) as unknown as readonly FindingRow[];
    if (rows.length !== 1) {
      throw conflict("The bounded QA repair target is unavailable or ambiguous.");
    }
    return rows[0]!;
  }

  #resolveBlockingFinding(
    subtaskId: SubtaskId,
    focusedResult: GovernedRoleResult,
  ): void {
    const finding = this.#requiredBlockingFinding(subtaskId);
    const access = this.#access();
    const existing = access.sqlite
      .prepare(
        "SELECT * FROM governed_finding_resolutions WHERE finding_id = ?",
      )
      .get(finding.finding_id) as
      | {
          readonly finding_id: string;
          readonly role_result_id: string;
          readonly resolved_at: string;
        }
      | undefined;
    if (existing !== undefined) {
      if (
        existing.role_result_id !== focusedResult.resultId ||
        existing.resolved_at !== focusedResult.occurredAt
      ) {
        throw malformed();
      }
      return;
    }
    access.sqlite
      .prepare(
        `INSERT INTO governed_finding_resolutions (
           finding_id, role_result_id, resolved_at
         ) VALUES (?, ?, ?)`,
      )
      .run(finding.finding_id, focusedResult.resultId, focusedResult.occurredAt);
  }

  #getRoleResult(authorizationId: string): GovernedRoleResult | null {
    const row = this.#access().sqlite
      .prepare("SELECT * FROM governed_role_results WHERE authorization_id = ?")
      .get(authorizationId) as RoleResultRow | undefined;
    if (row === undefined) {
      return null;
    }
    const result = parseRoleResultRow(row);
    const authorization = this.getRoleAuthorization(authorizationId);
    const run = this.#storage.getExecutionRunById(result.executionRunId);
    const link = this.#getRoleLink(authorizationId);
    const findings = this.#recordRoleFindingRows(result.resultId);
    const expectedFindingCount =
      result.outcome === "BLOCKING_FAIL" && result.role !== "FOCUSED_RE_QA"
        ? 1
        : 0;
    if (
      authorization === null ||
      authorization.role !== result.role ||
      run?.status !== "SUCCEEDED" ||
      link?.execution_run_id !== result.executionRunId ||
      !isCanonicalTimestamp(result.occurredAt) ||
      new Date(result.occurredAt).getTime() <
        new Date(authorization.authorizedAt).getTime() ||
      findings.length !== expectedFindingCount ||
      findings.some(
        (finding, index) =>
          finding.result_id !== result.resultId ||
          finding.subtask_id !== authorization.subtaskId ||
          finding.ordinal !== index ||
          finding.blocking !== 1,
      )
    ) {
      throw malformed();
    }
    return result;
  }

  #getDispatchReceiptForSubtask(
    subtaskId: SubtaskId,
  ): GovernedDispatchReceipt | null {
    const row = this.#access().sqlite
      .prepare("SELECT * FROM governed_dispatch_receipts WHERE subtask_id = ?")
      .get(subtaskId) as DispatchRow | undefined;
    if (row === undefined) {
      return null;
    }
    const receipt = parseDispatchRow(row);
    const view = this.#requiredWorkflowView(subtaskId);
    if (
      receipt.projectId !== view.projectId ||
      receipt.bigTaskId !== view.bigTaskId ||
      receipt.planRevision !== view.planRevision ||
      receipt.candidateBinding !== view.candidateBinding ||
      receipt.profile !== view.profile ||
      receipt.writeEnabled !== view.writeEnabled
    ) {
      throw malformed();
    }
    return receipt;
  }

  #getRoleAuthorizationForSequence(
    subtaskId: SubtaskId,
    sequence: number,
  ): GovernedRoleAuthorization | null {
    const row = this.#access().sqlite
      .prepare(
        `SELECT * FROM governed_role_authorizations
          WHERE subtask_id = ? AND workflow_sequence = ?`,
      )
      .get(subtaskId, sequence) as RoleAuthorizationRow | undefined;
    return row === undefined ? null : parseRoleAuthorizationRow(row);
  }

  #getRoleLink(authorizationId: string): RoleLinkRow | null {
    return (
      (this.#access().sqlite
        .prepare(
          "SELECT * FROM governed_role_execution_links WHERE authorization_id = ?",
        )
        .get(authorizationId) as RoleLinkRow | undefined) ?? null
    );
  }

  #requiredRoleLink(authorizationId: string): RoleLinkRow {
    const link = this.#getRoleLink(authorizationId);
    if (link === null) {
      throw conflict("The governed role execution link does not exist.");
    }
    return link;
  }

  #attemptFromLink(
    link: RoleLinkRow,
    authorization: GovernedRoleAuthorization,
  ): GovernedRoleExecutionAttempt {
    const threadId = ChatThreadIdSchema.safeParse(link.chat_thread_id);
    const runId = ExecutionRunIdSchema.safeParse(link.execution_run_id);
    if (
      link.authorization_id !== authorization.authorizationId ||
      !threadId.success ||
      threadId.data !== link.chat_thread_id ||
      !runId.success ||
      runId.data !== link.execution_run_id ||
      !isCanonicalTimestamp(link.linked_at) ||
      new Date(link.linked_at).getTime() <
        new Date(authorization.authorizedAt).getTime()
    ) {
      throw malformed();
    }
    return freeze({
      authorization,
      chatThreadId: threadId.data,
      executionRunId: runId.data,
    });
  }

  #assertRoleAuthorizationCurrent(
    authorization: GovernedRoleAuthorization,
  ): void {
    const view = this.#requiredWorkflowView(authorization.subtaskId);
    const receipt = this.#getDispatchReceiptForSubtask(authorization.subtaskId);
    if (receipt !== null) {
      this.#assertDispatchAuthority(receipt, view);
    }
    if (
      receipt === null ||
      receipt.receiptId !== authorization.dispatchReceiptId ||
      (receipt.status !== "RESERVED" && receipt.status !== "ACTIVE") ||
      view.currentStage !== authorization.workflowStage ||
      view.transitionCount + 1 !== authorization.workflowSequence ||
      view.repairCyclesUsed !== authorization.repairCyclesUsed ||
      authorization.projectId !== view.projectId ||
      authorization.bigTaskId !== view.bigTaskId ||
      authorization.planRevision !== view.planRevision ||
      authorization.candidateBinding !== view.candidateBinding ||
      authorization.role !== roleForStage(view.currentStage) ||
      authorization.contextProfile !== contextProfileForRole(authorization.role) ||
      authorization.writeEnabled !== roleWrites(authorization.role, view.writeEnabled) ||
      authorization.worktreeOwnershipId !== receipt.worktreeOwnershipId ||
      view.unresolvedHumanRequired !== null
    ) {
      throw conflict("The governed role authorization is stale.");
    }
  }

  #assertDispatchAuthority(
    receipt: GovernedDispatchReceipt,
    view: DurableWorkflowControlView,
  ): void {
    const subtask = this.#storage.getSubtaskById(view.subtaskId);
    const executeEntrySequence =
      view.initialStage === "EXECUTE"
        ? 1
        : (view.transitions.find(({ resultingStage }) => resultingStage === "EXECUTE")
            ?.sequence ?? -1) + 1;
    const manualRow =
      receipt.manualStartAuthorityId === null
        ? undefined
        : (this.#access().sqlite
            .prepare(
              "SELECT * FROM governed_manual_start_authorities WHERE authority_id = ?",
            )
            .get(receipt.manualStartAuthorityId) as ManualStartRow | undefined);
    if (
      subtask === null ||
      receipt.projectId !== view.projectId ||
      receipt.bigTaskId !== view.bigTaskId ||
      receipt.planRevision !== view.planRevision ||
      receipt.candidateBinding !== view.candidateBinding ||
      receipt.subtaskId !== view.subtaskId ||
      receipt.profile !== view.profile ||
      receipt.writeEnabled !== view.writeEnabled ||
      receipt.startPolicy !== subtask.startPolicy ||
      receipt.workflowSequence !== executeEntrySequence ||
      (receipt.startPolicy === "WHEN_READY" && manualRow !== undefined) ||
      (receipt.startPolicy === "MANUAL" &&
        (manualRow === undefined ||
          this.#manualStartFromRow(manualRow, view, false).workflowSequence !==
            receipt.workflowSequence))
    ) {
      throw malformed();
    }
  }

  #manualStartFromRow(
    row: ManualStartRow,
    view: DurableWorkflowControlView,
    requireCurrentSequence = true,
  ): GovernedManualStartAuthority {
    if (
      !/^gms_[0-9a-f]{48}$/u.test(row.authority_id) ||
      row.project_id !== view.projectId ||
      row.big_task_id !== view.bigTaskId ||
      row.plan_revision !== view.planRevision ||
      row.candidate_binding !== view.candidateBinding ||
      row.subtask_id !== view.subtaskId ||
      (requireCurrentSequence && row.workflow_sequence !== view.transitionCount + 1) ||
      row.workflow_sequence < 1 ||
      !isCanonicalTimestamp(row.authorized_at)
    ) {
      throw malformed();
    }
    return freeze({
      authorityId: row.authority_id,
      projectId: row.project_id,
      bigTaskId: row.big_task_id,
      planRevision: row.plan_revision,
      candidateBinding: row.candidate_binding,
      subtaskId: view.subtaskId,
      workflowSequence: row.workflow_sequence,
      authorizedAt: row.authorized_at,
    });
  }

  #budgetExtensionFromRow(
    row: BudgetExtensionRow,
    view: DurableWorkflowControlView,
  ): GovernedBudgetExtensionAuthority {
    if (
      !/^gbe_[0-9a-f]{48}$/u.test(row.authority_id) ||
      row.project_id !== view.projectId ||
      row.big_task_id !== view.bigTaskId ||
      row.plan_revision !== view.planRevision ||
      row.candidate_binding !== view.candidateBinding ||
      row.subtask_id !== view.subtaskId ||
      row.granted_tokens !== 40_000 ||
      !isCanonicalTimestamp(row.authorized_at)
    ) {
      throw malformed();
    }
    return freeze({
      authorityId: row.authority_id,
      projectId: row.project_id,
      bigTaskId: row.big_task_id,
      planRevision: row.plan_revision,
      candidateBinding: row.candidate_binding,
      subtaskId: view.subtaskId,
      grantedTokens: 40_000 as const,
      authorizedAt: row.authorized_at,
    });
  }

  #getManualStart(subtaskId: SubtaskId): GovernedManualStartAuthority | null {
    const row = this.#access().sqlite
      .prepare("SELECT * FROM governed_manual_start_authorities WHERE subtask_id = ?")
      .get(subtaskId) as ManualStartRow | undefined;
    return row === undefined
      ? null
      : this.#manualStartFromRow(row, this.#requiredWorkflowView(subtaskId));
  }

  #getBudgetExtension(
    subtaskId: SubtaskId,
  ): GovernedBudgetExtensionAuthority | null {
    const row = this.#access().sqlite
      .prepare("SELECT * FROM governed_budget_extensions WHERE subtask_id = ?")
      .get(subtaskId) as BudgetExtensionRow | undefined;
    return row === undefined
      ? null
      : this.#budgetExtensionFromRow(row, this.#requiredWorkflowView(subtaskId));
  }

  #reconcileDispatchStatuses(bigTaskId: BigTaskId): void {
    const rows = this.#access().sqlite
      .prepare(
        `SELECT * FROM governed_dispatch_receipts
          WHERE big_task_id = ? AND status IN ('RESERVED', 'ACTIVE')`,
      )
      .all(bigTaskId) as unknown as readonly DispatchRow[];
    for (const row of rows) {
      const receipt = parseDispatchRow(row);
      const view = this.#requiredWorkflowView(receipt.subtaskId);
      if (view.currentStage === "COMPLETE") {
        this.#terminalizeDispatch(receipt.receiptId, "COMPLETED");
      } else if (view.unresolvedHumanRequired !== null) {
        this.#terminalizeDispatch(receipt.receiptId, "HUMAN_REQUIRED");
      }
    }
  }

  #terminalizeDispatch(
    receiptId: string,
    status: "COMPLETED" | "HUMAN_REQUIRED",
  ): void {
    const access = this.#access();
    const row = access.sqlite
      .prepare("SELECT * FROM governed_dispatch_receipts WHERE receipt_id = ?")
      .get(receiptId) as DispatchRow | undefined;
    if (row === undefined) {
      throw malformed();
    }
    const receipt = parseDispatchRow(row);
    if (receipt.status === status) {
      return;
    }
    if (receipt.status !== "RESERVED" && receipt.status !== "ACTIVE") {
      throw malformed();
    }
    const terminalAt = this.#timestampAtOrAfter(receipt.updatedAt);
    access.sqlite
      .prepare(
        `UPDATE governed_dispatch_receipts
            SET status = ?, updated_at = ?, terminal_at = ?
          WHERE receipt_id = ? AND status IN ('RESERVED', 'ACTIVE')`,
      )
      .run(status, terminalAt, terminalAt, receiptId);
  }

  #tryCompleteBigTask(
    bigTaskId: BigTaskId,
  ): Extract<GovernedPreparationResult, { readonly kind: "BIG_TASK_COMPLETE" }> | null {
    const materialization = this.#storage.getCanonicalTaskMaterialization(bigTaskId);
    const bigTask = this.#storage.getBigTaskById(bigTaskId);
    if (materialization === null || bigTask === null) {
      return null;
    }
    const existing = this.#access().sqlite
      .prepare(
        "SELECT receipt_id, candidate_binding FROM governed_big_task_completion_receipts WHERE big_task_id = ?",
      )
      .get(bigTaskId) as
      | { readonly receipt_id: string; readonly candidate_binding: string }
      | undefined;
    if (existing !== undefined) {
      if (
        bigTask.status !== "DONE" ||
        existing.candidate_binding !== materialization.candidateBinding ||
        !/^gbc_[0-9a-f]{48}$/u.test(existing.receipt_id)
      ) {
        throw malformed();
      }
      return freeze({
        kind: "BIG_TASK_COMPLETE",
        bigTaskId,
        completionReceiptId: existing.receipt_id,
      });
    }
    if (bigTask.status === "DONE") {
      throw malformed();
    }
    const views = materialization.subtasks.map(({ subtaskId }) =>
      this.#requiredWorkflowView(subtaskId),
    );
    if (views.some(({ unresolvedHumanRequired }) => unresolvedHumanRequired !== null)) {
      return null;
    }
    const decision = evaluateBigTaskCompletion(
      {
        kind: "MATERIALIZED_GRAPH",
        projectId: materialization.projectId,
        bigTaskId: materialization.bigTaskId,
        planRevision: materialization.planRevision,
        candidateBinding: materialization.candidateBinding,
        subtasks: materialization.subtasks.map(
          ({ subtaskId, taskContractRef, profile, writeEnabled }) => ({
            id: subtaskId,
            bigTaskId: materialization.bigTaskId,
            taskContractRef,
            profile,
            writeEnabled,
          }),
        ),
        dependencies: materialization.dependencies,
      },
      {
        candidateBinding: materialization.candidateBinding,
        subtaskStates: views.map((view) => ({
          subtaskId: view.subtaskId,
          stage: view.currentStage,
          maturity: view.deliveryMaturity,
        })),
      },
    );
    if (decision.kind !== "BIG_TASK_COMPLETION_ELIGIBLE") {
      return null;
    }
    return this.#storage.runInTransaction(() => {
      const access = this.#access();
      const receiptId = stableId(
        "gbc",
        materialization.projectId,
        materialization.bigTaskId,
        materialization.planRevision,
        materialization.candidateBinding,
      );
      const completedAt = this.#timestampAtOrAfter(
        ...views.map(
          (view) => view.transitions.at(-1)?.occurredAt ?? view.initializedAt,
        ),
      );
      access.sqlite
        .prepare(
          `INSERT INTO governed_big_task_completion_receipts (
             receipt_id, project_id, big_task_id, plan_revision,
             candidate_binding, subtask_count, completed_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          receiptId,
          materialization.projectId,
          materialization.bigTaskId,
          materialization.planRevision,
          materialization.candidateBinding,
          materialization.subtaskCount,
          completedAt,
        );
      const done = this.#storage.getBigTaskById(bigTaskId);
      if (done?.status !== "DONE") {
        throw new TaskStorageError(
          "STORAGE_OPERATION_FAILED",
          "The governed Big Task completion was not persisted.",
        );
      }
      return freeze({
        kind: "BIG_TASK_COMPLETE" as const,
        bigTaskId,
        completionReceiptId: receiptId,
      });
    });
  }

  #requiredWorkflowView(subtaskId: SubtaskId): DurableWorkflowControlView {
    const view = this.#storage.getDurableWorkflowControlView(subtaskId);
    if (view === null) {
      throw new TaskStorageError(
        "PARENT_NOT_FOUND",
        "The durable governed workflow does not exist.",
      );
    }
    return view;
  }

  #canonicalSubtaskId(input: SubtaskId): SubtaskId {
    const parsed = SubtaskIdSchema.safeParse(input);
    if (!parsed.success || parsed.data !== input) {
      throw invalid("The governed Subtask ID is invalid.");
    }
    return parsed.data;
  }

  #budgetBlock(
    subtaskId: SubtaskId,
    budget: AggregateSubtaskUsageBudget,
  ): GovernedPreparationBlock {
    return new GovernedPreparationBlock(
      freeze(
        budget.status === "HARD_PAUSE" && !budget.extensionApplied
          ? {
              kind: "HUMAN_REQUIRED" as const,
              reason: "BUDGET_EXTENSION_REQUIRED" as const,
              subtaskId,
            }
          : {
              kind: "BLOCKED" as const,
              reason: "BUDGET_BLOCKED" as const,
              subtaskId,
            },
      ),
    );
  }

  #access() {
    const access = getTaskStorageWorktreeAccess(this.#storage);
    if (access === null || !access.isOpen()) {
      throw new TaskStorageError(
        "DATABASE_CLOSED",
        "The governed execution store is unavailable.",
      );
    }
    return access;
  }

  #timestampAtOrAfter(...previous: readonly string[]): string {
    const timestamp = this.#access().clock();
    if (!(timestamp instanceof Date) || Number.isNaN(timestamp.getTime())) {
      throw new TaskStorageError(
        "STORAGE_OPERATION_FAILED",
        "The governed execution clock is invalid.",
      );
    }
    const value = timestamp.toISOString();
    if (
      previous.some(
        (item) =>
          !isCanonicalTimestamp(item) ||
          new Date(value).getTime() < new Date(item).getTime(),
      )
    ) {
      throw new TaskStorageError(
        "STORAGE_OPERATION_FAILED",
        "The governed execution clock regressed.",
      );
    }
    return value;
  }
}

class GovernedPreparationBlock extends Error {
  readonly result: Extract<
    GovernedPreparationResult,
    { readonly kind: "BLOCKED" | "HUMAN_REQUIRED" }
  >;

  constructor(
    result: Extract<
      GovernedPreparationResult,
      { readonly kind: "BLOCKED" | "HUMAN_REQUIRED" }
    >,
  ) {
    super(result.reason);
    this.name = "GovernedPreparationBlock";
    this.result = result;
  }
}

export const createGovernedExecutionStore = (
  storage: TaskStorage,
  worktrees?: WorktreeOwnershipManager,
): GovernedExecutionStore => new GovernedExecutionStore(storage, worktrees);
