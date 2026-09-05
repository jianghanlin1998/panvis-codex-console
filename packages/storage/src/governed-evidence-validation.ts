import { GATE_KINDS, assertGateOwner, assertProviderTurnSource, inputHash, readGateObservation } from "./governed-occurrence-provenance.js";
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { DurableWorkflowEvidence } from "./workflow-control.js";
import { TaskStorageError } from "./errors.js";
import { assertGovernedSchemaIntegrity } from "./governed-schema-integrity.js";

function malformed(): never { throw new TaskStorageError("MALFORMED_STORED_DATA", "Stored governed execution authority is malformed."); }
export const governedStableId = (prefix: string, ...parts: readonly unknown[]): string =>
  `${prefix}_${createHash("sha256").update(JSON.stringify(parts), "utf8").digest("hex").slice(0, 48)}`;

export function assertGovernedEvidenceSource(sqlite: DatabaseSync, evidence: DurableWorkflowEvidence): void {
  // Accepted Step 8C fixture/legacy producers keep their existing contract.
  // All IDs issued by Step 8D are in this deterministic namespace, including
  // old equal-shaped 8D rows: missing new provenance is never backfilled.
  if (!/^wfa_[a-f0-9]{48}$/u.test(evidence.authorityId)) return;
  assertGovernedSchemaIntegrity(sqlite);
  const values = [evidence.projectId, evidence.bigTaskId, evidence.planRevision,
    evidence.candidateBinding, evidence.subtaskId, evidence.expectedSequence,
    evidence.observedStage, evidence.observedRepairCyclesUsed, evidence.kind,
    evidence.outcome, evidence.producer, evidence.sourceReference, evidence.occurredAt];
  if (evidence.authorityId !== governedStableId("wfa", evidence.subtaskId, evidence.expectedSequence, evidence.kind, evidence.sourceReference) ||
      evidence.evidenceId !== governedStableId("wfe", evidence.authorityId)) malformed();
  if (evidence.producer === "OPERATIONAL_GATE" || evidence.producer === "HUMAN_AUTHORITY") {
    const source = sqlite.prepare("SELECT * FROM governed_gate_sources WHERE authority_id = ?").get(evidence.authorityId);
    if (source?.source_type !== evidence.authoritySourceType || source.source_reference !== evidence.sourceReference ||
        source.payload !== JSON.stringify(values)) malformed();
    const observation = readGateObservation(sqlite, evidence.sourceReference);
    const o = observation.owner;
    const kinds = { REPOSITORY_PREFLIGHT: "repository", CONTEXT_PREFLIGHT: "context", BUDGET_GATE: "budget",
      CONCURRENCY_GATE: "concurrency", WORKTREE_OWNERSHIP: "worktree", HUMAN_APPROVAL: "human-policy" } as const;
    if (!(evidence.authoritySourceType in kinds) || observation.kind !== kinds[evidence.authoritySourceType as keyof typeof kinds] ||
        o.projectId !== evidence.projectId || o.bigTaskId !== evidence.bigTaskId || o.planRevision !== evidence.planRevision ||
        o.candidateBinding !== evidence.candidateBinding || o.subtaskId !== evidence.subtaskId ||
        o.workflowSequence !== evidence.expectedSequence || o.workflowStage !== evidence.observedStage ||
        o.occurrenceId !== governedStableId("gdr", governedStableId("gdo", evidence.subtaskId, evidence.expectedSequence))) malformed();
    return;
  }
  let resultId = evidence.sourceReference;
  if (evidence.authoritySourceType === "BLOCKING_FINDING_CONTROL") resultId = resultId.slice("findings:".length);
  if (evidence.authoritySourceType === "HANDOFF_CONTROL" || evidence.authoritySourceType === "PROMOTED_CONTEXT_DISPOSITION") {
    const handoff = evidence.authoritySourceType === "HANDOFF_CONTROL";
    const row = sqlite.prepare(handoff ? "SELECT * FROM governed_handoffs WHERE handoff_id = ?" :
      "SELECT * FROM governed_promoted_context_dispositions WHERE disposition_id = ?").get(evidence.sourceReference);
    if (row === undefined || row.subtask_id !== evidence.subtaskId) malformed();
    resultId = String(row.role_result_id);
  }
  const row = sqlite.prepare(`SELECT r.*, a.subtask_id, a.project_id, a.big_task_id, a.plan_revision,
    a.candidate_binding, a.workflow_sequence, a.repair_cycles_used, er.status AS run_status,
    er.provider_run_id AS actual_run_id, er.provider_model_id AS actual_model_id,
    ct.provider_thread_id AS actual_thread_id, er.usage_present, er.total_tokens,
    p.provider_thread_id, p.provider_run_id, p.provider_model_id, p.structured_result,
    p.candidate_sha AS proven_sha, p.recorded_at, p.normalized_usage,
    claim.execution_run_id AS claimed_run
    FROM governed_role_results r
    JOIN governed_role_authorizations a ON a.authorization_id = r.authorization_id
    JOIN governed_role_execution_links l ON l.authorization_id = a.authorization_id AND l.execution_run_id = r.execution_run_id
    JOIN execution_runs er ON er.id = l.execution_run_id AND er.chat_thread_id = l.chat_thread_id
    JOIN chat_threads ct ON ct.id = l.chat_thread_id AND ct.subtask_id = a.subtask_id
    JOIN governed_result_provenance p ON p.result_id = r.result_id AND p.authorization_id = a.authorization_id
    JOIN governed_provider_claims claim ON claim.authorization_id = a.authorization_id
    WHERE r.result_id = ?`).get(resultId);
  if (row === undefined || row.run_status !== "SUCCEEDED" || row.claimed_run !== row.execution_run_id ||
      row.subtask_id !== evidence.subtaskId || row.project_id !== evidence.projectId || row.big_task_id !== evidence.bigTaskId ||
      row.plan_revision !== evidence.planRevision || row.candidate_binding !== evidence.candidateBinding ||
      row.workflow_sequence !== evidence.expectedSequence || row.repair_cycles_used !== evidence.observedRepairCyclesUsed ||
      row.role !== evidence.observedStage || row.proven_sha !== row.candidate_sha || row.recorded_at !== row.occurred_at ||
      row.occurred_at !== evidence.occurredAt || row.usage_present !== 1 || row.total_tokens === null ||
      row.actual_thread_id !== row.provider_thread_id || row.actual_run_id !== row.provider_run_id ||
      row.actual_model_id !== row.provider_model_id) malformed();
  const resultAuthorization = sqlite.prepare("SELECT authorization_id FROM governed_role_results WHERE result_id = ?").get(resultId);
  assertProviderTurnSource(sqlite, String(resultAuthorization!.authorization_id));
  const expectedOutcome = row.role === "REPAIR" ? "READY" : evidence.outcome;
  if (row.outcome !== expectedOutcome) malformed();
  try {
    const source = JSON.parse(String(row.structured_result)) as {outcome: unknown; summary: unknown; findings: unknown[]};
    const usage = JSON.parse(String(row.normalized_usage)) as {totalTokens: unknown};
    if (source.outcome !== row.outcome || source.summary !== row.summary || usage.totalTokens !== row.total_tokens) malformed();
    const findings = sqlite.prepare("SELECT * FROM governed_findings WHERE result_id = ? ORDER BY ordinal").all(resultId);
    if (findings.length !== source.findings.length || findings.some((f, index) => {
      const expected = source.findings[index] as Record<string, unknown>;
      return f.subtask_id !== row.subtask_id || f.ordinal !== index || f.provider_finding_key !== expected.findingId ||
        f.blocking !== (expected.blocking ? 1 : 0) || f.violated_invariant !== expected.violatedInvariant ||
        f.affected_contract !== expected.affectedContract || f.reproduction !== expected.reproduction;
    })) malformed();
  } catch { malformed(); }
  if (evidence.authoritySourceType === "HANDOFF_CONTROL") {
    const handoff = sqlite.prepare("SELECT * FROM governed_handoffs WHERE handoff_id = ?").get(evidence.sourceReference)!;
    if (handoff.summary !== row.summary || handoff.candidate_sha !== row.candidate_sha || handoff.created_at !== row.occurred_at ||
        handoff.verification_disposition !== "PASS" || handoff.scope_confirmation !== "TASK_CONTRACT_SCOPE_CONFIRMED" ||
        handoff.remaining_blocker_count !== 0) malformed();
  }
  if (evidence.authoritySourceType === "PROMOTED_CONTEXT_DISPOSITION") {
    const disposition = sqlite.prepare("SELECT * FROM governed_promoted_context_dispositions WHERE disposition_id = ?").get(evidence.sourceReference)!;
    const candidate = sqlite.prepare(`SELECT 1 FROM governed_promotion_candidates pc JOIN governed_role_results rr ON rr.result_id = pc.result_id
      JOIN governed_role_authorizations a ON a.authorization_id = rr.authorization_id WHERE a.subtask_id = ? LIMIT 1`).get(evidence.subtaskId);
    if (disposition.created_at !== row.occurred_at || disposition.decision !== (candidate ? "CANDIDATE_RECORDED" : "NO_PROMOTION_CANDIDATE")) malformed();
  }
  if (evidence.authoritySourceType === "BLOCKING_FINDING_CONTROL" && sqlite.prepare(`SELECT 1 FROM governed_findings f
    LEFT JOIN governed_finding_resolutions r ON r.finding_id = f.finding_id
    WHERE f.subtask_id = ? AND f.blocking = 1 AND r.finding_id IS NULL LIMIT 1`).get(evidence.subtaskId)) malformed();
}

