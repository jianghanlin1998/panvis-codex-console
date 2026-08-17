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
import { devNull } from "node:os";
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

interface RepositoryIdentity {
  readonly device: bigint;
  readonly inode: bigint;
}

interface VerifiedRepositoryRoot {
  readonly path: string;
  readonly identity: RepositoryIdentity;
}

interface RepositoryStateObservation extends WorktreeObservation {
  readonly head: string;
  readonly branch: string | null;
}

interface LocalTrackingRefObservation {
  readonly ref: string;
  readonly commitSha: string | null;
}

interface RepositoryObservation {
  readonly state: RepositoryStateObservation;
  readonly tracking: LocalTrackingRefObservation;
  readonly canonicalRuleContent: Buffer | null;
}

interface FileState {
  readonly device: bigint;
  readonly inode: bigint;
  readonly mode: bigint;
  readonly size: bigint;
  readonly modifiedNanoseconds: bigint;
  readonly changedNanoseconds: bigint;
}

type CanonicalRuleFileObservation =
  | Readonly<{ readonly kind: "MISSING" }>
  | Readonly<{
      readonly kind: "PRESENT";
      readonly state: FileState;
      readonly content: Buffer;
    }>;

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

const repositoryRootMismatch = (): TrustedRepositorySourceError =>
  sourceError(
    "REPOSITORY_ROOT_MISMATCH",
    "The configured path does not designate the probed Git repository root.",
  );

const unsafeCanonicalRuleSource = (): TrustedRepositorySourceError =>
  sourceError(
    "UNSAFE_CANONICAL_RULE_SOURCE",
    "The repository rule source is not a stable safe regular file.",
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

const readRepositoryIdentity = (repositoryRoot: string): RepositoryIdentity => {
  try {
    const observation = statSync(repositoryRoot, { bigint: true });
    if (!observation.isDirectory()) {
      throw repositoryRootMismatch();
    }
    return Object.freeze({
      device: observation.dev,
      inode: observation.ino,
    });
  } catch (error) {
    if (error instanceof TrustedRepositorySourceError) {
      throw error;
    }
    throw repositoryRootMismatch();
  }
};

const repositoryIdentitiesEqual = (
  left: RepositoryIdentity,
  right: RepositoryIdentity,
): boolean => left.device === right.device && left.inode === right.inode;

const assertRepositoryIdentity = (
  repositoryRoot: string,
  expectedIdentity: RepositoryIdentity,
): void => {
  if (
    !repositoryIdentitiesEqual(
      readRepositoryIdentity(repositoryRoot),
      expectedIdentity,
    )
  ) {
    throw repositoryRootMismatch();
  }
};

const localGitEnvironment = (): NodeJS.ProcessEnv => {
  const inheritedRuntimeEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !name.toUpperCase().startsWith("GIT_"),
    ),
  );
  return {
    ...inheritedRuntimeEnvironment,
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
  };
};

