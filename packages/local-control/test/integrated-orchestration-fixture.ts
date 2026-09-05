import { execFileSync, spawn } from "node:child_process";
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { expect } from "vitest";
import { BigTaskIdSchema, ProjectIdSchema, ProjectSchema, SubtaskIdSchema, TaskContractV0Schema } from "@codex-task-console/domain";
import type { BigTaskId, SubtaskId } from "@codex-task-console/domain";
import { openTaskDatabase } from "@codex-task-console/storage";
import type { TaskStorage } from "../../storage/src/index.js";
import { createGovernedExecutionStoreForTest } from "../../storage/src/governed-execution-public.js";
import { createWorktreeOwnershipManagerForTesting } from "../../storage/src/worktree-ownership.js";
import { executeGovernedRoleCodexWithDependenciesForTest } from "../../codex-adapter/src/live-execution.js";
import { TESTED_CODEX_VERSION } from "../../codex-adapter/src/index.js";
import { validateOwnedWorktreeHardlinkSafety } from "../../codex-adapter/src/worktree-filesystem-safety.js";

const MOCK_PATH = fileURLToPath(new URL("../../../fixtures/mock-governed-app-server.ts", import.meta.url));
export const PROJECT_ID = ProjectIdSchema.parse("prj_integrated_turnover");
export const BIG_TASK_ID = BigTaskIdSchema.parse("bt_integrated_turnover");
export const SUBTASK_IDS = [1, 2, 3].map(index => SubtaskIdSchema.parse(`st_integrated_${index}`));
type SyntheticRole = "EXECUTE" | "VERIFY" | "HARDEN" | "FRESH_QA" | "REPAIR" | "FOCUSED_RE_QA";
export interface IntegratedOptions {
  profiles?: readonly ("LOW" | "STANDARD" | "HIGH_RISK_FOUNDATION")[];
  dependency?: boolean;
  manual?: boolean;
  planning?: boolean;
}

export const fixtureGit = (path: string, args: readonly string[]): string => execFileSync("git", ["-C", path, ...args], {
  encoding: "utf8",
  env: {
    PATH: process.env.PATH,
    GIT_AUTHOR_NAME: "Synthetic Orchestration",
    GIT_AUTHOR_EMAIL: "synthetic@example.invalid",
    GIT_COMMITTER_NAME: "Synthetic Orchestration",
    GIT_COMMITTER_EMAIL: "synthetic@example.invalid",
    GIT_AUTHOR_DATE: "2026-09-05T00:00:00Z",
    GIT_COMMITTER_DATE: "2026-09-05T00:00:00Z",
  },
  stdio: ["ignore", "pipe", "pipe"],
}).trim();

// Structured producer fixtures have proposal/decision authority only. All
// validation, bindings, materialization and progression run in production APIs.
export const planner = (revision: number, options: IntegratedOptions = {}) => ({
  candidate: {
    kind: "PLAN_CANDIDATE" as const, projectId: PROJECT_ID, bigTaskId: BIG_TASK_ID, revision,
    subtasks: SUBTASK_IDS.slice(0, options.profiles?.length ?? 3).map((id, index) => ({
      id, bigTaskId: BIG_TASK_ID, profile: options.profiles?.[index] ?? "STANDARD" as const,
      taskContractRef: `contract/${id}/v${revision}`, writeEnabled: true,
    })),
    dependencies: options.dependency ? [{ upstreamSubtaskId: SUBTASK_IDS[0]!, downstreamSubtaskId: SUBTASK_IDS[1]!,
      dependencyType: "BLOCKING" as const, requiredGate: "ACCEPTED" as const, reason: "Require the exact accepted upstream candidate." }] : [],
  },
  contracts: SUBTASK_IDS.slice(0, options.profiles?.length ?? 3).map(id => TaskContractV0Schema.parse({
    taskContractRef: `contract/${id}/v${revision}`, projectId: PROJECT_ID,
    bigTaskId: BIG_TASK_ID, subtaskId: id, title: `Synthetic component ${id}`,
    goal: "Commit and verify a bounded synthetic component.",
    scopeIn: ["Disposable candidate file"], scopeOut: ["Network", "Real targets"],
    acceptanceCriteria: revision === 1 ? ["Candidate exists."] : ["Candidate is committed and independently verified."],
    untouchedAreas: ["Source main"], promptSeed: `Current contract canary ${id} revision ${revision}. Produce the exact governed result.`,
    startPolicy: options.manual ? "MANUAL" : "WHEN_READY", delegationPolicy: "NONE", recommendedReasoningLevel: "HIGH",
  })),
});