export function assertGovernedDispatchSource(sqlite: DatabaseSync, subtaskId: string): void {
  if (!sqlite.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'governed_dispatch_receipts'").get()) return;
  const row = sqlite.prepare("SELECT * FROM governed_dispatch_receipts WHERE subtask_id = ?").get(subtaskId);
  if (row === undefined) return;
  assertGovernedSchemaIntegrity(sqlite);
  const snapshot = sqlite.prepare("SELECT * FROM governed_dispatch_gate_snapshots WHERE receipt_id = ?").get(row.receipt_id!);
  if (snapshot === undefined || row.operation_id !== governedStableId("gdo", subtaskId, row.workflow_sequence) ||
      row.receipt_id !== governedStableId("gdr", row.operation_id) || snapshot.gate_references !== row.gate_evidence_references ||
      snapshot.recorded_at !== row.reserved_at) malformed();
  let refs: string[];
  try { refs = JSON.parse(String(snapshot.gate_references)); } catch { malformed(); }
  if (!Array.isArray(refs) || refs.length !== 7 || new Set(refs).size !== 7 ||
      JSON.stringify([...refs].sort()) !== snapshot.gate_references) malformed();
  const owner = {
    projectId: String(row.project_id), bigTaskId: String(row.big_task_id), planRevision: Number(row.plan_revision),
    candidateBinding: String(row.candidate_binding), subtaskId, workflowSequence: Number(row.workflow_sequence),
    workflowStage: "EXECUTE", occurrenceId: String(row.receipt_id), worktreeOwnershipId: String(row.worktree_ownership_id),
    candidateSha: String(snapshot.candidate_sha),
  };
  const observations = refs.map(reference => readGateObservation(sqlite, reference));
  for (const kind of GATE_KINDS) {
    const found = observations.filter(observation => observation.kind === kind);
    if (found.length !== 1) malformed();
    const observation = found[0]!;
    assertGateOwner(observation, owner, kind);
    const value = observation.value as unknown as Record<string, unknown>;
    if (kind === "context" && (typeof value.text !== "string" || value.hash !== inputHash(value.text) ||
        value.bytes !== Buffer.byteLength(value.text, "utf8") || value.authorizationId !== governedStableId("gra",
          owner.projectId, owner.bigTaskId, owner.planRevision, owner.candidateBinding, subtaskId, owner.workflowSequence, 0, "EXECUTE"))) malformed();
    if ((kind === "repository" || kind === "worktree") &&
        (value.ownershipId !== owner.worktreeOwnershipId || value.candidateSha !== owner.candidateSha)) malformed();
    if (kind === "concurrency" && (value.projectId !== owner.projectId || !Number.isSafeInteger(value.activeCoding) ||
        !Number.isSafeInteger(value.activeWrite) || Number(value.activeCoding) < 0 || Number(value.activeCoding) >= 2 ||
        Number(value.activeWrite) < 0 || Number(value.activeWrite) > 1 || (row.write_enabled === 1 && value.activeWrite !== 0))) malformed();
    if (kind === "budget" && (value.subtaskId !== subtaskId || typeof value.budget !== "object" || value.budget === null ||
        !(value.budget as {allowed?: boolean}).allowed)) malformed();
    if (kind === "human-policy" && (value.startPolicy !== row.start_policy || value.manualStartAuthorityId !== row.manual_start_authority_id)) malformed();
  }
  const resolutions = sqlite.prepare(`SELECT r.*, a.subtask_id AS resolving_subtask, rr.role, rr.outcome,
    rr.occurred_at, c.target_finding_ids FROM governed_finding_resolutions r
    JOIN governed_findings f ON f.finding_id = r.finding_id
    LEFT JOIN governed_role_results rr ON rr.result_id = r.role_result_id
    LEFT JOIN governed_role_authorizations a ON a.authorization_id = rr.authorization_id
    LEFT JOIN governed_provider_claims c ON c.authorization_id = a.authorization_id
    WHERE f.subtask_id = ?`).all(subtaskId);
  for (const resolution of resolutions) {
    if (resolution.resolving_subtask !== subtaskId || resolution.role !== "FOCUSED_RE_QA" || resolution.outcome !== "PASS" ||
        resolution.resolved_at !== resolution.occurred_at || typeof resolution.target_finding_ids !== "string") malformed();
    try {
      const targets: unknown = JSON.parse(resolution.target_finding_ids);
      if (!Array.isArray(targets) || !targets.includes(resolution.finding_id)) malformed();
    } catch { malformed(); }
  }
}

// A governed checkpoint is applied only inside reconciliation after the exact
// provider result and physical candidate have both been checked. Public storage
// callers cannot replay result-shaped data across a later candidate change.
const checkpointWriters = new WeakSet<object>();
export function withGovernedCheckpointWriter<T>(storage: object, apply: () => T): T {
  if (checkpointWriters.has(storage)) malformed();
  checkpointWriters.add(storage);
  try { return apply(); } finally { checkpointWriters.delete(storage); }
}
export function assertGovernedCheckpointWriter(storage: object): void {
  if (!checkpointWriters.has(storage)) {
    throw new TaskStorageError("CONFLICT", "Governed implementation requires exact provider result authority from its internal execution path.");
  }
}
