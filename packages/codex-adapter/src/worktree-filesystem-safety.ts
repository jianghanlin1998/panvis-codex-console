import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  realpathSync,
  type BigIntStats,
} from "node:fs";
import { isAbsolute, join } from "node:path";

export class WorktreeFilesystemSafetyError extends Error {
  constructor() {
    super("WORKTREE_FILESYSTEM_UNSAFE");
    this.name = "WorktreeFilesystemSafetyError";
  }
}

export function validateOwnedWorktreeHardlinkSafety(
  worktreePath: string,
): void {
  try {
    if (!isAbsolute(worktreePath) || realpathSync.native(worktreePath) !== worktreePath) {
      throw new Error("unsafe root");
    }
    const pendingDirectories = [worktreePath];
    while (pendingDirectories.length > 0) {
      const directory = pendingDirectories.pop();
      if (directory === undefined) {
        throw new Error("missing traversal state");
      }
      const before = lstatSync(directory, { bigint: true });
      if (!before.isDirectory() || before.isSymbolicLink()) {
        throw new Error("unsafe directory");
      }
      const descriptor = openSync(
        directory,
        constants.O_RDONLY |
          constants.O_DIRECTORY |
          constants.O_NOFOLLOW |
          constants.O_NONBLOCK,
      );
      try {
        const opened = fstatSync(descriptor, { bigint: true });
        if (!sameNode(before, opened) || !opened.isDirectory()) {
          throw new Error("unstable directory");
        }
        const entries = readdirSync(directory, { withFileTypes: true }).sort(
          (left, right) => left.name.localeCompare(right.name, "en"),
        );
        for (const entry of entries) {
          const entryPath = join(directory, entry.name);
          const observed = lstatSync(entryPath, { bigint: true });
          if (observed.isSymbolicLink()) {
            continue;
          }
          if (observed.isDirectory()) {
            pendingDirectories.push(entryPath);
            continue;
          }
          if (observed.isFile()) {
            validateRegularFile(entryPath, observed);
          }
        }
        const afterDescriptor = fstatSync(descriptor, { bigint: true });
        const afterPath = lstatSync(directory, { bigint: true });
        if (
          !stableObservation(before, afterDescriptor) ||
          !stableObservation(afterDescriptor, afterPath)
        ) {
          throw new Error("unstable directory");
        }
      } finally {
        closeSync(descriptor);
      }
    }
  } catch (error: unknown) {
    if (error instanceof WorktreeFilesystemSafetyError) {
      throw error;
    }
    throw new WorktreeFilesystemSafetyError();
  }
}

function validateRegularFile(path: string, before: BigIntStats): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const opened = fstatSync(descriptor, { bigint: true });
    const after = lstatSync(path, { bigint: true });
    if (
      !opened.isFile() ||
      !after.isFile() ||
      before.nlink !== 1n ||
      opened.nlink !== 1n ||
      after.nlink !== 1n ||
      !stableObservation(before, opened) ||
      !stableObservation(opened, after)
    ) {
      throw new Error("unsafe regular file");
    }
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
}

function sameNode(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode
  );
}

function stableObservation(left: BigIntStats, right: BigIntStats): boolean {
  return (
    sameNode(left, right) &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}
