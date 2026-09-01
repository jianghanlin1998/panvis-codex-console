import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MAX_AUTHORITY_FILE_BYTES = 4_096;

export type LocalStateErrorCode =
  | "UNSAFE_LOCAL_STATE"
  | "DAEMON_ALREADY_RUNNING"
  | "SESSION_UNAVAILABLE"
  | "SESSION_MALFORMED"
  | "AUTHORITY_CLEANUP_FAILED";

export class LocalStateError extends Error {
  readonly code: LocalStateErrorCode;

  constructor(code: LocalStateErrorCode) {
    super(code);
    this.name = "LocalStateError";
    this.code = code;
  }
}

export interface LocalControlPaths {
  readonly root: string;
  readonly stateDirectory: string;
  readonly databasePath: string;
  readonly operatorDirectory: string;
  readonly lockPath: string;
  readonly sessionPath: string;
}

export interface LocalSessionDescriptor {
  readonly schemaVersion: 1;
  readonly instanceId: string;
  readonly pid: number;
  readonly port: number;
  readonly startedAt: string;
  readonly sessionToken: string;
}

interface FileIdentity {
  readonly device: bigint;
  readonly inode: bigint;
}

export interface OwnedAuthorityFile {
  readonly path: string;
  readonly instanceId: string;
  readonly identity: FileIdentity;
}

const currentUid = (): number => {
  const getuid = process.getuid;
  if (getuid === undefined) {
    throw new LocalStateError("UNSAFE_LOCAL_STATE");
  }
  return getuid.call(process);
};

const modeBits = (mode: number): number => mode & 0o777;

const identitiesMatch = (
  left: FileIdentity,
  right: FileIdentity,
): boolean => left.device === right.device && left.inode === right.inode;

const fileIdentity = (stats: { readonly dev: bigint; readonly ino: bigint }): FileIdentity =>
  Object.freeze({ device: stats.dev, inode: stats.ino });

const safeLstat = (path: string) => {
  try {
    return lstatSync(path, { bigint: true });
  } catch {
    throw new LocalStateError("UNSAFE_LOCAL_STATE");
  }
};

const assertCanonicalAbsolutePath = (path: string): void => {
  if (
    !isAbsolute(path) ||
    resolve(path) !== path ||
    path === "/" ||
    path.includes("\0") ||
    path.includes("\r") ||
    path.includes("\n")
  ) {
    throw new LocalStateError("UNSAFE_LOCAL_STATE");
  }
};

