import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, devNull } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { TextDecoder } from "node:util";

import {
  SubtaskIdSchema,
  WorktreeOwnershipIdSchema,
  WorktreeOwnershipSchema,
} from "@codex-task-console/domain";
import type {
  Project,
  RepositoryCommitSha,
  Subtask,
  SubtaskId,
  WorktreeOwnership,
  WorktreeOwnershipId,
  WorktreeOwnershipStatus,
} from "@codex-task-console/domain";

import { TaskStorageError } from "./errors.js";
import { TaskStorage } from "./task-storage.js";
import {
  getTaskStorageWorktreeAccess,
  type TaskStorageWorktreeAccess,
} from "./task-storage-internals.js";

const GIT_OUTPUT_MAX_BYTES = 4 * 1_024 * 1_024;
const GIT_TIMEOUT_MILLISECONDS = 15_000;
const OWNERSHIP_BRANCH_PREFIX = "ctc/worktree/";
const OWNERSHIP_MARKER_NAME = "ctc-worktree-ownership-v0";

export type WorktreeOwnershipErrorCode =
  | "INVALID_SUBTASK_ID"
  | "TASK_HIERARCHY_UNAVAILABLE"
  | "INELIGIBLE_SUBTASK_STATUS"
  | "UNSUPPORTED_REPOSITORY_REFERENCE"
  | "REPOSITORY_PATH_UNAVAILABLE"
  | "NOT_GIT_REPOSITORY"
  | "REPOSITORY_ROOT_MISMATCH"
  | "UNSAFE_WORKTREE_ROOT"
  | "OWNERSHIP_CONFLICT"
  | "PROJECT_CAPACITY_EXCEEDED"
  | "OWNERSHIP_COLLISION"
  | "OWNERSHIP_NOT_ACTIVE"
  | "OWNERSHIP_DRIFT"
  | "WORKTREE_DIRTY"
  | "GIT_OPERATION_FAILED"
  | "RECOVERY_REQUIRED"
  | "MALFORMED_STORED_OWNERSHIP"
  | "STORAGE_UNAVAILABLE";

export class WorktreeOwnershipError extends Error {
  readonly code: WorktreeOwnershipErrorCode;

  constructor(code: WorktreeOwnershipErrorCode, message: string) {
    super(message);
    this.name = "WorktreeOwnershipError";
    this.code = code;
  }
}

export interface ResolvedActiveOwnedWorktree {
  readonly ownership: WorktreeOwnership;
  readonly currentHeadSha: RepositoryCommitSha;
}

export interface WorktreeOwnershipManager {
  provisionOwnedWorktreeForSubtask(subtaskId: SubtaskId): WorktreeOwnership;
  resolveActiveOwnedWorktreeForSubtask(
    subtaskId: SubtaskId,
  ): ResolvedActiveOwnedWorktree;
  releaseOwnedWorktreeForSubtask(subtaskId: SubtaskId): WorktreeOwnership;
  reconcileWorktreeOwnershipForSubtask(subtaskId: SubtaskId): WorktreeOwnership;
  listWorktreeOwnershipHistoryForSubtask(
    subtaskId: SubtaskId,
  ): readonly WorktreeOwnership[];
}

interface WorktreeOwnershipFailureHooks {
  readonly beforeReservation?: () => void;
  readonly beforeGitAdd?: () => void;
  readonly afterGitAdd?: () => void;
  readonly beforeGitRemove?: () => void;
  readonly afterGitRemove?: () => void;
}

export interface WorktreeOwnershipTestDependencies {
  readonly worktreeRoot: string;
  readonly idGenerator: () => string;
  readonly failureHooks?: WorktreeOwnershipFailureHooks;
}

interface ManagerDependencies {
  readonly worktreeRoot: string;
  readonly idGenerator: () => string;
  readonly failureHooks: WorktreeOwnershipFailureHooks;
}

interface RepositoryIdentity {
  readonly device: bigint;
  readonly inode: bigint;
}

interface VerifiedPath {
  readonly path: string;
  readonly identity: RepositoryIdentity;
}

interface VerifiedRepository {
  readonly root: VerifiedPath;
  readonly commonDirectory: VerifiedPath;
  readonly gitDirectory: VerifiedPath;
  readonly head: RepositoryCommitSha;
  readonly headReference: string | null;
}

interface GitResult {
  readonly status: number;
  readonly stdout: Buffer;
}

interface RegisteredWorktree {
  readonly path: string;
  readonly head: RepositoryCommitSha;
  readonly branch: string | null;
}

interface CanonicalHierarchy {
  readonly project: Project;
  readonly subtask: Subtask;
}

interface OwnershipRow {
  readonly id: string;
  readonly project_id: string;
  readonly subtask_id: string;
  readonly status: string;
  readonly worktree_path: string;
  readonly branch_name: string;
  readonly starting_commit_sha: string;
  readonly release_head_sha: string | null;
  readonly created_at: string;
  readonly activated_at: string | null;
  readonly release_started_at: string | null;
  readonly released_at: string | null;
  readonly updated_at: string;
}

const ownershipError = (
  code: WorktreeOwnershipErrorCode,
  message: string,
): WorktreeOwnershipError => new WorktreeOwnershipError(code, message);

const freezeRecursively = <T>(value: T): T => {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value)) {
    freezeRecursively(nested);
  }
  return Object.freeze(value);
};

const decodeUtf8 = (value: Buffer): string | null => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    return null;
  }
};

const decodeSingleLine = (value: Buffer): string | null => {
  const decoded = decodeUtf8(value);
  if (decoded === null) {
    return null;
  }
  const line = decoded.endsWith("\n")
    ? decoded.slice(0, decoded.endsWith("\r\n") ? -2 : -1)
    : decoded;
  if (line.length === 0 || /[\0\r\n]/.test(line)) {
    return null;
  }
  return line;
};

const parseCommitSha = (value: string | null): RepositoryCommitSha => {
  if (value === null || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)) {
    throw ownershipError(
      "GIT_OPERATION_FAILED",
      "The local Git observation was malformed.",
    );
  }
  return value as RepositoryCommitSha;
};

const isProvisioningEligibleStatus = (status: string): boolean =>
  status === "TODO" || status === "IN_PROGRESS" || status === "QA_DEBUG";

const readIdentity = (path: string): RepositoryIdentity => {
  const observation = statSync(path, { bigint: true });
  if (!observation.isDirectory()) {
    throw new Error("not a directory");
  }
  return Object.freeze({
    device: observation.dev,
    inode: observation.ino,
  });
};

const identitiesEqual = (
  left: RepositoryIdentity,
  right: RepositoryIdentity,
): boolean => left.device === right.device && left.inode === right.inode;

const assertPathIdentity = (path: VerifiedPath): void => {
  try {
    if (!identitiesEqual(readIdentity(path.path), path.identity)) {
      throw new Error("identity drift");
    }
  } catch {
    throw ownershipError(
      "OWNERSHIP_DRIFT",
      "A required filesystem identity changed.",
    );
  }
};

