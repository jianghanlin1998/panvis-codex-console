import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  ChatThreadIdSchema,
  ExecutionProviderIdSchema,
  ExecutionRunIdSchema,
  ProviderModelReferenceSchema,
  ProviderRunReferenceSchema,
  ProviderThreadReferenceSchema,
} from "@codex-task-console/domain";
import type {
  ChatThreadId,
  ExecutionRunId,
  ProviderModelReference,
  ProviderRunReference,
  ProviderThreadReference,
  SubtaskId,
} from "@codex-task-console/domain";
import { openTaskDatabase } from "../src/index.js";
import type { TaskStorage } from "../src/index.js";
import {
  captureTaskStorageError,
  createHierarchy,
  fixedClock,
  makeSubtask,
  withMemoryStorage,
  withTemporaryDatabasePath,
} from "./fixtures.js";

const providerId = ExecutionProviderIdSchema.parse("codex-app-server");
const threadId = (value: string): ChatThreadId => ChatThreadIdSchema.parse(value);
const runId = (value: string): ExecutionRunId => ExecutionRunIdSchema.parse(value);

const providerThread = (value = "provider-thread-1"): ProviderThreadReference =>
  ProviderThreadReferenceSchema.parse({
    providerId,
    providerThreadId: value,
  });

const providerRun = (
  providerThreadId = "provider-thread-1",
  providerRunId = "provider-run-1",
): ProviderRunReference =>
  ProviderRunReferenceSchema.parse({ providerId, providerThreadId, providerRunId });

const providerModel = (value = "provider-model-1"): ProviderModelReference =>
  ProviderModelReferenceSchema.parse({ providerId, providerModelId: value });

const createThread = (
  storage: TaskStorage,
  id = "thr_a",
  subtaskId: SubtaskId = makeSubtask("st_a").id,
) => storage.createChatThread({ id: threadId(id), subtaskId, providerId });

const createBoundThread = (
  storage: TaskStorage,
  id = "thr_a",
  providerThreadId = "provider-thread-1",
) => {
  createThread(storage, id);
  return storage.bindChatThreadProviderReference({
    chatThreadId: threadId(id),
    providerThread: providerThread(providerThreadId),
  });
};

describe("durable ChatThread storage", () => {
  it("creates, gets, and deterministically lists multiple threads per Subtask", () => {
    withMemoryStorage((storage) => {
      createHierarchy(storage);
      const laterId = threadId("thr_b");
      const earlierId = threadId("thr_a");
      storage.createChatThread({
        id: laterId,
        subtaskId: makeSubtask("st_a").id,
        providerId,
      });
      const earlier = storage.createChatThread({
        id: earlierId,
        subtaskId: makeSubtask("st_a").id,
        providerId,
      });
      createThread(storage, "thr_other", makeSubtask("st_b").id);

      expect(storage.getChatThreadById(earlierId)).toEqual(earlier);
      expect(
        storage.listChatThreadsForSubtask(makeSubtask("st_a").id).map(({ id }) => id),
      ).toEqual([earlierId, laterId]);
    });
  });

  it("binds once, permits exact idempotent rebinding, and rejects conflicting rebinding atomically", () => {
    withMemoryStorage((storage) => {
      createHierarchy(storage);
      createThread(storage);
      const bound = storage.bindChatThreadProviderReference({
        chatThreadId: threadId("thr_a"),
        providerThread: providerThread(),
      });
      expect(
        storage.bindChatThreadProviderReference({
          chatThreadId: threadId("thr_a"),
          providerThread: providerThread(),
        }),
      ).toEqual(bound);

      expect(() =>
        storage.bindChatThreadProviderReference({
          chatThreadId: threadId("thr_a"),
          providerThread: providerThread("different-thread"),
        }),
      ).toThrow(expect.objectContaining({ code: "CONFLICT" }));
      expect(storage.getChatThreadById(threadId("thr_a"))).toEqual(bound);
    });
  });

  it("prevents one provider thread from belonging to two Console threads", () => {
    withMemoryStorage((storage) => {
      createHierarchy(storage);
      createBoundThread(storage, "thr_a");
      createThread(storage, "thr_b");
      const before = storage.getChatThreadById(threadId("thr_b"));

      expect(() =>
        storage.bindChatThreadProviderReference({
          chatThreadId: threadId("thr_b"),
          providerThread: providerThread(),
        }),
      ).toThrow(expect.objectContaining({ code: "CONFLICT" }));
      expect(storage.getChatThreadById(threadId("thr_b"))).toEqual(before);
    });
  });

  it("rejects a missing Subtask and duplicate Console thread ID", () => {
    withMemoryStorage((storage) => {
      createHierarchy(storage);
      expect(() =>
        createThread(storage, "thr_missing", "st_missing" as SubtaskId),
      ).toThrow(expect.objectContaining({ code: "PARENT_NOT_FOUND" }));
      createThread(storage);
      expect(() => createThread(storage)).toThrow(
        expect.objectContaining({ code: "CONFLICT" }),
      );
    });
  });
});

