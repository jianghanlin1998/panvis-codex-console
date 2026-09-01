import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

import {
  BigTaskIdSchema,
  ChatThreadIdSchema,
  ExecutionProviderIdSchema,
  ExecutionRunIdSchema,
  ProjectIdSchema,
  SubtaskIdSchema,
} from "@codex-task-console/domain";
import type { SubtaskId } from "@codex-task-console/domain";
import {
  CODEX_APP_SERVER_PROVIDER_ID,
  executeSingleSubtaskOwnedWorktreeCodex,
} from "@codex-task-console/codex-adapter";
import type {
  OwnedWorktreeCodexExecutionResult,
} from "@codex-task-console/codex-adapter";
import { openTaskDatabase } from "@codex-task-console/storage";
import type { TaskStorage } from "@codex-task-console/storage";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createWorktreeOwnershipManagerForTesting } from "../../storage/src/worktree-ownership.js";
import { createLocalControlServiceForTesting } from "../src/service.js";
import type { LocalControlServiceError } from "../src/service.js";

interface Fixture {
  readonly root: string;
  readonly repository: string;
  readonly worktreeRoot: string;
  readonly storage: TaskStorage;
  readonly subtaskId: SubtaskId;
}

const fixtures: Fixture[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fixture.storage.close();
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

const git = (cwd: string, arguments_: readonly string[]): void => {
  const result = spawnSync("git", arguments_, {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, LC_ALL: "C" },
    timeout: 10_000,
  });
  if (result.status !== 0) {
    throw new Error("synthetic git fixture failed");
  }
};

const createFixture = (): Fixture => {
  const root = realpathSync.native(
    mkdtempSync(join(tmpdir(), "ctc-local-service-test-")),
  );
  const repository = join(root, "source");
  const worktreeRoot = join(root, "worktrees");
  mkdirSync(repository, { mode: 0o700 });
  mkdirSync(worktreeRoot, { mode: 0o700 });
  chmodSync(worktreeRoot, 0o700);
  git(repository, ["init", "-b", "main"]);
  writeFileSync(join(repository, "README.md"), "synthetic\n", {
    encoding: "utf-8",
  });
  git(repository, ["add", "README.md"]);
  git(repository, [
    "-c",
    "user.name=Codex Task Console Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "synthetic fixture",
  ]);

  const storage = openTaskDatabase({ databasePath: join(root, "console.sqlite3") });
  const projectId = ProjectIdSchema.parse("prj_local_service");
  const bigTaskId = BigTaskIdSchema.parse("bt_local_service");
  const subtaskId = SubtaskIdSchema.parse("st_local_service");
  storage.createProject({
    recordType: "PROJECT",
    id: projectId,
    name: "Local Service Test",
    slug: "local-service-test",
    repository: { kind: "PATH", path: repository },
    defaultBranch: "main",
    maxActiveCodingSubtasks: 2,
  });
  storage.createBigTask({
    recordType: "BIG_TASK",
    id: bigTaskId,
    projectId,
    title: "Synthetic Big Task",
    goal: "Test local control",
    rationale: "Deterministic integration",
    scopeIn: ["local"],
    scopeOut: [],
    acceptanceCriteria: ["passes"],
    status: "IN_PROGRESS",
  });
  storage.createSubtask({
    recordType: "SUBTASK",
    id: subtaskId,
    bigTaskId,
    title: "Synthetic Subtask",
    goal: "Exercise service",
    scopeIn: ["service"],
    scopeOut: [],
    acceptanceCriteria: ["passes"],
    untouchedAreas: [],
    status: "IN_PROGRESS",
    maturity: "NOT_STARTED",
    startPolicy: "MANUAL",
    delegationPolicy: "NONE",
    recommendedReasoningLevel: "LOW",
    promptSeed: "private prompt that must not be returned",
  });
  const fixture = { root, repository, worktreeRoot, storage, subtaskId };
  fixtures.push(fixture);
  return fixture;
};

const failedExecution = (): OwnedWorktreeCodexExecutionResult => ({
  success: false,
  failureCode: "ACTIVE_WORKTREE_REQUIRED",
  providerId: CODEX_APP_SERVER_PROVIDER_ID,
  runtime: null,
  authType: null,
  planType: null,
  preflight: null,
  chatThreadId: null,
  executionRunId: null,
  providerThread: null,
  providerRun: null,
  model: null,
  normalizedUsage: null,
  terminalTurnStatus: null,
  worktreeOwnershipId: null,
  worktreeStartingHeadSha: null,
  threadPolicy: null,
  diagnostics: {
    approvalRequestsDeclined: 0,
    interruptRequests: 0,
    notificationsReceived: 0,
    serverRequestsReceived: 0,
    toolActionsObserved: 0,
    turnStartRequests: 0,
    unknownNotificationsIgnored: 0,
  },
  appServerChildCleaned: true,
  transientRuntimeCleaned: true,
});