const localGitEnvironment = (): NodeJS.ProcessEnv => {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !name.toUpperCase().startsWith("GIT_"),
    ),
  );
  return {
    ...inherited,
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
  };
};

const runLocalGit = (
  root: VerifiedPath,
  arguments_: readonly string[],
): GitResult => {
  assertPathIdentity(root);
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
          "-c",
          `core.hooksPath=${devNull}`,
          "-C",
          root.path,
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
      throw ownershipError(
        "GIT_OPERATION_FAILED",
        "The local Git operation could not be completed.",
      );
    }
  })();
  assertPathIdentity(root);
  if (
    result.error !== undefined ||
    result.signal !== null ||
    result.status === null ||
    !Buffer.isBuffer(result.stdout)
  ) {
    throw ownershipError(
      "GIT_OPERATION_FAILED",
      "The local Git operation could not be completed.",
    );
  }
  return Object.freeze({ status: result.status, stdout: result.stdout });
};

const resolveVerifiedRepository = (configuredPath: string): VerifiedRepository => {
  let canonicalRoot: string;
  let rootIdentity: RepositoryIdentity;
  try {
    canonicalRoot = realpathSync.native(configuredPath);
    rootIdentity = readIdentity(canonicalRoot);
  } catch {
    throw ownershipError(
      "REPOSITORY_PATH_UNAVAILABLE",
      "The configured repository path is unavailable.",
    );
  }
  const root = Object.freeze({ path: canonicalRoot, identity: rootIdentity });

  const rootResult = runLocalGit(root, [
    "rev-parse",
    "--path-format=absolute",
    "--show-toplevel",
  ]);
  if (rootResult.status !== 0) {
    throw ownershipError(
      "NOT_GIT_REPOSITORY",
      "The configured path is not a local Git repository.",
    );
  }
  const reportedRoot = decodeSingleLine(rootResult.stdout);
  let resolvedReportedRoot: string;
  try {
    resolvedReportedRoot =
      reportedRoot === null ? "" : realpathSync.native(reportedRoot);
  } catch {
    throw ownershipError(
      "REPOSITORY_ROOT_MISMATCH",
      "The configured path is not the exact Git worktree root.",
    );
  }
  if (resolvedReportedRoot !== canonicalRoot) {
    throw ownershipError(
      "REPOSITORY_ROOT_MISMATCH",
      "The configured path is not the exact Git worktree root.",
    );
  }

  const commonResult = runLocalGit(root, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  if (commonResult.status !== 0) {
    throw ownershipError(
      "GIT_OPERATION_FAILED",
      "The local repository identity could not be observed.",
    );
  }
  const reportedCommon = decodeSingleLine(commonResult.stdout);
  let commonPath: string;
  let commonIdentity: RepositoryIdentity;
  try {
    commonPath = reportedCommon === null ? "" : realpathSync.native(reportedCommon);
    commonIdentity = readIdentity(commonPath);
  } catch {
    throw ownershipError(
      "GIT_OPERATION_FAILED",
      "The local repository identity could not be observed.",
    );
  }

  const gitDirectoryResult = runLocalGit(root, [
    "rev-parse",
    "--path-format=absolute",
    "--absolute-git-dir",
  ]);
  if (gitDirectoryResult.status !== 0) {
    throw ownershipError(
      "GIT_OPERATION_FAILED",
      "The local repository identity could not be observed.",
    );
  }
  const reportedGitDirectory = decodeSingleLine(gitDirectoryResult.stdout);
  let gitDirectoryPath: string;
  let gitDirectoryIdentity: RepositoryIdentity;
  try {
    gitDirectoryPath =
      reportedGitDirectory === null
        ? ""
        : realpathSync.native(reportedGitDirectory);
    gitDirectoryIdentity = readIdentity(gitDirectoryPath);
  } catch {
    throw ownershipError(
      "GIT_OPERATION_FAILED",
      "The local repository identity could not be observed.",
    );
  }

  const headResult = runLocalGit(root, ["rev-parse", "--verify", "HEAD^{commit}"]);
  if (headResult.status !== 0) {
    throw ownershipError(
      "GIT_OPERATION_FAILED",
      "The local repository HEAD could not be observed.",
    );
  }
  const head = parseCommitSha(decodeSingleLine(headResult.stdout));
  const headReferenceResult = runLocalGit(root, [
    "symbolic-ref",
    "--quiet",
    "HEAD",
  ]);
  const headReference =
    headReferenceResult.status === 0
      ? decodeSingleLine(headReferenceResult.stdout)
      : headReferenceResult.status === 1 && headReferenceResult.stdout.length === 0
        ? null
        : undefined;
  if (
    headReference === undefined ||
    (headReference !== null && !headReference.startsWith("refs/heads/"))
  ) {
    throw ownershipError(
      "GIT_OPERATION_FAILED",
      "The local repository identity could not be observed.",
    );
  }
  assertPathIdentity(root);
  const commonDirectory = Object.freeze({
    path: commonPath,
    identity: commonIdentity,
  });
  const gitDirectory = Object.freeze({
    path: gitDirectoryPath,
    identity: gitDirectoryIdentity,
  });
  assertPathIdentity(commonDirectory);
  assertPathIdentity(gitDirectory);
  return Object.freeze({
    root,
    commonDirectory,
    gitDirectory,
    head,
    headReference,
  });
};

const parseRegisteredWorktrees = (result: GitResult): readonly RegisteredWorktree[] => {
  if (result.status !== 0) {
    throw ownershipError(
      "GIT_OPERATION_FAILED",
      "The local worktree registry could not be observed.",
    );
  }
  const decoded = decodeUtf8(result.stdout);
  if (decoded === null || !decoded.endsWith("\0\0")) {
    throw ownershipError(
      "GIT_OPERATION_FAILED",
      "The local worktree registry observation was malformed.",
    );
  }

  const worktrees: RegisteredWorktree[] = [];
  let path: string | null = null;
  let head: RepositoryCommitSha | null = null;
  let branch: string | null | undefined;
  for (const field of decoded.split("\0")) {
    if (field.length === 0) {
      if (path !== null || head !== null || branch !== undefined) {
        if (path === null || head === null || branch === undefined) {
          throw ownershipError(
            "GIT_OPERATION_FAILED",
            "The local worktree registry observation was malformed.",
          );
        }
        worktrees.push(Object.freeze({ path, head, branch }));
        path = null;
        head = null;
        branch = undefined;
      }
      continue;
    }
    if (field.startsWith("worktree ")) {
      if (path !== null) {
        throw ownershipError(
          "GIT_OPERATION_FAILED",
          "The local worktree registry observation was malformed.",
        );
      }
      path = field.slice("worktree ".length);
    } else if (field.startsWith("HEAD ")) {
      if (head !== null) {
        throw ownershipError(
          "GIT_OPERATION_FAILED",
          "The local worktree registry observation was malformed.",
        );
      }
      head = parseCommitSha(field.slice("HEAD ".length));
    } else if (field.startsWith("branch ")) {
      if (branch !== undefined) {
        throw ownershipError(
          "GIT_OPERATION_FAILED",
          "The local worktree registry observation was malformed.",
        );
      }
      branch = field.slice("branch ".length);
    } else if (field === "detached") {
      if (branch !== undefined) {
        throw ownershipError(
          "GIT_OPERATION_FAILED",
          "The local worktree registry observation was malformed.",
        );
      }
      branch = null;
    } else if (
      field === "bare" ||
      field.startsWith("locked") ||
      field.startsWith("prunable")
    ) {
      // These registry attributes do not change the identity fields used here.
    } else {
      throw ownershipError(
        "GIT_OPERATION_FAILED",
        "The local worktree registry observation was malformed.",
      );
    }
  }
  return Object.freeze(worktrees);
};

/** Package-private parser seam; intentionally not exported from the package root. */
export const parseRegisteredWorktreesForTesting = (
  status: number,
  stdout: Buffer,
): readonly RegisteredWorktree[] =>
  parseRegisteredWorktrees(Object.freeze({ status, stdout }));

const listRegisteredWorktrees = (
  repository: VerifiedRepository,
): readonly RegisteredWorktree[] =>
  parseRegisteredWorktrees(
    runLocalGit(repository.root, ["worktree", "list", "--porcelain", "-z"]),
  );

const exactRegisteredWorktrees = (
  repository: VerifiedRepository,
  path: string,
): readonly RegisteredWorktree[] =>
  listRegisteredWorktrees(repository).filter(
    (worktree) => resolve(worktree.path) === path,
  );

const pathExists = (path: string): boolean => {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return false;
    }
    throw ownershipError(
      "OWNERSHIP_DRIFT",
      "The owned worktree path could not be inspected.",
    );
  }
};

