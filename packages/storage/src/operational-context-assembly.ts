import { isDeepStrictEqual } from "node:util";

import { compileJitContextPacket } from "@codex-task-console/domain";
import type {
  JitContextPacket,
  JitContextPacketCompilationInput,
  SubtaskId,
} from "@codex-task-console/domain";

import { TaskStorageError } from "./errors.js";
import type {
  JitContextStorageSourceSnapshot,
} from "./task-storage.js";
import { TaskStorage } from "./task-storage.js";
import {
  TrustedRepositorySourceReader,
} from "./trusted-repository-source.js";

export type OperationalJitContextProfile =
  | "STANDARD_SUBTASK_EXECUTION"
  | "FRESH_INDEPENDENT_QA";

export type OperationalJitContextAssemblyErrorCode =
  | "INVALID_INPUT"
  | "UNSUPPORTED_PROFILE"
  | "SOURCE_DRIFT"
  | "TRUSTED_STORAGE_SOURCE_FAILED"
  | "TRUSTED_REPOSITORY_SOURCE_FAILED"
  | "PACKET_COMPILATION_FAILED";

export class OperationalJitContextAssemblyError extends Error {
  readonly code: OperationalJitContextAssemblyErrorCode;

  constructor(
    code: OperationalJitContextAssemblyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "OperationalJitContextAssemblyError";
    this.code = code;
  }
}

const assemblyError = (
  code: OperationalJitContextAssemblyErrorCode,
  message: string,
): OperationalJitContextAssemblyError =>
  new OperationalJitContextAssemblyError(code, message);

const invalidInput = (): OperationalJitContextAssemblyError =>
  assemblyError(
    "INVALID_INPUT",
    "The operational JIT context assembly input is invalid.",
  );

const unsupportedProfile = (): OperationalJitContextAssemblyError =>
  assemblyError(
    "UNSUPPORTED_PROFILE",
    "The requested operational JIT context profile is not supported.",
  );

const sourceDrift = (): OperationalJitContextAssemblyError =>
  assemblyError(
    "SOURCE_DRIFT",
    "Trusted context sources changed during bounded assembly.",
  );

const trustedStorageSourceFailed = (): OperationalJitContextAssemblyError =>
  assemblyError(
    "TRUSTED_STORAGE_SOURCE_FAILED",
    "The trusted storage source could not be read.",
  );

const trustedRepositorySourceFailed = (): OperationalJitContextAssemblyError =>
  assemblyError(
    "TRUSTED_REPOSITORY_SOURCE_FAILED",
    "The trusted repository source could not be read.",
  );

const packetCompilationFailed = (): OperationalJitContextAssemblyError =>
  assemblyError(
    "PACKET_COMPILATION_FAILED",
    "The JIT context packet could not be compiled.",
  );

const FRESH_QA_POLICY = Object.freeze({
  sourceReference:
    "system:operational-context-assembly-v0#fresh-independent-qa-policy",
  title: "Operational Context Assembly V0 Fresh Independent QA Policy",
  body:
    "Perform fresh independent no-write QA against the current canonical task contract, acceptance criteria, canonical Project rules, and current repository/runtime evidence. Do not treat prior builder, hardening, repair, Handoff, prior PASS conclusion, or self-assessment as authority. Report bounded findings and do not repair them or modify the target repository.",
});

/**
 * Provider-neutral trusted composition boundary for Operational Context
 * Assembly V0. Its operation accepts no caller-provided source content.
 */
export class OperationalJitContextAssembler {
  readonly #storage: TaskStorage;
  readonly #repositorySourceReader: TrustedRepositorySourceReader;

  constructor(storage: TaskStorage) {
    if (!(storage instanceof TaskStorage)) {
      throw invalidInput();
    }
    this.#storage = storage;
    try {
      this.#repositorySourceReader = new TrustedRepositorySourceReader(storage);
    } catch {
      throw invalidInput();
    }
  }

  assembleOperationalJitContextPacketForSubtask(
    subtaskId: SubtaskId,
    profile: OperationalJitContextProfile,
  ): JitContextPacket {
    if (typeof subtaskId !== "string" || typeof profile !== "string") {
      throw invalidInput();
    }
    if (
      profile !== "STANDARD_SUBTASK_EXECUTION" &&
      profile !== "FRESH_INDEPENDENT_QA"
    ) {
      throw unsupportedProfile();
    }

    const {storageSnapshot: storageSnapshotA, sharedInput} = readOperationalSources(
      this.#storage, this.#repositorySourceReader, subtaskId, profile,
    );
    const compilationInput: JitContextPacketCompilationInput =
      storageSnapshotA.profile === "STANDARD_SUBTASK_EXECUTION"
        ? {
            profile: storageSnapshotA.profile,
            ...sharedInput,
            activeContext: {
              project: [...storageSnapshotA.activeContext.project],
              bigTask: [...storageSnapshotA.activeContext.bigTask],
              subtask: [...storageSnapshotA.activeContext.subtask],
            },
          }
        : {
            profile: storageSnapshotA.profile,
            ...sharedInput,
            lockedInvariants: [],
            qaInstructions: [FRESH_QA_POLICY],
            boundedRetestTargets: [],
          };
    return compileOperationalPacket(compilationInput);
  }
}

// Package-private shared owners for governed focused composition. These are not
// supported package exports and do not confer evidence or provider authority.
export function compileOperationalPacket(input: JitContextPacketCompilationInput): JitContextPacket {
  const result = compileJitContextPacket(input);
  if (!result.compiled) throw packetCompilationFailed();
  return result.packet;
}

export function readOperationalSources(
  storage: TaskStorage,
  repositoryReader: TrustedRepositorySourceReader,
  subtaskId: SubtaskId,
  profile: JitContextPacketCompilationInput["profile"],
) {
  const readSnapshot = (): JitContextStorageSourceSnapshot => {
    try {
      return storage.readJitContextSourceSnapshotForSubtask(subtaskId, profile);
    } catch (error) {
      if (error instanceof TaskStorageError && error.code === "INVALID_INPUT") throw invalidInput();
      throw trustedStorageSourceFailed();
    }
  };
  const storageSnapshotA = readSnapshot();
  let repositorySnapshot;
  try {
    repositorySnapshot = repositoryReader.readTrustedRepositorySourceSnapshotForSubtask(subtaskId);
  } catch { throw trustedRepositorySourceFailed(); }
  const storageSnapshotB = readSnapshot();
  if (!isDeepStrictEqual(storageSnapshotA, storageSnapshotB) ||
      repositorySnapshot.projectId !== storageSnapshotA.project.id ||
      !isDeepStrictEqual(repositorySnapshot.repository, storageSnapshotA.project.repository)) throw sourceDrift();
  return {storageSnapshot: storageSnapshotA, sharedInput: {
    project: storageSnapshotA.project,
    bigTask: storageSnapshotA.bigTask,
    subtask: storageSnapshotA.subtask,
    canonicalProjectRules: [...repositorySnapshot.canonicalProjectRules],
    repositoryRuntimeEvidence: [...repositorySnapshot.repositoryRuntimeEvidence],
  }};
}
