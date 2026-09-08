import type { PlanCandidate } from "@codex-task-console/orchestration";

/** New STANDARD tasks can reach ACCEPTED through independent QA; legacy graphs keep their original path. */
export function executionPlanIssues(candidate: PlanCandidate, reviewedStandard = false): readonly { code: "DEPENDENCY_PROFILE_CONFLICT"; subtaskId: string }[] {
  const affected = new Set<string>();
  for (const edge of candidate.dependencies) {
    if (edge.dependencyType !== "BLOCKING" || edge.requiredGate === "VERIFIED") continue;
    const upstream = candidate.subtasks.find(task => task.id === edge.upstreamSubtaskId);
    if (upstream !== undefined && upstream.profile !== "HIGH_RISK_FOUNDATION" && !(reviewedStandard && upstream.profile === "STANDARD")) affected.add(upstream.id);
  }
  return [...affected].sort().map(subtaskId => ({ code: "DEPENDENCY_PROFILE_CONFLICT", subtaskId }));
}