export const reviewer = (bundle: ReturnType<TaskStorage["getDurablePlanningReviewBundle"]>) => {
  if (bundle === null) throw new Error("A current review bundle is required.");
  const binding = { planRevision: bundle.reviewState.candidate.revision, candidateBinding: bundle.candidateBinding };
  return bundle.taskContracts.every(contract => contract.acceptanceCriteria.includes("Candidate is committed and independently verified."))
    ? { ...binding, outcome: "APPROVE" as const }
    : { ...binding, outcome: "REJECT" as const, revisionRequirements: ["Require committed candidates and independent verification for each component."] };
};

export class IntegratedOrchestrationFixture {
  readonly directory = realpathSync.native(mkdtempSync(join(tmpdir(), "ctc-integrated-8e-")));
  readonly repositoryPath = join(this.directory, "source");
  readonly databasePath = join(this.directory, "console.sqlite");
  #timestamp = Date.parse("2026-09-05T00:00:00.000Z");
  #nextOwnership = 0;
  readonly clock = () => new Date(this.#timestamp += 1_000);
  storage = openTaskDatabase({ databasePath: this.databasePath, clock: this.clock });
  worktrees = this.#makeWorktrees();
  governed = createGovernedExecutionStoreForTest(this.storage, this.worktrees);
  readonly executions: { subtaskId: SubtaskId; role: SyntheticRole; before: string; after: string }[] = [];

  constructor(readonly options: IntegratedOptions = {}) {
    fixtureGit(this.directory, ["init", "--initial-branch", "main", this.repositoryPath]);
    writeFileSync(join(this.repositoryPath, "AGENTS.md"), "Synthetic work only.\n", { encoding: "utf8" });
    fixtureGit(this.repositoryPath, ["add", "--all"]);
    fixtureGit(this.repositoryPath, ["-c", "commit.gpgsign=false", "commit", "--message", "Synthetic foundation"]);
    fixtureGit(this.repositoryPath, ["update-ref", "refs/remotes/origin/main", fixtureGit(this.repositoryPath, ["rev-parse", "HEAD"])]);
    fixtureGit(this.repositoryPath, ["config", "branch.main.remote", "origin"]);
    fixtureGit(this.repositoryPath, ["config", "branch.main.merge", "refs/heads/main"]);
    this.storage.createProject(ProjectSchema.parse({
      recordType: "PROJECT", id: PROJECT_ID, name: "Synthetic turnover", slug: "synthetic-turnover",
      repository: { kind: "PATH", path: this.repositoryPath }, defaultBranch: "main", maxActiveCodingSubtasks: 2,
    }));
    this.storage.createBigTask({
      recordType: "BIG_TASK", id: BIG_TASK_ID, projectId: PROJECT_ID, title: "Three synthetic components",
      goal: "Complete three canonical components sequentially.", rationale: "Prove ownership turnover.",
      scopeIn: ["Synthetic candidates"], scopeOut: ["Real targets"],
      acceptanceCriteria: ["Every component completes through governed execution."], status: "IN_PROGRESS",
    });
    if (options.planning === false) return;
    const v1 = planner(1, options);
    this.storage.beginDurablePlanningBundle(v1.candidate, v1.contracts);
    const v1Bundle = this.storage.getDurablePlanningReviewBundle(BIG_TASK_ID)!;
    const rejection = reviewer(v1Bundle);
    expect(rejection.outcome).toBe("REJECT");
    this.storage.recordDurableReviewerDecision(BIG_TASK_ID, rejection);
    const v2 = planner(2, options);
    this.storage.submitDurablePlannerRevisionBundle(v2.candidate, v2.contracts);
    const beforeStale = this.counts();
    expect(() => this.storage.recordDurableReviewerDecision(BIG_TASK_ID, { outcome: "APPROVE", planRevision: 1,
      candidateBinding: v1Bundle.candidateBinding })).toThrow();
    expect(this.counts()).toEqual(beforeStale);
    const approval = reviewer(this.storage.getDurablePlanningReviewBundle(BIG_TASK_ID));
    expect(approval.outcome).toBe("APPROVE");
    this.storage.recordDurableReviewerDecision(BIG_TASK_ID, approval);
    this.reopen();
    const approved = this.storage.getDurablePlanningSnapshot(BIG_TASK_ID)!;
    expect(approved.candidateHistory).toHaveLength(2);
    expect(approved.reviewDecisions).toHaveLength(2);
    expect(approved.reviewState).toMatchObject({ phase: "APPROVED", automaticRevisionsUsed: 1 });
    this.storage.materializeDurablePlan(BIG_TASK_ID);
    const canonical = this.storage.materializeApprovedCanonicalTasks(BIG_TASK_ID);
    this.reopen();
    expect(this.storage.materializeApprovedCanonicalTasks(BIG_TASK_ID)).toEqual(canonical);
    const initialized = this.storage.initializeDurableSubtaskWorkflows(BIG_TASK_ID);
    this.reopen();
    expect(this.storage.initializeDurableSubtaskWorkflows(BIG_TASK_ID)).toEqual(initialized);
    const inspection = this.governed.inspectBigTask(BIG_TASK_ID);
    expect(inspection.dispatchReceipts).toHaveLength(0);
    expect(inspection.workflows).toHaveLength(options.profiles?.length ?? 3);
    for (const view of inspection.workflows) {
      expect(view).toMatchObject({ currentStage: view.profile === "LOW" ? "EXECUTE" : "MATERIALIZE", boardStatus: "TODO", repairCyclesUsed: 0 });
      expect(this.worktrees.listWorktreeOwnershipHistoryForSubtask(view.subtaskId)).toHaveLength(0);
    }
  }

  #makeWorktrees() {
    return createWorktreeOwnershipManagerForTesting(this.storage, {
      worktreeRoot: join(this.directory, "worktrees"),
      idGenerator: () => `wt_${(++this.#nextOwnership).toString(16).padStart(32, "0")}`,
    });
  }

