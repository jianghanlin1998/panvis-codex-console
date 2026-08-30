import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";

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
  ExecutionProviderId,
  ExecutionRunId,
  NormalizedUsage,
  ProviderModelReference,
  ProviderRunReference,
  ProviderThreadReference,
  SubtaskId,
} from "@codex-task-console/domain";
import * as storagePackage from "../src/index.js";
import { openTaskDatabase } from "../src/index.js";
import type { TaskStorage } from "../src/index.js";
import {
  captureTaskStorageError,
  createHierarchy,
  makeSubtask,
  withTemporaryDatabasePath,
} from "./fixtures.js";

const at = (value: string) => (): Date => new Date(value);
const INITIAL_TIME = "2037-02-03T04:05:06.007Z";
const EARLIER_TIME = "2037-02-03T04:05:06.006Z";
const LATER_TIME = "2037-02-03T04:05:07.007Z";

const threadId = (value: string): ChatThreadId => ChatThreadIdSchema.parse(value);
const runId = (value: string): ExecutionRunId => ExecutionRunIdSchema.parse(value);
const providerId = (value = "provider-alpha"): ExecutionProviderId =>
  ExecutionProviderIdSchema.parse(value);

const providerThread = (
  provider = providerId(),
  value = "remote-thread-alpha",
): ProviderThreadReference =>
  ProviderThreadReferenceSchema.parse({ providerId: provider, providerThreadId: value });

const providerRun = (
  provider = providerId(),
  providerThreadId = "remote-thread-alpha",
  value = "remote-run-alpha",
): ProviderRunReference =>
  ProviderRunReferenceSchema.parse({
    providerId: provider,
    providerThreadId,
    providerRunId: value,
  });

const providerModel = (
  provider = providerId(),
  value = "model-alpha",
): ProviderModelReference =>
  ProviderModelReferenceSchema.parse({ providerId: provider, providerModelId: value });

const createThread = (
  storage: TaskStorage,
  id: string,
  subtaskId: SubtaskId = makeSubtask("st_a").id,
  provider = providerId(),
) => storage.createChatThread({ id: threadId(id), subtaskId, providerId: provider });

const bindThread = (
  storage: TaskStorage,
  id: string,
  reference = providerThread(),
) =>
  storage.bindChatThreadProviderReference({
    chatThreadId: threadId(id),
    providerThread: reference,
  });

const createBoundThread = (
  storage: TaskStorage,
  id = "thr_hard_alpha",
  subtaskId: SubtaskId = makeSubtask("st_a").id,
  provider = providerId(),
  remoteThreadId = "remote-thread-alpha",
) => {
  createThread(storage, id, subtaskId, provider);
  return bindThread(storage, id, providerThread(provider, remoteThreadId));
};

const createRun = (storage: TaskStorage, id: string, owner = "thr_hard_alpha") =>
  storage.createExecutionRun({ id: runId(id), chatThreadId: threadId(owner) });

const startRun = (
  storage: TaskStorage,
  id: string,
  remoteRunId: string,
  model?: ProviderModelReference,
) =>
  storage.startExecutionRun({
    executionRunId: runId(id),
    providerRun: providerRun(providerId(), "remote-thread-alpha", remoteRunId),
    ...(model === undefined ? {} : { providerModel: model }),
  });

const rawRun = (sqlite: DatabaseSync, id: string): unknown =>
  sqlite.prepare("SELECT * FROM execution_runs WHERE id = ?").get(id);

const rawThread = (sqlite: DatabaseSync, id: string): unknown =>
  sqlite.prepare("SELECT * FROM chat_threads WHERE id = ?").get(id);

