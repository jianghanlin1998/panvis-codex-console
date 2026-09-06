import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { ProviderThreadReferenceSchema, ProviderRunReferenceSchema, ProviderModelReferenceSchema } from "@codex-task-console/domain";

import { makePlanningFixture } from "./live-planning-fixture.js";

type Fixture = ReturnType<typeof makePlanningFixture>;
const run = (f: Fixture, output: unknown, tokens: number | null = 100) => {
  const id = f.intake.bigTask.id;
  const claim = f.planning.claim(id);
  f.planning.observe(id, claim.sequence, {
    providerThread: ProviderThreadReferenceSchema.parse({ providerId: "codex-app-server", providerThreadId: `thread-${claim.sequence}` }),
    providerRun: ProviderRunReferenceSchema.parse({ providerId: "codex-app-server", providerThreadId: `thread-${claim.sequence}`, providerRunId: `turn-${claim.sequence}` }),
    model: ProviderModelReferenceSchema.parse({ providerId: "codex-app-server", providerModelId: "fixture" }),
    normalizedUsage: tokens === null ? null : { totalTokens: tokens },
  });
  return f.planning.finish(id, claim.sequence, true, typeof output === "string" ? output : JSON.stringify(output));
};
const review = (f: Fixture, outcome = "APPROVE") => {
  const bundle = f.storage.getDurablePlanningReviewBundle(f.intake.bigTask.id)!;
  return { outcome, candidateBinding: bundle.candidateBinding, planRevision: bundle.reviewState.candidate.revision,
    revisionRequirements: outcome === "REJECT" ? ["Add deterministic source failure tests."] : [],
    questions: outcome === "ESCALATE" ? ["Should the board support accounts?"] : [],
  };
};

