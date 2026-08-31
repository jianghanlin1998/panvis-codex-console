import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  BigTaskSchema,
  ChatThreadIdSchema,
  ExecutionRunIdSchema,
  ProjectSchema,
  SubtaskCreateInputSchema,
  SubtaskIdSchema,
} from "@codex-task-console/domain";
import {
  openTaskDatabase,
  type TaskStorage,
} from "@codex-task-console/storage";
import { createWorktreeOwnershipManagerForTesting } from "../../storage/src/worktree-ownership.js";
import {
  executeSingleSubtaskOwnedWorktreeCodexWithDependenciesForTest,
} from "../src/live-execution.js";
import { TESTED_CODEX_VERSION } from "../src/index.js";

type TestDependencies = Parameters<
  typeof executeSingleSubtaskOwnedWorktreeCodexWithDependenciesForTest
>[2];
type Scenario =
  | "approval"
  | "interrupted"
  | "malformed-tool"
  | "success"
  | "turn-failed"
  | "turn-start-failed"
  | "wait-for-interrupt";

const SUBTASK_ID = SubtaskIdSchema.parse("st_write_execution");
const CHAT_THREAD_ID = ChatThreadIdSchema.parse(
  "thr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
);
const EXECUTION_RUN_ID = ExecutionRunIdSchema.parse(
  "run_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
);
const OWNERSHIP_ID = `wt_${"c".repeat(32)}`;
const FIXED_TIME = "2026-08-31T01:00:00.000Z";
const MOCK_WRITE_FIXTURE_PATH = fileURLToPath(
  new URL("../../../fixtures/mock-write-app-server.ts", import.meta.url),
);
const FAKE_OWNED_EXECUTABLE =
  "/owned/codex/0.148.0-alpha.9-aarch64-apple-darwin/bin/codex";
const BASE_LIMITS = Object.freeze({
  startupTimeoutMs: 2_000,
  requestTimeoutMs: 2_000,
  turnTimeoutMs: 2_000,
  interruptTimeoutMs: 500,
  shutdownGraceMs: 500,
  terminateGraceMs: 500,
  maxJsonlLineBytes: 256 * 1_024,
  maxPendingRequests: 8,
  maxNotifications: 64,
  maxAgentResponseBytes: 4_096,
  maxStderrBytes: 128,
});

interface Fixture {
  readonly directory: string;
  readonly databasePath: string;
  readonly sourcePath: string;
  readonly storage: TaskStorage;
  readonly worktreePath: string | null;
  readonly manager: ReturnType<typeof createWorktreeOwnershipManagerForTesting>;
}

interface Harness {
  readonly children: ReturnType<typeof spawn>[];
  readonly dependencies: TestDependencies;
  readonly launches: Array<{
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
  }>;
  readonly transientDirectories: string[];
}

const liveChildren = new Set<ReturnType<typeof spawn>>();

afterEach(() => {
  for (const child of liveChildren) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
  liveChildren.clear();
});

