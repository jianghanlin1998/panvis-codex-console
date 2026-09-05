import type { BigTaskId, SubtaskId } from "@codex-task-console/domain";

import { TaskStorageError } from "./errors.js";
import { GovernedExecutionStore as ProviderBridge } from "./governed-execution.js";
import type { TaskStorage } from "./task-storage.js";
import type { WorktreeOwnershipManager } from "./worktree-ownership.js";

// Package-private identity map. Neither the bridge nor its accessor is a root
// export. The adapter imports this internal module; consumers receive only the
// frozen decision/operator facade below, never callbacks or minting capabilities.
const bridges = new WeakMap<GovernedExecutionStore, ProviderBridge>();

export function getGovernedProviderBridge(handle: GovernedExecutionStore): ProviderBridge {
  const bridge = bridges.get(handle);
  if (bridge === undefined) {
    throw new TaskStorageError("INVALID_INPUT", "Governed execution authority is unavailable.");
  }
  return bridge;
}

export class GovernedExecutionStore {
  constructor(storage: TaskStorage) {
    if (arguments.length !== 1) {
      throw new TaskStorageError("INVALID_INPUT", "The governed store input is invalid.");
    }
    bridges.set(this, new ProviderBridge(storage));
    Object.freeze(this);
  }

  inspectBigTask(bigTaskId: BigTaskId) {
    return getGovernedProviderBridge(this).inspectBigTask(bigTaskId);
  }

  prepareNextRole(bigTaskId: BigTaskId) {
    return getGovernedProviderBridge(this).prepareNextRole(bigTaskId);
  }

  getRoleAuthorization(authorizationId: string) {
    return getGovernedProviderBridge(this).getRoleAuthorization(authorizationId);
  }

  authorizeManualStart(subtaskId: SubtaskId) {
    return getGovernedProviderBridge(this).authorizeManualStart(subtaskId);
  }

  authorizeOneTimeBudgetExtension(subtaskId: SubtaskId) {
    return getGovernedProviderBridge(this).authorizeOneTimeBudgetExtension(subtaskId);
  }
}
Object.freeze(GovernedExecutionStore.prototype);
Object.freeze(GovernedExecutionStore);

export function createGovernedExecutionStore(storage: TaskStorage): GovernedExecutionStore {
  if (arguments.length !== 1) {
    throw new TaskStorageError("INVALID_INPUT", "The governed store input is invalid.");
  }
  return new GovernedExecutionStore(storage);
}

export function createGovernedExecutionStoreForTest(
  storage: TaskStorage,
  worktrees: WorktreeOwnershipManager,
): GovernedExecutionStore {
  if (process.env.NODE_ENV !== "test") {
    throw new TaskStorageError("INVALID_INPUT", "The test seam is unavailable.");
  }
  const handle = new GovernedExecutionStore(storage);
  bridges.set(handle, new ProviderBridge(storage, worktrees));
  return handle;
}