describe("Big Task live planning ownership", () => {
  it("protects intake, exact compiled input and completed evidence from SQL mutation", () => {
    const f = makePlanningFixture();
    try {
      f.planning.accept(f.intake);
      const sql = new DatabaseSync(f.databasePath);
      try {
        expect(() => sql.prepare("UPDATE live_planning_intakes SET payload = '{}' ").run()).toThrow();
        expect(() => sql.prepare("DELETE FROM live_planning_intakes").run()).toThrow();
        const claim = f.planning.claim(f.intake.bigTask.id);
        expect(() => sql.prepare("UPDATE live_planning_runs SET payload = json_set(payload, '$.inputText', 'replacement')").run()).toThrow();
        f.planning.finish(f.intake.bigTask.id, claim.sequence, false, null);
        expect(() => sql.prepare("UPDATE live_planning_runs SET payload = json_set(payload, '$.status', 'RUNNING')").run()).toThrow();
        expect(() => sql.prepare("DELETE FROM live_planning_runs").run()).toThrow();
      } finally { sql.close(); }
    } finally { f.close(); }
  });

  it("rolls back a whole intake when its approved repository cannot be verified", () => {
    const f = makePlanningFixture();
    try {
      // A dirty file is observed honestly, while an unsafe canonical rule source must fail intake.
      f.git(["update-ref", "-d", "HEAD"]);
      expect(() => f.planning.accept(f.intake)).toThrow();
      expect(f.storage.getBigTaskById(f.intake.bigTask.id)).toBeNull();
    } finally { f.close(); }
  });

  it("keeps actual usage when the repository changes during a provider turn", () => {
    const f = makePlanningFixture();
    try {
      f.planning.accept(f.intake);
      const claim = f.planning.claim(f.intake.bigTask.id);
      f.planning.observe(f.intake.bigTask.id, claim.sequence, { providerThread: null, providerRun: null, model: null, normalizedUsage: { totalTokens: 321 } });
      writeFileSync(join(f.repository, "changed.txt"), "changed", "utf8");
      expect(f.planning.finish(f.intake.bigTask.id, claim.sequence, true, JSON.stringify(f.proposal)))
        .toMatchObject({ phase: "HUMAN_REQUIRED", stopReason: "CONTEXT_CHANGED", totalTokens: 321 });
      expect(f.storage.getDurablePlanningSnapshot(f.intake.bigTask.id)).toBeNull();
    } finally { f.close(); }
  });
  it("stores only approved intent at intake, then preserves a real proposal and separate approval across reopen", () => {
    const f = makePlanningFixture();
    try {
      expect(f.planning.accept(f.intake).nextRole).toBe("PLANNER");
      expect(f.storage.getDurablePlanningSnapshot(f.intake.bigTask.id)).toBeNull();
      expect(f.storage.listSubtasksByBigTask(f.intake.bigTask.id)).toEqual([]);
      expect(run(f, f.proposal).nextRole).toBe("REVIEWER");
      f.reopen();
      const state = run(f, review(f));
      expect(state).toMatchObject({ phase: "APPROVED", totalTokens: 200, usageComplete: true, automaticRevisionsUsed: 0 });
      expect(state.runs.map((item) => item.role)).toEqual(["PLANNER", "REVIEWER"]);
      expect(JSON.stringify(state)).not.toContain("inputText");
      expect(f.storage.listSubtasksByBigTask(f.intake.bigTask.id)).toEqual([]);
      expect(f.storage.getDurablePlanningSnapshot(f.intake.bigTask.id)?.materializedGraph).toBeNull();
      f.reopen();
      expect(f.planning.inspect(f.intake.bigTask.id)).toEqual(state);
      expect(() => f.planning.claim(f.intake.bigTask.id)).toThrow();
    } finally { f.close(); }
  });

  it("uses exactly two revision rounds, passes concrete requirements to Planner and excludes them from fresh Reviewer context", () => {
    const f = makePlanningFixture();
    try {
      f.planning.accept(f.intake);
      for (let revision = 1; revision <= 3; revision += 1) {
        run(f, f.proposal);
        const claim = f.planning.claim(f.intake.bigTask.id);
        expect(JSON.parse(claim.inputText)).not.toHaveProperty("revisionRequirements");
        f.planning.observe(f.intake.bigTask.id, claim.sequence, { providerThread: ProviderThreadReferenceSchema.parse({ providerId: "codex-app-server", providerThreadId: `thread-${claim.sequence}` }), providerRun: ProviderRunReferenceSchema.parse({ providerId: "codex-app-server", providerThreadId: `thread-${claim.sequence}`, providerRunId: `turn-${claim.sequence}` }), model: ProviderModelReferenceSchema.parse({ providerId: "codex-app-server", providerModelId: "fixture" }), normalizedUsage: { totalTokens: 20 } });
        f.planning.finish(f.intake.bigTask.id, claim.sequence, true, JSON.stringify(review(f, "REJECT")));
      }
      expect(f.planning.inspect(f.intake.bigTask.id)).toMatchObject({ phase: "HUMAN_REQUIRED", stopReason: "PLAN_REVIEW_EXHAUSTED", automaticRevisionsUsed: 2 });
      expect(() => f.planning.claim(f.intake.bigTask.id)).toThrow();
    } finally { f.close(); }
  });

  it.each([
    ["missing usage", null, "USAGE_UNKNOWN"],
    ["budget boundary", 120_000, "BUDGET_BLOCKED"],
  ] as const)("halts without creating a candidate for %s", (_name, tokens, reason) => {
    const f = makePlanningFixture();
    try {
      f.planning.accept(f.intake);
      expect(run(f, f.proposal, tokens)).toMatchObject({ phase: "HUMAN_REQUIRED", stopReason: reason });
      expect(f.storage.getDurablePlanningSnapshot(f.intake.bigTask.id)).toBeNull();
    } finally { f.close(); }
  });

  it.each(["unknown-field", "self-approval", "missing-dependency", "cycle", "duplicate-json-key"])("rejects %s without partial planning authority", (kind) => {
    const f = makePlanningFixture();
    try {
      f.planning.accept(f.intake);
      let output: unknown = structuredClone(f.proposal);
      if (kind === "unknown-field") output = { ...f.proposal, allowedWrites: true };
      if (kind === "self-approval") output = { ...f.proposal, outcome: "APPROVE" };
      if (kind === "missing-dependency") output = { ...f.proposal, dependencies: [{ ...f.proposal.dependencies[0], upstreamKey: "absent" }] };
      if (kind === "cycle") output = { ...f.proposal, dependencies: [...f.proposal.dependencies, { ...f.proposal.dependencies[0], upstreamKey: "board", downstreamKey: "collect" }] };
      if (kind === "duplicate-json-key") output = JSON.stringify(f.proposal).replace('"outcome":"PROPOSE"', '"outcome":"HUMAN_REQUIRED","outcome":"PROPOSE"');
      expect(run(f, output).stopReason).toBe("INVALID_OUTPUT");
      expect(f.storage.getDurablePlanningSnapshot(f.intake.bigTask.id)).toBeNull();
    } finally { f.close(); }
  });

  it("rejects intake without approval or with hand-filled tasks", () => {
    const f = makePlanningFixture();
    try {
      expect(() => f.planning.accept({ ...f.intake, approved: false })).toThrow();
      expect(() => f.planning.accept({ ...f.intake, subtasks: f.proposal.tasks })).toThrow();
      expect(f.storage.getBigTaskById(f.intake.bigTask.id)).toBeNull();
    } finally { f.close(); }
  });

  it("preserves product questions without inventing tasks", () => {
    const f = makePlanningFixture();
    try {
      f.planning.accept(f.intake);
      expect(run(f, { outcome: "HUMAN_REQUIRED", questions: ["Which sources are allowed?"], tasks: [], dependencies: [] }))
        .toMatchObject({ phase: "HUMAN_REQUIRED", stopReason: "PRODUCT_QUESTION", questions: ["Which sources are allowed?"] });
    } finally { f.close(); }
  });

  it("refuses a second claim and persists an uncertain interrupted turn without reissuing it", () => {
    const f = makePlanningFixture();
    try {
      f.planning.accept(f.intake);
      f.planning.claim(f.intake.bigTask.id);
      expect(() => f.planning.claim(f.intake.bigTask.id)).toThrow();
      f.reopen();
      expect(f.planning.inspect(f.intake.bigTask.id).phase).toBe("RUNNING");
      f.planning.recoverInterrupted();
      expect(f.planning.inspect(f.intake.bigTask.id)).toMatchObject({ phase: "HUMAN_REQUIRED", stopReason: "INTERRUPTED", usageComplete: false });
      expect(() => f.planning.claim(f.intake.bigTask.id)).toThrow();
    } finally { f.close(); }
  });

  it("refuses repository drift before another provider turn", () => {
    const f = makePlanningFixture();
    try {
      f.planning.accept(f.intake);
      writeFileSync(join(f.repository, "unexpected.txt"), "changed", "utf8");
      expect(f.planning.claim(f.intake.bigTask.id)).toMatchObject({ status: "HUMAN_REQUIRED", stopReason: "CONTEXT_CHANGED" });
    } finally { f.close(); }
  });

  it("rejects a stale Reviewer binding and keeps the reviewed candidate unchanged", () => {
    const f = makePlanningFixture();
    try {
      f.planning.accept(f.intake);
      run(f, f.proposal);
      const before = f.storage.getDurablePlanningSnapshot(f.intake.bigTask.id);
      expect(run(f, { ...review(f), candidateBinding: "wrong" }).stopReason).toBe("INVALID_OUTPUT");
      expect(f.storage.getDurablePlanningSnapshot(f.intake.bigTask.id)).toEqual(before);
    } finally { f.close(); }
  });
});
