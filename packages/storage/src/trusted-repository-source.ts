import { spawnSync } from "node:child_process";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { TextDecoder } from "node:util";

import type {
  ProjectId,
  RepositoryReference,
  SubtaskId,
} from "@codex-task-console/domain";

import { TaskStorageError } from "./errors.js";
import { TaskStorage } from "./task-storage.js";

const PACKET_SOURCE_REFERENCE_MAX_LENGTH = 2_048;
const PACKET_TITLE_MAX_LENGTH = 256;
const PACKET_BODY_MAX_LENGTH = 4_000;
const GIT_OUTPUT_MAX_BYTES = 16 * 1_024 * 1_024;
const GIT_TIMEOUT_MILLISECONDS = 10_000;

type PathRepositoryReference = Extract<
  RepositoryReference,
  { readonly kind: "PATH" }
>;

export type TrustedRepositorySourceErrorCode =
  | "INVALID_SUBTASK_ID"
  | "TASK_HIERARCHY_UNAVAILABLE"
  | "UNSUPPORTED_REPOSITORY_REFERENCE"
  | "REPOSITORY_PATH_UNAVAILABLE"
  | "NOT_GIT_REPOSITORY"
  | "REPOSITORY_ROOT_MISMATCH"
  | "UNSAFE_CANONICAL_RULE_SOURCE"
  | "FILESYSTEM_READ_FAILED"
  | "REPOSITORY_PROBE_FAILED"
  | "MALFORMED_RUNTIME_OBSERVATION";

export class TrustedRepositorySourceError extends Error {
  readonly code: TrustedRepositorySourceErrorCode;

  constructor(code: TrustedRepositorySourceErrorCode, message: string) {
    super(message);
    this.name = "TrustedRepositorySourceError";
    this.code = code;
  }
}

export interface TrustedRepositorySourceTextBlock {
  readonly sourceReference: string;
  readonly title: string;
  readonly body: string;
}

export interface TrustedRepositorySourceSnapshot {
  readonly projectId: ProjectId;
  readonly repository: Readonly<PathRepositoryReference>;
  readonly canonicalProjectRules: readonly TrustedRepositorySourceTextBlock[];
  readonly repositoryRuntimeEvidence: readonly TrustedRepositorySourceTextBlock[];
}

interface GitResult {
  readonly status: number;
  readonly stdout: Buffer;
}

interface WorktreeObservation {
  readonly clean: boolean;
  readonly trackedChanges: number;
  readonly untrackedEntries: number;
  readonly unmergedEntries: number;
}

const sourceError = (
  code: TrustedRepositorySourceErrorCode,
  message: string,
): TrustedRepositorySourceError => new TrustedRepositorySourceError(code, message);

const malformedRuntimeObservation = (): TrustedRepositorySourceError =>
  sourceError(
    "MALFORMED_RUNTIME_OBSERVATION",
    "The repository runtime observation was malformed.",
  );

const probeFailed = (): TrustedRepositorySourceError =>
  sourceError(
    "REPOSITORY_PROBE_FAILED",
    "The local repository probe could not be completed.",
  );

const freezeRecursively = <T>(value: T): T => {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const nestedValue of Object.values(value)) {
    freezeRecursively(nestedValue);
  }
  return Object.freeze(value);
};

const makeTextBlock = (
  sourceReference: string,
  title: string,
  body: string,
): TrustedRepositorySourceTextBlock | null => {
  if (
    sourceReference.trim().length === 0 ||
    sourceReference.length > PACKET_SOURCE_REFERENCE_MAX_LENGTH ||
    title.trim().length === 0 ||
    title.length > PACKET_TITLE_MAX_LENGTH ||
    body.trim().length === 0 ||
    body.length > PACKET_BODY_MAX_LENGTH
  ) {
    return null;
  }
  return Object.freeze({ sourceReference, title, body });
};

