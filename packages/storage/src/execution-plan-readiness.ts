import type { PlanCandidate } from "@codex-task-console/orchestration";

/** A completed STANDARD/LOW task remains IMPLEMENTED; only the full QA path reaches ACCEPTED. */
export function executionPlanIssues(candidate: PlanCandidate): readonly { code: "DEPENDENCY_PROFILE_CONFLICT"; subtaskId: string }[] {
  const affected = new Set<string>();
  for (const edge of candidate.dependencies) {
    if (edge.dependencyType !== "BLOCKING") continue;
    const upstream = candidate.subtasks.find(task => task.id === edge.upstreamSubtaskId);
    if (upstream !== undefined && upstream.profile !== "HIGH_RISK_FOUNDATION") affected.add(upstream.id);
  }
  return [...affected].sort().map(subtaskId => ({ code: "DEPENDENCY_PROFILE_CONFLICT", subtaskId }));
}
