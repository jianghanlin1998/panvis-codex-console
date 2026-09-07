import { AsyncLocalStorage } from "node:async_hooks";
import { spawnSync } from "node:child_process";
import { TaskStorageError } from "./errors.js";

// Package-private scope keeps legacy repository operations unchanged while every
// nested source/worktree Git command shares the approved execution boundary.
const boundary = new AsyncLocalStorage<() => number>();
export const withExecutionGitBoundary = <T>(remaining: () => number, action: () => T): T =>
  boundary.run(remaining, action);

export function executionGitTimeout(defaultTimeout: number): number {
  const remaining = boundary.getStore()?.() ?? defaultTimeout;
  if (!Number.isFinite(remaining) || remaining <= 0) {
    throw new TaskStorageError("CONFLICT", "The approved execution time is unavailable.");
  }
  return Math.max(1, Math.min(defaultTimeout, Math.floor(remaining)));
}

export function checkExecutionGitFilters(prefix: readonly string[], env: NodeJS.ProcessEnv): void {
  if (boundary.getStore() === undefined) return;
  const result = spawnSync("git", [...prefix, "config", "--name-only", "--get-regexp", "^filter\\."], {
    env, encoding: "utf8", shell: false, windowsHide: true,
    timeout: executionGitTimeout(10_000), maxBuffer: 16_384,
  });
  executionGitTimeout(10_000);
  if (result.error !== undefined || result.signal !== null || result.status !== 1 || result.stdout !== "") {
    throw new TaskStorageError("CONFLICT", "The repository Git configuration is unsupported.");
  }
}
