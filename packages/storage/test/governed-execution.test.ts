import { GATE_KINDS, provenanceId, readGateObservation } from "../src/governed-occurrence-provenance.js";
import { createGovernedExecutionStoreForTesting as createGovernedExecutionStore } from "../src/governed-execution.js";
import type { GovernedExecutionStore } from "../src/governed-execution.js";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  BigTaskIdSchema,
  ContextScopeSchema,
  ChatThreadIdSchema,
  ExecutionProviderIdSchema,
  ExecutionRunIdSchema,
  ProjectIdSchema,
  ProjectSchema,
  ProviderModelReferenceSchema,
  ProviderRunReferenceSchema,
  ProviderThreadReferenceSchema,
  SubtaskIdSchema,
  SubtaskDependencySchema,
  TaskContractV0Schema,
} from "@codex-task-console/domain";
import type {
  BigTaskId,
  NormalizedUsage,
  SubtaskId,
  TaskContractV0,
} from "@codex-task-console/domain";
import type { PlanCandidate, WorkflowProfile } from "@codex-task-console/orchestration";
import {
  openTaskDatabase,
} from "../src/index.js";
import type {
  GovernedPreparationResult,
  TaskStorage,
  WorktreeOwnershipManager,
} from "../src/index.js";
import { createWorktreeOwnershipManagerForTesting } from "../src/worktree-ownership.js";
import { makeBigTask, makeContextItem, makeContextDigest } from "./fixtures.js";

// Long synchronous SQLite/Git matrices must let Vitest deliver task updates.
// This yields between isolated cases; it does not change their timeout or work.
afterEach(async () => { await new Promise<void>(resolve => setImmediate(resolve)); });

const PROVIDER_ID = ExecutionProviderIdSchema.parse("codex-app-server");
const MODEL = ProviderModelReferenceSchema.parse({
  providerId: PROVIDER_ID,
  providerModelId: "gpt-test",
});
const ZERO_USAGE: NormalizedUsage = Object.freeze({
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  totalTokens: 0,
});

const clock = (): (() => Date) => {
  let value = Date.parse("2026-09-04T00:00:00.000Z");
  return () => new Date((value += 1_000));
};

const git = (repositoryPath: string, arguments_: readonly string[]): string =>
  execFileSync("git", ["-C", repositoryPath, ...arguments_], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: "2026-09-04T00:00:00Z",
      GIT_AUTHOR_EMAIL: "governed@example.invalid",
      GIT_AUTHOR_NAME: "Governed Fixture",
      GIT_COMMITTER_DATE: "2026-09-04T00:00:00Z",
      GIT_COMMITTER_EMAIL: "governed@example.invalid",
      GIT_COMMITTER_NAME: "Governed Fixture",
    },
  }).trim();

interface Scenario {
  readonly directory: string;
  readonly databasePath: string;
  readonly repositoryPath: string;
  readonly worktreeRoot: string;
  readonly now: () => Date;
  readonly storage: TaskStorage;
}

const createScenario = (): Scenario => {
  const directory = realpathSync.native(
    mkdtempSync(join(tmpdir(), "ctc-governed-execution-")),
  );
  const repositoryPath = join(directory, "source");
  mkdirSync(repositoryPath);
  git(repositoryPath, ["init", "--initial-branch", "main"]);
  writeFileSync(join(repositoryPath, "AGENTS.md"), "Keep changes bounded.\n", {
    encoding: "utf8",
  });
  writeFileSync(join(repositoryPath, "README.md"), "fixture\n", {
    encoding: "utf8",
  });
  git(repositoryPath, ["add", "--all"]);
  git(repositoryPath, ["commit", "--message", "fixture"]);
  git(repositoryPath, [
    "update-ref",
    "refs/remotes/origin/main",
    git(repositoryPath, ["rev-parse", "HEAD"]),
  ]);
  git(repositoryPath, ["config", "branch.main.remote", "origin"]);
  git(repositoryPath, ["config", "branch.main.merge", "refs/heads/main"]);
  const databasePath = join(directory, "console.sqlite");
  const now = clock();
  return {
    directory,
    databasePath,
    repositoryPath,
    worktreeRoot: join(directory, "worktrees"),
    now,
    storage: openTaskDatabase({ databasePath, clock: now }),
  };
};

const cleanupScenario = (scenario: Scenario): void => {
  scenario.storage.close();
  rmSync(scenario.directory, { force: true, recursive: true });
};

const seed = (
  scenario: Scenario,
  options: Readonly<{
    suffix?: string;
    projectId?: string;
    profiles?: readonly WorkflowProfile[];
    startPolicy?: "MANUAL" | "WHEN_READY";
    writeEnabled?: boolean;
    promptSeed?: string;
    blockingDependency?: boolean;
  }> = {},
): Readonly<{ bigTaskId: BigTaskId; subtaskIds: readonly SubtaskId[] }> => {
  const suffix = options.suffix ?? "";
  const projectId = ProjectIdSchema.parse(options.projectId ?? `prj_governed${suffix}`);
  const bigTaskId = BigTaskIdSchema.parse(`bt_governed${suffix}`);
  const profiles = options.profiles ?? ["STANDARD"];
  const subtaskIds = profiles.map((_profile, index) =>
    SubtaskIdSchema.parse(`st_governed${suffix}_${index}`),
  );
  if (scenario.storage.getProjectById(projectId) === null) {
    scenario.storage.createProject(
      ProjectSchema.parse({
        recordType: "PROJECT",
        id: projectId,
        name: "Governed execution",
        slug: `governed-execution${suffix.replaceAll("_", "-")}`,
        repository: { kind: "PATH", path: scenario.repositoryPath },
        defaultBranch: "main",
        maxActiveCodingSubtasks: 2,
      }),
    );
  }
  scenario.storage.createBigTask(makeBigTask(bigTaskId, projectId));
  const plan: PlanCandidate = {
    kind: "PLAN_CANDIDATE",
    projectId,
    bigTaskId,
    revision: 1,
    subtasks: profiles.map((profile, index) => ({
      id: subtaskIds[index]!,
      bigTaskId,
      profile,
      taskContractRef: `contract/governed${suffix}/${index}`,
      writeEnabled: options.writeEnabled ?? true,
    })),
    dependencies:
      options.blockingDependency === true && subtaskIds.length >= 2
        ? [
            SubtaskDependencySchema.parse({
              upstreamSubtaskId: subtaskIds[0]!,
              downstreamSubtaskId: subtaskIds[1]!,
              dependencyType: "BLOCKING",
              requiredGate: "ACCEPTED",
              reason: "The upstream governed result must be accepted first.",
            }),
          ]
        : [],
  };
  const contracts: readonly TaskContractV0[] = plan.subtasks.map(
    (subtask, index) =>
      TaskContractV0Schema.parse({
        taskContractRef: subtask.taskContractRef,
        projectId,
        bigTaskId,
        subtaskId: subtask.id,
        title: `Governed ${index}`,
        goal: "Execute a bounded synthetic role.",
        scopeIn: ["Governed execution"],
        scopeOut: ["External side effects"],
        acceptanceCriteria: ["Durable authority is exact."],
        untouchedAreas: ["Provider expansion"],
        promptSeed: options.promptSeed ?? "Return the governed result.",
        startPolicy: options.startPolicy ?? "WHEN_READY",
        delegationPolicy: "NONE",
        recommendedReasoningLevel: "HIGH",
      }),
  );
  const bundle = scenario.storage.beginDurablePlanningBundle(plan, contracts);
  scenario.storage.recordDurableReviewerDecision(bigTaskId, {
    outcome: "APPROVE",
    planRevision: 1,
    candidateBinding: bundle.reviewState.candidateBinding,
  });
  scenario.storage.materializeDurablePlan(bigTaskId);
  scenario.storage.materializeApprovedCanonicalTasks(bigTaskId);
  scenario.storage.initializeDurableSubtaskWorkflows(bigTaskId);
  return { bigTaskId, subtaskIds };
};

const governedFor = (
  scenario: Scenario,
  preprovisionBigTaskIds: readonly BigTaskId[] = [],
): GovernedExecutionStore => {
  const db = new DatabaseSync(scenario.databasePath, {readOnly:true});
  let next = Number(db.prepare("SELECT count(*) AS count FROM worktree_ownerships").get()!.count);
  db.close();
  const worktrees = createWorktreeOwnershipManagerForTesting(scenario.storage, {
    worktreeRoot: scenario.worktreeRoot,
    idGenerator: () => `wt_${(++next).toString(16).padStart(32, "0")}`,
  });
  if (preprovisionBigTaskIds.length !== 0) {
    for (const bigTaskId of preprovisionBigTaskIds) {
      for (const subtask of scenario.storage.listSubtasksByBigTask(bigTaskId)) {
        if (subtask.status === "TODO") {
          worktrees.provisionOwnedWorktreeForSubtask(subtask.id);
        }
      }
    }
  }
  return createGovernedExecutionStore(scenario.storage, worktrees);
};

const waitForFiles = async (paths: readonly string[]): Promise<void> => {
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    if (paths.every((path) => existsSync(path))) {
      return;
    }
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 5));
  }
  throw new Error("Cross-process governed-dispatch barrier was not reached.");
};

