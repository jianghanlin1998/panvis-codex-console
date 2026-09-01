import { request } from "node:http";
import type { ClientRequest } from "node:http";

import {
  ChatThreadIdSchema,
  ChatThreadStatusSchema,
  ExecutionProviderIdSchema,
  ExecutionRunIdSchema,
  ExecutionRunStatusSchema,
  NormalizedUsageSchema,
  SubtaskIdSchema,
  WorktreeOwnershipIdSchema,
} from "@codex-task-console/domain";
import type { SubtaskId } from "@codex-task-console/domain";

import {
  LOCAL_CONTROL_HOST,
  LOCAL_CONTROL_RESPONSE_LIMIT_BYTES,
} from "./http-server.js";
import {
  LocalStateError,
  productionLocalControlPaths,
  readSessionDescriptor,
} from "./state.js";
import type {
  LocalControlPaths,
  LocalSessionDescriptor,
} from "./state.js";

const DEFAULT_OPERATOR_TIMEOUT_MILLISECONDS = 5 * 60_000;

export type OperatorCommandName =
  | "ping"
  | "status"
  | "provision"
  | "run"
  | "release";

export type OperatorCommand =
  | { readonly name: "ping" }
  | {
      readonly name: Exclude<OperatorCommandName, "ping">;
      readonly subtaskId: SubtaskId;
    };

export interface OperatorResult {
  readonly httpStatus: number;
  readonly body: Readonly<Record<string, unknown>>;
  readonly succeeded: boolean;
}

export type LocalOperatorErrorCode =
  | "INVALID_COMMAND"
  | "SESSION_UNAVAILABLE"
  | "OPERATOR_UNAVAILABLE"
  | "OPERATOR_TIMEOUT"
  | "RESPONSE_TOO_LARGE"
  | "RESPONSE_MALFORMED";

export class LocalOperatorError extends Error {
  readonly code: LocalOperatorErrorCode;

  constructor(code: LocalOperatorErrorCode) {
    super(code);
    this.name = "LocalOperatorError";
    this.code = code;
  }
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactKeys = (
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): boolean => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};

const schemaMatchesExactly = (
  schema: { safeParse(value: unknown): { success: boolean; data?: unknown } },
  value: unknown,
): boolean => {
  const result = schema.safeParse(value);
  return result.success && result.data === value;
};

const isCanonicalTimestamp = (value: unknown): value is string =>
  typeof value === "string" &&
  !Number.isNaN(Date.parse(value)) &&
  new Date(value).toISOString() === value;

const isNullableBoundedString = (value: unknown): boolean =>
  value === null ||
  (typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 512 &&
    value.trim() === value);

const isRunSummary = (value: unknown): boolean => {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "id",
      "status",
      "providerRunId",
      "providerModelId",
      "normalizedUsage",
      "createdAt",
      "updatedAt",
    ])
  ) {
    return false;
  }
  return (
    schemaMatchesExactly(ExecutionRunIdSchema, value.id) &&
    ExecutionRunStatusSchema.safeParse(value.status).success &&
    isNullableBoundedString(value.providerRunId) &&
    isNullableBoundedString(value.providerModelId) &&
    (value.normalizedUsage === null ||
      NormalizedUsageSchema.safeParse(value.normalizedUsage).success) &&
    isCanonicalTimestamp(value.createdAt) &&
    isCanonicalTimestamp(value.updatedAt)
  );
};

const isThreadSummary = (value: unknown): boolean => {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "id",
      "status",
      "providerId",
      "createdAt",
      "updatedAt",
      "runs",
    ]) ||
    !Array.isArray(value.runs) ||
    value.runs.length > 8
  ) {
    return false;
  }
  return (
    schemaMatchesExactly(ChatThreadIdSchema, value.id) &&
    ChatThreadStatusSchema.safeParse(value.status).success &&
    schemaMatchesExactly(ExecutionProviderIdSchema, value.providerId) &&
    isCanonicalTimestamp(value.createdAt) &&
    isCanonicalTimestamp(value.updatedAt) &&
    value.runs.every(isRunSummary)
  );
};