const inspectPrivateOwnershipRoot = (
  configuredRoot: string,
  create: boolean,
): VerifiedPath => {
  const expectedRoot = resolve(configuredRoot);
  try {
    if (create) {
      mkdirSync(expectedRoot, { recursive: true, mode: 0o700 });
    }
    const linkObservation = lstatSync(expectedRoot);
    const observation = statSync(expectedRoot, { bigint: true });
    const ownerMatches =
      typeof process.getuid !== "function" || observation.uid === BigInt(process.getuid());
    if (
      linkObservation.isSymbolicLink() ||
      !observation.isDirectory() ||
      !ownerMatches ||
      (observation.mode & 0o077n) !== 0n ||
      realpathSync.native(expectedRoot) !== expectedRoot
    ) {
      throw new Error("unsafe root");
    }
    return Object.freeze({ path: expectedRoot, identity: readIdentity(expectedRoot) });
  } catch {
    throw ownershipError(
      "UNSAFE_WORKTREE_ROOT",
      "The Console worktree root is unavailable or unsafe.",
    );
  }
};

const ensurePrivateOwnershipRoot = (configuredRoot: string): VerifiedPath =>
  inspectPrivateOwnershipRoot(configuredRoot, true);

const verifyPrivateOwnershipRoot = (configuredRoot: string): VerifiedPath =>
  inspectPrivateOwnershipRoot(configuredRoot, false);

const deriveOwnedPath = (
  root: VerifiedPath,
  id: WorktreeOwnershipId,
): string => {
  const path = join(root.path, id);
  if (dirname(path) !== root.path || !path.startsWith(`${root.path}${sep}`)) {
    throw ownershipError(
      "UNSAFE_WORKTREE_ROOT",
      "The generated worktree path is unsafe.",
    );
  }
  return path;
};

const parseCanonicalSubtaskId = (input: SubtaskId): SubtaskId => {
  const result = SubtaskIdSchema.safeParse(input);
  if (!result.success || result.data !== input) {
    throw ownershipError(
      "INVALID_SUBTASK_ID",
      "The Subtask ID is invalid or noncanonical.",
    );
  }
  return result.data;
};

const resolveCanonicalHierarchy = (
  storage: TaskStorage,
  input: SubtaskId,
): CanonicalHierarchy => {
  const subtaskId = parseCanonicalSubtaskId(input);
  try {
    const snapshot = storage.readJitContextSourceSnapshotForSubtask(
      subtaskId,
      "FRESH_INDEPENDENT_QA",
    );
    return Object.freeze({ project: snapshot.project, subtask: snapshot.subtask });
  } catch (error) {
    if (error instanceof TaskStorageError && error.code === "INVALID_INPUT") {
      throw ownershipError(
        "INVALID_SUBTASK_ID",
        "The Subtask ID is invalid or noncanonical.",
      );
    }
    throw ownershipError(
      "TASK_HIERARCHY_UNAVAILABLE",
      "The canonical task hierarchy is unavailable.",
    );
  }
};

const getStorageAccess = (storage: TaskStorage): TaskStorageWorktreeAccess => {
  const access = getTaskStorageWorktreeAccess(storage);
  if (access === null || !access.isOpen()) {
    throw ownershipError(
      "STORAGE_UNAVAILABLE",
      "The worktree ownership store is unavailable.",
    );
  }
  return access;
};

const timestamp = (access: TaskStorageWorktreeAccess): string => {
  try {
    const value = access.clock();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new Error("invalid clock");
    }
    return value.toISOString();
  } catch {
    throw ownershipError(
      "STORAGE_UNAVAILABLE",
      "The worktree ownership timestamp is unavailable.",
    );
  }
};

const parseOwnershipRow = (
  row: OwnershipRow,
  configuredRoot: string,
): WorktreeOwnership => {
  const result = WorktreeOwnershipSchema.safeParse({
    id: row.id,
    projectId: row.project_id,
    subtaskId: row.subtask_id,
    status: row.status,
    worktreePath: row.worktree_path,
    branchName: row.branch_name,
    startingCommitSha: row.starting_commit_sha,
    releaseHeadSha: row.release_head_sha,
    createdAt: row.created_at,
    activatedAt: row.activated_at,
    releaseStartedAt: row.release_started_at,
    releasedAt: row.released_at,
    updatedAt: row.updated_at,
  });
  if (!result.success) {
    throw ownershipError(
      "MALFORMED_STORED_OWNERSHIP",
      "Stored worktree ownership data is malformed.",
    );
  }
  if (row.worktree_path !== join(resolve(configuredRoot), result.data.id)) {
    throw ownershipError(
      "MALFORMED_STORED_OWNERSHIP",
      "Stored worktree ownership data is malformed.",
    );
  }
  return freezeRecursively(result.data);
};

const selectOwnershipById = (
  access: TaskStorageWorktreeAccess,
  id: WorktreeOwnershipId,
  configuredRoot: string,
): WorktreeOwnership => {
  const row = access.sqlite
    .prepare("SELECT * FROM worktree_ownerships WHERE id = ?")
    .get(id) as OwnershipRow | undefined;
  if (row === undefined) {
    throw ownershipError(
      "STORAGE_UNAVAILABLE",
      "The worktree ownership record is unavailable.",
    );
  }
  return parseOwnershipRow(row, configuredRoot);
};