const runDispatchWorker = (
  scenario: Scenario,
  bigTaskId: BigTaskId,
  readyPath: string,
  goPath: string,
  outcomePath: string,
  operation = "PREPARE",
): Promise<Readonly<{ readonly status: number | null; readonly output: string }>> =>
  new Promise((resolvePromise) => {
    const child = spawn(
      process.execPath,
      [
        join(process.cwd(), "node_modules", "vitest", "vitest.mjs"),
        "run",
        "packages/storage/test/governed-dispatch-process-worker.test.ts",
        "--maxWorkers=1",
        "--reporter=dot",
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          CTC_8D_PROCESS_OPERATION: operation,
          CTC_8D_PROCESS_DATABASE_PATH: scenario.databasePath,
          CTC_8D_PROCESS_WORKTREE_ROOT: scenario.worktreeRoot,
          CTC_8D_PROCESS_BIG_TASK_ID: bigTaskId,
          CTC_8D_PROCESS_READY_PATH: readyPath,
          CTC_8D_PROCESS_GO_PATH: goPath,
          CTC_8D_PROCESS_OUTCOME_PATH: outcomePath,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.on("close", (status) =>
      resolvePromise(Object.freeze({ status, output })),
    );
  });

const authorized = (
  prepared: GovernedPreparationResult,
): Extract<GovernedPreparationResult, { readonly kind: "ROLE_AUTHORIZED" }> => {
  expect(prepared.kind, JSON.stringify(prepared)).toBe("ROLE_AUTHORIZED");
  return prepared as Extract<
    GovernedPreparationResult,
    { readonly kind: "ROLE_AUTHORIZED" }
  >;
};

const completeRole = (
  governed: GovernedExecutionStore,
  prepared: Extract<
    GovernedPreparationResult,
    { readonly kind: "ROLE_AUTHORIZED" }
  >,
  outcome: "READY" | "PASS" | "BLOCKING_FAIL",
  findings: readonly object[] = [],
  usage?: NormalizedUsage,
  promotionCandidate: string | null = null,
) => {
  const { authorization } = prepared;
  const attempt = governed.reserveRoleExecutionAttempt(
    authorization.authorizationId,
  );
  const input = governed.claimRoleProviderExecution(authorization.authorizationId);
  const providerThread = ProviderThreadReferenceSchema.parse({
    providerId: PROVIDER_ID,
    providerThreadId: `provider-thread-${authorization.workflowSequence}`,
  });
  governed.bindRoleProviderThread(authorization.authorizationId, providerThread);
  governed.validateRoleProviderTurnStart(authorization.authorizationId, input.preflight.text);
  governed.startRoleProviderRun(
    authorization.authorizationId,
    ProviderRunReferenceSchema.parse({
      providerId: PROVIDER_ID,
      providerThreadId: providerThread.providerThreadId,
      providerRunId: `provider-run-${authorization.workflowSequence}`,
    }),
    MODEL,
  );
  const result = governed.persistSuccessfulRoleResult(
    authorization.authorizationId,
    JSON.stringify({
      schemaVersion: 1,
      promotionCandidate,
      outcome,
      summary: `${authorization.role} completed.`,
      findings,
    }),
    MODEL,
    usage ?? ZERO_USAGE,
  );
  expect(result.executionRunId).toBe(attempt.executionRunId);
  return governed.reconcileRoleResult(authorization.authorizationId);
};

const recordUsage = (
  scenario: Scenario,
  subtaskId: SubtaskId,
  suffix: string,
  totalTokens: number | null,
): void => {
  const threadId = ChatThreadIdSchema.parse(`thr_budget_${suffix}`);
  const runId = ExecutionRunIdSchema.parse(`run_budget_${suffix}`);
  scenario.storage.createChatThread({
    id: threadId,
    subtaskId,
    providerId: PROVIDER_ID,
  });
  const providerThread = ProviderThreadReferenceSchema.parse({
    providerId: PROVIDER_ID,
    providerThreadId: `budget-thread-${suffix}`,
  });
  scenario.storage.bindChatThreadProviderReference({
    chatThreadId: threadId,
    providerThread,
  });
  scenario.storage.createExecutionRun({ id: runId, chatThreadId: threadId });
  scenario.storage.startExecutionRun({
    executionRunId: runId,
    providerRun: ProviderRunReferenceSchema.parse({
      providerId: PROVIDER_ID,
      providerThreadId: providerThread.providerThreadId,
      providerRunId: `budget-run-${suffix}`,
    }),
    providerModel: MODEL,
  });
  if (totalTokens !== null) {
    scenario.storage.finishExecutionRun({
      executionRunId: runId,
      status: "SUCCEEDED",
      normalizedUsage: {
        inputTokens: totalTokens,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        totalTokens,
      },
    });
  }
};

describe("Operational Governed Execution V0", () => {
  it("runs the STANDARD authority chain and derives durable Big Task completion", () => {
    const scenario = createScenario();
    try {
      const { bigTaskId, subtaskIds } = seed(scenario);
      const governed = governedFor(scenario);

      const execute = authorized(governed.prepareNextRole(bigTaskId));
      expect(execute.authorization.role).toBe("EXECUTE");
      expect(execute.authorization.writeEnabled).toBe(true);
      expect(scenario.storage.getSubtaskById(subtaskIds[0]!)?.status).toBe(
        "IN_PROGRESS",
      );
      expect(completeRole(governed, execute, "READY").currentStage).toBe(
        "VERIFY",
      );

      const verify = authorized(governed.prepareNextRole(bigTaskId));
      expect(verify.authorization).toMatchObject({
        role: "VERIFY",
        contextProfile: "STANDARD_SUBTASK_EXECUTION",
        writeEnabled: false,
      });
      expect(completeRole(governed, verify, "PASS").currentStage).toBe(
        "COMPLETE",
      );
      expect(scenario.storage.getSubtaskById(subtaskIds[0]!)?.status).toBe("DONE");

      expect(governed.prepareNextRole(bigTaskId)).toMatchObject({
        kind: "BIG_TASK_COMPLETE",
        bigTaskId,
      });
      expect(scenario.storage.getBigTaskById(bigTaskId)?.status).toBe("DONE");
      expect(governed.inspectBigTask(bigTaskId).dispatchReceipts).toMatchObject([
        { status: "COMPLETED" },
      ]);
      const sqlite = new DatabaseSync(scenario.databasePath);
      expect(
        sqlite
          .prepare(
            `SELECT
               (SELECT count(*) FROM governed_handoffs) AS handoffs,
               (SELECT count(*) FROM governed_promoted_context_dispositions) AS dispositions,
               (SELECT count(*) FROM governed_big_task_completion_receipts) AS completions`,
          )
          .get(),
      ).toEqual({ handoffs: 1, dispositions: 1, completions: 1 });
      expect(() =>
        sqlite
          .prepare(
            "UPDATE governed_big_task_completion_receipts SET completed_at = completed_at",
          )
          .run(),
      ).toThrow(/immutable governed Big Task completion receipt/u);
      sqlite.exec("DROP TRIGGER governed_dispatch_update_guard");
      sqlite.prepare("UPDATE governed_dispatch_receipts SET profile = 'LOW'").run();
      expect(() => governed.inspectBigTask(bigTaskId)).toThrow(
        /Stored governed execution authority is malformed/u,
      );
      sqlite.close();
    } finally {
      cleanupScenario(scenario);
    }
  });

  it("requires immutable manual-start authority and returns the same receipt on retry", () => {
    const scenario = createScenario();
    try {
      const { bigTaskId, subtaskIds } = seed(scenario, {
        profiles: ["LOW"],
        startPolicy: "MANUAL",
      });
      const governed = governedFor(scenario);
      expect(governed.prepareNextRole(bigTaskId)).toEqual({
        kind: "HUMAN_REQUIRED",
        reason: "MANUAL_START_REQUIRED",
        subtaskId: subtaskIds[0],
      });
      const first = governed.authorizeManualStart(subtaskIds[0]!);
      expect(governed.authorizeManualStart(subtaskIds[0]!)).toEqual(first);
      expect(authorized(governed.prepareNextRole(bigTaskId)).receipt).toMatchObject({
        manualStartAuthorityId: first.authorityId,
        status: "ACTIVE",
      });
      expect(governed.authorizeManualStart(subtaskIds[0]!)).toEqual(first);

      const sqlite = new DatabaseSync(scenario.databasePath);
      expect(() =>
        sqlite
          .prepare(
            "UPDATE governed_manual_start_authorities SET authorized_at = authorized_at WHERE authority_id = ?",
          )
          .run(first.authorityId),
      ).toThrow(/immutable governed manual-start authority/u);
      sqlite.close();
    } finally {
      cleanupScenario(scenario);
    }
  });

  it("enforces aggregate warning, one human extension, and the absolute ceiling", () => {
    const scenario = createScenario();
    try {
      const { bigTaskId, subtaskIds } = seed(scenario, {
        profiles: ["LOW"],
      });
      const subtaskId = subtaskIds[0]!;
      const threadId = ChatThreadIdSchema.parse("thr_budget_history");
      const runId = ExecutionRunIdSchema.parse("run_budget_history");
      scenario.storage.createChatThread({
        id: threadId,
        subtaskId,
        providerId: PROVIDER_ID,
      });
      const providerThread = ProviderThreadReferenceSchema.parse({
        providerId: PROVIDER_ID,
        providerThreadId: "budget-thread",
      });
      scenario.storage.bindChatThreadProviderReference({
        chatThreadId: threadId,
        providerThread,
      });
      scenario.storage.createExecutionRun({ id: runId, chatThreadId: threadId });
      scenario.storage.startExecutionRun({
        executionRunId: runId,
        providerRun: ProviderRunReferenceSchema.parse({
          providerId: PROVIDER_ID,
          providerThreadId: providerThread.providerThreadId,
          providerRunId: "budget-run",
        }),
        providerModel: MODEL,
      });
      scenario.storage.finishExecutionRun({
        executionRunId: runId,
        status: "SUCCEEDED",
        normalizedUsage: {
          inputTokens: 100_000,
          cachedInputTokens: 0,
          outputTokens: 20_000,
          reasoningTokens: 0,
          totalTokens: 120_000,
        },
      });
      const governed = governedFor(scenario);
      expect(governed.prepareNextRole(bigTaskId)).toMatchObject({
        kind: "HUMAN_REQUIRED",
        reason: "BUDGET_EXTENSION_REQUIRED",
      });
      const extension = governed.authorizeOneTimeBudgetExtension(subtaskId);
      expect(extension.grantedTokens).toBe(40_000);
      expect(governed.authorizeOneTimeBudgetExtension(subtaskId)).toEqual(extension);
      const prepared = authorized(governed.prepareNextRole(bigTaskId));
      expect(prepared.budget).toMatchObject({
        allowed: true,
        warning: true,
        effectiveLimitTokens: 160_000,
      });
    } finally {
      cleanupScenario(scenario);
    }
  });

  withFreshRoleTest("runs one bounded HIGH_RISK repair path with focused no-write re-QA", ({scenario,bigTaskId,governed,harden,fresh})=>{
      expect(harden.authorization.role).toBe("HARDEN");
      expect(fresh.authorization.contextProfile).toBe("FRESH_INDEPENDENT_QA");
      completeRole(governed, fresh, "BLOCKING_FAIL", [
        {
          findingId: "finding-1",
          blocking: true,
          violatedInvariant: "The exact invariant failed.",
          affectedContract: "contract/governed/0",
          reproduction: "Run the bounded synthetic check.",
        },
      ]);
      const repair = authorized(governed.prepareNextRole(bigTaskId));
      expect(repair.authorization).toMatchObject({ role: "REPAIR", writeEnabled: true });
      completeRole(governed, repair, "READY");
      const focused = authorized(governed.prepareNextRole(bigTaskId));
      expect(focused.authorization).toMatchObject({
        role: "FOCUSED_RE_QA",
        contextProfile: "FOCUSED_RE_QA",
        repairCyclesUsed: 1,
        writeEnabled: false,
      });
      expect(completeRole(governed, focused, "PASS").currentStage).toBe(
        "COMPLETE",
      );
      expect(governed.prepareNextRole(bigTaskId).kind).toBe("BIG_TASK_COMPLETE");
      const sqlite = new DatabaseSync(scenario.databasePath, { readOnly: true });
      expect(
        sqlite
          .prepare(
            `SELECT
               (SELECT count(*) FROM governed_findings) AS findings,
               (SELECT count(*) FROM governed_finding_resolutions) AS resolutions,
               (SELECT count(*) FROM governed_handoffs) AS handoffs,
               (SELECT count(*) FROM governed_promoted_context_dispositions) AS dispositions`,
          )
          .get(),
      ).toEqual({ findings: 1, resolutions: 1, handoffs: 1, dispositions: 1 });
      sqlite.close();
  });

  withFreshRoleTest("stops a failed focused Re-QA at HUMAN_REQUIRED without a second repair", ({ scenario, bigTaskId, subtaskIds, governed }) => {
      completeRole(
        governed,
        authorized(governed.prepareNextRole(bigTaskId)),
        "BLOCKING_FAIL",
        [
          {
            findingId: "persistent-finding",
            blocking: true,
            violatedInvariant: "The exact invariant remains broken.",
            affectedContract: "contract/governed/0",
            reproduction: "Run the focused invariant check.",
          },
        ],
      );
      completeRole(governed, authorized(governed.prepareNextRole(bigTaskId)), "READY");
      const focused = authorized(governed.prepareNextRole(bigTaskId));
      expect(focused.authorization.role).toBe("FOCUSED_RE_QA");
      expect(
        completeRole(governed, focused, "BLOCKING_FAIL", [
          {
            findingId: "persistent-finding",
            blocking: true,
            violatedInvariant: "The exact invariant remains broken.",
            affectedContract: "contract/governed/0",
            reproduction: "Run the focused invariant check.",
          },
        ]),
      ).toMatchObject({ kind: "HUMAN_REQUIRED" });
      expect(governed.prepareNextRole(bigTaskId)).toEqual({
        kind: "HUMAN_REQUIRED",
        reason: "REPAIR_REQA_EXHAUSTED",
        subtaskId: subtaskIds[0],
      });
      const sqlite = new DatabaseSync(scenario.databasePath, { readOnly: true });
      expect(
        sqlite
          .prepare(
            "SELECT role, count(*) AS count FROM governed_role_authorizations WHERE subtask_id = ? GROUP BY role ORDER BY role",
          )
          .all(subtaskIds[0]!),
      ).toEqual([
        { role: "EXECUTE", count: 1 },
        { role: "FOCUSED_RE_QA", count: 1 },
        { role: "FRESH_QA", count: 1 },
        { role: "HARDEN", count: 1 },
        { role: "REPAIR", count: 1 },
      ]);
      sqlite.close();
  });

  it("fails closed for unknown usage and enforces warning and absolute ceilings", () => {
    const unknown = createScenario();
    try {
      const seeded = seed(unknown, { profiles: ["LOW"] });
      recordUsage(unknown, seeded.subtaskIds[0]!, "unknown", null);
      expect(governedFor(unknown).prepareNextRole(seeded.bigTaskId)).toEqual({
        kind: "BLOCKED",
        reason: "BUDGET_BLOCKED",
        subtaskId: seeded.subtaskIds[0],
      });
      expect(governedFor(unknown).inspectBigTask(seeded.bigTaskId).budgets[0]).toMatchObject({
        status: "UNKNOWN_USAGE",
        totalTokens: null,
        allowed: false,
      });
    } finally {
      cleanupScenario(unknown);
    }

    const warning = createScenario();
    try {
      const seeded = seed(warning, { profiles: ["LOW"] });
      recordUsage(warning, seeded.subtaskIds[0]!, "warning", 80_000);
      expect(
        authorized(governedFor(warning).prepareNextRole(seeded.bigTaskId)).budget,
      ).toMatchObject({
        status: "AVAILABLE_WARNING",
        totalTokens: 80_000,
        warning: true,
        allowed: true,
      });
    } finally {
      cleanupScenario(warning);
    }

    const ceiling = createScenario();
    try {
      const seeded = seed(ceiling, { profiles: ["LOW"] });
      const subtaskId = seeded.subtaskIds[0]!;
      recordUsage(ceiling, subtaskId, "ceiling-a", 120_000);
      const governed = governedFor(ceiling);
      expect(governed.prepareNextRole(seeded.bigTaskId)).toMatchObject({
        kind: "HUMAN_REQUIRED",
        reason: "BUDGET_EXTENSION_REQUIRED",
      });
      const extension = governed.authorizeOneTimeBudgetExtension(subtaskId);
      recordUsage(ceiling, subtaskId, "ceiling-b", 40_000);
      expect(governed.prepareNextRole(seeded.bigTaskId)).toEqual({
        kind: "BLOCKED",
        reason: "BUDGET_BLOCKED",
        subtaskId,
      });
      expect(governed.authorizeOneTimeBudgetExtension(subtaskId)).toEqual(extension);
      expect(governed.inspectBigTask(seeded.bigTaskId).budgets[0]).toMatchObject({
        status: "ABSOLUTE_CEILING",
        totalTokens: 160_000,
        allowed: false,
      });
    } finally {
      cleanupScenario(ceiling);
    }
  });

  it("resumes exact durable authority across reopen crash seams", () => {
    const scenario = createScenario();
    const { bigTaskId } = seed(scenario, { profiles: ["STANDARD"] });
    let storage = scenario.storage;
    try {
      let governed = governedFor(scenario);
      const first = authorized(governed.prepareNextRole(bigTaskId));
      const firstAttempt = governed.reserveRoleExecutionAttempt(
        first.authorization.authorizationId,
      );
      storage.close();

      storage = openTaskDatabase({
        databasePath: scenario.databasePath,
        clock: scenario.now,
      });
      const reopenedScenario = { ...scenario, storage };
      governed = governedFor(reopenedScenario);
      const resumed = authorized(governed.prepareNextRole(bigTaskId));
      expect(resumed.authorization.authorizationId).toBe(
        first.authorization.authorizationId,
      );
      expect(
        governed.reserveRoleExecutionAttempt(resumed.authorization.authorizationId),
      ).toEqual(firstAttempt);
      const providerThread = ProviderThreadReferenceSchema.parse({
        providerId: PROVIDER_ID,
        providerThreadId: "provider-thread-resume",
      });
      const input = governed.claimRoleProviderExecution(resumed.authorization.authorizationId);
      governed.bindRoleProviderThread(resumed.authorization.authorizationId, providerThread);
      governed.validateRoleProviderTurnStart(resumed.authorization.authorizationId, input.preflight.text);
      governed.startRoleProviderRun(
        resumed.authorization.authorizationId,
        ProviderRunReferenceSchema.parse({
          providerId: PROVIDER_ID,
          providerThreadId: providerThread.providerThreadId,
          providerRunId: "provider-run-resume",
        }),
        MODEL,
      );
      const response = JSON.stringify({
        schemaVersion: 1,
      promotionCandidate: null,
        outcome: "READY",
        summary: "EXECUTE resumed.",
        findings: [],
      });
      const persisted = governed.persistSuccessfulRoleResult(
        resumed.authorization.authorizationId,
        response,
        MODEL,
        ZERO_USAGE,
      );
      storage.close();

      storage = openTaskDatabase({
        databasePath: scenario.databasePath,
        clock: scenario.now,
      });
      governed = governedFor({ ...scenario, storage });
      const verify = authorized(governed.prepareNextRole(bigTaskId));
      expect(verify.authorization.role).toBe("VERIFY");
      expect(
        governed.persistSuccessfulRoleResult(
          resumed.authorization.authorizationId,
          response,
          MODEL,
          ZERO_USAGE,
        ),
      ).toEqual(persisted);
      completeRole(governed, verify, "PASS");
      const completed = governed.prepareNextRole(bigTaskId);
      expect(completed.kind).toBe("BIG_TASK_COMPLETE");
      expect(governed.prepareNextRole(bigTaskId)).toEqual(completed);
      const sqlite = new DatabaseSync(scenario.databasePath, { readOnly: true });
      expect(
        sqlite
          .prepare(
            `SELECT
               (SELECT count(*) FROM governed_dispatch_receipts) AS dispatches,
               (SELECT count(*) FROM governed_role_execution_links) AS links,
               (SELECT count(*) FROM governed_big_task_completion_receipts) AS completions`,
          )
          .get(),
      ).toEqual({ dispatches: 1, links: 2, completions: 1 });
      sqlite.close();
    } finally {
      storage.close();
      rmSync(scenario.directory, { force: true, recursive: true });
    }
  });

  it("serializes competing process reservations to one Project write authority", async () => {
    const scenario = createScenario();
    try {
      const first = seed(scenario, {
        suffix: "_race_a",
        projectId: "prj_governed_race",
        profiles: ["LOW"],
      });
      const second = seed(scenario, {
        suffix: "_race_b",
        projectId: "prj_governed_race",
        profiles: ["LOW"],
      });
      governedFor(scenario, [first.bigTaskId, second.bigTaskId]);
      const goPath = join(scenario.directory, "dispatch-go");
      const readyPaths = [
        join(scenario.directory, "dispatch-ready-a"),
        join(scenario.directory, "dispatch-ready-b"),
      ];
      const outcomePaths = [
        join(scenario.directory, "dispatch-outcome-a"),
        join(scenario.directory, "dispatch-outcome-b"),
      ];
      const workers = [
        runDispatchWorker(
          scenario,
          first.bigTaskId,
          readyPaths[0]!,
          goPath,
          outcomePaths[0]!,
        ),
        runDispatchWorker(
          scenario,
          second.bigTaskId,
          readyPaths[1]!,
          goPath,
          outcomePaths[1]!,
        ),
      ];
      await waitForFiles(readyPaths);
      writeFileSync(goPath, "go\n", { encoding: "utf-8" });
      const results = await Promise.all(workers);
      expect(results.map(({ status }) => status)).toEqual([0, 0]);
      const outcomes = outcomePaths.map((path) =>
        JSON.parse(readFileSync(path, "utf-8")) as Readonly<{
          kind: string;
          reason?: string;
        }>,
      );
      expect(outcomes.filter(({ kind }) => kind === "ROLE_AUTHORIZED")).toHaveLength(1);
      expect(outcomes).toContainEqual({
        kind: "BLOCKED",
        reason: "CONCURRENCY_BLOCKED",
      });
      const sqlite = new DatabaseSync(scenario.databasePath, { readOnly: true });
      expect(
        sqlite
          .prepare(
            "SELECT count(*) AS count FROM governed_dispatch_receipts WHERE status IN ('RESERVED', 'ACTIVE') AND write_enabled = 1",
          )
          .get(),
      ).toEqual({ count: 1 });
      sqlite.close();
    } finally {
      cleanupScenario(scenario);
    }
  });

  it("keeps blocking dependencies out of dispatch and completes a LOW path", () => {
    const scenario = createScenario();
    try {
      const seeded = seed(scenario, {
        profiles: ["LOW", "LOW"],
        blockingDependency: true,
      });
      const governed = governedFor(scenario);
      completeRole(governed, authorized(governed.prepareNextRole(seeded.bigTaskId)), "READY");
      completeRole(governed, authorized(governed.prepareNextRole(seeded.bigTaskId)), "PASS");
      expect(scenario.storage.getSubtaskById(seeded.subtaskIds[0]!)?.status).toBe(
        "DONE",
      );
      expect(scenario.storage.getSubtaskById(seeded.subtaskIds[1]!)?.status).toBe(
        "TODO",
      );
      expect(governed.prepareNextRole(seeded.bigTaskId)).toEqual({
        kind: "BLOCKED",
        reason: "DEPENDENCY_BLOCKED",
        subtaskId: null,
      });
    } finally {
      cleanupScenario(scenario);
    }
  });

  it("rejects worktree drift and direct role/result authority spoofing", () => {
    const scenario = createScenario();
    try {
      const seeded = seed(scenario, { profiles: ["STANDARD"] });
      const governed = governedFor(scenario);
      const execute = authorized(governed.prepareNextRole(seeded.bigTaskId));
      governed.reserveRoleExecutionAttempt(execute.authorization.authorizationId);
      const worktreePath = governed.resolveRoleExecutionInput(
        execute.authorization.authorizationId,
      ).worktree.ownership.worktreePath;
      writeFileSync(
        join(worktreePath, "drift.txt"),
        "drift\n",
        { encoding: "utf-8" },
      );
      expect(() =>
        governed.resolveRoleExecutionInput(execute.authorization.authorizationId),
      ).toThrow(/candidate worktree authority drifted/u);

      const sqlite = new DatabaseSync(scenario.databasePath);
      expect(() =>
        sqlite
          .prepare(
            `INSERT INTO governed_role_results (
               result_id, authorization_id, execution_run_id, role, outcome,
               summary, candidate_sha, occurred_at
             ) VALUES ('grr_spoof', ?, 'run_unrelated', 'VERIFY', 'PASS',
                       'spoof', ?, '2026-09-04T00:00:00.000Z')`,
          )
          .run(
            execute.authorization.authorizationId,
            execute.authorization.candidateSha,
          ),
      ).toThrow();
      expect(() =>
        sqlite
          .prepare(
            "UPDATE governed_role_authorizations SET role = 'VERIFY' WHERE authorization_id = ?",
          )
          .run(execute.authorization.authorizationId),
      ).toThrow(/immutable governed role authorization/u);
      sqlite.close();
    } finally {
      cleanupScenario(scenario);
    }
  });

  it("leaves lifecycle TODO when accepted worktree provisioning cannot succeed", () => {
    const scenario = createScenario();
    try {
      const seeded = seed(scenario, { profiles: ["STANDARD"] });
      const unavailable = (): never => {
        throw new Error("synthetic unavailable worktree");
      };
      const manager: WorktreeOwnershipManager = {
        provisionOwnedWorktreeForSubtask: unavailable,
        resolveActiveOwnedWorktreeForSubtask: unavailable,
        releaseOwnedWorktreeForSubtask: unavailable,
        reconcileWorktreeOwnershipForSubtask: unavailable,
        listWorktreeOwnershipHistoryForSubtask: () => [],
      };
      const governed = createGovernedExecutionStore(scenario.storage, manager);
      expect(governed.prepareNextRole(seeded.bigTaskId)).toEqual({
        kind: "BLOCKED",
        reason: "WORKTREE_BLOCKED",
        subtaskId: seeded.subtaskIds[0],
      });
      expect(scenario.storage.getSubtaskById(seeded.subtaskIds[0]!)?.status).toBe(
        "TODO",
      );
      const sqlite = new DatabaseSync(scenario.databasePath, { readOnly: true });
      expect(
        sqlite.prepare("SELECT count(*) AS count FROM governed_dispatch_receipts").get(),
      ).toEqual({ count: 0 });
      sqlite.close();
    } finally {
      cleanupScenario(scenario);
    }
  });

  it("blocks the governed context only after role policy is included", () => {
    const scenario = createScenario();
    try {
      const { bigTaskId } = seed(scenario, {
        profiles: ["LOW"],
        promptSeed: "x".repeat(63_900),
      });
      expect(governedFor(scenario).prepareNextRole(bigTaskId)).toMatchObject({
        kind: "BLOCKED",
        reason: "CONTEXT_PREFLIGHT_BLOCKED",
      });
    } finally {
      cleanupScenario(scenario);
    }
  });
});

const hardeningFinding = (findingId: string, blocking = true) => ({
  findingId, blocking, violatedInvariant: `Invariant ${findingId}.`,
  affectedContract: "contract/governed/0", reproduction: `Check ${findingId}.`,
});

const freshRole = (scenario: Scenario, options: Parameters<typeof seed>[1] = {}) => {
  const seeded = seed(scenario, { ...options, profiles: ["HIGH_RISK_FOUNDATION"] });
  const governed = governedFor(scenario);
  completeRole(governed, authorized(governed.prepareNextRole(seeded.bigTaskId)), "READY");
  const harden = authorized(governed.prepareNextRole(seeded.bigTaskId));
  completeRole(governed, harden, "PASS");
  return { ...seeded, governed, harden, fresh: authorized(governed.prepareNextRole(seeded.bigTaskId)) };
};

describe("Step 8D comprehensive hardening regressions", () => {
  describe.each([
    { findings: [hardeningFinding("A"), hardeningFinding("B")] },
    { findings: [hardeningFinding("C"), hardeningFinding("D", false)] },
    { findings: Array.from({ length: 16 }, (_, i) => hardeningFinding(`BATCH-${i}`, i < 12)) },
  ])("bounded batch repair %#", ({findings}) => {
  const fixtures = new WeakMap<object, ReturnType<typeof freshRole> & { scenario: Scenario }>();
  beforeEach(context => {
    const scenario = createScenario();
    try { fixtures.set(context, { ...freshRole(scenario), scenario }); }
    catch (error) { cleanupScenario(scenario); throw error; }
  });
  afterEach(context => { const fixture = fixtures.get(context); if (fixture) cleanupScenario(fixture.scenario); });
  it("repairs and retests the exact bounded Fresh-QA batch in one cycle", testContext => {
      const { governed, bigTaskId, subtaskIds, fresh, scenario } = fixtures.get(testContext)!;
      completeRole(governed, fresh, "BLOCKING_FAIL", findings);
      const repair = authorized(governed.prepareNextRole(bigTaskId));
      governed.reserveRoleExecutionAttempt(repair.authorization.authorizationId);
      const repairInput = governed.resolveRoleExecutionInput(repair.authorization.authorizationId);
      const repairPayload = JSON.parse(repairInput.preflight.text.split("\n").slice(1).join("\n"));
      expect(repairPayload.boundedFindings.map((f: {providerFindingKey: string}) => f.providerFindingKey))
        .toEqual(findings.filter(f => f.blocking).map(f => f.findingId));
      expect(repairPayload.candidateSha).toBe(repair.authorization.candidateSha);
      completeRole(governed, repair, "READY");
      const focused = authorized(governed.prepareNextRole(bigTaskId));
      governed.reserveRoleExecutionAttempt(focused.authorization.authorizationId);
      const input = governed.resolveRoleExecutionInput(focused.authorization.authorizationId);
      const payload = JSON.parse(input.preflight.text.split("\n").slice(1).join("\n"));
      expect(payload.boundedFindings).toEqual(repairPayload.boundedFindings);
      const context = JSON.parse(payload.canonicalContext.split("\n").slice(1).join("\n"));
      expect(context.profile).toBe("FOCUSED_RE_QA");
      expect(input.preflight.utf8Bytes).toBe(Buffer.byteLength(input.preflight.text, "utf8"));
      expect(JSON.stringify(context)).not.toContain('"activeContext"');
      completeRole(governed, focused, "PASS", [hardeningFinding("DEFERRED", false)]);
      expect(governed.prepareNextRole(bigTaskId).kind).toBe("BIG_TASK_COMPLETE");
      const db = new DatabaseSync(scenario.databasePath);
      expect(db.prepare("SELECT count(*) AS count FROM governed_finding_resolutions").get())
        .toEqual({ count: findings.filter(f => f.blocking).length });
      expect(db.prepare("SELECT count(*) AS count FROM governed_role_authorizations WHERE role = 'REPAIR'").get()).toEqual({ count: 1 });
      expect(scenario.storage.getDurableWorkflowControlView(subtaskIds[0]!)?.repairCyclesUsed).toBe(1);
      db.close();
  });
  });

  it.each(["HARDEN", "FRESH_QA", "VERIFY"] as const)("permits %s PASS with bounded non-blocking findings", role => {
    const scenario = createScenario();
    try {
      const { bigTaskId } = seed(scenario, { profiles: [role === "VERIFY" ? "STANDARD" : "HIGH_RISK_FOUNDATION"] });
      const governed = governedFor(scenario);
      completeRole(governed, authorized(governed.prepareNextRole(bigTaskId)), "READY");
      if (role === "FRESH_QA") completeRole(governed, authorized(governed.prepareNextRole(bigTaskId)), "PASS");
      const prepared = authorized(governed.prepareNextRole(bigTaskId));
      expect(prepared.authorization.role).toBe(role);
      expect(completeRole(governed, prepared, "PASS", [hardeningFinding("DEFER", false)]).kind).toBe("TRANSITION_RECORDED");
    } finally { cleanupScenario(scenario); }
  });

  withFreshRoleTest("persists a new bounded blocker found by focused Re-QA and escalates without another repair", ({ bigTaskId, governed, fresh }) => {
      completeRole(governed, fresh, "BLOCKING_FAIL", [hardeningFinding("FIRST"), hardeningFinding("SECOND")]);
      completeRole(governed, authorized(governed.prepareNextRole(bigTaskId)), "READY");
      expect(completeRole(governed, authorized(governed.prepareNextRole(bigTaskId)), "BLOCKING_FAIL",
        [hardeningFinding("FIRST"), hardeningFinding("NEW-REPAIRED-SURFACE"), hardeningFinding("DEFER", false)]).kind).toBe("HUMAN_REQUIRED");
      expect(governed.prepareNextRole(bigTaskId)).toMatchObject({ kind: "HUMAN_REQUIRED", reason: "REPAIR_REQA_EXHAUSTED" });
  });

  it("records source-backed promotion candidates for human review without auto-accepting them", () => {
    const scenario = createScenario();
    try {
      const { bigTaskId } = seed(scenario, { profiles: ["LOW"] });
      const governed = governedFor(scenario);
      completeRole(governed, authorized(governed.prepareNextRole(bigTaskId)), "READY", [], undefined, "A bounded candidate conclusion.");
      completeRole(governed, authorized(governed.prepareNextRole(bigTaskId)), "PASS");
      expect(governed.prepareNextRole(bigTaskId).kind).toBe("BIG_TASK_COMPLETE");
      const db = new DatabaseSync(scenario.databasePath);
      expect(db.prepare("SELECT decision FROM governed_promoted_context_dispositions").get()).toEqual({ decision: "CANDIDATE_RECORDED" });
      expect(db.prepare("SELECT disposition FROM governed_promotion_candidates").get()).toEqual({ disposition: "PENDING_HUMAN_REVIEW" });
      db.close();
    } finally { cleanupScenario(scenario); }
  });

  it.each([0, 79_999, 80_000, 80_001, 119_999, 120_000, 120_001, 159_999, 160_000, 160_001])("derives aggregate budget at exactly %i tokens", total => {
    const scenario = createScenario();
    try {
      const { bigTaskId, subtaskIds } = seed(scenario, { profiles: ["LOW"] });
      recordUsage(scenario, subtaskIds[0]!, "boundary", total);
      const governed = governedFor(scenario);
      expect(governed.inspectBigTask(bigTaskId).budgets[0]).toMatchObject({
        totalTokens: total, allowed: total < 120_000, warning: total >= 80_000, effectiveLimitTokens: 120_000,
      });
      if (total >= 120_000 && total < 160_000) {
        const first = governed.authorizeOneTimeBudgetExtension(subtaskIds[0]!);
        expect(governed.authorizeOneTimeBudgetExtension(subtaskIds[0]!)).toEqual(first);
        expect(governed.inspectBigTask(bigTaskId).budgets[0]).toMatchObject({ allowed: true, effectiveLimitTokens: 160_000 });
      } else expect(() => governed.authorizeOneTimeBudgetExtension(subtaskIds[0]!)).toThrow();
    } finally { cleanupScenario(scenario); }
  });

  it("allows one provider-start claimant and never resumes an ambiguous claimed CREATED run", () => {
    const scenario = createScenario();
    try {
      const { bigTaskId } = seed(scenario, { profiles: ["LOW"] });
      const governed = governedFor(scenario);
      const prepared = authorized(governed.prepareNextRole(bigTaskId));
      const attempt = governed.reserveRoleExecutionAttempt(prepared.authorization.authorizationId);
      governed.claimRoleProviderExecution(prepared.authorization.authorizationId);
      expect(() => governed.claimRoleProviderExecution(prepared.authorization.authorizationId)).toThrow(/already claimed/u);
      expect(governed.prepareNextRole(bigTaskId)).toMatchObject({ kind: "BLOCKED", reason: "PROVIDER_ROLE_FAILED" });
      expect(scenario.storage.getExecutionRunById(attempt.executionRunId)?.status).toBe("CREATED");
    } finally { cleanupScenario(scenario); }
  });

  it("rejects a generic public implementation checkpoint on a governed Subtask", () => {
    const scenario = createScenario();
    try {
      const { bigTaskId, subtaskIds } = seed(scenario, { profiles: ["LOW"] });
      const prepared = authorized(governedFor(scenario).prepareNextRole(bigTaskId));
      expect(() => scenario.storage.completeSubtaskImplementation({subtaskId: subtaskIds[0]!, checkpoint: {
        id: "icp_caller_forgery" as never, subtaskId: subtaskIds[0]!, repositoryCommitSha: prepared.authorization.candidateSha,
        actorType: "CODEX", actorReference: "caller", sourceReference: "caller", summary: "Caller says ready.", occurredAt: "2026-09-04T02:00:00.000Z",
      }})).toThrow(/exact provider result authority/u);
      expect(scenario.storage.getSubtaskById(subtaskIds[0]!)?.maturity).toBe("NOT_STARTED");
    } finally { cleanupScenario(scenario); }
  });

  it("rejects all critical governed trigger/index losses on authoritative use", async () => {
    const scenario = createScenario();
    try {
      const { bigTaskId } = seed(scenario, { profiles: ["LOW"] });
      const governed = governedFor(scenario);
      governed.prepareNextRole(bigTaskId);
      const db = new DatabaseSync(scenario.databasePath);
      const objects = db.prepare("SELECT name,type,sql FROM sqlite_schema WHERE name GLOB 'governed_*' AND type IN ('trigger','index')").all();
      expect(objects.length).toBeGreaterThan(80);
      for (const object of objects) {
        db.exec(`DROP ${String(object.type).toUpperCase()} "${object.name}"`);
        expect(() => governed.inspectBigTask(bigTaskId), String(object.name)).toThrow(/malformed/u);
        db.exec(String(object.sql));
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      db.close();
      expect(governed.inspectBigTask(bigTaskId).dispatchReceipts).toHaveLength(1);
    } finally { cleanupScenario(scenario); }
  });
});

describe("Step 8D bounded persisted-state matrix", () => {
  it.each([
    ["governed_dispatch_receipts", "gate_evidence_references = '[]'"],
    ["governed_dispatch_gate_snapshots", "candidate_sha = '1111111111111111111111111111111111111111'"],
    ["governed_role_results", "summary = 'Stale result summary.'"],
    ["governed_result_provenance", "provider_model_id = 'wrong-model'"],
    ["governed_handoffs", "summary = 'Stale Handoff summary.'"],
    ["governed_promoted_context_dispositions", "decision = 'CANDIDATE_RECORDED'"],
    ["governed_role_authorizations", "candidate_binding = 'wrong-candidate'"],
  ])("rejects shape-valid %s corruption with original guards restored", (table, mutation) => {
    const scenario = createScenario();
    try {
      const { bigTaskId } = seed(scenario, { profiles: ["STANDARD"] });
      const governed = governedFor(scenario);
      completeRole(governed, authorized(governed.prepareNextRole(bigTaskId)), "READY");
      completeRole(governed, authorized(governed.prepareNextRole(bigTaskId)), "PASS");
      const db = new DatabaseSync(scenario.databasePath);
      db.exec("PRAGMA foreign_keys = OFF");
      const triggers = db.prepare("SELECT name,sql FROM sqlite_schema WHERE type = 'trigger' AND tbl_name = ?").all(table);
      for (const trigger of triggers) db.exec(`DROP TRIGGER "${trigger.name}"`);
      db.exec(`UPDATE ${table} SET ${mutation}`);
      for (const trigger of triggers) db.exec(String(trigger.sql));
      db.close();
      expect(() => governed.prepareNextRole(bigTaskId)).toThrow();
      expect(() => governed.inspectBigTask(bigTaskId)).toThrow();
    } finally { cleanupScenario(scenario); }
  });

  withPreparedScenario("rejects replacement, upsert, update and delete on every populated immutable authority table", scenario=>{
      const { bigTaskId, subtaskIds } = seed(scenario, {profiles:["HIGH_RISK_FOUNDATION"], startPolicy:"MANUAL"});
      const governed = governedFor(scenario);
      expect(governed.prepareNextRole(bigTaskId).kind).toBe("HUMAN_REQUIRED");
      governed.authorizeManualStart(subtaskIds[0]!);
      recordUsage(scenario, subtaskIds[0]!, "mutation-budget", 120_000);
      governed.authorizeOneTimeBudgetExtension(subtaskIds[0]!);
      completeRole(governed, authorized(governed.prepareNextRole(bigTaskId)), "READY", [], undefined, "Candidate for explicit review.");
      completeRole(governed, authorized(governed.prepareNextRole(bigTaskId)), "PASS");
      return {bigTaskId,governed};
  }, async ({scenario,bigTaskId,governed})=>{
      completeRole(governed, authorized(governed.prepareNextRole(bigTaskId)), "BLOCKING_FAIL", [hardeningFinding("A"), hardeningFinding("B")]);
      completeRole(governed, authorized(governed.prepareNextRole(bigTaskId)), "READY");
      completeRole(governed, authorized(governed.prepareNextRole(bigTaskId)), "PASS");
      governed.prepareNextRole(bigTaskId);
      const db = new DatabaseSync(scenario.databasePath);
      const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name GLOB 'governed_*'").all();
      expect(tables).toHaveLength(19);
      let attempts = 0;
      for (const recursive of ["ON", "OFF"]) {
        db.exec(`PRAGMA recursive_triggers = ${recursive}`);
        for (const {name} of tables) {
          await new Promise<void>(resolve => setImmediate(resolve));
          const table = String(name);
          const row = db.prepare(`SELECT * FROM ${table} LIMIT 1`).get()!;
          expect(row, table).toBeDefined();
          const cols = Object.keys(row).map(c => `"${c}"`).join(",");
          const first = Object.keys(row)[0]!;
          const placeholder = Object.keys(row).map(() => "?").join(",");
          const values = Object.values(row);
          const mutations = [
            `INSERT INTO ${table} (${cols}) VALUES (${placeholder})`,
            `INSERT OR REPLACE INTO ${table} (${cols}) VALUES (${placeholder})`,
            `INSERT INTO ${table} (${cols}) VALUES (${placeholder}) ON CONFLICT DO UPDATE SET "${first}" = excluded."${first}"`,
          ];
          for (const sql of mutations) { expect(() => db.prepare(sql).run(...values), table).toThrow(); attempts++; }
          expect(() => db.exec(`UPDATE ${table} SET "${first}" = "${first}"`), table).toThrow(); attempts++;
          expect(() => db.exec(`DELETE FROM ${table}`), table).toThrow(); attempts++;
        }
      }
      expect(attempts).toBe(190);
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      db.close();
      expect(governed.inspectBigTask(bigTaskId).status).toBe("DONE");
  });

  it("rejects malformed bounded findings without changing durable results", () => {
    const scenario = createScenario();
    try {
      const { governed, fresh } = freshRole(scenario);
      const a = fresh.authorization;
      governed.reserveRoleExecutionAttempt(a.authorizationId);
      const input = governed.claimRoleProviderExecution(a.authorizationId);
      governed.bindRoleProviderThread(a.authorizationId, ProviderThreadReferenceSchema.parse({providerId:PROVIDER_ID,providerThreadId:"invalid-result-thread"}));
      governed.validateRoleProviderTurnStart(a.authorizationId, input.preflight.text);
      governed.startRoleProviderRun(a.authorizationId, ProviderRunReferenceSchema.parse({providerId:PROVIDER_ID,providerThreadId:"invalid-result-thread",providerRunId:"invalid-result-run"}), MODEL);
      for (const [outcome, findings] of [
        ["PASS", [hardeningFinding("blocking")]], ["BLOCKING_FAIL", []],
        ["BLOCKING_FAIL", [hardeningFinding("nonblocking", false)]],
        ["BLOCKING_FAIL", [hardeningFinding("duplicate"), hardeningFinding("duplicate")]],
        ["BLOCKING_FAIL", Array.from({length:17},(_,i)=>hardeningFinding(`too-many-${i}`))],
        ["BLOCKING_FAIL", [hardeningFinding("\ud800")]],
        ["BLOCKING_FAIL", [hardeningFinding("embedded\u0000control")]],
      ]) {
        expect(() => governed.persistSuccessfulRoleResult(a.authorizationId, JSON.stringify({schemaVersion:1,outcome,summary:"Bounded assessment.",findings,promotionCandidate:null}),MODEL,ZERO_USAGE)).toThrow();
      }
      const db = new DatabaseSync(scenario.databasePath);
      expect(db.prepare("SELECT count(*) AS count FROM governed_role_results WHERE authorization_id = ?").get(a.authorizationId)).toEqual({count:0});
      db.close();
    } finally { cleanupScenario(scenario); }
  });

  it("blocks candidate changes between persisted execution result and checkpoint reconciliation", () => {
    const scenario = createScenario();
    try {
      const {bigTaskId} = seed(scenario,{profiles:["LOW"]});
      const governed = governedFor(scenario);
      const a = authorized(governed.prepareNextRole(bigTaskId)).authorization;
      governed.reserveRoleExecutionAttempt(a.authorizationId);
      const input = governed.claimRoleProviderExecution(a.authorizationId);
      governed.bindRoleProviderThread(a.authorizationId,ProviderThreadReferenceSchema.parse({providerId:PROVIDER_ID,providerThreadId:"candidate-thread"}));
      governed.validateRoleProviderTurnStart(a.authorizationId, input.preflight.text);
      governed.startRoleProviderRun(a.authorizationId,ProviderRunReferenceSchema.parse({providerId:PROVIDER_ID,providerThreadId:"candidate-thread",providerRunId:"candidate-run"}),MODEL);
      governed.persistSuccessfulRoleResult(a.authorizationId,JSON.stringify({schemaVersion:1,outcome:"READY",summary:"Candidate ready.",findings:[],promotionCandidate:null}),MODEL,ZERO_USAGE);
      writeFileSync(join(input.worktree.ownership.worktreePath,"uncommitted.txt"),"uncommitted\n",{encoding:"utf-8"});
      expect(() => governed.reconcileRoleResult(a.authorizationId)).toThrow(/candidate changed/u);
      expect(scenario.storage.getSubtaskById(a.subtaskId)?.maturity).toBe("NOT_STARTED");
    } finally {cleanupScenario(scenario);}
  });
});

describe("Step 8D exact context, restart and operation matrices", () => {
  it.each([40_000,40_001,64_000,64_001])("measures the final UTF-8 role input at %i bytes", bytes => {
    const baseline = createScenario();
    let overhead: number;
    try {
      const {bigTaskId} = seed(baseline, {profiles:["LOW"], promptSeed:"x"});
      const governed = governedFor(baseline);
      const a = authorized(governed.prepareNextRole(bigTaskId)).authorization;
      governed.reserveRoleExecutionAttempt(a.authorizationId);
      overhead = governed.resolveRoleExecutionInput(a.authorizationId).preflight.utf8Bytes - 1;
    } finally {cleanupScenario(baseline);}
    {
      const scenario = createScenario();
      try {
        const {bigTaskId,subtaskIds} = seed(scenario,{profiles:["LOW"],promptSeed:"x".repeat(bytes-overhead)});
        const governed = governedFor(scenario);
        const prepared = governed.prepareNextRole(bigTaskId);
        if (bytes > 64_000) {
          expect(prepared).toMatchObject({kind:"BLOCKED",reason:"CONTEXT_PREFLIGHT_BLOCKED"});
          expect(scenario.storage.getSubtaskById(subtaskIds[0]!)?.status).toBe("TODO");
          expect(governed.inspectBigTask(bigTaskId).dispatchReceipts).toHaveLength(0);
        } else {
          const a = authorized(prepared).authorization;
          governed.reserveRoleExecutionAttempt(a.authorizationId);
          const input = governed.claimRoleProviderExecution(a.authorizationId);
          expect(Buffer.byteLength(input.preflight.text,"utf8")).toBe(bytes);
          expect(input.preflight).toMatchObject({utf8Bytes:bytes,status:bytes <= 40_000 ? "WITHIN_TARGET" : "ABOVE_TARGET"});
          expect(input.preflight.text).toContain('"instruction":');
          expect(input.preflight.text).toContain('"candidateSha":');
          const db = new DatabaseSync(scenario.databasePath);
          const context = authorized(prepared).receipt.gateEvidenceReferences.map(ref => readGateObservation(db, ref)).find(o => o.kind === "context");
          expect(context?.value).toEqual({authorizationId:a.authorizationId,text:input.preflight.text,hash:createHash("sha256").update(input.preflight.text,"utf8").digest("hex"),bytes});
          db.close();
        }
      } finally {cleanupScenario(scenario);}
    }
  });

  it.each(["LOW","STANDARD","HIGH_RISK_FOUNDATION"] as const)("requires explicit manual authority before any %s gate or dispatch", profile => {
    const scenario = createScenario();
    try {
      const {bigTaskId,subtaskIds}=seed(scenario,{profiles:[profile],startPolicy:"MANUAL",writeEnabled:false});
      const governed=governedFor(scenario);
      expect(governed.prepareNextRole(bigTaskId)).toMatchObject({kind:"HUMAN_REQUIRED",reason:"MANUAL_START_REQUIRED"});
      const db=new DatabaseSync(scenario.databasePath);
      expect(db.prepare("SELECT count(*) AS count FROM governed_gate_sources").get()).toEqual({count:0});
      expect(db.prepare("SELECT count(*) AS count FROM governed_manual_start_authorities").get()).toEqual({count:0});
      const manual=governed.authorizeManualStart(subtaskIds[0]!);
      const a=authorized(governed.prepareNextRole(bigTaskId));
      expect(a.authorization.writeEnabled).toBe(false);
      expect(a.receipt.manualStartAuthorityId).toBe(manual.authorityId);
      expect(a.receipt.gateEvidenceReferences.map(ref=>readGateObservation(db,ref)).find(o=>o.kind==="human-policy")?.value).toEqual({startPolicy:"MANUAL",manualStartAuthorityId:manual.authorityId});
      expect(a.receipt.gateEvidenceReferences.join(" ")).not.toContain("routine-not-required");
      db.close();
    } finally {cleanupScenario(scenario);}
  });

  it.each(["CLAIMED","BOUND","RUNNING","FAILED","INTERRUPTED"])("never infers success after a reopened %s provider attempt", seam => {
    const scenario=createScenario(); let reopened:TaskStorage|undefined;
    try {
      const {bigTaskId}=seed(scenario,{profiles:["LOW"]});
      const governed=governedFor(scenario);
      const a=authorized(governed.prepareNextRole(bigTaskId)).authorization;
      const attempt=governed.reserveRoleExecutionAttempt(a.authorizationId);
      const input = governed.claimRoleProviderExecution(a.authorizationId);
      if (seam!=="CLAIMED") governed.bindRoleProviderThread(a.authorizationId,ProviderThreadReferenceSchema.parse({providerId:PROVIDER_ID,providerThreadId:"restart-thread"}));
      if (["RUNNING","FAILED","INTERRUPTED"].includes(seam)) governed.validateRoleProviderTurnStart(a.authorizationId, input.preflight.text);
      if (["RUNNING","FAILED","INTERRUPTED"].includes(seam)) governed.startRoleProviderRun(a.authorizationId,ProviderRunReferenceSchema.parse({providerId:PROVIDER_ID,providerThreadId:"restart-thread",providerRunId:"restart-run"}),MODEL);
      if (seam==="FAILED" || seam==="INTERRUPTED") scenario.storage.finishExecutionRun({executionRunId:attempt.executionRunId,status:seam});
      scenario.storage.close();
      reopened=openTaskDatabase({databasePath:scenario.databasePath,clock:scenario.now});
      const next=governedFor({...scenario,storage:reopened});
      expect(next.prepareNextRole(bigTaskId).kind).toBe("BLOCKED");
      expect(() => next.claimRoleProviderExecution(a.authorizationId)).toThrow();
      expect(reopened.getSubtaskById(a.subtaskId)?.maturity).toBe("NOT_STARTED");
      const db=new DatabaseSync(scenario.databasePath);
      expect(db.prepare("SELECT count(*) AS count FROM governed_role_results").get()).toEqual({count:0});
      expect(db.prepare("SELECT count(*) AS count FROM governed_provider_claims").get()).toEqual({count:1});
      db.close();
    } finally {reopened?.close();cleanupScenario(scenario);}
  });

  it.each(["FAILED","INTERRUPTED"] as const)("counts started terminal %s with missing usage as unknown, but permits pre-start failure", status => {
    const scenario=createScenario();
    try {
      const {bigTaskId,subtaskIds}=seed(scenario,{profiles:["LOW"]});
      const tid=ChatThreadIdSchema.parse("thr_prestart");
      const rid=ExecutionRunIdSchema.parse("run_prestart");
      scenario.storage.createChatThread({id:tid,subtaskId:subtaskIds[0]!,providerId:PROVIDER_ID});
      scenario.storage.createExecutionRun({id:rid,chatThreadId:tid});
      scenario.storage.failExecutionRunBeforeStart(rid);
      const governed=governedFor(scenario);
      expect(governed.inspectBigTask(bigTaskId).budgets[0]).toMatchObject({allowed:true,totalTokens:0});
      recordUsage(scenario,subtaskIds[0]!,"terminal-missing",null);
      scenario.storage.finishExecutionRun({executionRunId:ExecutionRunIdSchema.parse("run_budget_terminal-missing"),status});
      expect(governed.inspectBigTask(bigTaskId).budgets[0]).toMatchObject({allowed:false,status:"UNKNOWN_USAGE"});
      expect(() => governed.authorizeOneTimeBudgetExtension(subtaskIds[0]!)).toThrow();
    } finally {cleanupScenario(scenario);}
  });

  it("blocks a clean committed candidate drift before provider start", () => {
    const scenario=createScenario();
    try {
      const {bigTaskId}=seed(scenario,{profiles:["LOW"]}); const governed=governedFor(scenario);
      const a=authorized(governed.prepareNextRole(bigTaskId)).authorization;
      governed.reserveRoleExecutionAttempt(a.authorizationId);
      const path=governed.resolveRoleExecutionInput(a.authorizationId).worktree.ownership.worktreePath;
      writeFileSync(join(path,"changed.txt"),"synthetic clean change\n",{encoding:"utf8"});
      git(path,["add","changed.txt"]);git(path,["commit","-m","synthetic candidate drift"]);
      expect(()=>governed.claimRoleProviderExecution(a.authorizationId)).toThrow(/drifted/u);
      expect(scenario.storage.getSubtaskById(a.subtaskId)?.maturity).toBe("NOT_STARTED");
    } finally {cleanupScenario(scenario);}
  });

  it.each(["SAME_SUBTASK","TWO_PROJECTS"])("reconciles deterministic cross-process %s dispatch", async mode => {
    const scenario=createScenario();
    try {
      const first=seed(scenario,{suffix:"_parallel_a",profiles:["LOW"]});
      const second=mode==="SAME_SUBTASK" ? first : seed(scenario,{suffix:"_parallel_b",profiles:["LOW"]});
      governedFor(scenario,[first.bigTaskId,...(mode==="SAME_SUBTASK"?[]:[second.bigTaskId])]);
      const go=join(scenario.directory,"go");
      const ready=[join(scenario.directory,"ready-a"),join(scenario.directory,"ready-b")];
      const paths=[join(scenario.directory,"out-a"),join(scenario.directory,"out-b")];
      const workers=[runDispatchWorker(scenario,first.bigTaskId,ready[0]!,go,paths[0]!),runDispatchWorker(scenario,second.bigTaskId,ready[1]!,go,paths[1]!)];
      await waitForFiles(ready);writeFileSync(go,"go\n",{encoding:"utf8"});
      const exits=await Promise.all(workers);expect(exits.map(x=>x.status),JSON.stringify(exits)).toEqual([0,0]);
      const outcomes=paths.map(path=>JSON.parse(readFileSync(path,"utf8")) as {kind:string;receiptId:string;authorizationId:string});
      expect(outcomes.map(x=>x.kind)).toEqual(["ROLE_AUTHORIZED","ROLE_AUTHORIZED"]);
      if(mode==="SAME_SUBTASK") expect(outcomes[0]).toEqual(outcomes[1]);
      else expect(outcomes[0]!.receiptId).not.toBe(outcomes[1]!.receiptId);
      const db=new DatabaseSync(scenario.databasePath);
      expect(db.prepare("SELECT count(*) AS count FROM governed_dispatch_receipts").get()).toEqual({count:mode==="SAME_SUBTASK"?1:2});
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);db.close();
    } finally {cleanupScenario(scenario);}
  },20_000);
});

describe("Step 8D durable source and completion checks", () => {
  withFreshRoleTest("keeps Fresh QA, Repair and Focused Re-QA free of Active Context, Digest and prior reasoning", ({scenario,bigTaskId,subtaskIds,governed,fresh})=>{
      const scope=ContextScopeSchema.parse({scopeType:"SUBTASK",projectId:"prj_governed",bigTaskId,subtaskId:subtaskIds[0]});
      scenario.storage.createContextItem(makeContextItem("ctx_reasoning_canary",scope,{body:"BUILDER_RAW_CANARY HARDENER_RAW_CANARY REPAIR_RAW_CANARY PRIOR_HANDOFF_CANARY SELF_ASSESSMENT_CANARY"}));
      scenario.storage.createContextDigest(makeContextDigest("dgt_reasoning_canary",scope,{body:"DIGEST_CANARY RAW_HISTORY_CANARY"}));
      for(const [index,role] of ["FRESH_QA","REPAIR","FOCUSED_RE_QA"].entries()) {
        const prepared=index===0?fresh:authorized(governed.prepareNextRole(bigTaskId));
        expect(prepared.authorization.role).toBe(role);
        governed.reserveRoleExecutionAttempt(prepared.authorization.authorizationId);
        const input=governed.resolveRoleExecutionInput(prepared.authorization.authorizationId);
        expect(input.preflight.text).not.toMatch(/(?:BUILDER_RAW|HARDENER_RAW|REPAIR_RAW|PRIOR_HANDOFF|SELF_ASSESSMENT|DIGEST|RAW_HISTORY)_CANARY/u);
        expect(input.preflight.text).toContain("Durable authority is exact.");
        expect(input.preflight.text).toContain("Keep changes bounded.");
        expect(input.preflight.text).toContain(prepared.authorization.candidateSha);
        completeRole(governed,prepared,index===0?"BLOCKING_FAIL":index===1?"READY":"PASS",index===0?[hardeningFinding("target-a"),hardeningFinding("target-b")]:[]);
      }
      expect(governed.prepareNextRole(bigTaskId).kind).toBe("BIG_TASK_COMPLETE");
  });

  for (const [table,mutation] of [
    ["governed_findings","affected_contract = 'contract/unrelated'"],
    ["governed_finding_resolutions","role_result_id = (SELECT result_id FROM governed_role_results WHERE role = 'HARDEN')"],
    ["governed_provider_claims","target_finding_ids = '[]' WHERE authorization_id IN (SELECT authorization_id FROM governed_role_authorizations WHERE role = 'FOCUSED_RE_QA')"],
    ["governed_promotion_candidates","summary = 'Changed candidate conclusion.'"],
    ["governed_gate_sources","source_reference = 'wrong-gate-source'"],
    ["governed_big_task_completion_receipts","subtask_count = 2"],
  ] as const) {
    withPreparedScenario(`rejects ${table} source corruption after reopen with original schema restored`,scenario=>{
      const shortPath = ["governed_promotion_candidates", "governed_gate_sources", "governed_big_task_completion_receipts"].includes(table);
      const {bigTaskId}=seed(scenario,{profiles:[shortPath ? "STANDARD" : "HIGH_RISK_FOUNDATION"]});
      const governed=governedFor(scenario);
      completeRole(governed,authorized(governed.prepareNextRole(bigTaskId)),"READY",[],undefined,"Pending candidate conclusion.");
      completeRole(governed,authorized(governed.prepareNextRole(bigTaskId)),"PASS");
      return {shortPath,bigTaskId,governed};
    },({scenario,shortPath,bigTaskId,governed})=>{
      let reopened:TaskStorage|undefined;
      try {
      if (!shortPath) {
        completeRole(governed,authorized(governed.prepareNextRole(bigTaskId)),"BLOCKING_FAIL",[hardeningFinding("A"),hardeningFinding("B")]);
        completeRole(governed,authorized(governed.prepareNextRole(bigTaskId)),"READY");
        completeRole(governed,authorized(governed.prepareNextRole(bigTaskId)),"PASS");
      }
      governed.prepareNextRole(bigTaskId);
      scenario.storage.close();
      const db=new DatabaseSync(scenario.databasePath);db.exec("PRAGMA foreign_keys = OFF");
      const triggers=db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND tbl_name=?").all(table);
      for(const t of triggers) db.exec(`DROP TRIGGER "${t.name}"`);
      db.exec(`UPDATE ${table} SET ${mutation}`);
      for(const t of triggers) db.exec(String(t.sql));db.close();
      reopened=openTaskDatabase({databasePath:scenario.databasePath,clock:scenario.now});
      const next=governedFor({...scenario,storage:reopened});
      expect(()=>next.prepareNextRole(bigTaskId)).toThrow();
      expect(()=>next.inspectBigTask(bigTaskId)).toThrow();
      } finally {reopened?.close();}
    });
  }

  it.each([
    ["subtasks","status = 'TODO'"],
    ["subtasks","maturity = 'NOT_STARTED'"],
    ["durable_workflow_transitions","resulting_stage = 'EXECUTE'"],
  ])("rejects completed Big Task with corrupted %s canonical state",(table,mutation)=>{
    const scenario=createScenario();
    try {
      const {bigTaskId}=seed(scenario,{profiles:["LOW"]});const governed=governedFor(scenario);
      completeRole(governed,authorized(governed.prepareNextRole(bigTaskId)),"READY");
      completeRole(governed,authorized(governed.prepareNextRole(bigTaskId)),"PASS");
      expect(governed.prepareNextRole(bigTaskId).kind).toBe("BIG_TASK_COMPLETE");
      const db=new DatabaseSync(scenario.databasePath);
      const triggers=db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND tbl_name=?").all(table);
      for(const t of triggers)db.exec(`DROP TRIGGER "${t.name}"`);
      db.exec(`UPDATE ${table} SET ${mutation}`);
      for(const t of triggers)db.exec(String(t.sql));db.close();
      expect(()=>governed.prepareNextRole(bigTaskId)).toThrow();
    } finally {cleanupScenario(scenario);}
  });
});


describe("Step 8D explicit operator races",()=>{
  it.each(["EXTENSION_REPLAY","MANUAL_VS_DISPATCH"])("serializes %s without duplicated authority",async mode=>{
    const scenario=createScenario();
    try {
      const {bigTaskId,subtaskIds}=seed(scenario,{profiles:["LOW"],startPolicy:mode==="MANUAL_VS_DISPATCH"?"MANUAL":"WHEN_READY"});
      if(mode==="EXTENSION_REPLAY")recordUsage(scenario,subtaskIds[0]!,"extension-race",120_000);
      governedFor(scenario,[bigTaskId]);
      const go=join(scenario.directory,"operator-go");const ready=[join(scenario.directory,"operator-a"),join(scenario.directory,"operator-b")];
      const paths=[join(scenario.directory,"result-a"),join(scenario.directory,"result-b")];
      const operations=mode==="EXTENSION_REPLAY"?["EXTEND","EXTEND"]:["MANUAL","PREPARE"];
      const workers=operations.map((operation,index)=>runDispatchWorker(scenario,bigTaskId,ready[index]!,go,paths[index]!,operation));
      await waitForFiles(ready);writeFileSync(go,"go\n",{encoding:"utf8"});
      const exits=await Promise.all(workers);expect(exits.map(x=>x.status),JSON.stringify(exits)).toEqual([0,0]);
      const outcomes=paths.map(path=>JSON.parse(readFileSync(path,"utf8")) as {kind:string;authorityId?:string});
      const db=new DatabaseSync(scenario.databasePath);
      if(mode==="EXTENSION_REPLAY"){
        expect(outcomes[0]).toEqual(outcomes[1]);expect(outcomes[0]!.kind).toBe("OPERATOR_AUTHORIZED");
        expect(db.prepare("SELECT count(*) AS count FROM governed_budget_extensions").get()).toEqual({count:1});
        expect(governedFor(scenario).inspectBigTask(bigTaskId).budgets[0]).toMatchObject({effectiveLimitTokens:160_000});
      }else{
        expect(outcomes[0]!.kind).toBe("OPERATOR_AUTHORIZED");expect(["HUMAN_REQUIRED","ROLE_AUTHORIZED"]).toContain(outcomes[1]!.kind);
        const prepared=authorized(governedFor(scenario).prepareNextRole(bigTaskId));
        expect(prepared.receipt.manualStartAuthorityId).toBe(outcomes[0]!.authorityId);
        expect(prepared.receipt.gateEvidenceReferences.join(" ")).not.toContain("routine-not-required");
      }
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);db.close();
    }finally{cleanupScenario(scenario);}
  },20_000);
});


it("does not expose governed checkpoint replay as a public authority path",()=>{
  const scenario=createScenario();
  try {
    const {bigTaskId,subtaskIds}=seed(scenario,{profiles:["LOW"]});const governed=governedFor(scenario);
    completeRole(governed,authorized(governed.prepareNextRole(bigTaskId)),"READY");
    const checkpoint=scenario.storage.listSubtaskImplementationCheckpoints(subtaskIds[0]!)[0]!;
    expect(checkpoint).toBeDefined();
    expect(()=>scenario.storage.completeSubtaskImplementation({subtaskId:subtaskIds[0]!,checkpoint})).toThrow(/internal execution path/u);
    completeRole(governed,authorized(governed.prepareNextRole(bigTaskId)),"PASS");
    expect(governed.prepareNextRole(bigTaskId).kind).toBe("BIG_TASK_COMPLETE");
  }finally{cleanupScenario(scenario);}
});


describe("Step 8D post-FQA repair", () => {
  it.each(["input_hash = '" + "a".repeat(64) + "'", "input_bytes = input_bytes + 1"])("rejects inconsistent provider claim %s", mutation => {
    const scenario=createScenario();
    try {
      const {bigTaskId}=seed(scenario); const governed=governedFor(scenario);
      const a=authorized(governed.prepareNextRole(bigTaskId)).authorization;
      governed.reserveRoleExecutionAttempt(a.authorizationId);
      const input = governed.claimRoleProviderExecution(a.authorizationId);
      const thread=ProviderThreadReferenceSchema.parse({providerId:PROVIDER_ID,providerThreadId:"repro-thread"});
      governed.bindRoleProviderThread(a.authorizationId,thread);
      governed.validateRoleProviderTurnStart(a.authorizationId, input.preflight.text);
      governed.startRoleProviderRun(a.authorizationId,ProviderRunReferenceSchema.parse({...thread,providerRunId:"repro-run"}),MODEL);
      corrupt(scenario,"governed_provider_claims",mutation);
      expect(()=>governed.persistSuccessfulRoleResult(a.authorizationId,JSON.stringify({schemaVersion:1,outcome:"READY",summary:"ready",findings:[],promotionCandidate:null}),MODEL,ZERO_USAGE)).toThrow();
    } finally {cleanupScenario(scenario);}
  });
  it("rejects jointly replaced gate references",()=>{
    const scenario=createScenario();
    try {
      const {bigTaskId}=seed(scenario);const governed=governedFor(scenario);
      const prepared=authorized(governed.prepareNextRole(bigTaskId));
      const refs=[...prepared.receipt.gateEvidenceReferences]; refs[0]="ggo_"+"f".repeat(48);refs.sort();
      corrupt(scenario,"governed_dispatch_receipts",`gate_evidence_references = '${JSON.stringify(refs)}'`);
      corrupt(scenario,"governed_dispatch_gate_snapshots",`gate_references = '${JSON.stringify(refs)}'`);
      expect(()=>governed.inspectBigTask(bigTaskId)).toThrow();
    } finally {cleanupScenario(scenario);}
  });
  it("blocks new candidate commit at Big Task completion",()=>{
    const scenario=createScenario();
    try {
      const {bigTaskId}=seed(scenario);const governed=governedFor(scenario);
      const a=authorized(governed.prepareNextRole(bigTaskId));
      completeRole(governed,a,"READY");completeRole(governed,authorized(governed.prepareNextRole(bigTaskId)),"PASS");
      const path=join(scenario.worktreeRoot,a.authorization.worktreeOwnershipId);
      git(path,["commit","--allow-empty","-m","after assessment"]);
      expect(()=>governed.prepareNextRole(bigTaskId)).toThrow();
    } finally {cleanupScenario(scenario);}
  });
  it.each(["STANDARD","HIGH_RISK_FOUNDATION","LOW"] as const)("progresses serial %s to STANDARD across reopen",profile=>{
    const scenario=createScenario();let reopened:TaskStorage|undefined;
    try {
      const {bigTaskId,subtaskIds}=seed(scenario,{profiles:[profile,"STANDARD"]});let governed=governedFor(scenario);
      let first: Extract<GovernedPreparationResult,{kind:"ROLE_AUTHORIZED"}> | undefined;
      for(const outcome of profile==="HIGH_RISK_FOUNDATION"?["READY","PASS","PASS"] as const:["READY","PASS"] as const) {
        const prepared=authorized(governed.prepareNextRole(bigTaskId));first ??= prepared;completeRole(governed,prepared,outcome);
      }
      scenario.storage.close();reopened=openTaskDatabase({databasePath:scenario.databasePath,clock:scenario.now});
      governed=governedFor({...scenario,storage:reopened});
      const second=authorized(governed.prepareNextRole(bigTaskId));
      expect(second.authorization.subtaskId).toBe(subtaskIds[1]);
      expect(reopened.getSubtaskById(subtaskIds[1]!)?.status).toBe("IN_PROGRESS");
      const db=new DatabaseSync(scenario.databasePath);
      const capacity=[first!,second].map(p=>p.receipt.gateEvidenceReferences.map(ref=>({ref,observation:readGateObservation(db,ref)})).find(o=>o.observation.kind==="concurrency")!);
      expect(capacity[0]!.ref).not.toBe(capacity[1]!.ref);
      for(const source of capacity)expect(source.observation.value).toMatchObject({activeCoding:0,activeWrite:0});
      expect(db.prepare("SELECT status FROM governed_dispatch_receipts WHERE subtask_id=?").get(subtaskIds[0]!)).toEqual({status:"COMPLETED"});
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);db.close();
    } finally {reopened?.close();cleanupScenario(scenario);}
  });
  it("rejects changed promotion conclusion on semantic replay",()=>{
    const scenario=createScenario();
    try {
      const {bigTaskId}=seed(scenario);const governed=governedFor(scenario);
      const a=authorized(governed.prepareNextRole(bigTaskId));completeRole(governed,a,"READY",[],undefined,"Conclusion A");
      const exact=JSON.stringify({schemaVersion:1,outcome:"READY",summary:"EXECUTE completed.",findings:[],promotionCandidate:"Conclusion A"});
      const result=governed.persistSuccessfulRoleResult(a.authorization.authorizationId,exact,MODEL,ZERO_USAGE);
      expect(governed.persistSuccessfulRoleResult(a.authorization.authorizationId,exact,MODEL,ZERO_USAGE)).toEqual(result);
      expect(()=>governed.persistSuccessfulRoleResult(a.authorization.authorizationId,JSON.stringify({schemaVersion:1,outcome:"READY",summary:"EXECUTE completed.",findings:[],promotionCandidate:"Conclusion B"}),MODEL,ZERO_USAGE)).toThrow();
    } finally {cleanupScenario(scenario);}
  });
});