export const ensurePrivateDirectory = (path: string): void => {
  assertCanonicalAbsolutePath(path);
  try {
    mkdirSync(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  } catch {
    throw new LocalStateError("UNSAFE_LOCAL_STATE");
  }
  const stats = safeLstat(path);
  let canonicalPath: string;
  try {
    canonicalPath = realpathSync.native(path);
  } catch {
    throw new LocalStateError("UNSAFE_LOCAL_STATE");
  }
  if (
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    stats.uid !== BigInt(currentUid()) ||
    modeBits(Number(stats.mode)) !== PRIVATE_DIRECTORY_MODE ||
    canonicalPath !== path
  ) {
    throw new LocalStateError("UNSAFE_LOCAL_STATE");
  }
};

export const verifyPrivateDirectory = (path: string): void => {
  assertCanonicalAbsolutePath(path);
  const stats = safeLstat(path);
  let canonicalPath: string;
  try {
    canonicalPath = realpathSync.native(path);
  } catch {
    throw new LocalStateError("UNSAFE_LOCAL_STATE");
  }
  if (
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    stats.uid !== BigInt(currentUid()) ||
    modeBits(Number(stats.mode)) !== PRIVATE_DIRECTORY_MODE ||
    canonicalPath !== path
  ) {
    throw new LocalStateError("UNSAFE_LOCAL_STATE");
  }
};

const pathsForRoot = (root: string): LocalControlPaths => {
  assertCanonicalAbsolutePath(root);
  return Object.freeze({
    root,
    stateDirectory: join(root, "state"),
    databasePath: join(root, "state", "console.sqlite3"),
    operatorDirectory: join(root, "operator"),
    lockPath: join(root, "operator", "daemon.lock"),
    sessionPath: join(root, "operator", "current-session.json"),
  });
};

export const productionLocalControlPaths = (): LocalControlPaths =>
  pathsForRoot(
    join(
      homedir(),
      "Library",
      "Application Support",
      "Codex Task Console",
    ),
  );

/** Package-private deterministic-test seam; not exported from the package root. */
export const localControlPathsForTesting = (root: string): LocalControlPaths =>
  pathsForRoot(resolve(root));

export const ensureProductionStateDirectories = (
  paths: LocalControlPaths,
): void => {
  ensurePrivateDirectory(paths.root);
  ensurePrivateDirectory(paths.stateDirectory);
  ensurePrivateDirectory(paths.operatorDirectory);
};

export const verifyOperatorStateDirectories = (
  paths: LocalControlPaths,
): void => {
  verifyPrivateDirectory(paths.root);
  verifyPrivateDirectory(paths.operatorDirectory);
};

const openExclusivePrivateFile = (path: string): number => {
  try {
    return openSync(
      path,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      PRIVATE_FILE_MODE,
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      throw new LocalStateError("DAEMON_ALREADY_RUNNING");
    }
    throw new LocalStateError("UNSAFE_LOCAL_STATE");
  }
};

const writeExclusiveAuthorityFile = (
  path: string,
  instanceId: string,
  contents: string,
): OwnedAuthorityFile => {
  assertCanonicalAbsolutePath(path);
  const descriptor = openExclusivePrivateFile(path);
  let openedIdentity: FileIdentity | undefined;
  let identity: FileIdentity | undefined;
  try {
    const stats = fstatSync(descriptor, { bigint: true });
    if (
      !stats.isFile() ||
      stats.nlink !== 1n ||
      stats.uid !== BigInt(currentUid()) ||
      modeBits(Number(stats.mode)) !== PRIVATE_FILE_MODE
    ) {
      throw new LocalStateError("UNSAFE_LOCAL_STATE");
    }
    openedIdentity = fileIdentity(stats);
    writeFileSync(descriptor, contents, { encoding: "utf-8" });
    fsyncSync(descriptor);
    const stable = fstatSync(descriptor, { bigint: true });
    identity = fileIdentity(stable);
    if (!identitiesMatch(identity, fileIdentity(stats))) {
      throw new LocalStateError("UNSAFE_LOCAL_STATE");
    }
  } catch (error) {
    try {
      closeSync(descriptor);
    } catch {
      // The sanitized authority error remains primary.
    }
    if (openedIdentity !== undefined) {
      try {
        const linked = lstatSync(path, { bigint: true });
        if (identitiesMatch(openedIdentity, fileIdentity(linked))) {
          unlinkSync(path);
        }
      } catch {
        // A failed or replaced authority file is left fail-closed.
      }
    }
    if (error instanceof LocalStateError) {
      throw error;
    }
    throw new LocalStateError("UNSAFE_LOCAL_STATE");
  }
  try {
    closeSync(descriptor);
  } catch {
    throw new LocalStateError("UNSAFE_LOCAL_STATE");
  }
  if (identity === undefined) {
    throw new LocalStateError("UNSAFE_LOCAL_STATE");
  }
  const linked = safeLstat(path);
  if (
    !linked.isFile() ||
    linked.isSymbolicLink() ||
    linked.nlink !== 1n ||
    linked.uid !== BigInt(currentUid()) ||
    modeBits(Number(linked.mode)) !== PRIVATE_FILE_MODE ||
    !identitiesMatch(identity, fileIdentity(linked))
  ) {
    throw new LocalStateError("UNSAFE_LOCAL_STATE");
  }
  return Object.freeze({ path, instanceId, identity });
};

export const acquireDaemonLock = (
  paths: LocalControlPaths,
  instanceId: string,
  pid: number,
  startedAt: string,
): OwnedAuthorityFile =>
  writeExclusiveAuthorityFile(
    paths.lockPath,
    instanceId,
    `${JSON.stringify({ schemaVersion: 1, instanceId, pid, startedAt })}\n`,
  );

export const writeSessionDescriptor = (
  paths: LocalControlPaths,
  descriptor: LocalSessionDescriptor,
): OwnedAuthorityFile =>
  writeExclusiveAuthorityFile(
    paths.sessionPath,
    descriptor.instanceId,
    `${JSON.stringify(descriptor)}\n`,
  );

const readPrivateFile = (path: string, missingCode: LocalStateErrorCode): string => {
  assertCanonicalAbsolutePath(path);
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new LocalStateError(missingCode);
  }
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.uid !== BigInt(currentUid()) ||
      modeBits(Number(before.mode)) !== PRIVATE_FILE_MODE ||
      before.size > BigInt(MAX_AUTHORITY_FILE_BYTES)
    ) {
      throw new LocalStateError("SESSION_MALFORMED");
    }
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    if (
      !identitiesMatch(fileIdentity(before), fileIdentity(after)) ||
      before.size !== after.size ||
      bytes.byteLength !== Number(after.size)
    ) {
      throw new LocalStateError("SESSION_MALFORMED");
    }
    return bytes.toString("utf-8");
  } finally {
    try {
      closeSync(descriptor);
    } catch {
      // The read result will still be validated as untrusted data.
    }
  }
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactKeys = (
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): boolean => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};

