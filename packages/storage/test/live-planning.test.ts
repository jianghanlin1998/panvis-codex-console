import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
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
  return { outcome, candidateBinding: createHash("sha256").update(bundle.candidateBinding, "utf8").digest("hex"), planRevision: bundle.reviewState.candidate.revision,
    revisionRequirements: outcome === "REJECT" ? ["Add deterministic source failure tests."] : [],
    questions: outcome === "ESCALATE" ? ["Should the board support accounts?"] : [],
  };
};

describe("Big Task live planning ownership", () => {
  it("accepts a clean gitlink baseline but stops when its worktree contents change", () => {
    const f = makePlanningFixture();
    try {
      const nested = join(f.repository, "nested");
      mkdirSync(nested);
      f.git(["-C", nested, "init", "-b", "main"]);
      writeFileSync(join(nested, "source.txt"), "baseline", "utf8");
      f.git(["-C", nested, "add", "source.txt"]);
      f.git(["-C", nested, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "Nested baseline"]);
      f.git(["add", "nested"]);
      f.git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "Gitlink baseline"]);
      expect(f.planning.accept(f.intake).phase).toBe("READY");
      writeFileSync(join(nested, "source.txt"), "changed!", "utf8");
      expect(f.planning.claim(f.intake.bigTask.id)).toMatchObject({ status: "HUMAN_REQUIRED", stopReason: "CONTEXT_CHANGED", providerThread: null });
      expect(f.storage.getDurablePlanningSnapshot(f.intake.bigTask.id)).toBeNull();
    } finally { f.close(); }
  });

  it.each(["untracked", "tracked", "staged"])("rejects an unverifiable %s dirty intake atomically, including equal-count content changes", (kind) => {
    const f = makePlanningFixture();
    try {
      const file = join(f.repository, "existing.txt");
      writeFileSync(file, "baseline", "utf8");
      if (kind !== "untracked") {
        f.git(["add", "existing.txt"]);
        f.git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "Tracked baseline"]);
      }
      for (const content of ["approved content", "changed content!"]) {
        writeFileSync(file, content, "utf8");
        if (kind === "staged") f.git(["add", "existing.txt"]);
        expect(() => f.planning.accept(f.intake)).toThrow();
        expect(f.storage.getBigTaskById(f.intake.bigTask.id)).toBeNull();
        const sql = new DatabaseSync(f.databasePath);
        try {
          expect(sql.prepare("SELECT count(*) AS count FROM live_planning_intakes").get()!.count).toBe(0);
          expect(sql.prepare("SELECT count(*) AS count FROM live_planning_runs").get()!.count).toBe(0);
        } finally { sql.close(); }
      }
    } finally { f.close(); }
  });

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
      // Missing repository authority must roll back the enclosing intake.
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
      expect(run(f, { ...review(f), candidateBinding: "f".repeat(64) }).stopReason).toBe("INVALID_OUTPUT");
      expect(f.storage.getDurablePlanningSnapshot(f.intake.bigTask.id)).toEqual(before);
    } finally { f.close(); }
  });
});