const withImmediateTransaction = <T>(
  access: TaskStorageWorktreeAccess,
  operation: () => T,
): T => {
  if (!access.isOpen() || access.sqlite.isTransaction) {
    throw ownershipError(
      "STORAGE_UNAVAILABLE",
      "The worktree ownership store is unavailable.",
    );
  }
  try {
    access.sqlite.exec("BEGIN IMMEDIATE");
    const result = operation();
    access.sqlite.exec("COMMIT");
    return result;
  } catch (error) {
    if (access.sqlite.isTransaction) {
      try {
        access.sqlite.exec("ROLLBACK");
      } catch {
        throw ownershipError(
          "STORAGE_UNAVAILABLE",
          "The worktree ownership transaction could not be rolled back.",
        );
      }
    }
    if (error instanceof WorktreeOwnershipError) {
      throw error;
    }
    throw ownershipError(
      "STORAGE_UNAVAILABLE",
      "The worktree ownership transaction failed.",
    );
  }
};

const reserveOwnership = (
  access: TaskStorageWorktreeAccess,
  hierarchy: CanonicalHierarchy,
  ownership: WorktreeOwnership,
  configuredRoot: string,
): WorktreeOwnership =>
  withImmediateTransaction(access, () => {
    const durableHierarchy = access.sqlite
      .prepare(
        `SELECT s.status AS subtask_status,
                b.project_id AS project_id,
                p.repository_kind AS repository_kind,
                p.repository_value AS repository_value,
                p.max_active_coding_subtasks AS project_limit
           FROM subtasks s
           JOIN big_tasks b ON b.id = s.big_task_id
           JOIN projects p ON p.id = b.project_id
          WHERE s.id = ?`,
      )
      .get(hierarchy.subtask.id) as
      | {
          readonly subtask_status: string;
          readonly project_id: string;
          readonly repository_kind: string;
          readonly repository_value: string;
          readonly project_limit: number;
        }
      | undefined;
    if (
      durableHierarchy === undefined ||
      durableHierarchy.project_id !== hierarchy.project.id ||
      durableHierarchy.subtask_status !== hierarchy.subtask.status ||
      durableHierarchy.repository_kind !== hierarchy.project.repository.kind ||
      hierarchy.project.repository.kind !== "PATH" ||
      durableHierarchy.repository_value !== hierarchy.project.repository.path ||
      durableHierarchy.project_limit !== hierarchy.project.maxActiveCodingSubtasks
    ) {
      throw ownershipError(
        "TASK_HIERARCHY_UNAVAILABLE",
        "The canonical task hierarchy changed during reservation.",
      );
    }
    if (!isProvisioningEligibleStatus(hierarchy.subtask.status)) {
      throw ownershipError(
        "INELIGIBLE_SUBTASK_STATUS",
        "The Subtask status is not eligible for worktree provisioning.",
      );
    }

    const existing = access.sqlite
      .prepare(
        "SELECT count(*) AS count FROM worktree_ownerships WHERE subtask_id = ? AND status IN ('PROVISIONING', 'ACTIVE', 'RELEASING')",
      )
      .get(ownership.subtaskId) as { readonly count: number };
    if (existing.count !== 0) {
      throw ownershipError(
        "OWNERSHIP_CONFLICT",
        "The Subtask already has a non-terminal owned worktree.",
      );
    }

    const slots = access.sqlite
      .prepare(
        "SELECT count(*) AS count FROM worktree_ownerships WHERE project_id = ? AND status IN ('PROVISIONING', 'ACTIVE', 'RELEASING')",
      )
      .get(ownership.projectId) as { readonly count: number };
    if (slots.count >= hierarchy.project.maxActiveCodingSubtasks) {
      throw ownershipError(
        "PROJECT_CAPACITY_EXCEEDED",
        "The Project has no available active-coding worktree slot.",
      );
    }

    const generatedCollision = access.sqlite
      .prepare(
        "SELECT count(*) AS count FROM worktree_ownerships WHERE id = ? OR worktree_path = ? OR branch_name = ?",
      )
      .get(ownership.id, ownership.worktreePath, ownership.branchName) as {
      readonly count: number;
    };
    if (generatedCollision.count !== 0) {
      throw ownershipError(
        "OWNERSHIP_COLLISION",
        "The generated worktree ownership identity collided with durable state.",
      );
    }

    access.sqlite
      .prepare(
        `INSERT INTO worktree_ownerships (
           id, project_id, subtask_id, status, worktree_path, branch_name,
           starting_commit_sha, release_head_sha, created_at, activated_at,
           release_started_at, released_at, updated_at
         ) VALUES (?, ?, ?, 'PROVISIONING', ?, ?, ?, NULL, ?, NULL, NULL, NULL, ?)`,
      )
      .run(
        ownership.id,
        ownership.projectId,
        ownership.subtaskId,
        ownership.worktreePath,
        ownership.branchName,
        ownership.startingCommitSha,
        ownership.createdAt,
        ownership.updatedAt,
      );
    return selectOwnershipById(access, ownership.id, configuredRoot);
  });

const transitionOwnership = (
  access: TaskStorageWorktreeAccess,
  id: WorktreeOwnershipId,
  from: WorktreeOwnershipStatus,
  to: WorktreeOwnershipStatus,
  configuredRoot: string,
  releaseHeadSha: RepositoryCommitSha | null = null,
): WorktreeOwnership =>
  withImmediateTransaction(access, () => {
    const current = selectOwnershipById(access, id, configuredRoot);
    if (current.status !== from) {
      throw ownershipError(
        "OWNERSHIP_CONFLICT",
        "The durable worktree ownership state changed unexpectedly.",
      );
    }
    const now = timestamp(access);
    if (now < current.updatedAt) {
      throw ownershipError(
        "STORAGE_UNAVAILABLE",
        "The worktree ownership clock regressed.",
      );
    }

    let result;
    switch (`${from}->${to}`) {
      case "PROVISIONING->ACTIVE":
        result = access.sqlite
          .prepare(
            "UPDATE worktree_ownerships SET status = 'ACTIVE', activated_at = ?, updated_at = ? WHERE id = ? AND status = 'PROVISIONING'",
          )
          .run(now, now, id);
        break;
      case "PROVISIONING->FAILED":
        result = access.sqlite
          .prepare(
            "UPDATE worktree_ownerships SET status = 'FAILED', updated_at = ? WHERE id = ? AND status = 'PROVISIONING'",
          )
          .run(now, id);
        break;
      case "ACTIVE->RELEASING":
        if (releaseHeadSha === null) {
          throw ownershipError(
            "STORAGE_UNAVAILABLE",
            "Release evidence is required before worktree removal.",
          );
        }
        result = access.sqlite
          .prepare(
            "UPDATE worktree_ownerships SET status = 'RELEASING', release_head_sha = ?, release_started_at = ?, updated_at = ? WHERE id = ? AND status = 'ACTIVE'",
          )
          .run(releaseHeadSha, now, now, id);
        break;
      case "RELEASING->RELEASED":
        result = access.sqlite
          .prepare(
            "UPDATE worktree_ownerships SET status = 'RELEASED', released_at = ?, updated_at = ? WHERE id = ? AND status = 'RELEASING' AND release_head_sha IS NOT NULL",
          )
          .run(now, now, id);
        break;
      default:
        throw ownershipError(
          "OWNERSHIP_CONFLICT",
          "The requested worktree ownership transition is forbidden.",
        );
    }
    if (result.changes !== 1) {
      throw ownershipError(
        "OWNERSHIP_CONFLICT",
        "The durable worktree ownership state changed unexpectedly.",
      );
    }
    return selectOwnershipById(access, id, configuredRoot);
  });