function corrupt(scenario: Scenario, table: string, mutation: string): void {
  const db=new DatabaseSync(scenario.databasePath);
  db.exec("PRAGMA foreign_keys = OFF");
  const triggers=db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND tbl_name=?").all(table);
  try {
    for(const t of triggers) db.exec(`DROP TRIGGER "${t.name}"`);
    db.exec(`UPDATE ${table} SET ${mutation}`);
  } finally {for(const t of triggers) db.exec(String(t.sql));db.close();}
}

describe("Step 8D occurrence ownership matrix", () => {
  it.each(GATE_KINDS.flatMap(kind => ["subtaskId", "bigTaskId", "projectId", "planRevision", "candidateBinding", "candidateSha", "workflowSequence", "workflowStage", "occurrenceId"].map(field => ({kind, field}))))("rejects $kind observation with changed $field even when references agree", ({kind, field}) => {
      const scenario=createScenario();let reopened:TaskStorage|undefined;
      try {
        const {bigTaskId}=seed(scenario,{suffix:`_${kind.replaceAll("-", "_")}_${field.toLowerCase()}`});const governed=governedFor(scenario);
        const receipt=authorized(governed.prepareNextRole(bigTaskId)).receipt;
        const db=new DatabaseSync(scenario.databasePath);
        const exact=receipt.gateEvidenceReferences.map(ref=>({ref,observation:readGateObservation(db,ref)})).find(o=>o.observation.kind===kind)!;
        db.close();
        const owner={...exact.observation.owner,[field]:(field==="workflowSequence"||field==="planRevision")?99:field==="candidateSha"?"b".repeat(40):field==="workflowStage"?"VERIFY":`unrelated_${field}`};
        const altered={...exact.observation,owner};const ref=provenanceId("ggo",altered);
        const escaped=JSON.stringify(altered).replaceAll("'","''");
        corrupt(scenario,"governed_gate_observations",`source_reference='${ref}', payload='${escaped}', subtask_id='${owner.subtaskId}', workflow_sequence=${owner.workflowSequence} WHERE source_reference='${exact.ref}'`);
        const refs=receipt.gateEvidenceReferences.map(r=>r===exact.ref?ref:r).sort();
        corrupt(scenario,"governed_dispatch_receipts",`gate_evidence_references='${JSON.stringify(refs)}'`);
        corrupt(scenario,"governed_dispatch_gate_snapshots",`gate_references='${JSON.stringify(refs)}'`);
        expect(()=>governed.inspectBigTask(bigTaskId)).toThrow();
        scenario.storage.close();reopened=openTaskDatabase({databasePath:scenario.databasePath,clock:scenario.now});
        expect(()=>governedFor({...scenario,storage:reopened!}).inspectBigTask(bigTaskId)).toThrow();
      }finally{reopened?.close();cleanupScenario(scenario);}
    });
});