describe.sequential("Write-Enabled Execution Authority Binding V0", () => {
  it("binds the exact ACTIVE worktree, workspaceWrite policy, durable records, and synthetic writes", async () => {
    const fixture = createFixture(true);
    try {
      const sourceBefore = sourceEvidence(fixture.sourcePath);
      const harness = makeHarness(fixture, "success");
      const result = await executeSingleSubtaskOwnedWorktreeCodexWithDependenciesForTest(
        fixture.storage,
        SUBTASK_ID,
        harness.dependencies,
      );

      expect(result).toMatchObject({
        success: true,
        failureCode: null,
        chatThreadId: CHAT_THREAD_ID,
        executionRunId: EXECUTION_RUN_ID,
        worktreeOwnershipId: OWNERSHIP_ID,
        terminalTurnStatus: "completed",
        threadPolicy: {
          approvalPolicy: "never",
          cwd: "TRUSTED_ACTIVE_OWNED_WORKTREE",
          ephemeral: true,
          sandbox: "workspaceWrite",
          writableRootCount: 1,
          networkAccess: false,
        },
        normalizedUsage: {
          inputTokens: 12,
          cachedInputTokens: 2,
          outputTokens: 6,
          reasoningTokens: 1,
          totalTokens: 18,
        },
        diagnostics: {
          approvalRequestsDeclined: 0,
          interruptRequests: 0,
          toolActionsObserved: 2,
          turnStartRequests: 1,
        },
        appServerChildCleaned: true,
        transientRuntimeCleaned: true,
      });
      expect(result.providerThread?.providerThreadId).toBe("thread-write-mock-77");
      expect(result.providerRun?.providerRunId).toBe("turn-write-mock-88");
      expect(result.model?.providerModelId).toBe("fixture-write-model");
      expect(harness.launches).toHaveLength(1);
      expect(harness.launches[0]?.cwd).toBe(fixture.worktreePath);
      expect(harness.launches[0]?.env.TMPDIR).not.toBe(fixture.worktreePath);
      expect(harness.transientDirectories.every((path) => !existsSync(path))).toBe(true);
      expect(readFileSync(join(fixture.worktreePath!, "owned-output.txt"), "utf8")).toBe(
        "owned worktree write\n",
      );
      expect(sourceEvidence(fixture.sourcePath)).toEqual(sourceBefore);
      expect(fixture.manager.resolveActiveOwnedWorktreeForSubtask(SUBTASK_ID).ownership.status).toBe(
        "ACTIVE",
      );

      expect(fixture.storage.getChatThreadById(CHAT_THREAD_ID)).toMatchObject({
        status: "OPEN",
        providerThread: { providerThreadId: "thread-write-mock-77" },
      });
      expect(fixture.storage.getExecutionRunById(EXECUTION_RUN_ID)).toMatchObject({
        status: "SUCCEEDED",
        providerRun: { providerRunId: "turn-write-mock-88" },
        providerModel: { providerModelId: "fixture-write-model" },
        normalizedUsage: { totalTokens: 18 },
      });

      fixture.storage.close();
      const reopened = openTaskDatabase({
        databasePath: fixture.databasePath,
        clock: fixedClock,
      });
      try {
        expect(reopened.getChatThreadById(CHAT_THREAD_ID)).toEqual(
          expect.objectContaining({
            id: CHAT_THREAD_ID,
            providerThread: expect.objectContaining({
              providerThreadId: "thread-write-mock-77",
            }),
          }),
        );
        expect(reopened.getExecutionRunById(EXECUTION_RUN_ID)).toEqual(
          expect.objectContaining({
            id: EXECUTION_RUN_ID,
            status: "SUCCEEDED",
            normalizedUsage: expect.objectContaining({ totalTokens: 18 }),
          }),
        );
      } finally {
        reopened.close();
      }
    } finally {
      if (fixture.storage.isOpen) {
        fixture.storage.close();
      }
      rmSync(fixture.directory, { force: true, recursive: true });
    }
  });

  it("exposes only storage and Subtask authority and fixes the standard profile internally", async () => {
    const module = await import("../src/index.js");
    expect(module.executeSingleSubtaskOwnedWorktreeCodex).toHaveLength(2);
  });

  it("blocks before durable or provider work when no ACTIVE ownership exists", async () => {
    const fixture = createFixture(false);
    try {
      const harness = makeHarness(fixture, "success");
      const result = await executeSingleSubtaskOwnedWorktreeCodexWithDependenciesForTest(
        fixture.storage,
        SUBTASK_ID,
        harness.dependencies,
      );
      expect(result).toMatchObject({
        success: false,
        failureCode: "ACTIVE_WORKTREE_REQUIRED",
        chatThreadId: null,
        executionRunId: null,
        diagnostics: { turnStartRequests: 0 },
      });
      expect(harness.launches).toHaveLength(0);
    } finally {
      cleanupFixture(fixture);
    }
  });

  it.each([
    [2, 0],
    [3, 0],
    [4, 0],
  ] as const)(
    "fails closed when ownership revalidation %s drifts before turn authority",
    async (failResolveCall, expectedTurns) => {
      const fixture = createFixture(true);
      try {
        const harness = makeHarness(fixture, "success", { failResolveCall });
        const result = await executeSingleSubtaskOwnedWorktreeCodexWithDependenciesForTest(
          fixture.storage,
          SUBTASK_ID,
          harness.dependencies,
        );
        expect(result).toMatchObject({
          success: false,
          failureCode: "WORKTREE_AUTHORITY_DRIFT",
          diagnostics: { turnStartRequests: expectedTurns },
        });
        expect(fixture.storage.getExecutionRunById(EXECUTION_RUN_ID)?.status).toBe(
          "FAILED",
        );
      } finally {
        cleanupFixture(fixture);
      }
    },
  );

  it("blocks the turn when provider-thread persistence fails", async () => {
    const fixture = createFixture(true);
    try {
      const harness = makeHarness(fixture, "success", {
        failDurableOperation: "BIND_THREAD",
      });
      const result = await executeSingleSubtaskOwnedWorktreeCodexWithDependenciesForTest(
        fixture.storage,
        SUBTASK_ID,
        harness.dependencies,
      );
      expect(result).toMatchObject({
        success: false,
        failureCode: "DURABLE_THREAD_PERSISTENCE_FAILED",
        providerThread: { providerThreadId: "thread-write-mock-77" },
        providerRun: null,
        diagnostics: { turnStartRequests: 0 },
      });
      expect(fixture.storage.getExecutionRunById(EXECUTION_RUN_ID)?.status).toBe(
        "FAILED",
      );
    } finally {
      cleanupFixture(fixture);
    }
  });

  it("interrupts once and never retries when durable RUNNING binding fails", async () => {
    const fixture = createFixture(true);
    try {
      const harness = makeHarness(fixture, "wait-for-interrupt", {
        failDurableOperation: "START_RUN",
      });
      const result = await executeSingleSubtaskOwnedWorktreeCodexWithDependenciesForTest(
        fixture.storage,
        SUBTASK_ID,
        harness.dependencies,
      );
      expect(result).toMatchObject({
        success: false,
        failureCode: "DURABLE_RUN_PERSISTENCE_FAILED",
        providerRun: { providerRunId: "turn-write-mock-88" },
        diagnostics: { interruptRequests: 1, turnStartRequests: 1 },
      });
      expect(fixture.storage.getExecutionRunById(EXECUTION_RUN_ID)).toMatchObject({
        status: "FAILED",
        providerRun: null,
      });
      expect(harness.children).toHaveLength(1);
    } finally {
      cleanupFixture(fixture);
    }
  });

  it.each([
    ["turn-failed", "FAILED", "TURN_FAILED"],
    ["interrupted", "INTERRUPTED", "TURN_INTERRUPTED"],
  ] as const)(
    "maps provider %s to durable %s",
    async (scenario, durableStatus, failureCode) => {
      const fixture = createFixture(true);
      try {
        const harness = makeHarness(fixture, scenario);
        const result = await executeSingleSubtaskOwnedWorktreeCodexWithDependenciesForTest(
          fixture.storage,
          SUBTASK_ID,
          harness.dependencies,
        );
        expect(result.failureCode).toBe(failureCode);
        expect(fixture.storage.getExecutionRunById(EXECUTION_RUN_ID)?.status).toBe(
          durableStatus,
        );
      } finally {
        cleanupFixture(fixture);
      }
    },
  );

  it.each([
    ["approval", "APPROVAL_REQUESTED", 1],
    ["malformed-tool", "APP_SERVER_PROTOCOL_ERROR", 0],
  ] as const)(
    "fails closed for %s write events without retry",
    async (scenario, failureCode, approvalsDeclined) => {
      const fixture = createFixture(true);
      try {
        const harness = makeHarness(fixture, scenario);
        const result = await executeSingleSubtaskOwnedWorktreeCodexWithDependenciesForTest(
          fixture.storage,
          SUBTASK_ID,
          harness.dependencies,
        );
        expect(result).toMatchObject({
          success: false,
          failureCode,
          diagnostics: {
            approvalRequestsDeclined: approvalsDeclined,
            turnStartRequests: 1,
          },
        });
        expect(fixture.storage.getExecutionRunById(EXECUTION_RUN_ID)?.status).toBe(
          "FAILED",
        );
      } finally {
        cleanupFixture(fixture);
      }
    },
  );

  it("keeps the exact persisted RUNNING seam when terminal persistence fails", async () => {
    const fixture = createFixture(true);
    try {
      const harness = makeHarness(fixture, "success", {
        failDurableOperation: "FINISH_RUN",
      });
      const result = await executeSingleSubtaskOwnedWorktreeCodexWithDependenciesForTest(
        fixture.storage,
        SUBTASK_ID,
        harness.dependencies,
      );
      expect(result).toMatchObject({
        success: false,
        failureCode: "DURABLE_RUN_PERSISTENCE_FAILED",
        terminalTurnStatus: "completed",
      });
      expect(fixture.storage.getExecutionRunById(EXECUTION_RUN_ID)?.status).toBe(
        "RUNNING",
      );
    } finally {
      cleanupFixture(fixture);
    }
  });

  it("fails terminal accounting when transient cleanup fails and preserves the owned worktree", async () => {
    const fixture = createFixture(true);
    try {
      const harness = makeHarness(fixture, "success", {
        removeWorkspaceThrows: true,
      });
      const result = await executeSingleSubtaskOwnedWorktreeCodexWithDependenciesForTest(
        fixture.storage,
        SUBTASK_ID,
        harness.dependencies,
      );
      expect(result).toMatchObject({
        success: false,
        failureCode: "WORKSPACE_CLEANUP_FAILED",
        transientRuntimeCleaned: false,
      });
      expect(fixture.storage.getExecutionRunById(EXECUTION_RUN_ID)?.status).toBe(
        "FAILED",
      );
      expect(readFileSync(join(fixture.worktreePath!, "owned-output.txt"), "utf8")).toBe(
        "owned worktree write\n",
      );
      for (const path of harness.transientDirectories) {
        rmSync(path, { force: true, recursive: true });
      }
    } finally {
      cleanupFixture(fixture);
    }
  });

  it("does not fabricate RUNNING state when turn/start fails", async () => {
    const fixture = createFixture(true);
    try {
      const harness = makeHarness(fixture, "turn-start-failed");
      const result = await executeSingleSubtaskOwnedWorktreeCodexWithDependenciesForTest(
        fixture.storage,
        SUBTASK_ID,
        harness.dependencies,
      );
      expect(result).toMatchObject({
        success: false,
        providerRun: null,
        diagnostics: { turnStartRequests: 1 },
      });
      expect(fixture.storage.getExecutionRunById(EXECUTION_RUN_ID)).toMatchObject({
        status: "FAILED",
        providerRun: null,
      });
    } finally {
      cleanupFixture(fixture);
    }
  });
});

