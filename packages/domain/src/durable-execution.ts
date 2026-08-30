import { z } from "zod";

import {
  ExecutionProviderIdSchema,
  NormalizedUsageSchema,
  ProviderModelReferenceSchema,
  ProviderRunReferenceSchema,
  ProviderThreadReferenceSchema,
} from "./execution.js";
import {
  ChatThreadIdSchema,
  ExecutionRunIdSchema,
  SubtaskIdSchema,
} from "./identifiers.js";

export const CHAT_THREAD_STATUSES = ["OPEN", "CLOSED"] as const;
export const EXECUTION_RUN_STATUSES = [
  "CREATED",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "INTERRUPTED",
] as const;
export const TERMINAL_EXECUTION_RUN_STATUSES = [
  "SUCCEEDED",
  "FAILED",
  "INTERRUPTED",
] as const;

export const ChatThreadStatusSchema = z.enum(CHAT_THREAD_STATUSES);
export const ExecutionRunStatusSchema = z.enum(EXECUTION_RUN_STATUSES);
export const TerminalExecutionRunStatusSchema = z.enum(
  TERMINAL_EXECUTION_RUN_STATUSES,
);

const durableTimestampSchema = z.iso.datetime({ offset: true });

const timestampMillis = (value: string): number => new Date(value).getTime();

export const ChatThreadSchema = z
  .object({
    id: ChatThreadIdSchema,
    subtaskId: SubtaskIdSchema,
    providerId: ExecutionProviderIdSchema,
    providerThread: ProviderThreadReferenceSchema.nullable(),
    status: ChatThreadStatusSchema,
    createdAt: durableTimestampSchema,
    updatedAt: durableTimestampSchema,
    closedAt: durableTimestampSchema.nullable(),
  })
  .strict()
  .superRefine((thread, context) => {
    if (timestampMillis(thread.updatedAt) < timestampMillis(thread.createdAt)) {
      context.addIssue({
        code: "custom",
        message: "Thread updatedAt cannot precede createdAt",
        path: ["updatedAt"],
      });
    }
    if (
      thread.providerThread !== null &&
      thread.providerThread.providerId !== thread.providerId
    ) {
      context.addIssue({
        code: "custom",
        message: "Provider thread must use the ChatThread provider",
        path: ["providerThread", "providerId"],
      });
    }
    if (thread.status === "OPEN" && thread.closedAt !== null) {
      context.addIssue({
        code: "custom",
        message: "An open ChatThread cannot have closedAt",
        path: ["closedAt"],
      });
    }
    if (thread.status === "CLOSED") {
      if (thread.closedAt === null) {
        context.addIssue({
          code: "custom",
          message: "A closed ChatThread must have closedAt",
          path: ["closedAt"],
        });
      } else if (thread.closedAt !== thread.updatedAt) {
        context.addIssue({
          code: "custom",
          message: "A closed ChatThread must have matching closedAt and updatedAt",
          path: ["closedAt"],
        });
      }
    }
  });

export const ExecutionRunSchema = z
  .object({
    id: ExecutionRunIdSchema,
    chatThreadId: ChatThreadIdSchema,
    status: ExecutionRunStatusSchema,
    providerRun: ProviderRunReferenceSchema.nullable(),
    providerModel: ProviderModelReferenceSchema.nullable(),
    normalizedUsage: NormalizedUsageSchema.nullable(),
    createdAt: durableTimestampSchema,
    updatedAt: durableTimestampSchema,
    startedAt: durableTimestampSchema.nullable(),
    endedAt: durableTimestampSchema.nullable(),
  })
  .strict()
  .superRefine((run, context) => {
    const createdAt = timestampMillis(run.createdAt);
    const updatedAt = timestampMillis(run.updatedAt);
    if (updatedAt < createdAt) {
      context.addIssue({
        code: "custom",
        message: "Run updatedAt cannot precede createdAt",
        path: ["updatedAt"],
      });
    }
    if (run.startedAt !== null && timestampMillis(run.startedAt) < createdAt) {
      context.addIssue({
        code: "custom",
        message: "Run startedAt cannot precede createdAt",
        path: ["startedAt"],
      });
    }
    if (
      run.endedAt !== null &&
      (timestampMillis(run.endedAt) < createdAt ||
        (run.startedAt !== null &&
          timestampMillis(run.endedAt) < timestampMillis(run.startedAt)))
    ) {
      context.addIssue({
        code: "custom",
        message: "Run endedAt cannot precede its creation or start",
        path: ["endedAt"],
      });
    }
    if (
      run.providerRun !== null &&
      run.providerModel !== null &&
      run.providerRun.providerId !== run.providerModel.providerId
    ) {
      context.addIssue({
        code: "custom",
        message: "Provider run and model references must use the same provider",
        path: ["providerModel", "providerId"],
      });
    }

    if (run.status === "CREATED") {
      if (
        run.providerRun !== null ||
        run.providerModel !== null ||
        run.normalizedUsage !== null ||
        run.startedAt !== null ||
        run.endedAt !== null ||
        run.updatedAt !== run.createdAt
      ) {
        context.addIssue({
          code: "custom",
          message: "A created run cannot contain started or final execution state",
        });
      }
      return;
    }

    if (run.status === "RUNNING") {
      if (
        run.providerRun === null ||
        run.startedAt === null ||
        run.endedAt !== null ||
        run.normalizedUsage !== null ||
        run.updatedAt !== run.startedAt
      ) {
        context.addIssue({
          code: "custom",
          message: "A running run must contain only established start state",
        });
      }
      return;
    }

    if (run.endedAt === null || run.endedAt !== run.updatedAt) {
      context.addIssue({
        code: "custom",
        message: "A terminal run must have matching endedAt and updatedAt",
        path: ["endedAt"],
      });
    }
    if (run.startedAt === null) {
      if (
        run.status !== "FAILED" ||
        run.providerRun !== null ||
        run.providerModel !== null ||
        run.normalizedUsage !== null
      ) {
        context.addIssue({
          code: "custom",
          message: "Only a failed pre-start run may be terminal without start state",
        });
      }
    } else if (run.providerRun === null) {
      context.addIssue({
        code: "custom",
        message: "A terminal started run must retain its provider run reference",
        path: ["providerRun"],
      });
    }
  });

export type ChatThreadStatus = z.infer<typeof ChatThreadStatusSchema>;
export type ExecutionRunStatus = z.infer<typeof ExecutionRunStatusSchema>;
export type TerminalExecutionRunStatus = z.infer<
  typeof TerminalExecutionRunStatusSchema
>;
export type ChatThread = z.infer<typeof ChatThreadSchema>;
export type ExecutionRun = z.infer<typeof ExecutionRunSchema>;