const decodeUtf8 = (value: Buffer): string | null => {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(value);
    return value.toString("utf8");
  } catch {
    return null;
  }
};

const decodeSingleLine = (value: Buffer): string | null => {
  const decoded = decodeUtf8(value);
  if (decoded === null) {
    return null;
  }
  const withoutTerminator = decoded.endsWith("\n")
    ? decoded.slice(0, decoded.endsWith("\r\n") ? -2 : -1)
    : decoded;
  if (
    withoutTerminator.length === 0 ||
    withoutTerminator.includes("\n") ||
    withoutTerminator.includes("\r") ||
    withoutTerminator.includes("\0")
  ) {
    return null;
  }
  return withoutTerminator;
};

const runLocalGit = (
  repositoryRoot: string,
  arguments_: readonly string[],
): GitResult => {
  const result = (() => {
    try {
      return spawnSync(
        "git",
        [
          "-c",
          "core.fsmonitor=false",
          "-c",
          "core.untrackedCache=false",
          "-c",
          "core.quotePath=false",
          "-C",
          repositoryRoot,
          ...arguments_,
        ],
        {
          env: {
            ...process.env,
            GIT_OPTIONAL_LOCKS: "0",
            GIT_TERMINAL_PROMPT: "0",
          },
          maxBuffer: GIT_OUTPUT_MAX_BYTES,
          shell: false,
          timeout: GIT_TIMEOUT_MILLISECONDS,
          windowsHide: true,
        },
      );
    } catch {
      throw probeFailed();
    }
  })();
  if (
    result.error !== undefined ||
    result.signal !== null ||
    result.status === null ||
    !Buffer.isBuffer(result.stdout)
  ) {
    throw probeFailed();
  }
  return { status: result.status, stdout: result.stdout };
};

const resolveVerifiedRepositoryRoot = (configuredPath: string): string => {
  let configuredRoot: string;
  try {
    configuredRoot = realpathSync.native(configuredPath);
    if (!statSync(configuredRoot).isDirectory()) {
      throw new Error("not a directory");
    }
  } catch {
    throw sourceError(
      "REPOSITORY_PATH_UNAVAILABLE",
      "The configured repository path is unavailable.",
    );
  }

  const rootResult = runLocalGit(configuredRoot, [
    "rev-parse",
    "--path-format=absolute",
    "--show-toplevel",
  ]);
  if (rootResult.status !== 0) {
    throw sourceError(
      "NOT_GIT_REPOSITORY",
      "The configured repository path is not a local Git repository.",
    );
  }
  const reportedRoot = decodeSingleLine(rootResult.stdout);
  if (reportedRoot === null) {
    throw malformedRuntimeObservation();
  }

  let resolvedReportedRoot: string;
  try {
    resolvedReportedRoot = realpathSync.native(reportedRoot);
  } catch {
    throw sourceError(
      "REPOSITORY_ROOT_MISMATCH",
      "The configured path does not designate the probed Git repository root.",
    );
  }
  if (resolvedReportedRoot !== configuredRoot) {
    throw sourceError(
      "REPOSITORY_ROOT_MISMATCH",
      "The configured path does not designate the probed Git repository root.",
    );
  }
  return configuredRoot;
};

const splitRuleContent = (content: string): readonly string[] => {
  const chunks: string[] = [];
  let offset = 0;
  while (offset < content.length) {
    let end = Math.min(offset + PACKET_BODY_MAX_LENGTH, content.length);
    if (
      end < content.length &&
      end > offset &&
      content.charCodeAt(end - 1) >= 0xd800 &&
      content.charCodeAt(end - 1) <= 0xdbff &&
      content.charCodeAt(end) >= 0xdc00 &&
      content.charCodeAt(end) <= 0xdfff
    ) {
      end -= 1;
    }
    chunks.push(content.slice(offset, end));
    offset = end;
  }
  return chunks;
};

