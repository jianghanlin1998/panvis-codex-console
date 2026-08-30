import type { DatabaseSync } from "node:sqlite";

export interface TaskStorageWorktreeAccess {
  readonly sqlite: DatabaseSync;
  readonly clock: () => Date;
  readonly isOpen: () => boolean;
}

const worktreeAccessByStorage = new WeakMap<object, TaskStorageWorktreeAccess>();

export const registerTaskStorageWorktreeAccess = (
  storage: object,
  access: TaskStorageWorktreeAccess,
): void => {
  worktreeAccessByStorage.set(storage, access);
};

export const getTaskStorageWorktreeAccess = (
  storage: object,
): TaskStorageWorktreeAccess | null => worktreeAccessByStorage.get(storage) ?? null;
