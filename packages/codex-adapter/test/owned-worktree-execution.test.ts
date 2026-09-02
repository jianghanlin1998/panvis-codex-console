import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  BigTaskSchema,
  BigTaskIdSchema,
  ChatThreadIdSchema,
  ExecutionProviderIdSchema,
  ExecutionRunIdSchema,
  ProjectSchema,
  SubtaskCreateInputSchema,
  SubtaskDependencySchema,
  SubtaskIdSchema,
  WorktreeOwnershipIdSchema,
} from "@codex-task-console/domain";
import {
  openTaskDatabase,
  type TaskStorage,
  WorktreeOwnershipError,
} from "@codex-task-console/storage";
import { createWorktreeOwnershipManagerForTesting } from "../../storage/src/worktree-ownership.js";
import {
  executeSingleSubtaskOwnedWorktreeCodexWithDependenciesForTest,
} from "../src/live-execution.js";
import { validateOwnedWorktreeHardlinkSafety } from "../src/worktree-filesystem-safety.js";
import { TESTED_CODEX_VERSION } from "../src/index.js";

type TestDependencies = Parameters<
  typeof executeSingleSubtaskOwnedWorktreeCodexWithDependenciesForTest
>[2];
type Scenario =
  | "absolute-file-change-path-success"
  | "approval"
  | "hardlink-during-turn"
  | "head-drift-during-turn"
  | "interrupted"
  | "malformed-response-after-tools"
  | "malformed-tool"
  | "progress-success"
  | "success"
  | "turn-failed"
  | "turn-started-before-response"
  | "turn-start-transport-failed"
  | "turn-start-failed"
  | "tools-before-response"
  | "wait-for-authority-mutation"
  | "wait-for-interrupt"
  | "wait-for-interrupt-without-terminal";
type ThreadStartVariant =
  | "approval-policy-on-request"
  | "approvals-reviewer-auto"
  | "ephemeral-false"
  | "exact"
  | "exclude-slash-tmp-true"
  | "exclude-tmpdir-env-true"
  | "network-enabled"
  | "sandbox-type-read-only"
  | "thread-cwd-mismatch"
  | "top-level-cwd-mismatch"
  | "writable-roots-duplicate"
  | "writable-roots-malformed"
  | "writable-roots-other"
  | "writable-roots-worktree";

const SUBTASK_ID = SubtaskIdSchema.parse("st_write_execution");
const UPSTREAM_SUBTASK_ID = SubtaskIdSchema.parse("st_write_upstream");
const SECOND_SUBTASK_ID = SubtaskIdSchema.parse("st_write_independent");
const BIG_TASK_ID = BigTaskIdSchema.parse("bt_write_execution");
const CHAT_THREAD_ID = ChatThreadIdSchema.parse(
  "thr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
);
const EXECUTION_RUN_ID = ExecutionRunIdSchema.parse(
  "run_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
);
const OWNERSHIP_ID = WorktreeOwnershipIdSchema.parse(`wt_${"c".repeat(32)}`);
const SECOND_OWNERSHIP_ID = WorktreeOwnershipIdSchema.parse(`wt_${"d".repeat(32)}`);
const PROVIDER_ID = ExecutionProviderIdSchema.parse("openai-codex-app-server");
const FIXED_TIME = "2026-08-31T01:00:00.000Z";
const MOCK_WRITE_FIXTURE_PATH = fileURLToPath(
  new URL("../../../fixtures/mock-write-app-server.ts", import.meta.url),
);
const FAKE_OWNED_EXECUTABLE =
  "/owned/codex/0.148.0-alpha.9-aarch64-apple-darwin/bin/codex";