const readCanonicalProjectRules = (
  repositoryRoot: string,
): readonly TrustedRepositorySourceTextBlock[] => {
  const rulesPath = join(repositoryRoot, "AGENTS.md");
  let pathStat;
  try {
    pathStat = lstatSync(rulesPath);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return Object.freeze([]);
    }
    throw sourceError(
      "FILESYSTEM_READ_FAILED",
      "The repository rule source could not be read.",
    );
  }
  if (!pathStat.isFile() || pathStat.isSymbolicLink()) {
    throw sourceError(
      "UNSAFE_CANONICAL_RULE_SOURCE",
      "The repository rule source is not a safe regular file.",
    );
  }

  let fileDescriptor: number | undefined;
  let contentBytes: Buffer;
  try {
    fileDescriptor = openSync(
      rulesPath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const openedStat = fstatSync(fileDescriptor);
    if (
      !openedStat.isFile() ||
      openedStat.dev !== pathStat.dev ||
      openedStat.ino !== pathStat.ino
    ) {
      throw sourceError(
        "UNSAFE_CANONICAL_RULE_SOURCE",
        "The repository rule source is not a safe regular file.",
      );
    }
    contentBytes = readFileSync(fileDescriptor);
  } catch (error) {
    if (error instanceof TrustedRepositorySourceError) {
      throw error;
    }
    throw sourceError(
      "FILESYSTEM_READ_FAILED",
      "The repository rule source could not be read.",
    );
  } finally {
    if (fileDescriptor !== undefined) {
      try {
        closeSync(fileDescriptor);
      } catch {
        // The read result remains authoritative; no public process detail leaks.
      }
    }
  }

  const content = decodeUtf8(contentBytes);
  if (content === null) {
    throw sourceError(
      "UNSAFE_CANONICAL_RULE_SOURCE",
      "The repository rule source is not safely readable as UTF-8 text.",
    );
  }
  if (content.length === 0) {
    return Object.freeze([]);
  }

  const chunks = splitRuleContent(content);
  const blocks = chunks.map((body, index) => {
    const part = index + 1;
    const sourceReference =
      chunks.length === 1
        ? "repo:AGENTS.md"
        : `repo:AGENTS.md#part=${part}/${chunks.length}`;
    const title =
      chunks.length === 1
        ? "Repository root AGENTS.md"
        : `Repository root AGENTS.md (part ${part} of ${chunks.length})`;
    const block = makeTextBlock(sourceReference, title, body);
    if (block === null) {
      throw sourceError(
        "UNSAFE_CANONICAL_RULE_SOURCE",
        "The repository rule source cannot satisfy the packet text-block contract.",
      );
    }
    return block;
  });
  return Object.freeze(blocks);
};

const parseCommitSha = (output: Buffer): string => {
  const commitSha = decodeSingleLine(output);
  if (commitSha === null || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commitSha)) {
    throw malformedRuntimeObservation();
  }
  return commitSha;
};

const readHead = (repositoryRoot: string): string => {
  const result = runLocalGit(repositoryRoot, ["rev-parse", "--verify", "HEAD"]);
  if (result.status !== 0) {
    throw probeFailed();
  }
  return parseCommitSha(result.stdout);
};

const readBranch = (repositoryRoot: string): string | null => {
  const result = runLocalGit(repositoryRoot, [
    "symbolic-ref",
    "--quiet",
    "--short",
    "HEAD",
  ]);
  if (result.status === 1) {
    return null;
  }
  if (result.status !== 0) {
    throw probeFailed();
  }
  const branch = decodeSingleLine(result.stdout);
  if (branch === null || branch.length > PACKET_BODY_MAX_LENGTH) {
    throw malformedRuntimeObservation();
  }
  return branch;
};