const runLocalGit = (
  repository: VerifiedRepositoryRoot,
  arguments_: readonly string[],
): GitResult => {
  assertRepositoryIdentity(repository.path, repository.identity);
  const result = (() => {
    try {
      return spawnSync(
        "git",
        [
          "--no-pager",
          "-c",
          "core.fsmonitor=false",
          "-c",
          "core.untrackedCache=false",
          "-c",
          "core.quotePath=false",
          "-c",
          "submodule.recurse=false",
          "-C",
          repository.path,
          ...arguments_,
        ],
        {
          env: localGitEnvironment(),
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
  assertRepositoryIdentity(repository.path, repository.identity);
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

const resolveVerifiedRepositoryRoot = (
  configuredPath: string,
): VerifiedRepositoryRoot => {
  let configuredRoot: string;
  let identity: RepositoryIdentity;
  try {
    configuredRoot = realpathSync.native(configuredPath);
    identity = readRepositoryIdentity(configuredRoot);
    if (!statSync(configuredRoot).isDirectory()) {
      throw new Error("not a directory");
    }
  } catch {
    throw sourceError(
      "REPOSITORY_PATH_UNAVAILABLE",
      "The configured repository path is unavailable.",
    );
  }

  const repository = Object.freeze({ path: configuredRoot, identity });
  const rootResult = runLocalGit(repository, [
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
    throw repositoryRootMismatch();
  }
  if (resolvedReportedRoot !== configuredRoot) {
    throw repositoryRootMismatch();
  }
  assertRepositoryIdentity(configuredRoot, identity);
  return repository;
};

const avoidsSurrogateSplit = (content: string, end: number): number => {
  if (
    end < content.length &&
    end > 0 &&
    content.charCodeAt(end - 1) >= 0xd800 &&
    content.charCodeAt(end - 1) <= 0xdbff &&
    content.charCodeAt(end) >= 0xdc00 &&
    content.charCodeAt(end) <= 0xdfff
  ) {
    return end - 1;
  }
  return end;
};

const lastNonWhitespaceCodePointStart = (
  content: string,
  start: number,
  end: number,
): number | null => {
  for (let index = end - 1; index >= start; index -= 1) {
    if (content.slice(index, index + 1).trim().length === 0) {
      continue;
    }
    if (
      content.charCodeAt(index) >= 0xdc00 &&
      content.charCodeAt(index) <= 0xdfff &&
      index > start &&
      content.charCodeAt(index - 1) >= 0xd800 &&
      content.charCodeAt(index - 1) <= 0xdbff
    ) {
      return index - 1;
    }
    return index;
  }
  return null;
};

const splitRuleContent = (content: string): readonly string[] | null => {
  const chunks: string[] = [];
  let offset = 0;
  while (offset < content.length) {
    let end = avoidsSurrogateSplit(
      content,
      Math.min(offset + PACKET_BODY_MAX_LENGTH, content.length),
    );
    if (
      end < content.length &&
      content
        .slice(end, Math.min(end + PACKET_BODY_MAX_LENGTH, content.length))
        .trim().length === 0
    ) {
      const retainedNonWhitespace = lastNonWhitespaceCodePointStart(
        content,
        offset,
        end,
      );
      if (
        retainedNonWhitespace === null ||
        retainedNonWhitespace === offset ||
        content.slice(offset, retainedNonWhitespace).trim().length === 0
      ) {
        return null;
      }
      end = retainedNonWhitespace;
    }
    const chunk = content.slice(offset, end);
    if (chunk.trim().length === 0) {
      return null;
    }
    chunks.push(chunk);
    offset = end;
  }
  return chunks;
};

const fileState = (observation: {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mode: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}): FileState =>
  Object.freeze({
    device: observation.dev,
    inode: observation.ino,
    mode: observation.mode,
    size: observation.size,
    modifiedNanoseconds: observation.mtimeNs,
    changedNanoseconds: observation.ctimeNs,
  });

const fileStatesEqual = (left: FileState, right: FileState): boolean =>
  left.device === right.device &&
  left.inode === right.inode &&
  left.mode === right.mode &&
  left.size === right.size &&
  left.modifiedNanoseconds === right.modifiedNanoseconds &&
  left.changedNanoseconds === right.changedNanoseconds;

const readCanonicalRuleFileOnce = (
  repository: VerifiedRepositoryRoot,
): CanonicalRuleFileObservation => {
  assertRepositoryIdentity(repository.path, repository.identity);
  const rulesPath = join(repository.path, "AGENTS.md");
  let pathStat;
  try {
    pathStat = lstatSync(rulesPath, { bigint: true });
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      assertRepositoryIdentity(repository.path, repository.identity);
      return Object.freeze({ kind: "MISSING" });
    }
    throw sourceError(
      "FILESYSTEM_READ_FAILED",
      "The repository rule source could not be read.",
    );
  }
  if (!pathStat.isFile() || pathStat.isSymbolicLink()) {
    throw unsafeCanonicalRuleSource();
  }

  let fileDescriptor: number | undefined;
  let contentBytes: Buffer;
  let openedState: FileState;
  try {
    fileDescriptor = openSync(
      rulesPath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const openedBefore = fstatSync(fileDescriptor, { bigint: true });
    if (
      !openedBefore.isFile() ||
      openedBefore.dev !== pathStat.dev ||
      openedBefore.ino !== pathStat.ino
    ) {
      throw unsafeCanonicalRuleSource();
    }
    openedState = fileState(openedBefore);
    contentBytes = readFileSync(fileDescriptor);
    const openedAfter = fstatSync(fileDescriptor, { bigint: true });
    if (
      !openedAfter.isFile() ||
      !fileStatesEqual(openedState, fileState(openedAfter)) ||
      BigInt(contentBytes.byteLength) !== openedAfter.size
    ) {
      throw unsafeCanonicalRuleSource();
    }
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

  try {
    const pathAfter = lstatSync(rulesPath, { bigint: true });
    if (
      !pathAfter.isFile() ||
      pathAfter.isSymbolicLink() ||
      !fileStatesEqual(openedState, fileState(pathAfter))
    ) {
      throw unsafeCanonicalRuleSource();
    }
  } catch (error) {
    if (error instanceof TrustedRepositorySourceError) {
      throw error;
    }
    throw unsafeCanonicalRuleSource();
  }
  assertRepositoryIdentity(repository.path, repository.identity);
  return Object.freeze({
    kind: "PRESENT",
    state: openedState,
    content: contentBytes,
  });
};

const readStableCanonicalRuleContent = (
  repository: VerifiedRepositoryRoot,
): Buffer | null => {
  const first = readCanonicalRuleFileOnce(repository);
  const second = readCanonicalRuleFileOnce(repository);
  if (first.kind !== second.kind) {
    throw unsafeCanonicalRuleSource();
  }
  if (first.kind === "MISSING" || second.kind === "MISSING") {
    return null;
  }
  if (
    !fileStatesEqual(first.state, second.state) ||
    !first.content.equals(second.content)
  ) {
    throw unsafeCanonicalRuleSource();
  }
  return Buffer.from(first.content);
};

const readCanonicalProjectRules = (
  contentBytes: Buffer | null,
): readonly TrustedRepositorySourceTextBlock[] => {
  if (contentBytes === null) {
    return Object.freeze([]);
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
  if (chunks === null) {
    throw sourceError(
      "UNSAFE_CANONICAL_RULE_SOURCE",
      "The repository rule source cannot satisfy the packet text-block contract.",
    );
  }
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

const parseCommitShaText = (commitSha: string): string => {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commitSha)) {
    throw malformedRuntimeObservation();
  }
  return commitSha;
};

const parseCommitSha = (output: Buffer): string => {
  const commitSha = decodeSingleLine(output);
  if (commitSha === null) {
    throw malformedRuntimeObservation();
  }
  return parseCommitShaText(commitSha);
};

const readLocalTrackingRef = (
  repository: VerifiedRepositoryRoot,
  defaultBranch: string,
): LocalTrackingRefObservation => {
  const ref = `refs/remotes/origin/${defaultBranch}`;
  const checkResult = runLocalGit(repository, [
    "check-ref-format",
    "--normalize",
    ref,
  ]);
  if (checkResult.status !== 0 || decodeSingleLine(checkResult.stdout) !== ref) {
    throw malformedRuntimeObservation();
  }
  const result = runLocalGit(repository, [
    "rev-parse",
    "--verify",
    "--quiet",
    `${ref}^{commit}`,
  ]);
  if (result.status === 1 && result.stdout.length === 0) {
    return Object.freeze({ ref, commitSha: null });
  }
  if (result.status !== 0) {
    throw probeFailed();
  }
  return Object.freeze({ ref, commitSha: parseCommitSha(result.stdout) });
};

const readRepositoryState = (
  repository: VerifiedRepositoryRoot,
): RepositoryStateObservation => {
  const result = runLocalGit(repository, [
    "status",
    "--porcelain=v2",
    "--branch",
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
  if (decoded.length === 0 || !decoded.endsWith("\0")) {
    throw malformedRuntimeObservation();
  }

  const records = decoded.slice(0, -1).split("\0");
  let head: string | undefined;
  let branch: string | null | undefined;
  let trackedChanges = 0;
  let untrackedEntries = 0;
  let unmergedEntries = 0;
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record === undefined) {
      throw malformedRuntimeObservation();
    }
    if (record.startsWith("# branch.oid ")) {
      if (head !== undefined) {
        throw malformedRuntimeObservation();
      }
      head = parseCommitShaText(record.slice("# branch.oid ".length));
    } else if (record.startsWith("# branch.head ")) {
      if (branch !== undefined) {
        throw malformedRuntimeObservation();
      }
      const observedBranch = record.slice("# branch.head ".length);
      if (
        observedBranch.length === 0 ||
        observedBranch.length > PACKET_BODY_MAX_LENGTH ||
        /[\0\r\n]/.test(observedBranch)
      ) {
        throw malformedRuntimeObservation();
      }
      branch = observedBranch === "(detached)" ? null : observedBranch;
    } else if (
      record.startsWith("# branch.upstream ") ||
      record.startsWith("# branch.ab ")
    ) {
      // Local status metadata that is not copied into the evidence model.
    } else if (record.startsWith("1 ")) {
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
  if (head === undefined || branch === undefined) {
    throw malformedRuntimeObservation();
  }
  return Object.freeze({
    head,
    branch,
    clean: trackedChanges + untrackedEntries + unmergedEntries === 0,
    trackedChanges,
    untrackedEntries,
    unmergedEntries,
  });
};

const readGitVersion = (repository: VerifiedRepositoryRoot): string => {
  const result = runLocalGit(repository, ["--version"]);
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

const worktreeObservationsEqual = (
  left: WorktreeObservation,
  right: WorktreeObservation,
): boolean =>
  left.clean === right.clean &&
  left.trackedChanges === right.trackedChanges &&
  left.untrackedEntries === right.untrackedEntries &&
  left.unmergedEntries === right.unmergedEntries;

const repositoryStatesEqual = (
  left: RepositoryStateObservation,
  right: RepositoryStateObservation,
): boolean =>
  left.head === right.head &&
  left.branch === right.branch &&
  worktreeObservationsEqual(left, right);

const trackingObservationsEqual = (
  left: LocalTrackingRefObservation,
  right: LocalTrackingRefObservation,
): boolean => left.ref === right.ref && left.commitSha === right.commitSha;

const readRepositoryObservationOnce = (
  repository: VerifiedRepositoryRoot,
  defaultBranch: string,
): RepositoryObservation =>
  Object.freeze({
    state: readRepositoryState(repository),
    tracking: readLocalTrackingRef(repository, defaultBranch),
    canonicalRuleContent: readStableCanonicalRuleContent(repository),
  });

const readStableRepositoryObservation = (
  repository: VerifiedRepositoryRoot,
  defaultBranch: string,
): RepositoryObservation => {
  const first = readRepositoryObservationOnce(repository, defaultBranch);
  const second = readRepositoryObservationOnce(repository, defaultBranch);
  if (
    !repositoryStatesEqual(first.state, second.state) ||
    !trackingObservationsEqual(first.tracking, second.tracking)
  ) {
    throw probeFailed();
  }
  if (
    (first.canonicalRuleContent === null) !==
      (second.canonicalRuleContent === null) ||
    (first.canonicalRuleContent !== null &&
      second.canonicalRuleContent !== null &&
      !first.canonicalRuleContent.equals(second.canonicalRuleContent))
  ) {
    throw unsafeCanonicalRuleSource();
  }
  assertRepositoryIdentity(repository.path, repository.identity);
  return first;
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
  observation: RepositoryObservation,
  gitVersion: string,
): readonly TrustedRepositorySourceTextBlock[] => {
  const { head, branch, ...worktree } = observation.state;
  const tracking = observation.tracking;
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
    const gitVersion = readGitVersion(repositoryRoot);
    const observation = readStableRepositoryObservation(
      repositoryRoot,
      project.defaultBranch,
    );
    const snapshot: TrustedRepositorySourceSnapshot = {
      projectId: project.id,
      repository: {
        kind: "PATH",
        path: project.repository.path,
      },
      canonicalProjectRules: readCanonicalProjectRules(
        observation.canonicalRuleContent,
      ),
      repositoryRuntimeEvidence: readRepositoryRuntimeEvidence(
        observation,
        gitVersion,
      ),
    };
    return freezeRecursively(snapshot);
  }
}
