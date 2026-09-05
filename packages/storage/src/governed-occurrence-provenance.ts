import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { AggregateSubtaskUsageBudget } from "./governed-execution.js";
import type { TaskStorage } from "./task-storage.js";
import { TaskStorageError } from "./errors.js";

function malformed(): never { throw new TaskStorageError("MALFORMED_STORED_DATA", "Stored governed execution authority is malformed."); }
export const provenanceId = (prefix: string, value: unknown): string =>
  `${prefix}_${createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex").slice(0, 48)}`;
export const inputHash = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
export const GATE_KINDS = ["dependency", "repository", "context", "budget", "concurrency", "worktree", "human-policy"] as const;
export type GateKind = typeof GATE_KINDS[number];
export interface GateOwner {
  readonly projectId: string;
  readonly bigTaskId: string;
  readonly planRevision: number;
  readonly candidateBinding: string;
  readonly subtaskId: string;
  readonly workflowSequence: number;
  readonly workflowStage: string;
  readonly occurrenceId: string;
  readonly worktreeOwnershipId: string;
  readonly candidateSha: string;
}
export interface GateValues {
  readonly dependency: { readonly readiness: ReturnType<TaskStorage["evaluateStoredSubtaskDependencyReadiness"]> };
  readonly repository: { readonly ownershipId: string; readonly candidateSha: string; readonly clean: true };
  readonly context: { readonly authorizationId: string; readonly text: string; readonly hash: string; readonly bytes: number };
  readonly budget: { readonly subtaskId: string; readonly budget: AggregateSubtaskUsageBudget; readonly extensionAuthorityId: string | null };
  readonly concurrency: { readonly projectId: string; readonly activeCoding: number; readonly activeWrite: number };
  readonly worktree: { readonly ownershipId: string; readonly candidateSha: string; readonly status: "ACTIVE" };
  readonly "human-policy": { readonly startPolicy: "MANUAL" | "WHEN_READY"; readonly manualStartAuthorityId: string | null };
}
export type GateObservation = { [K in GateKind]: { readonly owner: GateOwner; readonly kind: K; readonly value: GateValues[K] } }[GateKind];
export function recordGateObservations(sqlite: DatabaseSync, observations: readonly GateObservation[]): void {
  for (const observation of observations) {
    const reference = provenanceId("ggo", observation);
    const payload = JSON.stringify(observation);
    const existing = sqlite.prepare("SELECT payload FROM governed_gate_observations WHERE source_reference = ?").get(reference);
    if (existing !== undefined) {
      if (existing.payload !== payload) malformed();
    } else {
      sqlite.prepare("INSERT INTO governed_gate_observations (source_reference, subtask_id, workflow_sequence, gate_kind, payload) VALUES (?, ?, ?, ?, ?)")
        .run(reference, observation.owner.subtaskId, observation.owner.workflowSequence, observation.kind, payload);
    }
  }
}
export function readGateObservation(sqlite: DatabaseSync, reference: string): GateObservation {
  const row = sqlite.prepare("SELECT * FROM governed_gate_observations WHERE source_reference = ?").get(reference);
  if (row === undefined || typeof row.payload !== "string") malformed();
  try {
    const observation = JSON.parse(row.payload as string) as GateObservation;
    if (provenanceId("ggo", observation) !== reference || observation.owner.subtaskId !== row.subtask_id ||
        observation.owner.workflowSequence !== row.workflow_sequence || observation.kind !== row.gate_kind ||
        !GATE_KINDS.includes(observation.kind)) malformed();
    validateGateValue(sqlite, observation);
    return observation;
  } catch { return malformed(); }
}
export function assertGateOwner(observation: GateObservation, owner: GateOwner, kind: GateKind): void {
  if (observation.kind !== kind || JSON.stringify(observation.owner) !== JSON.stringify(owner)) malformed();
}