const selectCurrentOwnership = (
  access: TaskStorageWorktreeAccess,
  subtaskId: SubtaskId,
  configuredRoot: string,
): WorktreeOwnership | null => {
  const nonTerminalRows = access.sqlite
    .prepare(
      "SELECT * FROM worktree_ownerships WHERE (subtask_id = ? OR trim(subtask_id) = ?) AND status IN ('PROVISIONING', 'ACTIVE', 'RELEASING') ORDER BY created_at, id",
    )
    .all(subtaskId, subtaskId) as unknown as OwnershipRow[];
  if (nonTerminalRows.length > 1) {
    throw ownershipError(
      "MALFORMED_STORED_OWNERSHIP",
      "Stored worktree ownership cardinality is invalid.",
    );
  }
  if (nonTerminalRows.length === 1) {
    return parseOwnershipRow(nonTerminalRows[0]!, configuredRoot);
  }
  const terminal = access.sqlite
    .prepare(
      "SELECT * FROM worktree_ownerships WHERE subtask_id = ? OR trim(subtask_id) = ? ORDER BY created_at DESC, id DESC LIMIT 1",
    )
    .get(subtaskId, subtaskId) as OwnershipRow | undefined;
  return terminal === undefined
    ? null
    : parseOwnershipRow(terminal, configuredRoot);
};

const assertGeneratedBranchIsAbsent = (
  repository: VerifiedRepository,
  branchName: string,
): void => {
  const result = runLocalGit(repository.root, [
    "show-ref",
    "--verify",
    "--quiet",
    `refs/heads/${branchName}`,
  ]);
  if (result.status === 0) {
    throw ownershipError(
      "OWNERSHIP_COLLISION",
      "The generated worktree branch already exists.",
    );
  }
  if (result.status !== 1 || result.stdout.length !== 0) {
    throw ownershipError(
      "GIT_OPERATION_FAILED",
      "The generated worktree branch could not be checked safely.",
    );
  }
};

const assertGeneratedPathIsAbsent = (
  repository: VerifiedRepository,
  worktreePath: string,
): void => {
  if (
    pathExists(worktreePath) ||
    exactRegisteredWorktrees(repository, worktreePath).length !== 0
  ) {
    throw ownershipError(
      "OWNERSHIP_COLLISION",
      "The generated worktree path already exists or is registered.",
    );
  }
};

const assertStoredPathIsDerived = (
  root: VerifiedPath,
  ownership: WorktreeOwnership,
): void => {
  if (deriveOwnedPath(root, ownership.id) !== ownership.worktreePath) {
    throw ownershipError(
      "OWNERSHIP_DRIFT",
      "The stored worktree path is not Console-derived.",
    );
  }
};

interface CheckoutIdentityEvidence {
  readonly sourceHeadReference: string | null;
}

const encodeHeadReference = (reference: string | null): string =>
  reference === null ? "-" : Buffer.from(reference, "utf8").toString("base64url");

const markerContents = (
  source: VerifiedRepository,
  ownership: WorktreeOwnership,
): string =>
  [
    "ctc-worktree-ownership-v0",
    ownership.id,
    ownership.startingCommitSha,
    source.root.identity.device.toString(),
    source.root.identity.inode.toString(),
    source.commonDirectory.identity.device.toString(),
    source.commonDirectory.identity.inode.toString(),
    encodeHeadReference(source.headReference),
    "",
  ].join("\n");

const assertOwnedGitAdministrativeDirectory = (
  source: VerifiedRepository,
  ownedRepository: VerifiedRepository,
): void => {
  let expectedParent: string;
  try {
    expectedParent = realpathSync.native(
      join(source.commonDirectory.path, "worktrees"),
    );
  } catch {
    throw ownershipError(
      "OWNERSHIP_DRIFT",
      "The owned worktree Git administration is unavailable.",
    );
  }
  if (
    dirname(ownedRepository.gitDirectory.path) !== expectedParent ||
    ownedRepository.gitDirectory.path === source.commonDirectory.path
  ) {
    throw ownershipError(
      "OWNERSHIP_DRIFT",
      "The owned worktree Git administration is not independently owned.",
    );
  }
};

const assertCheckoutIdentityMarker = (
  source: VerifiedRepository,
  ownedRepository: VerifiedRepository,
  ownership: WorktreeOwnership,
): CheckoutIdentityEvidence => {
  assertOwnedGitAdministrativeDirectory(source, ownedRepository);
  assertPathIdentity(ownedRepository.gitDirectory);
  const markerPath = join(ownedRepository.gitDirectory.path, OWNERSHIP_MARKER_NAME);
  let descriptor: number | null = null;
  try {
    descriptor = openSync(markerPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(descriptor, { bigint: true });
    const ownerMatches =
      typeof process.getuid !== "function" || before.uid === BigInt(process.getuid());
    if (
      !before.isFile() ||
      !ownerMatches ||
      (before.mode & 0o077n) !== 0n ||
      before.size < 1n ||
      before.size > 8_192n
    ) {
      throw new Error("unsafe marker");
    }
    const contents = readFileSync(descriptor, "utf8");
    const after = fstatSync(descriptor, { bigint: true });
    const fields = contents.split("\n");
    const referenceToken = fields[7];
    let sourceHeadReference: string | null;
    if (referenceToken === "-") {
      sourceHeadReference = null;
    } else if (
      typeof referenceToken === "string" &&
      /^[A-Za-z0-9_-]+$/.test(referenceToken)
    ) {
      const decodedReference = decodeUtf8(
        Buffer.from(referenceToken, "base64url"),
      );
      sourceHeadReference =
        decodedReference !== null &&
        decodedReference.startsWith("refs/heads/") &&
        decodedReference.length <= 4_096 &&
        !/[\0\r\n]/.test(decodedReference)
          ? decodedReference
          : null;
      if (sourceHeadReference === null) {
        throw new Error("invalid source reference");
      }
    } else {
      throw new Error("invalid source reference");
    }
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      fields.length !== 9 ||
      fields[0] !== "ctc-worktree-ownership-v0" ||
      fields[1] !== ownership.id ||
      fields[2] !== ownership.startingCommitSha ||
      fields[3] !== source.root.identity.device.toString() ||
      fields[4] !== source.root.identity.inode.toString() ||
      fields[5] !== source.commonDirectory.identity.device.toString() ||
      fields[6] !== source.commonDirectory.identity.inode.toString() ||
      fields[8] !== ""
    ) {
      throw new Error("marker drift");
    }
    assertPathIdentity(ownedRepository.gitDirectory);
    return Object.freeze({ sourceHeadReference });
  } catch {
    throw ownershipError(
      "OWNERSHIP_DRIFT",
      "The owned worktree checkout generation does not match durable ownership.",
    );
  } finally {
    if (descriptor !== null) {
      try {
        closeSync(descriptor);
      } catch {
        // The authoritative result is already fail-closed above.
      }
    }
  }
};