describe("Step 8D exact provider provenance and budget",()=>{
  it.each([
    ["hash and bytes",`input_hash='${"b".repeat(64)}',input_bytes=input_bytes+1`],
    ["targets","target_finding_ids='[\"foreign-finding\"]'"],
    ["execution run","execution_run_id='run_budget_sibling'"],
    ["candidate",`candidate_sha='${"b".repeat(40)}'`],
  ])("rejects changed %s before turn and after reopen",(_name,mutation)=>{
    const scenario=createScenario();let reopened:TaskStorage|undefined;
    try {
      const {bigTaskId,subtaskIds}=seed(scenario);const governed=governedFor(scenario);
      recordUsage(scenario,subtaskIds[0]!,"sibling",0);
      const a=authorized(governed.prepareNextRole(bigTaskId)).authorization;
      governed.reserveRoleExecutionAttempt(a.authorizationId);governed.claimRoleProviderExecution(a.authorizationId);
      corrupt(scenario,"governed_provider_claims",mutation!);
      expect(()=>governed.bindRoleProviderThread(a.authorizationId,ProviderThreadReferenceSchema.parse({providerId:PROVIDER_ID,providerThreadId:"exact-test"}))).toThrow();
      scenario.storage.close();reopened=openTaskDatabase({databasePath:scenario.databasePath,clock:scenario.now});
      expect(()=>governedFor({...scenario,storage:reopened!}).inspectBigTask(bigTaskId)).toThrow();
    }finally{reopened?.close();cleanupScenario(scenario);}
  });
  it.each([
    {total:119_999,extension:false,allowed:true},
    {total:120_000,extension:false,allowed:false},
    {total:120_000,extension:true,allowed:true},
    {total:160_000,extension:false,allowed:false},
    {total:null,extension:false,allowed:false},
  ])("rechecks changed aggregate budget $total (extension $extension)",({total,extension,allowed})=>{
    const scenario=createScenario();
    try {
      const {bigTaskId,subtaskIds}=seed(scenario);const governed=governedFor(scenario);
      recordUsage(scenario,subtaskIds[0]!,"freshness",1);
      const a=authorized(governed.prepareNextRole(bigTaskId)).authorization;
      governed.reserveRoleExecutionAttempt(a.authorizationId);const input=governed.claimRoleProviderExecution(a.authorizationId);
      governed.bindRoleProviderThread(a.authorizationId,ProviderThreadReferenceSchema.parse({providerId:PROVIDER_ID,providerThreadId:"budget-freshness"}));
      corrupt(scenario,"execution_runs",total===null
        ? "usage_present=0,input_tokens=NULL,cached_input_tokens=NULL,output_tokens=NULL,reasoning_tokens=NULL,total_tokens=NULL WHERE id='run_budget_freshness'"
        : `input_tokens=${total},total_tokens=${total} WHERE id='run_budget_freshness'`);
      if(extension) governed.authorizeOneTimeBudgetExtension(subtaskIds[0]!);
      const start=()=>governed.validateRoleProviderTurnStart(a.authorizationId,input.preflight.text);
      if(allowed)expect(start).not.toThrow();else expect(start).toThrow();
    }finally{cleanupScenario(scenario);}
  });
  it("binds the exact claimed text and rejects a second turn or altered text",()=>{
    const scenario=createScenario();
    try{
      const {bigTaskId}=seed(scenario);const governed=governedFor(scenario);const a=authorized(governed.prepareNextRole(bigTaskId)).authorization;
      const attempt=governed.reserveRoleExecutionAttempt(a.authorizationId);const input=governed.claimRoleProviderExecution(a.authorizationId);
      const db=new DatabaseSync(scenario.databasePath);const row=db.prepare("SELECT * FROM governed_provider_claims").get()!;
      expect(row).toMatchObject({authorization_id:a.authorizationId,execution_run_id:attempt.executionRunId,candidate_sha:a.candidateSha,
        input_hash:createHash("sha256").update(input.preflight.text,"utf8").digest("hex"),input_bytes:Buffer.byteLength(input.preflight.text,"utf8"),target_finding_ids:"[]"});db.close();
      governed.bindRoleProviderThread(a.authorizationId,ProviderThreadReferenceSchema.parse({providerId:PROVIDER_ID,providerThreadId:"exact-input"}));
      expect(()=>governed.validateRoleProviderTurnStart(a.authorizationId,input.preflight.text+"stale")).toThrow();
      expect(()=>governed.validateRoleProviderTurnStart(a.authorizationId,input.preflight.text)).not.toThrow();
      expect(()=>governed.validateRoleProviderTurnStart(a.authorizationId,input.preflight.text)).toThrow();
    }finally{cleanupScenario(scenario);}
  });
});