const BASE_LIMITS = Object.freeze({
  startupTimeoutMs: 2_000,
  requestTimeoutMs: 2_000,
  turnIdleTimeoutMs: 2_000,
  turnAbsoluteTimeoutMs: 5_000,
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
    readonly arguments_: readonly string[];
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
  it("accepts the exact .9 thread mode response and binds the exact turn root", async () => {
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
      expect(harness.launches[0]?.arguments_).toEqual([
        "app-server",
        "--listen",
        "stdio://",
        "--strict-config",
        "--config",
        "orchestrator.mcp.enabled=false",
        "--config",
        'web_search="disabled"',
        ...[
          "apps",
          "browser_use",
          "browser_use_external",
          "browser_use_full_cdp_access",
          "computer_use",
          "hooks",
          "image_generation",
          "in_app_browser",
          "in_app_updates",
          "multi_agent",
          "multi_agent_v2",
          "plugin_sharing",
          "plugins",
          "recommended_plugins",
          "remote_control",
          "remote_plugin",
          "skill_mcp_dependency_install",
          "tool_suggest",
          "workspace_dependencies",
        ].flatMap((feature) => ["--disable", feature]),
      ]);
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
        status: "CLOSED",
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

  it("accepts the exact .9 absolute file-change path representation inside the owned worktree", async () => {
    const fixture = createFixture(true);
    try {
      const sourceBefore = sourceEvidence(fixture.sourcePath);
      const harness = makeHarness(fixture, "absolute-file-change-path-success");
      const result = await executeSingleSubtaskOwnedWorktreeCodexWithDependenciesForTest(
        fixture.storage,
        SUBTASK_ID,
        harness.dependencies,
      );

      expect(result).toMatchObject({
        success: true,
        failureCode: null,
        terminalTurnStatus: "completed",
        diagnostics: {
          interruptRequests: 0,
          toolActionsObserved: 2,
          turnStartRequests: 1,
        },
      });
      expect(sourceEvidence(fixture.sourcePath)).toEqual(sourceBefore);
      expect(
        fixture.manager.resolveActiveOwnedWorktreeForSubtask(SUBTASK_ID)
          .ownership.status,
      ).toBe("ACTIVE");
      expect(
        readFileSync(join(fixture.worktreePath!, "owned-output.txt"), "utf8"),
      ).toBe("owned worktree write\n");
    } finally {
      cleanupFixture(fixture);
    }
  });

  it("terminally fails an idle owned turn while preserving exact ACTIVE authority", async () => {
    const fixture = createFixture(true);
    try {
      const ownedBefore = fixture.manager.resolveActiveOwnedWorktreeForSubtask(SUBTASK_ID);
      const harness = makeHarness(fixture, "wait-for-interrupt-without-terminal", {
        limits: {
          turnIdleTimeoutMs: 100,
          turnAbsoluteTimeoutMs: 600,
        },
      });
      const result = await executeSingleSubtaskOwnedWorktreeCodexWithDependenciesForTest(
        fixture.storage,
        SUBTASK_ID,
        harness.dependencies,
      );
      expect(result).toMatchObject({
        success: false,
        failureCode: "APP_SERVER_TIMEOUT",
        terminalTurnStatus: null,
        diagnostics: { interruptRequests: 1, turnStartRequests: 1 },
      });
      expect(fixture.storage.getExecutionRunById(EXECUTION_RUN_ID)?.status).toBe(
        "FAILED",
      );
      expect(fixture.storage.getChatThreadById(CHAT_THREAD_ID)?.status).toBe(
        "CLOSED",
      );
      const ownedAfter = fixture.manager.resolveActiveOwnedWorktreeForSubtask(SUBTASK_ID);
      expect(ownedAfter.ownership.status).toBe("ACTIVE");
      expect(ownedAfter.currentHeadSha).toBe(ownedBefore.currentHeadSha);
      expect(runGit(fixture.worktreePath!, ["status", "--porcelain=v1"])).toBe("");
    } finally {
      cleanupFixture(fixture);
    }
  });

  it("allows validated authorized tool progress beyond one owned idle interval", async () => {
    const fixture = createFixture(true);
    try {
      const harness = makeHarness(fixture, "progress-success", {
        limits: {
          turnIdleTimeoutMs: 250,
          turnAbsoluteTimeoutMs: 1_500,
        },
      });
      const result = await executeSingleSubtaskOwnedWorktreeCodexWithDependenciesForTest(
        fixture.storage,
        SUBTASK_ID,
        harness.dependencies,
      );
      expect(result).toMatchObject({
        success: true,
        failureCode: null,
        terminalTurnStatus: "completed",
        diagnostics: {
          interruptRequests: 0,
          toolActionsObserved: 2,
          turnStartRequests: 1,
        },
      });
      expect(fixture.storage.getExecutionRunById(EXECUTION_RUN_ID)?.status).toBe(
        "SUCCEEDED",
      );
      expect(fixture.storage.getChatThreadById(CHAT_THREAD_ID)?.status).toBe(
        "CLOSED",
      );
      expect(
        fixture.manager.resolveActiveOwnedWorktreeForSubtask(SUBTASK_ID).ownership.status,
      ).toBe("ACTIVE");
      expect(readFileSync(join(fixture.worktreePath!, "owned-output.txt"), "utf8")).toBe(
        "owned worktree write\n",
      );
    } finally {
      cleanupFixture(fixture);
    }
  });

  it("exposes only storage and Subtask authority and fixes the standard profile internally", async () => {
    const module = await import("../src/index.js");
    expect(module.executeSingleSubtaskOwnedWorktreeCodex).toHaveLength(2);
  });

  it.each([
    "approval-policy-on-request",
    "approvals-reviewer-auto",
    "exclude-slash-tmp-true",
    "exclude-tmpdir-env-true",
    "network-enabled",
    "sandbox-type-read-only",
    "thread-cwd-mismatch",
    "top-level-cwd-mismatch",
  ] as const)(
    "fails closed before turn/start for thread policy mismatch %s",
    async (threadStartVariant) => {
      const fixture = createFixture(true);
      try {
        const harness = makeHarness(fixture, "success", {
          threadStartVariant,
        });
        const result =
          await executeSingleSubtaskOwnedWorktreeCodexWithDependenciesForTest(
            fixture.storage,
            SUBTASK_ID,
            harness.dependencies,
          );
        expect(result).toMatchObject({
          success: false,
          failureCode: "WRITE_POLICY_REQUIRED",
          providerThread: null,
          threadPolicy: null,
          diagnostics: { turnStartRequests: 0 },
        });
        expect(fixture.storage.getExecutionRunById(EXECUTION_RUN_ID)?.status).toBe(
          "FAILED",
        );
        expect(fixture.storage.getChatThreadById(CHAT_THREAD_ID)?.status).toBe(
          "CLOSED",
        );
      } finally {
        cleanupFixture(fixture);
      }
    },
  );

  it.each([
    "writable-roots-worktree",
    "writable-roots-other",
    "writable-roots-duplicate",
    "writable-roots-malformed",
  ] as const)(
    "rejects nonempty thread-level writableRoots variant %s",
    async (threadStartVariant) => {
      const fixture = createFixture(true);
      try {
        const harness = makeHarness(fixture, "success", {
          threadStartVariant,
        });
        const result =
          await executeSingleSubtaskOwnedWorktreeCodexWithDependenciesForTest(
            fixture.storage,
            SUBTASK_ID,
            harness.dependencies,
          );
        expect(result).toMatchObject({
          success: false,
          failureCode: "WRITE_POLICY_REQUIRED",
          threadPolicy: null,
          diagnostics: { turnStartRequests: 0 },
        });
      } finally {
        cleanupFixture(fixture);
      }
    },
  );

  it("preserves the existing ephemeral invariant for thread/start", async () => {
    const fixture = createFixture(true);
    try {
      const harness = makeHarness(fixture, "success", {
        threadStartVariant: "ephemeral-false",
      });
      const result =
        await executeSingleSubtaskOwnedWorktreeCodexWithDependenciesForTest(
          fixture.storage,
          SUBTASK_ID,
          harness.dependencies,
        );
      expect(result).toMatchObject({
        success: false,
        failureCode: "EPHEMERAL_THREAD_REQUIRED",
        threadPolicy: null,
        diagnostics: { turnStartRequests: 0 },
      });
    } finally {
      cleanupFixture(fixture);
    }
  });

  it.each(["DONE", "DROPPED", "ARCHIVED"] as const)(
    "blocks a %s Subtask before reservation or turn/start",
    async (status) => {
      const fixture = createFixture(true);
      try {
        setStoredSubtaskStatus(fixture.databasePath, SUBTASK_ID, status);
        const harness = makeHarness(fixture, "success");
        const result =
          await executeSingleSubtaskOwnedWorktreeCodexWithDependenciesForTest(
            fixture.storage,
            SUBTASK_ID,
            harness.dependencies,
          );
        expect(result).toMatchObject({
          success: false,
          failureCode: "PRIMARY_EXECUTION_CONFLICT",
          chatThreadId: null,
          executionRunId: null,
          diagnostics: { turnStartRequests: 0 },
        });
        expect(harness.launches).toHaveLength(0);
        expect(fixture.storage.listChatThreadsForSubtask(SUBTASK_ID)).toEqual([]);
      } finally {
        cleanupFixture(fixture);
      }
    },
  );

  it("blocks a HARDENED dependency gate before reservation", async () => {
    const fixture = createFixture(true);
    try {
      seedBlockingDependency(fixture, "HARDENED", "NOT_STARTED");
      const harness = makeHarness(fixture, "success");
      const result =
        await executeSingleSubtaskOwnedWorktreeCodexWithDependenciesForTest(
          fixture.storage,
          SUBTASK_ID,
          harness.dependencies,
        );
      expect(result).toMatchObject({
        success: false,
        failureCode: "PRIMARY_EXECUTION_CONFLICT",
        chatThreadId: null,
        executionRunId: null,
        diagnostics: { turnStartRequests: 0 },
      });
      expect(harness.launches).toHaveLength(0);
      expect(fixture.storage.listChatThreadsForSubtask(SUBTASK_ID)).toEqual([]);
    } finally {
      cleanupFixture(fixture);
    }
  });

  it("fails and closes the reserved attempt when the Subtask becomes DONE before turn/start", async () => {
    const fixture = createFixture(true);
    try {
      const harness = makeHarness(fixture, "success", {
        beforeWorktreeAuthorityGate: (gate) => {
          if (gate === "FINAL_PRE_TURN_HARDLINK_SCAN") {
            setStoredSubtaskStatus(fixture.databasePath, SUBTASK_ID, "DONE");
          }
        },
      });
      const result =
        await executeSingleSubtaskOwnedWorktreeCodexWithDependenciesForTest(
          fixture.storage,
          SUBTASK_ID,
          harness.dependencies,
        );
      expect(result).toMatchObject({
        success: false,
        failureCode: "PRIMARY_EXECUTION_CONFLICT",
        diagnostics: { turnStartRequests: 0 },
      });
      expect(fixture.storage.getExecutionRunById(EXECUTION_RUN_ID)?.status).toBe(
        "FAILED",
      );
      expect(fixture.storage.getChatThreadById(CHAT_THREAD_ID)?.status).toBe(
        "CLOSED",
      );
    } finally {
      cleanupFixture(fixture);
    }
  });

  it("fails and closes the reserved attempt when readiness becomes blocked before turn/start", async () => {
    const fixture = createFixture(true);
    try {
      seedBlockingDependency(fixture, "HARDENED", "HARDENED");
      const harness = makeHarness(fixture, "success", {
        beforeWorktreeAuthorityGate: (gate) => {
          if (gate === "FINAL_PRE_TURN_HARDLINK_SCAN") {
            setStoredSubtaskMaturity(
              fixture.databasePath,
              UPSTREAM_SUBTASK_ID,
              "NOT_STARTED",
            );
          }
        },
      });
      const result =
        await executeSingleSubtaskOwnedWorktreeCodexWithDependenciesForTest(
          fixture.storage,
          SUBTASK_ID,
          harness.dependencies,
        );
      expect(result).toMatchObject({
        success: false,
        failureCode: "PRIMARY_EXECUTION_CONFLICT",
        diagnostics: { turnStartRequests: 0 },
      });
      expect(fixture.storage.getExecutionRunById(EXECUTION_RUN_ID)?.status).toBe(
        "FAILED",
      );
      expect(fixture.storage.getChatThreadById(CHAT_THREAD_ID)?.status).toBe(
        "CLOSED",
      );
    } finally {
      cleanupFixture(fixture);
    }
  });

  it("does not durably succeed when the Subtask becomes DONE during the provider turn", async () => {
    const fixture = createFixture(true);
    try {
      const harness = makeHarness(fixture, "wait-for-authority-mutation", {
        afterDurableOperation: (operation) => {
          if (operation === "START_RUN") {
            setStoredSubtaskStatus(fixture.databasePath, SUBTASK_ID, "DONE");
          }
        },
      });
      const result =
        await executeSingleSubtaskOwnedWorktreeCodexWithDependenciesForTest(
          fixture.storage,
          SUBTASK_ID,
          harness.dependencies,
        );
      expect(result).toMatchObject({
        success: false,
        failureCode: "PRIMARY_EXECUTION_CONFLICT",
        terminalTurnStatus: "completed",
      });
      expect(readFileSync(join(fixture.worktreePath!, "owned-output.txt"), "utf8")).toBe(
        "owned worktree write\n",
      );
      expect(fixture.storage.getExecutionRunById(EXECUTION_RUN_ID)?.status).toBe(
        "FAILED",
      );
      expect(fixture.storage.getChatThreadById(CHAT_THREAD_ID)?.status).toBe(
        "CLOSED",
      );
    } finally {
      cleanupFixture(fixture);
    }
  });

  it("does not durably succeed when an ACCEPTED dependency gate becomes blocked during the provider turn", async () => {
    const fixture = createFixture(true);
    try {
      seedBlockingDependency(fixture, "ACCEPTED", "ACCEPTED");
      const harness = makeHarness(fixture, "wait-for-authority-mutation", {
        afterDurableOperation: (operation) => {
          if (operation === "START_RUN") {
            setStoredSubtaskMaturity(
              fixture.databasePath,
              UPSTREAM_SUBTASK_ID,
              "HARDENED",
            );
          }
        },
      });
      const result =
        await executeSingleSubtaskOwnedWorktreeCodexWithDependenciesForTest(
          fixture.storage,
          SUBTASK_ID,
          harness.dependencies,
        );
      expect(result).toMatchObject({
        success: false,
        failureCode: "PRIMARY_EXECUTION_CONFLICT",
        terminalTurnStatus: "completed",
      });
      expect(fixture.storage.getExecutionRunById(EXECUTION_RUN_ID)?.status).toBe(
        "FAILED",
      );
      expect(fixture.storage.getChatThreadById(CHAT_THREAD_ID)?.status).toBe(
        "CLOSED",
      );
    } finally {
      cleanupFixture(fixture);
    }
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

  it("blocks a pre-existing external hardlink before provider write authority", async () => {
    const fixture = createFixture(true);
    try {
      const sentinel = join(fixture.directory, "external-sentinel.txt");
      writeFileSync(sentinel, "original\n", { encoding: "utf8" });
      linkSync(sentinel, join(fixture.worktreePath!, "external-alias.txt"));
      const harness = makeHarness(fixture, "success");
      const result = await executeSingleSubtaskOwnedWorktreeCodexWithDependenciesForTest(
        fixture.storage,
        SUBTASK_ID,
        harness.dependencies,
      );
      expect(result).toMatchObject({
        success: false,
        failureCode: "WORKTREE_FILESYSTEM_UNSAFE",
        chatThreadId: null,
        executionRunId: null,
        diagnostics: { turnStartRequests: 0 },
      });
      expect(harness.launches).toHaveLength(0);
      expect(readFileSync(sentinel, "utf8")).toBe("original\n");
    } finally {
      cleanupFixture(fixture);
    }
  });

  it("blocks multiple hardlinks entirely inside the worktree", async () => {
    const fixture = createFixture(true);
    try {
      linkSync(
        join(fixture.worktreePath!, "tracked.txt"),
        join(fixture.worktreePath!, "tracked-alias.txt"),
      );
      const harness = makeHarness(fixture, "success");
      const result = await executeSingleSubtaskOwnedWorktreeCodexWithDependenciesForTest(
        fixture.storage,
        SUBTASK_ID,
        harness.dependencies,
      );
      expect(result.failureCode).toBe("WORKTREE_FILESYSTEM_UNSAFE");
      expect(harness.launches).toHaveLength(0);
    } finally {
      cleanupFixture(fixture);
    }
  });

  it("rechecks hardlink safety immediately before turn/start", async () => {
    const fixture = createFixture(true);
    try {
      const harness = makeHarness(fixture, "success", {
        beforeWorktreeAuthorityGate: (gate) => {
          if (gate === "FINAL_PRE_TURN_HARDLINK_SCAN") {
            linkSync(
              join(fixture.worktreePath!, "tracked.txt"),
              join(fixture.worktreePath!, "late-alias.txt"),
            );
          }
        },
      });
      const result = await executeSingleSubtaskOwnedWorktreeCodexWithDependenciesForTest(
        fixture.storage,
        SUBTASK_ID,
        harness.dependencies,
      );
      expect(result).toMatchObject({
        success: false,
        failureCode: "WORKTREE_FILESYSTEM_UNSAFE",
        diagnostics: { turnStartRequests: 0 },
      });
      expect(fixture.storage.getExecutionRunById(EXECUTION_RUN_ID)?.status).toBe(
        "FAILED",
      );
      expect(fixture.storage.getChatThreadById(CHAT_THREAD_ID)?.status).toBe(
        "CLOSED",
      );
      expect(fixture.storage.getChatThreadById(CHAT_THREAD_ID)?.status).toBe(
        "CLOSED",
      );
    } finally {
      cleanupFixture(fixture);
    }
  });

  it("fails durable success when a hardlink appears during the provider turn", async () => {
    const fixture = createFixture(true);
    try {
      const harness = makeHarness(fixture, "hardlink-during-turn");
      const result = await executeSingleSubtaskOwnedWorktreeCodexWithDependenciesForTest(
        fixture.storage,
        SUBTASK_ID,
        harness.dependencies,
      );
      expect(result).toMatchObject({
        success: false,
        failureCode: "WORKTREE_FILESYSTEM_UNSAFE",
        terminalTurnStatus: "completed",
      });
      expect(fixture.storage.getExecutionRunById(EXECUTION_RUN_ID)?.status).toBe(
        "FAILED",
      );
    } finally {
      cleanupFixture(fixture);
    }
  });

  it("fails durable success when an external hardlink appears after provider terminal", async () => {
    const fixture = createFixture(true);
    try {
      const sentinel = join(fixture.directory, "post-terminal-sentinel.txt");
      writeFileSync(sentinel, "post-terminal\n", { encoding: "utf8" });
      const harness = makeHarness(fixture, "success", {
        beforeWorktreeAuthorityGate: (gate) => {
          if (gate === "POST_TURN_SUCCESS_GATE") {
            linkSync(
              sentinel,
              join(fixture.worktreePath!, "post-terminal-alias.txt"),
            );
          }
        },
      });
      const result = await executeSingleSubtaskOwnedWorktreeCodexWithDependenciesForTest(
        fixture.storage,
        SUBTASK_ID,
        harness.dependencies,
      );
      expect(result.failureCode).toBe("WORKTREE_FILESYSTEM_UNSAFE");
      expect(readFileSync(sentinel, "utf8")).toBe("post-terminal\n");
      expect(fixture.storage.getExecutionRunById(EXECUTION_RUN_ID)?.status).toBe(
        "FAILED",
      );
    } finally {
      cleanupFixture(fixture);
    }
  });

  it.each([
    [2, 0],
    [3, 0],
    [4, 0],
    [5, 1],
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
        status: "CREATED",
        providerRun: null,
      });
      expect(fixture.storage.getChatThreadById(CHAT_THREAD_ID)).toMatchObject({
        status: "OPEN",
        providerThread: { providerThreadId: "thread-write-mock-77" },
      });
      expect(harness.children).toHaveLength(1);
    } finally {
      cleanupFixture(fixture);
    }
  });

  it("preserves CREATED and OPEN residue after provider writes and terminal evidence when RUNNING bind fails", async () => {
    const fixture = createFixture(true);
    try {
      const harness = makeHarness(fixture, "success", {
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
        terminalTurnStatus: "completed",
        diagnostics: { turnStartRequests: 1 },
      });
      expect(result.diagnostics.interruptRequests).toBeLessThanOrEqual(1);
      expect(readFileSync(join(fixture.worktreePath!, "owned-output.txt"), "utf8")).toBe(
        "owned worktree write\n",
      );
      expect(fixture.storage.getExecutionRunById(EXECUTION_RUN_ID)).toMatchObject({
        status: "CREATED",
        providerRun: null,
        startedAt: null,
      });
      expect(fixture.storage.getChatThreadById(CHAT_THREAD_ID)).toMatchObject({
        status: "OPEN",
        providerThread: { providerThreadId: "thread-write-mock-77" },
      });

      seedIndependentSubtask(fixture.storage);
      const independentManager = createWorktreeOwnershipManagerForTesting(
        fixture.storage,
        {
          worktreeRoot: join(fixture.directory, "owned-worktrees"),
          idGenerator: () => SECOND_OWNERSHIP_ID,
        },
      );
      independentManager.provisionOwnedWorktreeForSubtask(SECOND_SUBTASK_ID);
      fixture.storage.close();
      const reopened = openTaskDatabase({
        databasePath: fixture.databasePath,
        clock: fixedClock,
      });
      try {
        expect(reopened.getExecutionRunById(EXECUTION_RUN_ID)?.status).toBe(
          "CREATED",
        );
        expect(reopened.getChatThreadById(CHAT_THREAD_ID)?.status).toBe("OPEN");
        expect(() =>
          reopened.reservePrimaryExecutionAttempt({
            subtaskId: SUBTASK_ID,
            worktreeOwnershipId: OWNERSHIP_ID,
            chatThreadId: ChatThreadIdSchema.parse(
              "thr_unresolved_reopen_block_aaaaaaaa",
            ),
            executionRunId: ExecutionRunIdSchema.parse(
              "run_unresolved_reopen_block_aaaaaaa",
            ),
            providerId: PROVIDER_ID,
          }),
        ).toThrow();
        expect(
          reopened.reservePrimaryExecutionAttempt({
            subtaskId: SECOND_SUBTASK_ID,
            worktreeOwnershipId: SECOND_OWNERSHIP_ID,
            chatThreadId: ChatThreadIdSchema.parse(
              "thr_independent_reservation_aaaaaaaa",
            ),
            executionRunId: ExecutionRunIdSchema.parse(
              "run_independent_reservation_aaaaaaa",
            ),
            providerId: PROVIDER_ID,
          }).executionRun.status,
        ).toBe("CREATED");
      } finally {
        reopened.close();
      }
    } finally {
      cleanupFixture(fixture);
    }
  });

  it("preserves CREATED and OPEN residue when tool activity precedes the RUNNING bind", async () => {
    const fixture = createFixture(true);
    try {
      const harness = makeHarness(fixture, "tools-before-response", {
        failDurableOperation: "START_RUN",
      });
      const result =
        await executeSingleSubtaskOwnedWorktreeCodexWithDependenciesForTest(
          fixture.storage,
          SUBTASK_ID,
          harness.dependencies,
        );
      expect(result).toMatchObject({
        success: false,
        failureCode: "DURABLE_RUN_PERSISTENCE_FAILED",
        diagnostics: { turnStartRequests: 1 },
      });
      expect(result.diagnostics.toolActionsObserved).toBeGreaterThan(0);
      expect(fixture.storage.getExecutionRunById(EXECUTION_RUN_ID)?.status).toBe(
        "CREATED",
      );
      expect(fixture.storage.getChatThreadById(CHAT_THREAD_ID)?.status).toBe(
        "OPEN",
      );
    } finally {
      cleanupFixture(fixture);
    }
  });

  it("preserves CREATED and OPEN residue when turn/start transport fails after send", async () => {
    const fixture = createFixture(true);
    try {
      const harness = makeHarness(fixture, "turn-start-transport-failed");
      const result =
        await executeSingleSubtaskOwnedWorktreeCodexWithDependenciesForTest(
          fixture.storage,
          SUBTASK_ID,
          harness.dependencies,
        );
      expect(result).toMatchObject({
        success: false,
        providerRun: null,
        threadPolicy: null,
        diagnostics: { turnStartRequests: 1 },
      });
      expect(fixture.storage.getExecutionRunById(EXECUTION_RUN_ID)).toMatchObject({
        status: "CREATED",
        providerRun: null,
        startedAt: null,
      });
      expect(fixture.storage.getChatThreadById(CHAT_THREAD_ID)?.status).toBe(
        "OPEN",
      );
    } finally {
      cleanupFixture(fixture);
    }
  });

  it.each(["turn-started-before-response", "tools-before-response"] as const)(
    "accepts correlated %s ordering without retry",
    async (scenario) => {
      const fixture = createFixture(true);
      try {
        const harness = makeHarness(fixture, scenario);
        const result = await executeSingleSubtaskOwnedWorktreeCodexWithDependenciesForTest(
          fixture.storage,
          SUBTASK_ID,
          harness.dependencies,
        );
        expect(result).toMatchObject({
          success: true,
          diagnostics: { turnStartRequests: 1, interruptRequests: 0 },
        });
      } finally {
        cleanupFixture(fixture);
      }
    },
  );

  it("rejects a malformed turn/start response after correlated tool activity", async () => {
    const fixture = createFixture(true);
    try {
      const harness = makeHarness(fixture, "malformed-response-after-tools");
      const result = await executeSingleSubtaskOwnedWorktreeCodexWithDependenciesForTest(
        fixture.storage,
        SUBTASK_ID,
        harness.dependencies,
      );
      expect(result).toMatchObject({
        success: false,
        failureCode: "APP_SERVER_PROTOCOL_ERROR",
        diagnostics: { turnStartRequests: 1 },
      });
      expect(fixture.storage.getExecutionRunById(EXECUTION_RUN_ID)?.status).toBe(
        "CREATED",
      );
      expect(fixture.storage.getChatThreadById(CHAT_THREAD_ID)?.status).toBe(
        "OPEN",
      );
    } finally {
      cleanupFixture(fixture);
    }
  });

  it("denies durable success after HEAD changes during the turn", async () => {
      const fixture = createFixture(true);
      try {
        const harness = makeHarness(fixture, "head-drift-during-turn");
        const result = await executeSingleSubtaskOwnedWorktreeCodexWithDependenciesForTest(
          fixture.storage,
          SUBTASK_ID,
          harness.dependencies,
        );
        expect(result).toMatchObject({
          success: false,
          failureCode: "WORKTREE_AUTHORITY_DRIFT",
          terminalTurnStatus: "completed",
        });
        expect(fixture.storage.getExecutionRunById(EXECUTION_RUN_ID)?.status).toBe(
          "FAILED",
        );
      } finally {
        cleanupFixture(fixture);
      }
  });

  it("denies durable success when the worktree disappears after the turn", async () => {
    const fixture = createFixture(true);
    try {
      const harness = makeHarness(fixture, "success", {
        beforeWorktreeAuthorityGate: (gate) => {
          if (gate === "POST_TURN_SUCCESS_GATE") {
            rmSync(fixture.worktreePath!, { force: true, recursive: true });
          }
        },
      });
      const result = await executeSingleSubtaskOwnedWorktreeCodexWithDependenciesForTest(
        fixture.storage,
        SUBTASK_ID,
        harness.dependencies,
      );
      expect(result).toMatchObject({
        success: false,
        failureCode: "WORKTREE_AUTHORITY_DRIFT",
        terminalTurnStatus: "completed",
      });
      expect(fixture.storage.getExecutionRunById(EXECUTION_RUN_ID)?.status).toBe(
        "FAILED",
      );
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
        expect(fixture.storage.getChatThreadById(CHAT_THREAD_ID)?.status).toBe(
          "CLOSED",
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
        expect(fixture.storage.getChatThreadById(CHAT_THREAD_ID)?.status).toBe(
          "CLOSED",
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
        failDurableOperation: "FINALIZE_ATTEMPT",
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
      expect(fixture.storage.getChatThreadById(CHAT_THREAD_ID)?.status).toBe(
        "OPEN",
      );
    } finally {
      cleanupFixture(fixture);
    }
  });

  it("prioritizes a post-turn hardlink violation over transient cleanup failure", async () => {
    const fixture = createFixture(true);
    try {
      const harness = makeHarness(fixture, "hardlink-during-turn", {
        removeWorkspaceThrows: true,
      });
      const result = await executeSingleSubtaskOwnedWorktreeCodexWithDependenciesForTest(
        fixture.storage,
        SUBTASK_ID,
        harness.dependencies,
      );
      expect(result).toMatchObject({
        success: false,
        failureCode: "WORKTREE_FILESYSTEM_UNSAFE",
        transientRuntimeCleaned: false,
      });
      expect(fixture.storage.getExecutionRunById(EXECUTION_RUN_ID)?.status).toBe(
        "FAILED",
      );
      for (const path of harness.transientDirectories) {
        rmSync(path, { force: true, recursive: true });
      }
    } finally {
      cleanupFixture(fixture);
    }
  });

  it("prioritizes terminal persistence failure over cleanup failure", async () => {
    const fixture = createFixture(true);
    try {
      const harness = makeHarness(fixture, "success", {
        failDurableOperation: "FINALIZE_ATTEMPT",
        removeWorkspaceThrows: true,
      });
      const result = await executeSingleSubtaskOwnedWorktreeCodexWithDependenciesForTest(
        fixture.storage,
        SUBTASK_ID,
        harness.dependencies,
      );
      expect(result.failureCode).toBe("DURABLE_RUN_PERSISTENCE_FAILED");
      expect(fixture.storage.getExecutionRunById(EXECUTION_RUN_ID)?.status).toBe(
        "RUNNING",
      );
      expect(fixture.storage.getChatThreadById(CHAT_THREAD_ID)?.status).toBe(
        "OPEN",
      );
      for (const path of harness.transientDirectories) {
        rmSync(path, { force: true, recursive: true });
      }
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

  it("does not fabricate RUNNING state or pre-start failure after turn/start is sent", async () => {
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
        threadPolicy: null,
        diagnostics: { turnStartRequests: 1 },
      });
      expect(fixture.storage.getExecutionRunById(EXECUTION_RUN_ID)).toMatchObject({
        status: "CREATED",
        providerRun: null,
      });
      expect(fixture.storage.getChatThreadById(CHAT_THREAD_ID)?.status).toBe(
        "OPEN",
      );
    } finally {
      cleanupFixture(fixture);
    }
  });

  it("denies release when an execution reservation wins", () => {
    const fixture = createFixture(true);
    try {
      fixture.storage.reservePrimaryExecutionAttempt({
        subtaskId: SUBTASK_ID,
        worktreeOwnershipId: OWNERSHIP_ID,
        chatThreadId: CHAT_THREAD_ID,
        executionRunId: EXECUTION_RUN_ID,
        providerId: PROVIDER_ID,
      });
      expect(() =>
        fixture.manager.releaseOwnedWorktreeForSubtask(SUBTASK_ID),
      ).toThrow(WorktreeOwnershipError);
      try {
        fixture.manager.releaseOwnedWorktreeForSubtask(SUBTASK_ID);
      } catch (error: unknown) {
        expect((error as WorktreeOwnershipError).code).toBe(
          "ACTIVE_EXECUTION_EXISTS",
        );
      }
      expect(
        fixture.manager.resolveActiveOwnedWorktreeForSubtask(SUBTASK_ID)
          .ownership.status,
      ).toBe("ACTIVE");
    } finally {
      cleanupFixture(fixture);
    }
  });

  it("prevents execution reservation when release wins", () => {
    const fixture = createFixture(true);
    try {
      expect(
        fixture.manager.releaseOwnedWorktreeForSubtask(SUBTASK_ID).status,
      ).toBe("RELEASED");
      expect(() =>
        fixture.storage.reservePrimaryExecutionAttempt({
          subtaskId: SUBTASK_ID,
          worktreeOwnershipId: OWNERSHIP_ID,
          chatThreadId: CHAT_THREAD_ID,
          executionRunId: EXECUTION_RUN_ID,
          providerId: PROVIDER_ID,
        }),
      ).toThrow();
      expect(fixture.storage.getChatThreadById(CHAT_THREAD_ID)).toBeNull();
    } finally {
      cleanupFixture(fixture);
    }
  });

  it("preserves release exclusion after database reopen", () => {
    const fixture = createFixture(true);
    fixture.storage.reservePrimaryExecutionAttempt({
      subtaskId: SUBTASK_ID,
      worktreeOwnershipId: OWNERSHIP_ID,
      chatThreadId: CHAT_THREAD_ID,
      executionRunId: EXECUTION_RUN_ID,
      providerId: PROVIDER_ID,
    });
    fixture.storage.close();
    const reopened = openTaskDatabase({
      databasePath: fixture.databasePath,
      clock: fixedClock,
    });
    const manager = createWorktreeOwnershipManagerForTesting(reopened, {
      worktreeRoot: join(fixture.directory, "owned-worktrees"),
      idGenerator: () => `wt_${"d".repeat(32)}`,
    });
    try {
      expect(() => manager.releaseOwnedWorktreeForSubtask(SUBTASK_ID)).toThrow(
        WorktreeOwnershipError,
      );
    } finally {
      reopened.close();
      rmSync(fixture.directory, { force: true, recursive: true });
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
    readonly afterDurableOperation?: NonNullable<
      TestDependencies["afterDurableOperation"]
    >;
    readonly failResolveCall?: number;
    readonly removeWorkspaceThrows?: boolean;
    readonly limits?: Partial<TestDependencies["limits"]>;
    readonly threadStartVariant?: ThreadStartVariant;
    readonly beforeWorktreeAuthorityGate?: NonNullable<
      TestDependencies["beforeWorktreeAuthorityGate"]
    >;
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
    validateWorktreeFilesystem: validateOwnedWorktreeHardlinkSafety,
    beforeDurableOperation: (operation) => {
      if (operation === options.failDurableOperation) {
        throw new Error("synthetic durable failure");
      }
    },
    afterDurableOperation: (operation) => {
      options.afterDurableOperation?.(operation);
      if (
        operation === "START_RUN" &&
        scenario === "wait-for-authority-mutation"
      ) {
        children[0]?.kill("SIGUSR1");
      }
    },
    ...(options.beforeWorktreeAuthorityGate === undefined
      ? {}
      : { beforeWorktreeAuthorityGate: options.beforeWorktreeAuthorityGate }),
    spawnAppServer: (_executable, arguments_, spawnOptions) => {
      launches.push({
        arguments_: [...arguments_],
        cwd: spawnOptions.cwd,
        env: { ...spawnOptions.env },
      });
      const child = spawn(
        process.execPath,
        [
          MOCK_WRITE_FIXTURE_PATH,
          `--scenario=${scenario}`,
          `--thread-start-variant=${options.threadStartVariant ?? "exact"}`,
        ],
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
    limits: { ...BASE_LIMITS, ...options.limits },
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
      maxActiveCodingSubtasks: 2,
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

function seedBlockingDependency(
  fixture: Fixture,
  requiredGate: "HARDENED" | "ACCEPTED",
  upstreamMaturity: "NOT_STARTED" | "HARDENED" | "ACCEPTED",
): void {
  fixture.storage.createSubtask(
    SubtaskCreateInputSchema.parse({
      recordType: "SUBTASK",
      id: UPSTREAM_SUBTASK_ID,
      bigTaskId: BIG_TASK_ID,
      title: "Write execution dependency",
      goal: "Provide deterministic dependency evidence",
      scopeIn: ["Stored readiness"],
      scopeOut: ["Provider calls"],
      acceptanceCriteria: ["Gate is evaluated from storage"],
      untouchedAreas: ["Real repositories"],
      status: "DONE",
      maturity: "NOT_STARTED",
      startPolicy: "MANUAL",
      delegationPolicy: "NONE",
      recommendedReasoningLevel: "HIGH",
      promptSeed: "Synthetic readiness dependency.",
    }),
  );
  setStoredSubtaskMaturity(
    fixture.databasePath,
    UPSTREAM_SUBTASK_ID,
    upstreamMaturity,
  );
  fixture.storage.replaceDependenciesForBigTask(BIG_TASK_ID, [
    SubtaskDependencySchema.parse({
      upstreamSubtaskId: UPSTREAM_SUBTASK_ID,
      downstreamSubtaskId: SUBTASK_ID,
      dependencyType: "BLOCKING",
      requiredGate,
      reason: `Synthetic ${requiredGate} execution gate.`,
    }),
  ]);
}

function seedIndependentSubtask(storage: TaskStorage): void {
  storage.createSubtask(
    SubtaskCreateInputSchema.parse({
      recordType: "SUBTASK",
      id: SECOND_SUBTASK_ID,
      bigTaskId: BIG_TASK_ID,
      title: "Independent write execution",
      goal: "Prove execution residue is scoped to one Subtask",
      scopeIn: ["Independent reservation"],
      scopeOut: ["Provider calls"],
      acceptanceCriteria: ["Independent reservation remains available"],
      untouchedAreas: ["Primary attempt"],
      status: "IN_PROGRESS",
      maturity: "NOT_STARTED",
      startPolicy: "MANUAL",
      delegationPolicy: "NONE",
      recommendedReasoningLevel: "HIGH",
      promptSeed: "Reserve only this independent synthetic Subtask.",
    }),
  );
}

function setStoredSubtaskStatus(
  databasePath: string,
  subtaskId: ReturnType<typeof SubtaskIdSchema.parse>,
  status: "DONE" | "DROPPED" | "ARCHIVED",
): void {
  updateStoredSubtask(databasePath, "status", status, subtaskId);
}

function setStoredSubtaskMaturity(
  databasePath: string,
  subtaskId: ReturnType<typeof SubtaskIdSchema.parse>,
  maturity: "NOT_STARTED" | "HARDENED" | "ACCEPTED",
): void {
  updateStoredSubtask(databasePath, "maturity", maturity, subtaskId);
}

function updateStoredSubtask(
  databasePath: string,
  column: "maturity" | "status",
  value: string,
  subtaskId: ReturnType<typeof SubtaskIdSchema.parse>,
): void {
  const sqlite = new DatabaseSync(databasePath);
  try {
    const result = sqlite
      .prepare(`UPDATE subtasks SET ${column} = ? WHERE id = ?`)
      .run(value, subtaskId);
    expect(result.changes).toBe(1);
  } finally {
    sqlite.close();
  }
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