function createFixture(provision: boolean): Fixture {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "ctc-write-execution-")));
  const sourcePath = join(directory, "source");
  const databasePath = join(directory, "console.sqlite");
  execFileSync("git", ["init", "--initial-branch", "main", sourcePath]);
  runGit(sourcePath, ["config", "user.name", "Write Fixture"]);
  runGit(sourcePath, ["config", "user.email", "write@example.invalid"]);
  writeFileSync(join(sourcePath, "tracked.txt"), "source tracked\n", {
    encoding: "utf8",
  });
  runGit(sourcePath, ["add", "tracked.txt"]);
  runGit(sourcePath, ["commit", "--message", "fixture"]);
  const head = runGit(sourcePath, ["rev-parse", "HEAD"]);
  runGit(sourcePath, ["update-ref", "refs/remotes/origin/main", head]);
  writeFileSync(join(sourcePath, "source-untracked.txt"), "source sentinel\n", {
    encoding: "utf8",
  });

  const storage = openTaskDatabase({ databasePath, clock: fixedClock });
  seedHierarchy(storage, sourcePath);
  const manager = createWorktreeOwnershipManagerForTesting(storage, {
    worktreeRoot: join(directory, "owned-worktrees"),
    idGenerator: () => OWNERSHIP_ID,
  });
  const worktreePath = provision
    ? manager.provisionOwnedWorktreeForSubtask(SUBTASK_ID).worktreePath
    : null;
  return { directory, databasePath, sourcePath, storage, worktreePath, manager };
}