describe("Step 8D final candidate completion matrix",()=>{
  it.each(["unchanged","dirty","released","handoff","reopen"])("checks %s candidate authority",mode=>{
    const scenario=createScenario();let reopened:TaskStorage|undefined;
    try{
      const {bigTaskId}=seed(scenario);let governed=governedFor(scenario);const a=authorized(governed.prepareNextRole(bigTaskId));
      completeRole(governed,a,"READY");completeRole(governed,authorized(governed.prepareNextRole(bigTaskId)),"PASS");
      const path=join(scenario.worktreeRoot,a.authorization.worktreeOwnershipId);
      if(mode==="dirty")writeFileSync(join(path,"after-assessment.txt"),"changed",{encoding:"utf8"});
      if(mode==="released")createWorktreeOwnershipManagerForTesting(scenario.storage,{worktreeRoot:scenario.worktreeRoot,idGenerator:()=>`wt_${"d".repeat(32)}`}).releaseOwnedWorktreeForSubtask(a.authorization.subtaskId);
      if(mode==="handoff")corrupt(scenario,"governed_handoffs",`candidate_sha='${"c".repeat(40)}'`);
      if(mode==="reopen"){
        scenario.storage.close();reopened=openTaskDatabase({databasePath:scenario.databasePath,clock:scenario.now});governed=governedFor({...scenario,storage:reopened});
      }
      if(mode==="unchanged"||mode==="reopen"){
        const result=governed.prepareNextRole(bigTaskId);expect(result.kind).toBe("BIG_TASK_COMPLETE");expect(governed.prepareNextRole(bigTaskId)).toEqual(result);
      }else expect(()=>governed.prepareNextRole(bigTaskId)).toThrow();
    }finally{reopened?.close();cleanupScenario(scenario);}
  });
});


