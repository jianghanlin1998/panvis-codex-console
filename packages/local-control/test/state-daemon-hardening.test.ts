import { Agent, request } from "node:http";
import { connect } from "node:net";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { openTaskDatabase } from "@codex-task-console/storage";
import type { TaskStorage } from "@codex-task-console/storage";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  LocalDaemonError,
  startLocalControlDaemonForTesting,
} from "../src/daemon.js";
import type { LocalDaemonTestDependencies } from "../src/daemon.js";
import type { LocalControlService } from "../src/service.js";
import {
  LocalStateError,
  acquireDaemonLock,
  ensureProductionStateDirectories,
  localControlPathsForTesting,
  readSessionDescriptor,
  removeOwnedAuthorityFile,
  writeSessionDescriptor,
} from "../src/state.js";
import type { LocalControlPaths } from "../src/state.js";

const roots: string[] = [];

const disposableRoot = (): string => {
  const root = realpathSync.native(
    mkdtempSync(join(tmpdir(), "ctc-local-daemon-hardening-")),
  );
  roots.push(root);
  return root;
};

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
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

const dependencies = (
  root: string,
  overrides: Partial<LocalDaemonTestDependencies> = {},
): LocalDaemonTestDependencies => ({
  paths: localControlPathsForTesting(join(root, "Codex Task Console")),
  instanceId: "inst_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  sessionToken: "a".repeat(64),
  pid: 42,
  clock: () => new Date("2026-09-01T00:00:00.000Z"),
  openStorage: (databasePath) => openTaskDatabase({ databasePath }),
  createService: () => fakeService(),
  readinessWriter: () => undefined,
  shutdownTimeoutMilliseconds: 1_000,
  ...overrides,
});

const initializePaths = (root: string): LocalControlPaths => {
  const paths = localControlPathsForTesting(join(root, "Codex Task Console"));
  ensureProductionStateDirectories(paths);
  return paths;
};

const validSessionText = (token: string = "a".repeat(64)): string =>
  `${JSON.stringify({
    schemaVersion: 1,
    instanceId: "inst_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    pid: 42,
    port: 12_345,
    startedAt: "2026-09-01T00:00:00.000Z",
    sessionToken: token,
  })}\n`;

