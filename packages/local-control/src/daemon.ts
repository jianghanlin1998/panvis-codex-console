import { randomBytes } from "node:crypto";
import { lstatSync } from "node:fs";
import type { AddressInfo } from "node:net";

import {
  openTaskDatabase,
} from "@codex-task-console/storage";
import type { TaskStorage } from "@codex-task-console/storage";

import { createLocalControlHttpServer, LOCAL_CONTROL_HOST } from "./http-server.js";
import { createProductionLocalControlService } from "./service.js";
import type { LocalControlService } from "./service.js";
import {
  LocalStateError,
  acquireDaemonLock,
  ensureProductionStateDirectories,
  productionLocalControlPaths,
  removeOwnedAuthorityFile,
  writeSessionDescriptor,
} from "./state.js";
import type {
  LocalControlPaths,
  OwnedAuthorityFile,
} from "./state.js";

const DEFAULT_SHUTDOWN_TIMEOUT_MILLISECONDS = 30_000;

const generateInstanceId = (): string =>
  `inst_${randomBytes(16).toString("hex")}`;

const generateSessionToken = (): string => randomBytes(32).toString("hex");

export type LocalDaemonErrorCode =
  | "DAEMON_ALREADY_RUNNING"
  | "LOCAL_STATE_UNSAFE"
  | "DATABASE_UNAVAILABLE"
  | "LISTEN_FAILED"
  | "SESSION_UNAVAILABLE"
  | "SHUTDOWN_FAILED"
  | "SHUTDOWN_TIMEOUT";

export class LocalDaemonError extends Error {
  readonly code: LocalDaemonErrorCode;

  constructor(code: LocalDaemonErrorCode) {
    super(code);
    this.name = "LocalDaemonError";
    this.code = code;
  }
}

export interface LocalDaemonHandle {
  readonly instanceId: string;
  readonly pid: number;
  readonly port: number;
  stop(): Promise<void>;
}

interface DaemonDependencies {
  readonly paths: LocalControlPaths;
  readonly instanceId: string;
  readonly sessionToken: string;
  readonly pid: number;
  readonly clock: () => Date;
  readonly openStorage: (databasePath: string) => TaskStorage;
  readonly createService: (storage: TaskStorage) => LocalControlService;
  readonly readinessWriter: (line: string) => void;
  readonly shutdownTimeoutMilliseconds: number;
}

const productionDependencies = (): DaemonDependencies => ({
  paths: productionLocalControlPaths(),
  instanceId: generateInstanceId(),
  sessionToken: generateSessionToken(),
  pid: process.pid,
  clock: () => new Date(),
  openStorage: (databasePath) => openTaskDatabase({ databasePath }),
  createService: createProductionLocalControlService,
  readinessWriter: (line) => {
    process.stdout.write(`${line}\n`);
  },
  shutdownTimeoutMilliseconds: DEFAULT_SHUTDOWN_TIMEOUT_MILLISECONDS,
});

const mapStateError = (error: unknown): LocalDaemonError => {
  if (error instanceof LocalDaemonError) {
    return error;
  }
  if (error instanceof LocalStateError) {
    switch (error.code) {
      case "DAEMON_ALREADY_RUNNING":
        return new LocalDaemonError("DAEMON_ALREADY_RUNNING");
      case "SESSION_UNAVAILABLE":
      case "SESSION_MALFORMED":
        return new LocalDaemonError("SESSION_UNAVAILABLE");
      case "UNSAFE_LOCAL_STATE":
      case "AUTHORITY_CLEANUP_FAILED":
        return new LocalDaemonError("LOCAL_STATE_UNSAFE");
    }
  }
  return new LocalDaemonError("LOCAL_STATE_UNSAFE");
};

const pathExists = (path: string): boolean => {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw new LocalDaemonError("LOCAL_STATE_UNSAFE");
  }
};

const listen = async (
  server: ReturnType<typeof createLocalControlHttpServer>["server"],
): Promise<number> =>
  new Promise((resolve, reject) => {
    const onError = (): void => {
      reject(new LocalDaemonError("LISTEN_FAILED"));
    };
    server.once("error", onError);
    server.listen(0, LOCAL_CONTROL_HOST, () => {
      server.off("error", onError);
      const address = server.address() as AddressInfo | null;
      if (
        address === null ||
        address.address !== LOCAL_CONTROL_HOST ||
        address.port < 1 ||
        address.port > 65_535
      ) {
        reject(new LocalDaemonError("LISTEN_FAILED"));
        return;
      }
      resolve(address.port);
    });
  });

const closeListeningServer = async (
  server: ReturnType<typeof createLocalControlHttpServer>["server"],
): Promise<void> => {
  if (!server.listening) {
    return;
  }
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeIdleConnections();
  });
};

