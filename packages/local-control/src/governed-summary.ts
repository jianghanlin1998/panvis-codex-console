import { createHash } from "node:crypto";
import type { GovernedExecutionStore } from "@codex-task-console/storage";

type Inspection = ReturnType<GovernedExecutionStore["inspectBigTask"]>;
const digest = (value: string | null): string | null => value === null ? null : createHash("sha256").update(value, "utf8").digest("hex");

/** Repeated canonical plan bindings and transition history do not belong in every status poll. */
export function summarizeGovernedStatus(status: Inspection) {
  return {
    format: "CTC_GOVERNED_STATUS_V1" as const,
    bigTaskId: status.bigTaskId,
    status: status.status,
    candidateDigest: digest(status.candidateBinding),
    workflows: status.workflows.map(w => ({
      subtaskId: w.subtaskId, profile: w.profile, currentStage: w.currentStage,
      repairCyclesUsed: w.repairCyclesUsed, boardStatus: w.boardStatus,
      deliveryMaturity: w.deliveryMaturity, transitionCount: w.transitionCount,
      blockedReason: w.unresolvedHumanRequired?.reason ?? null,
    })),
    budgets: status.budgets,
    dispatchReceipts: status.dispatchReceipts.map(r => ({ subtaskId: r.subtaskId,
      worktreeOwnershipId: r.worktreeOwnershipId, status: r.status, reservedAt: r.reservedAt, terminalAt: r.terminalAt })),
  };
}

/** Stable per-subtask sequence cursor; new activity cannot shift an older page. */
export function summarizeGovernedHistory(status: Inspection, subtaskId: string, afterSequence: number, limit: number) {
  const workflow = status.workflows.find(w => w.subtaskId === subtaskId);
  if (!workflow) return null;
  const rows = workflow.transitions.filter(t => t.sequence > afterSequence).slice(0, limit);
  return { format: "CTC_GOVERNED_HISTORY_V1" as const, bigTaskId: status.bigTaskId, subtaskId,
    candidateDigest: digest(status.candidateBinding), totalTransitions: workflow.transitionCount,
    transitions: rows.map(t => ({ sequence: t.sequence, operationId: t.operationId,
      priorStage: t.priorStage, resultingStage: t.resultingStage, repairCyclesUsed: t.resultingRepairCyclesUsed,
      occurredAt: t.occurredAt, evidenceCount: t.evidenceReferences.length })),
    nextAfterSequence: rows.length && rows.at(-1)!.sequence < workflow.transitionCount ? rows.at(-1)!.sequence : null };
}
