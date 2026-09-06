import { existsSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { executeBigTaskPlanningCodexForTest } from "../src/live-execution.js";
import { makePlanningFixture } from "../../storage/test/live-planning-fixture.js";
import { planningProviderFixture } from "./planning-provider-fixture.js";

describe("real Big Task planning adapter with deterministic JSONL peer", () => {
  it("creates the candidate from provider output, invokes a fresh review and retains separate usage", async () => {
    const f = makePlanningFixture();
    try {
      f.planning.accept(f.intake);
      const provider = planningProviderFixture((packet) => packet.role === "PLANNER" ? f.proposal : {
        outcome: "APPROVE", planRevision: packet.proposal!.candidate.revision,
        candidateBinding: packet.proposal!.candidateBinding, revisionRequirements: [], questions: [],
      });
      const first = await executeBigTaskPlanningCodexForTest(f.storage, f.intake.bigTask.id, provider.dependencies);
      expect(first).toMatchObject({ phase: "READY", nextRole: "REVIEWER", totalTokens: 100 });
      const second = await executeBigTaskPlanningCodexForTest(f.storage, f.intake.bigTask.id, provider.dependencies);
      expect(second).toMatchObject({ phase: "APPROVED", totalTokens: 200 });
      expect(provider.packets.map((packet) => packet.role)).toEqual(["PLANNER", "REVIEWER"]);
      expect(provider.packets[0]?.proposal).toBeNull();
      expect(provider.packets[1]).not.toHaveProperty("revisionRequirements");
      expect(provider.launches).toHaveLength(2);
      expect(provider.workspaces.every((workspace) => !existsSync(workspace))).toBe(true);
      expect(new Set(provider.launches.map((launch) => launch.options.cwd)).size).toBe(2);
      for (const launch of provider.launches) {
        expect(launch.args).toContain("--strict-config");
        expect(launch.args).toContain('web_search="disabled"');
        expect(launch.options.shell).toBe(false);
      }
      for (const request of provider.requests.filter((request) => request.method === "turn/start")) {
        expect(request.params).toMatchObject({ approvalPolicy: "never", sandboxPolicy: { type: "readOnly", networkAccess: false } });
        expect(request.params.outputSchema).toMatchObject({ type: "object", additionalProperties: false });
      }
      expect(f.storage.listSubtasksByBigTask(f.intake.bigTask.id)).toEqual([]);
    } finally { f.close(); }
  });

  it.each([
    ["unknown usage", { omitUsage: true }, "USAGE_UNKNOWN"],
    ["budget exhaustion", { tokens: 120_000 }, "BUDGET_BLOCKED"],
    ["API key authentication", { apiKey: true }, "PROVIDER_FAILED"],
    ["tool attempt", { toolAttempt: true }, "PROVIDER_FAILED"],
  ] as const)("stops on %s and does not repeat the provider turn", async (_name, options, reason) => {
    const f = makePlanningFixture();
    try {
      f.planning.accept(f.intake);
      const provider = planningProviderFixture(() => f.proposal, options);
      const result = await executeBigTaskPlanningCodexForTest(f.storage, f.intake.bigTask.id, provider.dependencies);
      expect(result).toMatchObject({ phase: "HUMAN_REQUIRED", stopReason: reason });
      expect(f.storage.getDurablePlanningSnapshot(f.intake.bigTask.id)).toBeNull();
      await expect(executeBigTaskPlanningCodexForTest(f.storage, f.intake.bigTask.id, provider.dependencies)).rejects.toThrow();
      expect(provider.launches).toHaveLength(1);
      expect(provider.requests.filter((request) => request.method === "turn/start")).toHaveLength("apiKey" in options ? 0 : 1);
    } finally { f.close(); }
  });

  it("refuses a reused Planner thread before the Reviewer turn starts", async () => {
    const f = makePlanningFixture();
    try {
      f.planning.accept(f.intake);
      const provider = planningProviderFixture(() => f.proposal, { duplicateThread: true });
      await executeBigTaskPlanningCodexForTest(f.storage, f.intake.bigTask.id, provider.dependencies);
      const result = await executeBigTaskPlanningCodexForTest(f.storage, f.intake.bigTask.id, provider.dependencies);
      expect(result.phase).toBe("HUMAN_REQUIRED");
      expect(provider.requests.filter((request) => request.method === "turn/start")).toHaveLength(1);
    } finally { f.close(); }
  });
});