const readLocalTrackingRef = (
  repositoryRoot: string,
  defaultBranch: string,
): Readonly<{ ref: string; commitSha: string | null }> => {
  const ref = `refs/remotes/origin/${defaultBranch}`;
  const checkResult = runLocalGit(repositoryRoot, [
    "check-ref-format",
    "--normalize",
    ref,
  ]);
  if (checkResult.status !== 0 || decodeSingleLine(checkResult.stdout) !== ref) {
    throw malformedRuntimeObservation();
  }
  const presence = runLocalGit(repositoryRoot, [
    "show-ref",
    "--verify",
    "--quiet",
    ref,
  ]);
  if (presence.status === 1 && presence.stdout.length === 0) {
    return Object.freeze({ ref, commitSha: null });
  }
  if (presence.status !== 0) {
    throw probeFailed();
  }
  const result = runLocalGit(repositoryRoot, ["rev-parse", "--verify", ref]);
  if (result.status !== 0) {
    throw probeFailed();
  }
  return Object.freeze({ ref, commitSha: parseCommitSha(result.stdout) });
};

const readWorktreeObservation = (
  repositoryRoot: string,
): WorktreeObservation => {
  const result = runLocalGit(repositoryRoot, [
    "status",
    "--porcelain=v2",
    "--untracked-files=all",
    "--ignore-submodules=all",
    "-z",
  ]);
  if (result.status !== 0) {
    throw probeFailed();
  }
  const decoded = decodeUtf8(result.stdout);
  if (decoded === null) {
    throw malformedRuntimeObservation();
  }
  if (decoded.length === 0) {
    return Object.freeze({
      clean: true,
      trackedChanges: 0,
      untrackedEntries: 0,
      unmergedEntries: 0,
    });
  }
  if (!decoded.endsWith("\0")) {
    throw malformedRuntimeObservation();
  }

  const records = decoded.slice(0, -1).split("\0");
  let trackedChanges = 0;
  let untrackedEntries = 0;
  let unmergedEntries = 0;
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record === undefined) {
      throw malformedRuntimeObservation();
    }
    if (record.startsWith("1 ")) {
      trackedChanges += 1;
    } else if (record.startsWith("2 ")) {
      trackedChanges += 1;
      index += 1;
      if (index >= records.length) {
        throw malformedRuntimeObservation();
      }
    } else if (record.startsWith("u ")) {
      unmergedEntries += 1;
    } else if (record.startsWith("? ")) {
      untrackedEntries += 1;
    } else if (!record.startsWith("! ")) {
      throw malformedRuntimeObservation();
    }
  }
  return Object.freeze({
    clean: trackedChanges + untrackedEntries + unmergedEntries === 0,
    trackedChanges,
    untrackedEntries,
    unmergedEntries,
  });
};

const readGitVersion = (repositoryRoot: string): string => {
  const result = runLocalGit(repositoryRoot, ["--version"]);
  if (result.status !== 0) {
    throw probeFailed();
  }
  const version = decodeSingleLine(result.stdout);
  if (
    version === null ||
    !version.startsWith("git version ") ||
    version.length > 512
  ) {
    throw malformedRuntimeObservation();
  }
  return version;
};

const runtimeAtom = (value: unknown): string => {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512 ||
    /[\0\r\n]/.test(value)
  ) {
    throw malformedRuntimeObservation();
  }
  return value;
};

const evidenceBlock = (
  sourceReference: string,
  title: string,
  body: string,
): TrustedRepositorySourceTextBlock => {
  const block = makeTextBlock(sourceReference, title, body);
  if (block === null) {
    throw malformedRuntimeObservation();
  }
  return block;
};