describe("Durable Execution V0 comprehensive hardening", () => {
  it("accepts equal durable timestamps and rejects clock regression atomically", () => {
    withTemporaryDatabasePath((databasePath) => {
      let now = INITIAL_TIME;
      const storage = openTaskDatabase({ databasePath, clock: () => new Date(now) });
      try {
        createHierarchy(storage);
        const createdThread = createThread(storage, "thr_clock");

        now = EARLIER_TIME;
        expect(captureTaskStorageError(() => bindThread(storage, "thr_clock")).code).toBe(
          "STORAGE_OPERATION_FAILED",
        );
        expect(storage.getChatThreadById(threadId("thr_clock"))).toEqual(createdThread);

        now = INITIAL_TIME;
        const bound = bindThread(storage, "thr_clock");
        expect(bound.updatedAt).toBe(INITIAL_TIME);
        const createdRun = createRun(storage, "run_clock", "thr_clock");

        now = EARLIER_TIME;
        expect(
          captureTaskStorageError(() => startRun(storage, "run_clock", "remote-run-clock"))
            .code,
        ).toBe("STORAGE_OPERATION_FAILED");
        expect(storage.getExecutionRunById(runId("run_clock"))).toEqual(createdRun);

        now = INITIAL_TIME;
        const running = startRun(storage, "run_clock", "remote-run-clock");
        expect(running.startedAt).toBe(INITIAL_TIME);

        now = EARLIER_TIME;
        expect(
          captureTaskStorageError(() =>
            storage.finishExecutionRun({
              executionRunId: runId("run_clock"),
              status: "SUCCEEDED",
              normalizedUsage: {},
            }),
          ).code,
        ).toBe("STORAGE_OPERATION_FAILED");
        expect(storage.getExecutionRunById(runId("run_clock"))).toEqual(running);

        now = INITIAL_TIME;
        const terminal = storage.finishExecutionRun({
          executionRunId: runId("run_clock"),
          status: "SUCCEEDED",
          normalizedUsage: {},
        });
        expect(terminal.endedAt).toBe(INITIAL_TIME);

        now = EARLIER_TIME;
        expect(
          captureTaskStorageError(() => storage.closeChatThread(threadId("thr_clock"))).code,
        ).toBe("STORAGE_OPERATION_FAILED");
        expect(storage.getChatThreadById(threadId("thr_clock"))).toEqual(bound);

        now = INITIAL_TIME;
        const closed = storage.closeChatThread(threadId("thr_clock"));
        expect(closed.closedAt).toBe(INITIAL_TIME);
      } finally {
        storage.close();
      }
    });
  });

  it("enforces the complete public lifecycle matrix and terminal immutability", () => {
    withTemporaryDatabasePath((databasePath) => {
      const storage = openTaskDatabase({ databasePath, clock: at(INITIAL_TIME) });
      try {
        createHierarchy(storage);
        createBoundThread(storage);

        for (const status of ["SUCCEEDED", "INTERRUPTED"] as const) {
          const id = `run_created_reject_${status.toLowerCase()}`;
          const created = createRun(storage, id);
          expect(() =>
            storage.finishExecutionRun({ executionRunId: runId(id), status }),
          ).toThrow(expect.objectContaining({ code: "CONFLICT" }));
          expect(storage.getExecutionRunById(runId(id))).toEqual(created);
          storage.failExecutionRunBeforeStart(runId(id));
        }

        for (const status of ["SUCCEEDED", "FAILED", "INTERRUPTED"] as const) {
          const id = `run_terminal_${status.toLowerCase()}`;
          createRun(storage, id);
          startRun(storage, id, `remote-${id}`);
          const terminal = storage.finishExecutionRun({
            executionRunId: runId(id),
            status,
            normalizedUsage: { toolCallCount: 0 },
          });
          const mutations = [
            () => startRun(storage, id, `replacement-${id}`),
            () => storage.failExecutionRunBeforeStart(runId(id)),
            () =>
              storage.finishExecutionRun({
                executionRunId: runId(id),
                status: status === "FAILED" ? "SUCCEEDED" : "FAILED",
              }),
          ];
          for (const mutation of mutations) {
            expect(captureTaskStorageError(mutation).code).toBe("CONFLICT");
            expect(storage.getExecutionRunById(runId(id))).toEqual(terminal);
          }
        }

        const activeCreated = createRun(storage, "run_active_created");
        const openThread = storage.getChatThreadById(threadId("thr_hard_alpha"));
        expect(() => storage.closeChatThread(threadId("thr_hard_alpha"))).toThrow(
          expect.objectContaining({ code: "CONFLICT" }),
        );
        expect(storage.getChatThreadById(threadId("thr_hard_alpha"))).toEqual(openThread);
        storage.failExecutionRunBeforeStart(activeCreated.id);

        createRun(storage, "run_active_running");
        startRun(storage, "run_active_running", "remote-active-running");
        expect(() => storage.closeChatThread(threadId("thr_hard_alpha"))).toThrow(
          expect.objectContaining({ code: "CONFLICT" }),
        );
        storage.finishExecutionRun({
          executionRunId: runId("run_active_running"),
          status: "FAILED",
        });
        const closed = storage.closeChatThread(threadId("thr_hard_alpha"));
        expect(closed.status).toBe("CLOSED");
        expect(() => storage.closeChatThread(closed.id)).toThrow(
          expect.objectContaining({ code: "CONFLICT" }),
        );
        expect(() =>
          storage.createExecutionRun({
            id: runId("run_after_close"),
            chatThreadId: closed.id,
          }),
        ).toThrow(expect.objectContaining({ code: "CONFLICT" }));
      } finally {
        storage.close();
      }
    });
  });

  it("enforces provider-neutral thread, run, and model ownership without partial writes", () => {
    withTemporaryDatabasePath((databasePath) => {
      const storage = openTaskDatabase({ databasePath, clock: at(INITIAL_TIME) });
      try {
        createHierarchy(storage);
        const alpha = createBoundThread(storage);
        expect(bindThread(storage, alpha.id, providerThread())).toEqual(alpha);
        createThread(storage, "thr_hard_beta", makeSubtask("st_b").id);
        const betaBefore = storage.getChatThreadById(threadId("thr_hard_beta"));
        expect(() => bindThread(storage, "thr_hard_beta", providerThread())).toThrow(
          expect.objectContaining({ code: "CONFLICT" }),
        );
        expect(storage.getChatThreadById(threadId("thr_hard_beta"))).toEqual(betaBefore);

        const otherProvider = providerId("provider-beta");
        createBoundThread(
          storage,
          "thr_hard_other_provider",
          makeSubtask("st_c").id,
          otherProvider,
          "remote-thread-beta",
        );
        const otherRun = createRun(storage, "run_other_provider", "thr_hard_other_provider");
        const otherStarted = storage.startExecutionRun({
          executionRunId: otherRun.id,
          providerRun: providerRun(
            otherProvider,
            "remote-thread-beta",
            "remote-run-beta",
          ),
          providerModel: providerModel(otherProvider, "model-beta"),
        });
        expect(otherStarted.providerRun?.providerId).toBe(otherProvider);

        const created = createRun(storage, "run_provider_conflict");
        expect(() =>
          storage.startExecutionRun({
            executionRunId: created.id,
            providerRun: providerRun(providerId(), "wrong-thread", "wrong-run"),
          }),
        ).toThrow(expect.objectContaining({ code: "CONFLICT" }));
        expect(storage.getExecutionRunById(created.id)).toEqual(created);

        const running = startRun(
          storage,
          "run_provider_conflict",
          "remote-run-model-conflict",
          providerModel(providerId(), "model-fixed"),
        );
        expect(() =>
          storage.finishExecutionRun({
            executionRunId: running.id,
            status: "SUCCEEDED",
            providerModel: providerModel(providerId(), "model-replacement"),
            normalizedUsage: { totalTokens: 99 },
          }),
        ).toThrow(expect.objectContaining({ code: "CONFLICT" }));
        expect(storage.getExecutionRunById(running.id)).toEqual(running);

        createRun(storage, "run_model_at_finish");
        startRun(storage, "run_model_at_finish", "remote-run-model-at-finish");
        expect(
          storage.finishExecutionRun({
            executionRunId: runId("run_model_at_finish"),
            status: "SUCCEEDED",
            providerModel: providerModel(providerId(), "model-established-at-finish"),
          }).providerModel,
        ).toEqual(providerModel(providerId(), "model-established-at-finish"));
      } finally {
        storage.close();
      }
    });
  });

  it("prevents duplicate provider-run ownership and preserves the losing run", () => {
    withTemporaryDatabasePath((databasePath) => {
      const storage = openTaskDatabase({ databasePath, clock: at(INITIAL_TIME) });
      try {
        createHierarchy(storage);
        createBoundThread(storage);
        createRun(storage, "run_provider_owner_a");
        const first = startRun(storage, "run_provider_owner_a", "shared-provider-run");
        const secondCreated = createRun(storage, "run_provider_owner_b");

        expect(() =>
          startRun(storage, "run_provider_owner_b", "shared-provider-run"),
        ).toThrow(expect.objectContaining({ code: "CONFLICT" }));
        expect(storage.getExecutionRunById(first.id)).toEqual(first);
        expect(storage.getExecutionRunById(secondCreated.id)).toEqual(secondCreated);
      } finally {
        storage.close();
      }
    });
  });

  it("round-trips every normalized usage shape, zeros, and safe boundaries after reopen", () => {
    withTemporaryDatabasePath((databasePath) => {
      const usages: readonly (NormalizedUsage | null)[] = [
        null,
        {},
        { inputTokens: 1 },
        { cachedInputTokens: 2 },
        { outputTokens: 3 },
        { reasoningTokens: 4 },
        { totalTokens: 5 },
        { runtimeSeconds: 0.125 },
        { toolCallCount: 6 },
        {
          inputTokens: 0,
          cachedInputTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
          totalTokens: 0,
          runtimeSeconds: 0,
          toolCallCount: 0,
        },
        {
          inputTokens: Number.MAX_SAFE_INTEGER,
          cachedInputTokens: Number.MAX_SAFE_INTEGER,
          reasoningTokens: Number.MAX_SAFE_INTEGER,
          toolCallCount: Number.MAX_SAFE_INTEGER,
        },
        { inputTokens: 8, outputTokens: 13, totalTokens: 21, runtimeSeconds: 34.55 },
      ];
      const first = openTaskDatabase({ databasePath, clock: at(INITIAL_TIME) });
      createHierarchy(first);
      createBoundThread(first);
      const expected = usages.map((usage, index) => {
        const id = `run_usage_${index.toString().padStart(2, "0")}`;
        createRun(first, id);
        startRun(first, id, `remote-usage-${index}`);
        return first.finishExecutionRun({
          executionRunId: runId(id),
          status: "SUCCEEDED",
          ...(usage === null ? {} : { normalizedUsage: usage }),
        });
      });
      first.close();

      const reopened = openTaskDatabase({ databasePath, clock: at(LATER_TIME) });
      try {
        expect(
          expected.map(({ id }) => reopened.getExecutionRunById(id)?.normalizedUsage),
        ).toEqual(usages);
        expect(reopened.getExecutionRunById(runId("run_usage_00"))?.normalizedUsage).toBeNull();
        expect(reopened.getExecutionRunById(runId("run_usage_01"))?.normalizedUsage).toEqual(
          {},
        );
      } finally {
        reopened.close();
      }
    });
  });

  it("rejects every invalid normalized usage form and unknown field without mutation", () => {
    withTemporaryDatabasePath((databasePath) => {
      const storage = openTaskDatabase({ databasePath, clock: at(INITIAL_TIME) });
      try {
        createHierarchy(storage);
        createBoundThread(storage);
        createRun(storage, "run_invalid_usage");
        const running = startRun(storage, "run_invalid_usage", "remote-invalid-usage");
        const invalidUsages = [
          { inputTokens: -1 },
          { inputTokens: 0.5 },
          { inputTokens: Number.MAX_SAFE_INTEGER + 1 },
          { runtimeSeconds: -0.1 },
          { runtimeSeconds: Number.NaN },
          { runtimeSeconds: Number.POSITIVE_INFINITY },
          { inputTokens: 1, outputTokens: 2, totalTokens: 4 },
          { arbitraryProviderBilling: "sensitive-usage-sentinel" },
        ] as const;
        for (const usage of invalidUsages) {
          const error = captureTaskStorageError(() =>
            storage.finishExecutionRun({
              executionRunId: running.id,
              status: "SUCCEEDED",
              normalizedUsage: usage as unknown as NormalizedUsage,
            }),
          );
          expect(error.code).toBe("INVALID_INPUT");
          expect(error.message).not.toContain("sensitive-usage-sentinel");
          expect(storage.getExecutionRunById(running.id)).toEqual(running);
        }
      } finally {
        storage.close();
      }
    });
  });

  it("rejects noncanonical IDs, malformed provider references, and extra mutation fields", () => {
    withTemporaryDatabasePath((databasePath) => {
      const storage = openTaskDatabase({ databasePath, clock: at(INITIAL_TIME) });
      try {
        createHierarchy(storage);
        expect(
          captureTaskStorageError(() =>
            storage.createChatThread({
              id: " thr_noncanonical" as ChatThreadId,
              subtaskId: makeSubtask("st_a").id,
              providerId: providerId(),
            }),
          ).code,
        ).toBe("INVALID_INPUT");
        createThread(storage, "thr_strict_input");
        const threadBefore = storage.getChatThreadById(threadId("thr_strict_input"));
        expect(
          captureTaskStorageError(() =>
            storage.bindChatThreadProviderReference({
              chatThreadId: threadId("thr_strict_input"),
              providerThread: {
                providerId: providerId(),
                providerThreadId: " remote-thread-whitespace ",
              } as ProviderThreadReference,
            }),
          ).code,
        ).toBe("INVALID_INPUT");
        expect(storage.getChatThreadById(threadId("thr_strict_input"))).toEqual(
          threadBefore,
        );
        bindThread(storage, "thr_strict_input", providerThread());

        expect(
          captureTaskStorageError(() =>
            storage.createExecutionRun({
              id: " run_noncanonical" as ExecutionRunId,
              chatThreadId: threadId("thr_strict_input"),
            }),
          ).code,
        ).toBe("INVALID_INPUT");
        const created = createRun(storage, "run_strict_input", "thr_strict_input");
        expect(
          captureTaskStorageError(() =>
            storage.startExecutionRun({
              executionRunId: created.id,
              providerRun: {
                providerId: providerId(),
                providerThreadId: "remote-thread-alpha",
                providerRunId: " remote-run-whitespace ",
              } as ProviderRunReference,
              rawProviderMetadata: "private-metadata-sentinel",
            } as never),
          ).code,
        ).toBe("INVALID_INPUT");
        expect(storage.getExecutionRunById(created.id)).toEqual(created);

        const running = startRun(storage, "run_strict_input", "remote-run-strict");
        const error = captureTaskStorageError(() =>
          storage.finishExecutionRun({
            executionRunId: running.id,
            status: "SUCCEEDED",
            transcript: "private-transcript-sentinel",
          } as never),
        );
        expect(error.code).toBe("INVALID_INPUT");
        expect(error.message).not.toMatch(/private-(metadata|transcript)-sentinel/);
        expect(storage.getExecutionRunById(running.id)).toEqual(running);
      } finally {
        storage.close();
      }
    });
  });

  it("orders equal and distinct timestamps by createdAt then Console ID across reopen", () => {
    withTemporaryDatabasePath((databasePath) => {
      const initial = openTaskDatabase({ databasePath, clock: at(INITIAL_TIME) });
      createHierarchy(initial);
      createThread(initial, "thr_order_z");
      createThread(initial, "thr_order_a");
      createRun(initial, "run_order_z", "thr_order_a");
      createRun(initial, "run_order_a", "thr_order_a");
      initial.close();

      const later = openTaskDatabase({ databasePath, clock: at(LATER_TIME) });
      createThread(later, "thr_order_later");
      createRun(later, "run_order_later", "thr_order_a");
      later.close();

      const reopened = openTaskDatabase({ databasePath, clock: at(LATER_TIME) });
      try {
        expect(
          reopened.listChatThreadsForSubtask(makeSubtask("st_a").id).map(({ id }) => id),
        ).toEqual([
          threadId("thr_order_a"),
          threadId("thr_order_z"),
          threadId("thr_order_later"),
        ]);
        expect(
          reopened.listExecutionRunsForChatThread(threadId("thr_order_a")).map(({ id }) => id),
        ).toEqual([
          runId("run_order_a"),
          runId("run_order_z"),
          runId("run_order_later"),
        ]);
      } finally {
        reopened.close();
      }
    });
  });

  it("uses database constraints to reject malformed ownership, lifecycle, and usage rows", () => {
    withTemporaryDatabasePath((databasePath) => {
      const storage = openTaskDatabase({ databasePath, clock: at(INITIAL_TIME) });
      createHierarchy(storage);
      createBoundThread(storage, "thr_constraints");
      storage.close();

      const sqlite = new DatabaseSync(databasePath);
      sqlite.exec("PRAGMA foreign_keys = ON");
      const insertThread = (values: readonly SQLInputValue[]) =>
        sqlite
          .prepare(
            `INSERT INTO chat_threads (
              id, subtask_id, provider_id, provider_thread_id, status,
              created_at, updated_at, closed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(...values);
      const validThread = [
        "thr_constraint_candidate",
        "st_a",
        "provider-alpha",
        null,
        "OPEN",
        INITIAL_TIME,
        INITIAL_TIME,
        null,
      ] as const;
      const invalidThreads = [
        ["bad_thread", ...validThread.slice(1)],
        ["thr_missing_parent", "st_missing", ...validThread.slice(2)],
        ["thr_bad_provider", "st_a", "Provider-Alpha", ...validThread.slice(3)],
        ["thr_bad_remote", "st_a", "provider-alpha", " remote ", ...validThread.slice(4)],
        ["thr_bad_status", ...validThread.slice(1, 4), "PAUSED", ...validThread.slice(5)],
        [
          "thr_open_closed",
          ...validThread.slice(1, 5),
          INITIAL_TIME,
          INITIAL_TIME,
          INITIAL_TIME,
        ],
        [
          "thr_closed_missing",
          ...validThread.slice(1, 4),
          "CLOSED",
          INITIAL_TIME,
          INITIAL_TIME,
          null,
        ],
        [
          "thr_closed_mismatch",
          ...validThread.slice(1, 4),
          "CLOSED",
          INITIAL_TIME,
          LATER_TIME,
          INITIAL_TIME,
        ],
      ];
      for (const values of invalidThreads) {
        expect(() => insertThread(values)).toThrow();
      }

      const insertRun = (values: readonly SQLInputValue[]) =>
        sqlite
          .prepare(
            `INSERT INTO execution_runs (
              id, chat_thread_id, status, provider_thread_id, provider_run_id,
              provider_model_id, usage_present, input_tokens, cached_input_tokens,
              output_tokens, reasoning_tokens, total_tokens, runtime_seconds,
              tool_call_count, created_at, updated_at, started_at, ended_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(...values);
      const createdRun = [
        "run_constraint_candidate",
        "thr_constraints",
        "CREATED",
        null,
        null,
        null,
        0,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        INITIAL_TIME,
        INITIAL_TIME,
        null,
        null,
      ] as const;
      const runningRun = [
        "run_constraint_running",
        "thr_constraints",
        "RUNNING",
        "remote-thread-alpha",
        "remote-run-constraint",
        null,
        0,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        INITIAL_TIME,
        INITIAL_TIME,
        INITIAL_TIME,
        null,
      ] as const;
      const invalidRuns = [
        ["bad_run", ...createdRun.slice(1)],
        ["run_missing_parent", "thr_missing", ...createdRun.slice(2)],
        ["run_bad_status", "thr_constraints", "PAUSED", ...createdRun.slice(3)],
        [
          "run_half_provider",
          "thr_constraints",
          "RUNNING",
          "remote-thread-alpha",
          null,
          ...runningRun.slice(5),
        ],
        [
          "run_created_provider",
          "thr_constraints",
          "CREATED",
          "remote-thread-alpha",
          "remote-run-created",
          ...createdRun.slice(5),
        ],
        ["run_running_missing", "thr_constraints", "RUNNING", ...createdRun.slice(3)],
        [
          "run_running_usage",
          ...runningRun.slice(1, 6),
          1,
          1,
          ...runningRun.slice(8),
        ],
        [
          "run_terminal_missing_end",
          "thr_constraints",
          "SUCCEEDED",
          ...runningRun.slice(3, 17),
          null,
        ],
        [
          "run_prestart_succeeded",
          "thr_constraints",
          "SUCCEEDED",
          ...createdRun.slice(3, 15),
          INITIAL_TIME,
          null,
          INITIAL_TIME,
        ],
        ["run_bad_marker", ...createdRun.slice(1, 6), 2, ...createdRun.slice(7)],
        ["run_usage_absent_values", ...createdRun.slice(1, 7), 1, ...createdRun.slice(8)],
        [
          "run_negative_usage",
          "thr_constraints",
          "FAILED",
          "remote-thread-alpha",
          "remote-run-negative",
          null,
          1,
          -1,
          null,
          null,
          null,
          null,
          null,
          null,
          INITIAL_TIME,
          INITIAL_TIME,
          INITIAL_TIME,
          INITIAL_TIME,
        ],
        [
          "run_fractional_usage",
          "thr_constraints",
          "FAILED",
          "remote-thread-alpha",
          "remote-run-fractional",
          null,
          1,
          0.5,
          null,
          null,
          null,
          null,
          null,
          null,
          INITIAL_TIME,
          INITIAL_TIME,
          INITIAL_TIME,
          INITIAL_TIME,
        ],
        [
          "run_inconsistent_total",
          "thr_constraints",
          "FAILED",
          "remote-thread-alpha",
          "remote-run-total",
          null,
          1,
          1,
          null,
          2,
          null,
          4,
          null,
          null,
          INITIAL_TIME,
          INITIAL_TIME,
          INITIAL_TIME,
          INITIAL_TIME,
        ],
      ];
      for (const values of invalidRuns) {
        expect(() => insertRun(values)).toThrow();
      }

      insertRun(runningRun);
      expect(() =>
        insertRun([
          "run_duplicate_provider_owner",
          ...runningRun.slice(1),
        ]),
      ).toThrow();
      sqlite.close();
    });
  });

  it("fails closed for identity, parent, timestamp, provider, and usage corruption", () => {
    const scenarios: readonly {
      readonly name: string;
      readonly corrupt: (sqlite: DatabaseSync) => void;
      readonly read: (storage: TaskStorage) => unknown;
    }[] = [
      {
        name: "noncanonical thread ID",
        corrupt: (sqlite) => sqlite.exec("UPDATE chat_threads SET id = ' thr_corrupt'"),
        read: (storage) => storage.listChatThreadsForSubtask(makeSubtask("st_a").id),
      },
      {
        name: "noncanonical run ID",
        corrupt: (sqlite) => sqlite.exec("UPDATE execution_runs SET id = ' run_corrupt'"),
        read: (storage) =>
          storage.listExecutionRunsForChatThread(threadId("thr_corrupt_source")),
      },
      {
        name: "missing Subtask parent",
        corrupt: (sqlite) =>
          sqlite.exec("UPDATE chat_threads SET subtask_id = 'st_missing_parent'"),
        read: (storage) => storage.getChatThreadById(threadId("thr_corrupt_source")),
      },
      {
        name: "missing ChatThread parent",
        corrupt: (sqlite) =>
          sqlite.exec("UPDATE execution_runs SET chat_thread_id = 'thr_missing_parent'"),
        read: (storage) => storage.getExecutionRunById(runId("run_corrupt_source")),
      },
      {
        name: "invalid timestamp",
        corrupt: (sqlite) => sqlite.exec("UPDATE chat_threads SET created_at = 'not-a-time'"),
        read: (storage) => storage.getChatThreadById(threadId("thr_corrupt_source")),
      },
      {
        name: "noncanonical UTC timestamp",
        corrupt: (sqlite) =>
          sqlite.exec(
            "UPDATE chat_threads SET created_at = '2037-02-03T04:05:06.007+00:00'",
          ),
        read: (storage) => storage.getChatThreadById(threadId("thr_corrupt_source")),
      },
      {
        name: "updated before created",
        corrupt: (sqlite) =>
          sqlite.exec("UPDATE chat_threads SET updated_at = '2037-02-03T04:05:06.006Z'"),
        read: (storage) => storage.getChatThreadById(threadId("thr_corrupt_source")),
      },
      {
        name: "started before created",
        corrupt: (sqlite) =>
          sqlite.exec("UPDATE execution_runs SET started_at = '2037-02-03T04:05:06.006Z'"),
        read: (storage) => storage.getExecutionRunById(runId("run_corrupt_source")),
      },
      {
        name: "ended before started",
        corrupt: (sqlite) =>
          sqlite.exec(
            `UPDATE execution_runs
             SET ended_at = '2037-02-03T04:05:06.006Z',
                 updated_at = '2037-02-03T04:05:06.006Z'`,
          ),
        read: (storage) => storage.getExecutionRunById(runId("run_corrupt_source")),
      },
      {
        name: "closed timestamp mismatch",
        corrupt: (sqlite) =>
          sqlite.exec(
            `UPDATE chat_threads SET status = 'CLOSED',
             closed_at = '2037-02-03T04:05:06.007Z',
             updated_at = '2037-02-03T04:05:07.007Z'`,
          ),
        read: (storage) => storage.getChatThreadById(threadId("thr_corrupt_source")),
      },
      {
        name: "invalid provider",
        corrupt: (sqlite) => sqlite.exec("UPDATE chat_threads SET provider_id = 'Provider Alpha'"),
        read: (storage) => storage.getChatThreadById(threadId("thr_corrupt_source")),
      },
      {
        name: "provider-owned whitespace",
        corrupt: (sqlite) =>
          sqlite.exec("UPDATE chat_threads SET provider_thread_id = ' sensitive-sentinel '") ,
        read: (storage) => storage.getChatThreadById(threadId("thr_corrupt_source")),
      },
      {
        name: "run/thread provider mismatch",
        corrupt: (sqlite) =>
          sqlite.exec("UPDATE execution_runs SET provider_thread_id = 'remote-thread-other'"),
        read: (storage) => storage.getExecutionRunById(runId("run_corrupt_source")),
      },
      {
        name: "run provider state on unbound thread",
        corrupt: (sqlite) => sqlite.exec("UPDATE chat_threads SET provider_thread_id = NULL"),
        read: (storage) => storage.getExecutionRunById(runId("run_corrupt_source")),
      },
      {
        name: "invalid usage marker",
        corrupt: (sqlite) => sqlite.exec("UPDATE execution_runs SET usage_present = 2"),
        read: (storage) => storage.getExecutionRunById(runId("run_corrupt_source")),
      },
      {
        name: "negative usage",
        corrupt: (sqlite) =>
          sqlite.exec("UPDATE execution_runs SET usage_present = 1, input_tokens = -1"),
        read: (storage) => storage.getExecutionRunById(runId("run_corrupt_source")),
      },
      {
        name: "incompatible total",
        corrupt: (sqlite) =>
          sqlite.exec(
            `UPDATE execution_runs SET usage_present = 1,
             input_tokens = 1, output_tokens = 2, total_tokens = 4`,
          ),
        read: (storage) => storage.getExecutionRunById(runId("run_corrupt_source")),
      },
      {
        name: "non-finite runtime",
        corrupt: (sqlite) =>
          sqlite.exec("UPDATE execution_runs SET usage_present = 1, runtime_seconds = 1e999"),
        read: (storage) => storage.getExecutionRunById(runId("run_corrupt_source")),
      },
    ];

    for (const scenario of scenarios) {
      withTemporaryDatabasePath((databasePath) => {
        const first = openTaskDatabase({ databasePath, clock: at(INITIAL_TIME) });
        createHierarchy(first);
        createBoundThread(first, "thr_corrupt_source");
        createRun(first, "run_corrupt_source", "thr_corrupt_source");
        startRun(first, "run_corrupt_source", "remote-run-corrupt");
        first.finishExecutionRun({
          executionRunId: runId("run_corrupt_source"),
          status: "SUCCEEDED",
        });
        first.close();

        const sqlite = new DatabaseSync(databasePath);
        sqlite.exec("PRAGMA foreign_keys = OFF");
        sqlite.exec("PRAGMA ignore_check_constraints = ON");
        scenario.corrupt(sqlite);
        sqlite.close();

        const reopened = openTaskDatabase({ databasePath, clock: at(LATER_TIME) });
        try {
          const error = captureTaskStorageError(() => scenario.read(reopened));
          expect(error.code, scenario.name).toBe("MALFORMED_STORED_DATA");
          expect(error.message, scenario.name).toBe("Stored task data is malformed.");
          expect(error.message).not.toMatch(/sensitive-sentinel|SELECT|UPDATE|sqlite/i);
        } finally {
          reopened.close();
        }
      });
    }
  });

  it("rolls back a database-induced mutation failure and sanitizes the error", () => {
    withTemporaryDatabasePath((databasePath) => {
      const initial = openTaskDatabase({ databasePath, clock: at(INITIAL_TIME) });
      createHierarchy(initial);
      const before = createThread(initial, "thr_trigger_failure");
      initial.close();

      const sqlite = new DatabaseSync(databasePath);
      sqlite.exec(`CREATE TRIGGER reject_provider_binding
        BEFORE UPDATE OF provider_thread_id ON chat_threads
        BEGIN
          SELECT RAISE(ABORT, 'private-trigger-sentinel');
        END`);
      sqlite.close();

      const storage = openTaskDatabase({ databasePath, clock: at(LATER_TIME) });
      try {
        const error = captureTaskStorageError(() =>
          bindThread(storage, "thr_trigger_failure"),
        );
        expect(error.code).toBe("TRANSACTION_FAILED");
        expect(error.message).toBe("The transaction failed and was rolled back.");
        expect(error.message).not.toContain("private-trigger-sentinel");
        expect(storage.getChatThreadById(before.id)).toEqual(before);
      } finally {
        storage.close();
      }
    });
  });

  it("serializes competing multi-connection ownership and lifecycle mutations", () => {
    withTemporaryDatabasePath((databasePath) => {
      const first = openTaskDatabase({ databasePath, clock: at(INITIAL_TIME) });
      createHierarchy(first);
      createThread(first, "thr_concurrent_a");
      createThread(first, "thr_concurrent_b", makeSubtask("st_b").id);
      const second = openTaskDatabase({ databasePath, clock: at(LATER_TIME) });
      try {
        const winner = bindThread(first, "thr_concurrent_a");
        const loserBefore = second.getChatThreadById(threadId("thr_concurrent_b"));
        expect(() => bindThread(second, "thr_concurrent_b")).toThrow(
          expect.objectContaining({ code: "CONFLICT" }),
        );
        expect(first.getChatThreadById(winner.id)).toEqual(winner);
        expect(second.getChatThreadById(threadId("thr_concurrent_b"))).toEqual(
          loserBefore,
        );

        createRun(first, "run_concurrent_start", "thr_concurrent_a");
        const started = startRun(first, "run_concurrent_start", "remote-run-winner");
        expect(() =>
          second.startExecutionRun({
            executionRunId: started.id,
            providerRun: providerRun(
              providerId(),
              "remote-thread-alpha",
              "remote-run-loser",
            ),
          }),
        ).toThrow(expect.objectContaining({ code: "CONFLICT" }));
        expect(second.getExecutionRunById(started.id)).toEqual(started);

        const terminal = first.finishExecutionRun({
          executionRunId: started.id,
          status: "SUCCEEDED",
          normalizedUsage: { totalTokens: 1 },
        });
        expect(() =>
          second.finishExecutionRun({ executionRunId: started.id, status: "FAILED" }),
        ).toThrow(expect.objectContaining({ code: "CONFLICT" }));
        expect(second.getExecutionRunById(started.id)).toEqual(terminal);
      } finally {
        second.close();
        first.close();
      }
    });
  });

  it("permits only serializable close-thread versus create-run outcomes", () => {
    withTemporaryDatabasePath((databasePath) => {
      const first = openTaskDatabase({ databasePath, clock: at(INITIAL_TIME) });
      createHierarchy(first);
      createThread(first, "thr_close_wins");
      const second = openTaskDatabase({ databasePath, clock: at(LATER_TIME) });
      try {
        first.closeChatThread(threadId("thr_close_wins"));
        expect(() => createRun(second, "run_close_lost", "thr_close_wins")).toThrow(
          expect.objectContaining({ code: "CONFLICT" }),
        );

        createThread(first, "thr_create_wins");
        const created = createRun(second, "run_create_won", "thr_create_wins");
        expect(() => first.closeChatThread(threadId("thr_create_wins"))).toThrow(
          expect.objectContaining({ code: "CONFLICT" }),
        );
        expect(first.getExecutionRunById(created.id)).toEqual(created);
        expect(first.getChatThreadById(threadId("thr_create_wins"))?.status).toBe("OPEN");
      } finally {
        second.close();
        first.close();
      }
    });
  });

  it("sanitizes deterministic SQLite busy failures and recovers after lock release", () => {
    withTemporaryDatabasePath((databasePath) => {
      const storage = openTaskDatabase({ databasePath, clock: at(INITIAL_TIME) });
      createHierarchy(storage);
      const locker = new DatabaseSync(databasePath);
      locker.exec("BEGIN IMMEDIATE");
      try {
        const error = captureTaskStorageError(() => createThread(storage, "thr_busy"));
        expect(error.code).toBe("TRANSACTION_FAILED");
        expect(error.message).toBe("The transaction could not start.");
        expect(error.message).not.toMatch(/busy|locked|sqlite|task-console/i);
        expect(storage.getChatThreadById(threadId("thr_busy"))).toBeNull();
      } finally {
        locker.exec("ROLLBACK");
        locker.close();
      }
      expect(createThread(storage, "thr_busy").status).toBe("OPEN");
      storage.close();
    });
  }, 10_000);

  it("keeps restrictive foreign keys active for durable history deletion", () => {
    withTemporaryDatabasePath((databasePath) => {
      const storage = openTaskDatabase({ databasePath, clock: at(INITIAL_TIME) });
      createHierarchy(storage);
      createBoundThread(storage, "thr_fk");
      createRun(storage, "run_fk", "thr_fk");
      storage.close();

      const sqlite = new DatabaseSync(databasePath);
      sqlite.exec("PRAGMA foreign_keys = ON");
      expect(() => sqlite.prepare("DELETE FROM subtasks WHERE id = ?").run("st_a")).toThrow();
      expect(() =>
        sqlite.prepare("DELETE FROM chat_threads WHERE id = ?").run("thr_fk"),
      ).toThrow();
      expect(rawThread(sqlite, "thr_fk")).toBeDefined();
      expect(rawRun(sqlite, "run_fk")).toBeDefined();
      sqlite.close();
    });
  });

  it("preserves strict public inputs, encapsulation, and data minimization", () => {
    withTemporaryDatabasePath((databasePath) => {
      const storage = openTaskDatabase({ databasePath, clock: at(INITIAL_TIME) });
      createHierarchy(storage);
      const sentinel = "private-prompt-context-response-auth-sentinel";
      const error = captureTaskStorageError(() =>
        storage.createChatThread({
          id: threadId("thr_privacy"),
          subtaskId: makeSubtask("st_a").id,
          providerId: providerId(),
          prompt: sentinel,
        } as never),
      );
      expect(error.code).toBe("INVALID_INPUT");
      expect(error.message).not.toContain(sentinel);
      expect(storage.getChatThreadById(threadId("thr_privacy"))).toBeNull();
      storage.close();

      const sqlite = new DatabaseSync(databasePath, { readOnly: true });
      const columns = ["chat_threads", "execution_runs"].flatMap((table) =>
        sqlite
          .prepare(`PRAGMA table_info(${table})`)
          .all()
          .map((row) => (row as { readonly name: string }).name),
      );
      sqlite.close();
      for (const forbidden of [
        "prompt",
        "context",
        "response",
        "transcript",
        "event",
        "reasoning_text",
        "tool_trace",
        "stderr",
        "process",
        "environment",
        "credential",
        "auth",
        "metadata",
        "raw_usage",
      ]) {
        expect(columns).not.toContain(forbidden);
      }

      const methods = Object.getOwnPropertyNames(storagePackage.TaskStorage.prototype);
      expect(methods).not.toEqual(
        expect.arrayContaining([
          "setStatus",
          "setProviderMetadata",
          "setRawUsage",
          "deleteChatThread",
          "deleteExecutionRun",
        ]),
      );
      expect(storagePackage).not.toHaveProperty("executeSingleSubtaskLiveCodex");
      expect(storagePackage).not.toHaveProperty("unsafeMutateExecutionRun");
    });
  });
});