const installCheckoutIdentityMarker = (
  source: VerifiedRepository,
  root: VerifiedPath,
  ownership: WorktreeOwnership,
): void => {
  assertPathIdentity(root);
  assertPathIdentity(source.commonDirectory);
  const ownedRepository = resolveVerifiedRepository(ownership.worktreePath);
  if (
    ownedRepository.commonDirectory.path !== source.commonDirectory.path ||
    !identitiesEqual(
      ownedRepository.commonDirectory.identity,
      source.commonDirectory.identity,
    )
  ) {
    throw ownershipError(
      "OWNERSHIP_DRIFT",
      "The owned worktree belongs to a different Git repository.",
    );
  }
  assertOwnedGitAdministrativeDirectory(source, ownedRepository);
  const markerPath = join(ownedRepository.gitDirectory.path, OWNERSHIP_MARKER_NAME);
  try {
    writeFileSync(markerPath, markerContents(source, ownership), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch {
    throw ownershipError(
      "RECOVERY_REQUIRED",
      "The owned worktree checkout identity could not be established safely.",
    );
  }
  assertCheckoutIdentityMarker(source, ownedRepository, ownership);
  assertPathIdentity(root);
  assertPathIdentity(source.commonDirectory);
};

const observeExactOwnedWorktree = (
  source: VerifiedRepository,
  root: VerifiedPath,
  ownership: WorktreeOwnership,
  requireStartingHead: boolean,
  requireCheckoutIdentity = true,
  requireStableSourceCheckout = false,
): RepositoryCommitSha => {
  assertPathIdentity(root);
  assertPathIdentity(source.root);
  assertPathIdentity(source.commonDirectory);
  assertStoredPathIsDerived(root, ownership);

  const registered = exactRegisteredWorktrees(source, ownership.worktreePath);
  if (registered.length !== 1) {
    throw ownershipError(
      "OWNERSHIP_DRIFT",
      "The owned worktree is not registered exactly once.",
    );
  }
  const expectedRef = `refs/heads/${ownership.branchName}`;
  if (registered[0]!.branch !== expectedRef) {
    throw ownershipError(
      "OWNERSHIP_DRIFT",
      "The owned worktree branch does not match durable ownership.",
    );
  }

  let pathObservation: ReturnType<typeof lstatSync>;
  try {
    pathObservation = lstatSync(ownership.worktreePath);
    if (
      pathObservation.isSymbolicLink() ||
      !pathObservation.isDirectory() ||
      realpathSync.native(ownership.worktreePath) !== ownership.worktreePath
    ) {
      throw new Error("unsafe path");
    }
  } catch {
    throw ownershipError(
      "OWNERSHIP_DRIFT",
      "The owned worktree path is missing or unsafe.",
    );
  }
  const ownedRepository = resolveVerifiedRepository(ownership.worktreePath);
  if (
    !identitiesEqual(
      source.commonDirectory.identity,
      ownedRepository.commonDirectory.identity,
    ) ||
    source.commonDirectory.path !== ownedRepository.commonDirectory.path
  ) {
    throw ownershipError(
      "OWNERSHIP_DRIFT",
      "The owned worktree belongs to a different Git repository.",
    );
  }
  if (requireCheckoutIdentity) {
    const checkoutIdentity = assertCheckoutIdentityMarker(
      source,
      ownedRepository,
      ownership,
    );
    if (
      requireStableSourceCheckout &&
      (source.head !== ownership.startingCommitSha ||
        source.headReference !== checkoutIdentity.sourceHeadReference)
    ) {
      throw ownershipError(
        "OWNERSHIP_DRIFT",
        "The source checkout changed before worktree activation.",
      );
    }
  }
  const branchResult = runLocalGit(ownedRepository.root, [
    "symbolic-ref",
    "--quiet",
    "HEAD",
  ]);
  if (
    branchResult.status !== 0 ||
    decodeSingleLine(branchResult.stdout) !== expectedRef
  ) {
    throw ownershipError(
      "OWNERSHIP_DRIFT",
      "The owned worktree branch does not match durable ownership.",
    );
  }
  if (
    registered[0]!.head !== ownedRepository.head ||
    (requireStartingHead && ownedRepository.head !== ownership.startingCommitSha)
  ) {
    throw ownershipError(
      "OWNERSHIP_DRIFT",
      "The owned worktree HEAD does not match the required ownership evidence.",
    );
  }
  assertPathIdentity(root);
  assertPathIdentity(source.root);
  assertPathIdentity(source.commonDirectory);
  assertPathIdentity(ownedRepository.gitDirectory);
  return ownedRepository.head;
};

const worktreeIsClean = (worktreePath: string): boolean => {
  const repository = resolveVerifiedRepository(worktreePath);
  const result = runLocalGit(repository.root, [
    "status",
    "--porcelain=v2",
    "--untracked-files=all",
    "--ignore-submodules=none",
    "-z",
  ]);
  if (result.status !== 0) {
    throw ownershipError(
      "GIT_OPERATION_FAILED",
      "The owned worktree status could not be observed.",
    );
  }
  return result.stdout.length === 0;
};

const readLocalBranchHead = (
  repository: VerifiedRepository,
  branchName: string,
): RepositoryCommitSha => {
  const result = runLocalGit(repository.root, [
    "rev-parse",
    "--verify",
    `refs/heads/${branchName}^{commit}`,
  ]);
  if (result.status !== 0) {
    throw ownershipError(
      "OWNERSHIP_DRIFT",
      "The retained owned-worktree branch is unavailable.",
    );
  }
  return parseCommitSha(decodeSingleLine(result.stdout));
};

const ownedPathState = (
  source: VerifiedRepository,
  path: string,
): Readonly<{ readonly exists: boolean; readonly registeredCount: number }> =>
  Object.freeze({
    exists: pathExists(path),
    registeredCount: exactRegisteredWorktrees(source, path).length,
  });

class LocalWorktreeOwnershipManager implements WorktreeOwnershipManager {
  readonly #storage: TaskStorage;
  readonly #dependencies: ManagerDependencies;

  constructor(storage: TaskStorage, dependencies: ManagerDependencies) {
    if (!(storage instanceof TaskStorage) || getTaskStorageWorktreeAccess(storage) === null) {
      throw ownershipError(
        "STORAGE_UNAVAILABLE",
        "The worktree ownership store is unavailable.",
      );
    }
    this.#storage = storage;
    this.#dependencies = dependencies;
  }

  provisionOwnedWorktreeForSubtask(input: SubtaskId): WorktreeOwnership {
    const hierarchy = resolveCanonicalHierarchy(this.#storage, input);
    if (!isProvisioningEligibleStatus(hierarchy.subtask.status)) {
      throw ownershipError(
        "INELIGIBLE_SUBTASK_STATUS",
        "The Subtask status is not eligible for worktree provisioning.",
      );
    }
    if (hierarchy.project.repository.kind !== "PATH") {
      throw ownershipError(
        "UNSUPPORTED_REPOSITORY_REFERENCE",
        "REFERENCE repositories cannot be provisioned as local worktrees.",
      );
    }

    const access = getStorageAccess(this.#storage);
    const worktreeRoot = ensurePrivateOwnershipRoot(this.#dependencies.worktreeRoot);
    const source = resolveVerifiedRepository(hierarchy.project.repository.path);
    let generatedValue: string;
    try {
      generatedValue = this.#dependencies.idGenerator();
    } catch {
      throw ownershipError(
        "OWNERSHIP_COLLISION",
        "A worktree ownership identity could not be generated.",
      );
    }
    const generatedId = WorktreeOwnershipIdSchema.safeParse(generatedValue);
    if (!generatedId.success) {
      throw ownershipError(
        "OWNERSHIP_COLLISION",
        "The generated worktree ownership identity was invalid.",
      );
    }
    const id = generatedId.data;
    const branchName = `${OWNERSHIP_BRANCH_PREFIX}${id}`;
    const worktreePath = deriveOwnedPath(worktreeRoot, id);
    assertGeneratedBranchIsAbsent(source, branchName);
    assertGeneratedPathIsAbsent(source, worktreePath);

    const createdAt = timestamp(access);
    const reservationResult = WorktreeOwnershipSchema.safeParse({
      id,
      projectId: hierarchy.project.id,
      subtaskId: hierarchy.subtask.id,
      status: "PROVISIONING",
      worktreePath,
      branchName,
      startingCommitSha: source.head,
      releaseHeadSha: null,
      createdAt,
      activatedAt: null,
      releaseStartedAt: null,
      releasedAt: null,
      updatedAt: createdAt,
    });
    if (!reservationResult.success) {
      throw ownershipError(
        "UNSAFE_WORKTREE_ROOT",
        "The generated worktree ownership reservation was unsafe.",
      );
    }
    const reservation = reservationResult.data;
    this.#dependencies.failureHooks.beforeReservation?.();
    const persisted = reserveOwnership(
      access,
      hierarchy,
      reservation,
      this.#dependencies.worktreeRoot,
    );

    try {
      this.#dependencies.failureHooks.beforeGitAdd?.();
      const addResult = runLocalGit(source.root, [
        "worktree",
        "add",
        "--no-track",
        "-b",
        persisted.branchName,
        persisted.worktreePath,
        persisted.startingCommitSha,
      ]);
      if (addResult.status !== 0) {
        throw ownershipError(
          "GIT_OPERATION_FAILED",
          "The owned worktree could not be created.",
        );
      }
      observeExactOwnedWorktree(source, worktreeRoot, persisted, true, false);
      installCheckoutIdentityMarker(source, worktreeRoot, persisted);
      this.#dependencies.failureHooks.afterGitAdd?.();
      observeExactOwnedWorktree(source, worktreeRoot, persisted, true, true, true);
      const stableSource = resolveVerifiedRepository(hierarchy.project.repository.path);
      if (
        stableSource.head !== persisted.startingCommitSha ||
        stableSource.headReference !== source.headReference ||
        stableSource.root.path !== source.root.path ||
        !identitiesEqual(stableSource.root.identity, source.root.identity) ||
        stableSource.commonDirectory.path !== source.commonDirectory.path ||
        !identitiesEqual(
          stableSource.commonDirectory.identity,
          source.commonDirectory.identity,
        )
      ) {
        throw ownershipError(
          "RECOVERY_REQUIRED",
          "The source repository changed during worktree provisioning.",
        );
      }
      return transitionOwnership(
        access,
        persisted.id,
        "PROVISIONING",
        "ACTIVE",
        this.#dependencies.worktreeRoot,
      );
    } catch (error) {
      let state: ReturnType<typeof ownedPathState>;
      try {
        state = ownedPathState(source, persisted.worktreePath);
      } catch {
        throw ownershipError(
          "RECOVERY_REQUIRED",
          "Worktree provisioning requires bounded reconciliation.",
        );
      }
      if (!state.exists && state.registeredCount === 0) {
        try {
          transitionOwnership(
            access,
            persisted.id,
            "PROVISIONING",
            "FAILED",
            this.#dependencies.worktreeRoot,
          );
        } catch {
          throw ownershipError(
            "RECOVERY_REQUIRED",
            "Worktree provisioning requires bounded reconciliation.",
          );
        }
        if (error instanceof WorktreeOwnershipError) {
          throw error;
        }
        throw ownershipError(
          "GIT_OPERATION_FAILED",
          "The owned worktree could not be created.",
        );
      }
      throw ownershipError(
        "RECOVERY_REQUIRED",
        "Worktree provisioning requires bounded reconciliation.",
      );
    }
  }

  resolveActiveOwnedWorktreeForSubtask(
    input: SubtaskId,
  ): ResolvedActiveOwnedWorktree {
    const hierarchy = resolveCanonicalHierarchy(this.#storage, input);
    if (hierarchy.project.repository.kind !== "PATH") {
      throw ownershipError(
        "UNSUPPORTED_REPOSITORY_REFERENCE",
        "REFERENCE repositories cannot own local worktrees.",
      );
    }
    const access = getStorageAccess(this.#storage);
    const current = selectCurrentOwnership(
      access,
      hierarchy.subtask.id,
      this.#dependencies.worktreeRoot,
    );
    if (current === null || current.status !== "ACTIVE") {
      throw ownershipError(
        "OWNERSHIP_NOT_ACTIVE",
        "The Subtask has no ACTIVE owned worktree.",
      );
    }
    if (current.projectId !== hierarchy.project.id) {
      throw ownershipError(
        "OWNERSHIP_DRIFT",
        "The durable worktree hierarchy does not match the canonical task hierarchy.",
      );
    }
    const worktreeRoot = verifyPrivateOwnershipRoot(this.#dependencies.worktreeRoot);
    const source = resolveVerifiedRepository(hierarchy.project.repository.path);
    const currentHeadSha = observeExactOwnedWorktree(
      source,
      worktreeRoot,
      current,
      false,
    );
    return freezeRecursively({ ownership: current, currentHeadSha });
  }

  releaseOwnedWorktreeForSubtask(input: SubtaskId): WorktreeOwnership {
    const hierarchy = resolveCanonicalHierarchy(this.#storage, input);
    if (hierarchy.project.repository.kind !== "PATH") {
      throw ownershipError(
        "UNSUPPORTED_REPOSITORY_REFERENCE",
        "REFERENCE repositories cannot own local worktrees.",
      );
    }
    const access = getStorageAccess(this.#storage);
    const resolved = this.resolveActiveOwnedWorktreeForSubtask(
      hierarchy.subtask.id,
    );
    if (!worktreeIsClean(resolved.ownership.worktreePath)) {
      throw ownershipError(
        "WORKTREE_DIRTY",
        "The owned worktree has changes that prevent safe release.",
      );
    }
    const releaseEvidence = this.resolveActiveOwnedWorktreeForSubtask(
      hierarchy.subtask.id,
    );
    const releasing = transitionOwnership(
      access,
      releaseEvidence.ownership.id,
      "ACTIVE",
      "RELEASING",
      this.#dependencies.worktreeRoot,
      releaseEvidence.currentHeadSha,
    );
    const source = resolveVerifiedRepository(hierarchy.project.repository.path);

    try {
      this.#dependencies.failureHooks.beforeGitRemove?.();
      const preRemovalHead = observeExactOwnedWorktree(
        source,
        verifyPrivateOwnershipRoot(this.#dependencies.worktreeRoot),
        releasing,
        false,
      );
      if (
        preRemovalHead !== releasing.releaseHeadSha ||
        !worktreeIsClean(releasing.worktreePath)
      ) {
        throw ownershipError(
          "OWNERSHIP_DRIFT",
          "The owned worktree changed after release evidence was captured.",
        );
      }
      const removeResult = runLocalGit(source.root, [
        "worktree",
        "remove",
        releasing.worktreePath,
      ]);
      if (removeResult.status !== 0) {
        throw ownershipError(
          "GIT_OPERATION_FAILED",
          "The owned worktree could not be removed safely.",
        );
      }
      this.#dependencies.failureHooks.afterGitRemove?.();
      const state = ownedPathState(source, releasing.worktreePath);
      if (state.exists || state.registeredCount !== 0) {
        throw ownershipError(
          "RECOVERY_REQUIRED",
          "Worktree release requires bounded reconciliation.",
        );
      }
      if (readLocalBranchHead(source, releasing.branchName) !== releasing.releaseHeadSha) {
        throw ownershipError(
          "OWNERSHIP_DRIFT",
          "The retained owned-worktree branch changed during release.",
        );
      }
      return transitionOwnership(
        access,
        releasing.id,
        "RELEASING",
        "RELEASED",
        this.#dependencies.worktreeRoot,
      );
    } catch {
      throw ownershipError(
        "RECOVERY_REQUIRED",
        "Worktree release requires bounded reconciliation.",
      );
    }
  }

  reconcileWorktreeOwnershipForSubtask(input: SubtaskId): WorktreeOwnership {
    const hierarchy = resolveCanonicalHierarchy(this.#storage, input);
    const access = getStorageAccess(this.#storage);
    const current = selectCurrentOwnership(
      access,
      hierarchy.subtask.id,
      this.#dependencies.worktreeRoot,
    );
    if (current === null) {
      throw ownershipError(
        "OWNERSHIP_CONFLICT",
        "The Subtask has no worktree ownership history.",
      );
    }
    if (current.projectId !== hierarchy.project.id) {
      throw ownershipError(
        "OWNERSHIP_DRIFT",
        "The durable worktree hierarchy does not match the canonical task hierarchy.",
      );
    }
    if (current.status === "RELEASED" || current.status === "FAILED") {
      return current;
    }
    if (hierarchy.project.repository.kind !== "PATH") {
      throw ownershipError(
        "UNSUPPORTED_REPOSITORY_REFERENCE",
        "REFERENCE repositories cannot own local worktrees.",
      );
    }

    const worktreeRoot = verifyPrivateOwnershipRoot(this.#dependencies.worktreeRoot);
    const source = resolveVerifiedRepository(hierarchy.project.repository.path);
    const state = ownedPathState(source, current.worktreePath);

    if (current.status === "PROVISIONING") {
      if (!state.exists && state.registeredCount === 0) {
        return transitionOwnership(
          access,
          current.id,
          "PROVISIONING",
          "FAILED",
          this.#dependencies.worktreeRoot,
        );
      }
      if (state.exists && state.registeredCount === 1) {
        try {
          observeExactOwnedWorktree(
            source,
            worktreeRoot,
            current,
            true,
            true,
            true,
          );
        } catch {
          throw ownershipError(
            "RECOVERY_REQUIRED",
            "The pending worktree does not match its durable reservation.",
          );
        }
        return transitionOwnership(
          access,
          current.id,
          "PROVISIONING",
          "ACTIVE",
          this.#dependencies.worktreeRoot,
        );
      }
      throw ownershipError(
        "RECOVERY_REQUIRED",
        "The pending worktree state is ambiguous.",
      );
    }

    if (current.status === "RELEASING") {
      if (!state.exists && state.registeredCount === 0 && current.releaseHeadSha !== null) {
        if (readLocalBranchHead(source, current.branchName) !== current.releaseHeadSha) {
          throw ownershipError(
            "OWNERSHIP_DRIFT",
            "The retained owned-worktree branch does not match release evidence.",
          );
        }
        return transitionOwnership(
          access,
          current.id,
          "RELEASING",
          "RELEASED",
          this.#dependencies.worktreeRoot,
        );
      }
      if (state.exists && state.registeredCount === 1) {
        const head = observeExactOwnedWorktree(source, worktreeRoot, current, false);
        if (head !== current.releaseHeadSha) {
          throw ownershipError(
            "OWNERSHIP_DRIFT",
            "The releasing worktree changed after release evidence was captured.",
          );
        }
      }
      throw ownershipError(
        "RECOVERY_REQUIRED",
        "The pending release has not completed.",
      );
    }

    observeExactOwnedWorktree(source, worktreeRoot, current, false);
    return current;
  }

  listWorktreeOwnershipHistoryForSubtask(
    input: SubtaskId,
  ): readonly WorktreeOwnership[] {
    const hierarchy = resolveCanonicalHierarchy(this.#storage, input);
    const access = getStorageAccess(this.#storage);
    const rows = access.sqlite
      .prepare(
        "SELECT * FROM worktree_ownerships WHERE subtask_id = ? OR trim(subtask_id) = ? ORDER BY created_at, id",
      )
      .all(hierarchy.subtask.id, hierarchy.subtask.id) as unknown as OwnershipRow[];
    const history = rows.map((row) =>
      parseOwnershipRow(row, this.#dependencies.worktreeRoot),
    );
    if (
      history.some(
        (ownership) =>
          ownership.projectId !== hierarchy.project.id ||
          ownership.subtaskId !== hierarchy.subtask.id,
      )
    ) {
      throw ownershipError(
        "MALFORMED_STORED_OWNERSHIP",
        "Stored worktree ownership hierarchy is malformed.",
      );
    }
    return freezeRecursively(history);
  }
}

const productionWorktreeRoot = (): string =>
  join(
    homedir(),
    "Library",
    "Application Support",
    "Codex Task Console",
    "worktrees",
  );

export const createWorktreeOwnershipManager = (
  storage: TaskStorage,
): WorktreeOwnershipManager =>
  new LocalWorktreeOwnershipManager(storage, {
    worktreeRoot: productionWorktreeRoot(),
    idGenerator: () => `wt_${randomBytes(16).toString("hex")}`,
    failureHooks: {},
  });

/** Package-private test seam; intentionally not exported from the package root. */
export const createWorktreeOwnershipManagerForTesting = (
  storage: TaskStorage,
  dependencies: WorktreeOwnershipTestDependencies,
): WorktreeOwnershipManager =>
  new LocalWorktreeOwnershipManager(storage, {
    worktreeRoot: dependencies.worktreeRoot,
    idGenerator: dependencies.idGenerator,
    failureHooks: dependencies.failureHooks ?? {},
  });
