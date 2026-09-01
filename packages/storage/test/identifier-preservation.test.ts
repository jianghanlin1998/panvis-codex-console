import { describe, expect, it } from "vitest";

import {
  ChatThreadIdSchema,
  ContextScopeSchema,
  ExecutionProviderIdSchema,
  ExecutionRunIdSchema,
  ProviderModelReferenceSchema,
  ProviderRunReferenceSchema,
  ProviderThreadReferenceSchema,
  SubtaskIdSchema,
} from "@codex-task-console/domain";
import type {
  ProviderModelReference,
  ProviderRunReference,
  ProviderThreadReference,
  SubtaskCreateInput,
  SubtaskId,
} from "@codex-task-console/domain";
import { openTaskDatabase } from "../src/index.js";
import {
  captureTaskStorageError,
  fixedClock,
  makeAuditEvent,
  makeBigTask,
  makeContextDigest,
  makeContextItem,
  makeDependency,
  makeImplementationCheckpoint,
  makeProject,
  makeSubtask,
  withTemporaryDatabasePath,
} from "./fixtures.js";

const codeUnits = (value: string): readonly number[] =>
  Array.from({ length: value.length }, (_, index) => value.charCodeAt(index));

const expectExactIdentifier = (actual: string, expected: string): void => {
  expect(actual).toBe(expected);
  expect(codeUnits(actual)).toEqual(codeUnits(expected));
};