describe("durable ExecutionRun lifecycle", () => {
  it("creates, gets, and deterministically lists multiple runs per thread", () => {
    withMemoryStorage((storage) => {
      createHierarchy(storage);
      createThread(storage);
      const laterId = runId("run_b");
      const earlierId = runId("run_a");
      storage.createExecutionRun({ id: laterId, chatThreadId: threadId("thr_a") });
      const earlier = storage.createExecutionRun({
        id: earlierId,
        chatThreadId: threadId("thr_a"),
      });

      expect(storage.getExecutionRunById(earlierId)).toEqual(earlier);
      expect(
        storage
          .listExecutionRunsForChatThread(threadId("thr_a"))
          .map(({ id }) => id),
      ).toEqual([earlierId, laterId]);
    });
  });

  it("supports the narrow CREATED to FAILED pre-start transition", () => {
    withMemoryStorage((storage) => {
      createHierarchy(storage);
      createThread(storage);
      storage.createExecutionRun({
        id: runId("run_prestart"),
        chatThreadId: threadId("thr_a"),
      });
      const failed = storage.failExecutionRunBeforeStart(runId("run_prestart"));
      expect(failed).toMatchObject({
        status: "FAILED",
        providerRun: null,
        providerModel: null,
        normalizedUsage: null,
        startedAt: null,
      });
      expect(failed.endedAt).toBe(failed.updatedAt);
    });
  });

  it.each(["SUCCEEDED", "FAILED", "INTERRUPTED"] as const)(
    "starts and finishes a run as %s with immutable provider state and normalized usage",
    (status) => {
      withMemoryStorage((storage) => {
        createHierarchy(storage);
        createBoundThread(storage);
        storage.createExecutionRun({
          id: runId("run_a"),
          chatThreadId: threadId("thr_a"),
        });
        const running = storage.startExecutionRun({
          executionRunId: runId("run_a"),
          providerRun: providerRun(),
          providerModel: providerModel(),
        });
        expect(running).toMatchObject({ status: "RUNNING", providerRun: providerRun() });
        expect(running.startedAt).toBe(running.updatedAt);

        const terminal = storage.finishExecutionRun({
          executionRunId: runId("run_a"),
          status,
          providerModel: providerModel(),
          normalizedUsage: {
            inputTokens: 2,
            outputTokens: 3,
            totalTokens: 5,
            runtimeSeconds: 1.25,
            toolCallCount: 1,
          },
        });
        expect(terminal).toMatchObject({
          status,
          providerRun: providerRun(),
          providerModel: providerModel(),
          normalizedUsage: {
            inputTokens: 2,
            outputTokens: 3,
            totalTokens: 5,
            runtimeSeconds: 1.25,
            toolCallCount: 1,
          },
        });
        expect(terminal.endedAt).toBe(terminal.updatedAt);
      });
    },
  );

  it("preserves present empty usage separately from absent usage", () => {
    withMemoryStorage((storage) => {
      createHierarchy(storage);
      createBoundThread(storage);
      for (const id of ["run_absent", "run_present"] as const) {
        storage.createExecutionRun({ id: runId(id), chatThreadId: threadId("thr_a") });
        storage.startExecutionRun({
          executionRunId: runId(id),
          providerRun: providerRun("provider-thread-1", `provider-${id}`),
        });
      }
      expect(
        storage.finishExecutionRun({
          executionRunId: runId("run_absent"),
          status: "SUCCEEDED",
        }).normalizedUsage,
      ).toBeNull();
      expect(
        storage.finishExecutionRun({
          executionRunId: runId("run_present"),
          status: "SUCCEEDED",
          normalizedUsage: {},
        }).normalizedUsage,
      ).toEqual({});
    });
  });

  it("rejects RUNNING to RUNNING, CREATED to SUCCEEDED, and terminal mutation", () => {
    withMemoryStorage((storage) => {
      createHierarchy(storage);
      createBoundThread(storage);
      storage.createExecutionRun({ id: runId("run_a"), chatThreadId: threadId("thr_a") });
      expect(() =>
        storage.finishExecutionRun({
          executionRunId: runId("run_a"),
          status: "SUCCEEDED",
        }),
      ).toThrow(expect.objectContaining({ code: "CONFLICT" }));
      storage.startExecutionRun({
        executionRunId: runId("run_a"),
        providerRun: providerRun(),
      });
      const running = storage.getExecutionRunById(runId("run_a"));
      expect(() =>
        storage.startExecutionRun({
          executionRunId: runId("run_a"),
          providerRun: providerRun(),
        }),
      ).toThrow(expect.objectContaining({ code: "CONFLICT" }));
      expect(storage.getExecutionRunById(runId("run_a"))).toEqual(running);

      const terminal = storage.finishExecutionRun({
        executionRunId: runId("run_a"),
        status: "SUCCEEDED",
      });
      expect(() =>
        storage.finishExecutionRun({
          executionRunId: runId("run_a"),
          status: "FAILED",
        }),
      ).toThrow(expect.objectContaining({ code: "CONFLICT" }));
      expect(() => storage.failExecutionRunBeforeStart(runId("run_a"))).toThrow(
        expect.objectContaining({ code: "CONFLICT" }),
      );
      expect(storage.getExecutionRunById(runId("run_a"))).toEqual(terminal);
    });
  });
});