function makeHarness(
  fixture: Fixture,
  scenario: Scenario,
  options: {
    readonly failDurableOperation?: Parameters<
      NonNullable<TestDependencies["beforeDurableOperation"]>
    >[0];
    readonly failResolveCall?: number;
    readonly removeWorkspaceThrows?: boolean;
  } = {},
): Harness {
  const children: ReturnType<typeof spawn>[] = [];
  const launches: Harness["launches"] = [];
  const transientDirectories: string[] = [];
  let resolveCalls = 0;
  const dependencies: TestDependencies = {
    checkCompatibility: () => true,
    resolveRuntime: () => ({
      canonicalExecutablePath: FAKE_OWNED_EXECUTABLE,
      exactVersionOutput: TESTED_CODEX_VERSION,
      executable: true,
      readable: true,
      releaseVersion: "0.148.0-alpha.9",
      source: "OWNED_RELEASE",
      target: "aarch64-apple-darwin",
    }),
    resolveOwnedWorktree: () => {
      resolveCalls += 1;
      if (resolveCalls === options.failResolveCall) {
        throw new Error("synthetic ownership drift");
      }
      return fixture.manager.resolveActiveOwnedWorktreeForSubtask(SUBTASK_ID);
    },
    generateChatThreadId: () => CHAT_THREAD_ID,
    generateExecutionRunId: () => EXECUTION_RUN_ID,
    beforeDurableOperation: (operation) => {
      if (operation === options.failDurableOperation) {
        throw new Error("synthetic durable failure");
      }
    },
    spawnAppServer: (_executable, _arguments, spawnOptions) => {
      launches.push({ cwd: spawnOptions.cwd, env: { ...spawnOptions.env } });
      const child = spawn(
        process.execPath,
        [MOCK_WRITE_FIXTURE_PATH, `--scenario=${scenario}`],
        spawnOptions,
      );
      children.push(child);
      liveChildren.add(child);
      child.once("close", () => liveChildren.delete(child));
      return child;
    },
    sourceEnvironment: { LANG: "en_US.UTF-8" },
    normalHomeDirectory: "/fixture/normal-home",
    createWorkspace: () => {
      const path = mkdtempSync(join(realpathSync(tmpdir()), "ctc-write-runtime-"));
      chmodSync(path, 0o700);
      transientDirectories.push(path);
      return path;
    },
    removeWorkspace: (path) => {
      if (options.removeWorkspaceThrows === true) {
        throw new Error("synthetic transient cleanup failure");
      }
      rmSync(path, { force: true, recursive: true });
    },
    limits: BASE_LIMITS,
  };
  return { children, dependencies, launches, transientDirectories };
}

