import { request } from "node:http";

import { SubtaskIdSchema } from "@codex-task-console/domain";
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
    const fail = (error: LocalOperatorError): void => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    };
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
    const clientRequest = request(
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
        const contentType = response.headers["content-type"];
        if (
          typeof contentType !== "string" ||
          !/^application\/json(?:;\s*charset=utf-8)?$/iu.test(contentType)
        ) {
          response.resume();
          fail(new LocalOperatorError("RESPONSE_MALFORMED"));
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += buffer.byteLength;
          if (bytes > LOCAL_CONTROL_RESPONSE_LIMIT_BYTES) {
            clientRequest.destroy();
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
          const execution = parsed.execution;
          const executionFailed =
            isRecord(execution) && execution.success === false;
          settled = true;
          resolve(
            Object.freeze({
              httpStatus: status,
              body: parsed,
              succeeded: status >= 200 && status < 300 && !executionFailed,
            }),
          );
        });
      },
    );
    clientRequest.setTimeout(timeoutMilliseconds, () => {
      clientRequest.destroy();
      fail(new LocalOperatorError("OPERATOR_TIMEOUT"));
    });
    clientRequest.once("error", () => {
      fail(new LocalOperatorError("OPERATOR_UNAVAILABLE"));
    });
    if (outbound.body !== undefined) {
      clientRequest.write(outbound.body);
    }
    clientRequest.end();
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
