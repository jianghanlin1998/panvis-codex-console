import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  BigTaskSchema,
  ChatThreadIdSchema,
  ExecutionProviderIdSchema,
  ExecutionRunIdSchema,
  ProjectSchema,
  ProviderModelReferenceSchema,
  ProviderRunReferenceSchema,
  ProviderThreadReferenceSchema,
  SubtaskCreateInputSchema,
  SubtaskIdSchema,
  WorktreeOwnershipIdSchema,
} from "@codex-task-console/domain";
import { openTaskDatabase, TaskStorageError } from "../src/index.js";

const roots: string[] = [];
const CLOCK = () => new Date("2026-08-31T12:00:00.000Z");
const PROVIDER_ID = ExecutionProviderIdSchema.parse("openai-codex-app-server");

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("atomic primary execution authority", () => {
  it("allows exactly one reservation for one Subtask in one process", () => {
    const fixture = createFixture();
    try {
      const first = reserve(fixture.storage, "a");
      expect(first.executionRun.status).toBe("CREATED");
      expect(() => reserve(fixture.storage, "b")).toThrow(TaskStorageError);
      expect(fixture.storage.listChatThreadsForSubtask(fixture.subtaskId)).toHaveLength(1);
    } finally {
      fixture.storage.close();
    }
  });

  it("serializes the same gate across independent TaskStorage connections", () => {
    const fixture = createFixture();
    const second = openTaskDatabase({ databasePath: fixture.databasePath, clock: CLOCK });
    try {
      reserve(fixture.storage, "a");
      expect(() => reserve(second, "b")).toThrow(TaskStorageError);
      expect(second.listChatThreadsForSubtask(fixture.subtaskId)).toHaveLength(1);
    } finally {
      second.close();
      fixture.storage.close();
    }
  });

  it("serializes a deterministic two-process race with exactly one winner", async () => {
    const fixture = createFixture();
    fixture.storage.close();
    const goPath = join(fixture.root, "go");
    const workers = ["alpha", "beta"].map((role) => ({
      role,
      readyPath: join(fixture.root, `${role}.ready`),
      outcomePath: join(fixture.root, `${role}.outcome`),
    }));
    const running = workers.map((worker) =>
      runProcessWorker(
        fixture.databasePath,
        worker.role,
        worker.readyPath,
        goPath,
        worker.outcomePath,
      ),
    );
    await waitForFiles(workers.map(({ readyPath }) => readyPath));
    writeFileSync(goPath, "go\n", "utf8");
    const results = await Promise.all(running);
    expect(results.map(({ status }) => status)).toEqual([0, 0]);
    const outcomes = workers.map(({ outcomePath }) =>
      readFileSync(outcomePath, "utf8").trim(),
    );
    expect(outcomes.sort()).toEqual(["CONFLICT", "WINNER"]);
    const reopened = openTaskDatabase({ databasePath: fixture.databasePath, clock: CLOCK });
    try {
      expect(reopened.listChatThreadsForSubtask(fixture.subtaskId)).toHaveLength(1);
    } finally {
      reopened.close();
    }
  });

  it("allows a later attempt only after atomic terminalization closes the first thread", () => {
    const fixture = createFixture();
    try {
      const first = reserve(fixture.storage, "a");
      const finalized = fixture.storage.finalizePrimaryExecutionAttempt({
        executionRunId: first.executionRun.id,
        status: "FAILED",
      });
      expect(finalized.executionRun.status).toBe("FAILED");
      expect(finalized.chatThread.status).toBe("CLOSED");
      expect(reserve(fixture.storage, "b").executionRun.status).toBe("CREATED");
    } finally {
      fixture.storage.close();
    }
  });

  it("keeps CREATED crash residue authoritative across close and reopen", () => {
    const fixture = createFixture();
    reserve(fixture.storage, "a");
    fixture.storage.close();
    const reopened = openTaskDatabase({ databasePath: fixture.databasePath, clock: CLOCK });
    try {
      expect(() => reserve(reopened, "b")).toThrow(TaskStorageError);
    } finally {
      reopened.close();
    }
  });

  it("keeps RUNNING crash residue authoritative across close and reopen", () => {
    const fixture = createFixture();
    const attempt = reserve(fixture.storage, "a");
    bindAndStart(fixture.storage, attempt.chatThread.id, attempt.executionRun.id);
    fixture.storage.close();
    const reopened = openTaskDatabase({ databasePath: fixture.databasePath, clock: CLOCK });
    try {
      expect(() => reserve(reopened, "b")).toThrow(TaskStorageError);
    } finally {
      reopened.close();
    }
  });

  it("does not impose a global mutex across different Subtasks", () => {
    const fixture = createFixture(true);
    try {
      const first = reserve(fixture.storage, "a", fixture.subtaskId, fixture.ownershipId);
      const second = reserve(
        fixture.storage,
        "b",
        fixture.secondSubtaskId!,
        fixture.secondOwnershipId!,
      );
      expect(first.executionRun.status).toBe("CREATED");
      expect(second.executionRun.status).toBe("CREATED");
    } finally {
      fixture.storage.close();
    }
  });

  it("rolls back ChatThread creation when ExecutionRun insertion fails", () => {
    const fixture = createFixture();
    try {
      const sqlite = new DatabaseSync(fixture.databasePath);
      try {
        sqlite.exec(`CREATE TRIGGER reject_primary_run_insert
          BEFORE INSERT ON execution_runs
          BEGIN
            SELECT RAISE(ABORT, 'synthetic run insertion failure');
          END`);
      } finally {
        sqlite.close();
      }
      expect(() => reserve(fixture.storage, "a")).toThrow(TaskStorageError);
      expect(
        fixture.storage.listChatThreadsForSubtask(fixture.subtaskId),
      ).toHaveLength(0);
      expect(
        fixture.storage.getExecutionRunById(
          ExecutionRunIdSchema.parse("run_primary_a"),
        ),
      ).toBeNull();
    } finally {
      fixture.storage.close();
    }
  });

  it("rolls back terminal run state when one-attempt thread closure fails", () => {
    const fixture = createFixture();
    try {
      const attempt = reserve(fixture.storage, "a");
      const sqlite = new DatabaseSync(fixture.databasePath);
      try {
        sqlite.exec("DROP TRIGGER IF EXISTS reject_primary_thread_close");
        sqlite.exec(`CREATE TRIGGER reject_primary_thread_close
          BEFORE UPDATE OF status ON chat_threads
          WHEN NEW.status = 'CLOSED'
          BEGIN
            SELECT RAISE(ABORT, 'synthetic close failure');
          END`);
      } finally {
        sqlite.close();
      }
      expect(() =>
        fixture.storage.finalizePrimaryExecutionAttempt({
          executionRunId: attempt.executionRun.id,
          status: "FAILED",
        }),
      ).toThrow(TaskStorageError);
      expect(fixture.storage.getExecutionRunById(attempt.executionRun.id)?.status).toBe(
        "CREATED",
      );
      expect(fixture.storage.getChatThreadById(attempt.chatThread.id)?.status).toBe(
        "OPEN",
      );
    } finally {
      fixture.storage.close();
    }
  });
});