describe("provider consistency and transition atomicity", () => {
  it("rejects start before provider-thread binding without mutating the run", () => {
    withMemoryStorage((storage) => {
      createHierarchy(storage);
      createThread(storage);
      const created = storage.createExecutionRun({
        id: runId("run_a"),
        chatThreadId: threadId("thr_a"),
      });
      expect(() =>
        storage.startExecutionRun({
          executionRunId: runId("run_a"),
          providerRun: providerRun(),
        }),
      ).toThrow(expect.objectContaining({ code: "CONFLICT" }));
      expect(storage.getExecutionRunById(runId("run_a"))).toEqual(created);
    });
  });

  it.each([
    {
      name: "provider mismatch",
      providerRun: ProviderRunReferenceSchema.parse({
        providerId: "other-provider",
        providerThreadId: "provider-thread-1",
        providerRunId: "provider-run-1",
      }),
    },
    {
      name: "provider-thread mismatch",
      providerRun: providerRun("other-thread"),
    },
  ])("rejects provider-run $name atomically", ({ providerRun: invalidReference }) => {
    withMemoryStorage((storage) => {
      createHierarchy(storage);
      createBoundThread(storage);
      const created = storage.createExecutionRun({
        id: runId("run_a"),
        chatThreadId: threadId("thr_a"),
      });
      expect(() =>
        storage.startExecutionRun({
          executionRunId: runId("run_a"),
          providerRun: invalidReference,
        }),
      ).toThrow(expect.objectContaining({ code: "CONFLICT" }));
      expect(storage.getExecutionRunById(runId("run_a"))).toEqual(created);
    });
  });

  it("rejects a conflicting final model without mutating running state", () => {
    withMemoryStorage((storage) => {
      createHierarchy(storage);
      createBoundThread(storage);
      storage.createExecutionRun({ id: runId("run_a"), chatThreadId: threadId("thr_a") });
      const running = storage.startExecutionRun({
        executionRunId: runId("run_a"),
        providerRun: providerRun(),
        providerModel: providerModel("model-a"),
      });

      expect(() =>
        storage.finishExecutionRun({
          executionRunId: runId("run_a"),
          status: "SUCCEEDED",
          providerModel: providerModel("model-b"),
          normalizedUsage: { totalTokens: 10 },
        }),
      ).toThrow(expect.objectContaining({ code: "CONFLICT" }));
      expect(storage.getExecutionRunById(runId("run_a"))).toEqual(running);
    });
  });
});