describe("canonical durable identifier exact preservation", () => {
  it("round-trips valid Unicode identities through related lookups and close/reopen", () => {
    withTemporaryDatabasePath((databasePath) => {
      const composedProject = makeProject("prj_café", "unicode-composed");
      const decomposedProject = makeProject("prj_cafe\u0301", "unicode-decomposed");
      const bigTask = makeBigTask("bt_中文任务", composedProject.id);
      const primarySubtask = makeSubtask("st_日本語", bigTask.id);
      const implementationSubtask = makeSubtask("st_実装😀", bigTask.id, "IN_PROGRESS");
      const dependency = makeDependency(
        primarySubtask.id,
        implementationSubtask.id,
        "INFORMATIONAL",
      );
      const scope = ContextScopeSchema.parse({
        scopeType: "SUBTASK",
        projectId: composedProject.id,
        bigTaskId: bigTask.id,
        subtaskId: primarySubtask.id,
      });
      const contextItem = makeContextItem("ctx_证据😀", scope);
      const contextDigest = makeContextDigest("dgt_café%2F", scope);
      const auditEvent = makeAuditEvent("aud_監査😀", scope);
      const checkpoint = makeImplementationCheckpoint(
        "icp_実装😀",
        implementationSubtask.id,
      );
      const providerId = ExecutionProviderIdSchema.parse("synthetic-provider");
      const chatThreadId = ChatThreadIdSchema.parse("thr_对话😀");
      const executionRunId = ExecutionRunIdSchema.parse("run_执行%2F😀");
      const providerThread = ProviderThreadReferenceSchema.parse({
        providerId,
        providerThreadId: "线程😀%2F",
      });
      const providerRun = ProviderRunReferenceSchema.parse({
        providerId,
        providerThreadId: providerThread.providerThreadId,
        providerRunId: "运行café😀",
      });
      const providerModel = ProviderModelReferenceSchema.parse({
        providerId,
        providerModelId: "模型cafe\u0301😀",
      });

      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      expectExactIdentifier(storage.createProject(composedProject).id, composedProject.id);
      expectExactIdentifier(
        storage.createProject(decomposedProject).id,
        decomposedProject.id,
      );
      expect(composedProject.id).not.toBe(decomposedProject.id);
      expect(storage.listProjects().map(({ id }) => id)).toEqual(
        expect.arrayContaining([composedProject.id, decomposedProject.id]),
      );

      expectExactIdentifier(storage.createBigTask(bigTask).id, bigTask.id);
      expectExactIdentifier(
        storage.listBigTasksByProject(composedProject.id)[0]!.id,
        bigTask.id,
      );
      expectExactIdentifier(
        storage.createSubtask(primarySubtask).id,
        primarySubtask.id,
      );
      expectExactIdentifier(
        storage.createSubtask(implementationSubtask).id,
        implementationSubtask.id,
      );
      expect(storage.replaceDependenciesForBigTask(bigTask.id, [dependency])).toEqual([
        dependency,
      ]);
      expect(storage.listDependenciesForBigTask(bigTask.id)).toEqual([dependency]);

      expectExactIdentifier(storage.createContextItem(contextItem).id, contextItem.id);
      expectExactIdentifier(
        storage.listContextItemsByScope(scope)[0]!.id,
        contextItem.id,
      );
      expectExactIdentifier(
        storage.createContextDigest(contextDigest).id,
        contextDigest.id,
      );
      expectExactIdentifier(storage.getContextDigestByScope(scope)!.id, contextDigest.id);
      expectExactIdentifier(storage.appendAuditEvent(auditEvent).id, auditEvent.id);
      expectExactIdentifier(storage.listAuditEventsByScope(scope)[0]!.id, auditEvent.id);

      const completion = storage.completeSubtaskImplementation({
        subtaskId: implementationSubtask.id,
        checkpoint,
      });
      expectExactIdentifier(completion.checkpoint.id, checkpoint.id);
      expectExactIdentifier(
        storage.listSubtaskImplementationCheckpoints(implementationSubtask.id)[0]!.id,
        checkpoint.id,
      );

      storage.createChatThread({
        id: chatThreadId,
        subtaskId: primarySubtask.id,
        providerId,
      });
      const boundThread = storage.bindChatThreadProviderReference({
        chatThreadId,
        providerThread,
      });
      expectExactIdentifier(boundThread.id, chatThreadId);
      expectExactIdentifier(
        boundThread.providerThread!.providerThreadId,
        providerThread.providerThreadId,
      );
      storage.createExecutionRun({ id: executionRunId, chatThreadId });
      const running = storage.startExecutionRun({
        executionRunId,
        providerRun,
        providerModel,
      });
      expectExactIdentifier(running.id, executionRunId);
      expectExactIdentifier(running.providerRun!.providerRunId, providerRun.providerRunId);
      expectExactIdentifier(
        running.providerModel!.providerModelId,
        providerModel.providerModelId,
      );
      const expectedRun = storage.finishExecutionRun({
        executionRunId,
        status: "SUCCEEDED",
      });
      const expectedThread = storage.closeChatThread(chatThreadId);
      expect(storage.listChatThreadsForSubtask(primarySubtask.id)).toEqual([
        expectedThread,
      ]);
      expect(storage.listExecutionRunsForChatThread(chatThreadId)).toEqual([
        expectedRun,
      ]);
      storage.close();

      const reopened = openTaskDatabase({ databasePath, clock: fixedClock });
      try {
        expectExactIdentifier(
          reopened.getProjectById(composedProject.id)!.id,
          composedProject.id,
        );
        expectExactIdentifier(
          reopened.getProjectById(decomposedProject.id)!.id,
          decomposedProject.id,
        );
        expectExactIdentifier(reopened.getBigTaskById(bigTask.id)!.id, bigTask.id);
        expectExactIdentifier(
          reopened.getSubtaskById(primarySubtask.id)!.id,
          primarySubtask.id,
        );
        expectExactIdentifier(reopened.getContextItemById(contextItem.id)!.id, contextItem.id);
        expectExactIdentifier(
          reopened.getContextDigestById(contextDigest.id)!.id,
          contextDigest.id,
        );
        expectExactIdentifier(reopened.getAuditEventById(auditEvent.id)!.id, auditEvent.id);
        expectExactIdentifier(
          reopened.getSubtaskImplementationCheckpointById(checkpoint.id)!.id,
          checkpoint.id,
        );

        const rereadThread = reopened.getChatThreadById(chatThreadId)!;
        expectExactIdentifier(rereadThread.id, chatThreadId);
        expectExactIdentifier(
          rereadThread.providerThread!.providerThreadId,
          providerThread.providerThreadId,
        );
        const rereadRun = reopened.getExecutionRunById(executionRunId)!;
        expectExactIdentifier(rereadRun.id, executionRunId);
        expectExactIdentifier(
          rereadRun.providerRun!.providerThreadId,
          providerRun.providerThreadId,
        );
        expectExactIdentifier(
          rereadRun.providerRun!.providerRunId,
          providerRun.providerRunId,
        );
        expectExactIdentifier(
          rereadRun.providerModel!.providerModelId,
          providerModel.providerModelId,
        );
      } finally {
        reopened.close();
      }
    });
  });

  it("rejects malformed task and provider identities before any transformed row is created", () => {
    withTemporaryDatabasePath((databasePath) => {
      const storage = openTaskDatabase({ databasePath, clock: fixedClock });
      const project = makeProject();
      const bigTask = makeBigTask();
      storage.createProject(project);
      storage.createBigTask(bigTask);

      const malformedSubtaskId = "st_new-regression-\ud800" as SubtaskId;
      const malformedSubtask = {
        ...makeSubtask("st_valid", bigTask.id),
        id: malformedSubtaskId,
      } as SubtaskCreateInput;
      expect(captureTaskStorageError(() => storage.createSubtask(malformedSubtask))).toMatchObject(
        { code: "INVALID_INPUT" },
      );
      expect(storage.listSubtasksByBigTask(bigTask.id)).toEqual([]);
      expect(
        storage.getSubtaskById(SubtaskIdSchema.parse("st_new-regression-�")),
      ).toBeNull();

      const subtask = storage.createSubtask(makeSubtask("st_provider-boundary", bigTask.id));
      const providerId = ExecutionProviderIdSchema.parse("synthetic-provider");
      const chatThreadId = ChatThreadIdSchema.parse("thr_provider-boundary");
      const executionRunId = ExecutionRunIdSchema.parse("run_provider-boundary");
      storage.createChatThread({ id: chatThreadId, subtaskId: subtask.id, providerId });

      const malformedProviderThread = {
        providerId,
        providerThreadId: "thread-\ud800",
      } as ProviderThreadReference;
      expect(
        captureTaskStorageError(() =>
          storage.bindChatThreadProviderReference({
            chatThreadId,
            providerThread: malformedProviderThread,
          }),
        ),
      ).toMatchObject({ code: "INVALID_INPUT" });
      expect(storage.getChatThreadById(chatThreadId)!.providerThread).toBeNull();

      const validProviderThread = ProviderThreadReferenceSchema.parse({
        providerId,
        providerThreadId: "线程-boundary",
      });
      storage.bindChatThreadProviderReference({ chatThreadId, providerThread: validProviderThread });
      storage.createExecutionRun({ id: executionRunId, chatThreadId });

      const malformedProviderRun = {
        providerId,
        providerThreadId: validProviderThread.providerThreadId,
        providerRunId: "run-\udc00",
      } as ProviderRunReference;
      expect(
        captureTaskStorageError(() =>
          storage.startExecutionRun({
            executionRunId,
            providerRun: malformedProviderRun,
          }),
        ),
      ).toMatchObject({ code: "INVALID_INPUT" });

      const validProviderRun = ProviderRunReferenceSchema.parse({
        providerId,
        providerThreadId: validProviderThread.providerThreadId,
        providerRunId: "运行-boundary",
      });
      const malformedProviderModel = {
        providerId,
        providerModelId: "model-middle-\ud800-value",
      } as ProviderModelReference;
      expect(
        captureTaskStorageError(() =>
          storage.startExecutionRun({
            executionRunId,
            providerRun: validProviderRun,
            providerModel: malformedProviderModel,
          }),
        ),
      ).toMatchObject({ code: "INVALID_INPUT" });
      expect(storage.getExecutionRunById(executionRunId)).toMatchObject({
        status: "CREATED",
        providerRun: null,
        providerModel: null,
      });
      storage.close();

      const reopened = openTaskDatabase({ databasePath, clock: fixedClock });
      try {
        expect(reopened.listSubtasksByBigTask(bigTask.id)).toEqual([subtask]);
        expect(reopened.getChatThreadById(chatThreadId)!.providerThread).toEqual(
          validProviderThread,
        );
        expect(reopened.getExecutionRunById(executionRunId)).toMatchObject({
          status: "CREATED",
          providerRun: null,
          providerModel: null,
        });
      } finally {
        reopened.close();
      }
    });
  });
});