function reserve(
  storage: ReturnType<typeof openTaskDatabase>,
  suffix: string,
  subtaskId = SubtaskIdSchema.parse("st_primary_a"),
  ownershipId = WorktreeOwnershipIdSchema.parse(`wt_${"a".repeat(32)}`),
) {
  return storage.reservePrimaryExecutionAttempt({
    subtaskId,
    worktreeOwnershipId: ownershipId,
    chatThreadId: ChatThreadIdSchema.parse(`thr_primary_${suffix}`),
    executionRunId: ExecutionRunIdSchema.parse(`run_primary_${suffix}`),
    providerId: PROVIDER_ID,
  });
}

function bindAndStart(
  storage: ReturnType<typeof openTaskDatabase>,
  chatThreadId: ReturnType<typeof ChatThreadIdSchema.parse>,
  executionRunId: ReturnType<typeof ExecutionRunIdSchema.parse>,
): void {
  const providerThread = ProviderThreadReferenceSchema.parse({
    providerId: PROVIDER_ID,
    providerThreadId: "provider-thread-primary",
  });
  storage.bindChatThreadProviderReference({ chatThreadId, providerThread });
  storage.startExecutionRun({
    executionRunId,
    providerRun: ProviderRunReferenceSchema.parse({
      providerId: PROVIDER_ID,
      providerThreadId: providerThread.providerThreadId,
      providerRunId: "provider-run-primary",
    }),
    providerModel: ProviderModelReferenceSchema.parse({
      providerId: PROVIDER_ID,
      providerModelId: "fixture-model",
    }),
  });
}