describe("canonical database filesystem authority hardening", () => {
  it.each(["symlink", "hardlink", "directory", "wrong-mode"] as const)(
    "fails closed for a pre-existing database %s without changing an outside sentinel",
    async (kind) => {
      const root = disposableRoot();
      const paths = initializePaths(root);
      const sentinel = join(root, "outside-sentinel");
      writeFileSync(sentinel, "outside-sentinel\n", { encoding: "utf-8", mode: 0o600 });
      if (kind === "symlink") {
        symlinkSync(sentinel, paths.databasePath);
      } else if (kind === "hardlink") {
        linkSync(sentinel, paths.databasePath);
      } else if (kind === "directory") {
        mkdirSync(paths.databasePath, { mode: 0o700 });
      } else {
        writeFileSync(paths.databasePath, "", { mode: 0o600 });
        chmodSync(paths.databasePath, 0o644);
      }

      await expect(
        startLocalControlDaemonForTesting(dependencies(root)),
      ).rejects.toMatchObject({ code: "LOCAL_STATE_UNSAFE" });
      expect(readFileSync(sentinel, { encoding: "utf-8" })).toBe(
        "outside-sentinel\n",
      );
      expect(existsSync(paths.lockPath)).toBe(false);
      expect(existsSync(paths.sessionPath)).toBe(false);
    },
  );

  it.each(["-journal", "-wal", "-shm"] as const)(
    "rejects pre-existing aliased SQLite %s sidecars",
    async (suffix) => {
      const root = disposableRoot();
      const paths = initializePaths(root);
      const sentinel = join(root, `outside${suffix}`);
      writeFileSync(sentinel, "sidecar-sentinel\n", {
        encoding: "utf-8",
        mode: 0o600,
      });
      linkSync(sentinel, `${paths.databasePath}${suffix}`);

      await expect(
        startLocalControlDaemonForTesting(dependencies(root)),
      ).rejects.toMatchObject({ code: "LOCAL_STATE_UNSAFE" });
      expect(readFileSync(sentinel, { encoding: "utf-8" })).toBe(
        "sidecar-sentinel\n",
      );
    },
  );

  it("creates a private single-link database and detects pathname replacement during startup", async () => {
    const firstRoot = disposableRoot();
    const firstDependencies = dependencies(firstRoot);
    const daemon = await startLocalControlDaemonForTesting(firstDependencies);
    const stats = lstatSync(firstDependencies.paths.databasePath);
    expect(stats.isFile()).toBe(true);
    expect(stats.nlink).toBe(1);
    expect(stats.mode & 0o777).toBe(0o600);
    await daemon.stop();
    const sqlite = new DatabaseSync(firstDependencies.paths.databasePath);
    expect(sqlite.prepare("PRAGMA journal_mode").get()).toEqual({
      journal_mode: "delete",
    });
    sqlite.exec("BEGIN IMMEDIATE; CREATE TABLE sidecar_probe (id INTEGER)");
    const journalStats = lstatSync(
      `${firstDependencies.paths.databasePath}-journal`,
    );
    expect(journalStats.isFile()).toBe(true);
    expect(journalStats.isSymbolicLink()).toBe(false);
    expect(journalStats.nlink).toBe(1);
    expect(journalStats.mode & 0o777).toBe(0o600);
    sqlite.exec("ROLLBACK");
    sqlite.close();
    expect(existsSync(`${firstDependencies.paths.databasePath}-journal`)).toBe(
      false,
    );

    const replacedRoot = disposableRoot();
    const replacedDependencies = dependencies(replacedRoot);
    let opened: TaskStorage | undefined;
    await expect(
      startLocalControlDaemonForTesting({
        ...replacedDependencies,
        openStorage: (databasePath) => {
          opened = openTaskDatabase({ databasePath });
          renameSync(databasePath, `${databasePath}.opened`);
          writeFileSync(databasePath, "replacement\n", {
            encoding: "utf-8",
            mode: 0o600,
          });
          return opened;
        },
      }),
    ).rejects.toMatchObject({ code: "LOCAL_STATE_UNSAFE" });
    expect(opened?.isOpen).toBe(false);
    expect(existsSync(replacedDependencies.paths.lockPath)).toBe(false);
    expect(existsSync(replacedDependencies.paths.sessionPath)).toBe(false);
  });
});