const withTimeout = async (
  operation: Promise<void>,
  milliseconds: number,
): Promise<void> => {
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      operation,
      new Promise<void>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new LocalDaemonError("SHUTDOWN_TIMEOUT")),
          milliseconds,
        );
        timeout.unref();
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
};

const cleanupStartupFailure = async (
  storage: TaskStorage | undefined,
  http: ReturnType<typeof createLocalControlHttpServer> | undefined,
  session: OwnedAuthorityFile | undefined,
  lock: OwnedAuthorityFile | undefined,
): Promise<void> => {
  try {
    if (http !== undefined) {
      http.stopAcceptingNewWork();
      await closeListeningServer(http.server);
    }
  } catch {
    // Startup remains failed and authority evidence remains fail-closed.
  }
  try {
    storage?.close();
  } catch {
    // Startup remains failed.
  }
  try {
    if (session !== undefined) {
      removeOwnedAuthorityFile(session);
    }
  } catch {
    // Foreign or replaced authority is never removed.
  }
  try {
    if (lock !== undefined) {
      removeOwnedAuthorityFile(lock);
    }
  } catch {
    // Foreign or replaced authority is never removed.
  }
};

const startWithDependencies = async (
  dependencies: DaemonDependencies,
): Promise<LocalDaemonHandle> => {
  let lock: OwnedAuthorityFile | undefined;
  let session: OwnedAuthorityFile | undefined;
  let storage: TaskStorage | undefined;
  let http: ReturnType<typeof createLocalControlHttpServer> | undefined;
  try {
    ensureProductionStateDirectories(dependencies.paths);
    const startedAt = dependencies.clock().toISOString();
    lock = acquireDaemonLock(
      dependencies.paths,
      dependencies.instanceId,
      dependencies.pid,
      startedAt,
    );
    if (pathExists(dependencies.paths.sessionPath)) {
      throw new LocalDaemonError("SESSION_UNAVAILABLE");
    }
    try {
      storage = dependencies.openStorage(dependencies.paths.databasePath);
    } catch {
      throw new LocalDaemonError("DATABASE_UNAVAILABLE");
    }
    http = createLocalControlHttpServer(
      dependencies.createService(storage),
      dependencies.sessionToken,
    );
    const port = await listen(http.server);
    http.setAuthority(`${LOCAL_CONTROL_HOST}:${port}`);
    try {
      session = writeSessionDescriptor(dependencies.paths, {
        schemaVersion: 1,
        instanceId: dependencies.instanceId,
        pid: dependencies.pid,
        port,
        startedAt,
        sessionToken: dependencies.sessionToken,
      });
    } catch {
      throw new LocalDaemonError("SESSION_UNAVAILABLE");
    }
    dependencies.readinessWriter(
      JSON.stringify({
        ready: true,
        address: LOCAL_CONTROL_HOST,
        port,
        pid: dependencies.pid,
        instanceId: dependencies.instanceId,
      }),
    );

    const ownedStorage = storage;
    const ownedHttp = http;
    const ownedSession = session;
    const ownedLock = lock;
    let stopped = false;
    let stopPromise: Promise<void> | undefined;
    const stop = async (): Promise<void> => {
      if (stopped) {
        return;
      }
      if (stopPromise !== undefined) {
        return stopPromise;
      }
      stopPromise = (async () => {
        ownedHttp.stopAcceptingNewWork();
        const serverClosed = closeListeningServer(ownedHttp.server);
        await withTimeout(
          Promise.all([
            serverClosed,
            ownedHttp.waitForInFlightRequests(),
          ]).then(() => undefined),
          dependencies.shutdownTimeoutMilliseconds,
        );
        try {
          ownedStorage.close();
          removeOwnedAuthorityFile(ownedSession);
          removeOwnedAuthorityFile(ownedLock);
        } catch {
          throw new LocalDaemonError("SHUTDOWN_FAILED");
        }
        stopped = true;
      })();
      try {
        await stopPromise;
      } catch (error) {
        stopPromise = undefined;
        throw error;
      }
    };

    return Object.freeze({
      instanceId: dependencies.instanceId,
      pid: dependencies.pid,
      port,
      stop,
    });
  } catch (error) {
    await cleanupStartupFailure(storage, http, session, lock);
    throw mapStateError(error);
  }
};

export const startLocalControlDaemon = async (): Promise<LocalDaemonHandle> =>
  startWithDependencies(productionDependencies());

/** Package-private deterministic-test seam; not exported from the package root. */
export const startLocalControlDaemonForTesting = async (
  dependencies: DaemonDependencies,
): Promise<LocalDaemonHandle> => startWithDependencies(dependencies);

/** Package-private deterministic-test type; not exported from the package root. */
export type { DaemonDependencies as LocalDaemonTestDependencies };

/** Package-private deterministic-test seam; not exported from the package root. */
export const generateSessionTokenForTesting = (): string =>
  generateSessionToken();