function createFixture(secondSubtask = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ctc-primary-authority-")));
  roots.push(root);
  const databasePath = join(root, "console.sqlite");
  const storage = openTaskDatabase({ databasePath, clock: CLOCK });
  storage.createProject(
    ProjectSchema.parse({
      recordType: "PROJECT",
      id: "prj_primary",
      name: "Primary authority",
      slug: "primary-authority",
      repository: { kind: "PATH", path: join(root, "source") },
      defaultBranch: "main",
      maxActiveCodingSubtasks: 2,
    }),
  );
  storage.createBigTask(
    BigTaskSchema.parse({
      recordType: "BIG_TASK",
      id: "bt_primary",
      projectId: "prj_primary",
      title: "Primary authority",
      goal: "Test primary execution",
      rationale: "Deterministic storage evidence",
      scopeIn: ["Primary attempts"],
      scopeOut: ["Provider calls"],
      acceptanceCriteria: ["One active attempt"],
      status: "IN_PROGRESS",
    }),
  );
  const subtaskId = createSubtask(storage, "a");
  const ownershipId = insertOwnership(databasePath, subtaskId, "a");
  const secondSubtaskId = secondSubtask ? createSubtask(storage, "b") : undefined;
  const secondOwnershipId =
    secondSubtaskId === undefined
      ? undefined
      : insertOwnership(databasePath, secondSubtaskId, "b");
  return {
    root,
    databasePath,
    storage,
    subtaskId,
    ownershipId,
    secondSubtaskId,
    secondOwnershipId,
  };
}

function createSubtask(
  storage: ReturnType<typeof openTaskDatabase>,
  suffix: string,
) {
  return storage.createSubtask(
    SubtaskCreateInputSchema.parse({
      recordType: "SUBTASK",
      id: `st_primary_${suffix}`,
      bigTaskId: "bt_primary",
      title: `Primary ${suffix}`,
      goal: "Test one primary attempt",
      scopeIn: ["Storage"],
      scopeOut: ["Provider"],
      acceptanceCriteria: ["Serialized"],
      untouchedAreas: ["External state"],
      status: "IN_PROGRESS",
      maturity: "NOT_STARTED",
      startPolicy: "MANUAL",
      delegationPolicy: "NONE",
      recommendedReasoningLevel: "HIGH",
      promptSeed: "Synthetic primary execution.",
    }),
  ).id;
}

function insertOwnership(
  databasePath: string,
  subtaskId: ReturnType<typeof SubtaskIdSchema.parse>,
  suffix: string,
) {
  const id = WorktreeOwnershipIdSchema.parse(
    `wt_${suffix.repeat(32)}`,
  );
  const sqlite = new DatabaseSync(databasePath);
  try {
    sqlite.prepare(
      `INSERT INTO worktree_ownerships (
        id, project_id, subtask_id, status, worktree_path, branch_name,
        starting_commit_sha, release_head_sha, created_at, activated_at,
        release_started_at, released_at, updated_at
      ) VALUES (?, 'prj_primary', ?, 'ACTIVE', ?, ?, ?, NULL, ?, ?, NULL, NULL, ?)`,
    ).run(
      id,
      subtaskId,
      join("/synthetic/owned", id),
      `ctc/worktree/${id}`,
      "1".repeat(40),
      CLOCK().toISOString(),
      CLOCK().toISOString(),
      CLOCK().toISOString(),
    );
  } finally {
    sqlite.close();
  }
  return id;
}

async function waitForFiles(paths: readonly string[]): Promise<void> {
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    if (paths.every((path) => existsSync(path))) {
      return;
    }
    await new Promise<void>((resolvePromise) => {
      setTimeout(resolvePromise, 5);
    });
  }
  throw new Error("Primary execution process barrier was not reached.");
}

function runProcessWorker(
  databasePath: string,
  role: string,
  readyPath: string,
  goPath: string,
  outcomePath: string,
): Promise<Readonly<{ readonly status: number | null; readonly output: string }>> {
  return new Promise((resolvePromise) => {
    const child = spawn(
      process.execPath,
      [
        join(process.cwd(), "node_modules", "vitest", "vitest.mjs"),
        "run",
        "packages/storage/test/primary-execution-process-worker.test.ts",
        "--maxWorkers=1",
        "--reporter=dot",
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          CTC_PRIMARY_PROCESS_ROLE: role,
          CTC_PRIMARY_PROCESS_DATABASE: databasePath,
          CTC_PRIMARY_PROCESS_READY: readyPath,
          CTC_PRIMARY_PROCESS_GO: goPath,
          CTC_PRIMARY_PROCESS_OUTCOME: outcomePath,
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
    child.on("close", (status) => {
      resolvePromise(Object.freeze({ status, output }));
    });
  });
}