const readRepositoryRuntimeEvidence = (
  repositoryRoot: string,
  defaultBranch: string,
): readonly TrustedRepositorySourceTextBlock[] => {
  const head = readHead(repositoryRoot);
  const branch = readBranch(repositoryRoot);
  const tracking = readLocalTrackingRef(repositoryRoot, defaultBranch);
  const worktree = readWorktreeObservation(repositoryRoot);
  const gitVersion = readGitVersion(repositoryRoot);
  const blocks = [
    evidenceBlock(
      "repo:git#head",
      "Local repository HEAD",
      `Local repository HEAD commit observation: ${head}.`,
    ),
    evidenceBlock(
      "repo:git#branch",
      "Local repository branch state",
      branch === null
        ? "Local repository branch state: DETACHED."
        : `Local repository branch state: ATTACHED ${JSON.stringify(branch)}.`,
    ),
    evidenceBlock(
      "repo:git#local-origin-default-branch",
      "Local origin/default-branch tracking ref",
      tracking.commitSha === null
        ? `Local remote-tracking ref ${JSON.stringify(tracking.ref)}: NOT_PRESENT. This is local state only and is not live origin or GitHub truth.`
        : `Local remote-tracking ref ${JSON.stringify(tracking.ref)}: ${tracking.commitSha}. This is local state only and is not live origin or GitHub truth.`,
    ),
    evidenceBlock(
      "repo:git#worktree",
      "Local repository worktree state",
      `Local worktree state: ${worktree.clean ? "CLEAN" : "DIRTY"}; tracked changes ${worktree.trackedChanges}; untracked entries ${worktree.untrackedEntries}; unmerged/conflict entries ${worktree.unmergedEntries}.`,
    ),
    evidenceBlock(
      "probe:runtime#toolchain",
      "Producer/probe runtime observation",
      `Producer/probe runtime: Node ${JSON.stringify(runtimeAtom(process.version))}; OS/platform ${JSON.stringify(runtimeAtom(process.platform))}; architecture ${JSON.stringify(runtimeAtom(process.arch))}; Git ${JSON.stringify(gitVersion)}. These are producer observations, not target repository requirements.`,
    ),
  ];
  return Object.freeze(blocks);
};

/**
 * Direct producer boundary for trusted repository-source snapshots. Trust comes
 * only from calling this operation with a real TaskStorage instance; an equal
 * serialized shape is ordinary DATA and has no parser, marker, or capability.
 */
export class TrustedRepositorySourceReader {
  readonly #storage: TaskStorage;

  constructor(storage: TaskStorage) {
    if (!(storage instanceof TaskStorage)) {
      throw sourceError(
        "TASK_HIERARCHY_UNAVAILABLE",
        "The canonical task hierarchy is unavailable.",
      );
    }
    this.#storage = storage;
  }

  readTrustedRepositorySourceSnapshotForSubtask(
    input: SubtaskId,
  ): TrustedRepositorySourceSnapshot {
    let storageSnapshot;
    try {
      storageSnapshot = this.#storage.readJitContextSourceSnapshotForSubtask(
        input,
        "FRESH_INDEPENDENT_QA",
      );
    } catch (error) {
      if (error instanceof TaskStorageError && error.code === "INVALID_INPUT") {
        throw sourceError(
          "INVALID_SUBTASK_ID",
          "The Subtask ID is invalid or noncanonical.",
        );
      }
      throw sourceError(
        "TASK_HIERARCHY_UNAVAILABLE",
        "The canonical task hierarchy is unavailable.",
      );
    }

    const { project } = storageSnapshot;
    if (project.repository.kind !== "PATH") {
      throw sourceError(
        "UNSUPPORTED_REPOSITORY_REFERENCE",
        "REFERENCE repositories are not supported by this local source producer.",
      );
    }

    const repositoryRoot = resolveVerifiedRepositoryRoot(project.repository.path);
    const snapshot: TrustedRepositorySourceSnapshot = {
      projectId: project.id,
      repository: {
        kind: "PATH",
        path: project.repository.path,
      },
      canonicalProjectRules: readCanonicalProjectRules(repositoryRoot),
      repositoryRuntimeEvidence: readRepositoryRuntimeEvidence(
        repositoryRoot,
        project.defaultBranch,
      ),
    };
    return freezeRecursively(snapshot);
  }
}