const isInspectionResponse = (
  value: Readonly<Record<string, unknown>>,
  subtaskId: SubtaskId,
): boolean => {
  if (
    !hasExactKeys(value, [
      "subtask",
      "dependencyReadiness",
      "worktree",
      "durableExecution",
    ]) ||
    !isRecord(value.subtask) ||
    !hasExactKeys(value.subtask, ["id", "status", "maturity"]) ||
    value.subtask.id !== subtaskId ||
    typeof value.subtask.status !== "string" ||
    typeof value.subtask.maturity !== "string" ||
    !isRecord(value.dependencyReadiness) ||
    !hasExactKeys(value.dependencyReadiness, [
      "valid",
      "ready",
      "blockerCount",
      "errorCodes",
    ]) ||
    typeof value.dependencyReadiness.valid !== "boolean" ||
    typeof value.dependencyReadiness.ready !== "boolean" ||
    !Number.isSafeInteger(value.dependencyReadiness.blockerCount) ||
    (value.dependencyReadiness.blockerCount as number) < 0 ||
    !Array.isArray(value.dependencyReadiness.errorCodes) ||
    !value.dependencyReadiness.errorCodes.every(
      (code) => typeof code === "string" && /^[A-Z][A-Z0-9_]*$/u.test(code),
    )
  ) {
    return false;
  }
  if (value.worktree !== null) {
    if (
      !isRecord(value.worktree) ||
      !hasExactKeys(value.worktree, [
        "id",
        "status",
        "activeAuthorityVerified",
      ]) ||
      !schemaMatchesExactly(WorktreeOwnershipIdSchema, value.worktree.id) ||
      !["PROVISIONING", "ACTIVE", "RELEASING", "RELEASED", "FAILED"].includes(
        value.worktree.status as string,
      ) ||
      typeof value.worktree.activeAuthorityVerified !== "boolean"
    ) {
      return false;
    }
  }
  if (
    !isRecord(value.durableExecution) ||
    !hasExactKeys(value.durableExecution, [
      "chatThreadCount",
      "returnedChatThreadCount",
      "recentChatThreads",
    ]) ||
    !Number.isSafeInteger(value.durableExecution.chatThreadCount) ||
    !Number.isSafeInteger(value.durableExecution.returnedChatThreadCount) ||
    (value.durableExecution.chatThreadCount as number) < 0 ||
    (value.durableExecution.returnedChatThreadCount as number) < 0 ||
    !Array.isArray(value.durableExecution.recentChatThreads) ||
    value.durableExecution.recentChatThreads.length > 8 ||
    value.durableExecution.returnedChatThreadCount !==
      value.durableExecution.recentChatThreads.length ||
    (value.durableExecution.chatThreadCount as number) <
      (value.durableExecution.returnedChatThreadCount as number)
  ) {
    return false;
  }
  return value.durableExecution.recentChatThreads.every(isThreadSummary);
};

const isWorktreeResponse = (
  value: Readonly<Record<string, unknown>>,
  expectedStatus: "ACTIVE" | "RELEASED",
): boolean => {
  if (
    !hasExactKeys(value, ["worktree"]) ||
    !isRecord(value.worktree) ||
    !hasExactKeys(value.worktree, [
      "id",
      "status",
      "startingCommitSha",
      "releaseHeadSha",
    ])
  ) {
    return false;
  }
  return (
    schemaMatchesExactly(WorktreeOwnershipIdSchema, value.worktree.id) &&
    value.worktree.status === expectedStatus &&
    typeof value.worktree.startingCommitSha === "string" &&
    /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(
      value.worktree.startingCommitSha,
    ) &&
    (expectedStatus === "ACTIVE"
      ? value.worktree.releaseHeadSha === null
      : typeof value.worktree.releaseHeadSha === "string" &&
        /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(
          value.worktree.releaseHeadSha,
        ))
  );
};

const isExecutionResponse = (
  value: Readonly<Record<string, unknown>>,
): boolean => {
  if (
    !hasExactKeys(value, ["execution"]) ||
    !isRecord(value.execution) ||
    !hasExactKeys(value.execution, [
      "success",
      "failureCode",
      "chatThreadId",
      "executionRunId",
      "worktreeOwnershipId",
      "providerId",
      "providerThreadId",
      "providerRunId",
      "providerModelId",
      "normalizedUsage",
      "terminalTurnStatus",
      "appServerChildCleaned",
      "transientRuntimeCleaned",
    ]) ||
    typeof value.execution.success !== "boolean" ||
    value.execution.providerId !== "codex-app-server" ||
    !isNullableBoundedString(value.execution.providerThreadId) ||
    !isNullableBoundedString(value.execution.providerRunId) ||
    !isNullableBoundedString(value.execution.providerModelId) ||
    (value.execution.normalizedUsage !== null &&
      !NormalizedUsageSchema.safeParse(value.execution.normalizedUsage).success) ||
    ![null, "completed", "failed", "interrupted"].includes(
      value.execution.terminalTurnStatus as string | null,
    ) ||
    typeof value.execution.appServerChildCleaned !== "boolean" ||
    typeof value.execution.transientRuntimeCleaned !== "boolean"
  ) {
    return false;
  }
  const idOrNull = (
    schema: { safeParse(value: unknown): { success: boolean; data?: unknown } },
    candidate: unknown,
  ): boolean => candidate === null || schemaMatchesExactly(schema, candidate);
  if (
    !idOrNull(ChatThreadIdSchema, value.execution.chatThreadId) ||
    !idOrNull(ExecutionRunIdSchema, value.execution.executionRunId) ||
    !idOrNull(
      WorktreeOwnershipIdSchema,
      value.execution.worktreeOwnershipId,
    )
  ) {
    return false;
  }
  return value.execution.success
    ? value.execution.failureCode === null &&
        value.execution.chatThreadId !== null &&
        value.execution.executionRunId !== null &&
        value.execution.worktreeOwnershipId !== null
    : typeof value.execution.failureCode === "string" &&
        /^[A-Z][A-Z0-9_]*$/u.test(value.execution.failureCode);
};