it("rejects a changed bounded Repair target after claim",()=>{
  const scenario=createScenario();
  try{
    const {bigTaskId,governed,fresh}=freshRole(scenario);
    completeRole(governed,fresh,"BLOCKING_FAIL",[hardeningFinding("original-target")]);
    const a=authorized(governed.prepareNextRole(bigTaskId)).authorization;
    governed.reserveRoleExecutionAttempt(a.authorizationId);const input=governed.claimRoleProviderExecution(a.authorizationId);
    governed.bindRoleProviderThread(a.authorizationId,ProviderThreadReferenceSchema.parse({providerId:PROVIDER_ID,providerThreadId:"bounded-target-drift"}));
    corrupt(scenario,"governed_findings","reproduction='A different bounded target.'");
    expect(()=>governed.validateRoleProviderTurnStart(a.authorizationId,input.preflight.text)).toThrow();
    const db=new DatabaseSync(scenario.databasePath);expect(db.prepare("SELECT count(*) AS count FROM governed_provider_turn_starts WHERE authorization_id=?").get(a.authorizationId)).toEqual({count:0});db.close();
  }finally{cleanupScenario(scenario);}
});


// Each test gets a newly constructed private repository/database. Setup is a
// separately bounded phase; no fixture is shared or reused by another test.
function withPreparedScenario<T>(name: string, prepare: (scenario: Scenario) => T, body: (fixture: T & {scenario: Scenario}) => void | Promise<void>): void {
  describe(name, () => {
    const fixtures = new WeakMap<object, T & {scenario: Scenario}>();
    beforeEach(context => {
      const scenario=createScenario();
      try { fixtures.set(context,{scenario,...prepare(scenario)}); }
      catch(error){cleanupScenario(scenario);throw error;}
    });
    afterEach(context=>{const fixture=fixtures.get(context);if(fixture)cleanupScenario(fixture.scenario);});
    it("preserves the exact bounded outcome and history", context=>body(fixtures.get(context)!));
  });
}
function withFreshRoleTest(name: string, body: (fixture: ReturnType<typeof freshRole> & {scenario: Scenario}) => void): void {
  withPreparedScenario(name, scenario=>freshRole(scenario), body);
}

