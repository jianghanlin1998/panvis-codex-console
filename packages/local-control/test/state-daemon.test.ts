import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";

import { openTaskDatabase } from "@codex-task-console/storage";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  generateSessionTokenForTesting,
  startLocalControlDaemonForTesting,
} from "../src/daemon.js";
import type {
  LocalDaemonError,
  LocalDaemonTestDependencies,
} from "../src/daemon.js";
import type { LocalControlService } from "../src/service.js";
import {
  LocalStateError,
  acquireDaemonLock,
  ensureProductionStateDirectories,
  localControlPathsForTesting,
  productionLocalControlPaths,
  readSessionDescriptor,
  removeOwnedAuthorityFile,
} from "../src/state.js";

const disposableRoots: string[] = [];

const disposableRoot = (): string => {
  const root = realpathSync.native(
    mkdtempSync(join(tmpdir(), "ctc-local-state-test-")),
  );
  disposableRoots.push(root);
  return root;
};

afterEach(() => {
  for (const root of disposableRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

const fakeService = (): LocalControlService => ({
  inspectSubtask: vi.fn(async (subtaskId) => ({
    subtask: { id: subtaskId, status: "IN_PROGRESS", maturity: "IMPLEMENTED" },
    dependencyReadiness: {
      valid: true,
      ready: true,
      blockerCount: 0,
      errorCodes: [],
    },
    worktree: null,
    durableExecution: {
      chatThreadCount: 0,
      returnedChatThreadCount: 0,
      recentChatThreads: [],
    },
  })),
  provisionOwnedWorktree: vi.fn(async () => ({
    worktree: {
      id: "wt_11111111111111111111111111111111",
      status: "ACTIVE" as const,
      startingCommitSha: "1".repeat(40),
      releaseHeadSha: null,
    },
  })),
  runOwnedWorktreeExecution: vi.fn(async () => ({
    execution: {
      success: false,
      failureCode: "ACTIVE_WORKTREE_REQUIRED",
      chatThreadId: null,
      executionRunId: null,
      worktreeOwnershipId: null,
      providerId: "codex-app-server",
      providerThreadId: null,
      providerRunId: null,
      providerModelId: null,
      normalizedUsage: null,
      terminalTurnStatus: null,
      appServerChildCleaned: true,
      transientRuntimeCleaned: true,
    },
  })),
  releaseOwnedWorktree: vi.fn(async () => ({
    worktree: {
      id: "wt_11111111111111111111111111111111",
      status: "RELEASED" as const,
      startingCommitSha: "1".repeat(40),
      releaseHeadSha: "1".repeat(40),
    },
  })),
});

const daemonDependencies = (
  root: string,
  instanceSuffix: string,
  readinessLines: string[],
): LocalDaemonTestDependencies => ({
  paths: localControlPathsForTesting(join(root, "Codex Task Console")),
  instanceId: `inst_${instanceSuffix.repeat(32)}`,
  sessionToken: instanceSuffix.repeat(64),
  pid: 42,
  clock: () => new Date("2026-09-01T00:00:00.000Z"),
  openStorage: (databasePath) => openTaskDatabase({ databasePath }),
  createService: () => fakeService(),
  readinessWriter: (line) => readinessLines.push(line),
  shutdownTimeoutMilliseconds: 2_000,
});

describe("canonical local state and daemon authority", () => {
  it("resolves the production database to the one canonical Application Support path", () => {
    const paths = productionLocalControlPaths();
    expect(paths.root).toBe(
      join(
        process.env.HOME ?? "",
        "Library",
        "Application Support",
        "Codex Task Console",
      ),
    );
    expect(paths.databasePath).toBe(join(paths.root, "state", "console.sqlite3"));
  });

  it("creates only private canonical directories and rejects a symlink state root", () => {
    const root = disposableRoot();
    const paths = localControlPathsForTesting(join(root, "owned"));
    ensureProductionStateDirectories(paths);
    expect(lstatSync(paths.root).mode & 0o777).toBe(0o700);
    expect(lstatSync(paths.stateDirectory).mode & 0o777).toBe(0o700);
    expect(lstatSync(paths.operatorDirectory).mode & 0o777).toBe(0o700);

    const target = join(root, "target");
    mkdirSync(target, { mode: 0o700 });
    const linked = join(root, "linked");
    symlinkSync(target, linked);
    expect(() =>
      ensureProductionStateDirectories(localControlPathsForTesting(linked)),
    ).toThrowError(LocalStateError);
  });

  it("rejects an existing state root with non-private permissions", () => {
    const root = disposableRoot();
    const unsafe = join(root, "unsafe");
    mkdirSync(unsafe, { mode: 0o700 });
    chmodSync(unsafe, 0o755);
    expect(() =>
      ensureProductionStateDirectories(localControlPathsForTesting(unsafe)),
    ).toThrowError(LocalStateError);
  });

  it("generates independent 256-bit lowercase hexadecimal session tokens", () => {
    const first = generateSessionTokenForTesting();
    const second = generateSessionTokenForTesting();
    expect(first).toMatch(/^[0-9a-f]{64}$/u);
    expect(second).toMatch(/^[0-9a-f]{64}$/u);
    expect(first).not.toBe(second);
  });

  it("uses the canonical database, blocks a second daemon, and cleans only its own evidence", async () => {
    const root = disposableRoot();
    const readinessLines: string[] = [];
    const firstDependencies = daemonDependencies(root, "a", readinessLines);
    const databasePaths: string[] = [];
    const first = await startLocalControlDaemonForTesting({
      ...firstDependencies,
      openStorage: (databasePath) => {
        databasePaths.push(databasePath);
        return openTaskDatabase({ databasePath });
      },
    });
    const descriptor = readSessionDescriptor(firstDependencies.paths);
    expect(descriptor.sessionToken).toBe("a".repeat(64));
    expect(descriptor.port).toBe(first.port);
    expect(lstatSync(firstDependencies.paths.sessionPath).mode & 0o777).toBe(0o600);
    expect(lstatSync(firstDependencies.paths.lockPath).mode & 0o777).toBe(0o600);
    expect(databasePaths).toEqual([firstDependencies.paths.databasePath]);
    expect(readinessLines).toHaveLength(1);
    expect(readinessLines[0]).not.toContain(descriptor.sessionToken);

    await expect(
      startLocalControlDaemonForTesting(daemonDependencies(root, "b", [])),
    ).rejects.toMatchObject({
      code: "DAEMON_ALREADY_RUNNING",
    } satisfies Partial<LocalDaemonError>);
    expect(readSessionDescriptor(firstDependencies.paths).instanceId).toBe(
      first.instanceId,
    );

    await first.stop();
    expect(existsSync(firstDependencies.paths.sessionPath)).toBe(false);
    expect(existsSync(firstDependencies.paths.lockPath)).toBe(false);
  });

  it("refuses to delete stale or foreign authority content", () => {
    const root = disposableRoot();
    const paths = localControlPathsForTesting(join(root, "owned"));
    ensureProductionStateDirectories(paths);
    const authority = acquireDaemonLock(
      paths,
      "inst_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      42,
      "2026-09-01T00:00:00.000Z",
    );
    writeFileSync(
      authority.path,
      `${JSON.stringify({
        schemaVersion: 1,
        instanceId: "inst_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        pid: 43,
        startedAt: "2026-09-01T00:00:00.000Z",
      })}\n`,
      { encoding: "utf-8" },
    );
    expect(() => removeOwnedAuthorityFile(authority)).toThrowError(
      LocalStateError,
    );
    expect(existsSync(authority.path)).toBe(true);
  });

  it("keeps storage and authority evidence until an in-flight operation finishes", async () => {
    const root = disposableRoot();
    const dependencies = daemonDependencies(root, "d", []);
    let operationStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      operationStarted = resolve;
    });
    let finishOperation: (() => void) | undefined;
    const operationGate = new Promise<void>((resolve) => {
      finishOperation = resolve;
    });
    const service = fakeService();
    vi.mocked(service.inspectSubtask).mockImplementation(async (subtaskId) => {
      operationStarted?.();
      await operationGate;
      return {
        subtask: {
          id: subtaskId,
          status: "IN_PROGRESS",
          maturity: "IMPLEMENTED",
        },
        dependencyReadiness: {
          valid: true,
          ready: true,
          blockerCount: 0,
          errorCodes: [],
        },
        worktree: null,
        durableExecution: {
          chatThreadCount: 0,
          returnedChatThreadCount: 0,
          recentChatThreads: [],
        },
      };
    });
    const daemon = await startLocalControlDaemonForTesting({
      ...dependencies,
      createService: () => service,
    });
    const descriptor = readSessionDescriptor(dependencies.paths);
    const response = new Promise<number>((resolve, reject) => {
      const outbound = request(
        {
          host: "127.0.0.1",
          port: daemon.port,
          path: "/v0/subtasks/st_shutdown_test",
          headers: {
            authorization: `Bearer ${descriptor.sessionToken}`,
            host: `127.0.0.1:${daemon.port}`,
          },
        },
        (incoming) => {
          incoming.resume();
          incoming.once("end", () => resolve(incoming.statusCode ?? 0));
        },
      );
      outbound.once("error", reject);
      outbound.end();
    });
    await started;
    const stopping = daemon.stop();
    expect(existsSync(dependencies.paths.sessionPath)).toBe(true);
    expect(existsSync(dependencies.paths.lockPath)).toBe(true);
    finishOperation?.();
    await expect(response).resolves.toBe(200);
    await stopping;
    expect(existsSync(dependencies.paths.sessionPath)).toBe(false);
    expect(existsSync(dependencies.paths.lockPath)).toBe(false);
  });
});