const isErrorResponse = (value: Readonly<Record<string, unknown>>): boolean =>
  hasExactKeys(value, ["error"]) &&
  isRecord(value.error) &&
  hasExactKeys(value.error, ["code"]) &&
  typeof value.error.code === "string" &&
  value.error.code.length <= 128 &&
  /^[A-Z][A-Z0-9_]*$/u.test(value.error.code);

const validateResponseShape = (
  command: OperatorCommand,
  status: number,
  value: Readonly<Record<string, unknown>>,
): boolean => {
  if (status < 200 || status >= 300) {
    return isErrorResponse(value);
  }
  if (status !== 200) {
    return false;
  }
  switch (command.name) {
    case "ping":
      return (
        hasExactKeys(value, ["ok", "schemaVersion"]) &&
        value.ok === true &&
        value.schemaVersion === 1
      );
    case "status":
      return isInspectionResponse(value, command.subtaskId);
    case "provision":
      return isWorktreeResponse(value, "ACTIVE");
    case "run":
      return isExecutionResponse(value);
    case "release":
      return isWorktreeResponse(value, "RELEASED");
  }
};

const parseSubtaskId = (value: string): SubtaskId => {
  const parsed = SubtaskIdSchema.safeParse(value);
  if (!parsed.success || parsed.data !== value) {
    throw new LocalOperatorError("INVALID_COMMAND");
  }
  return parsed.data;
};

export const parseOperatorCommand = (
  arguments_: readonly string[],
): OperatorCommand => {
  const [command, subtaskId, ...extra] = arguments_;
  if (extra.length !== 0) {
    throw new LocalOperatorError("INVALID_COMMAND");
  }
  if (command === "ping" && subtaskId === undefined) {
    return Object.freeze({ name: "ping" });
  }
  if (
    (command === "status" ||
      command === "provision" ||
      command === "run" ||
      command === "release") &&
    subtaskId !== undefined
  ) {
    return Object.freeze({ name: command, subtaskId: parseSubtaskId(subtaskId) });
  }
  throw new LocalOperatorError("INVALID_COMMAND");
};

const commandRequest = (
  command: OperatorCommand,
): {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly body: Buffer | undefined;
} => {
  switch (command.name) {
    case "ping":
      return { method: "GET", path: "/v0/ping", body: undefined };
    case "status":
      return {
        method: "GET",
        path: `/v0/subtasks/${encodeURIComponent(command.subtaskId)}`,
        body: undefined,
      };
    case "provision":
      return {
        method: "POST",
        path: "/v0/worktrees/provision",
        body: Buffer.from(JSON.stringify({ subtaskId: command.subtaskId }), "utf-8"),
      };
    case "run":
      return {
        method: "POST",
        path: "/v0/executions/run",
        body: Buffer.from(JSON.stringify({ subtaskId: command.subtaskId }), "utf-8"),
      };
    case "release":
      return {
        method: "POST",
        path: "/v0/worktrees/release",
        body: Buffer.from(JSON.stringify({ subtaskId: command.subtaskId }), "utf-8"),
      };
  }
};