describe("trusted service composition with synthetic durable state", () => {
  it("inspects bounded state and provisions/releases through WorktreeOwnership", async () => {
    const fixture = createFixture();
    const manager = createWorktreeOwnershipManagerForTesting(fixture.storage, {
      worktreeRoot: fixture.worktreeRoot,
      idGenerator: () => "wt_11111111111111111111111111111111",
    });
    const execute = vi.fn(async () => failedExecution());
    const service = createLocalControlServiceForTesting(
      fixture.storage,
      manager,
      execute,
    );

    for (let index = 0; index < 10; index += 1) {
      fixture.storage.createChatThread({
        id: ChatThreadIdSchema.parse(`thr_local_service_${index}`),
        subtaskId: fixture.subtaskId,
        providerId: ExecutionProviderIdSchema.parse("synthetic-provider"),
      });
    }
    const initial = await service.inspectSubtask(fixture.subtaskId);
    expect(initial.subtask).toEqual({
      id: fixture.subtaskId,
      status: "IN_PROGRESS",
      maturity: "NOT_STARTED",
    });
    expect(initial.dependencyReadiness).toMatchObject({
      valid: true,
      ready: true,
      blockerCount: 0,
    });
    expect(initial.worktree).toBeNull();
    expect(initial.durableExecution.chatThreadCount).toBe(10);
    expect(initial.durableExecution.returnedChatThreadCount).toBe(8);
    expect(JSON.stringify(initial)).not.toMatch(
      /private prompt|promptSeed|worktreePath|console\.sqlite3/u,
    );

    const provisioned = await service.provisionOwnedWorktree(fixture.subtaskId);
    expect(provisioned.worktree).toMatchObject({
      id: "wt_11111111111111111111111111111111",
      status: "ACTIVE",
    });
    expect(provisioned.worktree).not.toHaveProperty("worktreePath");
    const active = await service.inspectSubtask(fixture.subtaskId);
    expect(active.worktree).toEqual({
      id: "wt_11111111111111111111111111111111",
      status: "ACTIVE",
      activeAuthorityVerified: true,
    });

    const execution = await service.runOwnedWorktreeExecution(fixture.subtaskId);
    expect(execution.execution.failureCode).toBe("ACTIVE_WORKTREE_REQUIRED");
    expect(execute).toHaveBeenCalledExactlyOnceWith(
      fixture.storage,
      fixture.subtaskId,
    );

    const released = await service.releaseOwnedWorktree(fixture.subtaskId);
    expect(released.worktree.status).toBe("RELEASED");
    expect(manager.listWorktreeOwnershipHistoryForSubtask(fixture.subtaskId)).toHaveLength(1);
  });

  it("maps missing and noncanonical Subtasks to sanitized service errors", async () => {
    const fixture = createFixture();
    const manager = createWorktreeOwnershipManagerForTesting(fixture.storage, {
      worktreeRoot: fixture.worktreeRoot,
      idGenerator: () => "wt_22222222222222222222222222222222",
    });
    const service = createLocalControlServiceForTesting(
      fixture.storage,
      manager,
      async () => failedExecution(),
    );
    await expect(
      service.inspectSubtask(SubtaskIdSchema.parse("st_missing")),
    ).rejects.toMatchObject({
      code: "SUBTASK_NOT_FOUND",
      httpStatus: 404,
    } satisfies Partial<LocalControlServiceError>);
  });

  it("queries high-cardinality durable history with bounded SQL reads", async () => {
    const fixture = createFixture();
    const manager = createWorktreeOwnershipManagerForTesting(fixture.storage, {
      worktreeRoot: fixture.worktreeRoot,
      idGenerator: () => "wt_33333333333333333333333333333333",
    });
    const service = createLocalControlServiceForTesting(
      fixture.storage,
      manager,
      async () => failedExecution(),
    );
    const listThreads = vi.spyOn(fixture.storage, "listChatThreadsForSubtask");
    const listRuns = vi.spyOn(
      fixture.storage,
      "listExecutionRunsForChatThread",
    );
    for (let threadIndex = 0; threadIndex < 24; threadIndex += 1) {
      const chatThreadId = ChatThreadIdSchema.parse(
        `thr_bounded_${String(threadIndex).padStart(2, "0")}`,
      );
      fixture.storage.createChatThread({
        id: chatThreadId,
        subtaskId: fixture.subtaskId,
        providerId: ExecutionProviderIdSchema.parse("synthetic-provider"),
      });
      for (let runIndex = 0; runIndex < 24; runIndex += 1) {
        fixture.storage.createExecutionRun({
          id: ExecutionRunIdSchema.parse(
            `run_bounded_${String(threadIndex).padStart(2, "0")}_${String(
              runIndex,
            ).padStart(2, "0")}`,
          ),
          chatThreadId,
        });
      }
    }

    const result = await service.inspectSubtask(fixture.subtaskId);
    expect(result.durableExecution.chatThreadCount).toBe(24);
    expect(result.durableExecution.recentChatThreads).toHaveLength(8);
    expect(
      result.durableExecution.recentChatThreads.map(({ id }) => id),
    ).toEqual(
      Array.from(
        { length: 8 },
        (_, index) => `thr_bounded_${String(index + 16).padStart(2, "0")}`,
      ),
    );
    for (const thread of result.durableExecution.recentChatThreads) {
      expect(thread.runs).toHaveLength(8);
      expect(thread.runs[0]?.id).toMatch(/_16$/u);
      expect(thread.runs[7]?.id).toMatch(/_23$/u);
    }
    expect(listThreads).not.toHaveBeenCalled();
    expect(listRuns).not.toHaveBeenCalled();
    for (const options of [
      { maxChatThreads: 0, maxExecutionRunsPerThread: 8 },
      { maxChatThreads: 8, maxExecutionRunsPerThread: 65 },
      { maxChatThreads: 1.5, maxExecutionRunsPerThread: 8 },
      {
        maxChatThreads: 8,
        maxExecutionRunsPerThread: 8,
        unbounded: true,
      },
    ]) {
      expect(() =>
        fixture.storage.readBoundedDurableExecutionHistoryForSubtask(
          fixture.subtaskId,
          options,
        ),
      ).toThrowError();
    }
  });

  it("uses the accepted Step 5B pre-provider gate and preserves worktree concurrency authority", async () => {
    const fixture = createFixture();
    const manager = createWorktreeOwnershipManagerForTesting(fixture.storage, {
      worktreeRoot: fixture.worktreeRoot,
      idGenerator: () => "wt_44444444444444444444444444444444",
    });
    const service = createLocalControlServiceForTesting(
      fixture.storage,
      manager,
      executeSingleSubtaskOwnedWorktreeCodex,
    );
    const preProvider = await service.runOwnedWorktreeExecution(
      fixture.subtaskId,
    );
    expect(preProvider.execution).toMatchObject({
      success: false,
      failureCode: "ACTIVE_WORKTREE_REQUIRED",
      chatThreadId: null,
      executionRunId: null,
      providerThreadId: null,
      providerRunId: null,
    });

    const provisions = await Promise.allSettled([
      service.provisionOwnedWorktree(fixture.subtaskId),
      service.provisionOwnedWorktree(fixture.subtaskId),
    ]);
    expect(provisions.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(provisions.filter(({ status }) => status === "rejected")).toHaveLength(1);
    expect(
      manager.listWorktreeOwnershipHistoryForSubtask(fixture.subtaskId),
    ).toHaveLength(1);
    await expect(service.releaseOwnedWorktree(fixture.subtaskId)).resolves.toMatchObject({
      worktree: { status: "RELEASED" },
    });
    await expect(
      service.releaseOwnedWorktree(fixture.subtaskId),
    ).rejects.toMatchObject({ code: "OPERATION_CONFLICT", httpStatus: 409 });
  });

  it("sanitizes malformed durable history and raw repository failures", async () => {
    const fixture = createFixture();
    const manager = createWorktreeOwnershipManagerForTesting(fixture.storage, {
      worktreeRoot: fixture.worktreeRoot,
      idGenerator: () => "wt_55555555555555555555555555555555",
    });
    const service = createLocalControlServiceForTesting(
      fixture.storage,
      manager,
      async () => failedExecution(),
    );
    const threadId = ChatThreadIdSchema.parse("thr_sanitization_target");
    fixture.storage.createChatThread({
      id: threadId,
      subtaskId: fixture.subtaskId,
      providerId: ExecutionProviderIdSchema.parse("synthetic-provider"),
    });
    const sqlite = new DatabaseSync(join(fixture.root, "console.sqlite3"));
    sqlite.exec("PRAGMA ignore_check_constraints = ON");
    sqlite
      .prepare("UPDATE chat_threads SET provider_id = ? WHERE id = ?")
      .run("/private/provider-secret", threadId);
    sqlite.close();

    let durableError: unknown;
    try {
      await service.inspectSubtask(fixture.subtaskId);
    } catch (error) {
      durableError = error;
    }
    expect(durableError).toMatchObject({
      code: "LOCAL_OPERATION_FAILED",
      httpStatus: 500,
    });
    expect(String(durableError)).not.toMatch(
      /provider-secret|console\.sqlite3|private prompt/u,
    );

    const freshFixture = createFixture();
    const failingManager = createWorktreeOwnershipManagerForTesting(
      freshFixture.storage,
      {
        worktreeRoot: freshFixture.worktreeRoot,
        idGenerator: () => "wt_66666666666666666666666666666666",
      },
    );
    rmSync(freshFixture.repository, { force: true, recursive: true });
    const failingService = createLocalControlServiceForTesting(
      freshFixture.storage,
      failingManager,
      async () => failedExecution(),
    );
    let repositoryError: unknown;
    try {
      await failingService.provisionOwnedWorktree(freshFixture.subtaskId);
    } catch (error) {
      repositoryError = error;
    }
    expect(repositoryError).toMatchObject({ httpStatus: 409 });
    expect(String(repositoryError)).not.toContain(freshFixture.repository);
  });
});