  advanceClockForWorkerReadback() { this.#timestamp = Date.parse("2026-09-07T00:00:00.000Z"); }

  reopen() {
    this.storage.close();
    this.storage = openTaskDatabase({ databasePath: this.databasePath, clock: this.clock });
    this.worktrees = this.#makeWorktrees();
    this.governed = createGovernedExecutionStoreForTest(this.storage, this.worktrees);
  }

  counts() {
    const database = new DatabaseSync(this.databasePath, { readOnly: true });
    try {
      return Object.fromEntries([
        "orchestration_plan_candidates", "orchestration_review_decisions", "orchestration_materializations",
        "canonical_task_materializations", "workflow_initialization_receipts", "subtask_workflow_instances",
        "governed_dispatch_receipts", "governed_role_authorizations", "governed_role_results",
        "governed_handoffs", "governed_big_task_completion_receipts", "execution_runs",
      ].map(table => [table, Number(database.prepare(`SELECT count(*) AS count FROM ${table}`).get()!.count)]));
    } finally {
      database.close();
    }
  }

  seedIndependentProject(reuseProject = false) {
    const projectId = reuseProject ? PROJECT_ID : ProjectIdSchema.parse("prj_integrated_other");
    const bigTaskId = BigTaskIdSchema.parse("bt_integrated_other");
    const subtaskId = SubtaskIdSchema.parse("st_integrated_other");
    if (!reuseProject) this.storage.createProject(ProjectSchema.parse({ recordType: "PROJECT", id: projectId, name: "Independent synthetic Project",
      slug: "independent-synthetic", repository: { kind: "PATH", path: this.repositoryPath }, defaultBranch: "main", maxActiveCodingSubtasks: 2 }));
    this.storage.createBigTask({ recordType: "BIG_TASK", id: bigTaskId, projectId, title: "Independent component",
      goal: "Prove Project independence.", rationale: "Independent dispatch authority.", scopeIn: ["Disposable worktree"],
      scopeOut: ["Other Project context"], acceptanceCriteria: ["Verified synthetic commit."], status: "IN_PROGRESS" });
    const proposed = planner(2, { profiles: ["LOW"] });
    const taskContractRef = "contract/independent/v1";
    this.storage.beginDurablePlanningBundle({ ...proposed.candidate, revision: 1, projectId, bigTaskId,
      subtasks: [{ ...proposed.candidate.subtasks[0]!, id: subtaskId, bigTaskId, taskContractRef }] },
      [TaskContractV0Schema.parse({ ...proposed.contracts[0]!, taskContractRef, projectId, bigTaskId, subtaskId,
        promptSeed: "Independent Project approved contract canary." })]);
    const bundle = this.storage.getDurablePlanningReviewBundle(bigTaskId)!;
    this.storage.recordDurableReviewerDecision(bigTaskId, { outcome: "APPROVE", planRevision: 1, candidateBinding: bundle.candidateBinding });
    this.storage.materializeDurablePlan(bigTaskId); this.storage.materializeApprovedCanonicalTasks(bigTaskId);
    this.storage.initializeDurableSubtaskWorkflows(bigTaskId);
    return { projectId, bigTaskId, subtaskId };
  }

  readonly inputs: { role: SyntheticRole; payload: Record<string, unknown> }[] = [];

  readRows(sql: string) {
    const database = new DatabaseSync(this.databasePath, { readOnly: true });
    try { return database.prepare(sql).all(); } finally { database.close(); }
  }

  async runRole(subtaskId: SubtaskId, role: SyntheticRole, options: { scenario?: string; tokens?: number; success?: boolean; bigTaskId?: BigTaskId; beforeProvider?: () => void; onTurn?: () => void } = {}) {
    const prepared = this.governed.prepareNextRole(options.bigTaskId ?? BIG_TASK_ID);
    expect(prepared.kind).toBe("ROLE_AUTHORIZED");
    if (prepared.kind !== "ROLE_AUTHORIZED") throw new Error("Expected a governed role authorization.");
    expect(prepared.authorization).toMatchObject({ subtaskId, role });
    const receiptId = prepared.authorization.dispatchReceiptId;
    const active = this.governed.inspectBigTask(options.bigTaskId ?? BIG_TASK_ID).dispatchReceipts.filter(receipt => receipt.status === "ACTIVE" || receipt.status === "RESERVED");
    expect(active.map(receipt => receipt.receiptId)).toEqual([receiptId]);
    const before = prepared.authorization.candidateSha;
    if (role === "VERIFY") {
      expect(this.executions.filter(execution => execution.subtaskId === subtaskId).at(-1)).toMatchObject({ subtaskId, role: "EXECUTE", after: before });
    }
    let observationFailure: unknown;
    const pausePath = join(this.directory, `started-${prepared.authorization.authorizationId}`);
    options.beforeProvider?.();
    const result = await executeGovernedRoleCodexWithDependenciesForTest(this.governed, prepared.authorization.authorizationId, {
      checkCompatibility: () => true,
      resolveRuntime: () => ({ canonicalExecutablePath: "/owned/codex/bin/codex", exactVersionOutput: TESTED_CODEX_VERSION,
        executable: true, readable: true, releaseVersion: "0.148.0-alpha.9", source: "OWNED_RELEASE", target: "aarch64-apple-darwin" }),
      resolveOwnedWorktree: () => { throw new Error("Governed authority must resolve its own worktree."); },
      generateChatThreadId: () => { throw new Error("Governed storage must own thread IDs."); },
      generateExecutionRunId: () => { throw new Error("Governed storage must own run IDs."); },
      validateWorktreeFilesystem: validateOwnedWorktreeHardlinkSafety,
      spawnAppServer: (_executable, _args, spawnOptions) => {
        const child = spawn(process.execPath, [MOCK_PATH, `--role=${role}`, `--occurrence=${prepared.authorization.authorizationId}`,
          "--commit-candidate", "--canary", ...(options.scenario ? [`--scenario=${options.scenario}`] : []),
          ...(options.tokens === undefined ? [] : [`--tokens=${options.tokens}`]),
          ...(options.onTurn === undefined ? [] : [`--pause-after-start=${pausePath}`])], spawnOptions);
        if (options.onTurn !== undefined) {
          let output = "";
          let observed = false;
          child.stdout!.on("data", (chunk: Buffer) => {
            output += chunk.toString("utf8");
            if (!observed && output.includes('"method":"turn/started"')) {
              observed = true;
              setImmediate(() => {
                try { options.onTurn!(); } catch (error) { observationFailure = error; }
                finally { writeFileSync(pausePath, "continue", { encoding: "utf8" }); }
              });
            }
          });
        }
        const write = child.stdin!.write.bind(child.stdin!);
        child.stdin!.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
          const message = JSON.parse(String(chunk)) as { method?: string; params?: { input?: { text: string }[] } };
          if (message.method === "turn/start") {
            const text = message.params!.input![0]!.text;
            this.inputs.push({ role, payload: JSON.parse(text.slice(text.indexOf("\n") + 1)) as Record<string, unknown> });
          }
          return Reflect.apply(write, child.stdin, [chunk, ...rest]) as boolean;
        }) as typeof child.stdin.write;
        return child;
      },
      sourceEnvironment: { LANG: "en_US.UTF-8" }, normalHomeDirectory: "/fixture/home",
      createWorkspace: () => { const path = mkdtempSync(join(realpathSync(tmpdir()), "ctc-8e-runtime-")); chmodSync(path, 0o700); return path; },
      removeWorkspace: path => rmSync(path, { force: true, recursive: true }),
      limits: { startupTimeoutMs: 2_000, requestTimeoutMs: 2_000, turnIdleTimeoutMs: 2_000, turnAbsoluteTimeoutMs: 5_000,
        interruptTimeoutMs: 500, shutdownGraceMs: 500, terminateGraceMs: 500, maxJsonlLineBytes: 256 * 1_024,
        maxPendingRequests: 8, maxNotifications: 64, maxAgentResponseBytes: 16 * 1_024, maxStderrBytes: 128 },
    });
    if (observationFailure !== undefined) throw observationFailure;
    if (options.success === false) {
      expect(result.success).toBe(false);
      return result;
    }
    expect(result, `${subtaskId}/${role}: ${result.failureCode}`).toMatchObject({ success: true, roleResult: { role } });
    const after = this.worktrees.resolveActiveOwnedWorktreeForSubtask(subtaskId).currentHeadSha;
    expect(result.roleResult?.candidateSha).toBe(after);
    if (role === "EXECUTE" || role === "HARDEN" || role === "REPAIR") {
      expect(after).not.toBe(before);
      const worktree = this.worktrees.resolveActiveOwnedWorktreeForSubtask(subtaskId);
      expect(fixtureGit(worktree.ownership.worktreePath, ["rev-parse", "HEAD^"])).toBe(before);
    }
    else expect(after).toBe(before);
    this.executions.push({ subtaskId, role, before, after });
    return result;
  }

  close() {
    this.storage.close();
    rmSync(this.directory, { force: true, recursive: true });
  }
}