// The immutable observation owns the exact Console-compiled input, not another
// copy of its measurement. Both pre-turn and historical result checks measure
// this text and bind it to the same authorization and reserved execution.
export function readProviderInput(sqlite: DatabaseSync, authorizationId: string): { text: string; observationId: string } {
  const row = sqlite.prepare(`SELECT o.*, c.execution_run_id, c.candidate_sha, c.input_hash, c.input_bytes,
    c.target_finding_ids, c.claimed_at, a.dispatch_receipt_id, a.project_id, a.big_task_id, a.plan_revision,
    a.candidate_binding, a.subtask_id, a.workflow_sequence, a.workflow_stage, a.role, a.context_profile,
    a.write_enabled, a.authorized_at, a.repair_cycles_used, a.worktree_ownership_id, a.candidate_sha AS authorized_sha,
    l.execution_run_id AS linked_run, l.chat_thread_id
    FROM governed_provider_input_observations o
    JOIN governed_provider_claims c ON c.authorization_id = o.authorization_id
    JOIN governed_role_authorizations a ON a.authorization_id = o.authorization_id
    JOIN governed_role_execution_links l ON l.authorization_id = o.authorization_id
    WHERE o.authorization_id = ?`).get(authorizationId);
  if (row === undefined || typeof row.payload !== "string") malformed();
  try {
    const observation = JSON.parse(row.payload as string) as {
      authorization: Record<string, unknown>; executionRunId: string; chatThreadId: string;
      text: string; targetFindingIds: string[]; claimedAt: string;
    };
    const a = observation.authorization;
    const columns = { authorizationId: "authorization_id", dispatchReceiptId: "dispatch_receipt_id", projectId: "project_id",
      bigTaskId: "big_task_id", planRevision: "plan_revision", candidateBinding: "candidate_binding", subtaskId: "subtask_id",
      workflowSequence: "workflow_sequence", workflowStage: "workflow_stage", role: "role", contextProfile: "context_profile",
      worktreeOwnershipId: "worktree_ownership_id", candidateSha: "authorized_sha", authorizedAt: "authorized_at", repairCyclesUsed: "repair_cycles_used" };
    if (Object.entries(columns).some(([key, column]) => a[key] !== row[column]) || a.writeEnabled !== (row.write_enabled === 1) ||
        row.observation_id !== provenanceId("gpi", observation) || observation.executionRunId !== row.execution_run_id ||
        observation.executionRunId !== row.linked_run || observation.chatThreadId !== row.chat_thread_id ||
        row.candidate_sha !== row.authorized_sha || observation.claimedAt !== row.claimed_at ||
        JSON.stringify(observation.targetFindingIds) !== row.target_finding_ids || typeof observation.text !== "string" ||
        Buffer.byteLength(observation.text, "utf8") !== row.input_bytes || inputHash(observation.text) !== row.input_hash) malformed();
    const payload = JSON.parse(observation.text.split("\n").slice(1).join("\n")) as Record<string, unknown>;
    if (payload.authorizationId !== authorizationId || payload.candidateSha !== row.authorized_sha ||
        payload.worktreeOwnershipId !== row.worktree_ownership_id || payload.role !== row.role || payload.contextProfile !== row.context_profile ||
        payload.writeEnabled !== (row.write_enabled === 1)) malformed();
    return { text: observation.text, observationId: String(row.observation_id) };
  } catch { return malformed(); }
}
export function assertProviderTurnSource(sqlite: DatabaseSync, authorizationId: string): void {
  const input = readProviderInput(sqlite, authorizationId);
  const turn = sqlite.prepare(`SELECT s.*, ct.provider_thread_id AS actual_thread, c.claimed_at FROM governed_provider_turn_starts s
    JOIN governed_provider_claims c ON c.authorization_id = s.authorization_id
    JOIN governed_role_execution_links l ON l.authorization_id = s.authorization_id
    JOIN chat_threads ct ON ct.id = l.chat_thread_id WHERE s.authorization_id = ?`).get(authorizationId);
  if (turn === undefined || turn.observation_id !== input.observationId || turn.provider_thread_id !== turn.actual_thread ||
      typeof turn.validated_at !== "string" || !Number.isFinite(Date.parse(turn.validated_at)) ||
      new Date(turn.validated_at).toISOString() !== turn.validated_at || String(turn.validated_at) < String(turn.claimed_at)) malformed();
}
function validateGateValue(sqlite: DatabaseSync, observation: GateObservation): void {
  const {owner} = observation;
  const workflow = sqlite.prepare("SELECT * FROM subtask_workflow_instances WHERE subtask_id = ?").get(owner.subtaskId);
  const worktree = sqlite.prepare("SELECT project_id,subtask_id FROM worktree_ownerships WHERE id = ?").get(owner.worktreeOwnershipId);
  if (workflow === undefined || workflow.project_id !== owner.projectId || workflow.big_task_id !== owner.bigTaskId ||
      workflow.plan_revision !== owner.planRevision || workflow.candidate_binding !== owner.candidateBinding ||
      worktree?.project_id !== owner.projectId || worktree.subtask_id !== owner.subtaskId ||
      !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(owner.candidateSha)) malformed();
  switch (observation.kind) {
    case "dependency":
      if (!observation.value.readiness.valid || !observation.value.readiness.ready) malformed();
      break;
    case "context": {
      const value = observation.value;
      const authorizationId = provenanceId("gra", [owner.projectId, owner.bigTaskId, owner.planRevision,
        owner.candidateBinding, owner.subtaskId, owner.workflowSequence, 0, "EXECUTE"]);
      const text = JSON.parse(value.text.split("\n").slice(1).join("\n")) as Record<string, unknown>;
      if (value.authorizationId !== authorizationId || value.hash !== inputHash(value.text) || value.bytes !== Buffer.byteLength(value.text, "utf8") ||
          value.bytes < 1 || value.bytes > 64_000 || text.authorizationId !== authorizationId || text.role !== "EXECUTE" ||
          text.candidateSha !== owner.candidateSha || text.worktreeOwnershipId !== owner.worktreeOwnershipId) malformed();
      break;
    }
    case "budget": {
      const {budget, extensionAuthorityId, subtaskId} = observation.value;
      if (subtaskId !== owner.subtaskId || !budget.allowed || !Number.isSafeInteger(budget.totalTokens) || budget.totalTokens === null ||
          budget.totalTokens < 0 || budget.totalTokens >= budget.effectiveLimitTokens ||
          budget.effectiveLimitTokens !== (extensionAuthorityId === null ? 120_000 : 160_000) ||
          budget.extensionApplied !== (extensionAuthorityId !== null)) malformed();
      if (extensionAuthorityId !== null) {
        const extension = sqlite.prepare("SELECT * FROM governed_budget_extensions WHERE authority_id = ?").get(extensionAuthorityId);
        if (extension?.subtask_id !== owner.subtaskId || extension.project_id !== owner.projectId ||
            extension.big_task_id !== owner.bigTaskId || extension.plan_revision !== owner.planRevision ||
            extension.candidate_binding !== owner.candidateBinding) malformed();
      }
      break;
    }
    case "concurrency": {
      const value = observation.value;
      if (value.projectId !== owner.projectId || !Number.isSafeInteger(value.activeCoding) || value.activeCoding < 0 || value.activeCoding >= 2 ||
          !Number.isSafeInteger(value.activeWrite) || value.activeWrite < 0 || value.activeWrite > value.activeCoding) malformed();
      break;
    }
    case "repository":
    case "worktree":
      if (observation.value.ownershipId !== owner.worktreeOwnershipId || observation.value.candidateSha !== owner.candidateSha ||
          (observation.kind === "repository" ? observation.value.clean !== true : observation.value.status !== "ACTIVE")) malformed();
      break;
    case "human-policy": {
      const value = observation.value;
      const subtask = sqlite.prepare("SELECT start_policy FROM subtasks WHERE id = ?").get(owner.subtaskId);
      if (value.startPolicy !== subtask?.start_policy) malformed();
      if (value.startPolicy === "WHEN_READY") { if (value.manualStartAuthorityId !== null) malformed(); }
      else {
        const manual = sqlite.prepare("SELECT * FROM governed_manual_start_authorities WHERE authority_id = ?").get(value.manualStartAuthorityId);
        if (manual?.subtask_id !== owner.subtaskId || manual.project_id !== owner.projectId || manual.big_task_id !== owner.bigTaskId ||
            manual.plan_revision !== owner.planRevision || manual.candidate_binding !== owner.candidateBinding) malformed();
      }
    }
  }
}