describe("daemon lock, session, and startup publication hardening", () => {
  it.each([
    ["lock", "DAEMON_ALREADY_RUNNING"],
    ["session", "SESSION_UNAVAILABLE"],
    ["both", "DAEMON_ALREADY_RUNNING"],
  ] as const)("fails closed with stale %s evidence", async (kind, code) => {
    const root = disposableRoot();
    const paths = initializePaths(root);
    if (kind === "lock" || kind === "both") {
      acquireDaemonLock(
        paths,
        "inst_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        99,
        "2026-08-31T00:00:00.000Z",
      );
    }
    if (kind === "session" || kind === "both") {
      writeSessionDescriptor(paths, {
        schemaVersion: 1,
        instanceId: "inst_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        pid: 99,
        port: 12_345,
        startedAt: "2026-08-31T00:00:00.000Z",
        sessionToken: "b".repeat(64),
      });
    }

    await expect(
      startLocalControlDaemonForTesting(dependencies(root)),
    ).rejects.toMatchObject({ code });
    expect(existsSync(paths.sessionPath)).toBe(
      kind === "session" || kind === "both",
    );
    expect(existsSync(paths.lockPath)).toBe(kind === "lock" || kind === "both");
  });

  it.each(["symlink", "hardlink", "directory", "wrong-mode", "malformed"] as const)(
    "rejects a %s session descriptor",
    (kind) => {
      const root = disposableRoot();
      const paths = initializePaths(root);
      const outside = join(root, "outside-session");
      writeFileSync(outside, validSessionText(), {
        encoding: "utf-8",
        mode: 0o600,
      });
      if (kind === "symlink") {
        symlinkSync(outside, paths.sessionPath);
      } else if (kind === "hardlink") {
        linkSync(outside, paths.sessionPath);
      } else if (kind === "directory") {
        mkdirSync(paths.sessionPath, { mode: 0o700 });
      } else if (kind === "wrong-mode") {
        writeFileSync(paths.sessionPath, validSessionText(), {
          encoding: "utf-8",
          mode: 0o600,
        });
        chmodSync(paths.sessionPath, 0o644);
      } else {
        writeFileSync(paths.sessionPath, "{not-json}\n", {
          encoding: "utf-8",
          mode: 0o600,
        });
      }
      expect(() => readSessionDescriptor(paths)).toThrowError(LocalStateError);
    },
  );

  it("fails closed when invalid UTF-8 replacement decoding alters session authority", () => {
    const root = disposableRoot();
    const paths = initializePaths(root);
    const bytes = Buffer.from(validSessionText(), "utf-8");
    const tokenPrefix = Buffer.from('"sessionToken":"', "utf-8");
    const tokenStart = bytes.indexOf(tokenPrefix) + tokenPrefix.byteLength;
    expect(tokenStart).toBeGreaterThan(tokenPrefix.byteLength);
    bytes[tokenStart] = 0xc3;
    bytes[tokenStart + 1] = 0x28;
    writeFileSync(paths.sessionPath, bytes, { mode: 0o600 });

    const replacementDecoded = JSON.parse(bytes.toString("utf-8")) as {
      readonly sessionToken: string;
    };
    expect(replacementDecoded.sessionToken).toContain("\ufffd");

    expect(() => readSessionDescriptor(paths)).toThrowError(
      expect.objectContaining({ code: "SESSION_MALFORMED" }),
    );
  });

  it("cleans owned startup evidence and storage across injected failures without publishing readiness", async () => {
    for (const phase of ["open", "service", "listen", "readiness"] as const) {
      const root = disposableRoot();
      const readiness: string[] = [];
      let storage: TaskStorage | undefined;
      const base = dependencies(root, {
        readinessWriter: (line) => readiness.push(line),
      });
      const custom: LocalDaemonTestDependencies = {
        ...base,
        ...(phase === "open"
          ? {
              openStorage: () => {
                throw new Error("synthetic open failure");
              },
            }
          : {
              openStorage: (databasePath: string) => {
                storage = openTaskDatabase({ databasePath });
                return storage;
              },
            }),
        ...(phase === "service"
          ? {
              createService: () => {
                throw new Error("synthetic service failure");
              },
            }
          : {}),
        ...(phase === "listen"
          ? {
              listenServer: async () => {
                throw new LocalDaemonError("LISTEN_FAILED");
              },
            }
          : {}),
        ...(phase === "readiness"
          ? {
              readinessWriter: () => {
                expect(existsSync(base.paths.sessionPath)).toBe(true);
                throw new Error("synthetic readiness failure");
              },
            }
          : {}),
      };

      await expect(startLocalControlDaemonForTesting(custom)).rejects.toBeInstanceOf(
        LocalDaemonError,
      );
      expect(readiness).toEqual([]);
      expect(existsSync(base.paths.sessionPath)).toBe(false);
      expect(existsSync(base.paths.lockPath)).toBe(false);
      expect(storage?.isOpen ?? false).toBe(false);
    }
  });

  it("retries a partially completed clean shutdown without re-removing its session", async () => {
    const root = disposableRoot();
    let removals = 0;
    const daemonDependencies = dependencies(root, {
      removeAuthorityFile: (authority) => {
        removals += 1;
        if (removals === 2) {
          throw new LocalStateError("AUTHORITY_CLEANUP_FAILED");
        }
        removeOwnedAuthorityFile(authority);
      },
    });
    const daemon = await startLocalControlDaemonForTesting(daemonDependencies);

    await expect(daemon.stop()).rejects.toMatchObject({ code: "SHUTDOWN_FAILED" });
    expect(existsSync(daemonDependencies.paths.sessionPath)).toBe(false);
    expect(existsSync(daemonDependencies.paths.lockPath)).toBe(true);
    await expect(daemon.stop()).resolves.toBeUndefined();
    expect(removals).toBe(3);
    expect(existsSync(daemonDependencies.paths.lockPath)).toBe(false);
  });
});