describe("ChatThread close invariants", () => {
  it("rejects close with CREATED or RUNNING runs and leaves the thread unchanged", () => {
    withMemoryStorage((storage) => {
      createHierarchy(storage);
      const open = createBoundThread(storage);
      storage.createExecutionRun({ id: runId("run_created"), chatThreadId: threadId("thr_a") });
      expect(() => storage.closeChatThread(threadId("thr_a"))).toThrow(
        expect.objectContaining({ code: "CONFLICT" }),
      );
      expect(storage.getChatThreadById(threadId("thr_a"))).toEqual(open);

      storage.failExecutionRunBeforeStart(runId("run_created"));
      storage.createExecutionRun({ id: runId("run_running"), chatThreadId: threadId("thr_a") });
      storage.startExecutionRun({
        executionRunId: runId("run_running"),
        providerRun: providerRun("provider-thread-1", "provider-run-running"),
      });
      expect(() => storage.closeChatThread(threadId("thr_a"))).toThrow(
        expect.objectContaining({ code: "CONFLICT" }),
      );
      expect(storage.getChatThreadById(threadId("thr_a"))).toEqual(open);
    });
  });

  it("closes with terminal runs and rejects all later thread lifecycle mutation", () => {
    withMemoryStorage((storage) => {
      createHierarchy(storage);
      createThread(storage);
      storage.createExecutionRun({ id: runId("run_a"), chatThreadId: threadId("thr_a") });
      storage.failExecutionRunBeforeStart(runId("run_a"));
      const closed = storage.closeChatThread(threadId("thr_a"));
      expect(closed.status).toBe("CLOSED");
      expect(closed.closedAt).toBe(closed.updatedAt);
      expect(() =>
        storage.createExecutionRun({ id: runId("run_late"), chatThreadId: threadId("thr_a") }),
      ).toThrow(expect.objectContaining({ code: "CONFLICT" }));
      expect(() => storage.closeChatThread(threadId("thr_a"))).toThrow(
        expect.objectContaining({ code: "CONFLICT" }),
      );
      expect(() =>
        storage.bindChatThreadProviderReference({
          chatThreadId: threadId("thr_a"),
          providerThread: providerThread(),
        }),
      ).toThrow(expect.objectContaining({ code: "CONFLICT" }));
      expect(storage.getChatThreadById(threadId("thr_a"))).toEqual(closed);
    });
  });
});

describe("durable execution reopen and strict readback", () => {
  it("round-trips exact terminal thread/run state after close and reopen", () => {
    withTemporaryDatabasePath((databasePath) => {
      const first = openTaskDatabase({ databasePath, clock: fixedClock });
      createHierarchy(first);
      createBoundThread(first);
      first.createExecutionRun({ id: runId("run_a"), chatThreadId: threadId("thr_a") });
      first.startExecutionRun({
        executionRunId: runId("run_a"),
        providerRun: providerRun(),
        providerModel: providerModel(),
      });
      const expectedRun = first.finishExecutionRun({
        executionRunId: runId("run_a"),
        status: "SUCCEEDED",
        normalizedUsage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
      });
      const expectedThread = first.closeChatThread(threadId("thr_a"));
      first.close();

      const reopened = openTaskDatabase({ databasePath, clock: fixedClock });
      try {
        expect(reopened.getChatThreadById(threadId("thr_a"))).toEqual(expectedThread);
        expect(reopened.getExecutionRunById(runId("run_a"))).toEqual(expectedRun);
        expect(reopened.listExecutionRunsForChatThread(threadId("thr_a"))).toEqual([
          expectedRun,
        ]);
      } finally {
        reopened.close();
      }
    });
  });

  it("fails closed instead of discarding malformed stored provider state", () => {
    withTemporaryDatabasePath((databasePath) => {
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      createHierarchy(storage);
      createBoundThread(storage);
      storage.createExecutionRun({ id: runId("run_a"), chatThreadId: threadId("thr_a") });
      storage.startExecutionRun({
        executionRunId: runId("run_a"),
        providerRun: providerRun(),
      });
      storage.close();

      const sqlite = new DatabaseSync(databasePath);
      sqlite.exec("PRAGMA ignore_check_constraints = ON");
      sqlite
        .prepare("UPDATE execution_runs SET provider_thread_id = ? WHERE id = ?")
        .run("other-thread", "run_a");
      sqlite.close();

      const reopened = openTaskDatabase({ databasePath, clock: fixedClock });
      try {
        expect(captureTaskStorageError(() => reopened.getExecutionRunById(runId("run_a"))).code)
          .toBe("MALFORMED_STORED_DATA");
      } finally {
        reopened.close();
      }
    });
  });
});
