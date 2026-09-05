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

import { describe, expect, it } from "vitest";

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
  let next = 0;
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
  governed.claimRoleProviderExecution(authorization.authorizationId);
  const providerThread = ProviderThreadReferenceSchema.parse({
    providerId: PROVIDER_ID,
    providerThreadId: `provider-thread-${authorization.workflowSequence}`,
  });
  governed.bindRoleProviderThread(authorization.authorizationId, providerThread);
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

  it("runs one bounded HIGH_RISK repair path with focused no-write re-QA", () => {
    const scenario = createScenario();
    try {
      const { bigTaskId } = seed(scenario, {
        profiles: ["HIGH_RISK_FOUNDATION"],
      });
      const governed = governedFor(scenario);
      completeRole(governed, authorized(governed.prepareNextRole(bigTaskId)), "READY");
      const harden = authorized(governed.prepareNextRole(bigTaskId));
      expect(harden.authorization.role).toBe("HARDEN");
      completeRole(governed, harden, "PASS");
      const fresh = authorized(governed.prepareNextRole(bigTaskId));
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
    } finally {
      cleanupScenario(scenario);
    }
  });

  it("stops a failed focused Re-QA at HUMAN_REQUIRED without a second repair", () => {
    const scenario = createScenario();
    try {
      const { bigTaskId, subtaskIds } = seed(scenario, {
        profiles: ["HIGH_RISK_FOUNDATION"],
      });
      const governed = governedFor(scenario);
      completeRole(governed, authorized(governed.prepareNextRole(bigTaskId)), "READY");
      completeRole(governed, authorized(governed.prepareNextRole(bigTaskId)), "PASS");
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
    } finally {
      cleanupScenario(scenario);
    }
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
      governed.claimRoleProviderExecution(resumed.authorization.authorizationId);
      governed.bindRoleProviderThread(resumed.authorization.authorizationId, providerThread);
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
  completeRole(governed, authorized(governed.prepareNextRole(seeded.bigTaskId)), "PASS");
  return { ...seeded, governed, fresh: authorized(governed.prepareNextRole(seeded.bigTaskId)) };
};

describe("Step 8D comprehensive hardening regressions", () => {
  it.each([
    [hardeningFinding("A"), hardeningFinding("B")],
    [hardeningFinding("C"), hardeningFinding("D", false)],
    Array.from({ length: 16 }, (_, i) => hardeningFinding(`BATCH-${i}`, i < 12)),
  ])("repairs and retests the exact bounded Fresh-QA batch %# in one cycle", (...findings) => {
    const scenario = createScenario();
    try {
      const { governed, bigTaskId, subtaskIds, fresh } = freshRole(scenario);
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
    } finally { cleanupScenario(scenario); }
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

  it("persists a new bounded blocker found by focused Re-QA and escalates without another repair", () => {
    const scenario = createScenario();
    try {
      const { governed, bigTaskId, fresh } = freshRole(scenario);
      completeRole(governed, fresh, "BLOCKING_FAIL", [hardeningFinding("FIRST"), hardeningFinding("SECOND")]);
      completeRole(governed, authorized(governed.prepareNextRole(bigTaskId)), "READY");
      expect(completeRole(governed, authorized(governed.prepareNextRole(bigTaskId)), "BLOCKING_FAIL",
        [hardeningFinding("FIRST"), hardeningFinding("NEW-REPAIRED-SURFACE"), hardeningFinding("DEFER", false)]).kind).toBe("HUMAN_REQUIRED");
      expect(governed.prepareNextRole(bigTaskId)).toMatchObject({ kind: "HUMAN_REQUIRED", reason: "REPAIR_REQA_EXHAUSTED" });
    } finally { cleanupScenario(scenario); }
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

  it("rejects replacement, upsert, update and delete on every populated immutable authority table", async () => {
    const scenario = createScenario();
    try {
      const { bigTaskId, subtaskIds } = seed(scenario, {profiles:["HIGH_RISK_FOUNDATION"], startPolicy:"MANUAL"});
      const governed = governedFor(scenario);
      expect(governed.prepareNextRole(bigTaskId).kind).toBe("HUMAN_REQUIRED");
      governed.authorizeManualStart(subtaskIds[0]!);
      recordUsage(scenario, subtaskIds[0]!, "mutation-budget", 120_000);
      governed.authorizeOneTimeBudgetExtension(subtaskIds[0]!);
      completeRole(governed, authorized(governed.prepareNextRole(bigTaskId)), "READY", [], undefined, "Candidate for explicit review.");
      completeRole(governed, authorized(governed.prepareNextRole(bigTaskId)), "PASS");
      completeRole(governed, authorized(governed.prepareNextRole(bigTaskId)), "BLOCKING_FAIL", [hardeningFinding("A"), hardeningFinding("B")]);
      completeRole(governed, authorized(governed.prepareNextRole(bigTaskId)), "READY");
      completeRole(governed, authorized(governed.prepareNextRole(bigTaskId)), "PASS");
      governed.prepareNextRole(bigTaskId);
      const db = new DatabaseSync(scenario.databasePath);
      const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name GLOB 'governed_*'").all();
      expect(tables).toHaveLength(16);
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
      expect(attempts).toBe(160);
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      db.close();
      expect(governed.inspectBigTask(bigTaskId).status).toBe("DONE");
    } finally { cleanupScenario(scenario); }
  });

  it("rejects malformed bounded findings without changing durable results", () => {
    const scenario = createScenario();
    try {
      const { governed, fresh } = freshRole(scenario);
      const a = fresh.authorization;
      governed.reserveRoleExecutionAttempt(a.authorizationId);
      governed.claimRoleProviderExecution(a.authorizationId);
      governed.bindRoleProviderThread(a.authorizationId, ProviderThreadReferenceSchema.parse({providerId:PROVIDER_ID,providerThreadId:"invalid-result-thread"}));
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
      governed.startRoleProviderRun(a.authorizationId,ProviderRunReferenceSchema.parse({providerId:PROVIDER_ID,providerThreadId:"candidate-thread",providerRunId:"candidate-run"}),MODEL);
      governed.persistSuccessfulRoleResult(a.authorizationId,JSON.stringify({schemaVersion:1,outcome:"READY",summary:"Candidate ready.",findings:[],promotionCandidate:null}),MODEL,ZERO_USAGE);
      writeFileSync(join(input.worktree.ownership.worktreePath,"uncommitted.txt"),"uncommitted\n",{encoding:"utf-8"});
      expect(() => governed.reconcileRoleResult(a.authorizationId)).toThrow(/candidate changed/u);
      expect(scenario.storage.getSubtaskById(a.subtaskId)?.maturity).toBe("NOT_STARTED");
    } finally {cleanupScenario(scenario);}
  });
});

describe("Step 8D exact context, restart and operation matrices", () => {
  it("measures the final UTF-8 role input at 40000/40001/64000/64001 bytes", () => {
    const baseline = createScenario();
    let overhead: number;
    try {
      const {bigTaskId} = seed(baseline, {profiles:["LOW"], promptSeed:"x"});
      const governed = governedFor(baseline);
      const a = authorized(governed.prepareNextRole(bigTaskId)).authorization;
      governed.reserveRoleExecutionAttempt(a.authorizationId);
      overhead = governed.resolveRoleExecutionInput(a.authorizationId).preflight.utf8Bytes - 1;
    } finally {cleanupScenario(baseline);}
    for (const bytes of [40_000,40_001,64_000,64_001]) {
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
          expect(authorized(prepared).receipt.gateEvidenceReferences).toContain(`context:${a.authorizationId}:${createHash("sha256").update(input.preflight.text,"utf8").digest("hex")}:${bytes}`);
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
      expect(a.receipt.gateEvidenceReferences).toContain(`human-policy:${subtaskIds[0]}:manual:${manual.authorityId}`);
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
      governed.claimRoleProviderExecution(a.authorizationId);
      if (seam!=="CLAIMED") governed.bindRoleProviderThread(a.authorizationId,ProviderThreadReferenceSchema.parse({providerId:PROVIDER_ID,providerThreadId:"restart-thread"}));
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
  it("keeps Fresh QA, Repair and Focused Re-QA free of Active Context, Digest and prior reasoning", () => {
    const scenario=createScenario();
    try {
      const {bigTaskId,subtaskIds,governed,fresh}=freshRole(scenario);
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
    } finally {cleanupScenario(scenario);}
  });

  it.each([
    ["governed_findings","affected_contract = 'contract/unrelated'"],
    ["governed_finding_resolutions","role_result_id = (SELECT result_id FROM governed_role_results WHERE role = 'HARDEN')"],
    ["governed_provider_claims","target_finding_ids = '[]' WHERE authorization_id IN (SELECT authorization_id FROM governed_role_authorizations WHERE role = 'FOCUSED_RE_QA')"],
    ["governed_promotion_candidates","summary = 'Changed candidate conclusion.'"],
    ["governed_gate_sources","source_reference = 'wrong-gate-source'"],
    ["governed_big_task_completion_receipts","subtask_count = 2"],
  ])("rejects %s source corruption after reopen with original schema restored", (table,mutation) => {
    const scenario=createScenario();let reopened:TaskStorage|undefined;
    try {
      const {bigTaskId,governed,fresh}=freshRole(scenario);
      completeRole(governed,fresh,"BLOCKING_FAIL",[hardeningFinding("A"),hardeningFinding("B")]);
      completeRole(governed,authorized(governed.prepareNextRole(bigTaskId)),"READY",[],undefined,"Pending candidate conclusion.");
      completeRole(governed,authorized(governed.prepareNextRole(bigTaskId)),"PASS");
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
    } finally {reopened?.close();cleanupScenario(scenario);}
  });

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