function seedHierarchy(storage: TaskStorage, sourcePath: string): void {
  storage.createProject(
    ProjectSchema.parse({
      recordType: "PROJECT",
      id: "prj_write_execution",
      name: "Write Execution Fixture",
      slug: "write-execution-fixture",
      repository: { kind: "PATH", path: sourcePath },
      defaultBranch: "main",
      maxActiveCodingSubtasks: 1,
    }),
  );
  storage.createBigTask(
    BigTaskSchema.parse({
      recordType: "BIG_TASK",
      id: "bt_write_execution",
      projectId: "prj_write_execution",
      title: "Write execution",
      goal: "Exercise trusted write authority",
      rationale: "Synthetic baseline",
      scopeIn: ["Owned worktree"],
      scopeOut: ["Real repositories"],
      acceptanceCriteria: ["Only the owned worktree changes"],
      status: "IN_PROGRESS",
    }),
  );
  storage.createSubtask(
    SubtaskCreateInputSchema.parse({
      recordType: "SUBTASK",
      id: SUBTASK_ID,
      bigTaskId: "bt_write_execution",
      title: "Modify the owned worktree",
      goal: "Create one synthetic output file",
      scopeIn: ["Synthetic output"],
      scopeOut: ["Source checkout", "network"],
      acceptanceCriteria: ["Owned output persists"],
      untouchedAreas: ["Source checkout"],
      status: "IN_PROGRESS",
      maturity: "NOT_STARTED",
      startPolicy: "MANUAL",
      delegationPolicy: "NONE",
      recommendedReasoningLevel: "HIGH",
      promptSeed: "Create the approved synthetic output in the owned worktree.",
    }),
  );
}

function sourceEvidence(sourcePath: string): object {
  return {
    head: runGit(sourcePath, ["rev-parse", "HEAD"]),
    branch: runGit(sourcePath, ["branch", "--show-current"]),
    index: runGit(sourcePath, ["diff", "--cached", "--binary"]),
    status: runGit(sourcePath, ["status", "--porcelain=v1"]),
    tracked: readFileSync(join(sourcePath, "tracked.txt"), "utf8"),
    untracked: readFileSync(join(sourcePath, "source-untracked.txt"), "utf8"),
  };
}

function runGit(cwd: string, arguments_: readonly string[]): string {
  return execFileSync("git", ["-C", cwd, ...arguments_], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: "2026-08-31T00:00:00Z",
      GIT_AUTHOR_EMAIL: "write@example.invalid",
      GIT_AUTHOR_NAME: "Write Fixture",
      GIT_COMMITTER_DATE: "2026-08-31T00:00:00Z",
      GIT_COMMITTER_EMAIL: "write@example.invalid",
      GIT_COMMITTER_NAME: "Write Fixture",
      GIT_TERMINAL_PROMPT: "0",
    },
  }).trimEnd();
}

function fixedClock(): Date {
  return new Date(FIXED_TIME);
}

function cleanupFixture(fixture: Fixture): void {
  if (fixture.storage.isOpen) {
    fixture.storage.close();
  }
  rmSync(fixture.directory, { force: true, recursive: true });
}
