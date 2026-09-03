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
  createGovernedExecutionStore,
  openTaskDatabase,
} from "../src/index.js";
import type {
  GovernedExecutionStore,
  GovernedPreparationResult,
  TaskStorage,
  WorktreeOwnershipManager,
} from "../src/index.js";
import { createWorktreeOwnershipManagerForTesting } from "../src/worktree-ownership.js";
import { makeBigTask } from "./fixtures.js";

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
) => {
  const { authorization } = prepared;
  const attempt = governed.reserveRoleExecutionAttempt(
    authorization.authorizationId,
  );
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