it("upgrades predecessor-format claims without inventing input or gate provenance",()=>{
  const scenario=createScenario();let reopened:TaskStorage|undefined;
  try{
    const {bigTaskId}=seed(scenario);const governed=governedFor(scenario);const a=authorized(governed.prepareNextRole(bigTaskId)).authorization;
    governed.reserveRoleExecutionAttempt(a.authorizationId);governed.claimRoleProviderExecution(a.authorizationId);
    scenario.storage.close();
    const db=new DatabaseSync(scenario.databasePath);
    const claim=db.prepare("SELECT * FROM governed_provider_claims").get();
    // Reconstruct the exact prior schema, preserving predecessor-format rows.
    // No parsing or backfill may upgrade these records to the new source model.
    db.exec("PRAGMA foreign_keys = OFF");
    db.exec("DROP TABLE governed_provider_turn_starts");
    db.exec("DROP TABLE governed_provider_input_observations");
    db.exec("DROP TABLE governed_gate_observations");
    db.exec("DELETE FROM __drizzle_migrations WHERE id=(SELECT max(id) FROM __drizzle_migrations)");
    db.close();
    for(let i=0;i<2;i++){
      reopened=openTaskDatabase({databasePath:scenario.databasePath,clock:scenario.now});
      expect(()=>governedFor({...scenario,storage:reopened!}).inspectBigTask(bigTaskId)).toThrow();
      const inspect=new DatabaseSync(scenario.databasePath);
      expect(inspect.prepare("SELECT * FROM governed_provider_claims").get()).toEqual(claim);
      for(const table of ["governed_provider_turn_starts","governed_provider_input_observations","governed_gate_observations"])
        expect(inspect.prepare(`SELECT count(*) AS count FROM ${table}`).get()).toEqual({count:0});
      expect(inspect.prepare("PRAGMA foreign_key_check").all()).toEqual([]);inspect.close();reopened.close();
    }
  }finally{reopened?.close();cleanupScenario(scenario);}
});