describe("bounded shutdown interaction", () => {
  it("retains storage and authority after a shutdown timeout, then completes coherently", async () => {
    const root = disposableRoot();
    const service = fakeService();
    let startedOperation: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      startedOperation = resolve;
    });
    let finishOperation: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      finishOperation = resolve;
    });
    vi.mocked(service.inspectSubtask).mockImplementation(async (subtaskId) => {
      startedOperation?.();
      await gate;
      return {
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
      };
    });
    let storage: TaskStorage | undefined;
    const daemonDependencies = dependencies(root, {
      shutdownTimeoutMilliseconds: 20,
      openStorage: (databasePath) => {
        storage = openTaskDatabase({ databasePath });
        return storage;
      },
      createService: () => service,
    });
    const daemon = await startLocalControlDaemonForTesting(daemonDependencies);
    const descriptor = readSessionDescriptor(daemonDependencies.paths);
    const response = new Promise<number>((resolve, reject) => {
      const outbound = request(
        {
          host: "127.0.0.1",
          port: daemon.port,
          path: "/v0/subtasks/st_shutdown_hardening",
          headers: {
            authorization: `Bearer ${descriptor.sessionToken}`,
            connection: "close",
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
    await expect(daemon.stop()).rejects.toMatchObject({ code: "SHUTDOWN_TIMEOUT" });
    expect(storage?.isOpen).toBe(true);
    expect(existsSync(daemonDependencies.paths.sessionPath)).toBe(true);
    expect(existsSync(daemonDependencies.paths.lockPath)).toBe(true);
    finishOperation?.();
    await expect(response).resolves.toBe(200);
    await expect(daemon.stop()).resolves.toBeUndefined();
    expect(storage?.isOpen).toBe(false);
    expect(existsSync(daemonDependencies.paths.sessionPath)).toBe(false);
    expect(existsSync(daemonDependencies.paths.lockPath)).toBe(false);
  });

  it.each([
    ["inspect", "GET", "/v0/subtasks/st_shutdown_matrix"],
    ["provision", "POST", "/v0/worktrees/provision"],
    ["run", "POST", "/v0/executions/run"],
    ["release", "POST", "/v0/worktrees/release"],
  ] as const)(
    "waits for an already-started %s operation before closing storage or authority",
    async (operation, method, path) => {
      const root = disposableRoot();
      const base = fakeService();
      let markStarted: (() => void) | undefined;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      let finish: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const wait = async (): Promise<void> => {
        markStarted?.();
        await gate;
      };
      const service: LocalControlService = {
        ...base,
        ...(operation === "inspect"
          ? {
              inspectSubtask: vi.fn(async (subtaskId) => {
                await wait();
                return base.inspectSubtask(subtaskId);
              }),
            }
          : {}),
        ...(operation === "provision"
          ? {
              provisionOwnedWorktree: vi.fn(async (subtaskId) => {
                await wait();
                return base.provisionOwnedWorktree(subtaskId);
              }),
            }
          : {}),
        ...(operation === "run"
          ? {
              runOwnedWorktreeExecution: vi.fn(async (subtaskId) => {
                await wait();
                return base.runOwnedWorktreeExecution(subtaskId);
              }),
            }
          : {}),
        ...(operation === "release"
          ? {
              releaseOwnedWorktree: vi.fn(async (subtaskId) => {
                await wait();
                return base.releaseOwnedWorktree(subtaskId);
              }),
            }
          : {}),
      };
      let storage: TaskStorage | undefined;
      const daemonDependencies = dependencies(root, {
        openStorage: (databasePath) => {
          storage = openTaskDatabase({ databasePath });
          return storage;
        },
        createService: () => service,
      });
      const daemon = await startLocalControlDaemonForTesting(daemonDependencies);
      const descriptor = readSessionDescriptor(daemonDependencies.paths);
      const body =
        method === "POST"
          ? JSON.stringify({ subtaskId: "st_shutdown_matrix" })
          : undefined;
      const response = new Promise<number>((resolve, reject) => {
        const outbound = request(
          {
            host: "127.0.0.1",
            port: daemon.port,
            method,
            path,
            headers: {
              authorization: `Bearer ${descriptor.sessionToken}`,
              connection: "close",
              host: `127.0.0.1:${daemon.port}`,
              ...(body === undefined
                ? {}
                : {
                    "content-length": String(Buffer.byteLength(body)),
                    "content-type": "application/json",
                    "x-ctc-request": "1",
                  }),
            },
          },
          (incoming) => {
            incoming.resume();
            incoming.once("end", () => resolve(incoming.statusCode ?? 0));
          },
        );
        outbound.once("error", reject);
        outbound.end(body);
      });
      await started;
      const stopping = daemon.stop();
      expect(storage?.isOpen).toBe(true);
      expect(existsSync(daemonDependencies.paths.sessionPath)).toBe(true);
      finish?.();
      await expect(response).resolves.toBe(200);
      await expect(stopping).resolves.toBeUndefined();
      expect(storage?.isOpen).toBe(false);
      expect(existsSync(daemonDependencies.paths.sessionPath)).toBe(false);
    },
  );

  it("keeps a disconnected client operation in flight until trusted work finishes", async () => {
    const root = disposableRoot();
    const base = fakeService();
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let finish: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const service: LocalControlService = {
      ...base,
      inspectSubtask: vi.fn(async (subtaskId) => {
        markStarted?.();
        await gate;
        return base.inspectSubtask(subtaskId);
      }),
    };
    const daemonDependencies = dependencies(root, {
      createService: () => service,
    });
    const daemon = await startLocalControlDaemonForTesting(daemonDependencies);
    const descriptor = readSessionDescriptor(daemonDependencies.paths);
    const disconnected = new Promise<void>((resolve) => {
      const outbound = request({
        host: "127.0.0.1",
        port: daemon.port,
        path: "/v0/subtasks/st_disconnect",
        headers: {
          authorization: `Bearer ${descriptor.sessionToken}`,
          connection: "close",
          host: `127.0.0.1:${daemon.port}`,
        },
      });
      outbound.once("error", () => resolve());
      outbound.once("close", () => resolve());
      outbound.end();
      void started.then(() => outbound.destroy());
    });
    await started;
    const stopping = daemon.stop();
    expect(existsSync(daemonDependencies.paths.sessionPath)).toBe(true);
    finish?.();
    await disconnected;
    await stopping;
    expect(existsSync(daemonDependencies.paths.sessionPath)).toBe(false);
  });

  it("leaves fail-closed evidence for a partial body at timeout and closes idle keep-alive clients", async () => {
    const root = disposableRoot();
    const daemonDependencies = dependencies(root, {
      shutdownTimeoutMilliseconds: 25,
    });
    const daemon = await startLocalControlDaemonForTesting(daemonDependencies);
    const descriptor = readSessionDescriptor(daemonDependencies.paths);
    const socket = connect({ host: "127.0.0.1", port: daemon.port });
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    socket.write(
      [
        "POST /v0/worktrees/provision HTTP/1.1",
        `Host: 127.0.0.1:${daemon.port}`,
        `Authorization: Bearer ${descriptor.sessionToken}`,
        "Content-Type: application/json",
        "X-CTC-Request: 1",
        "Content-Length: 100",
        "Connection: close",
        "",
        "{",
      ].join("\r\n"),
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    await expect(daemon.stop()).rejects.toMatchObject({ code: "SHUTDOWN_TIMEOUT" });
    expect(existsSync(daemonDependencies.paths.sessionPath)).toBe(true);
    const socketClosed = new Promise<void>((resolve) =>
      socket.once("close", () => resolve()),
    );
    socket.destroy();
    await socketClosed;
    await daemon.stop();

    const keepAliveRoot = disposableRoot();
    const keepAliveDependencies = dependencies(keepAliveRoot);
    const keepAliveDaemon = await startLocalControlDaemonForTesting(
      keepAliveDependencies,
    );
    const keepAliveDescriptor = readSessionDescriptor(
      keepAliveDependencies.paths,
    );
    const agent = new Agent({ keepAlive: true });
    await new Promise<void>((resolve, reject) => {
      const outbound = request(
        {
          agent,
          host: "127.0.0.1",
          port: keepAliveDaemon.port,
          path: "/v0/ping",
          headers: {
            authorization: `Bearer ${keepAliveDescriptor.sessionToken}`,
            host: `127.0.0.1:${keepAliveDaemon.port}`,
          },
        },
        (incoming) => {
          incoming.resume();
          incoming.once("end", resolve);
        },
      );
      outbound.once("error", reject);
      outbound.end();
    });
    await expect(keepAliveDaemon.stop()).resolves.toBeUndefined();
    agent.destroy();
    expect(existsSync(keepAliveDependencies.paths.sessionPath)).toBe(false);
  });
});