const isCanonicalTimestamp = (value: unknown): value is string =>
  typeof value === "string" &&
  !Number.isNaN(Date.parse(value)) &&
  new Date(value).toISOString() === value;

export const readSessionDescriptor = (
  paths: LocalControlPaths,
): LocalSessionDescriptor => {
  verifyOperatorStateDirectories(paths);
  const text = readPrivateFile(paths.sessionPath, "SESSION_UNAVAILABLE");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new LocalStateError("SESSION_MALFORMED");
  }
  if (
    !isRecord(parsed) ||
    !hasExactKeys(parsed, [
      "schemaVersion",
      "instanceId",
      "pid",
      "port",
      "startedAt",
      "sessionToken",
    ]) ||
    parsed.schemaVersion !== 1 ||
    typeof parsed.instanceId !== "string" ||
    !/^inst_[0-9a-f]{32}$/.test(parsed.instanceId) ||
    typeof parsed.pid !== "number" ||
    !Number.isSafeInteger(parsed.pid) ||
    parsed.pid <= 0 ||
    typeof parsed.port !== "number" ||
    !Number.isInteger(parsed.port) ||
    parsed.port < 1 ||
    parsed.port > 65_535 ||
    !isCanonicalTimestamp(parsed.startedAt) ||
    typeof parsed.sessionToken !== "string" ||
    !/^[0-9a-f]{64}$/.test(parsed.sessionToken)
  ) {
    throw new LocalStateError("SESSION_MALFORMED");
  }
  return Object.freeze({
    schemaVersion: 1,
    instanceId: parsed.instanceId,
    pid: parsed.pid,
    port: parsed.port,
    startedAt: parsed.startedAt,
    sessionToken: parsed.sessionToken,
  });
};

const authorityBelongsToInstance = (
  authority: OwnedAuthorityFile,
): boolean => {
  let stats;
  try {
    stats = lstatSync(authority.path, { bigint: true });
  } catch {
    return false;
  }
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.nlink !== 1n ||
    stats.uid !== BigInt(currentUid()) ||
    modeBits(Number(stats.mode)) !== PRIVATE_FILE_MODE ||
    !identitiesMatch(authority.identity, fileIdentity(stats))
  ) {
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readPrivateFile(authority.path, "AUTHORITY_CLEANUP_FAILED"));
  } catch {
    return false;
  }
  return isRecord(parsed) && parsed.instanceId === authority.instanceId;
};

export const removeOwnedAuthorityFile = (authority: OwnedAuthorityFile): void => {
  if (!authorityBelongsToInstance(authority)) {
    throw new LocalStateError("AUTHORITY_CLEANUP_FAILED");
  }
  try {
    unlinkSync(authority.path);
  } catch {
    throw new LocalStateError("AUTHORITY_CLEANUP_FAILED");
  }
};