it("keeps a completed Subtask's assessed identity when its sibling candidate changes",()=>{
  const scenario=createScenario();
  try{
    const {bigTaskId,subtaskIds}=seed(scenario,{profiles:["STANDARD","STANDARD"]});
    const governed=governedFor(scenario,[bigTaskId]);
    const first=authorized(governed.prepareNextRole(bigTaskId));completeRole(governed,first,"READY");
    const assessment=authorized(governed.prepareNextRole(bigTaskId));completeRole(governed,assessment,"PASS");
    const manager=createWorktreeOwnershipManagerForTesting(scenario.storage,{worktreeRoot:scenario.worktreeRoot,idGenerator:()=>`wt_${"e".repeat(32)}`});
    const sibling=manager.resolveActiveOwnedWorktreeForSubtask(subtaskIds[1]!);
    git(sibling.ownership.worktreePath,["commit","--allow-empty","-m","sibling candidate"]);
    const unchanged=governed.persistSuccessfulRoleResult(assessment.authorization.authorizationId,JSON.stringify({schemaVersion:1,outcome:"PASS",summary:"VERIFY completed.",findings:[],promotionCandidate:null}),MODEL,ZERO_USAGE);
    expect(unchanged.candidateSha).toBe(first.authorization.candidateSha);
    const next=authorized(governed.prepareNextRole(bigTaskId));
    expect(next.authorization.subtaskId).toBe(subtaskIds[1]);
    expect(next.authorization.candidateSha).not.toBe(unchanged.candidateSha);
  }finally{cleanupScenario(scenario);}
});

describe.each(["SUBTASK","BIG_TASK","PROJECT"] as const)("Step 8D legitimate %s gate-source substitution", relation=>{
  for(const kind of GATE_KINDS){
    withPreparedScenario(`rejects a valid sibling ${kind} source`,scenario=>{
      const first=seed(scenario,{suffix:"_owner",profiles:relation==="SUBTASK"?["LOW","LOW"]:["LOW"],writeEnabled:false});
      const secondBigTask=relation==="SUBTASK"?first.bigTaskId:seed(scenario,{
        suffix:"_sibling",projectId:relation==="BIG_TASK"?"prj_governed_owner":"prj_governed_sibling",profiles:["LOW"],writeEnabled:false,
      }).bigTaskId;
      const governed=governedFor(scenario);
      const firstRole=authorized(governed.prepareNextRole(first.bigTaskId));
      const aid=firstRole.authorization.authorizationId;
      governed.reserveRoleExecutionAttempt(aid);const input=governed.claimRoleProviderExecution(aid);
      const thread=ProviderThreadReferenceSchema.parse({providerId:PROVIDER_ID,providerThreadId:"sibling-source-thread"});
      governed.bindRoleProviderThread(aid,thread);governed.validateRoleProviderTurnStart(aid,input.preflight.text);
      governed.startRoleProviderRun(aid,ProviderRunReferenceSchema.parse({...thread,providerRunId:"sibling-source-run"}),MODEL);
      if(relation==="SUBTASK") {
        governed.persistSuccessfulRoleResult(aid,JSON.stringify({schemaVersion:1,outcome:"READY",summary:"Source candidate ready.",findings:[],promotionCandidate:null}),MODEL,ZERO_USAGE);
        governed.reconcileRoleResult(aid);
        completeRole(governed,authorized(governed.prepareNextRole(first.bigTaskId)),"PASS");
      }
      const secondRole=authorized(governed.prepareNextRole(secondBigTask));
      expect(secondRole.authorization.subtaskId).not.toBe(firstRole.authorization.subtaskId);
      return {governed,bigTaskId:first.bigTaskId,firstRole,secondRole};
    },({scenario,governed,bigTaskId,firstRole,secondRole})=>{
      const db=new DatabaseSync(scenario.databasePath);
      const source=(receipt: typeof firstRole.receipt)=>receipt.gateEvidenceReferences.find(ref=>readGateObservation(db,ref).kind===kind)!;
      const original=source(firstRole.receipt);const sibling=source(secondRole.receipt);
      expect(sibling).not.toBe(original);expect(readGateObservation(db,sibling).owner.subtaskId).toBe(secondRole.authorization.subtaskId);
      db.close();
      const refs=firstRole.receipt.gateEvidenceReferences.map(ref=>ref===original?sibling:ref).sort();
      corrupt(scenario,"governed_dispatch_receipts",`gate_evidence_references='${JSON.stringify(refs)}' WHERE receipt_id='${firstRole.receipt.receiptId}'`);
      corrupt(scenario,"governed_dispatch_gate_snapshots",`gate_references='${JSON.stringify(refs)}' WHERE receipt_id='${firstRole.receipt.receiptId}'`);
      expect(()=>governed.inspectBigTask(bigTaskId)).toThrow();
      scenario.storage.close();const reopened=openTaskDatabase({databasePath:scenario.databasePath,clock:scenario.now});
      try{expect(()=>governedFor({...scenario,storage:reopened}).inspectBigTask(bigTaskId)).toThrow();}finally{reopened.close();}
    });
  }
});