const requestDaemon = async (
  descriptor: LocalSessionDescriptor,
  command: OperatorCommand,
  timeoutMilliseconds: number,
): Promise<OperatorResult> => {
  const outbound = commandRequest(command);
  const authority = `${LOCAL_CONTROL_HOST}:${descriptor.port}`;
  return new Promise((resolve, reject) => {
    let settled = false;
    const timing: {
      clientRequest?: ClientRequest;
      deadline?: NodeJS.Timeout;
    } = {};
    const fail = (error: LocalOperatorError): void => {
      if (!settled) {
        settled = true;
        if (timing.deadline !== undefined) {
          clearTimeout(timing.deadline);
        }
        reject(error);
      }
    };
    timing.deadline = setTimeout(() => {
      timing.clientRequest?.destroy();
      fail(new LocalOperatorError("OPERATOR_TIMEOUT"));
    }, timeoutMilliseconds);
    timing.deadline.unref();
    const headers: Record<string, string> = {
      accept: "application/json",
      authorization: `Bearer ${descriptor.sessionToken}`,
      connection: "close",
      host: authority,
    };
    if (outbound.body !== undefined) {
      headers["content-length"] = String(outbound.body.byteLength);
      headers["content-type"] = "application/json";
      headers["x-ctc-request"] = "1";
    }
    const outboundRequest = request(
      {
        agent: false,
        family: 4,
        headers,
        host: LOCAL_CONTROL_HOST,
        method: outbound.method,
        path: outbound.path,
        port: descriptor.port,
      },
      (response) => {
        const contentTypes = response.headersDistinct["content-type"];
        if (
          contentTypes?.length !== 1 ||
          !/^application\/json(?:;\s*charset=utf-8)?$/iu.test(
            contentTypes[0] ?? "",
          )
        ) {
          response.resume();
          fail(new LocalOperatorError("RESPONSE_MALFORMED"));
          return;
        }
        const contentLength = response.headers["content-length"];
        if (
          contentLength !== undefined &&
          (/^(?:0|[1-9][0-9]*)$/u.test(contentLength) === false ||
            Number(contentLength) > LOCAL_CONTROL_RESPONSE_LIMIT_BYTES)
        ) {
          response.resume();
          fail(
            new LocalOperatorError(
              Number(contentLength) > LOCAL_CONTROL_RESPONSE_LIMIT_BYTES
                ? "RESPONSE_TOO_LARGE"
                : "RESPONSE_MALFORMED",
            ),
          );
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += buffer.byteLength;
          if (bytes > LOCAL_CONTROL_RESPONSE_LIMIT_BYTES) {
            outboundRequest.destroy();
            fail(new LocalOperatorError("RESPONSE_TOO_LARGE"));
            return;
          }
          chunks.push(buffer);
        });
        response.once("end", () => {
          if (settled) {
            return;
          }
          const text = Buffer.concat(chunks, bytes).toString("utf-8");
          if (text.includes(descriptor.sessionToken)) {
            fail(new LocalOperatorError("RESPONSE_MALFORMED"));
            return;
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(text);
          } catch {
            fail(new LocalOperatorError("RESPONSE_MALFORMED"));
            return;
          }
          const status = response.statusCode;
          if (status === undefined || !isRecord(parsed)) {
            fail(new LocalOperatorError("RESPONSE_MALFORMED"));
            return;
          }
          let serialized: string;
          try {
            serialized = JSON.stringify(parsed);
          } catch {
            fail(new LocalOperatorError("RESPONSE_MALFORMED"));
            return;
          }
          if (
            serialized.includes(descriptor.sessionToken) ||
            !validateResponseShape(command, status, parsed)
          ) {
            fail(new LocalOperatorError("RESPONSE_MALFORMED"));
            return;
          }
          const execution = parsed.execution;
          const executionFailed =
            isRecord(execution) && execution.success === false;
          settled = true;
          if (timing.deadline !== undefined) {
            clearTimeout(timing.deadline);
          }
          resolve(
            Object.freeze({
              httpStatus: status,
              body: parsed,
              succeeded: status >= 200 && status < 300 && !executionFailed,
            }),
          );
        });
        response.once("aborted", () => {
          fail(new LocalOperatorError("OPERATOR_UNAVAILABLE"));
        });
        response.once("error", () => {
          fail(new LocalOperatorError("OPERATOR_UNAVAILABLE"));
        });
      },
    );
    timing.clientRequest = outboundRequest;
    outboundRequest.once("error", (error) => {
      fail(
        new LocalOperatorError(
          (error as NodeJS.ErrnoException).code?.startsWith("HPE_") === true
            ? "RESPONSE_MALFORMED"
            : "OPERATOR_UNAVAILABLE",
        ),
      );
    });
    if (outbound.body !== undefined) {
      outboundRequest.write(outbound.body);
    }
    outboundRequest.end();
  });
};

const runWithPaths = async (
  command: OperatorCommand,
  paths: LocalControlPaths,
  timeoutMilliseconds: number,
): Promise<OperatorResult> => {
  let descriptor: LocalSessionDescriptor;
  try {
    descriptor = readSessionDescriptor(paths);
  } catch (error) {
    if (error instanceof LocalStateError) {
      throw new LocalOperatorError("SESSION_UNAVAILABLE");
    }
    throw new LocalOperatorError("SESSION_UNAVAILABLE");
  }
  return requestDaemon(descriptor, command, timeoutMilliseconds);
};

export const runOperatorCommand = async (
  command: OperatorCommand,
): Promise<OperatorResult> =>
  runWithPaths(
    command,
    productionLocalControlPaths(),
    DEFAULT_OPERATOR_TIMEOUT_MILLISECONDS,
  );

/** Package-private deterministic-test seam; not exported from the package root. */
export const runOperatorCommandForTesting = async (
  command: OperatorCommand,
  paths: LocalControlPaths,
  timeoutMilliseconds: number,
): Promise<OperatorResult> =>
  runWithPaths(command, paths, timeoutMilliseconds);
