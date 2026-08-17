import { Buffer } from "node:buffer";

import { evaluateCompiledContextByteBudget } from "@codex-task-console/domain";
import type { SubtaskId } from "@codex-task-console/domain";

import {
  OperationalJitContextAssembler,
  OperationalJitContextAssemblyError,
} from "./operational-context-assembly.js";
import type { OperationalJitContextProfile } from "./operational-context-assembly.js";
import { TaskStorage } from "./task-storage.js";

const FORMAT = "CTC_JIT_CONTEXT_JSON_V0" as const;
const SERIALIZATION_MARKER = "CODEX_TASK_CONSOLE_JIT_CONTEXT_V0\n";

export type ExecutionInputPreflightErrorCode =
  | "INVALID_INPUT"
  | "UNSUPPORTED_PROFILE"
  | "ASSEMBLY_FAILED"
  | "SERIALIZATION_FAILED";

export class ExecutionInputPreflightError extends Error {
  readonly code: ExecutionInputPreflightErrorCode;

  constructor(code: ExecutionInputPreflightErrorCode, message: string) {
    super(message);
    this.name = "ExecutionInputPreflightError";
    this.code = code;
  }
}

export type ExecutionInputPreflightResult =
  | Readonly<{
      status: "WITHIN_TARGET" | "ABOVE_TARGET";
      allowed: true;
      format: typeof FORMAT;
      profile: OperationalJitContextProfile;
      utf8Bytes: number;
      normalTargetBytes: 40_000;
      absoluteCapBytes: 64_000;
      text: string;
    }>
  | Readonly<{
      status: "HARD_CAP_EXCEEDED";
      allowed: false;
      format: typeof FORMAT;
      profile: OperationalJitContextProfile;
      utf8Bytes: number;
      normalTargetBytes: 40_000;
      absoluteCapBytes: 64_000;
    }>;

const preflightError = (
  code: ExecutionInputPreflightErrorCode,
  message: string,
): ExecutionInputPreflightError => new ExecutionInputPreflightError(code, message);

const invalidInput = (): ExecutionInputPreflightError =>
  preflightError("INVALID_INPUT", "The execution input preflight input is invalid.");

const unsupportedProfile = (): ExecutionInputPreflightError =>
  preflightError(
    "UNSUPPORTED_PROFILE",
    "The requested execution input preflight profile is not supported.",
  );

const assemblyFailed = (): ExecutionInputPreflightError =>
  preflightError("ASSEMBLY_FAILED", "The execution input could not be assembled.");

const serializationFailed = (): ExecutionInputPreflightError =>
  preflightError(
    "SERIALIZATION_FAILED",
    "The execution input could not be serialized.",
  );

/**
 * Trusted provider-neutral path from TaskStorage to exact Console-owned context
 * text. Future execution must invoke this operation rather than accept a
 * caller-created packet, text, measurement, or result-shaped object.
 */
export class ExecutionInputPreflight {
  readonly #assembler: OperationalJitContextAssembler;

  constructor(storage: TaskStorage) {
    if (!(storage instanceof TaskStorage)) {
      throw invalidInput();
    }
    try {
      this.#assembler = new OperationalJitContextAssembler(storage);
    } catch {
      throw invalidInput();
    }
  }

  prepareExecutionInputForSubtask(
    subtaskId: SubtaskId,
    profile: OperationalJitContextProfile,
  ): ExecutionInputPreflightResult {
    let packet;
    try {
      packet = this.#assembler.assembleOperationalJitContextPacketForSubtask(
        subtaskId,
        profile,
      );
    } catch (error) {
      if (error instanceof OperationalJitContextAssemblyError) {
        if (error.code === "INVALID_INPUT") {
          throw invalidInput();
        }
        if (error.code === "UNSUPPORTED_PROFILE") {
          throw unsupportedProfile();
        }
      }
      throw assemblyFailed();
    }

    let text: string;
    try {
      const payload = JSON.stringify(packet);
      if (typeof payload !== "string") {
        throw new TypeError("The packet did not produce serialized text.");
      }
      text = SERIALIZATION_MARKER + payload;
    } catch {
      throw serializationFailed();
    }

    let decision;
    try {
      decision = evaluateCompiledContextByteBudget(
        Buffer.byteLength(text, "utf8"),
      );
    } catch {
      throw serializationFailed();
    }

    const shared = {
      format: FORMAT,
      profile,
      utf8Bytes: decision.utf8Bytes,
      normalTargetBytes: decision.normalTargetBytes,
      absoluteCapBytes: decision.absoluteCapBytes,
    };
    return decision.allowed
      ? Object.freeze({
          ...shared,
          status: decision.status,
          allowed: true,
          text,
        })
      : Object.freeze({
          ...shared,
          status: decision.status,
          allowed: false,
        });
  }
}
